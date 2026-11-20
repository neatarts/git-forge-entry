// The entry's HTTP server: one shared in-memory store, wired to the four
// surface modules (git smart HTTP, REST v3, GraphQL v4, MCP). main.ts owns
// the lifecycle (bind, register, wait-for-done); this file owns routing only.
//
// Every reply carries X-GitHub-Request-Id (the protocol checks assert it
// even on GET /api/v3/ and /healthz) and is application/json, never HTML.
// Auth lives in each module (Bearer $MAKEFUN_SHOP_TOKEN; any non-empty
// Bearer when the env var is unset, for local testing).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, nextRequestId } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; every reply gets a request id. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Path segments, without empty parts ('/api/v3/user' -> ['api','v3','user']). */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((part) => part.length > 0);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        const segments = segmentsOf(path);

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
        // No auth (the starter answered it without one, and the protocol check reads it bare).
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/... (claims synchronously, does I/O detached).
        if (handleGit(req, res, store, segments)) return;

        // REST v3: /api/v3/... (returns false for the root above and for non-API paths).
        if (await handleRest(req, res, store, segments)) return;

        // GraphQL v4: POST /api/graphql.
        if (await handleGraphql(req, res, store)) return;

        // MCP: POST/DELETE /mcp.
        if (await handleMcp(req, res, store)) return;

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never throw; this is the last-resort guard so one bad
        // request cannot take the server down mid-trial.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try { res.end(); } catch { /* already gone */ }
        }
      }
    })();
  });
}
