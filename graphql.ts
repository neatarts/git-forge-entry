// GraphQL v4 API — POST /api/graphql.
// Hand-rolled mini GraphQL engine (tokenizer + parser + resolver) covering exactly the
// documents gh / github-mcp-server send (see kit checks-graphql.ts): viewer, repository,
// issues/pullRequests with connections + cursor pagination, node(id:), search, __type/__schema
// introspection, and the createIssue / closeIssue / createPullRequest / mergePullRequest /
// addComment mutations. No dependencies, stdlib only.
//
// Auth: Bearer token required (MAKEFUN_SHOP_TOKEN; when unset any non-empty Bearer is
// accepted). Unknown fields are HTTP 200 with an `errors` array; unknown repositories are
// data.repository = null with no errors; malformed JSON is HTTP 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_DATE,
  diffTrees,
  invalidateIssueBody,
  shopUser,
  treeAtCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// HTTP helpers
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

// ---------------------------------------------------------------------------
// Global ids (opaque, deterministic, stable across reads)
// ---------------------------------------------------------------------------

function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':')).toString('base64');
}

function decodeGid(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function repoFromGid(store: Store, id: unknown): Repo | undefined {
  const d = decodeGid(id);
  if (!d || d.kind !== 'Repository' || d.parts.length < 1) return undefined;
  const n = Number(d.parts[0]);
  if (!Number.isInteger(n)) return undefined;
  return findRepoById(store, n);
}

function issueFromGid(store: Store, id: unknown): { repo: Repo; issue: Issue } | undefined {
  const d = decodeGid(id);
  if (!d || d.kind !== 'Issue' || d.parts.length < 2) return undefined;
  const repo = findRepoById(store, Number(d.parts[0]));
  if (!repo) return undefined;
  const issue = repo.issues.find((i) => i.number === Number(d.parts[1]));
  return issue ? { repo, issue } : undefined;
}

function pullFromGid(store: Store, id: unknown): { repo: Repo; pull: Pull } | undefined {
  const d = decodeGid(id);
  if (!d || d.kind !== 'PullRequest' || d.parts.length < 2) return undefined;
  const repo = findRepoById(store, Number(d.parts[0]));
  if (!repo) return undefined;
  const pull = repo.pulls.find((p) => p.number === Number(d.parts[1]));
  return pull ? { repo, pull } : undefined;
}

// ---------------------------------------------------------------------------
// Store mutations shared by the resolvers
// ---------------------------------------------------------------------------

function createIssueInStore(store: Store, repo: Repo, title: string, body: string): Issue {
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
  repo.issues.push(issue);
  return issue;
}

function computePullFiles(store: Store, repo: Repo, baseSha: string, headSha: string): Pull['files'] {
  try {
    const baseTree = treeAtCommit(repo, baseSha);
    const headTree = treeAtCommit(repo, headSha);
    return diffTrees(repo, baseTree, headTree);
  } catch {
    return [];
  }
}

function createPullInStore(
  store: Store,
  repo: Repo,
  baseRef: string,
  headRef: string,
  title: string,
  body: string,
): Pull {
  const baseSha = repo.branches.get(baseRef);
  const headSha = repo.branches.get(headRef);
  if (baseSha === undefined) throw new Error(`base branch ${baseRef} does not exist`);
  if (headSha === undefined) throw new Error(`head branch ${headRef} does not exist`);
  const n = repo.nextPull;
  repo.nextPull += 1;
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
    files: computePullFiles(store, repo, baseSha, headSha),
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
  repo.pulls.push(pull);
  return pull;
}

/** Squash-merge a pull request in the store; falls back to marking merged only. */
function mergePullInStore(store: Store, repo: Repo, pull: Pull): void {
  if (pull.merged) return;
  const baseSha = repo.branches.get(pull.base.ref);
  try {
    const headTree = treeAtCommit(repo, pull.head.sha);
    const parents = baseSha !== undefined ? [baseSha] : [];
    const made = store.makeCommit(repo, headTree, parents, `Merge pull request #${pull.number} from ${pull.head.ref}`, {
      name: shopUser().login,
      email: `${shopUser().login}@example.com`,
    }) as unknown as Record<string, unknown>;
    const sha =
      typeof made?.sha === 'string'
        ? (made.sha as string)
        : typeof made?.commitSha === 'string'
          ? (made.commitSha as string)
          : typeof made?.oid === 'string'
            ? (made.oid as string)
            : pull.head.sha;
    repo.branches.set(pull.base.ref, sha);
    pull.merge_commit_sha = sha;
  } catch {
    pull.merge_commit_sha = pull.head.sha;
  }
  pull.merged = true;
  pull.state = 'closed';
  pull.updated_at = FIXED_DATE;
  repo.updated_at = FIXED_DATE;
  repo.pushed_at = FIXED_DATE;
}

// ---------------------------------------------------------------------------
// GraphQL document parsing (tokenizer + recursive-descent parser)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string' | 'int' | 'float' | 'bool' | 'null' | 'enum'; value: string | number | boolean | null }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldSel {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selections?: Selection[];
}
interface InlineSel {
  kind: 'inline';
  typeCondition?: string;
  selections: Selection[];
}
interface SpreadSel {
  kind: 'spread';
  name: string;
}
type Selection = FieldSel | InlineSel | SpreadSel;

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}
interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}
interface Document {
  operations: Operation[];
  fragments: Record<string, FragmentDef>;
}

