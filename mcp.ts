// MCP endpoint — POST /mcp, JSON-RPC 2.0 over Streamable HTTP (plain JSON answers).
// Speaks both eras the suite accepts:
//   modern 2026-07-28: server/discover (supportedVersions, capabilities, serverInfo), no
//          handshake, no session.
//   legacy 2025-11-25 and earlier: initialize + notifications/initialized, optional
//          Mcp-Session-Id (echoed, or deterministic `sess-1`).
// tools/list is a module-level constant serialized deterministically, so two calls are
// byte-identical. Tools act on the same Store as REST/GraphQL.
//
// Auth: Bearer token required (MAKEFUN_SHOP_TOKEN; when unset any non-empty Bearer is
// accepted). Non-JSON body -> HTTP 400 with JSON-RPC -32700. Unknown tool -> -32602.
// Unknown method -> -32601. Malformed JSON-RPC -> -32600. Notifications get no body (202).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_DATE,
  diffTrees,
  shopUser,
  treeAtCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// HTTP + auth helpers
// ---------------------------------------------------------------------------

function isAuthed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7).trim();
  if (tok === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return tok === expected;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown, sessionId: string): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'mcp-session-id': sessionId,
  });
  res.end(text);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Tool catalogue — one frozen constant, fixed key order, serialized as-is.
// ---------------------------------------------------------------------------

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const SESSION_ID = 'sess-1';
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the new repository.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach (must already exist).' },
      },
      required: ['owner', 'repo', 'title'],
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
        number: { type: 'integer', description: 'Pull request number (alias for pull_number).' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  }),
]);

const TOOLS_RESULT: Readonly<{ tools: readonly ToolDef[] }> = Object.freeze({ tools: TOOLS });

// ---------------------------------------------------------------------------
// Store helpers (REST-shaped views, shared semantics with REST/GraphQL)
// ---------------------------------------------------------------------------

function restRepo(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner.login, id: repo.owner.id, avatar_url: repo.owner.avatar_url, html_url: repo.owner.html_url, type: 'User', site_admin: repo.owner.site_admin },
    description: repo.description,
    private: repo.private,
    fork: repo.fork,
    default_branch: repo.default_branch,
    has_issues: repo.has_issues,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
  };
}

function restIssue(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })),
    user: { login: issue.user.login, id: issue.user.id, avatar_url: issue.user.avatar_url, html_url: issue.user.html_url, type: 'User', site_admin: issue.user.site_admin },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `https://example.com/${repo.full_name}/issues/${issue.number}`,
  };
}

function restPull(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.mergeable,
    head: { label: pull.head.label, ref: pull.head.ref, sha: pull.head.sha },
    base: { label: pull.base.label, ref: pull.base.ref, sha: pull.base.sha },
    user: { login: pull.user.login, id: pull.user.id, avatar_url: pull.user.avatar_url, html_url: pull.user.html_url, type: 'User', site_admin: pull.user.site_admin },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: `https://example.com/${repo.full_name}/pull/${pull.number}`,
  };
}

/** Resolve owner/repo from tool arguments (owner+repo, or a full_name "owner/repo"). */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  const full = typeof args.full_name === 'string' ? args.full_name : typeof args.fullName === 'string' ? args.fullName : '';
  if (full.includes('/')) {
    const [o, r] = full.split('/', 2);
    return { owner: o ?? '', repo: r ?? '' };
  }
  const owner =
    typeof args.owner === 'string' && args.owner !== ''
      ? args.owner
      : typeof args.owner_login === 'string'
        ? args.owner_login
        : shopUser().login;
  const repo =
    typeof args.repo === 'string' && args.repo !== ''
      ? args.repo
      : typeof args.repository === 'string'
        ? args.repository
        : typeof args.name === 'string'
          ? args.name
          : '';
  return { owner, repo };
}

