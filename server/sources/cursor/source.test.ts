import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanUserText, describeLine, resolveProjectDir } from './source';

describe('Cursor: conversas', () => {
  it('tira as marcas do pedido do usuário', () => {
    expect(cleanUserText('<timestamp>x</timestamp>\n<user_query>\noi\n</user_query>')).toBe('oi');
  });

  it('desfaz o nome da pasta do projeto pelo disco', () => {
    const root = mkdtempSync(join(tmpdir(), 'cur-'));
    mkdirSync(join(root, 'Meu Jogo', 'sub-dir'), { recursive: true });
    const slug = join(root, 'Meu Jogo', 'sub-dir').replace(/^\//, '').replace(/[^\p{L}\p{N}]+/gu, '-');
    expect(resolveProjectDir(slug)).toBe(join(root, 'Meu Jogo', 'sub-dir'));
    expect(resolveProjectDir('1789221525060')).toBeUndefined();
  });

  it('transforma linhas em atividades', () => {
    const acts = describeLine('k', 1, 5, { role: 'assistant', message: { content: [{ type: 'text', text: 'feito' }, { type: 'tool_use', name: 'Shell', input: { command: 'ls' } }] } });
    expect(acts.map((a) => a.kind)).toEqual(['respond', 'run']);
    expect(describeLine('k', 2, 5, { type: 'turn_ended' })[0].kind).toBe('done');
  });
});
