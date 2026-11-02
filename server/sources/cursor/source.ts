// Fonte de agentes do Cursor (AgentSource 'cursor', ver sources/source.ts): o agente do Cursor grava cada conversa em
// ~/.cursor/projects/<pasta-do-projeto>/agent-transcripts/<id>/<id>.jsonl, uma linha por mensagem no formato
// {role:'user'|'assistant', message:{content:[{type:'text'|'tool_use',...}]}} e {type:'turn_ended'} ao fim de cada turno.
//
// Presença: não há registro de sessões abertas nem pid. Uma conversa conta como aberta enquanto o arquivo foi escrito nos
// últimos OPEN_MS; 'working' nos últimos WORKING_MS (e sem turn_ended por último), senão 'idle'. As linhas não têm hora:
// as atividades lidas ao vivo usam o instante da leitura; as do boot são espalhadas para trás a partir da data do arquivo.
// O nome da pasta do projeto troca tudo que não é letra/dígito por "-"; resolveProjectDir() o desfaz pelo disco.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity, ActivityKind, AgentStatus, SourceInfo } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { log, errMsg } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { tr } from '../../../shared/i18n';

export const OPEN_MS = 10 * 60_000;
export const WORKING_MS = 20_000;
const POLL_MS = 2_000;
/** Do fim de cada arquivo, só isto é lido ao abrir a conversa. */
const BOOT_BYTES = 512 * 1024;
const MAIN_ROLE = tr('Agente principal (Cursor)');
const UUID_RE = /^[0-9a-f-]{36}$/;

export interface CursorSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** `~/.cursor` (os projetos ficam em `projects/`). */
  dir: string;
  now?: () => number;
  pollMs?: number;
}

interface Convo {
  id: string;
  key: string;
  file: string;
  cwd: string;
  offset: number;
  pending: string;
  seq: number;
  turnOpen: boolean;
  inOffice: boolean;
}

const TOOL_KIND: [RegExp, ActivityKind, string][] = [
  [/^(Shell|Bash|RunTerminalCommand)/i, 'run', '⌨️'],
  [/^(Read|ReadFile|ReadLints)/i, 'read', '📖'],
  [/^(Glob|Grep|SemanticSearch|CodebaseSearch)/i, 'search', '🔎'],
  [/^(StrReplace|Edit|ApplyPatch|EditNotebook)/i, 'edit', '✏️'],
  [/^(Write|Delete)/i, 'write', '📝'],
  [/^(WebSearch|WebFetch)/i, 'web', '🌐'],
  [/^(Task|Subagent)/i, 'delegate', '🧩'],
  [/^(TodoWrite|CreatePlan)/i, 'plan', '📋'],
  [/^(AskQuestion)/i, 'ask', '❓'],
  [/^(mcp|CallMcp)/i, 'mcp', '🔌'],
];

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Texto do pedido do usuário sem as marcas que o Cursor acrescenta (<timestamp>, <user_query>...). */
export function cleanUserText(text: string): string {
  const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
  return (q ? q[1] : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')).trim();
}

/** Desfaz o nome da pasta do projeto ("Users-kaan-Documents-Meu-Jogo") no caminho real, olhando o disco. */
export function resolveProjectDir(slug: string): string | undefined {
  let dir = '/';
  let rest = slug;
  while (rest) {
    let best: { name: string; len: number } | undefined;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      const norm = name.replace(/[^\p{L}\p{N}]+/gu, '-');
      if ((rest === norm || rest.startsWith(`${norm}-`)) && (!best || norm.length > best.len)) best = { name, len: norm.length };
    }
    if (!best) return undefined;
    dir = join(dir, best.name);
    rest = rest.slice(best.len + 1);
  }
  return dir;
}

export function describeLine(key: string, seq: number, at: number, line: unknown): Activity[] {
  if (!line || typeof line !== 'object') return [];
  const l = line as { role?: string; type?: string; message?: { content?: unknown } };
  const mk = (n: number, a: Omit<Activity, 'id' | 'at'>): Activity => ({ id: `${key}#${seq}.${n}`, at, ...a });
  if (l.type === 'turn_ended') return [mk(0, { kind: 'done', icon: '✅', text: tr('Turno concluído') })];
  const content = l.message?.content;
  if (!Array.isArray(content)) return [];
  const out: Activity[] = [];
  content.forEach((b: { type?: string; text?: string; name?: string; input?: Record<string, unknown> }, i) => {
    if (b.type === 'text' && b.text) {
      if (l.role === 'user') {
        const t = cleanUserText(b.text);
        if (t) out.push(mk(i, { kind: 'prompt', icon: '💬', text: clip(t, 46), detail: clip(t, 300) }));
      } else out.push(mk(i, { kind: 'respond', icon: '🗨️', text: clip(b.text, 46), detail: clip(b.text, 300) }));
    } else if (b.type === 'tool_use' && b.name) {
      const hit = TOOL_KIND.find(([re]) => re.test(b.name!));
      const target = b.input ? String(b.input.path ?? b.input.command ?? b.input.pattern ?? b.input.query ?? b.input.target_directory ?? '') : '';
      out.push(mk(i, { kind: hit?.[1] ?? 'other', icon: hit?.[2] ?? '🛠️', text: clip(target ? `${b.name} ${target}` : b.name, 46), detail: b.input ? clip(JSON.stringify(b.input), 300) : undefined, tool: b.name }));
    }
  });
  return out;
}

