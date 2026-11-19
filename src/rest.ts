// REST v3: repos, branches, commits, contents, labels, issues, pulls.
// All replies are JSON; the app layer adds X-GitHub-Request-Id.
import { Buffer } from 'node:buffer';
import { parseCommit, ZERO_OID } from './gitobj.ts';
import { FIXED_ISO, VIEWER_ID, VIEWER_LOGIN, type Repo, type Store } from './store.ts';

export interface RestCtx {
  store: Store;
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: unknown;
  origin: string;
}
export type RestResult = { status: number; body: unknown; headers?: Record<string, string> } | null;

const notFound = (msg = 'Not Found'): RestResult => ({ status: 404, body: { message: msg } });
const badRequest = (msg: string): RestResult => ({ status: 400, body: { message: msg } });
const unprocessable = (msg: string): RestResult => ({ status: 422, body: { message: msg } });
const ok = (body: unknown, status = 200, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const jsonBody = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function repoOf(ctx: RestCtx, owner: string, name: string): Repo | undefined {
  return ctx.store.getRepo(owner, name);
}

function pageParams(ctx: RestCtx): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  return { page, perPage };
}
function paginate<T>(ctx: RestCtx, items: T[], basePath: string): RestResult {
  const { page, perPage } = pageParams(ctx);
  const total = items.length;
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const q = new URLSearchParams(ctx.query);
  if (page * perPage < total) {
    q.set('page', String(page + 1)); q.set('per_page', String(perPage));
    const next = `${ctx.origin}${basePath}?${q.toString()}`;
    q.set('page', String(Math.ceil(total / perPage)));
    headers.link = `<${next}>; rel="next", <${ctx.origin}${basePath}?${q.toString()}>; rel="last"`;
  }
  return ok(slice, 200, headers);
}

function branchTip(repo: Repo, branch?: string): string | undefined {
  if (!branch) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return repo.refs.get(`refs/heads/${branch}`);
}

