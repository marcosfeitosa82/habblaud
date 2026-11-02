import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentStatus } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import type { OpenCodeEventStreamOptions } from './events';
import type { OpenCodeEndpoint } from './discovery';
import { OpenCodeSource, type OpenCodePermissionNotice } from './source';

setQuiet(true);

afterEach(() => vi.useRealTimers());

interface Session {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  location?: { directory?: string };
  time?: { created?: number; updated?: number };
}

interface World {
  sessions: Session[];
  active: Record<string, unknown>;
  permissions?: Record<string, Array<{ id: string; sessionID: string; action: string; resources: string[]; message?: string }>>;
  failSessions?: boolean;
  failActive?: boolean;
}

interface Overrides {
  onPermission?: (notice: OpenCodePermissionNotice) => void;
  onPermissionGone?: (sessionId: string, requestId: string) => void;
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('tempo esgotado esperando a condição');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function session(id: string, updated: number, extra: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    location: { directory: '/projetos/habblaud' },
    time: { created: updated - 1_000, updated },
    ...extra,
  };
}

function setup(world: World, overrides: Overrides = {}) {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  let endpointUrl = 'http://127.0.0.1:49374';
  const discoverCalls: string[] = [];
  const requested: string[] = [];
  let streamOptions: OpenCodeEventStreamOptions | undefined;
  const stream = { start: vi.fn(), stop: vi.fn() };

  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(`${url.origin}${url.pathname}`);
    if (url.pathname === '/api/session') {
      if (world.failSessions) return new Response(null, { status: 503 });
      return Response.json({ data: world.sessions });
    }
    if (url.pathname === '/api/session/active') {
      if (world.failActive) return new Response(null, { status: 503 });
      return Response.json({ data: world.active });
    }
    const permission = /^\/api\/session\/([^/]+)\/permission$/.exec(url.pathname);
    if (permission) {
      return Response.json({ data: world.permissions?.[decodeURIComponent(permission[1])] ?? [] });
    }
    return new Response(null, { status: 404 });
  };

  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: '/home/test', env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'test',
    startedAt: clock,
    accounts: (sessions) => accounts.list(sessions),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;

  const discover = async (): Promise<OpenCodeEndpoint> => {
    discoverCalls.push(endpointUrl);
    return { url: endpointUrl, origin: 'service' };
  };

  const source = new OpenCodeSource({
    accounts,
    office,
    home: '/home/test',
    baseUrl: endpointUrl,
    fetchImpl,
    now,
    recentMs: 30 * 60_000,
    reconcileMs: 60_000,
    discover,
    eventStream: (options) => {
      streamOptions = options;
      return stream;
    },
    ...overrides,
  });

  return {
    source,
    office,
    accounts,
    requested,
    discoverCalls,
    stream,
    emit: (event: { type: string; data: unknown; id?: string; created?: number }) => streamOptions?.onEvent(event),
    setState: (state: 'open' | 'closed') => streamOptions?.onState?.(state),
    setEndpoint: (url: string) => {
      endpointUrl = url;
    },
    setClock: (value: number) => {
      clock = value;
    },
    now,
    agent: (sessionId: string): AgentInfo | undefined => office.list().find((a) => a.provider === 'opencode' && a.sessionId === sessionId),
    status: (sessionId: string): AgentStatus | undefined => office.list().find((a) => a.provider === 'opencode' && a.sessionId === sessionId)?.status,
  };
}

