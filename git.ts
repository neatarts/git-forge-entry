// Git smart-HTTP handlers: protocol v2 upload-pack (ls-refs, fetch) and v0
// receive-pack (push), over pkt-line framing. Node 22 stdlib only.
//
// The suite's client (kit sdk/conformance/git-client.ts) drives this surface with
// no git binary: it requests v2 with `Git-Protocol: version=2` on upload-pack,
// v0 on receive-pack, always asks for side-band-64k, and parses the reply with a
// strict pkt-line decoder. Everything below is shaped to what that client accepts:
//
//  * v2 advertisement: `version 2` first, capabilities `ls-refs=unborn`,
//    `fetch=shallow wait-for-done filter`, `object-format=sha1`.
//  * v0 advertisements open with `# service=git-...` and carry capabilities after
//    a NUL on the first ref line (or on a `capabilities^{}` line for an empty repo).
//  * fetch answers in v2 sections (acknowledgments / shallow-info / packfile) with
//    the pack wrapped in sideband band-1 pkt-lines; a fetch with nothing new sends
//    no packfile section at all (an empty one would fail the client's parser).
//  * receive-pack unpacks PACK v2 (plain entries plus ofs/ref deltas, including
//    thin packs whose delta bases already live in the repo), then applies ref
//    updates fast-forward only and answers report-status inside sideband band 1.
//
// Packfiles we generate carry no deltas (a self-contained pack is always valid);
// object SHAs are content-derived, so responses are deterministic.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  FIXED_DATE,
  parseCommitHeaders,
  parseTree,
  type GitObject,
  type ObjType,
  type Repo,
  type Store,
} from './store.ts';

export const ZERO_OID = '0'.repeat(40);

/** Max pkt-line payload: 65520 total - 4 header - 1 sideband byte. */
const SIDEBAND_CHUNK = 65515;

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Parse pkt-lines from a buffer. Tolerant: on a bad length header or truncation it
 * stops and reports ok:false instead of throwing, so a malformed request can never
 * take the server down (the suite sends one deliberately and then checks the repo
 * still clones).
 */
