import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverEndpoint, parseServiceFile, probeEndpoint, serviceFilePath, type OpenCodeEndpoint } from './discovery';

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'habblaud-opencode-'));
  homes.push(home);
  return home;
}

function writeService(home: string, data: unknown): void {
  const dir = join(home, '.local', 'state', 'opencode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'service.json'), typeof data === 'string' ? data : JSON.stringify(data));
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('descoberta do serviço OpenCode', () => {
  it('lê o registro padrão e aceita um serviço cujo /api/info casa PID e versão', async () => {
    const home = tempHome();
    writeService(home, { id: 'srv', version: '2.2.4', url: 'http://127.0.0.1:49374', pid: 123, password: 'segredo' });
    const calls: string[] = [];
    const endpoint = await discoverEndpoint({
      home,
      env: {},
      pidAlive: (pid) => pid === 123,
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        expect(new Headers(init?.headers).get('authorization')).toBe(basicAuth('segredo'));
        return Response.json({ version: '2.2.4', pid: 123 });
      },
    });
    expect(endpoint).toMatchObject({
      origin: 'service',
      url: 'http://127.0.0.1:49374',
      password: 'segredo',
      version: '2.2.4',
      pid: 123,
    });
    expect(calls).toEqual(['http://127.0.0.1:49374/api/info']);
  });

  it('ignora registro com PID morto, JSON inválido ou versão fora da 2.x', async () => {
    const deadHome = tempHome();
    writeService(deadHome, { version: '2.2.4', url: 'http://127.0.0.1:49374', pid: 123 });
    const dead = await discoverEndpoint({
      home: deadHome,
      env: {},
      pidAlive: () => false,
      fetchImpl: async () => {
        throw new Error('não deveria consultar um PID morto');
      },
    });
    expect(dead).toMatchObject({ origin: 'fallback', url: 'http://127.0.0.1:4096' });

    const brokenHome = tempHome();
    writeService(brokenHome, '{ isto não é json');
    const broken = await discoverEndpoint({ home: brokenHome, env: {}, pidAlive: () => true });
    expect(broken).toMatchObject({ origin: 'fallback', url: 'http://127.0.0.1:4096' });

    const futureHome = tempHome();
    writeService(futureHome, { version: '3.0.0', url: 'http://127.0.0.1:49374', pid: 123 });
    const future = await discoverEndpoint({
      home: futureHome,
      env: {},
      pidAlive: () => true,
      fetchImpl: async () => Response.json({ version: '3.0.0', pid: 123 }),
    });
    expect(future).toMatchObject({ origin: 'fallback', url: 'http://127.0.0.1:4096' });
  });

  it('ignora o registro quando o /api/info aponta outro PID', async () => {
    const home = tempHome();
    writeService(home, { version: '2.2.4', url: 'http://127.0.0.1:49374', pid: 123 });
    const endpoint = await discoverEndpoint({
      home,
      env: {},
      pidAlive: () => true,
      fetchImpl: async () => Response.json({ version: '2.2.4', pid: 999 }),
    });
    expect(endpoint).toMatchObject({ origin: 'fallback', url: 'http://127.0.0.1:4096' });
  });

  it('HABBLAUD_OPENCODE_URL explícita tem precedência e não lê o registro', async () => {
    const home = tempHome();
    writeService(home, { version: '2.2.4', url: 'http://127.0.0.1:49374', pid: 123 });
    const endpoint = await discoverEndpoint({
      home,
      env: {},
      explicitUrl: 'http://127.0.0.1:4097',
      explicitPassword: 'da-env',
      pidAlive: () => {
        throw new Error('não deveria olhar o registro');
      },
      fetchImpl: async () => {
        throw new Error('não deveria consultar o serviço');
      },
    });
    expect(endpoint).toEqual({ url: 'http://127.0.0.1:4097', password: 'da-env', origin: 'explicit' });
  });

  it('recusa URL explícita não loopback, com caminho ou com credenciais', async () => {
    const home = tempHome();
    await expect(discoverEndpoint({ home, env: {}, explicitUrl: 'http://example.com:4096' })).rejects.toThrow(/endereço local/);
    await expect(discoverEndpoint({ home, env: {}, explicitUrl: 'http://127.0.0.1:4096/path' })).rejects.toThrow(/somente origem/);
    await expect(discoverEndpoint({ home, env: {}, explicitUrl: 'http://user:senha@127.0.0.1:4096' })).rejects.toThrow(/somente origem/);
  });

  it('aceita XDG_STATE_HOME e o fallback ~/.local/state', () => {
    expect(serviceFilePath({ XDG_STATE_HOME: '/x' }, '/h')).toBe('/x/opencode/service.json');
    expect(serviceFilePath({}, '/h')).toBe('/h/.local/state/opencode/service.json');
  });

  it('valida o formato do registro e não vaza a senha em mensagens de erro', async () => {
    expect(parseServiceFile(JSON.stringify({ url: 'http://127.0.0.1:49374', pid: 1 }))).toEqual({ url: 'http://127.0.0.1:49374', pid: 1 });
    expect(parseServiceFile(JSON.stringify({ url: 'http://127.0.0.1:49374' }))).toBeUndefined();
    expect(parseServiceFile(JSON.stringify({ url: 'http://127.0.0.1:49374', pid: -1 }))).toBeUndefined();
    expect(parseServiceFile(JSON.stringify({ url: 42, pid: 1 }))).toBeUndefined();

    const home = tempHome();
    writeService(home, { version: '2.2.4', url: 'http://127.0.0.1:49374', pid: 123, password: 'super-segredo' });
    const endpoint = await discoverEndpoint({
      home,
      env: {},
      pidAlive: () => true,
      fetchImpl: async () => {
        throw new Error('falhou com super-segredo na mensagem');
      },
    });
    expect(endpoint.origin).toBe('fallback');

    const direct: OpenCodeEndpoint = { url: 'http://127.0.0.1:49374', password: 'super-segredo', origin: 'service' };
    let message = '';
    try {
      await probeEndpoint(direct, {
        fetchImpl: async () => {
          throw new Error('falhou com super-segredo na mensagem');
        },
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/Não foi possível conectar/);
    expect(message).not.toContain('super-segredo');
  });
});