describe('fonte OpenCode pela API v2', () => {
  it('registra a conta e mostra sessões ativas como working e recentes como idle', async () => {
    const ctx = setup({
      sessions: [session('ses_active', ctxClock()), session('ses_idle', ctxClock() - 5 * 60_000)],
      active: { ses_active: { type: 'running' } },
    });
    await ctx.source.start();
    const active = ctx.agent('ses_active');
    const idle = ctx.agent('ses_idle');
    expect(active).toMatchObject({
      kind: 'main',
      provider: 'opencode',
      account: '.opencode',
      roomId: '/projetos/habblaud',
      status: 'working',
      title: 'ses_active',
    });
    expect(idle?.status).toBe('idle');
    expect(ctx.accounts.entriesOf('opencode')).toHaveLength(1);
    expect(ctx.source.sources()[0]).toMatchObject({ provider: 'opencode', sessions: 2, ok: true });
    expect(ctx.requested).toContain('http://127.0.0.1:49374/api/session/ses_active/permission');
    ctx.source.stop();
  });

  it('não mostra sessão mais velha que recentMs nem filha como principal', async () => {
    const now = ctxClock();
    const ctx = setup({
      sessions: [
        session('ses_velha', now - 2 * 3600_000),
        session('ses_pai', now),
        session('ses_filha', now, { parentID: 'ses_pai', agent: 'explore' }),
      ],
      active: {},
    });
    await ctx.source.start();
    expect(ctx.agent('ses_velha')).toBeUndefined();
    expect(ctx.agent('ses_pai')?.kind).toBe('main');
    const child = ctx.agent('ses_filha');
    expect(child).toMatchObject({ kind: 'sub', parentId: '.opencode:ses_pai', role: 'explore', background: true });
    ctx.source.stop();
  });

  it('mapeia session.status busy/idle e session.idle', async () => {
    const ctx = setup({ sessions: [session('ses_1', ctxClock())], active: {} });
    await ctx.source.start();
    expect(ctx.status('ses_1')).toBe('idle');

    ctx.emit({ type: 'session.status', data: { sessionID: 'ses_1', status: { type: 'busy' } } });
    expect(ctx.status('ses_1')).toBe('working');

    ctx.emit({ type: 'session.status', data: { sessionID: 'ses_1', status: { type: 'idle' } } });
    expect(ctx.status('ses_1')).toBe('idle');

    ctx.emit({ type: 'session.status', data: { sessionID: 'ses_1', status: { type: 'busy' } } });
    ctx.emit({ type: 'session.idle', data: { sessionID: 'ses_1' } });
    expect(ctx.status('ses_1')).toBe('idle');
    ctx.source.stop();
  });

  it('permission.asked deixa waiting; permission.replied volta ao status anterior', async () => {
    const seen: OpenCodePermissionNotice[] = [];
    const gone: Array<[string, string]> = [];
    const ctx = setup(
      { sessions: [session('ses_1', ctxClock())], active: {} },
      { onPermission: (notice) => seen.push(notice), onPermissionGone: (sessionId, requestId) => gone.push([sessionId, requestId]) },
    );
    await ctx.source.start();
    ctx.emit({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_1', action: 'shell', resources: ['ls'] } });
    expect(ctx.status('ses_1')).toBe('waiting');
    expect(seen).toEqual([{ agentId: '.opencode:ses_1', sessionId: 'ses_1', requestId: 'per_1', action: 'shell', resources: ['ls'], message: undefined }]);

    ctx.emit({ type: 'permission.replied', data: { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' } });
    expect(ctx.status('ses_1')).toBe('idle');
    expect(gone).toEqual([['ses_1', 'per_1']]);
    ctx.source.stop();
  });

  it('um erro numa chamada não fecha as outras sessões', async () => {
    const ctx = setup({ sessions: [session('ses_1', ctxClock())], active: {}, failActive: true });
    await ctx.source.start();
    expect(ctx.agent('ses_1')).toBeDefined();
    expect(ctx.source.sources()[0].ok).toBe(false);
    expect(ctx.source.sources()[0].error).toBeTruthy();
    ctx.source.stop();
  });

  it('redescobre quando o stream cai', async () => {
    const ctx = setup({ sessions: [session('ses_1', ctxClock())], active: {} });
    await ctx.source.start();
    expect(ctx.discoverCalls).toEqual(['http://127.0.0.1:49374']);
    ctx.setEndpoint('http://127.0.0.1:50000');
    ctx.setState('closed');
    await waitFor(() => ctx.discoverCalls.length >= 2);
    await waitFor(() => ctx.requested.some((url) => url.startsWith('http://127.0.0.1:50000')));
    expect(ctx.discoverCalls).toContain('http://127.0.0.1:50000');
    ctx.source.stop();
  });

  it('shell em segundo plano vira status shell e termina em idle', async () => {
    const ctx = setup({ sessions: [session('ses_1', ctxClock())], active: {} });
    await ctx.source.start();
    const started = ctx.now();
    ctx.emit({
      type: 'session.shell.started',
      data: {
        sessionID: 'ses_1',
        shell: { id: 'sh_1', status: 'running', command: 'npm run dev', cwd: '/projetos/habblaud', shell: 'bash', file: '', time: { started } },
      },
    });
    expect(ctx.status('ses_1')).toBe('shell');
    expect(ctx.agent('ses_1')?.shells?.[0]).toMatchObject({ id: 'sh_1', background: true, command: 'npm run dev' });

    ctx.emit({
      type: 'session.shell.ended',
      data: {
        sessionID: 'ses_1',
        shell: { id: 'sh_1', status: 'exited', command: 'npm run dev', cwd: '/projetos/habblaud', shell: 'bash', file: '', exit: 0, time: { started, completed: started + 1_000 } },
        output: { output: '', cursor: 0, size: 0, truncated: false },
      },
    });
    expect(ctx.status('ses_1')).toBe('idle');
    expect(ctx.agent('ses_1')?.shells).toBeUndefined();
    ctx.source.stop();
  });

  it('usa o nome de tool.input.started para descrever a ferramenta chamada', async () => {
    const ctx = setup({ sessions: [session('ses_1', ctxClock())], active: {} });
    await ctx.source.start();
    ctx.emit({ type: 'session.tool.input.started', data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: 'call_1', name: 'grep' } });
    ctx.emit({ type: 'session.tool.called', data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: 'call_1', input: { pattern: 'TODO' }, executed: true } });
    expect(ctx.agent('ses_1')?.activity).toMatchObject({ kind: 'search' });
    ctx.source.stop();
  });

  it('mantém o último estado se a API falhar depois do boot', async () => {
    const world: World = { sessions: [session('ses_1', ctxClock())], active: { ses_1: { type: 'running' } } };
    const ctx = setup(world);
    await ctx.source.start();
    expect(ctx.status('ses_1')).toBe('working');
    world.failSessions = true;
    ctx.setState('closed');
    await waitFor(() => ctx.source.sources()[0].ok === false);
    expect(ctx.status('ses_1')).toBe('working');
    ctx.source.stop();
  });
});

/** Relógio inicial usado pelos cenários (o setup começa neste instante). */
function ctxClock(): number {
  return 1_800_000_000_000;
}