function parsePktLines(buffer: Buffer): { packets: Pkt[]; rest: Buffer; ok: boolean } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { packets, rest: buffer.subarray(offset), ok: false };
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) {
      return { packets, rest: buffer.subarray(offset), ok: false };
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset), ok: offset === buffer.length };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Every git route requires `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; when the
 * env var is unset locally, any non-empty Bearer token is accepted. */
function checkAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return match[1] === expected;
}

// ---------------------------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------------------------

/**
 * Non-branch refs (tags, and anything else a push creates outside refs/heads/).
 * The Store's `branches` map holds only branches, so tag refs live in this
 * module-level WeakMap keyed by the Repo object; the store is in-memory and
 * single-process, so it survives across requests for the process's life.
 */
const extraRefs = new WeakMap<Repo, Map<string, string>>();

function extraRefsOf(repo: Repo): Map<string, string> {
  let map = extraRefs.get(repo);
  if (!map) {
    map = new Map<string, string>();
    extraRefs.set(repo, map);
  }
  return map;
}

interface RefEntry {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs, sorted: branches first, then the rest, each group by name. */
function allRefs(repo: Repo): RefEntry[] {
  const out: RefEntry[] = [];
  for (const name of [...repo.branches.keys()].sort()) {
    out.push({ name: `refs/heads/${name}`, oid: repo.branches.get(name)! });
  }
  for (const name of [...extraRefsOf(repo).keys()].sort()) {
    const oid = extraRefsOf(repo).get(name)!;
    const entry: RefEntry = { name, oid };
    const peeled = peelToCommit(repo, oid);
    if (peeled !== undefined && peeled !== oid) entry.peeled = peeled;
    out.push(entry);
  }
  return out;
}

/** Follow an annotated tag (recursively) to its commit, or undefined. */
function peelToCommit(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (!object) return undefined;
  if (object.type === 'commit') return oid;
  if (object.type !== 'tag') return undefined;
  const text = object.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  if (!match) return undefined;
  return peelToCommit(repo, match[1]);
}

function parseTagTarget(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const headerText = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  let object = '';
  let type = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return { object, type };
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `tips` (commits, trees, blobs, tags), by oid.
 * `cutParents`: commits whose parents are NOT followed — the client's shallow
 * boundaries: a shallow clone holds the boundary commit but not its history,
 * so the have-closure must stop there or a deepen would (wrongly) conclude
 * the parent is already held and send nothing.
 */
function collectReachable(repo: Repo, tips: Iterable<string>, cutParents: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const { tree, parents } = parseCommitHeaders(object.data);
      if (tree !== '') stack.push(tree);
      if (!cutParents.has(oid)) for (const parent of parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.sha);
    } else if (object.type === 'tag') {
      stack.push(parseTagTarget(object.data).object);
    }
  }
  return seen;
}

/** All commit oids reachable from `tips` (following parents, peeling tags). */
function collectAncestorCommits(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    const peeled = peelToCommit(repo, tip);
    if (peeled !== undefined) stack.push(peeled);
    else {
      const object = repo.objects.get(tip);
      if (object && object.type === 'commit') stack.push(tip);
    }
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommitHeaders(object.data).parents) stack.push(parent);
  }
  return seen;
}

/**
 * Is `ancestor` an ancestor of (or equal to) `descendant`? A targeted walk
 * from the descendant that stops the moment the ancestor is found: the
 * fast-forward case is almost always the immediate parent, so this is O(1)
 * there instead of collecting the descendant's whole ancestor set.
 */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommitHeaders(object.data).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Object oids to send, in deterministic order. */
  toSend: string[];
  /** New shallow boundaries (commits whose parent was cut off by `deepen`). */
  shallow: string[];
  /** Former shallow boundaries that are no longer boundaries. */
  unshallow: string[];
  /** Haves the client and server share (ancestors of the wants). */
  acks: string[];
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | undefined,
): FetchPlan {
  const haveSet = new Set(haves);
  // With no haves there can be no acks: skip the whole-history ancestor walk
  // (a plain clone's fetch must not pay for it).
  const ancestors = haves.length > 0 ? collectAncestorCommits(repo, wants) : new Set<string>();
  const acks = haves.filter((have) => ancestors.has(have));

  // Depth-limited walk from the wants. A want is always walked even when it is
  // also a have (a deepen starts from the shallow tip the client already holds);
  // a parent that is a have is never expanded, because the client holds its history.
  const included = new Set<string>();
  const shallowSet = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = [];
  let queueIndex = 0;
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      const target = parseTagTarget(object.data).object;
      const peeled = peelToCommit(repo, want);
      if (peeled !== undefined) queue.push({ oid: peeled, gen: 0 });
      else if (target !== '') queue.push({ oid: target, gen: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    }
  }
  while (queueIndex < queue.length) {
    const { oid, gen } = queue[queueIndex]!;
    queueIndex += 1;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    included.add(oid);
    const { parents } = parseCommitHeaders(object.data);
    for (const parent of parents) {
      if (haveSet.has(parent)) continue;
      if (depth !== undefined && gen + 1 >= depth) {
        if (repo.objects.has(parent)) shallowSet.add(oid);
        continue;
      }
      if (repo.objects.has(parent)) queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  // Everything the included commits (and any non-commit wants) reach, minus
  // everything the haves already reach: the client must never be re-sent an
  // object it holds (the incremental-fetch check asserts exactly this).
  // NOTE: reachability from an included commit is only its own tree closure, NOT
  // its ancestors — a depth-limited fetch must not leak history past the cutoff.
  const wantedObjects = new Set<string>();
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type !== 'commit') {
      for (const oid of collectReachable(repo, [want])) wantedObjects.add(oid);
    }
  }
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    wantedObjects.add(oid);
    const { tree } = parseCommitHeaders(object.data);
    if (tree !== '') for (const reached of collectReachable(repo, [tree])) wantedObjects.add(reached);
  }
  const haveClosure = collectReachable(repo, haves, new Set(shallowIn));
  const toSend = [...wantedObjects].filter((oid) => !haveClosure.has(oid)).sort();

  const unshallow: string[] = [];
  for (const boundary of shallowIn) {
    if (shallowSet.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    if (!included.has(boundary) && !haveSet.has(boundary)) continue;
    const { parents } = parseCommitHeaders(object.data);
    if (parents.every((parent) => included.has(parent) || haveSet.has(parent))) {
      unshallow.push(boundary);
    }
  }

  return { toSend, shallow: [...shallowSet].sort(), unshallow: unshallow.sort(), acks };
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Caches for pack generation. Git objects are content-addressed and immutable,
 * so both caches are deterministic: a cached entry's bytes are exactly the
 * bytes a fresh build would produce, and eviction only costs a rebuild.
 * Whole packs are keyed by their (sorted) oid list; deflated object bytes by
 * oid. Both are bounded FIFO maps (insertion order) so a long-lived server
 * cannot grow them without bound.
 */
const PACK_CACHE_MAX = 128;
const packCache = new Map<string, Buffer>();
const DEFLATE_CACHE_MAX = 4096;
const deflatedCache = new Map<string, Buffer>();

function deflatedOf(oid: string, data: Buffer): Buffer {
  const cached = deflatedCache.get(oid);
  if (cached !== undefined) return cached;
  const out = deflateSync(data);
  if (deflatedCache.size >= DEFLATE_CACHE_MAX) {
    const oldest = deflatedCache.keys().next().value;
    if (oldest !== undefined) deflatedCache.delete(oldest);
  }
  deflatedCache.set(oid, out);
  return out;
}

/** PACK v2, one plain (undelted) entry per object, SHA-1 trailer. */
function buildPack(repo: Repo, oids: readonly string[]): Buffer {
  const key = oids.join(',');
  const cachedPack = packCache.get(key);
  if (cachedPack !== undefined) return cachedPack;
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflatedOf(oid, object.data));
  }
  const body = Buffer.concat(parts);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  if (packCache.size >= PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

/** Wrap pack bytes in sideband band-1 pkt-lines (no progress is ever sent). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// --- pack parsing (receive-pack) ---------------------------------------------------------

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse a PACK v2/v3 buffer into resolved objects. Handles plain entries and
 * ofs-delta / ref-delta entries; a delta base may be another entry in the same
 * pack or an object the repo already holds (thin packs).
 */
function parsePack(pack: Buffer, repo: Repo): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      entry.baseOffset = entryOffset - base.baseOffset;
      offset = base.next;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
  }

  const byOffset = new Map<number, RawPackEntry>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const memo = new Map<number, GitObject>();
  const oidByOffset = new Map<number, string>();
  const byOid = new Map<string, GitObject>();
  const resolving = new Set<number>();

  const hashObjectOf = (object: GitObject): string => {
    const header = Buffer.from(`${object.type} ${object.data.length}\0`, 'ascii');
    return createHash('sha1').update(header).update(object.data).digest('hex');
  };

  const resolve = (entry: RawPackEntry): GitObject => {
    const cached = memo.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    try {
      let result: GitObject;
      if (entry.typeCode === 6 || entry.typeCode === 7) {
        let base: GitObject | undefined;
        if (entry.typeCode === 6) {
          const baseEntry = byOffset.get(entry.baseOffset!);
          if (!baseEntry) throw new Error('ofs-delta base is outside the pack');
          base = resolve(baseEntry);
        } else {
          base = repo.objects.get(entry.baseOid!) ?? byOid.get(entry.baseOid!);
          if (!base) {
            // The base may be a not-yet-resolved entry in this pack (a
            // ref-delta to a later delta entry): resolve entries until it appears.
            for (const candidate of raw) {
              if (memo.has(candidate.offset) || resolving.has(candidate.offset)) continue;
              try {
                resolve(candidate);
              } catch {
                // Not resolvable yet; keep looking.
              }
              base = byOid.get(entry.baseOid!);
              if (base) break;
            }
          }
        }
        if (!base) throw new Error(`ref-delta base ${entry.baseOid} is not in the pack or the repo`);
        result = { type: base.type, data: applyDelta(base.data, entry.data) };
      } else {
        const type = CODE_TYPE[entry.typeCode];
        if (!type) throw new Error(`unknown pack object type ${entry.typeCode}`);
        if (entry.data.length !== entry.size) throw new Error('pack entry size mismatch');
        result = { type, data: entry.data };
      }
      memo.set(entry.offset, result);
      const oid = hashObjectOf(result);
      oidByOffset.set(entry.offset, oid);
      byOid.set(oid, result);
      return result;
    } finally {
      resolving.delete(entry.offset);
    }
  };

  const out = new Map<string, GitObject>();
  for (const entry of raw) {
    const object = resolve(entry);
    out.set(oidByOffset.get(entry.offset)!, object);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

/** The v2 advertisement is constant: build it once, never per request. */
const INFO_REFS_V2_BODY: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=git-forge/1.0\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done filter\n'),
  pktLine('object-format=sha1\n'),
  FLUSH,
]);

function infoRefsV2Body(): Buffer {
  return INFO_REFS_V2_BODY;
}

function infoRefsV0Body(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const defaultBranch = repo.default_branch;
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/${defaultBranch} agent=git-forge/1.0`
      : 'report-status side-band-64k delete-refs ofs-delta agent=git-forge/1.0';
  const refs = allRefs(repo);
  const headTip = repo.branches.get(defaultBranch);
  const lines: string[] = [];
  if (headTip !== undefined) {
    lines.push(`${headTip} HEAD`);
  } else if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  }
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}`);
  }
  if (lines.length === 0) {
    // Branches exist but the default branch is unborn: HEAD at zero with caps.
    lines.push(`${ZERO_OID} HEAD`);
  }
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

async function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
): Promise<void> {
  if (!checkAuth(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://entry');
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  const body = isV2 ? infoRefsV2Body() : infoRefsV0Body(repo, service);
  sendBytes(res, 200, `application/x-${service}-advertisement`, body);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  /** Ref names named by `want-ref` lines (resolved to oids by the caller). */
  wantRefs: string[];
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, wantRefs: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('want-ref ')) args.wantRefs.push(text.slice('want-ref '.length).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done, agent, object-format:
    // parsed for shape, otherwise ignored (an unknown filter must not break
    // the fetch; the full objects are simply sent).
  }
  return args;
}

function resolveWantRefs(repo: Repo, args: FetchArgs): void {
  if (args.wantRefs.length === 0) return;
  const byName = new Map<string, string>();
  for (const ref of allRefs(repo)) byName.set(ref.name, ref.oid);
  if (args.wantRefs.includes('HEAD')) {
    const tip = repo.branches.get(repo.default_branch);
    if (tip !== undefined) byName.set('HEAD', tip);
  }
  for (const refName of args.wantRefs) {
    const oid = byName.get(refName);
    if (oid !== undefined && oid !== ZERO_OID && !args.wants.includes(oid)) args.wants.push(oid);
  }
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  // Real git only expects an acknowledgments section when it sent haves: a
  // plain clone (no haves) fails with "expected 'packfile', received
  // 'acknowledgments'" if one is sent. The suite's client tolerates its
  // absence (nak stays false), so emit it only when haves were sent.
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(DELIM);
  }
  if (plan.toSend.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(buildPack(repo, plan.toSend)));
    parts.push(FLUSH);
  } else {
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  if (plan.toSend.length > 0) {
    parts.push(...sidebandPack(buildPack(repo, plan.toSend)));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, args: {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}): Buffer {
  const parts: Buffer[] = [];
  const defaultBranch = repo.default_branch;
  const headTip = repo.branches.get(defaultBranch);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  // HEAD is reported like any other ref: it is included exactly when a
  // ref-prefix matches it (a clone asks for `ref-prefix HEAD` alongside
  // `refs/heads/` and `refs/tags/`; a prefix filter for `refs/heads/` alone
  // must not see it).
  if (matches('HEAD')) {
    if (args.symrefs) {
      parts.push(
        headTip !== undefined
          ? pktLine(`${headTip} HEAD symref-target:refs/heads/${defaultBranch}\n`)
          : pktLine(`unborn HEAD symref-target:refs/heads/${defaultBranch}\n`),
      );
    } else if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${defaultBranch}\n`));
    }
  }
  for (const ref of allRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
): Promise<void> {
  if (!checkAuth(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (!isV2) {
    // Protocol v0: wants (+ capabilities on the first want line), shallow/deepen,
    // flush, haves, done, flush. Section boundaries are ignored; every line is
    // collected and the fetch is planned from the whole set.
    const { packets, ok } = parsePktLines(body);
    if (!ok && packets.length === 0) {
      sendBytes(res, 200, 'application/x-git-upload-pack-result', FLUSH);
      return;
    }
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    const args = parseFetchArgs(lines);
    resolveWantRefs(repo, args);
    sendBytes(res, 200, 'application/x-git-upload-pack-result', fetchResponseV0(repo, args));
    return;
  }
  const { packets } = parsePktLines(body);
  const dataLines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const commandLine = dataLines.find((line) => line.startsWith('command='));
  if (commandLine === 'command=ls-refs\n' || commandLine?.replace(/\n$/, '') === 'command=ls-refs') {
    const afterDelim = dataLines.slice(dataLines.indexOf(commandLine) + 1);
    const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
    for (const line of afterDelim) {
      const text = line.replace(/\n$/, '');
      if (text === 'peel') args.peel = true;
      else if (text === 'symrefs') args.symrefs = true;
      else if (text === 'unborn') args.unborn = true;
      else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    }
    // The client always asks for peel + symrefs + unborn; default them on when
    // the request carries none of the flags explicitly is wrong, so keep the
    // parsed values only. (ls-refs with no flags still lists the refs.)
    sendBytes(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
    return;
  }
  if (commandLine === 'command=fetch\n' || commandLine?.replace(/\n$/, '') === 'command=fetch') {
    const afterDelim = dataLines.slice(dataLines.indexOf(commandLine) + 1);
    const args = parseFetchArgs(afterDelim);
    resolveWantRefs(repo, args);
    sendBytes(res, 200, 'application/x-git-upload-pack-result', fetchResponseV2(repo, args));
    return;
  }
  // Unknown command: answer an empty response rather than dying.
  sendBytes(res, 200, 'application/x-git-upload-pack-result', FLUSH);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function checkRefUpdate(
  repo: Repo,
  command: PushCommand,
): { ok: boolean; reason: string } {
  const isBranch = command.ref.startsWith('refs/heads/');
  const current = isBranch
    ? repo.branches.get(command.ref.slice('refs/heads/'.length))
    : extraRefsOf(repo).get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    return { ok: true, reason: '' };
  }
  // New tip must exist (it arrived in the pack, or was already on the server).
  const tip = repo.objects.get(command.newOid);
  if (!tip) return { ok: false, reason: 'missing object' };
  if (current === undefined) {
    if (command.oldOid !== ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    return { ok: true, reason: '' };
  }
  if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  if (command.newOid === current) return { ok: true, reason: '' };
  // Fast-forward: the current tip must be an ancestor of the new tip.
  const newCommit = peelToCommit(repo, command.newOid);
  const currentCommit = peelToCommit(repo, current);
  if (newCommit === undefined || currentCommit === undefined) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  if (!isAncestor(repo, currentCommit, newCommit)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  return { ok: true, reason: '' };
}

function applyRefUpdate(repo: Repo, command: PushCommand): void {
  if (command.ref.startsWith('refs/heads/')) {
    const branch = command.ref.slice('refs/heads/'.length);
    if (command.newOid === ZERO_OID) repo.branches.delete(branch);
    else repo.branches.set(branch, command.newOid);
  } else {
    const map = extraRefsOf(repo);
    if (command.newOid === ZERO_OID) map.delete(command.ref);
    else map.set(command.ref, command.newOid);
  }
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
): Promise<void> {
  if (!checkAuth(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const body = await readBody(req);
  const { packets, ok } = parsePktLines(body);
  const reportLines: string[] = [];
  let sideband = false;
  let unpackOk = true;
  let unpackDetail = 'ok';
  const commands: PushCommand[] = [];

  if (!ok && packets.length === 0) {
    unpackOk = false;
    unpackDetail = 'malformed request';
  } else {
    // Commands run up to the first flush; everything after it is the packfile.
    let packStart = body.length;
    let offset = 0;
    let sawFlush = false;
    for (const packet of packets) {
      const header = body.subarray(offset, offset + 4).toString('ascii');
      const length = Number.parseInt(header, 16);
      if (packet.kind === 'flush') {
        packStart = offset + 4;
        sawFlush = true;
        break;
      }
      offset += length === 0 ? 4 : length;
    }
    if (!sawFlush) packStart = body.length;
    const commandLines = packets
      .filter((p) => p.kind === 'data')
      .map((p) => p.payload.toString('utf8'));
    let first = true;
    for (const rawLine of commandLines) {
      let line = rawLine.replace(/\n$/, '');
      if (first) {
        first = false;
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          const caps = line.slice(nul + 1);
          if (caps.split(' ').includes('side-band-64k')) sideband = true;
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    const packBytes = body.subarray(packStart);
    const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
    if (hasUpdates || packBytes.length > 0) {
      try {
        if (packBytes.length === 0) throw new Error('missing packfile');
        const objects = parsePack(packBytes, repo);
        for (const [sha, object] of objects) {
          if (!repo.objects.has(sha)) repo.objects.set(sha, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      const verdict = checkRefUpdate(repo, command);
      if (verdict.ok) applyRefUpdate(repo, command);
      results.push({ ref: command.ref, ok: verdict.ok, reason: verdict.reason });
    }
    if (results.some((result) => result.ok)) {
      repo.pushed_at = FIXED_DATE;
      repo.updated_at = FIXED_DATE;
    }
  } else {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    }
  }

  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat(reportLines.map((line) => pktLine(line)));
  let out: Buffer;
  if (sideband) {
    // report-status inside sideband band 1: the band-1 stream is the whole
    // report pkt-line stream INCLUDING its terminating flush (real git servers
    // send it this way, and git's report reader needs that inner flush to
    // terminate cleanly — without it the reader hits EOF and reports that the
    // remote hung up). The outer stream then ends with its own flush.
    const inner = Buffer.concat([report, FLUSH]);
    const wrapped: Buffer[] = [];
    for (let offset = 0; offset < inner.length; offset += SIDEBAND_CHUNK) {
      const chunk = inner.subarray(offset, Math.min(inner.length, offset + SIDEBAND_CHUNK));
      wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    out = Buffer.concat([...wrapped, FLUSH]);
  } else {
    out = Buffer.concat([report, FLUSH]);
  }
  sendBytes(res, 200, 'application/x-git-receive-pack-result', out);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/**
 * Handle one request if it is a git smart-HTTP route; returns true when handled
 * (the response is then owned by this module), false otherwise so the caller can
 * fall through to the REST/GraphQL/MCP surface.
 *
 * Routes: GET /{owner}/{repo}.git/info/refs?service=..., POST
 * /{owner}/{repo}.git/git-upload-pack, POST /{owner}/{repo}.git/git-receive-pack.
 * `segments` is accepted for the integrator's calling convention but the request
 * URL is authoritative; the path is re-derived from it.
 */
export function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  segments?: readonly string[],
): boolean {
  let parts: string[];
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    parts = url.pathname.split('/').filter((segment) => segment !== '');
  } catch {
    parts = [...(segments ?? [])];
  }
  if (parts.length < 2 || !parts[1].endsWith('.git')) return false;
  const method = req.method ?? 'GET';
  const isInfoRefs = parts.length >= 4 && parts[2] === 'info' && parts[3] === 'refs' && method === 'GET';
  const isUploadPack = parts.length === 3 && parts[2] === 'git-upload-pack' && method === 'POST';
  const isReceivePack = parts.length === 3 && parts[2] === 'git-receive-pack' && method === 'POST';
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;

  const owner = decodeURIComponent(parts[0]);
  const name = decodeURIComponent(parts[1].slice(0, -'.git'.length));
  const task = isInfoRefs
    ? handleInfoRefs(req, res, store, owner, name)
    : isUploadPack
      ? handleUploadPack(req, res, store, owner, name)
      : handleReceivePack(req, res, store, owner, name);
  task.catch((err: unknown) => {
    try {
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } else if (!res.writableEnded) {
        res.end();
      }
    } catch {
      // The socket is already gone; nothing left to do.
    }
  });
  return true;
}
