// Fonte de agentes do OpenCode (AgentSource 'opencode'): observa o serviço local pela API HTTP v2.
//
// Descoberta: registro padrão do serviço (discovery.ts) ou HABBLAUD_OPENCODE_URL explícita. Um stream SSE em
// `/api/event` alimenta o escritório ao vivo; `/api/session` + `/api/session/active` reconciliam no boot e depois de
// cada reconexão (o SSE não tem replay). A cada `reconcileMs` a lista é relida para cobrir eventos perdidos.
//
// Presença: sessões ativas e sessões atualizadas dentro de `recentMs` (30 min por padrão) ficam no escritório; as
// ativas como 'working', as demais como 'idle'. Sessões filhas (`parentID`) viram subagentes do principal.
//
// Status: `session.status` busy/idle, `session.execution.*`, permissões pendentes ('waiting') e shells em segundo
// plano ('shell'). Atividades vêm de `session.tool.*` e dos passos/raciocínio/texto; cada evento usa o próprio id,
// então uma repetição não duplica nada. Falha de um endpoint não fecha as outras sessões: o erro vai para
// `sources()` e a reconciliação seguinte tenta de novo.
//
// Nada de banco, credenciais da TUI ou transcripts internos: só a API e o registro de serviço. A senha fica no
// cliente (cabeçalho Basic) e nunca é logada.
import { isAbsolute, join } from 'node:path';
import { SPECIAL, type ShellOutcome } from '../../../shared/activity';
import type { Activity, AgentStatus, ShellJob, SourceInfo } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource, ConversationSource } from '../source';
import { describeOpenCodePermission, describeOpenCodeTool } from './activity';
import { OpenCodeApiClient, type OpenCodePermission, type OpenCodeSession } from './client';
import { OpenCodeConversation } from './conversation';
import { discoverEndpoint, type OpenCodeEndpoint } from './discovery';
import { OpenCodeEventStream, type OpenCodeEvent, type OpenCodeEventStreamOptions } from './events';

export interface OpenCodePermissionNotice {
  agentId: string;
  sessionId: string;
  requestId: string;
  action: string;
  resources: string[];
  message?: string;
}

export interface OpenCodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  home: string;
  /** Origem explícita (HABBLAUD_OPENCODE_URL); ausente = registro padrão. */
  baseUrl?: string;
  password?: string;
  env?: NodeJS.ProcessEnv;
  /** Janela de recência das sessões ociosas (padrão 30 min). */
  recentMs?: number;
  /** Intervalo da reconciliação por polling (padrão 15 s). */
  reconcileMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  discover?: typeof discoverEndpoint;
  eventStream?: (options: OpenCodeEventStreamOptions) => Pick<OpenCodeEventStream, 'start' | 'stop'>;
  onPermission?: (notice: OpenCodePermissionNotice) => void;
  onPermissionGone?: (sessionId: string, requestId: string) => void;
}

const ACCOUNT_COLOR = '#d5a84f';
const ACCOUNT_DIR_NAME = '.opencode';
const DEFAULT_RECENT_MS = 30 * 60_000;
const DEFAULT_RECONCILE_MS = 15_000;
const MAX_TITLE = 240;
const SESSION_LIMIT = 100;
const PERMISSION_REASON = () => tr('aprovar uma permissão');

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function modelLabel(model: OpenCodeSession['model']): string | undefined {
  if (!model) return undefined;
  const id = typeof model.modelID === 'string' ? model.modelID.trim() : '';
  const provider = typeof model.providerID === 'string' ? model.providerID.trim() : '';
  return id ? (provider ? `${provider}/${id}` : id).slice(0, 120) : undefined;
}

function sessionCreatedAt(session: OpenCodeSession, fallback: number): number {
  const created = session.time?.created;
  return typeof created === 'number' && Number.isFinite(created) && created > 0 ? created : fallback;
}

function sessionUpdatedAt(session: OpenCodeSession, fallback: number): number {
  const updated = session.time?.updated;
  return typeof updated === 'number' && Number.isFinite(updated) && updated > 0 ? updated : sessionCreatedAt(session, fallback);
}

