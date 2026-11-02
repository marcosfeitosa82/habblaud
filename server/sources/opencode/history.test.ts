import { describe, expect, it } from 'vitest';
import { encodeCwd } from '../watcher';
import type { OpenCodeSessionsQuery } from './client';
import { OpenCodeHistory, type OpenCodeHistoryClient } from './history';

const SESSION = 'ses_1234567890abcdef';
const OTHER = 'ses_abcdef1234567890';
const ACCOUNT = '.opencode';
const CWD = '/projetos/loja';

function client(sessions: unknown[]): OpenCodeHistoryClient & { calls: Array<OpenCodeSessionsQuery | undefined> } {
  const calls: Array<OpenCodeSessionsQuery | undefined> = [];
  return {
    calls,
    async sessions(query?: OpenCodeSessionsQuery) {
      calls.push(query);
      return sessions as never[];
    },
    async messages() {
      return [];
    },
  };
}

function history(api: OpenCodeHistoryClient | undefined, open: Record<string, string> = {}) {
  const asked: string[] = [];
  const h = new OpenCodeHistory({
    client: () => api,
    accounts: () => [{ id: ACCOUNT, dir: '/home/test/.local/share/opencode' }],
    openAgentOf: (account, sessionId) => {
      asked.push(`${account}:${sessionId}`);
      return open[sessionId];
    },
    now: () => 1_800_000_000_000,
  });
  return { h, asked };
}

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Título ${id}`,
  location: { directory: CWD },
  time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
  ...extra,
});

describe('histórico do OpenCode', () => {
  it('lista sessões recentes com provider opencode, projeto, título e horários', async () => {
    const api = client([
      session(SESSION),
      session(OTHER, { time: { created: 1_700_000_200_000, updated: 1_700_000_300_000 } }),
    ]);
    const { h, asked } = history(api, { [OTHER]: '.opencode:' + OTHER });
    const list = await h.list();
    expect(api.calls).toEqual([{ limit: 150, order: 'desc', archived: false }]);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      account: ACCOUNT,
      provider: 'opencode',
      sessionId: OTHER,
      project: CWD,
      projectDir: encodeCwd(CWD),
      title: `Título ${OTHER}`,
      firstAt: 1_700_000_200_000,
      lastAt: 1_700_000_300_000,
      size: 0,
      open: true,
      agentId: `.opencode:${OTHER}`,
    });
    expect(list[1]).toMatchObject({ sessionId: SESSION, open: false });
    expect(list[1].agentId).toBeUndefined();
    expect(asked).toContain(`${ACCOUNT}:${SESSION}`);
  });

  it('exclui filhas e arquivadas', async () => {
    const api = client([
      session(SESSION, { parentID: OTHER }),
      session(OTHER, { time: { created: 1_700_000_000_000, updated: 1_700_000_100_000, archived: 1_700_000_200_000 } }),
    ]);
    const { h } = history(api);
    expect(await h.list()).toEqual([]);
  });

  it('resolve uma sessão da conta com conversation; id inválido = 400; conta errada = 404', async () => {
    const api = client([]);
    const { h } = history(api);
    const found = h.resolve(ACCOUNT, SESSION);
    expect('conversation' in found).toBe(true);
    if ('conversation' in found) {
      const conv = found.conversation!();
      const init = await conv.load();
      expect(init.agentId).toBe(`session:${ACCOUNT}:${SESSION}`);
    }
    expect(h.resolve(ACCOUNT, '../../etc/passwd')).toEqual({ status: 400, error: 'id de sessão inválido' });
    expect(h.resolve(ACCOUNT, 'ses_curto')).toEqual({ status: 400, error: 'id de sessão inválido' });
    expect(h.resolve('.outra', SESSION)).toEqual({ status: 404, error: 'conta desconhecida' });
    expect(h.resolve(ACCOUNT, `${SESSION}/../outra`)).toEqual({ status: 400, error: 'id de sessão inválido' });
  });

  it('usa o agente aberto no conversation e o streamId quando não há agente', async () => {
    const api = client([]);
    const open = { [SESSION]: `.opencode:${SESSION}` };
    const { h } = history(api, open);
    const found = h.resolve(ACCOUNT, SESSION);
    if ('conversation' in found) {
      expect((await found.conversation!().load()).agentId).toBe(`.opencode:${SESSION}`);
    }
  });

  it('sem cliente lista falha com serviço indisponível e resolve dá 404', async () => {
    const { h } = history(undefined);
    await expect(h.list()).rejects.toThrow(/serviço OpenCode indisponível/);
    expect(h.resolve(ACCOUNT, SESSION)).toEqual({ status: 404, error: 'serviço OpenCode indisponível' });
  });

  it('não aceita id com path traversal', () => {
    const { h } = history(client([]));
    for (const bad of ['../../etc/passwd', '..', `${SESSION}/../${SESSION}`, `${SESSION}.jsonl`, 'ses_', '']) {
      expect(h.resolve(ACCOUNT, bad)).toMatchObject({ status: 400 });
    }
  });
});