interface Tok {
  kind: 'name' | 'string' | 'int' | 'punct';
  value: string;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!@$=[]|&'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && /[0-9]/.test(src[i]!) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      toks.push({ kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return toks;
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`Expected '${v}' but got '${t.value}'`);
  }
  private expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected a name but got '${t.value}'`);
    if (v !== undefined && t.value !== v) throw new Error(`Expected '${v}' but got '${t.value}'`);
    return t.value;
  }
  private atPunct(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === v;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments: Record<string, FragmentDef> = {};
    while (this.peek() !== undefined) {
      const t = this.peek()!;
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ type: 'query', selections: this.parseSelections() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek()?.kind === 'name') name = this.next().value;
        this.skipVarDefs();
        operations.push({ type, name, selections: this.parseSelections() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments[name] = { name, typeCondition, selections: this.parseSelections() };
      } else {
        throw new Error(`Unexpected token '${t.value}' in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  /** Skip `( $var: Type = default ... )` variable definitions. */
  private skipVarDefs(): void {
    if (!this.atPunct('(')) return;
    let depth = 0;
    while (this.peek() !== undefined) {
      const t = this.next();
      if (t.kind === 'punct' && t.value === '(') depth += 1;
      else if (t.kind === 'punct' && t.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelections(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek() === undefined) throw new Error('Unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): Selection {
    const t = this.peek()!;
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n?.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelections() };
      }
      if (n?.kind === 'name') return { kind: 'spread', name: this.next().value };
      return { kind: 'inline', selections: this.parseSelections() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.atPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.atPunct('(')) args = this.parseArgs();
    this.skipDirectives();
    let selections: Selection[] | undefined;
    if (this.atPunct('{')) selections = this.parseSelections();
    return { kind: 'field', alias, name, args, selections };
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.parseArgs();
    }
  }

  private parseArgs(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Unexpected value token '${t.value}'`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'null':
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema description (introspection + field validation)
// ---------------------------------------------------------------------------

// type -> field -> child type (null = scalar). '[X]' = list of X.
const SCHEMA: Record<string, Record<string, string | null>> = {
  Query: {
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    search: 'SearchResultItemConnection',
    __type: '__Type',
    __schema: '__Schema',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    id: null, databaseId: null, name: null, nameWithOwner: null, owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: null, hasIssuesEnabled: null,
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest', description: null, url: null, createdAt: null,
    updatedAt: null, pushedAt: null, isPrivate: null, fork: null,
  },
  User: { id: null, login: null, name: null, avatarUrl: null, url: null },
  Ref: { name: null, target: 'GitObject' },
  GitObject: { oid: null, type: null },
  Issue: {
    id: null, number: null, title: null, state: null, body: null, createdAt: null,
    updatedAt: null, url: null, author: 'User', labels: 'LabelConnection',
    comments: 'IssueCommentConnection',
  },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', totalCount: null, pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue', cursor: null },
  IssueCommentConnection: { nodes: '[IssueComment]', totalCount: null, pageInfo: 'PageInfo' },
  IssueComment: { id: null, body: null, author: 'User', createdAt: null, updatedAt: null },
  IssueCommentEdge: { node: 'IssueComment', cursor: null },
  LabelConnection: { nodes: '[Label]', totalCount: null },
  Label: { id: null, name: null, color: null, description: null },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', totalCount: null, pageInfo: 'PageInfo' },
  PullRequestEdge: { node: 'PullRequest', cursor: null },
  PullRequest: {
    id: null, number: null, title: null, body: null, state: null, merged: null,
    mergeable: null, headRefName: null, baseRefName: null, headRefOid: null,
    baseRefOid: null, files: 'PullRequestChangedFileConnection', author: 'User',
    createdAt: null, updatedAt: null, url: null,
  },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', totalCount: null, pageInfo: 'PageInfo' },
  PullRequestChangedFile: { path: null, additions: null, deletions: null, changeType: null },
  SearchResultItemConnection: {
    nodes: '[Issue]', edges: '[IssueEdge]', totalCount: null, issueCount: null, pageInfo: 'PageInfo',
  },
  PageInfo: { hasNextPage: null, hasPreviousPage: null, startCursor: null, endCursor: null },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: null },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: null },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: null },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: null },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: null },
  __Type: { name: null, kind: null, description: null, fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: null, description: null, type: '__Type' },
  __EnumValue: { name: null, description: null },
  __Schema: {
    queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type',
    types: '[__Type]', description: null,
  },
  Node: { id: null },
};

interface TypeDef {
  name: string;
  kind: string;
  fields: { name: string; type: { name: string; kind: string } }[];
  enumValues: { name: string }[] | null;
}

function scalarKind(name: string): string {
  return name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID' ? 'SCALAR' : 'OBJECT';
}

const TYPE_DEFS: Record<string, TypeDef> = {};
for (const [typeName, fields] of Object.entries(SCHEMA)) {
  if (typeName === 'Node') continue;
  TYPE_DEFS[typeName] = {
    name: typeName,
    kind: 'OBJECT',
    fields: Object.keys(fields).map((f) => {
      const child = fields[f]!;
      const base = child === null ? 'String' : child.replace(/[\[\]]/g, '');
      return { name: f, type: { name: base, kind: scalarKind(base) } };
    }),
    enumValues: null,
  };
}
const ENUM_DEFS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};
for (const [name, values] of Object.entries(ENUM_DEFS)) {
  TYPE_DEFS[name] = { name, kind: 'ENUM', fields: [], enumValues: values.map((v) => ({ name: v })) };
}
for (const name of ['String', 'Int', 'Boolean', 'ID']) {
  TYPE_DEFS[name] = { name, kind: 'SCALAR', fields: [], enumValues: null };
}
for (const name of ['CreateIssueInput', 'CloseIssueInput', 'CreatePullRequestInput', 'MergePullRequestInput', 'AddCommentInput', 'IssueOrder']) {
  TYPE_DEFS[name] = { name, kind: 'INPUT_OBJECT', fields: [], enumValues: null };
}

function typeObject(name: string): Record<string, unknown> | null {
  const def = TYPE_DEFS[name];
  if (!def) return null;
  return {
    __typename: '__Type',
    name: def.name,
    kind: def.kind,
    description: null,
    fields:
      def.kind === 'OBJECT'
        ? def.fields.map((f) => ({ __typename: '__Field', name: f.name, description: null, type: { __typename: '__Type', name: f.type.name, kind: f.type.kind, ofType: null } }))
        : null,
    enumValues: def.enumValues,
  };
}

function schemaObject(): Record<string, unknown> {
  return {
    __typename: '__Schema',
    description: null,
    queryType: typeObject('Query'),
    mutationType: typeObject('Mutation'),
    subscriptionType: null,
    types: Object.keys(TYPE_DEFS).map((n) => typeObject(n)),
  };
}

// ---------------------------------------------------------------------------
// Domain objects (already shaped like GraphQL responses; functions = args)
// ---------------------------------------------------------------------------

type Ctx = { store: Store };

function userObj(login: string): Record<string, unknown> {
  return {
    __typename: 'User',
    id: gid('User', login),
    login,
    name: login,
    avatarUrl: `https://example.com/avatars/${encodeURIComponent(login)}`,
    url: `https://example.com/${encodeURIComponent(login)}`,
  };
}

