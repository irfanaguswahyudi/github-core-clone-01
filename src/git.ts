// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2 + v0),
// receive-pack (v0). Objects are stored verbatim; packs are plain (no deltas out).
import { collectReachable, decodePackets, isOid, packetLines, parseTree, pktDelim, pktEnd, pktFlush, pktLine, readPack, writePack, ZERO_OID, type GitObject } from './gitobj.ts';
import { parseCommit, parseTag } from './gitobj.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'forge/1.0';

function capsLine(caps: string[]): string { return caps.join(' '); }

interface RefLine { oid: string; name: string; peeled?: string; symrefTarget?: string; unborn?: boolean; }

function sortedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const target = parseTag(obj.data).object;
      line.peeled = target;
    }
    out.push(line);
  }
  return out;
}

function headTarget(repo: Repo): string { return `refs/heads/${repo.defaultBranch}`; }

/** v0 advertisement body (with # service preamble). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? ['side-band-64k', 'thin-pack', 'ofs-delta', 'multi_ack', 'shallow', `symref=HEAD:${headTarget(repo)}`, `agent=${AGENT}`]
    : ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${capsLine(caps)}\n`);
  } else {
    if (headOid) lines.push(`${headOid} HEAD\0${capsLine(caps)}\n`);
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}\n`);
      if (r.peeled) lines.push(`${r.peeled} ${r.name}^{}\n`);
    }
    if (!headOid) {
      // caps must ride on the first line; redo with caps on first ref line
      lines[0] = `${lines[0].replace(/\n$/, '')}\0${capsLine(caps)}\n`;
    }
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 capability advertisement body. */
function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), pktFlush()]);
}

/** Split a buffer into side-band packets (band byte + chunk). */
function sidebandPackets(pack: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const MAX = 65515;
  for (let off = 0; off < pack.length; off += MAX) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + MAX));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(pktLine(payload));
  }
  return out;
}

interface FetchPlan {
  include: Set<string>; // commit oids to include
  shallow: string[]; // boundary commits (included, parents cut)
  unshallow: string[]; // formerly-shallow commits now fully included
  acks: string[];
}

/** Plan a fetch: generations from wants, minus haves' reachability. */
function planFetch(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth?: number): FetchPlan {
  const gen = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  const include = new Set<string>();
  const shallow: string[] = [];
  while (queue.length) {
    const [oid, g] = queue.shift()!;
    if (!oid || oid === ZERO_OID) continue;
    if (gen.has(oid) && gen.get(oid)! <= g) continue;
    gen.set(oid, g);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      // annotated tag: include the tag and walk its target as generation 0
      include.add(oid);
      queue.push([parseTag(obj.data).object, 0]);
      continue;
    }
    if (obj.type !== 'commit') { include.add(oid); continue; }
    if (depth !== undefined && g >= depth) continue;
    include.add(oid);
    const parents = parseCommit(obj.data).parents;
    for (const p of parents) queue.push([p, g + 1]);
  }
  // haves remove their reachable commits from the included set; the walk stops
  // at client-declared shallow boundaries (their parents are not held).
  if (haves.length) {
    const shallowSet = new Set(shallowIn);
    const haveReach = new Set<string>();
    const stack = [...haves];
    while (stack.length) {
      const oid = stack.pop()!;
      if (!oid || oid === ZERO_OID || haveReach.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      haveReach.add(oid);
      if (!shallowSet.has(oid)) for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    for (const oid of [...include]) if (haveReach.has(oid)) include.delete(oid);
  }
  // shallow boundaries: included commits with a parent not included
  for (const oid of include) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length && parents.some((p) => !include.has(p))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const b of shallowIn) {
    if (!include.has(b)) continue;
    const obj = repo.objects.get(b);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0 || parents.every((p) => include.has(p))) unshallow.push(b);
  }
  const acks: string[] = [];
  for (const h of haves) {
    // ack a have that is an ancestor of a want (or held)
    if (repo.objects.get(h)?.type === 'commit') acks.push(h);
  }
  return { include, shallow, unshallow, acks };
}

