import { join } from 'node:path';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountsService, AccountEntry } from '../../accounts/service';
import type { SourceInfo } from '../../../shared/types';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { OpenCodeApiClient, type OpenCodeSession } from './client';
import { tr } from '../../../shared/i18n';

export interface OpenCodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  home: string;
  /** Origem explícita; ausente = descoberta pelo registro padrão (a partir da Task 3). */
  baseUrl?: string;
  password?: string;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const ACCOUNT_COLOR = '#d5a84f';
const ACCOUNT_DIR_NAME = '.opencode';

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

/** Observa execuções OpenCode pela API HTTP v2; não lê banco, credenciais nem arquivos internos. */
export class OpenCodeSource implements AgentSource {
  private readonly opts: Pick<OpenCodeSourceOptions, 'accounts' | 'office' | 'home' | 'baseUrl'>;
  readonly provider = 'opencode' as const;
  private readonly client?: OpenCodeApiClient;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly entries: readonly AccountEntry[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly present = new Set<string>();
  private polling = false;
  private stopped = false;
  private error?: string;
  private apiVersion?: string;

  constructor(opts: OpenCodeSourceOptions) {
    this.opts = { accounts: opts.accounts, office: opts.office, home: opts.home, baseUrl: opts.baseUrl };
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 1_500;
    try {
      this.client = new OpenCodeApiClient({
        baseUrl: opts.baseUrl ?? 'http://127.0.0.1:4096',
        password: opts.password,
        fetchImpl: opts.fetchImpl,
      });
    } catch (error) {
      this.error = errMsg(error).slice(0, 180);
    }
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

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    this.opts.office.beginBoot();
    try {
      await this.safePoll();
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => void this.safePoll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of this.present) this.opts.office.closeMain(id);
    this.present.clear();
  }

  sources(): SourceInfo[] {
    return [{
      label: 'OpenCode',
      provider: 'opencode',
      path: 'API HTTP local',
      sessions: this.present.size,
      ok: !this.error,
      ...(this.error ? { error: this.error } : {}),
    }];
  }

  transcriptPathOf(_agentId: string): undefined {
    return undefined;
  }

  private async safePoll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      await this.poll();
      this.error = undefined;
    } catch (error) {
      this.error = errMsg(error).slice(0, 180);
      log.warnOnce(`opencode-source:${this.error}`, tr('OpenCode: falha ao consultar a API ({0}).', [this.error]));
    } finally {
      this.polling = false;
    }
  }

  private async poll(): Promise<void> {
    const client = this.client;
    if (!client) throw new Error(this.error ?? 'Configuração OpenCode inválida');
    if (!this.apiVersion) {
      const info = await client.info();
      this.apiVersion = typeof info.version === 'string' ? info.version : 'desconhecida';
    }
    const active = await client.activeSessions();
    const ids = Object.keys(active).filter((id) => id.startsWith('ses'));
    const sessions = await Promise.all(ids.map((id) => client.session(id)));
    const next = new Set<string>();
    const account = this.entries[0];
    if (!account) throw new Error('Conta OpenCode não registrada');
    const now = this.now();

    for (const session of sessions) {
      // Sessões filhas serão mapeadas como subagentes em uma fase posterior.
      if (session.parentID) continue;
      const cwd = session.location?.directory;
      if (typeof cwd !== 'string' || !cwd.startsWith('/')) continue;
      const id = `${account.id}:${session.id}`;
      this.opts.office.addMain({
        id,
        provider: 'opencode',
        account: account.id,
        sessionId: session.id,
        cwd,
        role: 'Agente OpenCode',
        title: typeof session.title === 'string' ? session.title.slice(0, 240) : undefined,
        model: modelLabel(session.model),
        startedAt: sessionCreatedAt(session, now),
        status: 'working',
      });
      next.add(id);
    }

    for (const id of this.present) if (!next.has(id)) this.opts.office.closeMain(id);
    this.present.clear();
    for (const id of next) this.present.add(id);
  }
}