function labelObj(repo: Repo, label: { id: number; name: string; color: string; description: string }): Record<string, unknown> {
  return { __typename: 'Label', id: gid('Label', repo.id, label.id), name: label.name, color: label.color, description: label.description };
}

function commentObj(repo: Repo, c: Issue['comments'][number]): Record<string, unknown> {
  return {
    __typename: 'IssueComment',
    id: gid('IssueComment', repo.id, c.id),
    body: c.body,
    author: userObj(c.user.login),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function issueObj(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: `https://example.com/${repo.full_name}/issues/${issue.number}`,
    author: userObj(issue.user.login),
    labels: {
      __typename: 'LabelConnection',
      nodes: issue.labels.map((l) => labelObj(repo, l)),
      totalCount: issue.labels.length,
    },
    comments: {
      __typename: 'IssueCommentConnection',
      nodes: issue.comments.map((c) => commentObj(repo, c)),
      totalCount: issue.comments.length,
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    },
  };
}

function changeTypeOf(status: string): string {
  return status === 'added' ? 'ADDED' : status === 'removed' ? 'REMOVED' : 'MODIFIED';
}

function pullObj(repo: Repo, pull: Pull): Record<string, unknown> {
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    __typename: 'PullRequest',
    id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.merged,
    mergeable: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    headRefOid: pull.head.sha,
    baseRefOid: pull.base.sha,
    files: {
      __typename: 'PullRequestChangedFileConnection',
      nodes: pull.files.map((f) => ({
        __typename: 'PullRequestChangedFile',
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: changeTypeOf(f.status),
      })),
      totalCount: pull.files.length,
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    },
    author: userObj(pull.user.login),
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    url: `https://example.com/${repo.full_name}/pull/${pull.number}`,
  };
}

