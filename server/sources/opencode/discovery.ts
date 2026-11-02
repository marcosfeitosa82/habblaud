// Descoberta do serviço local do OpenCode.
//
// A TUI grava o serviço que está rodando em `$XDG_STATE_HOME/opencode/service.json` (ou
// `~/.local/state/opencode/service.json`) com `{ id, version, url, pid, password }`. Lemos esse registro, conferimos
// que o PID ainda existe e perguntamos a `/api/info` qual versão/PID o serviço informa: só aceitamos quando os dois
// batem e a versão é da série 2.x. Registro velho, serviço morto ou versão incompatível caem no endereço explícito
// (`HABBLAUD_OPENCODE_URL`) ou no padrão histórico `http://127.0.0.1:4096`.
//
// A senha do registro só existe em memória e no cabeçalho Basic Auth; nunca entra em URL, log ou mensagem de erro.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseLocalOrigin } from './client';

export type OpenCodeOrigin = 'explicit' | 'service' | 'fallback';

export interface OpenCodeEndpoint {
  url: string;
  password?: string;
  version?: string;
  pid?: number;
  origin: OpenCodeOrigin;
}

export interface ServiceFileEntry {
  id?: string;
  version?: string;
  url: string;
  pid: number;
  password?: string;
}

export interface DiscoverEndpointOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  explicitUrl?: string;
  explicitPassword?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pidAlive?: (pid: number) => boolean;
}

export interface ProbeEndpointOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Caminho do registro de serviço: `$XDG_STATE_HOME/opencode/service.json`, senão `~/.local/state/...`. */
export function serviceFilePath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'opencode', 'service.json');
}

/** Lê o registro de serviço; qualquer campo fora do contrato invalida o arquivo inteiro. */
export function parseServiceFile(raw: string): ServiceFileEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== 'string' || !record.url.trim()) return undefined;
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid < 0) return undefined;
  if (record.password !== undefined && typeof record.password !== 'string') return undefined;
  if (record.version !== undefined && typeof record.version !== 'string') return undefined;
  if (record.id !== undefined && typeof record.id !== 'string') return undefined;
  return {
    url: record.url,
    pid: record.pid,
    ...(typeof record.password === 'string' ? { password: record.password } : {}),
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
  };
}

/** Versão da série 2.x, que é a que este cliente fala. */
function supportedVersion(version: string): boolean {
  return Number.parseInt(version.trim().split('.')[0] ?? '', 10) === 2;
}

function pidIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: o processo existe, só não temos permissão de sinalizá-lo.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Consulta `/api/info`; `undefined` quando o serviço responde algo fora do contrato. */
export async function probeEndpoint(
  endpoint: OpenCodeEndpoint,
  options: ProbeEndpointOptions = {},
): Promise<{ version: string; pid: number } | undefined> {
  const origin = parseLocalOrigin(endpoint.url, 'O endereço do serviço OpenCode');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (endpoint.password) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString('base64')}`;
  }
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL('/api/info', origin), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
  } catch {
    // A causa pode carregar a URL ou o cabeçalho: descartamos e mantemos a senha fora da mensagem.
    throw new Error('Não foi possível conectar à API OpenCode');
  }
  if (!response.ok) return undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.version !== 'string' || !record.version.trim()) return undefined;
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid < 0) return undefined;
  return { version: record.version, pid: record.pid };
}

/**
 * Escolhe o serviço do OpenCode: URL explícita > registro válido (PID vivo e `/api/info` coerente) > padrão.
 * Nunca lança por registro ausente/ inválido/ incompatível; só a URL explícita inválida é erro de configuração.
 */
export async function discoverEndpoint(options: DiscoverEndpointOptions): Promise<OpenCodeEndpoint> {
  const env = options.env ?? process.env;
  if (options.explicitUrl) {
    const origin = parseLocalOrigin(options.explicitUrl);
    return { url: origin.origin, ...(options.explicitPassword ? { password: options.explicitPassword } : {}), origin: 'explicit' };
  }

  const fallback: OpenCodeEndpoint = {
    url: 'http://127.0.0.1:4096',
    ...(options.explicitPassword ? { password: options.explicitPassword } : {}),
    origin: 'fallback',
  };

  let entry: ServiceFileEntry | undefined;
  try {
    entry = parseServiceFile(await readFile(serviceFilePath(env, options.home), 'utf8'));
  } catch {
    return fallback;
  }
  if (!entry) return fallback;
  if (!(options.pidAlive ?? pidIsAlive)(entry.pid)) return fallback;

  let origin: URL;
  try {
    origin = parseLocalOrigin(entry.url, 'O endereço do serviço OpenCode');
  } catch {
    return fallback;
  }

  let info: { version: string; pid: number } | undefined;
  try {
    info = await probeEndpoint(
      { url: origin.origin, ...(entry.password ? { password: entry.password } : {}), origin: 'service' },
      { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs },
    );
  } catch {
    return fallback;
  }
  if (!info || info.pid !== entry.pid || !supportedVersion(info.version)) return fallback;

  return {
    url: origin.origin,
    ...(entry.password ? { password: entry.password } : {}),
    version: info.version,
    pid: info.pid,
    origin: 'service',
  };
}

/** Home do usuário para quando o chamador não passa uma. */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || homedir();
}
