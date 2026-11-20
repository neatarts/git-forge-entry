// Self-test for graphql.ts + mcp.ts.
// Starts an http server with the handlers + a store (the real ./store.ts when it exists,
// else a minimal in-memory stub implementing the store interface, built in a temp dir),
// exercises GraphQL + MCP cases with fetch, prints PASS/FAIL per case, exits non-zero
// on any FAIL.
//
// Run with the Node 22 binary from the entry dir:
//   ~/workspace/makefun/node-v22.23.4-linux-x64/bin/node --experimental-strip-types test-gql-mcp.mjs

import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.MAKEFUN_SHOP_TOKEN = 'test-token-123';
const TOKEN = 'test-token-123';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Minimal stub store (used only when ./store.ts does not exist yet).
// Written without template literals / ${} so it can live inside a JS string.
// ---------------------------------------------------------------------------
const STUB_STORE_TS = [
  "import { createHash } from 'node:crypto';",
  "export const FIXED_DATE = '2025-01-01T00:00:00Z';",
  "export function shopUser() { return { login: 'shop-owner', id: 1, avatar_url: 'https://example.com/avatars/shop-owner', html_url: 'https://example.com/shop-owner', type: 'User', site_admin: true }; }",
  "let reqN = 0;",
  "export function nextRequestId() { reqN += 1; return 'req-' + reqN; }",
  "function sha1(buf) { return createHash('sha1').update(buf).digest('hex'); }",
  "function objSha(type, data) { const head = Buffer.from(type + ' ' + data.length + '\\0'); return sha1(Buffer.concat([head, data])); }",
  "function parseTree(data) {",
  "  const entries = [];",
  "  let i = 0;",
  "  while (i < data.length) {",
  "    const sp = data.indexOf(32, i);",
  "    const mode = data.subarray(i, sp).toString('utf8');",
  "    const nul = data.indexOf(0, sp);",
  "    const name = data.subarray(sp + 1, nul).toString('utf8');",
  "    const sha = data.subarray(nul + 1, nul + 21).toString('hex');",
  "    entries.push({ mode, name, sha });",
  "    i = nul + 21;",
  "  }",
  "  return entries;",
  "}",
  "function flatten(repo, treeSha, prefix, out) {",
  "  const obj = repo.objects.get(treeSha);",
  "  if (!obj || obj.type !== 'tree') return;",
  "  for (const e of parseTree(obj.data)) {",
  "    const p = prefix ? prefix + '/' + e.name : e.name;",
  "    if (e.mode === '40000') flatten(repo, e.sha, p, out);",
  "    else out.set(p, e.sha);",
  "  }",
  "}",
  "function lineCount(repo, sha) {",
  "  const obj = repo.objects.get(sha);",
  "  if (!obj) return 0;",
  "  const s = obj.data.toString('utf8');",
  "  if (s === '') return 0;",
  "  return s.split('\\n').filter(function (l) { return l.length > 0; }).length;",
  "}",
  "export function diffTrees(repo, baseTreeSha, headTreeSha, prefix) {",
  "  const base = new Map(); const head = new Map();",
  "  flatten(repo, baseTreeSha, '', base); flatten(repo, headTreeSha, '', head);",
  "  const out = [];",
  "  for (const [p, sha] of head) {",
  "    if (!base.has(p)) out.push({ filename: p, status: 'added', additions: lineCount(repo, sha), deletions: 0, changes: lineCount(repo, sha) });",
  "    else if (base.get(p) !== sha) out.push({ filename: p, status: 'modified', additions: 1, deletions: 1, changes: 2 });",
  "  }",
  "  for (const [p, sha] of base) {",
  "    if (!head.has(p)) out.push({ filename: p, status: 'removed', additions: 0, deletions: lineCount(repo, sha), changes: lineCount(repo, sha) });",
  "  }",
  "  out.sort(function (a, b) { return a.filename < b.filename ? -1 : 1; });",
  "  return out;",
  "}",
  "export function treeAtCommit(repo, commitSha) {",
  "  const obj = repo.objects.get(commitSha);",
  "  if (!obj || obj.type !== 'commit') throw new Error('not a commit: ' + commitSha);",
  "  const m = obj.data.toString('utf8').match(/^tree ([0-9a-f]{40})$/m);",
  "  if (!m) throw new Error('commit has no tree');",
  "  return m[1];",
  "}",
  "export class Store {",
  "  constructor() { this.repos = new Map(); this.nextRepoId = 1; }",
  "  getRepo(owner, name) { return this.repos.get(owner + '/' + name); }",
  "  createRepo(ownerLogin, name, description) {",
  "    const owner = { login: ownerLogin, id: 1, avatar_url: 'https://example.com/avatars/' + ownerLogin, html_url: 'https://example.com/' + ownerLogin, type: 'User', site_admin: true };",
  "    const id = this.nextRepoId; this.nextRepoId += 1;",
  "    const repo = { id, name, full_name: ownerLogin + '/' + name, owner, description: description || '', default_branch: 'main', private: false, fork: false, has_issues: true, branches: new Map(), objects: new Map(), issues: [], pulls: [], labels: [], nextIssue: 1, nextPull: 1, nextLabelId: 1, nextCommentId: 1, created_at: FIXED_DATE, updated_at: FIXED_DATE, pushed_at: FIXED_DATE };",
  "    this.repos.set(repo.full_name, repo);",
  "    return repo;",
  "  }",
  "  deleteRepo(owner, name) { return this.repos.delete(owner + '/' + name); }",
  "  putObject(repo, type, data) { const sha = objSha(type, data); repo.objects.set(sha, { type, data, sha }); return sha; }",
  "  getObject(repo, sha) { return repo.objects.get(sha); }",
  "  makeCommit(repo, treeSha, parents, message, author) {",
  "    let text = 'tree ' + treeSha + '\\n';",
  "    for (const p of parents) text += 'parent ' + p + '\\n';",
  "    text += 'author ' + author.name + ' <' + author.email + '> 1735689600 +0000\\n';",
  "    text += 'committer ' + author.name + ' <' + author.email + '> 1735689600 +0000\\n\\n' + message + '\\n';",
  "    const sha = this.putObject(repo, 'commit', Buffer.from(text, 'utf8'));",
  "    return { sha, tree: treeSha, parents, message };",
  "  }",
  "}",
].join('\n');

