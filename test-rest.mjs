// Self-test for rest.ts: starts an http server wired to handleRest + a store and
// exercises the REST v3 surface with fetch. Prints PASS/FAIL per case and exits
// non-zero on any FAIL.
//
// Store used: the real ./store.ts when it exists, otherwise a minimal in-memory
// stub store (the marked section below, copied into a staging dir next to a copy
// of rest.ts so rest.ts's own `import './store.ts'` resolves). Run with Node 22:
//   node --experimental-strip-types test-rest.mjs
// The token is fixed here (MAKEFUN_SHOP_TOKEN=secret-token) so the 401 cases work.

import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// __STUB_BEGIN__
import { createHash } from 'node:crypto';
export const FIXED_DATE = '2025-01-01T00:00:00Z';
let __reqCounter = 0;
export function nextRequestId() { __reqCounter += 1; return 'req-' + String(__reqCounter).padStart(6, '0'); }
export function shopUser() { return { login: 'octocat', id: 1, avatar_url: 'https://example.invalid/octocat.png', html_url: 'https://example.invalid/octocat', type: 'User', site_admin: false }; }
function __sha1(buf) { return createHash('sha1').update(buf).digest('hex'); }
function __gitHash(type, data) { const head = Buffer.from(type + ' ' + String(data.length) + '\0', 'utf8'); return __sha1(Buffer.concat([head, data])); }
function __putObject(repo, type, data) { const sha = __gitHash(type, data); repo.objects.set(sha, { type, data }); return sha; }
function __lines(buf) { const s = buf.toString('utf8'); if (s === '') return []; const parts = s.split('\n'); if (parts[parts.length - 1] === '') parts.pop(); return parts; }
function __lineDiff(oldBuf, newBuf) { const counts = new Map(); for (const l of __lines(oldBuf)) counts.set(l, (counts.get(l) || 0) + 1); let additions = 0; for (const l of __lines(newBuf)) { const c = counts.get(l) || 0; if (c > 0) counts.set(l, c - 1); else additions += 1; } let deletions = 0; for (const c of counts.values()) deletions += c; return { additions, deletions }; }
export function parseTree(data) { const entries = []; let i = 0; while (i < data.length) { const sp = data.indexOf(0x20, i); const mode = data.subarray(i, sp).toString('utf8'); const nul = data.indexOf(0, sp); const name = data.subarray(sp + 1, nul).toString('utf8'); const sha = data.subarray(nul + 1, nul + 21).toString('hex'); entries.push({ mode, name, sha }); i = nul + 21; } return entries; }
export function buildTree(repo, entries) { const sorted = [...entries].sort((a, b) => { const ka = a.name + ((a.mode === '040000' || a.mode === '40000') ? '/' : ''); const kb = b.name + ((b.mode === '040000' || b.mode === '40000') ? '/' : ''); return ka < kb ? -1 : ka > kb ? 1 : 0; }); const parts = []; for (const e of sorted) { parts.push(Buffer.from(e.mode + ' ' + e.name + '\0', 'utf8')); parts.push(Buffer.from(e.sha, 'hex')); } return __putObject(repo, 'tree', Buffer.concat(parts)); }
function __isDir(mode) { return mode === '040000' || mode === '40000'; }
function __flatten(repo, treeSha, prefix, out) { const obj = repo.objects.get(treeSha); if (!obj) return; for (const e of parseTree(obj.data)) { const p = prefix === '' ? e.name : prefix + '/' + e.name; if (__isDir(e.mode)) __flatten(repo, e.sha, p, out); else out.set(p, e.sha); } }
export function diffTrees(repo, baseTreeSha, headTreeSha, prefix) { const base = new Map(); const head = new Map(); __flatten(repo, baseTreeSha, prefix || '', base); __flatten(repo, headTreeSha, prefix || '', head); const names = [...new Set([...base.keys(), ...head.keys()])].sort(); const out = []; for (const name of names) { const b = base.get(name); const h = head.get(name); if (b === h) continue; if (b === undefined) { const n = __lines(repo.objects.get(h).data).length; out.push({ filename: name, status: 'added', additions: n, deletions: 0, changes: n }); } else if (h === undefined) { const n = __lines(repo.objects.get(b).data).length; out.push({ filename: name, status: 'removed', additions: 0, deletions: n, changes: n }); } else { const d = __lineDiff(repo.objects.get(b).data, repo.objects.get(h).data); out.push({ filename: name, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions }); } } return out; }
export function treeAtCommit(repo, commitSha) { const obj = repo.objects.get(commitSha); if (!obj || obj.type !== 'commit') throw new Error('not a commit: ' + commitSha); for (const line of obj.data.toString('utf8').split('\n')) { if (line.startsWith('tree ')) return line.slice(5).trim(); } throw new Error('commit has no tree: ' + commitSha); }
export function getFileAt(repo, commitSha, filePath) { const parts = filePath.split('/').filter((p) => p !== ''); let treeSha = treeAtCommit(repo, commitSha); for (let i = 0; i < parts.length; i += 1) { const entries = parseTree(repo.objects.get(treeSha).data); const entry = entries.find((e) => e.name === parts[i]); if (!entry) return undefined; if (i === parts.length - 1) { if (__isDir(entry.mode)) return undefined; const blob = repo.objects.get(entry.sha); if (!blob) return undefined; return { blobSha: entry.sha, content: blob.data }; } if (!__isDir(entry.mode)) return undefined; treeSha = entry.sha; } return undefined; }
export class Store {
  constructor() { this.repos = new Map(); this.nextRepoId = 1; }
  getRepo(owner, name) { return this.repos.get(owner + '/' + name); }
  createRepo(ownerLogin, name, description) { const owner = shopUser().login === ownerLogin ? shopUser() : { login: ownerLogin, id: 1, avatar_url: '', html_url: '', type: 'User', site_admin: false }; const repo = { id: this.nextRepoId, name, full_name: ownerLogin + '/' + name, owner, description, default_branch: 'main', private: false, fork: false, has_issues: true, branches: new Map(), objects: new Map(), issues: [], pulls: [], labels: [], nextIssue: 1, nextPull: 1, nextLabelId: 1, nextCommentId: 1, created_at: FIXED_DATE, updated_at: FIXED_DATE, pushed_at: FIXED_DATE }; this.nextRepoId += 1; this.repos.set(repo.full_name, repo); return repo; }
  deleteRepo(owner, name) { return this.repos.delete(owner + '/' + name); }
  putObject(repo, type, data) { return __putObject(repo, type, data); }
  getObject(repo, sha) { return repo.objects.get(sha); }
  makeCommit(repo, treeSha, parents, message, author) { const lines = ['tree ' + treeSha]; for (const p of parents) lines.push('parent ' + p); lines.push('author ' + author.name + ' <' + author.email + '> 1735689600 +0000'); lines.push('committer ' + author.name + ' <' + author.email + '> 1735689600 +0000'); const data = Buffer.from(lines.join('\n') + '\n\n' + message + '\n', 'utf8'); const sha = __putObject(repo, 'commit', data); return { sha, tree: treeSha, parents: [...parents], message, authorName: author.name, authorEmail: author.email, committerName: author.name, committerEmail: author.email }; }
}
// __STUB_END__