function cursorFor(repoId: number, number: number): string {
  return Buffer.from(`cursor:${repoId}:${number}`).toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'cursor' || parts.length < 3) return null;
    const n = Number(parts[2]);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

interface PageArgs {
  first?: unknown;
  after?: unknown;
  states?: unknown;
  orderBy?: unknown;
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const ob = (orderBy ?? {}) as { field?: string; direction?: string };
  const dir = ob.direction === 'ASC' ? 1 : -1;
  const field = ob.field === 'UPDATED_AT' ? 'updated_at' : 'created_at';
  return [...issues].sort((a, b) => {
    const da = a[field];
    const db = b[field];
    if (da !== db) return da < db ? -dir : dir;
    return (a.number - b.number) * dir;
  });
}

function paginate<T extends { number: number }>(
  items: T[],
  repoId: number,
  args: PageArgs,
  toNode: (item: T) => Record<string, unknown>,
  edgeType: string,
): Record<string, unknown> {
  const afterNum = cursorNumber(args.after);
  let start = 0;
  if (afterNum !== null) {
    const idx = items.findIndex((i) => i.number === afterNum);
    if (idx >= 0) start = idx + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : items.length;
  const page = items.slice(start, start + first);
  const endCursor = page.length > 0 ? cursorFor(repoId, page[page.length - 1]!.number) : null;
  const startCursor = page.length > 0 ? cursorFor(repoId, page[0]!.number) : null;
  return {
    nodes: page.map(toNode),
    edges: page.map((i) => ({ __typename: edgeType, node: toNode(i), cursor: cursorFor(repoId, i.number) })),
    totalCount: items.length,
    pageInfo: {
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor,
      endCursor,
    },
  };
}

function issueConnection(repo: Repo, args: PageArgs): Record<string, unknown> {
  let list = [...repo.issues];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  list = sortIssues(list, args.orderBy);
  return paginate(list, repo.id, args, (i) => issueObj(repo, i), 'IssueEdge');
}

function pullConnection(repo: Repo, args: PageArgs): Record<string, unknown> {
  let list = [...repo.pulls];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((s) => String(s).toUpperCase()));
    list = list.filter((p) => {
      const st = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(st);
    });
  }
  list = sortIssues(list as unknown as Issue[], args.orderBy) as unknown as Pull[];
  // sortIssues works on number/created_at which Pull also has; keep its result order.
  return paginate(list, repo.id, args, (p) => pullObj(repo, p), 'PullRequestEdge');
}

