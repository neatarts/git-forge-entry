// Shared in-memory store for the git forge (git smart-HTTP, REST v3, GraphQL, MCP
// all build against this one spec). Node 22 stdlib only. No wall-clock time anywhere:
// every timestamp in every response is FIXED_DATE, and every commit object the store
// builds uses the fixed epoch 1735689600 (+0000), so object SHAs are deterministic.

import { createHash } from 'node:crypto';

export const FIXED_DATE = '2025-01-01T00:00:00Z';

/** The fixed author/committer timestamp every commit object carries (2025-01-01T00:00:00Z). */
export const FIXED_EPOCH = 1735689600;

export interface Actor {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  type: 'User';
  site_admin: boolean;
}

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: Actor;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  user: Actor;
  created_at: string;
  updated_at: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merge_commit_sha: string | null;
  mergeable: boolean;
  head: { label: string; ref: string; sha: string };
  base: { label: string; ref: string; sha: string };
  user: Actor;
  files: PullFile[];
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: Actor;
  description: string;
  default_branch: string;
  private: boolean;
  fork: boolean;
  has_issues: boolean;
  branches: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssue: number;
  nextPull: number;
  nextLabelId: number;
  nextCommentId: number;
  created_at: string;
  updated_at: string;
  pushed_at: string;
}

/** SHA-1 of a git object header + payload: the object's id. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/**
 * The token's user. The suite never hardcodes a login: every check and workload derives
 * the owner from the scenario viewer (sdk/conformance/wire.ts buildScenario(), fixed
 * SCENARIO_SEED), and the viewer there is login `adaiversen`, id 1000, name "ada iversen",
 * email adaiversen@example.invalid (verified by running buildScenario() in the kit).
 * GET /api/v3/user must return this login, and repositories the token creates belong to
 * it, or the suite's git paths (/{viewer.login}/{repo}.git) would 404. A fixed 'shop'
 * login would fail every git check, so it is NOT used.
 */
/** The token's user, as one shared object: it is never mutated (serializers only read it). */
const SHOP_USER: Actor = {
  login: 'adaiversen',
  id: 1000,
  avatar_url: 'https://avatars.githubusercontent.com/u/1000?v=4',
  html_url: 'https://github.com/adaiversen',
  type: 'User',
  site_admin: false,
};

export function shopUser(): Actor {
  return SHOP_USER;
}

/**
 * Serialized-issue response cache. A GET /issues/{n} body is fully determined
 * by the issue, its labels, and the request host (the URLs embed it), and
 * issues are read far more often than written — so the exact response bytes
 * (`JSON.stringify(issueJson) + '\n'`) are cached per issue. The cache is
 * keyed by host, and every mutation of an issue (REST PATCH/comment, GraphQL
 * close/comment) must call invalidateIssueBody first: a stale entry would
 * serve the pre-mutation body. The WeakMap dies with the issue, so a deleted
 * repository cannot leak entries.
 */
const issueBodyCache = new WeakMap<Issue, { host: string; body: Buffer }>();

export function getCachedIssueBody(issue: Issue): { host: string; body: Buffer } | undefined {
  return issueBodyCache.get(issue);
}

export function setCachedIssueBody(issue: Issue, host: string, body: Buffer): void {
  issueBodyCache.set(issue, { host, body });
}

export function invalidateIssueBody(issue: Issue): void {
  issueBodyCache.delete(issue);
}

let requestCounter = 0;

