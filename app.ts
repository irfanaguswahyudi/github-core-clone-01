// HTTP server: routing, auth, JSON envelopes, request ids.
// main.ts owns the lifecycle; this file owns the forge's surface.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './src/git.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;
function nextRequestId(): string { requestCounter += 1; return `forge-${requestCounter}`; }

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), ...extra };
  if (body !== null) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (token === '') return header.startsWith('Bearer ') && header.length > 7;
    return header === `Bearer ${token}`;
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let url: URL;
      try { url = new URL(req.url ?? '/', 'http://entry'); } catch { sendJson(res, 404, { message: 'Not Found' }); return; }
      const path = url.pathname;
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

      if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }

      // Every other surface requires the trial bearer token.
      if (!authorized(req)) { sendJson(res, 401, { message: 'Unauthorized' }); return; }

      let raw: Buffer;
      try { raw = await readBody(req); } catch { sendJson(res, 400, { message: 'Bad Request' }); return; }

      try {
        // Git smart HTTP: /{owner}/{repo}.git/...
        if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
          const out = handleGit(store, { method, path, query: url.searchParams, headers, body: raw });
          if (out) { sendRaw(res, out.status, out.contentType, out.body); return; }
          sendJson(res, 404, { message: 'Not Found' }); return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
          let parsed: unknown;
          try { parsed = JSON.parse(raw.toString('utf8')); } catch { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
          const out = handleGraphQL(store, parsed);
          sendJson(res, out.status, out.body);
          return;
        }
        if (path === '/mcp') {
          if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
          const out = handleMcp(store, raw.toString('utf8'));
          if (out.body === null) { res.writeHead(out.status); res.end(); return; }
          sendJson(res, out.status, out.body);
          return;
        }
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          let parsed: unknown = undefined;
          if (raw.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
            try { parsed = JSON.parse(raw.toString('utf8')); } catch { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
          }
          const segments = path.replace(/^\/api\/v3\/?/, '').split('/').filter((s) => s !== '');
          const out = handleRest({ store, method, segments, query: url.searchParams, body: parsed, origin });
          if (!out) { sendJson(res, 404, { message: 'Not Found' }); return; }
          if (out.status === 204) {
            res.writeHead(204, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, out.status, out.body, out.headers ?? {});
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        sendJson(res, 500, { message: e instanceof Error ? e.message : 'Internal Server Error' });
      }
    })();
  });
}