// ---------------------------------------------------------------------------
// Load handlers + store (real store.ts if present, else stub in a temp dir).
// ---------------------------------------------------------------------------
let gqlMod;
let mcpMod;
let storeMod;
let usedStub = false;
if (fs.existsSync(path.join(HERE, 'store.ts'))) {
  gqlMod = await import(pathToFileURL(path.join(HERE, 'graphql.ts')).href);
  mcpMod = await import(pathToFileURL(path.join(HERE, 'mcp.ts')).href);
  storeMod = await import(pathToFileURL(path.join(HERE, 'store.ts')).href);
} else {
  usedStub = true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gql-mcp-test-'));
  fs.copyFileSync(path.join(HERE, 'graphql.ts'), path.join(tmp, 'graphql.ts'));
  fs.copyFileSync(path.join(HERE, 'mcp.ts'), path.join(tmp, 'mcp.ts'));
  fs.writeFileSync(path.join(tmp, 'store.ts'), STUB_STORE_TS);
  gqlMod = await import(pathToFileURL(path.join(tmp, 'graphql.ts')).href);
  mcpMod = await import(pathToFileURL(path.join(tmp, 'mcp.ts')).href);
  storeMod = await import(pathToFileURL(path.join(tmp, 'store.ts')).href);
}

const store = new storeMod.Store();
const owner = storeMod.shopUser().login;

// Fixture repo with a base commit on main and a head branch with one extra file.
const repo = store.createRepo(owner, 'test-repo', 'fixture repo');
function blob(text) { return store.putObject(repo, 'blob', Buffer.from(text, 'utf8')); }
function tree(entries) {
  const parts = [];
  for (const [mode, name, sha] of entries) {
    parts.push(Buffer.from(mode + ' ' + name + '\0', 'utf8'));
    parts.push(Buffer.from(sha, 'hex'));
  }
  return store.putObject(repo, 'tree', Buffer.concat(parts));
}
const baseBlob = blob('hello\n');
const baseTree = tree([['100644', 'README.md', baseBlob]]);
const baseCommit = store.makeCommit(repo, baseTree, [], 'first commit', { name: owner, email: owner + '@example.com' });
repo.branches.set('main', baseCommit.sha);
const headBlob = blob('feature\n');
const headTree = tree([['100644', 'README.md', baseBlob], ['100644', 'feature.txt', headBlob]]);
const headCommit = store.makeCommit(repo, headTree, [baseCommit.sha], 'add feature', { name: owner, email: owner + '@example.com' });
repo.branches.set('feature', headCommit.sha);