function errorDetail(raw: unknown): string | undefined {
  const error = obj(raw);
  return str(error.message) || str(error.type) || undefined;
}

function shellOutcome(shell: Record<string, unknown>): ShellOutcome {
  const status = str(shell.status);
  if (status === 'killed') return 'killed';
  if (status === 'timeout') return 'failed';
  if (status === 'exited' && typeof shell.exit === 'number' && shell.exit !== 0) return 'failed';
  return 'ok';
}

/** Observa o serviço local do OpenCode pela API HTTP v2. */
export class OpenCodeSource implements AgentSource {
  readonly provider = 'opencode' as const;
  private readonly opts: OpenCodeSourceOptions;
  private readonly now: () => number;
  private readonly recentMs: number;
  private readonly reconcileMs: number;
  private readonly entries: readonly AccountEntry[];
  private client?: OpenCodeApiClient;
  private endpoint?: OpenCodeEndpoint;
  private stream?: Pick<OpenCodeEventStream, 'start' | 'stop'>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;
  private connecting = false;
  private reconciling = false;
  private error?: string;
  private readonly present = new Set<string>();
  private readonly subs = new Set<string>();
  private readonly baseStatus = new Map<string, 'working' | 'idle'>();
  private readonly pending = new Map<string, Set<string>>();
  private readonly shells = new Map<string, Map<string, ShellJob>>();
  private readonly toolNames = new Map<string, string>();
  private readonly sessionOf = new Map<string, string>();
  private readonly agentOf = new Map<string, string>();

  constructor(opts: OpenCodeSourceOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.recentMs = Math.max(0, opts.recentMs ?? DEFAULT_RECENT_MS);
    this.reconcileMs = Math.max(1_000, opts.reconcileMs ?? DEFAULT_RECONCILE_MS);
    const configDir = join(opts.home, '.local', 'share', 'opencode');
    const detected: DetectedAccount = {
      id: ACCOUNT_DIR_NAME,
      provider: 'opencode',
      configDir,
      short: 'O',
      name: 'OpenCode',
      color: ACCOUNT_COLOR,
    };
    this.entries = opts.accounts.setProviderAccounts('opencode', [{ dir: configDir, detected }]);
  }

