// Self-test for store.ts + git.ts: spins up an http server with handleGit, then
// drives it with a REAL git CLI client (git exists on this machine for testing
// only; the entry itself never calls it) plus raw-protocol fetches.
// Usage: node --experimental-strip-types test-git.mjs
// Prints one PASS/FAIL line per case; exits non-zero if any case fails.

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { handleGit } from './git.ts';

process.env.MAKEFUN_SHOP_TOKEN = 'test-token-123';
const TOKEN = 'test-token-123';
const OWNER = 'adaiversen';
const NODE = process.execPath;

const tmp = mkdtempSync(join(tmpdir(), 'git-forge-test-'));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
}

const store = new Store();
store.createRepo(OWNER, 'demo', 'demo repo');
store.createRepo(OWNER, 'empty', 'empty repo');

const server = createServer((req, res) => {
  if (handleGit(req, res, store)) return;
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not Found' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const remote = `${base}/${OWNER}/demo.git`;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'a@example.invalid',
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'a@example.invalid',
  GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  HOME: join(tmp, 'home'),
};
mkdirSync(gitEnv.HOME, { recursive: true });

// Async on purpose: the test server runs in this same process, so a blocking
// execFileSync would starve the event loop and deadlock against the git client
// waiting for the server to answer.
async function git(args, cwd, extraEnv = {}) {
  const { stdout } = await execFileAsync(
    'git', ['-c', `http.extraHeader=Authorization: Bearer ${TOKEN}`, ...args],
    { cwd, env: { ...gitEnv, ...extraEnv }, encoding: 'utf8', timeout: 30000 },
  );
  return stdout;
}
async function gitMayFail(args, cwd, extraEnv = {}) {
  try {
    return { ok: true, out: await git(args, cwd, extraEnv) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}` };
  }
}

// --- pkt-line helpers for the raw-protocol fetch (case 4) ---
function parsePktLines(buf) {
  const packets = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = Number.parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return packets;
}
function pkt(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
async function rawFetchV2(wants, haves) {
  const lines = [
    pkt('command=fetch\n'), pkt('agent=test/1.0\n'), pkt('object-format=sha1\n'),
    Buffer.from('0001', 'ascii'),
    pkt('thin-pack\n'), pkt('no-progress\n'), pkt('ofs-delta\n'),
    ...wants.map((w) => pkt(`want ${w}\n`)),
    ...haves.map((h) => pkt(`have ${h}\n`)),
    pkt('done\n'), Buffer.from('0000', 'ascii'),
  ];
  const res = await fetch(`${remote}/git-upload-pack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-git-upload-pack-request',
      Accept: 'application/x-git-upload-pack-result',
      'Git-Protocol': 'version=2',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: Buffer.concat(lines),
  });
  const body = Buffer.from(await res.arrayBuffer());
  const packets = parsePktLines(body);
  let section = '';
  const packChunks = [];
  for (const p of packets) {
    if (p.kind !== 'data') { section = ''; continue; }
    if (section === '') {
      const text = p.payload.toString('utf8');
      if (text === 'packfile\n') section = 'packfile';
      continue;
    }
    if (section === 'packfile' && p.payload[0] === 1) packChunks.push(p.payload.subarray(1));
  }
  const pack = packChunks.length ? Buffer.concat(packChunks) : null;
  if (!pack) return { count: 0, pack: null };
  const trailerOk = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex')
    === pack.subarray(pack.length - 20).toString('hex');
  return { count: pack.readUInt32BE(8), pack, trailerOk };
}