// ---------------------------------------------------------------------------
// Server + test harness
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x').pathname;
  if (url === '/api/graphql') { if (await gqlMod.handleGraphql(req, res, store)) return; }
  if (url === '/mcp') { if (await mcpMod.handleMcp(req, res, store)) return; }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not Found' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = 'http://127.0.0.1:' + server.address().port;

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    const ok = await fn();
    if (ok === true) { passed += 1; console.log('PASS ' + name); }
    else { failed += 1; failures.push(name + ': ' + String(ok)); console.log('FAIL ' + name + ' — ' + String(ok)); }
  } catch (err) {
    failed += 1; failures.push(name + ': threw ' + err.message);
    console.log('FAIL ' + name + ' — threw ' + (err && err.message));
  }
}

async function gql(query, variables, token = TOKEN) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + '/api/graphql', { method: 'POST', headers, body: JSON.stringify({ query, variables: variables ?? {} }) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, body, text };
}
async function gqlRaw(body, token = TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + '/api/graphql', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, body: parsed, text };
}

let nextRpcId = 1;
async function mcp(method, params, opts = {}) {
  const id = opts.id ?? ('rpc-' + (nextRpcId++));
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  if (opts.session) headers['mcp-session-id'] = opts.session;
  const payload = { jsonrpc: '2.0', id, method, params: params ?? {} };
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, body, text, headers: res.headers };
}
async function mcpNotify(method, params) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }),
  });
  return { status: res.status, text: await res.text() };
}
function toolText(outcome) {
  const r = outcome.body && outcome.body.result;
  if (!r) return '';
  return (r.content || []).map((b) => b.text || '').join('\n');
}

// ---------------------------------------------------------------------------
// GraphQL cases
// ---------------------------------------------------------------------------
console.log(usedStub ? '(using stub store.ts — real store.ts not present)' : '(using real store.ts)');

let repoGid = '';
let issueNumbers = [];
let prNumber = 0;
let prGid = '';

await check('gql: introspection Issue fields', async () => {
  const r = await gql('query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }');
  if (r.status !== 200) return 'HTTP ' + r.status;
  const names = (r.body.data.Issue.fields || []).map((f) => f.name);
  for (const f of ['id', 'number', 'title', 'state', 'body']) if (!names.includes(f)) return 'missing ' + f;
  return true;
});

