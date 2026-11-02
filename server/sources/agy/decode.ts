// Leitor mínimo de protobuf (sem esquema) e dos passos (`steps`) das conversas do Antigravity (`agy`).
//
// Formato observado em ~/.gemini/antigravity/conversations/<id>.db (SQLite): a tabela `steps` guarda um protobuf por
// passo em `step_payload`. Os submensagens vêm como TEXTO com bytes em decimal separados por vírgula ("10,11,8,..."),
// então o leitor reconhece esse texto e decodifica de novo. Campos usados (por observação, sem documentação oficial):
//   1 = tipo do passo (14 pedido do usuário, 15 modelo, 132 chamada de ferramenta), 4 = status (3 concluído, 6 esperando
//   aprovação, 7 recusado/interrompido), 5.1.1 = segundos epoch, 19.2 = texto do usuário, 20.3 = raciocínio,
//   20.1/20.8 = resposta, 5.4.{1,2,3} = id/nome/argumentos JSON da ferramenta, 140.{1,2} = resumo da ferramenta.
export interface Field {
  f: number;
  /** Inteiro (varint). */
  v?: bigint;
  /** Bytes de um campo delimitado por tamanho. */
  b?: Buffer;
}

export function parseProto(buf: Buffer): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated');
      const b = buf[i++];
      r |= BigInt(b & 127) << s;
      if (b < 128) return r;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const f = key >> 3;
    const w = key & 7;
    if (f === 0) throw new Error('bad field');
    if (w === 0) out.push({ f, v: varint() });
    else if (w === 2) {
      const n = Number(varint());
      if (i + n > buf.length) throw new Error('truncated');
      out.push({ f, b: buf.subarray(i, i + n) });
      i += n;
    } else if (w === 1) i += 8;
    else if (w === 5) i += 4;
    else throw new Error('bad wire type');
  }
  return out;
}

const CSV_BYTES = /^\d{1,3}(,\d{1,3})+$/;

/** Os bytes de um campo que pode ser uma submensagem (direta ou no formato de bytes em decimal). */
function bytesOf(b: Buffer): Buffer {
  const s = b.toString('latin1');
  return CSV_BYTES.test(s) ? Buffer.from(s.split(',').map(Number)) : b;
}

/** Submensagem do campo `f` (a primeira), ou [] se não existir ou não for uma mensagem. */
export function sub(fields: Field[], f: number): Field[] {
  const x = fields.find((y) => y.f === f && y.b);
  if (!x?.b) return [];
  try {
    return parseProto(bytesOf(x.b));
  } catch {
    return [];
  }
}

export function str(fields: Field[], f: number): string | undefined {
  const x = fields.find((y) => y.f === f && y.b);
  if (!x?.b) return undefined;
  const s = x.b.toString('utf8');
  return s.includes('�') ? undefined : s;
}

export function int(fields: Field[], f: number): number | undefined {
  const x = fields.find((y) => y.f === f && y.v !== undefined);
  return x?.v === undefined ? undefined : Number(x.v);
}

export type AgyStepKind = 'user' | 'model' | 'tool' | 'other';

export interface AgyStep {
  idx: number;
  kind: AgyStepKind;
  status: number;
  /** Epoch ms do passo (0 = desconhecido). */
  at: number;
  /** user: pedido; model: resposta (vazia = só raciocínio). */
  text?: string;
  /** model: o passo é só raciocínio. */
  thinking?: boolean;
  tool?: string;
  /** Argumentos da ferramenta (JSON já lido). */
  args?: Record<string, unknown>;
  summary?: string;
}

export const STEP_DONE = 3;
export const STEP_WAITING = 6;
export const STEP_REJECTED = 7;

export function decodeStep(idx: number, payload: Uint8Array): AgyStep | undefined {
  let top: Field[];
  try {
    top = parseProto(Buffer.from(payload));
  } catch {
    return undefined;
  }
  const type = int(top, 1) ?? 0;
  const status = int(top, 4) ?? 0;
  const meta = sub(top, 5);
  const secs = int(sub(meta, 1), 1);
  const step: AgyStep = { idx, kind: 'other', status, at: secs ? secs * 1000 : 0 };
  if (type === 14) {
    step.kind = 'user';
    step.text = str(sub(top, 19), 2);
  } else if (type === 15) {
    step.kind = 'model';
    const m = sub(top, 20);
    const answer = str(m, 8) ?? str(m, 1);
    step.text = answer ?? str(m, 3);
    step.thinking = !answer;
  } else if (type === 132) {
    step.kind = 'tool';
    const call = sub(meta, 4);
    step.tool = str(call, 2);
    const raw = str(call, 3);
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') step.args = parsed as Record<string, unknown>;
      } catch {
        /* argumentos truncados */
      }
    }
    step.summary = str(sub(sub(top, 140), 1), 2);
  }
  return step;
}

/** Pasta do projeto da conversa: o primeiro `file:///...` do `trajectory_metadata_blob`. */
export function workspaceOf(blob: Uint8Array): string | undefined {
  const m = /file:\/\/\/[^\s"\u0000-\u001f]+/.exec(Buffer.from(blob).toString('latin1'));
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[0].slice('file://'.length)).replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}