function repoObj(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const defaultSha = repo.branches.get(repo.default_branch);
  return {
    __typename: 'Repository',
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    owner: userObj(repo.owner.login),
    defaultBranchRef:
      defaultSha === undefined
        ? null
        : { __typename: 'Ref', name: repo.default_branch, target: { __typename: 'GitObject', oid: defaultSha, type: 'commit' } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: repo.has_issues,
    description: repo.description,
    url: `https://example.com/${repo.full_name}`,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
    isPrivate: repo.private,
    fork: repo.fork,
    issue: (args: Record<string, unknown>) => {
      const n = Number(args.number);
      const issue = repo.issues.find((i) => i.number === n);
      return issue ? issueObj(repo, issue) : null;
    },
    issues: (args: Record<string, unknown>) => issueConnection(repo, args as PageArgs),
    pullRequests: (args: Record<string, unknown>) => pullConnection(repo, args as PageArgs),
    pullRequest: (args: Record<string, unknown>) => {
      const n = Number(args.number);
      const pull = repo.pulls.find((p) => p.number === n);
      return pull ? pullObj(repo, pull) : null;
    },
  };
}

function nodeById(ctx: Ctx, id: unknown): Record<string, unknown> | null {
  const d = decodeGid(id);
  if (!d) return null;
  if (d.kind === 'Repository') {
    const repo = findRepoById(ctx.store, Number(d.parts[0]));
    return repo ? repoObj(ctx, repo) : null;
  }
  if (d.kind === 'Issue') {
    const found = issueFromGid(ctx.store, id);
    return found ? issueObj(found.repo, found.issue) : null;
  }
  if (d.kind === 'PullRequest') {
    const found = pullFromGid(ctx.store, id);
    return found ? pullObj(found.repo, found.pull) : null;
  }
  return null;
}

function searchConnection(ctx: Ctx, args: Record<string, unknown>): Record<string, unknown> {
  const raw = typeof args.query === 'string' ? args.query : '';
  const words = raw
    .split(/\s+/)
    .filter((w) => w !== '' && !w.includes(':'))
    .map((w) => w.toLowerCase());
  const hits: { repo: Repo; issue: Issue }[] = [];
  for (const repo of ctx.store.repos.values()) {
    for (const issue of repo.issues) {
      const hay = `${issue.title} ${issue.body}`.toLowerCase();
      if (words.length === 0 || words.every((w) => hay.includes(w))) hits.push({ repo, issue });
    }
  }
  hits.sort((a, b) => b.issue.number - a.issue.number);
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : 10;
  const page = hits.slice(0, first);
  const nodes = page.map((h) => issueObj(h.repo, h.issue));
  return {
    __typename: 'SearchResultItemConnection',
    nodes,
    edges: nodes.map((n, i) => ({ __typename: 'IssueEdge', node: n, cursor: cursorFor(page[i]!.repo.id, page[i]!.issue.number) })),
    totalCount: hits.length,
    issueCount: hits.length,
    pageInfo: {
      hasNextPage: hits.length > page.length,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor(page[0]!.repo.id, page[0]!.issue.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.repo.id, page[page.length - 1]!.issue.number) : null,
    },
  };
}

function queryRoot(ctx: Ctx): Record<string, unknown> {
  return {
    __typename: 'Query',
    viewer: () => userObj(shopUser().login),
    repository: (args: Record<string, unknown>) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoObj(ctx, repo) : null;
    },
    node: (args: Record<string, unknown>) => nodeById(ctx, args.id),
    search: (args: Record<string, unknown>) => searchConnection(ctx, args),
    __type: (args: Record<string, unknown>) => (typeof args.name === 'string' ? typeObject(args.name) : null),
    __schema: () => schemaObject(),
  };
}

