// Fonte de agentes do Antigravity (AgentSource 'agy', ver sources/source.ts). O app grava as conversas em
// ~/.gemini/antigravity/conversations/<id>.db e a CLI `agy` em ~/.gemini/antigravity-cli/conversations/<id>.db
// (SQLite, formato em ./decode.ts); a CLI deixa um arquivo vazio com o mesmo nome na pasta do app, que é ignorado.
// A CLI também cria presence/<id>.lock (vazio) enquanto a sessão está aberta, mas o app deixa locks velhos para trás:
// o lock só vale com um passo dos últimos STALE_LOCK_MS.
//
// Presença sem lock: o Antigravity não grava registro de sessões abertas. Uma conversa conta como aberta enquanto o ÚLTIMO PASSO
// dela é dos últimos OPEN_MS (esperando aprovação: WAITING_OPEN_MS); depois sai do escritório e volta no próximo passo.
// A data do arquivo não serve: fechar o SQLite refaz o -wal e a própria leitura renovaria a presença.
// Status: 'waiting' se o último passo espera aprovação, 'working' se ele ainda não terminou ou é dos últimos WORKING_MS.
// Somente leitura (node:sqlite com readOnly); sem o módulo (Node < 22.13) a fonte aparece com erro no /api/health.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Activity, ActivityKind, AgentStatus, SourceInfo } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { decodeStep, STEP_DONE, STEP_REJECTED, STEP_WAITING, workspaceOf, type AgyStep } from './decode';
import { tr } from '../../../shared/i18n';

export const OPEN_MS = 10 * 60_000;
export const WORKING_MS = 20_000;
export const WAITING_OPEN_MS = 6 * 3600_000;
/** Lock de presença com o último passo mais velho que isto: sobra de um app fechado, não uma sessão aberta. */
export const STALE_LOCK_MS = 12 * 3600_000;
/** Só abre o banco das conversas tocadas neste período (evita ler as antigas a cada ciclo). */
const CANDIDATE_MS = 24 * 3600_000;
const POLL_MS = 2_000;
/** Passos antigos lidos ao entrar no escritório (o resto fica fora da linha do tempo). */
const BOOT_STEPS = 60;
const MAIN_ROLE = tr('Agente principal (Antigravity)');
const UUID_RE = /^[0-9a-f-]{36}$/;

type Db = { prepare(sql: string): { all(...a: unknown[]): Record<string, unknown>[]; get(...a: unknown[]): Record<string, unknown> | undefined }; close(): void };

export interface AgySourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas `.../antigravity` e `.../antigravity-cli` (as conversas ficam em `conversations/`). */
  dirs: string[];
  now?: () => number;
  pollMs?: number;
}

interface Convo {
  id: string;
  key: string;
  file: string;
  cwd: string;
  lastIdx: number;
  startedAt: number;
  inOffice: boolean;
}

const TOOL_KIND: [RegExp, ActivityKind, string][] = [
  [/^(run_command|send_command_input|command_status)/, 'run', '⌨️'],
  [/^(view_file|read_file|read_url|list_dir|view_code)/, 'read', '📖'],
  [/^(write_to_file|replace_file|multi_replace|edit)/, 'edit', '✏️'],
  [/^(grep|find|search_code|codebase_search)/, 'search', '🔎'],
  [/^(search_web|read_url_content)/, 'web', '🌐'],
  [/^(browser|open_browser)/, 'browser', '🧭'],
  [/^call_mcp_tool|^mcp_/, 'mcp', '🔌'],
  [/^(task_|todo|plan)/, 'plan', '📋'],
];

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function describeStep(convoKey: string, s: AgyStep): Activity | undefined {
  const base = { id: `${convoKey}#${s.idx}`, at: s.at || Date.now() };
  if (s.kind === 'user') return { ...base, kind: 'prompt', icon: '💬', text: clip(s.text ?? tr('Novo pedido'), 46), detail: s.text };
  if (s.kind === 'model') {
    if (!s.text) return undefined;
    return s.thinking
      ? { ...base, kind: 'think', icon: '💭', text: tr('Pensando'), detail: clip(s.text, 300) }
      : { ...base, kind: 'respond', icon: '🗨️', text: clip(s.text, 46), detail: clip(s.text, 300) };
  }
  if (s.kind === 'tool' && s.tool) {
    const hit = TOOL_KIND.find(([re]) => re.test(s.tool!));
    const detail = s.args ? clip(JSON.stringify(s.args), 300) : undefined;
    return {
      ...base,
      kind: hit?.[1] ?? 'other',
      icon: hit?.[2] ?? '🛠️',
      text: clip(s.summary ?? s.tool, 46),
      detail,
      tool: s.tool,
      ...(s.status === STEP_REJECTED ? { error: true } : {}),
    };
  }
  return undefined;
}

export class AgySource implements AgentSource {
  readonly provider = 'agy' as const;
  private readonly convos = new Map<string, Convo>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private accountId = '.antigravity';
  private error: string | undefined;
  private open: (path: string) => Db = () => {
    throw new Error('sqlite');
  };

