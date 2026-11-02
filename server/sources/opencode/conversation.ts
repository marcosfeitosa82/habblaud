// Conversa de uma sessão do OpenCode pela API v2 (`GET /api/session/:id/message`).
//
// O terminal do escritório fala o mesmo protocolo do transcript do Claude Code: um `init` com a conversa
// recente e `append` com o que chegar depois. Aqui a conversa vem paginada da API: mensagens do usuário,
// textos e raciocínio do assistente e ferramentas com o resultado. Ids são estáveis (`<msg>:<índice>` e
// `<msg>:<índice>:result`), então reler a mesma lista não duplica nada. Mensagens/ferramentas ainda em
// streaming ficam de fora até completarem; sessão apagada (404) encerra o polling.
import { maskSecrets, truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { TerminalEntry, TerminalInit, TerminalInputKind } from '../../../shared/types';
import type { ConversationPoll, ConversationSource } from '../source';
import { marked, oneLine, prepare, INPUT_MAX, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, TITLE_ARG_MAX } from '../terminal';
import { describeOpenCodeTool } from './activity';
import { OpenCodeApiError, type OpenCodeMessagesQuery } from './client';

/** O que a conversa precisa do cliente (facilita o teste com um duplo). */
export interface OpenCodeConversationClient {
  messages(sessionId: string, query?: OpenCodeMessagesQuery): Promise<unknown[]>;
}

export interface OpenCodeConversationOptions {
  client: OpenCodeConversationClient;
  sessionId: string;
  agentId: string;
  /** Intervalo do polling no terminal (padrão 2 s: a conversa vem por HTTP). */
  intervalMs?: number;
  /** Entradas no `init` (as mais recentes). */
  initEntries?: number;
  /** Mensagens pedidas por ciclo. */
  limit?: number;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_INIT_ENTRIES = 500;
const DEFAULT_LIMIT = 200;
/** Ids guardados para o diff (descarta os mais antigos; uma conversa longa não cresce sem fim). */
const SEEN_MAX = 5_000;

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resultText(state: Record<string, unknown>): string {
  const content = Array.isArray(state.content) ? state.content : [];
  const texts = content.flatMap((part) => {
    const item = rec(part);
    return item && str(item.type) === 'text' && str(item.text) ? [str(item.text)] : [];
  });
  if (texts.length) return texts.join('\n\n');
  return str(rec(state.error)?.message);
}

function inputKindOf(name: string): TerminalInputKind {
  if (name === 'shell' || name === 'bash') return 'command';
  if (name === 'execute') return 'json';
  return 'text';
}

/** Alvo do título de uma ferramenta: o comando, o caminho, o padrão... (mascarado e numa linha). */
function toolTarget(name: string, input: Record<string, unknown>): string {
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  };
  if (name === 'shell' || name === 'bash') return oneLine(first('command'), TITLE_ARG_MAX);
  if (name === 'edit' || name === 'write' || name === 'patch') {
    const path = first('path', 'file_path');
    if (path) return path;
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(first('patchText'));
    return match?.[1]?.trim() ?? '';
  }
  return first('path', 'file_path', 'pattern', 'url', 'query', 'description', 'skill', 'name');
}

/** Entradas de terminal de uma lista de mensagens da API, na ordem em que vieram. */
export function toTerminalEntries(messages: readonly unknown[]): TerminalEntry[] {
  const out: TerminalEntry[] = [];
  for (const raw of messages) {
    const message = rec(raw);
    const messageId = str(message?.id);
    if (!message || !messageId) continue;
    const type = str(message.type);
    const time = rec(message.time);
    const at = num(time?.created) ?? Date.now();

    if (type === 'user') {
      const p = prepare(str(message.text), TEXT_MAX);
      const text = marked(p);
      if (text) out.push({ kind: 'user', id: `${messageId}:0`, at, text });
      continue;
    }
    if (type !== 'assistant') continue;

    // Mensagem ainda em streaming: o assistant só entra quando termina (completed ou finish).
    const completed = num(time?.completed);
    if (completed === undefined && !str(message.finish)) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((rawPart, index) => {
      const part = rec(rawPart);
      if (!part) return;
      const kind = str(part.type);
      const id = `${messageId}:${index}`;

      if (kind === 'text') {
        const p = prepare(str(part.text), TEXT_MAX);
        const text = marked(p);
        if (text) out.push({ kind: 'assistant', id, at: completed ?? at, text });
        return;
      }
      if (kind === 'reasoning') {
        const p = prepare(str(part.text), THINKING_MAX);
        const text = marked(p);
        if (text) out.push({ kind: 'thinking', id, at: num(rec(part.time)?.created) ?? completed ?? at, text });
        return;
      }
      if (kind !== 'tool') return;

      const state = rec(part.state);
      const status = str(state?.status);
      // Ferramenta em streaming/running: espera completar (ou falhar) para virar entrada.
      if (!state || (status !== 'completed' && status !== 'error')) return;
      const name = str(part.name) || tr('ferramenta');
      const input = rec(state.input) ?? {};
      const desc = describeOpenCodeTool(name, input);
      const toolId = id;
      const target = maskSecrets(toolTarget(name, input));
      const title = target ? `${name}(${truncate(target, TITLE_ARG_MAX)})` : name;
      const tool: Extract<TerminalEntry, { kind: 'tool' }> = {
        kind: 'tool',
        id: toolId,
        at: num(rec(part.time)?.created) ?? completed ?? at,
        tool: name,
        title: maskSecrets(title),
      };
      if (desc.detail) {
        tool.input = truncate(maskSecrets(desc.detail), INPUT_MAX);
        tool.inputKind = inputKindOf(name);
      }
      out.push(tool);

      const p = prepare(resultText(state), RESULT_MAX, RESULT_MAX_LINES);
      const result: Extract<TerminalEntry, { kind: 'result' }> = {
        kind: 'result',
        id: `${toolId}:result`,
        at: num(rec(part.time)?.completed) ?? completed ?? at,
        toolUseId: toolId,
        text: p.text || tr('(sem saída)'),
      };
      if (status === 'error') result.error = true;
      if (p.truncated) result.truncated = true;
      out.push(result);
    });
  }
  return out;
}

/** Conversa de uma sessão do OpenCode servida ao terminal. */
export class OpenCodeConversation implements ConversationSource {
  readonly intervalMs: number;
  private readonly initEntries: number;
  private readonly limit: number;
  /** Ids já entregues (para o `append` não repetir). */
  private readonly seen = new Set<string>();

  constructor(private readonly opts: OpenCodeConversationOptions) {
    this.intervalMs = Math.max(250, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.initEntries = Math.max(1, opts.initEntries ?? DEFAULT_INIT_ENTRIES);
    this.limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  }

  async load(): Promise<TerminalInit> {
    const messages = await this.fetchMessages();
    const all = toTerminalEntries(messages);
    this.remember(all);
    const entries = all.slice(-this.initEntries);
    // Cortou entradas ou a API pode ter mais mensagens além do limite pedido.
    return { agentId: this.opts.agentId, entries, truncated: entries.length < all.length || messages.length >= this.limit };
  }

  async poll(): Promise<ConversationPoll> {
    let messages: unknown[];
    try {
      messages = await this.fetchMessages();
    } catch (error) {
      if (error instanceof OpenCodeApiError && error.status === 404) return { stop: true };
      throw error;
    }
    const all = toTerminalEntries(messages);
    const fresh = all.filter((entry) => !this.seen.has(entry.id));
    this.remember(fresh);
    return { append: fresh };
  }

  private fetchMessages(): Promise<unknown[]> {
    return this.opts.client.messages(this.opts.sessionId, { limit: this.limit, order: 'asc' });
  }

  private remember(entries: readonly TerminalEntry[]): void {
    for (const entry of entries) this.seen.add(entry.id);
    while (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}
