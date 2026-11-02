import { isIP } from 'node:net';

export interface OpenCodeSession {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { providerID?: string; modelID?: string };
  location?: { directory?: string };
  time?: { created?: number; updated?: number; busy?: number; idle?: number; archived?: number };
  outcome?: 'succeeded' | 'failed' | 'interrupted';
}

export interface OpenCodeSessionsQuery {
  limit?: number;
  order?: 'asc' | 'desc';
  archived?: boolean;
  parentID?: string;
  cursor?: string;
  directory?: string;
}

export interface OpenCodeMessagesQuery {
  limit?: number;
  order?: 'asc' | 'desc';
  cursor?: string;
  type?: string;
}

/** Pedido de permissão aberto numa sessão (GET /api/session/:id/permission). */
export interface OpenCodePermission {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  message?: string;
  source?: { type: 'tool'; messageID: string; id: string };
  metadata?: Record<string, unknown>;
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

/** Erro de uma chamada HTTP da API do OpenCode; `status` ausente = nem chegou a responder. */
export class OpenCodeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenCodeApiError';
  }
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

  async sessions(query: OpenCodeSessionsQuery = {}): Promise<OpenCodeSession[]> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.order) params.set('order', query.order);
    if (query.archived !== undefined) params.set('archived', String(query.archived));
    if (query.parentID) params.set('parentID', query.parentID);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.directory) params.set('directory', query.directory);
    const qs = params.toString();
    return this.jsonArray<OpenCodeSession>(`/api/session${qs ? `?${qs}` : ''}`, 'lista de sessões', (item) => typeof item.id === 'string' && item.id.length > 0);
  }

  async messages(sessionId: string, query: OpenCodeMessagesQuery = {}): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.order) params.set('order', query.order);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.type) params.set('type', query.type);
    const qs = params.toString();
    return this.jsonArray<unknown>(`/api/session/${encodeURIComponent(sessionId)}/message${qs ? `?${qs}` : ''}`, 'lista de mensagens');
  }

  async permissions(sessionId: string): Promise<OpenCodePermission[]> {
    return this.jsonArray<OpenCodePermission>(
      `/api/session/${encodeURIComponent(sessionId)}/permission`,
      'lista de permissões',
      (item) => typeof item.id === 'string' && typeof item.action === 'string' && Array.isArray(item.resources),
    );
  }

  async replyPermission(sessionId: string, requestId: string, decision: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    await this.post(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { decision, ...(message ? { message } : {}) },
    );
  }

  async interrupt(sessionId: string, resume?: boolean): Promise<void> {
    const qs = resume === undefined ? '' : `?resume=${resume ? 'true' : 'false'}`;
    await this.post(`/api/session/${encodeURIComponent(sessionId)}/interrupt${qs}`);
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.post(`/api/session/${encodeURIComponent(sessionId)}/prompt`, { text });
  }

  /** Abre o stream SSE; o sinal é do chamador (o timeout curto não vale para eventos). */
  async eventResponse(signal: AbortSignal): Promise<Response> {
    return this.send('GET', '/api/event', undefined, signal, { accept: 'text/event-stream' });
  }

  private async jsonArray<T>(path: string, label: string, valid?: (item: T) => boolean): Promise<T[]> {
    const response = await this.get<ApiEnvelope<T[]>>(path);
    const data = response.data;
    if (!Array.isArray(data) || (valid && !data.every((item) => typeof item === 'object' && item !== null && valid(item)))) {
      throw new Error(`Resposta inválida de ${label}`);
    }
    return data;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.send('GET', path, undefined, AbortSignal.timeout(this.timeoutMs));
    return this.readJson<T>(response);
  }

  private async post(path: string, body?: unknown): Promise<void> {
    const response = await this.send(
      'POST',
      path,
      body,
      AbortSignal.timeout(this.timeoutMs),
      body === undefined ? undefined : { 'content-type': 'application/json' },
    );
    await response.body?.cancel();
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path.slice(1), this.baseUrl), {
        method,
        headers: { ...this.headers, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error('Tempo esgotado ao consultar a API OpenCode');
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new Error('Não foi possível conectar à API OpenCode');
    }
    if (!response.ok) {
      const detail = response.status === 401 ? 'autenticação recusada' : `HTTP ${response.status}`;
      throw new OpenCodeApiError(`API OpenCode: ${detail}`, response.status);
    }
    return response;
  }

  private async readJson<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error('API OpenCode retornou JSON inválido');
    }
  }
}
