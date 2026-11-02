import { isIP } from 'node:net';

export interface OpenCodeSession {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { providerID?: string; modelID?: string };
  location?: { directory?: string };
  time?: { created?: number; updated?: number };
}

export interface OpenCodeApiClientOptions {
  baseUrl: string;
  password?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ApiEnvelope<T> {
  data?: T;
}

function loopbackOnly(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

/**
 * Valida uma origem HTTP(S) local e devolve a forma canônica com barra no fim. Recusa credenciais, caminho, query e
 * hash para impedir que a senha acabe na URL e que a configuração vire SSRF.
 */
export function parseLocalOrigin(value: string, label = 'HABBLAUD_OPENCODE_URL'): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} não é uma URL válida`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !loopbackOnly(url.hostname)) {
    throw new Error(`${label} deve usar HTTP(S) em endereço local (localhost/127.0.0.1/::1)`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`${label} deve conter somente origem, sem credenciais, caminho ou parâmetros`);
  }
  return new URL(`${url.origin}/`);
}

/** Cliente mínimo da API HTTP v2. Só aceita loopback para impedir SSRF por configuração. */
export class OpenCodeApiClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: OpenCodeApiClientOptions) {
    this.baseUrl = parseLocalOrigin(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.password) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`;
    }
    this.headers = headers;
  }

  async info(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>('/api/info');
  }

  async activeSessions(): Promise<Record<string, unknown>> {
    const response = await this.get<ApiEnvelope<Record<string, unknown>>>('/api/session/active');
    if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
      throw new Error('Resposta inválida de /api/session/active');
    }
    return response.data;
  }

  async session(sessionId: string): Promise<OpenCodeSession> {
    const response = await this.get<ApiEnvelope<OpenCodeSession>>(`/api/session/${encodeURIComponent(sessionId)}`);
    const session = response.data;
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || session.id !== sessionId) {
      throw new Error('Resposta inválida de /api/session/:id');
    }
    return session;
  }

  private async get<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path.slice(1), this.baseUrl), {
        method: 'GET',
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error('Tempo esgotado ao consultar a API OpenCode');
      throw new Error('Não foi possível conectar à API OpenCode');
    }
    if (!response.ok) {
      const detail = response.status === 401 ? 'autenticação recusada (confira HABBLAUD_OPENCODE_PASSWORD)' : `HTTP ${response.status}`;
      throw new Error(`API OpenCode: ${detail}`);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error('API OpenCode retornou JSON inválido');
    }
  }
}
