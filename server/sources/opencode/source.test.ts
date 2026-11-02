import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { OpenCodeSource } from './source';

setQuiet(true);

afterEach(() => vi.useRealTimers());

function setup(fetchImpl: typeof fetch) {
  let clock = 1_800_000_000_000;
  const now = () => clock;
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
  const source = new OpenCodeSource({ accounts, office, home: '/home/test', baseUrl: 'http://127.0.0.1:4096', fetchImpl, now, pollMs: 60_000 });
  return { source, office, accounts, advance: (ms: number) => { clock += ms; } };
}

describe('fonte OpenCode pela API v2', () => {
  it('registra a conta e coloca sessões em execução na sala do projeto', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/info') return Response.json({ version: '2.2.4' });
      if (path === '/api/session/active') return Response.json({ data: { ses_test123: { type: 'busy' } } });
      if (path === '/api/session/ses_test123') {
        return Response.json({ data: {
          id: 'ses_test123',
          title: 'Analisar integração',
          model: { providerID: 'ollama', modelID: 'qwen2.5-coder:3b' },
          location: { directory: '/projetos/habblaud' },
          time: { created: 1_799_999_000_000 },
        } });
      }
      return new Response(null, { status: 404 });
    };
    const ctx = setup(fetchImpl);
    await ctx.source.start();
    const agent = ctx.office.list().find((a) => a.provider === 'opencode') as AgentInfo | undefined;
    expect(agent).toMatchObject({
      kind: 'main',
      provider: 'opencode',
      account: '.opencode',
      sessionId: 'ses_test123',
      roomId: '/projetos/habblaud',
      status: 'working',
      title: 'Analisar integração',
      model: 'ollama/qwen2.5-coder:3b',
    });
    expect(ctx.accounts.entriesOf('opencode')).toHaveLength(1);
    expect(ctx.source.sources()[0]).toMatchObject({ provider: 'opencode', sessions: 1, ok: true });
    ctx.source.stop();
  });

  it('mantém o último estado se a API falhar e não inventa sessão encerrada', async () => {
    let fail = false;
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (fail) return new Response(null, { status: 503 });
      if (path === '/api/info') return Response.json({ version: '2.2.4' });
      if (path === '/api/session/active') return Response.json({ data: { ses_test123: { type: 'busy' } } });
      if (path === '/api/session/ses_test123') return Response.json({ data: { id: 'ses_test123', location: { directory: '/projetos/x' }, time: { created: 1_799_999_000_000 } } });
      return new Response(null, { status: 404 });
    };
    vi.useFakeTimers();
    const ctx = setup(fetchImpl);
    await ctx.source.start();
    fail = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.office.list().some((a) => a.provider === 'opencode' && a.status === 'working')).toBe(true);
    expect(ctx.source.sources()[0].ok).toBe(false);
    ctx.source.stop();
  });
});