export class CursorSource implements AgentSource {
  readonly provider = 'cursor' as const;
  private readonly convos = new Map<string, Convo>();
  private readonly dirCache = new Map<string, string | null>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private accountId = '.cursor';

  constructor(private readonly opts: CursorSourceOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): void {
    const entries = this.opts.accounts.setProviderAccounts('cursor', [
      { dir: this.opts.dir, detected: { id: '.cursor', provider: 'cursor', configDir: this.opts.dir, short: 'U', name: 'Cursor', color: '#2dd4bf' } },
    ]);
    this.accountId = entries[0]?.id ?? this.accountId;
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => this.poll(false), this.opts.pollMs ?? POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    return [{ label: 'Cursor', provider: 'cursor', path: this.opts.dir, sessions: [...this.convos.values()].filter((c) => c.inOffice).length, ok: true }];
  }

  transcriptPathOf(agentId: string): string | undefined {
    return [...this.convos.values()].find((c) => c.key === agentId)?.file;
  }

  private cwdOf(slug: string): string | undefined {
    if (!this.dirCache.has(slug)) this.dirCache.set(slug, resolveProjectDir(slug) ?? null);
    return this.dirCache.get(slug) ?? undefined;
  }

  private poll(boot: boolean): void {
    const now = this.now();
    const root = join(this.opts.dir, 'projects');
    const open = new Set<string>();
    let slugs: string[] = [];
    try {
      slugs = readdirSync(root);
    } catch {
      /* sem projetos */
    }
    for (const slug of slugs) {
      const base = join(root, slug, 'agent-transcripts');
      let ids: string[];
      try {
        ids = readdirSync(base).filter((n) => UUID_RE.test(n));
      } catch {
        continue;
      }
      for (const id of ids) {
        const file = join(base, id, `${id}.jsonl`);
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (now - st.mtimeMs > OPEN_MS) continue;
        try {
          if (this.tick(id, slug, file, st.size, st.mtimeMs, boot, now)) open.add(id);
        } catch (err) {
          log.warnOnce(`cursor-${id}`, tr('Cursor: falha ao ler a conversa {0} ({1}).', [id.slice(0, 8), errMsg(err)]));
        }
      }
    }
    for (const c of this.convos.values()) {
      if (c.inOffice && !open.has(c.id)) {
        this.opts.office.closeMain(c.key);
        c.inOffice = false;
      }
    }
  }

  private tick(id: string, slug: string, file: string, size: number, mtime: number, boot: boolean, now: number): boolean {
    const office = this.opts.office;
    let c = this.convos.get(id);
    if (!c) {
      const cwd = this.cwdOf(slug);
      if (!cwd) return false;
      c = { id, key: `cursor:${id}`, file, cwd, offset: Math.max(0, size - BOOT_BYTES), pending: '', seq: 0, turnOpen: false, inOffice: false };
      if (c.offset > 0) c.pending = '\u0000';
      this.convos.set(id, c);
    }
    const lines = this.readNew(c, size);
    const status: AgentStatus = c.turnOpen && now - mtime < WORKING_MS ? 'working' : 'idle';
    if (!c.inOffice) {
      office.addMain({ id: c.key, provider: 'cursor', account: this.accountId, sessionId: c.id, cwd: c.cwd, role: MAIN_ROLE, startedAt: mtime, status });
      c.inOffice = office.has(c.key);
      if (!c.inOffice) return false;
    }
    lines.forEach((line, i) => {
      const at = boot ? mtime - (lines.length - i) : now;
      for (const act of describeLine(c!.key, ++c!.seq, at, line)) office.addActivity(c!.key, act, true, { feed: !boot });
    });
    office.setStatus(c.key, status);
    return true;
  }

  /** Linhas JSON novas desde a última leitura (guarda a linha incompleta do fim para o próximo ciclo). */
  private readNew(c: Convo, size: number): unknown[] {
    if (size < c.offset) {
      c.offset = 0;
      c.pending = '';
    }
    if (size === c.offset) return [];
    const buf = Buffer.alloc(size - c.offset);
    const fd = openSync(c.file, 'r');
    try {
      readSync(fd, buf, 0, buf.length, c.offset);
    } finally {
      closeSync(fd);
    }
    c.offset = size;
    const parts = (c.pending === '\u0000' ? '' : c.pending) + buf.toString('utf8');
    const skipFirst = c.pending === '\u0000';
    const chunks = parts.split('\n');
    c.pending = chunks.pop() ?? '';
    if (skipFirst) chunks.shift();
    const out: unknown[] = [];
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      try {
        const line = JSON.parse(chunk) as { role?: string; type?: string };
        if (line.type === 'turn_ended') c.turnOpen = false;
        else if (line.role) c.turnOpen = true;
        out.push(line);
      } catch {
        /* linha cortada */
      }
    }
    return out;
  }
}

export function cursorDirExists(dir: string): boolean {
  return existsSync(join(dir, 'projects'));
}
