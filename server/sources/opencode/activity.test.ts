import { describe, expect, it } from 'vitest';
import { describeOpenCodePermission, describeOpenCodeTool } from './activity';

describe('atividades do OpenCode', () => {
  it('mapeia ferramentas comuns para atividades curtas em PT-BR', () => {
    expect(describeOpenCodeTool('shell', { command: 'npm test' })).toMatchObject({ kind: 'test' });
    expect(describeOpenCodeTool('read', { path: 'server/index.ts' })).toMatchObject({ kind: 'read' });
    expect(describeOpenCodeTool('edit', { path: 'server/index.ts' })).toMatchObject({ kind: 'edit' });
    expect(describeOpenCodeTool('write', { path: 'docs/novo.md' })).toMatchObject({ kind: 'write' });
    expect(describeOpenCodeTool('grep', { pattern: 'TODO' })).toMatchObject({ kind: 'search' });
    expect(describeOpenCodeTool('glob', { pattern: '**/*.ts' })).toMatchObject({ kind: 'search' });
    expect(describeOpenCodeTool('webfetch', { url: 'https://opencode.ai/docs' })).toMatchObject({ kind: 'web' });
    expect(describeOpenCodeTool('subagent', { description: 'Explorar o código' })).toMatchObject({ kind: 'delegate' });
    expect(describeOpenCodeTool('ferramenta-desconhecida', {})).toMatchObject({ kind: 'other' });
  });

  it('mascara segredos e corta o detalhe', () => {
    const desc = describeOpenCodeTool('shell', { command: 'curl -H "Authorization: Bearer abcdef123456" https://exemplo.test' });
    expect(desc.detail).toBeDefined();
    expect(desc.detail).not.toContain('abcdef123456');
    expect(desc.detail).toContain('***');
    expect(desc.text.length).toBeLessThanOrEqual(46);
  });

  it('descreve permissão como "ação(recurso)" e limita o título', () => {
    const desc = describeOpenCodePermission('shell', ['npm test -- --run'], 'precisa rodar os testes');
    expect(desc.title.startsWith('shell(')).toBe(true);
    expect(desc.title.length).toBeLessThanOrEqual(80);
    expect(desc.text).toBeTruthy();
    expect(desc.input).toContain('npm test');
    expect(desc.inputKind).toBe('command');

    const long = describeOpenCodePermission('read', ['/caminho/muito/longo/'.repeat(20)], undefined);
    expect(long.title.length).toBeLessThanOrEqual(80);
  });
});