await check('gql: introspection PullRequest/Repository/SearchType', async () => {
  const r = await gql('query T { PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } } Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } } }');
  if (r.status !== 200) return 'HTTP ' + r.status;
  const pr = (r.body.data.PullRequest.fields || []).map((f) => f.name);
  const repoNames = (r.body.data.Repository.fields || []).map((f) => f.name);
  for (const f of ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files']) if (!pr.includes(f)) return 'PR missing ' + f;
  for (const f of ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']) if (!repoNames.includes(f)) return 'Repo missing ' + f;
  const s = await gql('query S { SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }');
  const enums = (s.body.data.SearchType.enumValues || []).map((e) => e.name);
  if (!enums.includes('ISSUE')) return 'SearchType missing ISSUE';
  return true;
});

await check('gql: viewer login', async () => {
  const r = await gql('query ViewerLogin { viewer { login } }');
  if (r.status !== 200) return 'HTTP ' + r.status;
  return r.body.data.viewer.login === owner ? true : 'login=' + r.body.data.viewer.login + ' want ' + owner;
});

await check('gql: repository query', async () => {
  const r = await gql(
    'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }',
    { owner, name: 'test-repo' });
  if (r.status !== 200) return 'HTTP ' + r.status;
  const d = r.body.data.repository;
  if (!d) return 'repository null';
  repoGid = d.id;
  if (d.databaseId !== repo.id) return 'databaseId ' + d.databaseId;
  if (d.id === String(repo.id)) return 'id is plain databaseId, not opaque';
  if (d.name !== 'test-repo' || d.owner.login !== owner) return 'name/owner wrong';
  if (d.defaultBranchRef.name !== 'main') return 'defaultBranch ' + JSON.stringify(d.defaultBranchRef);
  if (d.viewerPermission !== 'ADMIN' || d.hasIssuesEnabled !== true) return 'permission/hasIssues wrong';
  return true;
});

await check('gql: unknown repository -> null, no errors', async () => {
  const r = await gql(
    'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id name } }',
    { owner, name: 'no-such-repo' });
  if (r.status !== 200) return 'HTTP ' + r.status;
  if (r.body.data.repository !== null) return 'repository not null';
  if (r.body.errors && r.body.errors.length > 0) return 'errors present';
  return true;
});

await check('gql: createIssue + closeIssue', async () => {
  for (let i = 1; i <= 4; i++) {
    const r = await gql('mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }',
      { input: { repositoryId: repoGid, title: 'gql issue ' + i, body: 'body ' + i } });
    if (r.status !== 200 || (r.body.errors || []).length > 0) return 'createIssue ' + i + ' failed: ' + r.text;
    issueNumbers.push(r.body.data.createIssue.issue.number);
  }
  const closeTarget = issueNumbers[3];
  const idRes = await gql(
    'query IssueByNumber($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id number state } } }',
    { owner, name: 'test-repo', number: closeTarget });
  const issueId = idRes.body.data.repository.issue.id;
  const c = await gql('mutation IssueClose($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number id state } } }',
    { input: { issueId } });
  if (c.body.data.closeIssue.issue.state !== 'CLOSED') return 'close state ' + JSON.stringify(c.body);
  const stored = repo.issues.find((x) => x.number === closeTarget);
  if (!stored || stored.state !== 'closed') return 'store not closed';
  return true;
});

await check('gql: issues OPEN + CREATED_AT DESC order', async () => {
  const r = await gql(
    'query OpenIssues($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state id } } } }',
    { owner, name: 'test-repo', first: 10 });
  if (r.status !== 200 || (r.body.errors || []).length > 0) return 'failed: ' + r.text;
  const nums = r.body.data.repository.issues.nodes.map((n) => n.number);
  if (nums.includes(issueNumbers[3])) return 'closed issue in OPEN list';
  for (let i = 1; i < nums.length; i++) if (nums[i] > nums[i - 1]) return 'out of order: ' + nums.join(',');
  for (let i = 0; i < 3; i++) if (!nums.includes(issueNumbers[i])) return 'missing open #' + issueNumbers[i];
  return true;
});

await check('gql: issues pagination first/after', async () => {
  const q = 'query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }';
  const p1 = await gql(q, { owner, name: 'test-repo', first: 2, after: null });
  const c1 = p1.body.data.repository.issues;
  if (c1.nodes.length !== 2) return 'page1 size ' + c1.nodes.length;
  if (c1.pageInfo.hasNextPage !== true) return 'page1 hasNextPage false';
  if (!c1.pageInfo.endCursor) return 'page1 no endCursor';
  const p2 = await gql(q, { owner, name: 'test-repo', first: 2, after: c1.pageInfo.endCursor });
  const c2 = p2.body.data.repository.issues;
  if (c2.nodes.length !== 2) return 'page2 size ' + c2.nodes.length;
  if (c2.pageInfo.hasNextPage !== false) return 'page2 hasNextPage true';
  const all = [...c1.nodes, ...c2.nodes].map((n) => n.number);
  if (new Set(all).size !== 4) return 'overlap/dup: ' + all.join(',');
  return true;
});

await check('gql: createPullRequest + files + list', async () => {
  const r = await gql('mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number id state headRefName baseRefName } } }',
    { input: { repositoryId: repoGid, baseRefName: 'main', headRefName: 'feature', title: 'gql pr' } });
  if (r.status !== 200 || (r.body.errors || []).length > 0) return 'createPR failed: ' + r.text;
  const pr = r.body.data.createPullRequest.pullRequest;
  prNumber = pr.number; prGid = pr.id;
  if (pr.state !== 'OPEN' || pr.headRefName !== 'feature' || pr.baseRefName !== 'main') return 'pr fields wrong: ' + JSON.stringify(pr);
  const f = await gql(
    'query PullRequestFiles($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { number files(first: 10) { nodes { path } } } } }',
    { owner, name: 'test-repo', number: prNumber });
  const paths = (f.body.data.repository.pullRequest.files.nodes || []).map((n) => n.path);
  if (!paths.includes('feature.txt')) return 'files missing feature.txt: ' + paths.join(',');
  const l = await gql(
    'query PullRequests($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { pullRequests(first: $first) { nodes { number headRefName baseRefName mergeable state } } } }',
    { owner, name: 'test-repo', first: 5 });
  const found = (l.body.data.repository.pullRequests.nodes || []).find((n) => n.number === prNumber);
  if (!found || found.headRefName !== 'feature' || found.state !== 'OPEN') return 'list missing PR';
  if (!['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(found.mergeable)) return 'mergeable=' + found.mergeable;
  return true;
});

await check('gql: mergePullRequest SQUASH', async () => {
  const r = await gql('mutation MergePullRequest($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { number merged state } } }',
    { input: { pullRequestId: prGid, mergeMethod: 'SQUASH' } });
  if (r.status !== 200 || (r.body.errors || []).length > 0) return 'merge failed: ' + r.text;
  if (r.body.data.mergePullRequest.pullRequest.merged !== true) return 'merged not true';
  const stored = repo.pulls.find((p) => p.number === prNumber);
  if (!stored || stored.merged !== true || stored.state !== 'closed') return 'store PR not merged/closed';
  if (repo.branches.get('main') === baseCommit.sha) return 'main branch did not advance';
  return true;
});

await check('gql: addComment', async () => {
  const idRes = await gql(
    'query IssueByNumber($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }',
    { owner, name: 'test-repo', number: issueNumbers[0] });
  const issueId = idRes.body.data.repository.issue.id;
  const r = await gql('mutation AddComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id body } } } }',
    { input: { subjectId: issueId, body: 'hello comment' } });
  if (r.status !== 200 || (r.body.errors || []).length > 0) return 'addComment failed: ' + r.text;
  if (r.body.data.addComment.commentEdge.node.body !== 'hello comment') return 'body mismatch';
  const stored = repo.issues.find((x) => x.number === issueNumbers[0]);
  if (!stored.comments.some((c) => c.body === 'hello comment')) return 'store comment missing';
  return true;
});

await check('gql: node(id:) round-trips repository', async () => {
  const r = await gql('query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }', { id: repoGid });
  if (r.status !== 200 || (r.body.errors || []).length > 0) return 'failed: ' + r.text;
  if (r.body.data.node.name !== 'test-repo') return 'name ' + JSON.stringify(r.body.data.node);
  if (r.body.data.node.nameWithOwner !== owner + '/test-repo') return 'nameWithOwner wrong';
  return true;
});

await check('gql: invalid field -> 200 with errors naming it', async () => {
  const r = await gql('query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }');
  if (r.status !== 200) return 'HTTP ' + r.status;
  if (!r.body.errors || r.body.errors.length === 0) return 'no errors array';
  if (!r.body.errors.some((e) => String(e.message).includes('noSuchFieldOnViewer'))) return 'errors do not name field: ' + JSON.stringify(r.body.errors);
  return true;
});

await check('gql: unauthenticated -> 401', async () => {
  const r = await gql('query ViewerLogin { viewer { login } }', {}, null);
  return r.status === 401 ? true : 'HTTP ' + r.status;
});

await check('gql: batch two operations in order', async () => {
  const r = await gqlRaw([
    { query: 'query ViewerLogin { viewer { login } }', variables: {} },
    { query: 'query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }', variables: {} },
  ]);
  if (r.status !== 200) return 'HTTP ' + r.status;
  if (!Array.isArray(r.body) || r.body.length !== 2) return 'not 2 results';
  if (r.body[0].data.viewer.login !== owner) return 'first op wrong';
  if (!(r.body[1].data.Issue.fields || []).length) return 'second op empty';
  return true;
});

await check('gql: malformed JSON -> 400', async () => {
  const r = await gqlRaw('{not json');
  return r.status === 400 ? true : 'HTTP ' + r.status;
});

await check('gql: search ISSUE finds issue', async () => {
  const r = await gql('query S($query: String!, $type: SearchType!, $first: Int!) { search(query: $query, type: $type, first: $first) { nodes { ... on Issue { number title } } } }',
    { query: 'gql issue 1', type: 'ISSUE', first: 5 });
  if (r.status !== 200 || (r.body.errors || []).length > 0) return 'failed: ' + r.text;
  const nodes = r.body.data.search.nodes || [];
  if (!nodes.some((n) => n.title === 'gql issue 1')) return 'issue not in search results';
  return true;
});

// ---------------------------------------------------------------------------
// MCP cases
// ---------------------------------------------------------------------------
await check('mcp: server/discover (modern)', async () => {
  const r = await mcp('server/discover', {});
  if (r.status !== 200) return 'HTTP ' + r.status;
  const res = r.body.result;
  if (!res) return 'no result: ' + r.text;
  if (!Array.isArray(res.supportedVersions) || res.supportedVersions.length === 0) return 'no supportedVersions';
  if (!res.supportedVersions.includes('2026-07-28')) return '2026-07-28 not supported';
  if (!res.serverInfo || !res.serverInfo.name || !res.serverInfo.version) return 'no serverInfo';
  if (!res.capabilities || typeof res.capabilities.tools !== 'object') return 'no tools capability';
  return true;
});

await check('mcp: initialize legacy 2025-11-25 + initialized', async () => {
  const r = await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, { id: 'initialize-1' });
  if (r.status !== 200) return 'HTTP ' + r.status;
  const res = r.body.result;
  if (!res) return 'no result: ' + r.text;
  if (res.protocolVersion !== '2025-11-25') return 'protocolVersion=' + res.protocolVersion;
  if (!res.serverInfo || !res.serverInfo.name || !res.serverInfo.version) return 'no serverInfo';
  if (!res.capabilities || typeof res.capabilities.tools !== 'object') return 'no tools capability';
  const n = await mcpNotify('notifications/initialized', {});
  if (n.status !== 202 && n.status !== 200) return 'notify status ' + n.status;
  if (n.text.trim() !== '') return 'notify body not empty: ' + n.text;
  return true;
});

let toolsList = [];
await check('mcp: tools/list >=6 with all required, byte-identical twice', async () => {
  const a = await mcp('tools/list', {});
  const b = await mcp('tools/list', {});
  if (a.status !== 200 || b.status !== 200) return 'HTTP ' + a.status + '/' + b.status;
  const ta = a.body.result.tools;
  const tb = b.body.result.tools;
  if (!Array.isArray(ta) || ta.length < 6) return 'only ' + (ta ? ta.length : 0) + ' tools';
  for (const need of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
    if (!ta.some((t) => t.name === need)) return 'missing tool ' + need;
  }
  for (const t of ta) {
    if (!t.description) return 'tool ' + t.name + ' has no description';
    if (!t.inputSchema || t.inputSchema.type !== 'object') return 'tool ' + t.name + ' bad inputSchema';
  }
  if (JSON.stringify(ta) !== JSON.stringify(tb)) return 'tools/list differs between calls';
  toolsList = ta;
  return true;
});

await check('mcp: create_repo + get_repo', async () => {
  const c = await mcp('tools/call', { name: 'create_repo', arguments: { owner, name: 'mcp-repo', description: 'via mcp', private: false } });
  if (c.body.error) return 'rpc error ' + JSON.stringify(c.body.error);
  if (c.body.result.isError) return 'isError: ' + toolText(c);
  const created = JSON.parse(toolText(c));
  if (created.name !== 'mcp-repo') return 'created name wrong';
  if (!store.getRepo(owner, 'mcp-repo')) return 'repo not in store';
  const g = await mcp('tools/call', { name: 'get_repo', arguments: { owner, repo: 'mcp-repo' } });
  if (g.body.error) return 'get rpc error';
  const got = JSON.parse(toolText(g));
  if (got.full_name !== owner + '/mcp-repo' || got.id !== created.id) return 'get_repo mismatch';
  return true;
});

await check('mcp: create_issue + list_issues round-trip', async () => {
  const c = await mcp('tools/call', { name: 'create_issue', arguments: { owner, repo: 'mcp-repo', title: 'mcp issue one', body: 'mcp body' } });
  if (c.body.error || c.body.result.isError) return 'create failed: ' + c.text;
  const created = JSON.parse(toolText(c));
  if (typeof created.number !== 'number') return 'no number in result';
  const l = await mcp('tools/call', { name: 'list_issues', arguments: { owner, repo: 'mcp-repo', state: 'open' } });
  if (l.body.error || l.body.result.isError) return 'list failed: ' + l.text;
  const text = toolText(l);
  if (!text.includes('mcp issue one')) return 'title not in list output';
  if (!new RegExp('"number"\\s*:\\s*' + created.number + '(?!\\d)').test(text)) return 'number not in list output';
  return true;
});

await check('mcp: create_pull_request + merge_pull_request', async () => {
  // branches for mcp-repo: reuse the fixture repo's commits by pointing branches at them
  const mrepo = store.getRepo(owner, 'mcp-repo');
  mrepo.branches.set('main', baseCommit.sha);
  mrepo.branches.set('feature', headCommit.sha);
  const c = await mcp('tools/call', { name: 'create_pull_request', arguments: { owner, repo: 'mcp-repo', title: 'mcp pr', head: 'feature', base: 'main', body: 'pr body' } });
  if (c.body.error || c.body.result.isError) return 'create PR failed: ' + c.text;
  const created = JSON.parse(toolText(c));
  if (created.head.ref !== 'feature' || created.base.ref !== 'main') return 'refs wrong: ' + JSON.stringify(created.head) + '/' + JSON.stringify(created.base);
  const m = await mcp('tools/call', { name: 'merge_pull_request', arguments: { owner, repo: 'mcp-repo', pull_number: created.number } });
  if (m.body.error || m.body.result.isError) return 'merge failed: ' + m.text;
  const stored = mrepo.pulls.find((p) => p.number === created.number);
  if (!stored || stored.merged !== true || stored.state !== 'closed') return 'store PR not merged';
  return true;
});

await check('mcp: unknown tool -> -32602/-32601, not 500', async () => {
  const r = await mcp('tools/call', { name: 'mcp_no_such_tool_xyz', arguments: {} });
  if (r.status === 500) return 'HTTP 500';
  if (!r.body.error) return 'no rpc error: ' + r.text;
  if (![-32602, -32601].includes(r.body.error.code)) return 'code ' + r.body.error.code;
  return true;
});

await check('mcp: missing arguments -> isError or -32602', async () => {
  const r = await mcp('tools/call', { name: 'create_issue', arguments: {} });
  if (r.body.error && r.body.error.code === -32602) return true;
  if (r.body.result && r.body.result.isError === true) return true;
  return 'accepted: ' + r.text;
});

await check('mcp: non-JSON body -> 400 -32700', async () => {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + TOKEN, 'mcp-method': 'tools/list' },
    body: '{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"',
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* ignore */ }
  if (res.status !== 400) return 'HTTP ' + res.status;
  if (!body || !body.error || body.error.code !== -32700) return 'no -32700: ' + text;
  return true;
});

await check('mcp: no token tools/call -> 401', async () => {
  const r = await mcp('tools/call', { name: 'create_issue', arguments: { owner, repo: 'mcp-repo', title: 'x' } }, { token: null });
  return r.status === 401 ? true : 'HTTP ' + r.status;
});

await check('mcp: concurrent calls keep own ids', async () => {
  store.createRepo(owner, 'conc-left', '');
  store.createRepo(owner, 'conc-right', '');
  const [a, b] = await Promise.all([
    mcp('tools/call', { name: 'get_repo', arguments: { owner, repo: 'conc-left' } }, { id: 'conc-left-1' }),
    mcp('tools/call', { name: 'get_repo', arguments: { owner, repo: 'conc-right' } }, { id: 'conc-right-1' }),
  ]);
  if (a.body.id !== 'conc-left-1') return 'left id ' + a.body.id;
  if (b.body.id !== 'conc-right-1') return 'right id ' + b.body.id;
  if (!toolText(a).includes('conc-left')) return 'left text wrong';
  if (!toolText(b).includes('conc-right')) return 'right text wrong';
  return true;
});

await check('mcp: ping -> empty result', async () => {
  const r = await mcp('ping', {});
  if (r.status !== 200) return 'HTTP ' + r.status;
  if (!r.body.result || typeof r.body.result !== 'object') return 'no result';
  return true;
});

await check('mcp: unknown method -> -32601', async () => {
  const r = await mcp('resources/list', {});
  if (!r.body.error || r.body.error.code !== -32601) return 'code ' + JSON.stringify(r.body);
  return true;
});

await check('mcp: malformed JSON-RPC (no jsonrpc) -> -32600', async () => {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ id: 9, method: 'tools/list', params: {} }),
  });
  const body = await res.json();
  if (!body.error || body.error.code !== -32600) return 'code ' + JSON.stringify(body);
  return true;
});

await check('mcp: unknown repo call -> isError', async () => {
  const r = await mcp('tools/call', { name: 'create_issue', arguments: { owner, repo: 'no-such', title: 't' } });
  if (r.body.error && r.body.error.code === -32602) return true;
  if (r.body.result && r.body.result.isError === true) return true;
  return 'accepted: ' + r.text;
});

server.close();
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) { console.log('failures: ' + failures.join(' | ')); process.exit(1); }
process.exit(0);