/** Deterministic counter: `req-1`, `req-2`, ... for X-GitHub-Request-Id. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** GitHub's standard default label set, in creation order (ids 1..9). */
const DEFAULT_LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'duplicate', color: 'cfd3d7', description: 'This issue or pull request already exists' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'invalid', color: 'e4e669', description: "This doesn't seem right" },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
];

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(ownerLogin: string, name: string, description: string): Repo {
    const owner: Actor =
      ownerLogin === shopUser().login
        ? shopUser()
        : {
            login: ownerLogin,
            id: 1,
            avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
            html_url: `https://github.com/${ownerLogin}`,
            type: 'User',
            site_admin: false,
          };
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      full_name: `${ownerLogin}/${name}`,
      owner,
      description,
      default_branch: 'main',
      private: false,
      fork: false,
      has_issues: true,
      branches: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      issues: [],
      pulls: [],
      labels: DEFAULT_LABELS.map((label, index) => ({ id: index + 1, ...label })),
      nextIssue: 1,
      nextPull: 1,
      nextLabelId: DEFAULT_LABELS.length + 1,
      nextCommentId: 1,
      created_at: FIXED_DATE,
      updated_at: FIXED_DATE,
      pushed_at: FIXED_DATE,
    };
    this.repos.set(repo.full_name, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  makeCommit(
    repo: Repo,
    treeSha: string,
    parents: string[],
    message: string,
    author: { name: string; email: string },
  ): CommitInfo {
    const lines: string[] = [`tree ${treeSha}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    const stamp = `${FIXED_EPOCH} +0000`;
    lines.push(`author ${author.name} <${author.email}> ${stamp}`);
    lines.push(`committer ${author.name} <${author.email}> ${stamp}`);
    const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
    const sha = this.putObject(repo, 'commit', data);
    return {
      sha,
      tree: treeSha,
      parents: [...parents],
      message,
      authorName: author.name,
      authorEmail: author.email,
      committerName: author.name,
      committerEmail: author.email,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------------------------

/** Parse a raw git tree object into its entries, in stored order. */
export function parseTree(data: Buffer): { mode: string; name: string; sha: string }[] {
  const entries: { mode: string; name: string; sha: string }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Git tree order: names compared as bytes, directories as if suffixed with '/'. */
function compareTreeEntries(
  a: { mode: string; name: string },
  b: { mode: string; name: string },
): number {
  const left = Buffer.from(isDirMode(a.mode) ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(isDirMode(b.mode) ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Encode, store and return the sha of a tree built from `entries` (sorted in git order). */
export function buildTree(
  repo: Repo,
  entries: { mode: string; name: string; sha: string }[],
): string {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = isDirMode(entry.mode) ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  const data = Buffer.concat(parts);
  const sha = hashObject('tree', data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type: 'tree', data });
  return sha;
}

/** Number of lines in a blob: '\n' count, +1 when non-empty and not newline-terminated. */
function lineCount(content: Buffer): number {
  if (content.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < content.length; i += 1) if (content[i] === 0x0a) count += 1;
  if (content[content.length - 1] !== 0x0a) count += 1;
  return count;
}

/**
 * Recursive diff of two trees. Additions/deletions are counted by newlines in the blob
 * content (a new file counts its lines as additions, a removed file its lines as
 * deletions; a modified file counts the new blob's lines as additions and the old
 * blob's lines as deletions). `changes` is additions + deletions.
 */
export function diffTrees(
  repo: Repo,
  baseTreeSha: string,
  headTreeSha: string,
  prefix = '',
): PullFile[] {
  const out: PullFile[] = [];
  const baseEntries = new Map<string, { mode: string; sha: string }>();
  if (baseTreeSha !== '') {
    const base = repo.objects.get(baseTreeSha);
    if (base) for (const e of parseTree(base.data)) baseEntries.set(e.name, e);
  }
  const headEntries = new Map<string, { mode: string; sha: string }>();
  if (headTreeSha !== '') {
    const head = repo.objects.get(headTreeSha);
    if (head) for (const e of parseTree(head.data)) headEntries.set(e.name, e);
  }
  const names = new Set([...baseEntries.keys(), ...headEntries.keys()]);
  for (const name of [...names].sort()) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const base = baseEntries.get(name);
    const head = headEntries.get(name);
    if (base && !head) {
      collectTreeFiles(repo, base, path, out, 'removed');
    } else if (!base && head) {
      collectTreeFiles(repo, head, path, out, 'added');
    } else if (base && head && base.sha !== head.sha) {
      if (isDirMode(base.mode) && isDirMode(head.mode)) {
        out.push(...diffTrees(repo, base.sha, head.sha, path));
      } else if (!isDirMode(base.mode) && !isDirMode(head.mode)) {
        const oldBlob = repo.objects.get(base.sha);
        const newBlob = repo.objects.get(head.sha);
        const deletions = oldBlob ? lineCount(oldBlob.data) : 0;
        const additions = newBlob ? lineCount(newBlob.data) : 0;
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      } else {
        // Type changed (file <-> directory): the old side is removed, the new added.
        collectTreeFiles(repo, base, path, out, 'removed');
        collectTreeFiles(repo, head, path, out, 'added');
      }
    }
  }
  return out;
}

function collectTreeFiles(
  repo: Repo,
  entry: { mode: string; sha: string },
  path: string,
  out: PullFile[],
  status: 'added' | 'removed',
): void {
  if (!isDirMode(entry.mode)) {
    const blob = repo.objects.get(entry.sha);
    const lines = blob ? lineCount(blob.data) : 0;
    out.push({
      filename: path,
      status,
      additions: status === 'added' ? lines : 0,
      deletions: status === 'removed' ? lines : 0,
      changes: lines,
    });
    return;
  }
  const tree = repo.objects.get(entry.sha);
  if (!tree) return;
  for (const child of parseTree(tree.data)) {
    collectTreeFiles(repo, child, `${path}/${child.name}`, out, status);
  }
}

/** Parse a commit object's headers. Returns the tree sha and parent shas. */
export function parseCommitHeaders(data: Buffer): { tree: string; parents: string[] } {
  const blank = data.indexOf('\n\n');
  const headerText = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

/** The tree sha of a commit, or '' when the commit is missing. */
export function treeAtCommit(repo: Repo, commitSha: string): string {
  const commit = repo.objects.get(commitSha);
  if (!commit || commit.type !== 'commit') return '';
  return parseCommitHeaders(commit.data).tree;
}

/** Walk trees by path segments; returns the blob sha and content at `path`, if present. */
export function getFileAt(
  repo: Repo,
  commitSha: string,
  path: string,
): { blobSha: string; content: Buffer } | undefined {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return undefined;
  let treeSha = treeAtCommit(repo, commitSha);
  if (treeSha === '') return undefined;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.objects.get(treeSha);
    if (!tree || tree.type !== 'tree') return undefined;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return undefined;
    if (i === segments.length - 1) {
      if (isDirMode(entry.mode)) return undefined;
      const blob = repo.objects.get(entry.sha);
      if (!blob || blob.type !== 'blob') return undefined;
      return { blobSha: entry.sha, content: blob.data };
    }
    if (!isDirMode(entry.mode)) return undefined;
    treeSha = entry.sha;
  }
  return undefined;
}