function createIssueInStore(store: Store, repo: Repo, title: string, body: string, labels: unknown): Issue {
  const n = repo.nextIssue;
  repo.nextIssue += 1;
  const issue: Issue = {
    id: n,
    number: n,
    title,
    body: body ?? '',
    state: 'open',
    labels: [],
    comments: [],
    user: shopUser(),
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
  if (Array.isArray(labels)) {
    for (const name of labels) {
      if (typeof name !== 'string') continue;
      const found = repo.labels.find((l) => l.name === name);
      if (found) issue.labels.push(found);
    }
  }
  repo.issues.push(issue);
  return issue;
}

function createPullInStore(store: Store, repo: Repo, baseRef: string, headRef: string, title: string, body: string): Pull {
  const baseSha = repo.branches.get(baseRef);
  const headSha = repo.branches.get(headRef);
  if (baseSha === undefined) throw new Error(`base branch ${baseRef} does not exist`);
  if (headSha === undefined) throw new Error(`head branch ${headRef} does not exist`);
  const n = repo.nextPull;
  repo.nextPull += 1;
  let files: Pull['files'] = [];
  try {
    files = diffTrees(repo, treeAtCommit(repo, baseSha), treeAtCommit(repo, headSha));
  } catch {
    files = [];
  }
  const pull: Pull = {
    id: n,
    number: n,
    title,
    body: body ?? '',
    state: 'open',
    merged: false,
    merge_commit_sha: null,
    mergeable: true,
    head: { label: `${repo.owner.login}:${headRef}`, ref: headRef, sha: headSha },
    base: { label: `${repo.owner.login}:${baseRef}`, ref: baseRef, sha: baseSha },
    user: shopUser(),
    files,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
  repo.pulls.push(pull);
  return pull;
}

function mergePullInStore(store: Store, repo: Repo, pull: Pull): string {
  if (pull.merged) return pull.merge_commit_sha ?? pull.head.sha;
  const baseSha = repo.branches.get(pull.base.ref);
  let sha = pull.head.sha;
  try {
    const headTree = treeAtCommit(repo, pull.head.sha);
    const made = store.makeCommit(repo, headTree, baseSha !== undefined ? [baseSha] : [], `Merge pull request #${pull.number} from ${pull.head.ref}`, {
      name: shopUser().login,
      email: `${shopUser().login}@example.com`,
    }) as unknown as Record<string, unknown>;
    sha =
      typeof made?.sha === 'string'
        ? (made.sha as string)
        : typeof made?.commitSha === 'string'
          ? (made.commitSha as string)
          : typeof made?.oid === 'string'
            ? (made.oid as string)
            : pull.head.sha;
    repo.branches.set(pull.base.ref, sha);
  } catch {
    sha = pull.head.sha;
  }
  pull.merge_commit_sha = sha;
  pull.merged = true;
  pull.state = 'closed';
  pull.updated_at = FIXED_DATE;
  repo.updated_at = FIXED_DATE;
  repo.pushed_at = FIXED_DATE;
  return sha;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

interface ToolOutcome {
  /** JSON-RPC error to answer with (instead of a result), when set. */
  rpcError?: { code: number; message: string };
  /** Tool result object, when set. */
  result?: Record<string, unknown>;
}

function textResult(payload: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }], isError };
}

function errorResult(message: string): Record<string, unknown> {
  return textResult(message, true);
}

function requiredOf(tool: ToolDef): string[] {
  const req = (tool.inputSchema as Record<string, unknown>).required;
  return Array.isArray(req) ? req.filter((x): x is string => typeof x === 'string') : [];
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = requiredOf(tool).filter((r) => {
    if (r === 'pull_number') return args.pull_number === undefined && args.number === undefined;
    return args[r] === undefined || args[r] === null || args[r] === '';
  });
  if (missing.length > 0) {
    return { result: errorResult(`Missing required argument(s): ${missing.join(', ')}`) };
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : shopUser().login;
        const repo = store.createRepo(owner, repoName, typeof args.description === 'string' ? args.description : '');
        if (typeof args.private === 'boolean') repo.private = args.private;
        return { result: textResult(restRepo(repo)) };
      }
      case 'get_repo': {
        const { owner, repo } = resolveRepoArgs(args);
        const found = store.getRepo(owner, repo);
        if (!found) return { result: errorResult(`Repository not found: ${owner}/${repo}`) };
        return { result: textResult(restRepo(found)) };
      }
      case 'create_issue': {
        const { owner, repo } = resolveRepoArgs(args);
        const found = store.getRepo(owner, repo);
        if (!found) return { result: errorResult(`Repository not found: ${owner}/${repo}`) };
        const issue = createIssueInStore(store, found, String(args.title), typeof args.body === 'string' ? args.body : '', args.labels);
        return { result: textResult(restIssue(found, issue)) };
      }
      case 'list_issues': {
        const { owner, repo } = resolveRepoArgs(args);
        const found = store.getRepo(owner, repo);
        if (!found) return { result: errorResult(`Repository not found: ${owner}/${repo}`) };
        const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
        const list = found.issues.filter((i) => state === 'all' ? true : i.state === state);
        return { result: textResult(list.map((i) => restIssue(found, i))) };
      }
      case 'create_pull_request': {
        const { owner, repo } = resolveRepoArgs(args);
        const found = store.getRepo(owner, repo);
        if (!found) return { result: errorResult(`Repository not found: ${owner}/${repo}`) };
        const pull = createPullInStore(
          store,
          found,
          String(args.base),
          String(args.head),
          String(args.title),
          typeof args.body === 'string' ? args.body : '',
        );
        return { result: textResult(restPull(found, pull)) };
      }
      case 'merge_pull_request': {
        const { owner, repo } = resolveRepoArgs(args);
        const found = store.getRepo(owner, repo);
        if (!found) return { result: errorResult(`Repository not found: ${owner}/${repo}`) };
        const num = Number(args.pull_number ?? args.number);
        const pull = found.pulls.find((p) => p.number === num);
        if (!pull) return { result: errorResult(`Pull request not found: #${num}`) };
        const sha = mergePullInStore(store, found, pull);
        return {
          result: textResult({
            merged: true,
            sha,
            message: `Pull request #${pull.number} merged`,
            number: pull.number,
            pull_request: restPull(found, pull),
          }),
        };
      }
      default:
        return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
    }
  } catch (err) {
    return { result: errorResult(err instanceof Error ? err.message : String(err)) };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

const ACCEPTED_VERSIONS = new Set<string>(SUPPORTED_VERSIONS);

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
  };
}