function packForFetch(repo: Repo, plan: FetchPlan, haves: string[], shallowIn: string[]): Buffer | null {
  // Objects reachable from included commits WITHOUT descending into non-included
  // parents (depth/shallow cuts), minus objects the client already holds.
  const wanted = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (!oid || oid === ZERO_OID || wanted.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      wanted.add(oid);
      if (obj.type === 'tree') for (const e of parseTree(obj.data)) stack.push(e.oid);
      else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
    }
  };
  for (const oid of plan.include) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    wanted.add(oid);
    if (obj.type === 'commit') addTreeClosure(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const tobj = repo.objects.get(target);
      if (tobj?.type === 'commit') { wanted.add(target); addTreeClosure(parseCommit(tobj.data).tree); }
      else if (tobj) addTreeClosure(target);
    } else if (obj.type === 'tree') addTreeClosure(oid);
  }
  // Objects the client holds: reachability from haves, stopping at shallow
  // boundaries (the client lacks those commits' parents).
  if (haves.length) {
    const shallowSet = new Set(shallowIn);
    const haveObjs = new Set<string>();
    const stack = [...haves];
    while (stack.length) {
      const oid = stack.pop()!;
      if (!oid || oid === ZERO_OID || haveObjs.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      haveObjs.add(oid);
      if (obj.type === 'commit') {
        addTreeClosureTo(obj, haveObjs, repo);
        if (!shallowSet.has(oid)) for (const p of parseCommit(obj.data).parents) stack.push(p);
      } else if (obj.type === 'tree') {
        addTreeClosureTo(obj, haveObjs, repo);
      }
    }
    for (const oid of haveObjs) wanted.delete(oid);
  }
  if (wanted.size === 0) return null;
  const objs: GitObject[] = [];
  for (const oid of [...wanted].sort()) {
    const obj = repo.objects.get(oid);
    if (obj) objs.push(obj);
  }
  return writePack(objs);
}

function addTreeClosureTo(obj: GitObject, out: Set<string>, repo: Repo): void {
  const stack: string[] = [];
  if (obj.type === 'commit') stack.push(parseCommit(obj.data).tree);
  else if (obj.type === 'tree') stack.push('');
  // caller adds the object itself; this walks its tree entries
  const start = obj.type === 'commit' ? parseCommit(obj.data).tree : null;
  if (start) stack.push(start);
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || out.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (!o) continue;
    out.add(oid);
    if (o.type === 'tree') for (const e of parseTree(o.data)) stack.push(e.oid);
    else if (o.type === 'tag') stack.push(parseTag(o.data).object);
  }
}

export interface GitRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}

/** Handle a git smart-HTTP request. Returns {status, contentType, body} or null if not a git path. */
export function handleGit(store: Store, req: GitRequest): { status: number; contentType: string; body: Buffer } | null {
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(req.path);
  if (!m) return null;
  const owner = decodeURIComponent(m[1]);
  const repoName = decodeURIComponent(m[2]);
  const rest = m[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

  if (req.method === 'GET' && rest === '/info/refs') {
    const service = req.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      if (isV2) return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
    }
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'unknown service' }) + '\n') };
  }

  if (req.method === 'POST' && rest === '/git-upload-pack') {
    return isV2 ? uploadPackV2(store, repo, req.body) : uploadPackV0(store, repo, req.body);
  }
  if (req.method === 'POST' && rest === '/git-receive-pack') {
    return receivePack(store, repo, req.body);
  }
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
}

/** Pack cache: identical fetches (same wants/haves/depth/ref state) reuse one pack.
 * The key includes the full ref snapshot, so any ref change invalidates it;
 * objects are immutable, so nothing else can change a fetch's answer. */
const fetchCache = new WeakMap<Repo, Map<string, { plan: FetchPlan; pack: Buffer | null }>>();
function fetchCacheKey(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | undefined): string {
  const refs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify({ wants, haves, shallowIn, depth: depth ?? null, refs });
}
function cachedFetch(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | undefined): { plan: FetchPlan; pack: Buffer | null } {
  const key = fetchCacheKey(repo, wants, haves, shallowIn, depth);
  let perRepo = fetchCache.get(repo);
  if (!perRepo) { perRepo = new Map(); fetchCache.set(repo, perRepo); }
  const hit = perRepo.get(key);
  if (hit) return hit;
  const plan = planFetch(repo, wants, haves, shallowIn, depth);
  const pack = packForFetch(repo, plan, haves, shallowIn);
  const entry = { plan, pack };
  perRepo.set(key, entry);
  if (perRepo.size > 8) { const first = perRepo.keys().next().value; if (first !== undefined) perRepo.delete(first); }
  return entry;
}