try {
  // --- Case 1: push a 3-commit history from a real git client ---
  const src = join(tmp, 'src');
  mkdirSync(src, { recursive: true });
  await git(['init', '-b', 'main', '.'], src);
  writeFileSync(join(src, 'README.md'), '# demo\n');
  writeFileSync(join(src, 'a.txt'), 'alpha\n');
  await git(['add', '.'], src);
  await git(['commit', '-m', 'first'], src);
  writeFileSync(join(src, 'a.txt'), 'alpha\nbeta\n');
  writeFileSync(join(src, 'b.txt'), 'bee\n');
  await git(['add', '.'], src);
  await git(['commit', '-m', 'second'], src);
  writeFileSync(join(src, 'a.txt'), 'alpha\nbeta\ngamma\n');
  await git(['add', '.'], src);
  await git(['commit', '-m', 'third'], src);
  const tip1 = (await git(['rev-parse', 'HEAD'], src)).trim();
  const log1 = (await git(['log', '--format=%H'], src)).trim().split('\n');
  const push = await gitMayFail(['push', remote, 'main'], src);
  const lsRemote = (await git(['ls-remote', remote, 'refs/heads/main'], src)).trim().split(/\s+/)[0];
  check('push-3-commits', push.ok && lsRemote === tip1, push.out.slice(0, 300));
  const repo = store.getRepo(OWNER, 'demo');
  check('push-objects-stored', repo.branches.get('main') === tip1 && repo.objects.has(tip1),
    `branch=${repo.branches.get('main')} tip=${tip1} objects=${repo.objects.size}`);

  // --- Case 2: clone back (full + shallow), verify contents and log ---
  const full = join(tmp, 'full');
  const cloneFull = await gitMayFail(['clone', remote, full], tmp);
  const fullLog = cloneFull.ok ? (await git(['log', '--format=%H'], full)).trim().split('\n') : [];
  const fullContent = cloneFull.ok ? readFileSync(join(full, 'a.txt'), 'utf8') : '';
  check('clone-full', cloneFull.ok && JSON.stringify(fullLog) === JSON.stringify(log1)
    && fullContent === 'alpha\nbeta\ngamma\n', cloneFull.out.slice(0, 300));
  const shallow = join(tmp, 'shallow');
  const cloneShallow = await gitMayFail(['clone', '--depth', '1', remote, shallow], tmp);
  let shallowOk = false;
  if (cloneShallow.ok) {
    const sLog = (await git(['log', '--format=%H'], shallow)).trim().split('\n');
    const isShallow = (await git(['rev-parse', '--is-shallow-repository'], shallow)).trim() === 'true';
    shallowOk = sLog.length === 1 && sLog[0] === tip1 && isShallow
      && readFileSync(join(shallow, 'a.txt'), 'utf8') === 'alpha\nbeta\ngamma\n';
  }
  check('clone-shallow-depth1', shallowOk, cloneShallow.out.slice(0, 300));

  // --- Case 3: non-fast-forward push is refused and the ref does not move ---
  const ff = join(tmp, 'ff');
  await git(['clone', remote, ff], tmp);
  await git(['reset', '--hard', 'HEAD~1'], ff);
  writeFileSync(join(ff, 'a.txt'), 'divergent\n');
  await git(['add', '.'], ff);
  await git(['commit', '-m', 'divergent'], ff);
  const refused = await gitMayFail(['push', remote, 'main'], ff);
  const lsAfter = (await git(['ls-remote', remote, 'refs/heads/main'], tmp)).trim().split(/\s+/)[0];
  check('push-non-fast-forward-refused',
    !refused.ok && /non-fast-forward/i.test(refused.out) && lsAfter === tip1,
    `pushOk=${refused.ok} lsAfter=${lsAfter} tip=${tip1} out=${refused.out.slice(0, 200)}`);

  // --- Case 4: fetch with haves transfers only new objects ---
  writeFileSync(join(src, 'a.txt'), 'alpha\nbeta\ngamma\ndelta\n');
  await git(['add', '.'], src);
  await git(['commit', '-m', 'fourth'], src);
  const tip2 = (await git(['rev-parse', 'HEAD'], src)).trim();
  const push2 = await gitMayFail(['push', remote, 'main'], src);
  check('push-4th-commit', push2.ok, push2.out.slice(0, 200));
  const fetchCli = await gitMayFail(['fetch', 'origin'], full);
  const fetchedLog = fetchCli.ok ? (await git(['log', '--format=%H', 'origin/main'], full)).trim().split('\n') : [];
  check('fetch-via-git-cli', fetchCli.ok && fetchedLog[0] === tip2, fetchCli.out.slice(0, 200));
  // Raw v2 fetch: want tip2, have tip1 -> exactly the new commit + tree + blob.
  const raw = await rawFetchV2([tip2], [tip1]);
  check('fetch-haves-only-new-objects', raw.count === 3 && raw.trailerOk === true,
    `pack object count=${raw.count} (expected 3), trailerOk=${raw.trailerOk}`);
  // Raw v2 fetch with nothing new -> empty pack.
  const rawEmpty = await rawFetchV2([tip2], [tip2]);
  check('fetch-nothing-new', rawEmpty.count === 0 && rawEmpty.pack === null,
    `pack object count=${rawEmpty.count}`);

  // --- Case 5: missing repo 404, missing/wrong token 401 ---
  const r404 = await fetch(`${base}/${OWNER}/nope.git/info/refs?service=git-upload-pack`,
    { headers: { Authorization: `Bearer ${TOKEN}` } });
  const r401a = await fetch(`${remote}/info/refs?service=git-upload-pack`);
  const r401b = await fetch(`${remote}/info/refs?service=git-upload-pack`,
    { headers: { Authorization: 'Bearer wrong' } });
  const r404recv = await fetch(`${base}/${OWNER}/nope.git/info/refs?service=git-receive-pack`,
    { headers: { Authorization: `Bearer ${TOKEN}` } });
  check('missing-repo-404', r404.status === 404 && r404recv.status === 404,
    `upload=${r404.status} receive=${r404recv.status}`);
  check('auth-401', r401a.status === 401 && r401b.status === 401,
    `no-token=${r401a.status} wrong-token=${r401b.status}`);

  // --- Extra: empty repo clones; annotated tag round-trips ---
  const emptyClone = await gitMayFail(['clone', `${base}/${OWNER}/empty.git`, join(tmp, 'empty-clone')], tmp);
  check('clone-empty-repo', emptyClone.ok, emptyClone.out.slice(0, 200));
  await git(['tag', '-a', 'v1', '-m', 'version 1'], src);
  const pushTag = await gitMayFail(['push', remote, 'v1'], src);
  const tagged = join(tmp, 'tagged');
  const cloneTag = await gitMayFail(['clone', remote, tagged], tmp);
  let tagOk = false;
  if (pushTag.ok && cloneTag.ok) {
    const cat = await git(['cat-file', '-p', 'v1'], tagged);
    const peeled = (await git(['rev-list', '-n', '1', 'v1'], tagged)).trim();
    tagOk = /tag v1/.test(cat) && peeled === tip2;
  }
  check('annotated-tag-roundtrip', tagOk, `pushTag=${pushTag.ok} cloneTag=${cloneTag.ok}`);
} catch (err) {
  check('harness-error', false, err instanceof Error ? err.message : String(err));
} finally {
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`---\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
