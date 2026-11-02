// Tradução das ferramentas do OpenCode para as atividades do escritório.
//
// Os eventos `session.tool.input.started` trazem o nome (`grep`, `shell`, `read`...) e `session.tool.called` traz o
// input já estruturado. Reaproveitamos as descrições do Claude Code onde o formato coincide (Read/Edit/Write/Grep...)
// e escrevemos as que são próprias do OpenCode (shell, patch, execute, subagent), sempre mascarando segredos.
import type { ActivityDescription } from '../../../shared/activity';
import { basename, describeCommand, describeTool, maskSecrets, truncate } from '../../../shared/activity';
import type { ActivityKind, TerminalInputKind } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

const MAX_TEXT = 46;
const MAX_DETAIL = 300;
const MAX_TITLE = 80;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function make(kind: ActivityKind, icon: string, text: string, detail?: string): ActivityDescription {
  return {
    kind,
    icon,
    text: truncate(maskSecrets(text.slice(0, MAX_TEXT * 8)), MAX_TEXT),
    ...(detail ? { detail: truncate(maskSecrets(detail.slice(0, MAX_DETAIL * 4)), MAX_DETAIL) } : {}),
  };
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim().toLowerCase();
}

function patchFiles(patchText: string): string[] {
  const files: string[] = [];
  for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const file = match[1]?.trim();
    if (file) files.push(file);
  }
  return files;
}

/** Descreve uma chamada de ferramenta do OpenCode (`name` + `input`). */
export function describeOpenCodeTool(name: string, rawInput: unknown): ActivityDescription {
  const input = obj(rawInput);
  const tool = name.trim().toLowerCase();
  const path = str(input.path) || str(input.file_path);

  switch (tool) {
    case 'bash':
    case 'shell':
      return describeCommand(str(input.command), str(input.description));
    case 'read':
    case 'write':
    case 'edit':
      return describeTool(tool === 'read' ? 'Read' : tool === 'write' ? 'Write' : 'Edit', { file_path: path });
    case 'patch': {
      const files = patchFiles(str(input.patchText));
      const label =
        files.length === 1
          ? basename(files[0])
          : files.length > 1
            ? tr('{0} e mais {1}', [basename(files[0]), files.length - 1])
            : tr('um patch');
      return make('edit', '✏️', tr('Aplicando um patch em {0}', [label]), str(input.patchText));
    }
    case 'glob':
      return describeTool('Glob', { pattern: str(input.pattern) });
    case 'grep':
      return describeTool('Grep', { pattern: str(input.pattern) });
    case 'webfetch':
      return describeTool('WebFetch', { url: str(input.url) });
    case 'websearch':
      return describeTool('WebSearch', { query: str(input.query) });
    case 'question':
      return describeTool('AskUserQuestion', { questions: input.questions });
    case 'skill':
      return describeTool('Skill', { skill: str(input.name) || str(input.skill) });
    case 'subagent':
    case 'task':
      return describeTool('Task', { description: str(input.description), subagent_type: str(input.agent), prompt: str(input.prompt) });
    case 'todowrite':
      return describeTool('TodoWrite', { todos: input.todos });
    case 'execute':
      return make('run', '🧪', tr('Executando código'), str(input.code));
    case 'experimental_image_generate':
      return make('other', '🖼️', tr('Gerando uma imagem'), str(input.prompt));
  }

  if (tool.startsWith('browser')) {
    return make('browser', '🧭', tr('Navegador: {0}', [humanize(tool.replace(/^browser[_.]?/, '') || 'página')]), str(input.url));
  }
  return make('other', '🛠️', tr('Usando {0}', [name]), str(input.command) || str(input.path));
}

function permissionInput(action: string, resources: readonly string[]): Record<string, unknown> {
  const first = resources[0] ?? '';
  switch (action) {
    case 'bash':
    case 'shell':
      return { command: resources.join('\n') };
    case 'read':
    case 'edit':
    case 'write':
    case 'patch':
      return { path: first };
    case 'grep':
    case 'glob':
      return { pattern: first };
    case 'webfetch':
      return { url: first };
    case 'websearch':
      return { query: first };
    case 'subagent':
    case 'task':
      return { description: first };
    case 'skill':
      return { skill: first };
    default:
      return {};
  }
}

function inputKindOf(action: string): TerminalInputKind {
  if (action === 'bash' || action === 'shell') return 'command';
  if (action === 'execute') return 'json';
  return 'text';
}

/** Pedido de permissão no formato do cartão do escritório: título "ação(recurso)" e o resumo da atividade. */
export function describeOpenCodePermission(
  action: string,
  resources: readonly string[],
  message?: string,
): { title: string; text: string; icon: string; input?: string; inputKind?: TerminalInputKind } {
  const list = resources.map((resource) => str(resource)).filter(Boolean);
  const desc = describeOpenCodeTool(action, permissionInput(action, list));
  const target = list[0] ? truncate(maskSecrets(list[0]), 60) : '*';
  const title = truncate(maskSecrets(`${action}(${target})`), MAX_TITLE);
  const detail = [list.join('\n'), message ?? ''].filter(Boolean).join('\n\n');
  return {
    title,
    text: desc.text,
    icon: desc.icon,
    ...(detail ? { input: truncate(maskSecrets(detail), MAX_DETAIL), inputKind: inputKindOf(action) } : {}),
  };
}
