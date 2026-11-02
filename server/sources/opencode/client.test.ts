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
});
