// Histórico do terminal do OpenCode (HistoryProvider 'opencode'): as sessões recentes vêm de
// `GET /api/session` e a conversa de cada uma de `GET /api/session/:id/message` (conversation.ts).
//
// A lista exclui sessões filhas (subagentes) e arquivadas; cada sessão vira um RecentSession com o projeto
// (`location.directory`), o título e os horários da API. O id precisa ser `ses_...` (nada de path traversal: aqui
// não há caminho de arquivo, mas a validação mantém o contrato das outras ferramentas).
import type { RecentSession } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import type { HistoryProvider, HistoryResolveResult, HistorySession } from '../source';
import { encodeCwd } from '../watcher';
import type { OpenCodeSession, OpenCodeSessionsQuery } from './client';
import { OpenCodeConversation, type OpenCodeConversationClient } from './conversation';

/** O que o histórico precisa do cliente (facilita o teste com um duplo). */
export interface OpenCodeHistoryClient extends OpenCodeConversationClient {
  sessions(query?: OpenCodeSessionsQuery): Promise<OpenCodeSession[]>;
}

export interface OpenCodeHistoryAccount {
  id: string;
  dir?: string;
}

export interface OpenCodeHistoryOptions {
  client: () => OpenCodeHistoryClient | undefined;
  accounts: () => readonly OpenCodeHistoryAccount[];
  /** Agente principal da sessão, se ela ainda estiver aberta no escritório. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  limit?: number;
}

const SESSION_ID = /^ses_[A-Za-z0-9]{10,64}$/;
const DEFAULT_LIMIT = 150;
const TITLE_MAX = 200;

function sessionTimes(session: OpenCodeSession): { created?: number; updated?: number } {
  const created = session.time?.created;
  const updated = session.time?.updated;
  return {
    ...(typeof created === 'number' && Number.isFinite(created) && created > 0 ? { created } : {}),
    ...(typeof updated === 'number' && Number.isFinite(updated) && updated > 0 ? { updated } : {}),
  };
}

export class OpenCodeHistory implements HistoryProvider {
  readonly provider = 'opencode' as const;
  private readonly now: () => number;
  private readonly limit: number;

  constructor(private readonly opts: OpenCodeHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  async list(): Promise<RecentSession[]> {
    const client = this.opts.client();
    if (!client) throw new Error(tr('serviço OpenCode indisponível'));
    const accounts = this.opts.accounts();
    const account = accounts[0];
    if (!account) return [];
    const now = this.now();
    const sessions = await client.sessions({ limit: this.limit, order: 'desc', archived: false });
    const out: RecentSession[] = [];
    for (const session of sessions) {
      // Subagentes (sessões filhas) e arquivadas não entram no histórico.
      if (session.parentID || session.time?.archived !== undefined) continue;
      const cwd = session.location?.directory;
      if (typeof cwd !== 'string' || !cwd.trim()) continue;
      const times = sessionTimes(session);
      const lastAt = times.updated ?? times.created ?? now;
      const agentId = this.opts.openAgentOf(account.id, session.id);
      const entry: RecentSession = {
        account: account.id,
        provider: 'opencode',
        sessionId: session.id,
        project: cwd,
        projectDir: encodeCwd(cwd),
        lastAt,
        size: 0,
        open: !!agentId,
      };
      if (typeof session.title === 'string' && session.title.trim()) entry.title = session.title.trim().slice(0, TITLE_MAX);
      if (times.created !== undefined) entry.firstAt = times.created;
      if (agentId) entry.agentId = agentId;
      out.push(entry);
    }
    return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, this.limit);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!SESSION_ID.test(sessionId)) return { status: 400, error: tr('id de sessão inválido') };
    if (!this.hasAccount(account)) return { status: 404, error: tr('conta desconhecida') };
    const client = this.opts.client();
    if (!client) return { status: 404, error: tr('serviço OpenCode indisponível') };
    const agentId = this.opts.openAgentOf(account, sessionId) ?? `session:${account}:${sessionId}`;
    const result: HistorySession = {
      conversation: () => new OpenCodeConversation({ client, sessionId, agentId }),
    };
    return result;
  }
}
