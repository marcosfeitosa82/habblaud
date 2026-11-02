import { describe, expect, it } from 'vitest';
import { OpenCodeApiClient } from './client';

describe('cliente HTTP do OpenCode', () => {
  it('aceita apenas endpoints locais e sem credenciais embutidas', () => {
    expect(() => new OpenCodeApiClient({ baseUrl: 'http://example.com:4096' })).toThrow(/endereço local/);
    expect(() => new OpenCodeApiClient({ baseUrl: 'http://127.0.0.1:4096/path' })).toThrow(/somente origem/);
    expect(() => new OpenCodeApiClient({ baseUrl: 'http://user:secret@127.0.0.1:4096' })).toThrow(/somente origem/);
  });

  it('envia Basic Auth sem expor a senha na URL', async () => {
    let requestedUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      return Response.json({ data: {} });
    };
    const client = new OpenCodeApiClient({ baseUrl: 'http://127.0.0.1:4096', password: 'segredo-de-teste', fetchImpl });
    await client.activeSessions();
    expect(requestedUrl).toBe('http://127.0.0.1:4096/api/session/active');
    expect(new Headers(requestInit?.headers).get('authorization')).toBe(`Basic ${Buffer.from('opencode:segredo-de-teste').toString('base64')}`);
  });

  it('rejeita resposta malformada da rota de sessões ativas', async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ data: [] });
    const client = new OpenCodeApiClient({ baseUrl: 'http://localhost:4096', fetchImpl });
    await expect(client.activeSessions()).rejects.toThrow(/Resposta inválida/);
  });

  it('lista sessões com limit/order/archived e valida o envelope', async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requested.push(String(input));
      return Response.json({ data: [{ id: 'ses_1' }] });
    };
    const client = new OpenCodeApiClient({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
    await expect(client.sessions({ limit: 50, order: 'desc', archived: false })).resolves.toEqual([{ id: 'ses_1' }]);
    expect(requested[0]).toBe('http://127.0.0.1:4096/api/session?limit=50&order=desc&archived=false');

    const broken = new OpenCodeApiClient({ baseUrl: 'http://127.0.0.1:4096', fetchImpl: async () => Response.json({ data: {} }) });
    await expect(broken.sessions()).rejects.toThrow(/Resposta inválida/);
    await expect(broken.messages('ses_1')).rejects.toThrow(/Resposta inválida/);
  });

  it('lê mensagens e permissões de uma sessão', async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      requested.push(path);
      if (path.endsWith('/message')) return Response.json({ data: [{ id: 'msg_1' }] });
      if (path.endsWith('/permission')) {
        return Response.json({ data: [{ id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['ls'] }] });
      }
      return new Response(null, { status: 404 });
    };
    const client = new OpenCodeApiClient({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
    await expect(client.messages('ses_1', { limit: 10, order: 'asc' })).resolves.toEqual([{ id: 'msg_1' }]);
    await expect(client.permissions('ses_1')).resolves.toEqual([
      { id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['ls'] },
    ]);
    expect(requested).toEqual(['/api/session/ses_1/message', '/api/session/ses_1/permission']);
  });

  it('responde permissão, interrompe e manda prompt com POST e JSON', async () => {
    const calls: Array<{ url: string; method?: string; body?: string; type: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: typeof init?.body === 'string' ? init.body : undefined,
        type: new Headers(init?.headers).get('content-type'),
      });
      return Response.json({});
    };
    const client = new OpenCodeApiClient({ baseUrl: 'http://127.0.0.1:4096', fetchImpl });
    await client.replyPermission('ses_1', 'per_1', 'once');
    await client.replyPermission('ses_1', 'per_2', 'reject', 'não pode');
    await client.interrupt('ses_1', true);
    await client.prompt('ses_1', 'oi');
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:4096/api/session/ses_1/permission/per_1/reply', method: 'POST', body: '{"decision":"once"}', type: 'application/json' },
      { url: 'http://127.0.0.1:4096/api/session/ses_1/permission/per_2/reply', method: 'POST', body: '{"decision":"reject","message":"não pode"}', type: 'application/json' },
      { url: 'http://127.0.0.1:4096/api/session/ses_1/interrupt?resume=true', method: 'POST', body: undefined, type: null },
      { url: 'http://127.0.0.1:4096/api/session/ses_1/prompt', method: 'POST', body: '{"text":"oi"}', type: 'application/json' },
    ]);
  });

  it('eventResponse não usa timeout curto e envia accept text/event-stream', async () => {
    let init: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_input, requestInit) => {
      init = requestInit;
      return new Response('', { status: 200 });
    };
    const client = new OpenCodeApiClient({ baseUrl: 'http://127.0.0.1:4096', password: 'segredo', fetchImpl });
    const controller = new AbortController();
    const response = await client.eventResponse(controller.signal);
    expect(response.ok).toBe(true);
    expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from('opencode:segredo').toString('base64')}`);
    expect(init?.signal).toBe(controller.signal);
  });
});