  /** Cliente atual, para o histórico e a conversa (Task 4). */
  api(): OpenCodeApiClient | undefined {
    return this.client;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.opts.office.beginBoot();
    try {
      await this.connect();
    } finally {
      this.opts.office.endBoot();
    }
    if (this.stopped) return;
    this.timer = setInterval(() => void this.reconcileSafely(), this.reconcileMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.stop();
    this.stream = undefined;
    for (const id of this.present) this.opts.office.closeMain(id);
    this.present.clear();
    this.subs.clear();
    this.baseStatus.clear();
    this.pending.clear();
    this.shells.clear();
    this.toolNames.clear();
    this.sessionOf.clear();
    this.agentOf.clear();
  }

  sources(): SourceInfo[] {
    const account = this.entries[0];
    if (!account) return [];
    return [{
      label: account.id,
      provider: 'opencode',
      path: account.dir,
      sessions: this.present.size,
      ok: !this.error,
      ...(this.error ? { error: this.error } : {}),
    }];
  }

  transcriptPathOf(_agentId: string): undefined {
    return undefined;
  }

  /** Conversa do agente principal pela API (o terminal e a sessão do histórico usam). */
  conversationOf(agentId: string): ConversationSource | undefined {
    const client = this.client;
    const sessionId = this.sessionOf.get(agentId);
    if (!client || !sessionId || !this.present.has(agentId)) return undefined;
    return new OpenCodeConversation({ client, sessionId, agentId });
  }

  // ---------------------------------------------------------------- conexão e reconciliação

  private async connect(): Promise<void> {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    try {
      const endpoint = await (this.opts.discover ?? discoverEndpoint)({
        home: this.opts.home,
        env: this.opts.env ?? process.env,
        explicitUrl: this.opts.baseUrl,
        explicitPassword: this.opts.password,
        fetchImpl: this.opts.fetchImpl,
      });
      if (this.stopped) return;
      const changed =
        !this.endpoint ||
        this.endpoint.url !== endpoint.url ||
        this.endpoint.password !== endpoint.password ||
        this.endpoint.pid !== endpoint.pid;
      this.endpoint = endpoint;
      if (changed || !this.client) {
        this.client = new OpenCodeApiClient({
          baseUrl: endpoint.url,
          password: endpoint.password,
          fetchImpl: this.opts.fetchImpl,
        });
      }
      await this.reconcile();
      if (!this.stream || changed) {
        this.stream?.stop();
        this.stream = (this.opts.eventStream ?? ((options) => new OpenCodeEventStream(options)))({
          open: (signal) => {
            if (!this.client) throw new Error('OpenCode indisponível');
            return this.client.eventResponse(signal);
          },
          onEvent: (event) => this.handleEvent(event),
          onState: (state) => {
            if (state === 'open') void this.refreshPermissions([...this.present].map((id) => this.sessionOf.get(id)).filter((id): id is string => !!id));
            else if (state === 'closed') void this.connect();
          },
          onError: (error) => this.fail(error),
        });
        this.stream.start();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.connecting = false;
    }
  }

  private async reconcileSafely(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    if (!this.client) {
      await this.connect();
      return;
    }
    this.reconciling = true;
    try {
      await this.reconcile();
    } catch (error) {
      this.fail(error);
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcile(): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('Cliente OpenCode indisponível');
    const account = this.entries[0];
    if (!account) throw new Error('Conta OpenCode não registrada');

    const [sessionsResult, activeResult] = await Promise.allSettled([
      client.sessions({ limit: SESSION_LIMIT, order: 'desc', archived: false }),
      client.activeSessions(),
    ]);
    if (sessionsResult.status === 'rejected') throw sessionsResult.reason;
    const sessions = sessionsResult.value;
    const active = activeResult.status === 'fulfilled' ? activeResult.value : undefined;
    const partial = activeResult.status === 'rejected' ? tr('sessões ativas: {0}', [errMsg(activeResult.reason)]) : undefined;

    const now = this.now();
    const nextMain = new Set<string>();
    const nextSubs = new Set<string>();
    const mainIds = new Set<string>();
    const visible: OpenCodeSession[] = [];

    // Principais primeiro; as filhas dependem de o pai já estar no escritório.
    for (const session of sessions) {
      if (session.parentID) continue;
      const cwd = session.location?.directory;
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) continue;
      const isActive = active ? active[session.id] !== undefined : this.baseStatus.get(session.id) === 'working';
      const recent = now - sessionUpdatedAt(session, now) <= this.recentMs;
      if (!isActive && !recent) continue;
      if (active) this.baseStatus.set(session.id, isActive ? 'working' : 'idle');
      else if (!this.baseStatus.has(session.id)) this.baseStatus.set(session.id, 'idle');
      const id = `${account.id}:${session.id}`;
      const status = this.statusFor(session.id);
      this.opts.office.addMain({
        id,
        provider: 'opencode',
        account: account.id,
        sessionId: session.id,
        cwd,
        role: tr('Agente OpenCode'),
        title: typeof session.title === 'string' ? session.title.slice(0, MAX_TITLE) : undefined,
        model: modelLabel(session.model),
        startedAt: sessionCreatedAt(session, now),
        status,
        waitingFor: status === 'waiting' ? PERMISSION_REASON() : undefined,
      });
      this.remember(id, session.id);
      nextMain.add(id);
      mainIds.add(session.id);
      visible.push(session);
    }

    for (const session of sessions) {
      if (!session.parentID) continue;
      const cwd = session.location?.directory;
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) continue;
      if (!mainIds.has(session.parentID)) continue;
      const updated = sessionUpdatedAt(session, now);
      const isActive = active ? active[session.id] !== undefined : false;
      if (!isActive && now - updated > this.recentMs) continue;
      const parentId = `${account.id}:${session.parentID}`;
      const id = `${account.id}:${session.id}`;
      if (!this.opts.office.has(id)) {
        const added = this.opts.office.addSub({
          id,
          parentId,
          sessionId: session.id,
          role: typeof session.agent === 'string' && session.agent.trim() ? session.agent.trim() : tr('Subagente (OpenCode)'),
          title: typeof session.title === 'string' ? session.title.slice(0, MAX_TITLE) : undefined,
          background: true,
          startedAt: sessionCreatedAt(session, now),
        });
        if (!added) continue;
      } else if (this.opts.office.isSubDone(id)) {
        this.opts.office.reactivateSub(id);
      }
      this.remember(id, session.id);
      nextSubs.add(id);
      visible.push(session);
    }

    for (const id of this.present) {
      if (nextMain.has(id)) continue;
      this.opts.office.closeMain(id);
      const sessionId = this.sessionOf.get(id);
      if (sessionId) this.forget(sessionId, id);
    }
    this.present.clear();
    for (const id of nextMain) this.present.add(id);

    for (const id of this.subs) {
      if (nextSubs.has(id)) continue;
      this.opts.office.completeSub(id);
      const sessionId = this.sessionOf.get(id);
      if (sessionId) this.forget(sessionId, id);
    }
    this.subs.clear();
    for (const id of nextSubs) this.subs.add(id);

    const permissionSessions = visible
      .map((session) => session.id)
      .filter((sessionId) => (active ? active[sessionId] !== undefined : false) || this.pending.has(sessionId));
    if (permissionSessions.length) await this.refreshPermissions(permissionSessions);

    if (partial) this.fail(partial);
    else this.error = undefined;
  }

  /** Recolhe permissões pendentes das sessões indicadas (boot e reconexão). */
  private async refreshPermissions(sessionIds: readonly string[]): Promise<void> {
    const client = this.client;
    if (!client || !sessionIds.length) return;
    const results = await Promise.allSettled(
      sessionIds.map(async (sessionId) => ({ sessionId, list: await client.permissions(sessionId) })),
    );
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { sessionId, list } = result.value;
      const before = this.pending.get(sessionId) ?? new Set<string>();
      const next = new Set(list.map((permission) => permission.id));
      for (const permission of list) {
        if (!before.has(permission.id)) this.notifyPermission(sessionId, permission);
      }
      for (const requestId of before) {
        if (!next.has(requestId)) this.opts.onPermissionGone?.(sessionId, requestId);
      }
      if (next.size) this.pending.set(sessionId, next);
      else this.pending.delete(sessionId);
      this.applyStatus(sessionId);
    }
  }