function mutationRoot(ctx: Ctx): Record<string, unknown> {
  const inputOf = (args: Record<string, unknown>): Record<string, unknown> =>
    (args.input ?? {}) as Record<string, unknown>;
  return {
    __typename: 'Mutation',
    createIssue: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const repo = repoFromGid(ctx.store, input.repositoryId);
      if (!repo) throw new Error('repository not found for the given repositoryId');
      const title = String(input.title ?? '');
      if (title === '') throw new Error('createIssue requires a title');
      const issue = createIssueInStore(ctx.store, repo, title, String(input.body ?? ''));
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const found = issueFromGid(ctx.store, input.issueId);
      if (!found) throw new Error('issue not found for the given issueId');
      found.issue.state = 'closed';
      found.issue.updated_at = FIXED_DATE;
      invalidateIssueBody(found.issue);
      return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const repo = repoFromGid(ctx.store, input.repositoryId);
      if (!repo) throw new Error('repository not found for the given repositoryId');
      const pull = createPullInStore(
        ctx.store,
        repo,
        String(input.baseRefName ?? ''),
        String(input.headRefName ?? ''),
        String(input.title ?? ''),
        String(input.body ?? ''),
      );
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const found = pullFromGid(ctx.store, input.pullRequestId);
      if (!found) throw new Error('pull request not found for the given pullRequestId');
      mergePullInStore(ctx.store, found.repo, found.pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const found = issueFromGid(ctx.store, input.subjectId);
      if (!found) throw new Error('subject not found for the given subjectId');
      const body = String(input.body ?? '');
      const id = found.repo.nextCommentId;
      found.repo.nextCommentId += 1;
      const comment = {
        id,
        body,
        user: shopUser(),
        created_at: FIXED_DATE,
        updated_at: FIXED_DATE,
      };
      found.issue.comments.push(comment);
      invalidateIssueBody(found.issue);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: commentObj(found.repo, comment),
          cursor: cursorFor(found.repo.id, id),
        },
        clientMutationId: (input.clientMutationId as string | undefined) ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface ResolverCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Record<string, FragmentDef>;
  errors: { message: string }[];
}

function resolveSelections(
  value: Record<string, unknown>,
  typeName: string,
  selections: Selection[],
  ctx: ResolverCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = SCHEMA[typeName] ?? {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments[sel.name];
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".` });
        continue;
      }
      if (frag.typeCondition === typeName || frag.typeCondition === 'Node') {
        Object.assign(out, resolveSelections(value, typeName, frag.selections, ctx));
      }
      continue;
    }
    if (sel.kind === 'inline') {
      if (!sel.typeCondition || sel.typeCondition === typeName || sel.typeCondition === 'Node') {
        const innerType = sel.typeCondition ?? typeName;
        Object.assign(out, resolveSelections(value, innerType, sel.selections, ctx));
      }
      continue;
    }
    const outName = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[outName] = (value.__typename as string | undefined) ?? typeName;
      continue;
    }
    if (!(sel.name in known)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[outName] = null;
      continue;
    }
    let raw: unknown = value[sel.name];
    if (typeof raw === 'function') {
      try {
        raw = (raw as (a: Record<string, unknown>, c: Ctx) => unknown)(resolveArgs(sel.args, ctx.variables), { store: ctx.store });
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[outName] = null;
        continue;
      }
    }
    const childType = known[sel.name]!;
    if (raw === null || raw === undefined) {
      out[outName] = null;
      continue;
    }
    if (!sel.selections || sel.selections.length === 0) {
      out[outName] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      const elemType = childType.startsWith('[') ? childType.slice(1, -1) : childType;
      out[outName] = raw.map((item) =>
        item === null || item === undefined
          ? null
          : typeof item === 'object'
            ? resolveSelections(item as Record<string, unknown>, (item as Record<string, unknown>).__typename as string | undefined ?? elemType, sel.selections!, ctx)
            : item,
      );
      continue;
    }
    if (typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const actual = (obj.__typename as string | undefined) ?? childType;
      out[outName] = resolveSelections(obj, actual, sel.selections, ctx);
      continue;
    }
    out[outName] = raw;
  }
  return out;
}

