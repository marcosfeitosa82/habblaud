// Stream de eventos do OpenCode (`GET /api/event`, Server-Sent Events).
//
// O SSE é só ao vivo: não há replay. O `server.connected` marca conexão/reconexão e a fonte reconcilia o estado por
// `/api/session` + `/api/session/active`; daqui em diante cada frame vira um `OpenCodeEvent`. O stream reconecta
// sozinho com backoff exponencial até `maxReconnectMs`, e `stop()` encerra sem reconectar.
import type { OpenCodeApiClient } from './client';

export interface OpenCodeEvent {
  id?: string;
  type: string;
  data: unknown;
  created?: number;
}

export interface OpenCodeEventStreamOptions {
  open: (signal: AbortSignal) => Promise<Response>;
  onEvent: (event: OpenCodeEvent) => void;
  onState?: (state: 'open' | 'closed') => void;
  onError?: (error: unknown) => void;
  reconnectMs?: number;
  maxReconnectMs?: number;
}

/** Lê um frame SSE (linhas `data:` podem se repetir) e devolve o evento JSON, ou `undefined` para heartbeat/lixo. */
export function parseEventFrame(frame: string): OpenCodeEvent | undefined {
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  }
  if (!data.length) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join('\n'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== 'string' || !record.type) return undefined;
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    type: record.type,
    data: record.data ?? {},
    ...(typeof record.created === 'number' ? { created: record.created } : {}),
  };
}

/** Consumo do SSE com reconexão automática; a fonte decide o que fazer com cada evento. */
export class OpenCodeEventStream {
  private readonly reconnectMs: number;
  private readonly maxReconnectMs: number;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private attempt = 0;

  constructor(private readonly opts: OpenCodeEventStreamOptions) {
    this.reconnectMs = Math.max(1, opts.reconnectMs ?? 1_000);
    this.maxReconnectMs = Math.max(this.reconnectMs, opts.maxReconnectMs ?? 30_000);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.opts.onState?.('closed');
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await this.opts.open(controller.signal);
      if (this.stopped) return;
      if (!response.ok) throw new Error(`API OpenCode: HTTP ${response.status}`);
      if (!response.body) throw new Error('API OpenCode: stream de eventos vazio');
      this.attempt = 0;
      this.opts.onState?.('open');
      await this.consume(response.body, controller.signal);
      if (!this.stopped) throw new Error('stream de eventos encerrado');
    } catch (error) {
      if (this.stopped || controller.signal.aborted) return;
      this.opts.onError?.(error);
      this.opts.onState?.('closed');
      this.schedule();
      return;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private async consume(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const onAbort = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    let buffer = '';
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let index: number;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          this.emit(frame);
        }
      }
      if (!signal.aborted) this.emit(buffer);
    } finally {
      signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }

  private emit(frame: string): void {
    if (!frame.trim()) return;
    const event = parseEventFrame(frame);
    if (event) this.opts.onEvent(event);
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(this.maxReconnectMs, this.reconnectMs * 2 ** this.attempt);
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
    this.timer.unref?.();
  }
}

/** `open` já ligado ao cliente (açúcar para a fonte). */
export function eventStreamFor(client: OpenCodeApiClient, options: Omit<OpenCodeEventStreamOptions, 'open'>): OpenCodeEventStream {
  return new OpenCodeEventStream({ ...options, open: (signal) => client.eventResponse(signal) });
}
