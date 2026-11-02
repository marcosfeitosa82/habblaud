// Identidade e rótulos dos provedores no escritório. No protocolo, `provider` ausente quer dizer Claude Code.
// O estilo vazado do chip permanece exclusivo do Codex; OpenCode recebe apenas identificação textual.
import type { AccountInfo, OfficeSnapshot, Provider } from '../../../shared/types';
import { shortcutHint } from './model';
import { tr } from '../../../shared/i18n';

/** Nome de cada ferramenta como aparece nos textos. */
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/** Ferramenta de um agente, conta, sessão ou pedido (ausente = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

/**
 * O id de conta tem cara de pasta do Codex (".codex", ".codex-trabalho", ".codex~2", "demo:.codex")? Só para quando a
 * conta já não está no snapshot (ex.: histórico, "Meu dia"): com a conta à mão, vale o `provider` dela.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

/** Id de conta OpenCode quando o snapshot já não está disponível. */
export function looksLikeOpenCodeId(id: string): boolean {
  return /(?:^|[:/\\])\.?opencode(?:[-_.~]|$)/i.test(id);
}

/** Ferramenta da conta: a do snapshot; sem ela, a dica de quem chamou ou o jeito do id. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  return hint ?? (looksLikeOpenCodeId(fallbackId) ? 'opencode' : looksLikeCodexId(fallbackId) ? 'codex' : 'claude');
}

/**
 * Letra do chip de uma conta que não está no snapshot: a primeira letra depois do prefixo da pasta
 * (".claude-conta2" -> "C", ".codex-trabalho" -> "T"). A pasta padrão do Codex (".codex") vira "X"; a do Claude Code,
 * "?" (como antes). Nunca devolve "." nem vazio.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  return provider === 'codex' ? 'X' : provider === 'opencode' ? 'O' : '?';
}

/** O selo "Codex" ao lado do nome da conta (não repete quando o nome já diz "Codex"). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  return provider !== 'claude' && !new RegExp(provider === 'codex' ? 'codex' : 'opencode', 'i').test(accountName);
}

/** Rótulo do chip da conta (dica e leitores de tela): "Conta C (dev@x.com)", "Codex · plano Team". */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  const providerName = PROVIDER_NAME[provider];
  if (!account) return fallbackId ? `${fallbackId}${provider === 'claude' ? '' : ` · ${providerName}`}` : tr('Conta desconhecida');
  if (provider === 'claude') return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ` · ${providerName}` : '';
  return `${account.name}${tag}${account.plan ? tr(' · plano {0}', [account.plan]) : ''}`;
}

/**
 * Texto do escritório vazio. Os atalhos ("atalhos c ou d") são só das contas do Claude Code, que vêm de aliases do
 * shell (a letra de uma conta do Codex não é um atalho); o Codex só entra quando há uma conta dele.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  const codex = accounts.some((a) => providerOf(a) === 'codex');
  const opencode = accounts.some((a) => providerOf(a) === 'opencode');
  const keys = shortcutHint(accounts.filter((a) => providerOf(a) === 'claude'));
  if (!opencode) {
    if (!codex) return tr('Abra o Claude Code em qualquer projeto{0} e veja seu agente chegar.', [keys ? ` (${keys})` : '']);
    return tr('Abra o Claude Code{0} ou o Codex em qualquer projeto e veja seu agente chegar.', [keys ? ` (${keys})` : '']);
  }
  const tools = [accounts.some((a) => providerOf(a) === 'claude') ? 'Claude Code' : '', codex ? 'Codex' : '', 'OpenCode'].filter(Boolean);
  return `Abra ${tools.join(' ou ')} em qualquer projeto${keys ? ` (${keys})` : ''} e veja seu agente chegar.`;
}

/** Algum pedido de permissão do Codex esperando: o prazo é curto e o cartão conta os segundos (relógio de 1 s). */
export function hasCodexPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && isCodex(a.permission) && a.status !== 'offline' && a.status !== 'done');
}

/** Como ver o Codex ao vivo e aprovar pelo escritório (gaveta de um agente do Codex e ajuda). */
export const CODEX_LIVE_HINT = tr('Para ver o Codex ao vivo e aprovar pelo escritório: `npm run codex:install` e aprove os hooks em `/hooks` no Codex.');

/** Políticas de aprovação do Codex (`approval_policy`), quando o servidor as manda no lugar do modo de permissão. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: tr('Pergunta antes de quase tudo'),
  'on-request': tr('Pergunta quando precisa'),
  'on-failure': tr('Pergunta quando um comando falha'),
  never: tr('Nunca pergunta'),
};

/** Aprovação de um agente do Codex em português (valor desconhecido passa como veio). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