process.env.MAKEFUN_SHOP_TOKEN = 'secret-token';
const TOKEN = 'secret-token';
const SHA40 = /^[0-9a-f]{40}$/;

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ' — ' + detail}`);
}

async function main() {
  // ---- load handleRest + a store (real store.ts when present, else stub staging)
  let handleRest;
  let store;
  let OWNER;
  let usingRealStore = false;
  const hasRealStore = fs.existsSync(new URL('./store.ts', import.meta.url));
  if (hasRealStore) {
    const restMod = await import('./rest.ts');
    const storeMod = await import('./store.ts');
    handleRest = restMod.handleRest;
    store = new storeMod.Store();
    OWNER = storeMod.shopUser().login;
    usingRealStore = true;
  } else {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-test-'));
    fs.copyFileSync(new URL('./rest.ts', import.meta.url), path.join(stage, 'rest.ts'));
    const own = fs.readFileSync(new URL(import.meta.url), 'utf8');
    const begin = own.indexOf('// __STUB_BEGIN__');
    const end = own.indexOf('// __STUB_END__');
    const stubLines = own.slice(begin, end).split('\n').slice(1).join('\n');
    fs.writeFileSync(path.join(stage, 'store.ts'), stubLines);
    const restMod = await import(pathToFileURL(path.join(stage, 'rest.ts')).href);
    handleRest = restMod.handleRest;
    store = new Store();
    OWNER = shopUser().login;
  }
  console.log(`using ${usingRealStore ? 'real' : 'stub'} store; owner=${OWNER}`);

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const segs = u.pathname.split('/').filter((s) => s !== '');
      const handled = await handleRest(req, res, store, segs);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json', 'x-github-request-id': 'test-fallback' });
        res.end(JSON.stringify({ message: 'Not Found' }));
      }
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: String(e && e.message ? e.message : e) }));
    }
  });
  await new Promise((r) => server.listen(0, r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  const headerProblems = [];
  async function req(method, p, opts = {}) {
    const headers = {};
    if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
    if (opts.raw !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + p, {
      method,
      headers,
      body: opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    const rid = res.headers.get('x-github-request-id');
    const ct = res.headers.get('content-type') ?? '';
    if (!rid) headerProblems.push(`${method} ${p}: missing X-GitHub-Request-Id`);
    if (!ct.includes('application/json')) headerProblems.push(`${method} ${p}: content-type=${ct}`);
    if (text.trim().startsWith('<')) headerProblems.push(`${method} ${p}: HTML body`);
    return { status: res.status, headers: res.headers, text, json };
  }
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const unb64 = (s) => Buffer.from(s.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
  const repoPath = (name = 'demo') => `/api/v3/repos/${OWNER}/${name}`;

  // ---- auth / meta / user
  let r = await req('GET', '/api/v3/user', { token: null });
  check('no token -> 401', r.status === 401 && r.json && typeof r.json.message === 'string', `status=${r.status} body=${r.text}`);
  r = await req('GET', '/api/v3/user', { token: 'wrong-token' });
  check('wrong token -> 401', r.status === 401, `status=${r.status}`);
  r = await req('GET', '/api/v3/user');
  check('GET /user -> 200 token user', r.status === 200 && r.json && r.json.login === OWNER, `status=${r.status} body=${r.text}`);
  r = await req('GET', '/api/v3/meta');
  check('GET /meta -> installed_version', r.status === 200 && r.json && typeof r.json.installed_version === 'string' && r.json.installed_version !== '', `status=${r.status} body=${r.text}`);
  r = await req('GET', '/api/v3/rate_limit');
  check('GET /rate_limit -> reset is fixed epoch', r.status === 200 && r.json && r.json.resources && r.json.resources.core && r.json.resources.core.reset === 1735689600, `status=${r.status} body=${r.text}`);

  // ---- repo create
  r = await req('POST', '/api/v3/user/repos', { body: { description: 'x' } });
  check('create repo missing name -> 422', r.status === 422, `status=${r.status}`);
  r = await req('POST', '/api/v3/user/repos', { body: { name: 'demo', description: 'demo repo', private: true } });
  check('create repo -> 201', r.status === 201 && r.json && r.json.name === 'demo' && r.json.full_name === `${OWNER}/demo` && r.json.private === true && r.json.default_branch === 'main', `status=${r.status} body=${r.text}`);
  r = await req('POST', '/api/v3/user/repos', { body: { name: 'demo' } });
  check('duplicate repo -> 422', r.status === 422, `status=${r.status}`);
  r = await req('GET', repoPath());
  check('get repo -> 200 matching fields', r.status === 200 && r.json && r.json.name === 'demo' && r.json.description === 'demo repo' && r.json.owner && r.json.owner.login === OWNER, `status=${r.status} body=${r.text}`);
  r = await req('GET', `/api/v3/repos/someone-else/demo`);
  check('foreign owner repo -> 404', r.status === 404, `status=${r.status}`);
  r = await req('GET', `/api/v3/repos/${OWNER}/no-such-repo`);
  check('missing repo -> 404 JSON', r.status === 404 && r.json && typeof r.json.message === 'string', `status=${r.status}`);
  r = await req('PATCH', repoPath(), { body: { description: 'updated desc' } });
  check('patch description -> 200', r.status === 200 && r.json && r.json.description === 'updated desc', `status=${r.status} body=${r.text}`);

  // ---- pagination over /user/repos
  for (const n of ['pg-1', 'pg-2', 'pg-3']) {
    const c = await req('POST', '/api/v3/user/repos', { body: { name: n } });
    if (c.status !== 201) check(`create ${n} for pagination`, false, `status=${c.status}`);
  }
  r = await req('GET', '/api/v3/user/repos?per_page=2');
  const linkHasNext = (r.headers.get('link') ?? '').includes('rel="next"');
  check('user/repos page 1 has Link next', r.status === 200 && Array.isArray(r.json) && r.json.length === 2 && linkHasNext, `status=${r.status} link=${r.headers.get('link')} n=${Array.isArray(r.json) ? r.json.length : '?'}`);
  {
    const seen = [];
    let next = `${BASE}/api/v3/user/repos?per_page=2`;
    let guard = 0;
    while (next && guard < 10) {
      guard += 1;
      const page = await fetch(next, { headers: { authorization: 'Bearer ' + TOKEN } });
      const items = await page.json();
      seen.push(...items.map((i) => i.name));
      const m = /<([^>]*)>;\s*rel="next"/.exec(page.headers.get('link') ?? '');
      next = m ? m[1] : null;
    }
    const uniq = new Set(seen);
    check('pagination walks all repos without dupes', seen.length === 4 && uniq.size === 4 && ['demo', 'pg-1', 'pg-2', 'pg-3'].every((n) => uniq.has(n)), `seen=${JSON.stringify(seen)}`);
  }

  // ---- contents: create nested file, read, dir listing, update, stale sha
  r = await req('PUT', `${repoPath()}/contents/docs/readme.md`, { body: { message: 'add readme', content: b64('hello world\n') } });
  check('contents PUT create -> 201', r.status === 201 && r.json && r.json.content && SHA40.test(r.json.content.sha) && r.json.commit && SHA40.test(r.json.commit.sha), `status=${r.status} body=${r.text}`);
  const readmeSha = r.json && r.json.content ? r.json.content.sha : '';
  const readmeCommit = r.json && r.json.commit ? r.json.commit.sha : '';
  r = await req('GET', `${repoPath()}/contents/docs/readme.md`);
  check('contents GET file matches', r.status === 200 && r.json && r.json.encoding === 'base64' && unb64(r.json.content) === 'hello world\n' && r.json.sha === readmeSha && r.json.size === 12, `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/contents/docs`);
  check('contents GET directory lists file', r.status === 200 && Array.isArray(r.json) && r.json.some((e) => e.name === 'readme.md' && e.type === 'file'), `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/contents`);
  check('contents GET root lists dir', r.status === 200 && Array.isArray(r.json) && r.json.some((e) => e.name === 'docs' && e.type === 'dir'), `status=${r.status} body=${r.text}`);
  r = await req('PUT', `${repoPath()}/contents/docs/readme.md`, { body: { message: 'update readme', content: b64('hello v2\n'), sha: readmeSha } });
  check('contents PUT update -> 200', r.status === 200 && r.json && r.json.content && r.json.content.sha !== readmeSha, `status=${r.status} body=${r.text}`);
  const readmeSha2 = r.json && r.json.content ? r.json.content.sha : '';
  r = await req('PUT', `${repoPath()}/contents/docs/readme.md`, { body: { message: 'stale', content: b64('stale\n'), sha: readmeSha } });
  check('contents PUT stale sha -> 409', r.status === 409, `status=${r.status}`);
  r = await req('GET', `${repoPath()}/commits/${readmeCommit}`);
  check('GET single commit -> 200 with message', r.status === 200 && r.json && r.json.sha === readmeCommit && r.json.commit && r.json.commit.message === 'add readme', `status=${r.status} body=${r.text}`);

  // ---- branches + git/refs + commits
  r = await req('GET', `${repoPath()}/branches`);
  const mainTip = Array.isArray(r.json) ? (r.json.find((b) => b.name === 'main') || {}).commit?.sha : undefined;
  check('branches list has main', r.status === 200 && typeof mainTip === 'string' && SHA40.test(mainTip), `status=${r.status} body=${r.text}`);
  r = await req('POST', `${repoPath()}/git/refs`, { body: { ref: 'refs/heads/feature', sha: mainTip } });
  check('POST git/refs creates branch -> 201', r.status === 201 && r.json && r.json.ref === 'refs/heads/feature' && r.json.object && r.json.object.sha === mainTip, `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/branches/feature`);
  check('GET single branch -> 200', r.status === 200 && r.json && r.json.name === 'feature' && r.json.commit.sha === mainTip, `status=${r.status} body=${r.text}`);
  r = await req('PUT', `${repoPath()}/contents/feature.txt`, { body: { message: 'feature work', content: b64('feature\n'), branch: 'feature' } });
  const featureCommit = r.json && r.json.commit ? r.json.commit.sha : '';
  check('contents PUT on branch -> 201', r.status === 201 && SHA40.test(featureCommit), `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/commits?sha=feature`);
  check('commits?sha=feature lists branch commit', r.status === 200 && Array.isArray(r.json) && r.json.some((c) => c.sha === featureCommit), `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/commits`);
  check('commits (default) excludes branch-only commit', r.status === 200 && Array.isArray(r.json) && !r.json.some((c) => c.sha === featureCommit) && r.json.length >= 1, `status=${r.status} body=${r.text}`);

  // ---- labels + issues + comments
  r = await req('POST', `${repoPath()}/labels`, { body: { name: 'test-label', color: 'd73a4a' } });
  check('label POST -> 201', r.status === 201 && r.json && r.json.name === 'test-label' && r.json.id >= 1, `status=${r.status} body=${r.text}`);
  r = await req('POST', `${repoPath()}/labels`, { body: { name: 'bug', color: 'd73a4a' } });
  check('label POST seeded default bug -> 201 idempotent', r.status === 201 && r.json && r.json.name === 'bug', `status=${r.status} body=${r.text}`);
  r = await req('POST', `${repoPath()}/labels`, { body: { name: 'test-label', color: 'd73a4a' } });
  check('duplicate label -> 201 idempotent', r.status === 201 && r.json && r.json.name === 'test-label', `status=${r.status}`);
  r = await req('GET', `${repoPath()}/labels`);
  check('labels GET lists bug + test-label', r.status === 200 && Array.isArray(r.json) && r.json.some((l) => l.name === 'bug') && r.json.some((l) => l.name === 'test-label'), `status=${r.status} body=${r.text}`);
  r = await req('POST', `${repoPath()}/issues`, { body: { title: 'bad', body: 'b', labels: ['no-such-label'] } });
  check('issue with unknown label -> 422', r.status === 422, `status=${r.status}`);
  r = await req('POST', `${repoPath()}/issues`, { body: { title: 'First issue', body: 'body one', labels: ['bug'] } });
  check('issue POST known label -> 201 number 1', r.status === 201 && r.json && r.json.number === 1 && r.json.state === 'open' && r.json.labels && r.json.labels.some((l) => l.name === 'bug'), `status=${r.status} body=${r.text}`);
  r = await req('POST', `${repoPath()}/issues`, { body: { title: 'Second issue', body: 'body two' } });
  check('second issue -> number 2', r.status === 201 && r.json && r.json.number === 2, `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/issues?state=open&sort=created&direction=asc&per_page=100`);
  check('issues sort asc -> [1,2]', r.status === 200 && Array.isArray(r.json) && JSON.stringify(r.json.map((i) => i.number)) === '[1,2]', `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/issues?state=open&sort=created&direction=desc&per_page=100`);
  check('issues sort desc -> [2,1]', r.status === 200 && Array.isArray(r.json) && JSON.stringify(r.json.map((i) => i.number)) === '[2,1]', `status=${r.status} body=${r.text}`);
  r = await req('PATCH', `${repoPath()}/issues/1`, { body: { state: 'closed' } });
  check('issue PATCH close -> 200', r.status === 200 && r.json && r.json.state === 'closed', `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/issues/1`);
  check('issue GET after close persists', r.status === 200 && r.json && r.json.state === 'closed', `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/issues?state=open&per_page=100`);
  check('issues?state=open excludes closed', r.status === 200 && Array.isArray(r.json) && r.json.every((i) => i.state === 'open') && r.json.some((i) => i.number === 2), `status=${r.status} body=${r.text}`);
  r = await req('POST', `${repoPath()}/issues/2/comments`, { body: { body: 'a comment' } });
  const commentId = r.json && r.json.id;
  check('comment POST -> 201', r.status === 201 && r.json && r.json.body === 'a comment' && typeof commentId === 'number', `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/issues/2/comments`);
  check('comments GET lists it', r.status === 200 && Array.isArray(r.json) && r.json.some((c) => c.id === commentId && c.body === 'a comment'), `status=${r.status} body=${r.text}`);

  // ---- pulls: create, files, merge, conflict
  r = await req('GET', `${repoPath()}/branches`);
  const mainTip2 = (r.json.find((b) => b.name === 'main') || {}).commit?.sha;
  r = await req('POST', `${repoPath()}/git/refs`, { body: { ref: 'refs/heads/feature2', sha: mainTip2 } });
  check('create feature2 branch', r.status === 201, `status=${r.status}`);
  r = await req('PUT', `${repoPath()}/contents/pr-file.txt`, { body: { message: 'pr change', content: b64('pr change\n'), branch: 'feature2' } });
  check('commit on feature2', r.status === 201, `status=${r.status}`);
  r = await req('GET', `${repoPath()}/branches`);
  const f2Tip = (r.json.find((b) => b.name === 'feature2') || {}).commit?.sha;
  r = await req('POST', `${repoPath()}/pulls`, { body: { title: 'PR one', head: 'feature2', base: 'main', body: 'pr body' } });
  check('pull POST -> 201 open with head/base shas', r.status === 201 && r.json && r.json.number === 1 && r.json.state === 'open' && r.json.head.ref === 'feature2' && r.json.head.sha === f2Tip && r.json.base.ref === 'main' && r.json.base.sha === mainTip2, `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/pulls/1`);
  check('pull GET one -> 200', r.status === 200 && r.json && r.json.number === 1 && r.json.title === 'PR one', `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/pulls/1/files`);
  check('pull files lists change', r.status === 200 && Array.isArray(r.json) && r.json.some((f) => f.filename === 'pr-file.txt' && (f.status === 'added' || f.status === 'modified') && f.additions >= 1), `status=${r.status} body=${r.text}`);
  r = await req('PUT', `${repoPath()}/pulls/1/merge`, { body: { merge_method: 'squash' } });
  const mergeSha = r.json && r.json.sha;
  check('pull merge -> 200 merged:true', r.status === 200 && r.json && r.json.merged === true && SHA40.test(mergeSha || '') && typeof r.json.message === 'string', `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/pulls/1`);
  check('pull GET after merge -> closed+merged', r.status === 200 && r.json && r.json.state === 'closed' && r.json.merged === true && r.json.merge_commit_sha === mergeSha && typeof r.json.merged_at === 'string', `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/contents/pr-file.txt?ref=main`);
  check('merged content on default branch', r.status === 200 && r.json && unb64(r.json.content) === 'pr change\n', `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/commits?sha=main`);
  check('merge commit on default branch', r.status === 200 && Array.isArray(r.json) && r.json.some((c) => c.sha === mergeSha), `status=${r.status} body=${r.text}`);

  // conflict: two branches edit the same file differently; merge first, second -> 405
  r = await req('GET', `${repoPath()}/branches`);
  const mainTip3 = (r.json.find((b) => b.name === 'main') || {}).commit?.sha;
  await req('POST', `${repoPath()}/git/refs`, { body: { ref: 'refs/heads/c-a', sha: mainTip3 } });
  await req('POST', `${repoPath()}/git/refs`, { body: { ref: 'refs/heads/c-b', sha: mainTip3 } });
  const cur = await req('GET', `${repoPath()}/contents/docs/readme.md?ref=c-a`);
  const curSha = cur.json && cur.json.sha;
  r = await req('PUT', `${repoPath()}/contents/docs/readme.md`, { body: { message: 'a', content: b64('version a\n'), sha: curSha, branch: 'c-a' } });
  check('conflict setup: commit on c-a', r.status === 200 || r.status === 201, `status=${r.status}`);
  r = await req('PUT', `${repoPath()}/contents/docs/readme.md`, { body: { message: 'b', content: b64('version b\n'), sha: curSha, branch: 'c-b' } });
  check('conflict setup: commit on c-b', r.status === 200 || r.status === 201, `status=${r.status}`);
  const pa = await req('POST', `${repoPath()}/pulls`, { body: { title: 'A', head: 'c-a', base: 'main' } });
  const pb = await req('POST', `${repoPath()}/pulls`, { body: { title: 'B', head: 'c-b', base: 'main' } });
  const numA = pa.json && pa.json.number;
  const numB = pb.json && pb.json.number;
  check('conflict setup: two PRs created', pa.status === 201 && pb.status === 201 && typeof numA === 'number' && typeof numB === 'number', `a=${pa.status} b=${pb.status}`);
  r = await req('PUT', `${repoPath()}/pulls/${numA}/merge`, { body: { merge_method: 'squash' } });
  check('merge first conflicting PR -> 200', r.status === 200 && r.json && r.json.merged === true, `status=${r.status}`);
  r = await req('PUT', `${repoPath()}/pulls/${numB}/merge`, { body: { merge_method: 'squash' } });
  check('merge conflicted PR -> 405', r.status === 405, `status=${r.status}`);
  r = await req('PUT', `${repoPath()}/pulls/999999/merge`, { body: { merge_method: 'squash' } });
  check('merge unknown PR -> 404', r.status === 404, `status=${r.status}`);
  r = await req('GET', `${repoPath()}/pulls/999999`);
  check('GET unknown PR -> 404', r.status === 404, `status=${r.status}`);
  r = await req('GET', `${repoPath()}/pulls?state=all&per_page=100`);
  check('pulls?state=all lists open+merged', r.status === 200 && Array.isArray(r.json) && r.json.some((p) => p.number === 1) && r.json.some((p) => p.number === numB), `status=${r.status} body=${r.text}`);

  // ---- contents DELETE, repo DELETE, protocol
  const del = await req('GET', `${repoPath()}/contents/feature.txt?ref=feature`);
  r = await req('DELETE', `${repoPath()}/contents/feature.txt?branch=feature`, { body: { message: 'remove', sha: del.json && del.json.sha } });
  // NOTE: branch is a body field, not a query param; retry with the body form if needed.
  if (r.status === 404) {
    r = await req('DELETE', `${repoPath()}/contents/feature.txt`, { body: { message: 'remove', sha: del.json && del.json.sha, branch: 'feature' } });
  }
  check('contents DELETE -> 200 commit sha', r.status === 200 && r.json && r.json.commit && SHA40.test(r.json.commit.sha), `status=${r.status} body=${r.text}`);
  r = await req('GET', `${repoPath()}/contents/feature.txt?ref=feature`);
  check('contents GET after DELETE -> 404', r.status === 404, `status=${r.status}`);
  r = await req('POST', '/api/v3/user/repos', { raw: '{"name":' });
  check('malformed JSON -> 400', r.status === 400 && r.json && typeof r.json.message === 'string', `status=${r.status} body=${r.text}`);
  r = await req('GET', '/api/v3/no-such-route');
  check('unknown route -> 404 JSON', r.status === 404 && r.json && typeof r.json.message === 'string', `status=${r.status} body=${r.text}`);
  r = await req('DELETE', repoPath());
  check('repo DELETE -> 204', r.status === 204, `status=${r.status}`);
  r = await req('GET', repoPath());
  check('repo GET after DELETE -> 404', r.status === 404, `status=${r.status}`);

  check('every reply: X-GitHub-Request-Id + JSON content-type, no HTML', headerProblems.length === 0, headerProblems.slice(0, 5).join(' | '));

  server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${usingRealStore ? ' (real store)' : ' (stub store)'}`);
  if (failed.length > 0) {
    console.log('FAILURES:');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FAIL test harness crashed:', e);
  process.exit(1);
});