  constructor(private readonly opts: AgySourceOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    const entries = this.opts.accounts.setProviderAccounts('agy', [
      { dir: this.opts.dirs[0], detected: { id: '.antigravity', provider: 'agy', configDir: this.opts.dirs[0], short: 'A', name: 'Antigravity', color: '#4285f4' } },
    ]);
    this.accountId = entries[0]?.id ?? this.accountId;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      this.open = (path) => new DatabaseSync(path, { readOnly: true }) as unknown as Db;
    } catch (err) {
      this.error = tr('node:sqlite indisponível (Node 22.13 ou mais novo): {0}', [errMsg(err)]);
      log.warn(this.error);
      return;
    }
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
    return this.opts.dirs.map((dir) => ({
      label: basename(dir),
      provider: 'agy' as const,
      path: dir,
      sessions: [...this.convos.values()].filter((c) => c.inOffice && c.file.startsWith(dir)).length,
      ok: !this.error,
      ...(this.error ? { error: this.error } : {}),
    }));
  }

  transcriptPathOf(): string | undefined {
    return undefined;
  }

  private poll(boot: boolean): void {
    const now = this.now();
    const present = new Set<string>();
    for (const dir of this.opts.dirs) {
      let names: string[];
      try {
        names = readdirSync(join(dir, 'conversations')).filter((n) => n.endsWith('.db') && UUID_RE.test(n.slice(0, -3)));
      } catch {
        continue;
      }
      for (const name of names) {
        const id = name.slice(0, -3);
        const file = join(dir, 'conversations', name);
        if (present.has(id)) continue;
        let stat;
        try {
          stat = statSync(file);
        } catch {
          continue;
        }
        const locked = existsSync(join(dir, 'presence', `${id}.lock`));
        if (stat.size === 0 || (!locked && now - this.mtimeOf(file) > CANDIDATE_MS)) continue;
        try {
          if (this.tick(id, file, boot, now, locked)) present.add(id);
        } catch (err) {
          log.warnOnce(`agy-${id}`, tr('Antigravity: falha ao ler a conversa {0} ({1}).', [id.slice(0, 8), errMsg(err)]));
        }
      }
    }
    for (const c of this.convos.values()) {
      if (c.inOffice && !present.has(c.id)) {
        this.opts.office.closeMain(c.key);
        c.inOffice = false;
      }
    }
  }

  /** O arquivo ou o -wal escrito por último (o SQLite em WAL só toca o -wal enquanto trabalha). */
  private mtimeOf(file: string): number {
    let m = 0;
    for (const f of [file, `${file}-wal`]) {
      try {
        m = Math.max(m, statSync(f).mtimeMs);
      } catch {
        /* sem o -wal */
      }
    }
    return m;
  }

  /** Lê passos novos e atualiza o escritório; devolve se a conversa está aberta. */
  private tick(id: string, file: string, boot: boolean, now: number, locked: boolean): boolean {
    const office = this.opts.office;
    const db = this.open(file);
    try {
      const tail = db.prepare('select idx, status, step_payload from steps order by idx desc limit 1').get();
      if (!tail) return false;
      const lastStatus = Number(tail.status);
      const lastAt = decodeStep(Number(tail.idx), tail.step_payload as Uint8Array)?.at ?? 0;
      const waiting = lastStatus === STEP_WAITING;
      const live = locked && now - lastAt < STALE_LOCK_MS;
      if (!live && now - lastAt > (waiting ? WAITING_OPEN_MS : OPEN_MS)) return false;
      let c = this.convos.get(id);
      if (!c) {
        const blob = db.prepare('select data from trajectory_metadata_blob limit 1').get()?.data;
        const cwd = blob ? workspaceOf(blob as Uint8Array) : undefined;
        if (!cwd) return false;
        const max = Number(db.prepare('select max(idx) m from steps').get()?.m ?? -1);
        c = { id, key: `agy:${id}`, file, cwd, lastIdx: Math.max(-1, max - BOOT_STEPS), startedAt: now, inOffice: false };
        this.convos.set(id, c);
      }
      const rows = db.prepare('select idx, step_payload from steps where idx > ? order by idx').all(c.lastIdx);
      const steps: AgyStep[] = [];
      for (const r of rows) {
        const s = decodeStep(Number(r.idx), r.step_payload as Uint8Array);
        c.lastIdx = Number(r.idx);
        if (s) steps.push(s);
      }
      const unfinished = lastStatus !== STEP_DONE && lastStatus !== STEP_REJECTED;
      const status: AgentStatus = waiting ? 'waiting' : unfinished || now - lastAt < WORKING_MS ? 'working' : 'idle';
      if (!c.inOffice) {
        c.startedAt = steps.find((s) => s.at)?.at ?? c.startedAt;
        office.addMain({ id: c.key, provider: 'agy', account: this.accountId, sessionId: c.id, cwd: c.cwd, role: MAIN_ROLE, startedAt: c.startedAt, status });
        c.inOffice = office.has(c.key);
        if (!c.inOffice) return false;
      }
      for (const s of steps) {
        const act = describeStep(c.key, s);
        if (act) office.addActivity(c.key, act, true, { feed: !boot && !!s.at && now - s.at < 120_000 });
      }
      office.setStatus(c.key, status);
      return true;
    } finally {
      db.close();
    }
  }
}
