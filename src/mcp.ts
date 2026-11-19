// MCP endpoint: JSON-RPC 2.0 Streamable HTTP.
// Modern era (2026-07-28) via server/discover, plus legacy initialize handshake.
// Tools act on the same store as REST; tool list is frozen so repeats are byte-identical.
import { FIXED_ISO, VIEWER_LOGIN, type Store } from './store.ts';

const SERVER_INFO = { name: 'github-core-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}
const str = (description: string): { type: string; description: string } => ({ type: 'string', description });
const bool = (description: string): { type: string; description: string } => ({ type: 'boolean', description });

const TOOLS: ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: str('Repository name'), description: str('Repository description'), private: bool('Whether the repository is private') }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: str('Repository owner login'), repo: str('Repository name') }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: str('Repository owner login'), repo: str('Repository name'), title: str('Issue title'), body: str('Issue body') }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: str('Repository owner login'), repo: str('Repository name'), state: str('Issue state: open, closed or all') }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: { type: 'object', properties: { owner: str('Repository owner login'), repo: str('Repository name'), title: str('Pull request title'), body: str('Pull request body'), head: str('Head branch name'), base: str('Base branch name') }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: { type: 'object', properties: { owner: str('Repository owner login'), repo: str('Repository name'), pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
]);

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError };
}
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Split "owner/repo" or use owner+repo args. */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  const full = typeof args.full_name === 'string' ? args.full_name : (typeof args.repo_full_name === 'string' ? args.repo_full_name : '');
  if (full && full.includes('/')) { const [o, r] = full.split('/'); owner = owner || o; repo = repo || r; }
  if (repo.includes('/')) { const [o, r] = repo.split('/'); owner = owner || o; repo = r; }
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { ok: boolean; result: Record<string, unknown> } {
  const missing = (tool: ToolDef): string | null => {
    for (const req of tool.inputSchema.required) {
      if (args[req] === undefined || args[req] === null || args[req] === '') return req;
    }
    return null;
  };
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, result: toolError(`Unknown tool: ${name}`) };
  const miss = missing(tool);
  if (miss) return { ok: false, result: toolError(`Missing required argument: ${miss}`) };

  if (name === 'create_repo') {
    const repoName = String(args.name);
    const repo = store.createRepo(repoName, { description: typeof args.description === 'string' ? args.description : '', private: args.private === true });
    if (!repo) {
      const existing = store.getRepo(VIEWER_LOGIN, repoName);
      if (existing) return { ok: true, result: toolResult(store.repoView(existing)) };
      return { ok: false, result: toolError('could not create repository') };
    }
    return { ok: true, result: toolResult(store.repoView(repo)) };
  }
  const { owner, repo: repoName } = resolveRepoArgs(args);
  const repo = store.getRepo(owner, repoName);
  if (name === 'get_repo') {
    if (!repo) return { ok: false, result: toolError(`repository not found: ${owner}/${repoName}`) };
    return { ok: true, result: toolResult(store.repoView(repo)) };
  }
  if (!repo) return { ok: false, result: toolError(`repository not found: ${owner}/${repoName}`) };
  if (name === 'create_issue') {
    const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return { ok: true, result: toolResult(store.issueView(repo, issue)) };
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = repo.issues.slice();
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    list.sort((a, b) => a.seq - b.seq);
    const payload = { issues: list.map((i) => store.issueView(repo, i)) };
    return { ok: true, result: toolResult(payload) };
  }
  if (name === 'create_pull_request') {
    const head = String(args.head).split(':').pop()!;
    const base = String(args.base).split(':').pop()!;
    const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
    if (!pull) return { ok: false, result: toolError('head or base branch not found') };
    return { ok: true, result: toolResult(store.pullView(repo, pull)) };
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return { ok: false, result: toolError(`pull request not found: ${number}`) };
    if (pull.merged) return { ok: true, result: toolResult({ merged: true, sha: pull.mergeCommitSha, message: 'Pull request successfully merged' }) };
    if (store.pullConflicted(repo, pull)) return { ok: false, result: toolError('Merge conflict') };
    const sha = store.squashMerge(repo, pull);
    if (!sha) return { ok: false, result: toolError('Merge conflict') };
    return { ok: true, result: toolResult({ merged: true, sha, message: 'Pull request successfully merged' }) };
  }
  return { ok: false, result: toolError(`Unknown tool: ${name}`) };
}

export interface McpOutcome {
  status: number;
  /** JSON value to send (null = no body, e.g. 202 for notifications). */
  body: unknown;
  headers?: Record<string, string>;
}

/** Handle one POST /mcp with the raw request body text. */
export function handleMcp(store: Store, rawBody: string): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = parsed as Record<string, unknown>;
  const id = (req.id === undefined ? null : req.id) as string | number | null;
  const method = typeof req.method === 'string' ? req.method : '';
  const isNotification = req.id === undefined;

  // Notifications get 202 with no body.
  if (isNotification) return { status: 202, body: null };
  const ok = (result: unknown): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const err = (code: number, message: string): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'server/discover') {
    return ok({
      resultType: 'DiscoverResult',
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: 'GitHub-compatible forge tools.',
    });
  }
  if (method === 'initialize') {
    const params = (req.params !== null && typeof req.params === 'object' ? req.params as Record<string, unknown> : {});
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const version = offered === '2026-07-28' ? '2026-07-28' : '2025-11-25';
    return ok({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = (req.params !== null && typeof req.params === 'object' ? req.params as Record<string, unknown> : {});
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)) ? params.arguments as Record<string, unknown> : {};
    // suffix / case-insensitive match (server prefix allowed)
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const wanted = norm(toolName);
    const tool = TOOLS.find((t) => norm(t.name) === wanted) ?? TOOLS.find((t) => wanted.endsWith(norm(t.name)));
    if (!tool) return err(-32602, `Unknown tool: ${toolName}`);
    const called = callTool(store, tool.name, args);
    return ok(called.result);
  }
  return err(-32601, `Method not found: ${method}`);
}
export { FIXED_ISO };