function executeOperation(
  store: Store,
  doc: Document,
  op: Operation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: ResolverCtx = { store, variables, fragments: doc.fragments, errors: [] };
  const isMutation = op.type === 'mutation';
  const root = isMutation ? mutationRoot({ store }) : queryRoot({ store });
  const rootType = isMutation ? 'Mutation' : 'Query';
  const data = resolveSelections(root, rootType, op.selections, ctx);
  return { data, errors: ctx.errors };
}

function executeOne(
  store: Store,
  body: unknown,
): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object with a query string.' }] };
  }
  const rec = body as Record<string, unknown>;
  const query = rec.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL request must include a query string.' }] };
  }
  const variables =
    rec.variables !== null && typeof rec.variables === 'object' && !Array.isArray(rec.variables)
      ? (rec.variables as Record<string, unknown>)
      : {};
  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'GraphQL document contains no operation.' }] };
  }
  let op: Operation | undefined;
  if (typeof rec.operationName === 'string' && rec.operationName !== '') {
    op = doc.operations.find((o) => o.name === rec.operationName);
    if (!op) return { data: null, errors: [{ message: `Unknown operation named "${String(rec.operationName)}".` }] };
  } else {
    op = doc.operations[0];
  }
  return executeOperation(store, doc, op, variables);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  if (req.method !== 'POST' || (path !== '/api/graphql' && path !== '/api/graphql/')) return false;
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Could not read request body' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? null : JSON.parse(text);
  } catch {
    sendJson(res, 400, { message: 'Invalid JSON' });
    return true;
  }
  if (parsed === null || (typeof parsed !== 'object' && !Array.isArray(parsed))) {
    sendJson(res, 400, { message: 'Invalid JSON' });
    return true;
  }
  if (Array.isArray(parsed)) {
    // GitHub operation batching: one result per operation, in order.
    const results = parsed.map((entry) => {
      const r = executeOne(store, entry);
      return r.errors.length > 0 ? { data: r.data, errors: r.errors } : { data: r.data };
    });
    sendJson(res, 200, results);
    return true;
  }
  const result = executeOne(store, parsed);
  sendJson(res, 200, result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data });
  return true;
}
