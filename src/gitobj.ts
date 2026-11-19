// Git object model + pkt-line codec + packfile read/write (Node stdlib only).
// Own implementation written for this forge; wire shapes follow the git protocol
// as the kit's client exercises it (v2/v0, side-band-64k, OFS/REF deltas).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer; }

const TYPE_CODE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const HEX40 = /^[0-9a-f]{40}$/;
export const isOid = (v: string): boolean => HEX40.test(v);

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
export function storeObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// --- pkt-line ---
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export const pktEnd = (): Buffer => Buffer.from('0002', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode all pkt-lines in a buffer (throws on truncation). */
export function decodePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line truncated');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) throw new Error('pkt-line bad length');
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end' }); off += 4; continue; }
    if (off + len > buf.length) throw new Error('pkt-line truncated');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
/** Lines (utf8, \n stripped) of data packets. */
export function packetLines(buf: Buffer): string[] {
  const lines: string[] = [];
  for (const p of decodePackets(buf)) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// --- tree / commit / tag ---
export interface TreeEntry { mode: string; name: string; oid: string; }
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree');
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const bn = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(an, bn);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
export interface CommitView { tree: string; parents: string[]; message: string; }
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}
export function parseTag(data: Buffer): { object: string; type: ObjType; message: string } {
  const blank = data.indexOf('\n\n');
  const head = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  let object = '';
  let type: ObjType = 'commit';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
  }
  return { object, type, message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}
export function buildCommit(tree: string, parents: string[], message: string, who: string, ts: number): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who} ${ts} +0000`, `committer ${who} ${ts} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// --- delta ---
function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0; let shift = 0; let o = off;
  for (;;) {
    if (o >= buf.length) throw new Error('delta varint truncated');
    const b = buf[o++];
    value += (b & 0x7f) * 2 ** shift; shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value, next: o };
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const src = readVarint(delta, off); off = src.next;
  const tgt = readVarint(delta, off); off = tgt.next;
  if (src.value !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgt.value);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0; let shift = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) cpOff += delta[off++] * 2 ** shift; shift += 8; }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) cpSize += delta[off++] * 2 ** shift; shift += 8; }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, written, cpOff, cpOff + cpSize);
      written += cpSize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n); off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgt.value) throw new Error('delta size mismatch');
  return out;
}

// --- packfile ---
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const r = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = r.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib consumed nothing');
  return { data: r.buffer, next: offset + written };
}

/** Read a PACK v2/v3; resolveBase supplies thin-pack bases already held. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: GitObject; oid?: string; }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = offset;
    let b = pack[offset];
    let size = b & 0x0f; let shift = 4; offset += 1;
    while (b & 0x80) { b = pack[offset++]; size += (b & 0x7f) * 2 ** shift; shift += 7; }
    const typeCode = (pack[entryOffset] >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[offset]; let value = byte & 0x7f; offset += 1;
      while (byte & 0x80) { byte = pack[offset++]; value = ((value + 1) * 128) + (byte & 0x7f); }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex'); offset += 20;
    } else if (!TYPE_CODE[typeCode]) throw new Error(`pack type ${typeCode}`);
    const inf = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inf.data.length !== size) throw new Error('pack size mismatch');
    entry.data = inf.data; offset = inf.next;
    raw.push(entry); byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.resolved && entry.oid) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let result: GitObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error('ofs-delta base missing');
        base = resolve(baseEntry);
      } else {
        const inPack = raw.find((e) => e.oid === entry.baseOid);
        base = inPack ? resolve(inPack) : resolveBase?.(entry.baseOid!);
        if (!base) throw new Error('ref-delta base missing');
      }
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data };
    } else {
      result = { type: TYPE_CODE[entry.typeCode]!, data: entry.data };
    }
    const oid = hashObject(result.type, result.data);
    entry.resolved = result; entry.oid = oid;
    objects.set(oid, result);
    resolving.delete(entry.offset);
    return result;
  };
  for (const e of raw) resolve(e);
  return objects;
}

/** Write a PACK v2 with plain (undeltified) objects. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [head];
  for (const obj of list) {
    const code = CODE_TYPE[obj.type];
    const size = obj.data.length;
    const hdr: number[] = [];
    let first = (size & 0x0f) | (code << 4);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    hdr.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      hdr.push(byte);
    }
    parts.push(Buffer.from(hdr));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** All objects reachable from roots (commits walk parents+trees, tags walk target). */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