function lsRefsResponse(repo: Repo, prefixes: string[], wantPeel: boolean, wantSymrefs: boolean, wantUnborn: boolean): Buffer {
  const lines: string[] = [];
  const headOid = repo.refs.get(headTarget(repo));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (wantUnborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:${headTarget(repo)}\n`);
  } else {
    if (keep('HEAD') && headOid) {
      lines.push(wantSymrefs ? `${headOid} HEAD symref-target:${headTarget(repo)}\n` : `${headOid} HEAD\n`);
    }
    for (const r of refs) {
      if (!keep(r.name)) continue;
      let line = `${r.oid} ${r.name}`;
      if (wantPeel && r.peeled) line += ` peeled:${r.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  const parts = lines.map((l) => pktLine(l));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function uploadPackV2(_store: Store, repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const packets = decodePackets(body);
  const lines = packetLines(body);
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice(8) : '';
  const ct = 'application/x-git-upload-pack-result';
  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false; let symrefs = false; let unborn = false;
    for (const line of lines.slice(1)) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
    }
    void packets;
    return { status: 200, contentType: ct, body: lsRefsResponse(repo, prefixes, peel, symrefs, unborn) };
  }
  if (command === 'fetch') {
    const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
    let depth: number | undefined;
    for (const line of lines.slice(1)) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) { const n = Number(line.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
    }
    const { plan, pack } = cachedFetch(repo, wants, haves, shallowIn, depth);
    const parts: Buffer[] = [];
    // protocol-v2: the acknowledgments section exists only when the client
    // sent haves (a clone sends none and gets no section).
    if (haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      if (plan.acks.length) {
        for (const a of plan.acks) parts.push(pktLine(`ACK ${a}\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(pktDelim());
    }
    if (plan.shallow.length || plan.unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(pktDelim());
    }
    if (pack) {
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPackets(pack));
    }
    parts.push(pktFlush());
    return { status: 200, contentType: ct, body: Buffer.concat(parts) };
  }
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'unknown command' }) + '\n') };
}

function uploadPackV0(_store: Store, repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  // two sections split by flush: wants (+shallow/deepen), then haves + done
  const packets = decodePackets(body);
  const sections: string[][] = [[]];
  for (const p of packets) {
    if (p.kind === 'flush') { sections.push([]); continue; }
    if (p.kind === 'data') sections[sections.length - 1].push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
  let depth: number | undefined;
  for (const section of sections) {
    for (const line of section) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) { const n = Number(line.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
    }
  }
  const { plan, pack } = cachedFetch(repo, wants, haves, shallowIn, depth);
  const parts: Buffer[] = [];
  if (plan.acks.length) {
    for (const a of plan.acks) parts.push(pktLine(`ACK ${a}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (pack) parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function receivePack(_store: Store, repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const ct = 'application/x-git-receive-pack-result';
  // Sideband framing applies only when the client negotiated side-band-64k
  // in the capabilities of the first command line; otherwise the report is
  // plain pkt-lines. Set during command parsing, read at report time.
  let negotiatedSideband = false;
  const report = (lines: string[]): Buffer => {
    const inner = Buffer.concat([...lines.map((l) => pktLine(l)), pktFlush()]);
    if (!negotiatedSideband) return inner;
    // band-1 sideband packets carrying the report pkt-lines
    const payload = Buffer.concat([Buffer.from([1]), inner]);
    const parts: Buffer[] = [];
    const MAX = 65515;
    for (let off = 0; off < payload.length; off += MAX) {
      parts.push(pktLine(payload.subarray(off, Math.min(payload.length, off + MAX))));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  };
  // Split command list (pkt-lines up to first flush) from the pack that follows.
  let off = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = body.length;
  try {
    while (off + 4 <= body.length) {
      const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
      if (len === 0) { packStart = off + 4; break; }
      if (len === 1 || len === 2) { off += 4; continue; }
      if (off + len > body.length) break;
      const line = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        if (caps.includes('side-band-64k')) negotiatedSideband = true;
      }
      const head = nul >= 0 ? line.slice(0, nul) : line;
      const parts = head.split(' ');
      if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
      }
      off += len;
    }
  } catch {
    return { status: 200, contentType: ct, body: report(['unpack error\n']) };
  }
  if (commands.length === 0) {
    return { status: 200, contentType: ct, body: report(['unpack ok\n']) };
  }
  const packBytes = body.subarray(packStart);
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    } catch {
      return { status: 200, contentType: ct, body: report(['unpack error\n']) };
    }
  }
  const lines: string[] = ['unpack ok\n'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = false; let reason = '';
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) { ok = false; reason = 'no such ref'; }
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { ok = false; reason = 'non-fast-forward'; }
      else { repo.refs.delete(cmd.ref); ok = true; }
    } else if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) { ok = false; reason = 'already exists'; }
      else if (!repo.objects.get(cmd.newOid)) { ok = false; reason = 'missing object'; }
      else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
    } else {
      if (current !== cmd.oldOid) { ok = false; reason = 'non-fast-forward'; }
      else if (!repo.objects.get(cmd.newOid)) { ok = false; reason = 'missing object'; }
      else {
        // fast-forward: old must be an ancestor of new
        const obj = repo.objects.get(cmd.newOid);
        if (!obj || obj.type !== 'commit') { ok = false; reason = 'non-fast-forward'; }
        else {
          // walk new's ancestry for old
          const seen = new Set<string>();
          const stack = [cmd.newOid];
          let found = false;
          while (stack.length) {
            const oid = stack.pop()!;
            if (oid === cmd.oldOid) { found = true; break; }
            if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
            seen.add(oid);
            const o = repo.objects.get(oid);
            if (o?.type === 'commit') for (const p of parseCommit(o.data).parents) stack.push(p);
          }
          if (found) { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
          else { ok = false; reason = 'non-fast-forward'; }
        }
      }
    }
    lines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
  }
  return { status: 200, contentType: ct, body: report(lines) };
}
