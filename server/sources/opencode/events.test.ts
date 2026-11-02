import { describe, expect, it } from 'vitest';
import { OpenCodeEventStream, parseEventFrame, type OpenCodeEvent } from './events';

async function waitFor(check: () => boolean, timeoutMs = 1_500): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('tempo esgotado esperando a condição');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sseStream(): { response: Response; send: (text: string) => void; close: () => void } {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (text) => controller.enqueue(encoder.encode(text)),
    close: () => {
      try {
        controller.close();
      } catch {
        // o cancelamento do abort já fechou o stream
      }
    },
  };
}

describe('parser do SSE do OpenCode', () => {
  it('ignora heartbeats e comentários e devolve o evento JSON', () => {
    expect(parseEventFrame(': heartbeat\n\ndata: {"id":"evt_1","type":"server.connected","data":{}}')).toEqual({
      id: 'evt_1',
      type: 'server.connected',
      data: {},
    });
    expect(parseEventFrame(': heartbeat')).toBeUndefined();
    expect(parseEventFrame('')).toBeUndefined();
  });

  it('junta data: em várias linhas e descarta JSON inválido', () => {
    const frame = 'data: {"type":"session.status",\ndata: "data":{"status":{"type":"busy"}}}';
    expect(parseEventFrame(frame)).toEqual({ type: 'session.status', data: { status: { type: 'busy' } } });
    expect(parseEventFrame('data: {isto não é json}')).toBeUndefined();
    expect(parseEventFrame('data: {"data":{}}')).toBeUndefined();
    expect(parseEventFrame('event: ping')).toBeUndefined();
  });
});

describe('stream de eventos do OpenCode', () => {
  it('lê frames, separa por linha em branco e ignora heartbeat', async () => {
    const sse = sseStream();
    const events: OpenCodeEvent[] = [];
    const states: string[] = [];
    const stream = new OpenCodeEventStream({
      open: async () => sse.response,
      onEvent: (event) => events.push(event),
      onState: (state) => states.push(state),
      reconnectMs: 5,
    });
    stream.start();
    await waitFor(() => states.includes('open'));
    sse.send(': heartbeat\n\n');
    sse.send('data: {"id":"evt_1","type":"session.status","data":{"status":{"type":"busy"}}}\n\n');
    sse.send('data: {"id":"evt_2","type":"session.idle","data":{"sessionID":"ses_1"}}\n\n');
    await waitFor(() => events.length === 2);
    expect(events).toEqual([
      { id: 'evt_1', type: 'session.status', data: { status: { type: 'busy' } } },
      { id: 'evt_2', type: 'session.idle', data: { sessionID: 'ses_1' } },
    ]);
    stream.stop();
    sse.close();
  });

  it('reconecta com backoff crescente e para quando stop() é chamado', async () => {
    let calls = 0;
    const stream = new OpenCodeEventStream({
      open: async () => {
        calls++;
        if (calls === 1) throw new Error('serviço fora do ar');
        return sseStream().response;
      },
      onEvent: () => undefined,
      reconnectMs: 5,
      maxReconnectMs: 10,
    });
    stream.start();
    await waitFor(() => calls >= 2);
    stream.stop();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toBe(2);
  });

  it('trata resposta sem sucesso como queda e avisa o erro', async () => {
    let calls = 0;
    const errors: string[] = [];
    const states: string[] = [];
    const stream = new OpenCodeEventStream({
      open: async () => {
        calls++;
        return new Response(null, { status: 503 });
      },
      onEvent: () => undefined,
      onError: (error) => errors.push(String(error)),
      onState: (state) => states.push(state),
      reconnectMs: 1,
    });
    stream.start();
    await waitFor(() => calls >= 2);
    stream.stop();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/HTTP 503/);
    expect(states).toContain('closed');
  });
});