function fileAt(store: Store, repo: Repo, tip: string | undefined, path: string): { blobOid: string; data: Buffer } | { dir: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> } | null {
  if (!tip) return null;
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return null;
  const files = repoFiles(store, repo, tip);
  const direct = files.get(path);
  if (direct) {
    const obj = repo.objects.get(direct.oid);
    if (!obj) return null;
    return { blobOid: direct.oid, data: obj.data };
  }
  // directory?
  const prefix = `${path}/`;
  const entries = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir' }>();
  for (const [p, e] of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0];
    if (rest.includes('/')) {
      entries.set(first, { name: first, path: `${path}/${first}`, sha: '', type: 'dir' });
    } else {
      entries.set(first, { name: first, path: p, sha: e.oid, type: 'file' });
    }
  }
  if (entries.size === 0) return null;
  // dir shas: compute from tree objects where possible; fall back to empty-tree hash
  return { dir: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function repoFiles(store: Store, repo: Repo, tip: string): Map<string, { mode: string; oid: string }> {
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return new Map();
  return store.flatten(repo, parseCommit(commit.data).tree);
}

export function handleRest(ctx: RestCtx): RestResult {
  const { store } = ctx;
  const seg = ctx.segments;
  const method = ctx.method;

  // --- root / meta / user ---
  if (seg.length === 0) {
    if (method === 'GET') return ok({ current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, 200, { 'x-oauth-scopes': 'repo, read:org' });
    return notFound();
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method === 'GET') return ok({ installed_version: '1.0.0' });
    return notFound();
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method === 'GET') return ok({ login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: `${VIEWER_LOGIN}@example.invalid`, type: 'User' });
    return notFound();
  }
  if (seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN).map((r) => store.repoView(r));
      return paginate(ctx, repos, '/api/v3/user/repos');
    }
    if (method === 'POST') {
      const b = jsonBody(ctx.body);
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name) return unprocessable('name is required');
      const repo = store.createRepo(name, { description: typeof b.description === 'string' ? b.description : '', private: b.private === true });
      if (!repo) return unprocessable('Repository already exists');
      return ok(store.repoView(repo), 201);
    }
    return notFound();
  }

  // --- /repos/{owner}/{repo}/... ---
  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = decodeURIComponent(seg[1]);
  const repoName = decodeURIComponent(seg[2]);
  const repo = repoOf(ctx, owner, repoName);
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (!repo) return notFound();
    if (method === 'GET') return ok(store.repoView(repo));
    if (method === 'PATCH') {
      const b = jsonBody(ctx.body);
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.private = b.private;
      return ok(store.repoView(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return notFound();
  }
  if (!repo) return notFound();

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) }, protected: false }));
      return ok(list);
    }
    if (rest.length === 2 && method === 'GET') {
      const name = decodeURIComponent(rest[1]);
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (!sha) return notFound();
      return ok({ name, commit: { sha }, protected: false });
    }
    return notFound();
  }
  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = ctx.query.get('sha');
    const tip = shaParam ? (repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.get(shaParam)?.type === 'commit' ? shaParam : undefined)) : branchTip(repo);
    if (!tip) return ok([]);
    const list = store.listCommits(repo, tip).map((c) => ({
      sha: c.sha,
      commit: { message: c.message, author: { name: 'ada iversen', email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_ISO }, committer: { name: 'ada iversen', email: `${VIEWER_LOGIN}@example.invalid`, date: FIXED_ISO } },
      author: { login: VIEWER_LOGIN, id: VIEWER_ID },
      committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
      url: `/api/v3/repos/${owner}/${repoName}/commits/${c.sha}`,
    }));
    return ok(list);
  }
  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const b = jsonBody(ctx.body);
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/heads/') || !repo.objects.get(sha)) return unprocessable('invalid ref or sha');
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}` }, 201);
    }
    if (method === 'GET' && rest.length >= 3) {
      const refPath = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
      const fullRef = `refs/${refPath}`;
      const sha = repo.refs.get(fullRef);
      if (!sha) return notFound();
      return ok({ ref: fullRef, object: { sha, type: 'commit' } });
    }
    if (method === 'GET' && rest.length === 2) {
      return ok([...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } })));
    }
    return notFound();
  }
  // contents
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (method === 'GET') {
      const refParam = ctx.query.get('ref');
      const tip = refParam ? (repo.refs.get(`refs/heads/${refParam}`) ?? (repo.objects.get(refParam)?.type === 'commit' ? refParam : undefined)) : branchTip(repo);
      if (!tip) return notFound();
      if (!filePath) {
        // root directory
        const files = repoFiles(store, repo, tip);
        const top = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir' }>();
        for (const [p, e] of files) {
          const first = p.split('/')[0];
          if (p.includes('/')) top.set(first, { name: first, path: first, sha: '', type: 'dir' });
          else top.set(first, { name: first, path: p, sha: e.oid, type: 'file' });
        }
        return ok([...top.values()].sort((a, b) => a.name.localeCompare(b.name)));
      }
      const found = fileAt(store, repo, tip, filePath);
      if (!found) return notFound();
      if ('dir' in found) return ok(found.dir);
      return ok({
        type: 'file', encoding: 'base64', size: found.data.length, name: filePath.split('/').pop(),
        path: filePath, content: found.data.toString('base64'), sha: found.blobOid,
        url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
      });
    }
    if (method === 'PUT') {
      const b = jsonBody(ctx.body);
      const message = typeof b.message === 'string' ? b.message : 'update';
      const contentB64 = typeof b.content === 'string' ? b.content : '';
      if (!contentB64) return unprocessable('content is required');
      const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip && branch !== repo.defaultBranch) {
        // create the branch at the default tip (MCP fallback path)
        const defTip = branchTip(repo);
        if (!defTip) return notFound('branch not found');
        repo.refs.set(`refs/heads/${branch}`, defTip);
        tip = defTip;
      }
      const existing = tip ? fileAt(store, repo, tip, filePath) : null;
      const existingBlob = existing && 'blobOid' in existing ? existing.blobOid : null;
      if (existingBlob) {
        if (typeof b.sha !== 'string' || b.sha.toLowerCase() !== existingBlob.toLowerCase()) {
          return { status: 409, body: { message: 'sha does not match' } };
        }
      }
      const changes = new Map<string, Buffer | null>([[filePath, content]]);
      const { commitSha } = store.commitFiles(repo, branch, changes, message);
      const blobOid = repo.objects.get(commitSha) ? store.flatten(repo, parseCommit(repo.objects.get(commitSha)!.data).tree).get(filePath)?.oid ?? '' : '';
      return ok({
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message },
      }, existingBlob ? 200 : 201);
    }
    if (method === 'DELETE') {
      const b = jsonBody(ctx.body);
      const message = typeof b.message === 'string' ? b.message : 'delete';
      const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip) return notFound();
      const existing = fileAt(store, repo, tip, filePath);
      if (!existing || !('blobOid' in existing)) return notFound();
      // Optimistic concurrency: when the caller supplies the blob sha it must
      // be the current blob; a stale sha conflicts and deletes nothing.
      if (typeof b.sha === 'string' && b.sha !== '' && b.sha !== existing.blobOid) {
        return { status: 409, body: { message: 'sha does not match the current blob' } };
      }
      const { commitSha } = store.commitFiles(repo, branch, new Map([[filePath, null]]), message);
      return ok({ commit: { sha: commitSha, message } });
    }
    return notFound();
  }
  // labels
  if (rest[0] === 'labels') {
    if (method === 'POST') {
      const b = jsonBody(ctx.body);
      const name = typeof b.name === 'string' ? b.name : '';
      if (!name) return unprocessable('name is required');
      const label = { name, color: typeof b.color === 'string' ? b.color : 'ededed', description: typeof b.description === 'string' ? b.description : '' };
      repo.labels.set(name, label);
      return ok(label, 201);
    }
    if (method === 'GET') return ok([...repo.labels.values()]);
    return notFound();
  }
  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const b = jsonBody(ctx.body);
        const title = typeof b.title === 'string' ? b.title : '';
        const bodyText = typeof b.body === 'string' ? b.body : '';
        const labelNames = Array.isArray(b.labels) ? b.labels : [];
        const labels: Array<{ name: string; color: string; description?: string }> = [];
        for (const ln of labelNames) {
          const name = typeof ln === 'string' ? ln : (ln as Record<string, unknown>)?.name;
          if (typeof name !== 'string') continue;
          const label = repo.labels.get(name);
          if (!label) return unprocessable(`Label does not exist: ${name}`);
          labels.push(label);
        }
        const issue = store.createIssue(repo, title, bodyText, labels);
        return ok(store.issueView(repo, issue), 201);
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = repo.issues.slice();
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        if (sort === 'created') list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
        return paginate(ctx, list.map((i) => store.issueView(repo, i)), `/api/v3/repos/${owner}/${repoName}/issues`);
      }
      return notFound();
    }
    const num = Number(rest[1]);
    const issue = repo.issues.find((i) => i.number === num);
    if (rest.length === 2) {
      if (!issue) return notFound();
      if (method === 'GET') return ok(store.issueView(repo, issue));
      if (method === 'PATCH') {
        const b = jsonBody(ctx.body);
        if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        return ok(store.issueView(repo, issue));
      }
      return notFound();
    }
    if (rest[2] === 'comments') {
      if (!issue) return notFound();
      if (method === 'POST') {
        const b = jsonBody(ctx.body);
        const comment = { id: repo.nextCommentId++, body: typeof b.body === 'string' ? b.body : '', user: { login: VIEWER_LOGIN }, created_at: FIXED_ISO, updated_at: FIXED_ISO };
        issue.comments.push(comment);
        return ok({ ...comment, html_url: '', url: `/api/v3/repos/${owner}/${repoName}/issues/${num}/comments/${comment.id}` }, 201);
      }
      if (method === 'GET') return ok(issue.comments.map((c) => ({ ...c, html_url: '', url: `/api/v3/repos/${owner}/${repoName}/issues/${num}/comments/${c.id}` })));
      return notFound();
    }
    return notFound();
  }
  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const b = jsonBody(ctx.body);
        const title = typeof b.title === 'string' ? b.title : '';
        const bodyText = typeof b.body === 'string' ? b.body : '';
        const head = typeof b.head === 'string' ? b.head.split(':').pop()! : '';
        const base = typeof b.base === 'string' ? b.base.split(':').pop()! : repo.defaultBranch;
        if (!head || !repo.refs.get(`refs/heads/${head}`)) return unprocessable('head branch not found');
        if (!repo.refs.get(`refs/heads/${base}`)) return unprocessable('base branch not found');
        const pull = store.createPull(repo, title, bodyText, head, base);
        if (!pull) return unprocessable('could not create pull request');
        return ok(store.pullView(repo, pull), 201);
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = repo.pulls.slice();
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        list.sort((a, b) => b.seq - a.seq);
        return paginate(ctx, list.map((p) => store.pullView(repo, p)), `/api/v3/repos/${owner}/${repoName}/pulls`);
      }
      return notFound();
    }
    const num = Number(rest[1]);
    const pull = repo.pulls.find((p) => p.number === num);
    if (rest.length === 2) {
      if (!pull) return notFound();
      if (method === 'GET') return ok(store.pullView(repo, pull));
      return notFound();
    }
    if (rest[2] === 'files' && method === 'GET') {
      if (!pull) return notFound();
      return ok(store.pullFiles(repo, pull));
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (!pull) return notFound();
      if (pull.merged) return ok({ sha: pull.mergeCommitSha, merged: true, message: 'Pull request successfully merged' });
      if (store.pullConflicted(repo, pull)) return { status: 405, body: { message: 'Merge conflict' } };
      const sha = store.squashMerge(repo, pull);
      if (!sha) return { status: 405, body: { message: 'Merge conflict' } };
      return ok({ sha, merged: true, message: 'Pull request successfully merged' });
    }
    return notFound();
  }
  void ZERO_OID;
  return notFound();
}