function initializeResult(params: Record<string, unknown>): Record<string, unknown> {
  const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const version = ACCEPTED_VERSIONS.has(offered) ? offered : '2026-07-28';
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

type RpcReply =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

function dispatchOne(store: Store, body: unknown): RpcReply | null {
  // Returns null for notifications (no reply).
  if (!isRecord(body)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' } };
  }
  const id = 'id' in body ? (body.id as string | number | null) : undefined;
  const hasId = id !== undefined;
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string' || body.method === '') {
    if (!hasId) return null;
    return { jsonrpc: '2.0', id: (id as string | number | null) ?? null, error: { code: -32600, message: 'Invalid Request: expected jsonrpc "2.0" and a method' } };
  }
  const method = body.method as string;
  if (!hasId) {
    // Notification: no response body, whatever the method.
    return null;
  }
  const rpcId = (id as string | number | null) ?? null;
  const params = isRecord(body.params) ? body.params : {};
  switch (method) {
    case 'server/discover':
      return { jsonrpc: '2.0', id: rpcId, result: discoverResult() };
    case 'initialize':
      return { jsonrpc: '2.0', id: rpcId, result: initializeResult(params) };
    case 'ping':
      return { jsonrpc: '2.0', id: rpcId, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: rpcId, result: TOOLS_RESULT };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(store, toolName, args);
      if (outcome.rpcError) {
        return { jsonrpc: '2.0', id: rpcId, error: { code: outcome.rpcError.code, message: outcome.rpcError.message } };
      }
      return { jsonrpc: '2.0', id: rpcId, result: outcome.result };
    }
    default:
      return { jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  if (path !== '/mcp' && path !== '/mcp/') return false;
  const sessionId = typeof req.headers['mcp-session-id'] === 'string' && req.headers['mcp-session-id'] !== '' ? req.headers['mcp-session-id'] : SESSION_ID;
  if (req.method === 'DELETE') {
    // Legacy session close: best-effort, no body.
    res.writeHead(204, { 'mcp-session-id': sessionId });
    res.end();
    return true;
  }
  if (req.method !== 'POST') return false;
  if (!isAuthed(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }, sessionId);
    return true;
  }
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, sessionId);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, sessionId);
    return true;
  }
  if (Array.isArray(parsed)) {
    const replies: RpcReply[] = [];
    for (const entry of parsed) {
      const reply = dispatchOne(store, entry);
      if (reply !== null) replies.push(reply);
    }
    sendJson(res, 200, replies, sessionId);
    return true;
  }
  const reply = dispatchOne(store, parsed);
  if (reply === null) {
    // Notification: accepted, no body.
    res.writeHead(202, { 'mcp-session-id': sessionId });
    res.end();
    return true;
  }
  sendJson(res, 200, reply, sessionId);
  return true;
}