  private notifyPermission(sessionId: string, permission: OpenCodePermission): void {
    this.pending.set(sessionId, new Set([...(this.pending.get(sessionId) ?? []), permission.id]));
    const agentId = this.agentOf.get(sessionId);
    if (agentId) {
      this.opts.onPermission?.({
        agentId,
        sessionId,
        requestId: permission.id,
        action: permission.action,
        resources: permission.resources,
        ...(permission.message ? { message: permission.message } : {}),
      });
    }
    this.applyStatus(sessionId);
  }

  // ---------------------------------------------------------------- eventos

  private handleEvent(event: OpenCodeEvent): void {
    if (this.stopped) return;
    const data = obj(event.data);
    const sessionId = str(data.sessionID) || undefined;
    try {
      switch (event.type) {
        case 'server.connected':
          void this.reconcileSafely();
          return;
        case 'session.status': {
          if (!sessionId) return;
          const status = str(obj(data.status).type);
          if (status === 'idle') this.setBase(sessionId, 'idle');
          else if (status === 'busy') this.setBase(sessionId, 'working');
          else if (status === 'retry') {
            this.setBase(sessionId, 'working');
            this.addActivity(sessionId, event, SPECIAL.apiRetry());
          }
          return;
        }
        case 'session.idle':
          if (sessionId) this.setBase(sessionId, 'idle');
          return;
        case 'session.execution.started':
          if (sessionId) this.setBase(sessionId, 'working');
          return;
        case 'session.execution.succeeded':
          if (sessionId) this.setBase(sessionId, 'idle');
          return;
        case 'session.execution.failed': {
          if (!sessionId) return;
          this.setBase(sessionId, 'idle');
          const detail = errorDetail(data.error);
          this.addActivity(sessionId, event, detail ? SPECIAL.error(undefined, detail) : SPECIAL.error());
          return;
        }
        case 'session.execution.interrupted':
          if (!sessionId) return;
          this.setBase(sessionId, 'idle');
          this.addActivity(sessionId, event, SPECIAL.interrupted());
          return;
        case 'session.step.started':
        case 'session.reasoning.started':
          if (!sessionId) return;
          this.setBase(sessionId, 'working');
          this.addActivity(sessionId, event, SPECIAL.think());
          return;
        case 'session.text.started':
          if (!sessionId) return;
          this.setBase(sessionId, 'working');
          this.addActivity(sessionId, event, SPECIAL.respond());
          return;
        case 'session.tool.input.started':
          if (sessionId) this.rememberToolName(sessionId, data);
          return;
        case 'session.tool.called':
          if (sessionId) this.toolCalled(sessionId, event, data);
          return;
        case 'session.tool.success':
          if (sessionId) this.toolEnded(sessionId, data, 'ok');
          return;
        case 'session.tool.failed': {
          if (!sessionId) return;
          const detail = errorDetail(data.error);
          if (detail) this.addActivity(sessionId, event, SPECIAL.error(this.toolName(sessionId, data), detail));
          this.toolEnded(sessionId, data, 'failed');
          return;
        }
        case 'session.shell.started':
          if (sessionId) this.shellStarted(sessionId, event, obj(data.shell));
          return;
        case 'session.shell.ended':
          if (sessionId) this.shellEnded(sessionId, event, obj(data.shell));
          return;
        case 'session.compaction.started':
        case 'session.compaction.ended':
          if (sessionId) this.addActivity(sessionId, event, SPECIAL.compact());
          return;
        case 'permission.asked': {
          if (!sessionId) return;
          const id = str(data.id);
          if (!id) return;
          this.pending.set(sessionId, new Set([...(this.pending.get(sessionId) ?? []), id]));
          const agentId = this.agentOf.get(sessionId);
          if (agentId) {
            this.opts.onPermission?.({
              agentId,
              sessionId,
              requestId: id,
              action: str(data.action),
              resources: Array.isArray(data.resources) ? data.resources.filter((resource): resource is string => typeof resource === 'string') : [],
              ...(str(data.message) ? { message: str(data.message) } : {}),
            });
          }
          this.applyStatus(sessionId);
          return;
        }
        case 'permission.replied': {
          if (!sessionId) return;
          const requestId = str(data.requestID);
          if (!requestId) return;
          const set = this.pending.get(sessionId);
          set?.delete(requestId);
          if (set && !set.size) this.pending.delete(sessionId);
          this.opts.onPermissionGone?.(sessionId, requestId);
          this.applyStatus(sessionId);
          return;
        }
        case 'session.renamed':
        case 'session.moved':
        case 'session.created':
        case 'session.deleted':
        case 'session.archived':
        case 'session.unarchived':
          void this.reconcileSafely();
          return;
        default:
          return;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private rememberToolName(sessionId: string, data: Record<string, unknown>): void {
    const id = str(data.id);
    const name = str(data.name);
    if (id && name) this.toolNames.set(`${sessionId}:${id}`, name);
  }

  private toolName(sessionId: string, data: Record<string, unknown>): string {
    const id = str(data.id);
    return this.toolNames.get(`${sessionId}:${id}`) ?? str(data.name) ?? str(data.tool) ?? tr('ferramenta');
  }

  private toolCalled(sessionId: string, event: OpenCodeEvent, data: Record<string, unknown>): void {
    if (!sessionId) return;
    const name = this.toolName(sessionId, data);
    const input = obj(data.input);
    this.addActivity(sessionId, event, describeOpenCodeTool(name, input));
    this.setBase(sessionId, 'working');
    if ((name === 'shell' || name === 'bash') && input.background !== true) {
      const key = str(data.id);
      if (!key) return;
      const desc = describeOpenCodeTool('shell', input);
      this.shellJobs(sessionId).set(key, {
        id: key,
        label: desc.text,
        ...(desc.detail ? { command: desc.detail } : {}),
        startedAt: event.created ?? this.now(),
        background: false,
        kind: 'shell',
      });
      this.applyShells(sessionId);
    }
  }

  private toolEnded(sessionId: string, data: Record<string, unknown>, outcome: ShellOutcome): void {
    const key = str(data.id);
    if (!key) return;
    const tools = this.shellJobs(sessionId);
    const job = tools.get(key);
    if (!job || job.background) return;
    tools.delete(key);
    if (tools.size === 0) this.shells.delete(sessionId);
    const agentId = this.agentOf.get(sessionId);
    if (agentId) this.opts.office.shellDone(agentId, job, outcome, this.now());
    this.applyShells(sessionId);
  }

  private shellStarted(sessionId: string, event: OpenCodeEvent, shell: Record<string, unknown>): void {
    const id = str(shell.id);
    if (!id) return;
    const command = str(shell.command);
    const desc = describeOpenCodeTool('shell', { command });
    const started = obj(shell.time).started;
    this.shellJobs(sessionId).set(id, {
      id,
      label: desc.text,
      ...(desc.detail ? { command: desc.detail } : {}),
      startedAt: typeof started === 'number' ? started : event.created ?? this.now(),
      background: true,
      kind: 'shell',
    });
    this.applyShells(sessionId);
  }

  private shellEnded(sessionId: string, event: OpenCodeEvent, shell: Record<string, unknown>): void {
    const id = str(shell.id);
    if (!id) return;
    const jobs = this.shellJobs(sessionId);
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    if (!jobs.size) this.shells.delete(sessionId);
    const agentId = this.agentOf.get(sessionId);
    if (agentId) {
      const completed = obj(shell.time).completed;
      this.opts.office.shellDone(agentId, job, shellOutcome(shell), typeof completed === 'number' ? completed : event.created ?? this.now());
    }
    this.setBase(sessionId, 'idle');
    this.applyShells(sessionId);
  }

  // ---------------------------------------------------------------- estado

  private remember(agentId: string, sessionId: string): void {
    this.sessionOf.set(agentId, sessionId);
    this.agentOf.set(sessionId, agentId);
  }

  private forget(sessionId: string, agentId: string): void {
    this.sessionOf.delete(agentId);
    if (this.agentOf.get(sessionId) === agentId) this.agentOf.delete(sessionId);
    this.baseStatus.delete(sessionId);
    this.pending.delete(sessionId);
    this.shells.delete(sessionId);
  }

  private setBase(sessionId: string, status: 'working' | 'idle'): void {
    this.baseStatus.set(sessionId, status);
    this.applyStatus(sessionId);
  }

  private statusFor(sessionId: string, base?: 'working' | 'idle'): AgentStatus {
    if (this.pending.get(sessionId)?.size) return 'waiting';
    const jobs = this.shells.get(sessionId);
    if (jobs && [...jobs.values()].some((job) => job.background)) return 'shell';
    return base ?? this.baseStatus.get(sessionId) ?? 'idle';
  }

  private applyStatus(sessionId: string): void {
    const agentId = this.agentOf.get(sessionId);
    if (!agentId) return;
    const status = this.statusFor(sessionId);
    this.opts.office.setStatus(agentId, status, status === 'waiting' ? PERMISSION_REASON() : undefined);
  }

  private shellJobs(sessionId: string): Map<string, ShellJob> {
    let jobs = this.shells.get(sessionId);
    if (!jobs) {
      jobs = new Map();
      this.shells.set(sessionId, jobs);
    }
    return jobs;
  }

  private applyShells(sessionId: string): void {
    const agentId = this.agentOf.get(sessionId);
    if (!agentId) return;
    this.opts.office.setShells(agentId, [...this.shellJobs(sessionId).values()]);
    this.applyStatus(sessionId);
  }

  private addActivity(sessionId: string, event: OpenCodeEvent, description: Omit<Activity, 'id' | 'at'>, id?: string): void {
    const agentId = this.agentOf.get(sessionId);
    if (!agentId) return;
    this.opts.office.addActivity(agentId, {
      id: id ?? event.id ?? `${agentId}#oc:${event.type}:${event.created ?? this.now()}`,
      at: event.created ?? this.now(),
      ...description,
    }, true);
  }

  private fail(error: unknown): void {
    const message = errMsg(error).slice(0, 180);
    this.error = message;
    log.warnOnce(`opencode-source:${message}`, tr('OpenCode: falha ao consultar a API ({0}).', [message]));
  }
}
