import { describe, expect, it } from 'vitest';
import { OpenCodeApiError, type OpenCodeMessagesQuery } from './client';
import { OpenCodeConversation } from './conversation';

const SESSION = 'ses_1234567890abcdef';

function client(initial: unknown[]) {
  let messages = initial;
  const calls: Array<{ sessionId: string; query?: OpenCodeMessagesQuery }> = [];
  return {
    calls,
    set(next: unknown[]) {
      messages = next;
    },
    async messages(sessionId: string, query?: OpenCodeMessagesQuery) {
      calls.push({ sessionId, query });
      return messages;
    },
  };
}

function conversation(messages: unknown[], options: { initEntries?: number } = {}) {
  const fake = client(messages);
  return { fake, conv: new OpenCodeConversation({ client: fake, sessionId: SESSION, agentId: '.opencode:ses_1234567890abcdef', ...options }) };
}

const user = (text: string) => ({ id: `msg_${text.replace(/[^a-zA-Z0-9]+/g, '_')}`, type: 'user', time: { created: 1_000 }, text });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'msg_a',
  type: 'assistant',
  time: { created: 2_000, completed: 5_000 },
  finish: 'stop',
  content,
  ...extra,
});

describe('conversa do OpenCode', () => {
  it('monta user, assistant, thinking, tool e result na ordem', async () => {
    const { conv, fake } = conversation([
      user('Arruma o carrinho'),
      assistant([
        { type: 'reasoning', text: 'Vou olhar o código', time: { created: 2_100 } },
        { type: 'text', text: 'Pronto: o carrinho soma o frete.' },
        {
          type: 'tool',
          id: 'call_1',
          name: 'shell',
          state: { status: 'completed', input: { command: 'npm test' }, content: [{ type: 'text', text: 'todos passaram' }] },
          time: { created: 2_200, completed: 4_000 },
        },
      ]),
    ]);
    const init = await conv.load();
    expect(init.agentId).toBe('.opencode:ses_1234567890abcdef');
    expect(init.entries.map((entry) => entry.kind)).toEqual(['user', 'thinking', 'assistant', 'tool', 'result']);
    expect(init.entries[0]).toMatchObject({ kind: 'user', text: 'Arruma o carrinho' });
    expect(init.entries[1]).toMatchObject({ kind: 'thinking', text: 'Vou olhar o código' });
    expect(init.entries[3]).toMatchObject({ kind: 'tool', tool: 'shell', title: 'shell(npm test)' });
    const tool = init.entries[3];
    const result = init.entries[4];
    expect(result).toMatchObject({ kind: 'result', text: 'todos passaram' });
    if (tool.kind === 'tool' && result.kind === 'result') expect(result.toolUseId).toBe(tool.id);
    expect(init.truncated).toBe(false);
    expect(fake.calls).toEqual([{ sessionId: SESSION, query: { limit: 200, order: 'asc' } }]);
  });

  it('não emite mensagem/ferramenta ainda em streaming; emite quando completa', async () => {
    const pending = [
      {
        id: 'msg_a',
        type: 'assistant',
        time: { created: 2_000 },
        content: [
          { type: 'text', text: 'escrevendo…' },
          { type: 'tool', id: 'call_1', name: 'shell', state: { status: 'running', input: { command: 'npm test' }, metadata: {} }, time: { created: 2_100 } },
        ],
      },
    ];
    const { conv, fake } = conversation(pending);
    expect((await conv.load()).entries).toEqual([]);

    fake.set([assistant([{ type: 'text', text: 'Terminei.' }])]);
    const poll = await conv.poll();
    expect(poll.append?.map((entry) => entry.kind)).toEqual(['assistant']);
    expect(poll.append?.[0]).toMatchObject({ text: 'Terminei.' });
  });

  it('faz diff por id e não repete entradas', async () => {
    const messages = [user('primeira'), assistant([{ type: 'text', text: 'resposta' }])];
    const { conv } = conversation(messages);
    const init = await conv.load();
    expect(init.entries).toHaveLength(2);
    expect((await conv.poll()).append).toEqual([]);

    messages.push(user('segunda'));
    const poll = await conv.poll();
    expect(poll.append).toHaveLength(1);
    expect(poll.append?.[0]).toMatchObject({ kind: 'user', text: 'segunda' });
    expect((await conv.poll()).append).toEqual([]);
  });

  it('limita o init às entradas mais recentes e marca truncated', async () => {
    const messages = [user('a'), user('b'), user('c')];
    const { conv } = conversation(messages, { initEntries: 2 });
    const init = await conv.load();
    expect(init.entries.map((entry) => (entry.kind === 'user' ? entry.text : ''))).toEqual(['b', 'c']);
    expect(init.truncated).toBe(true);
  });

  it('sessão apagada (404) devolve stop', async () => {
    const fake = {
      async messages() {
        throw new OpenCodeApiError('API OpenCode: HTTP 404', 404);
      },
    };
    const conv = new OpenCodeConversation({ client: fake, sessionId: SESSION, agentId: 'x' });
    expect(await conv.poll()).toEqual({ stop: true });
  });

  it('outros erros sobem para o terminal tentar de novo', async () => {
    const fake = {
      async messages() {
        throw new OpenCodeApiError('API OpenCode: HTTP 503', 503);
      },
    };
    const conv = new OpenCodeConversation({ client: fake, sessionId: SESSION, agentId: 'x' });
    await expect(conv.poll()).rejects.toThrow(/HTTP 503/);
  });
});
