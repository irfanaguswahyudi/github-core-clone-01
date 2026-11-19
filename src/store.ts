// In-memory deterministic store for the forge.
// One owner (the token's login, fixed by the kit's seeded scenario), repos keyed by
// owner/name, git objects stored verbatim by SHA-1, issues/PRs sharing one counter
// per repo (GitHub numbering). No wall clock anywhere: every timestamp is fixed.
import { buildCommit, buildTree, collectReachable, hashObject, parseCommit, parseTree, parseTag, storeObject, ZERO_OID, type GitObject, type TreeEntry } from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FIXED_TS = 1735689600; // 2025-01-01T00:00:00Z, fixed for replay determinism
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const WHO = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

export interface Label { name: string; color: string; description?: string }
export interface Comment { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: Comment[]; seq: number; // creation order
}
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string; mergeBaseSha: string;
  merged: boolean; mergeCommitSha: string | null; mergedAt: string | null; seq: number;
  changedPaths: string[]; // head-vs-base file paths, computed at creation
}
export interface Repo {
  id: number; owner: string; name: string; description: string; private: boolean;
  defaultBranch: string; objects: Map<string, GitObject>; refs: Map<string, string>;
  labels: Map<string, Label>; issues: Issue[]; pulls: Pull[];
  nextNumber: number; nextCommentId: number; nextId: number; seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextGlobalId = 1;
  seq = 0;

  key(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.seq - b.seq);
  }
  createRepo(name: string, opts: { description?: string; private?: boolean } = {}): Repo | null {
    if (this.getRepo(VIEWER_LOGIN, name)) return null;
    const repo: Repo = {
      id: this.nextRepoId++, owner: VIEWER_LOGIN, name,
      description: opts.description ?? '', private: opts.private ?? false,
      defaultBranch: 'main', objects: new Map(), refs: new Map(),
      labels: new Map(), issues: [], pulls: [],
      nextNumber: 1, nextCommentId: 1, nextId: 1, seq: ++this.seq,
    };
    this.repos.set(this.key(repo.owner, name), repo);
    return repo;
  }
  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.key(owner, name)); }

  // ---- git objects ----
  lookup(repo: Repo, oid: string): GitObject | undefined { return repo.objects.get(oid); }
  tip(repo: Repo, ref: string): string | undefined { return repo.refs.get(ref); }
  defaultTip(repo: Repo): string | undefined { return repo.refs.get(`refs/heads/${repo.defaultBranch}`); }

  /** Flatten a commit's tree to path -> {mode, oid}. */
  flatten(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return out;
    for (const e of parseTree(tree.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') this.flatten(repo, e.oid, path, out);
      else out.set(path, { mode: e.mode, oid: e.oid });
    }
    return out;
  }

  /** Rebuild nested trees from a flat file map; returns root tree oid. */
  rebuildTree(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    interface Node { files: Map<string, { mode: string; oid: string }>; dirs: Map<string, Node> }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        let child = node.dirs.get(parts[i]);
        if (!child) { child = { files: new Map(), dirs: new Map() }; node.dirs.set(parts[i], child); }
        node = child;
      }
      node.files.set(parts[parts.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return storeObject(repo.objects, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on `branch` applying file changes (path -> Buffer | null delete). */
  commitFiles(repo: Repo, branch: string, changes: Map<string, Buffer | null>, message: string): { commitSha: string; treeSha: string } {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    let files = new Map<string, { mode: string; oid: string }>();
    if (parent) {
      const commit = repo.objects.get(parent);
      if (commit && commit.type === 'commit') files = this.flatten(repo, parseCommit(commit.data).tree);
    }
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else files.set(path, { mode: '100644', oid: storeObject(repo.objects, 'blob', content) });
    }
    const treeSha = this.rebuildTree(repo, files);
    const commitData = buildCommit(treeSha, parent ? [parent] : [], message, WHO, FIXED_TS);
    const commitSha = storeObject(repo.objects, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, treeSha };
  }

  /** Ancestor set of a commit (itself included). */
  ancestors(repo: Repo, tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return seen;
  }
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === ZERO_OID) return true;
    return this.ancestors(repo, tip).has(ancestor);
  }
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancA = this.ancestors(repo, a);
    // walk b's history breadth-first-ish by generation order: first common found walking from b
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length) {
      const oid = queue.shift()!;
      if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
      seen.add(oid);
      if (ancA.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return null;
  }
  /** Files changed between two commits (path -> {status, baseOid, headOid}). */
  diffFiles(repo: Repo, baseSha: string, headSha: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }> {
    const baseTree = baseSha && baseSha !== ZERO_OID ? parseCommit(repo.objects.get(baseSha)!.data).tree : '';
    const headTree = headSha && headSha !== ZERO_OID ? parseCommit(repo.objects.get(headSha)!.data).tree : '';
    const baseFiles = baseTree ? this.flatten(repo, baseTree) : new Map();
    const headFiles = headTree ? this.flatten(repo, headTree) : new Map();
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }> = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseFiles.get(path); const h = headFiles.get(path);
      if (b && !h) out.push({ path, status: 'removed', baseOid: b.oid, headOid: null });
      else if (!b && h) out.push({ path, status: 'added', baseOid: null, headOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', baseOid: b.oid, headOid: h.oid });
    }
    return out;
  }
  /** Commits reachable from tip, newest-first by walk order (parents after child). */
  listCommits(repo: Repo, tip: string, limit = 100): Array<{ sha: string; message: string }> {
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length && out.length < limit) {
      const oid = queue.shift()!;
      if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message });
      for (const p of c.parents) queue.push(p);
    }
    return out;
  }
  reachableObjects(repo: Repo, roots: string[]): Set<string> {
    return collectReachable(roots, (oid) => repo.objects.get(oid));
  }

  // ---- issues / pulls ----
  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      id: this.nextGlobalId++, number: repo.nextNumber++, title, body: body ?? '',
      state: 'open', labels, comments: [], seq: ++this.seq,
    };
    repo.issues.push(issue);
    return issue;
  }
  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return null;
    const mb = this.mergeBase(repo, headSha, baseSha) ?? baseSha;
    const changed = this.diffFiles(repo, mb, headSha).filter((d) => d.status !== 'removed');
    const pull: Pull = {
      id: this.nextGlobalId++, number: repo.nextNumber++, title, body: body ?? '',
      state: 'open', headRef, baseRef, headSha, baseSha: baseSha, mergeBaseSha: mb,
      merged: false, mergeCommitSha: null, mergedAt: null, seq: ++this.seq,
      changedPaths: changed.map((d) => d.path),
    };
    repo.pulls.push(pull);
    return pull;
  }
  /** True when the PR can no longer merge cleanly (base moved a file the PR also changed). */
  pullConflicted(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return false;
    const baseFiles = this.flatten(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
    const mbFiles = pull.mergeBaseSha ? this.flatten(repo, parseCommit(repo.objects.get(pull.mergeBaseSha)!.data).tree) : new Map();
    const headFiles = this.flatten(repo, parseCommit(repo.objects.get(pull.headSha)!.data).tree);
    for (const d of this.diffFiles(repo, pull.mergeBaseSha, pull.headSha)) {
      if (d.status === 'removed') continue;
      const baseEntry = baseFiles.get(d.path);
      const mbEntry = mbFiles.get(d.path);
      const headEntry = headFiles.get(d.path);
      const baseChanged = (baseEntry?.oid ?? null) !== (mbEntry?.oid ?? null);
      if (baseChanged && (baseEntry?.oid ?? null) !== (headEntry?.oid ?? null)) return true;
    }
    return false;
  }
  /** Squash-merge: apply the PR's head files onto the base tip, one commit. Returns sha or null. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflicted(repo, pull)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return null;
    const files = this.flatten(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
    const headFiles = this.flatten(repo, parseCommit(repo.objects.get(pull.headSha)!.data).tree);
    for (const d of this.diffFiles(repo, pull.mergeBaseSha, pull.headSha)) {
      if (d.status === 'removed') files.delete(d.path);
      else if (d.headOid) files.set(d.path, { mode: headFiles.get(d.path)?.mode ?? '100644', oid: d.headOid });
    }
    const treeSha = this.rebuildTree(repo, files);
    const msg = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const commitSha = storeObject(repo.objects, 'commit', buildCommit(treeSha, [baseTip], msg, WHO, FIXED_TS));
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'closed'; pull.merged = true; pull.mergeCommitSha = commitSha; pull.mergedAt = FIXED_ISO;
    return commitSha;
  }

  // ---- JSON views (GitHub shapes) ----
  repoView(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id, node_id: `R_${repo.id}`, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      created_at: FIXED_ISO, updated_at: FIXED_ISO, pushed_at: FIXED_ISO,
      has_issues: true, has_projects: true, has_wiki: true, forks_count: 0, stargazers_count: 0,
      watchers_count: 0, open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    };
  }
  issueView(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id, node_id: `I_${issue.id}`, number: issue.number, title: issue.title,
      body: issue.body, state: issue.state, user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description ?? '' })),
      comments: issue.comments.length, comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
      created_at: FIXED_ISO, updated_at: FIXED_ISO, closed_at: issue.state === 'closed' ? FIXED_ISO : null,
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    };
  }
  pullView(repo: Repo, pull: Pull): Record<string, unknown> {
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    return {
      id: pull.id, node_id: `PR_${pull.id}`, number: pull.number, title: pull.title,
      body: pull.body, state: pull.state,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      head: { ref: pull.headRef, sha: headSha, label: `${VIEWER_LOGIN}:${pull.headRef}`, repo: this.repoView(repo) },
      base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}`, repo: this.repoView(repo) },
      merged: pull.merged, mergeable: this.pullConflicted(repo, pull) ? false : true,
      merge_commit_sha: pull.mergeCommitSha, merged_at: pull.mergedAt,
      created_at: FIXED_ISO, updated_at: FIXED_ISO, closed_at: pull.state === 'closed' ? FIXED_ISO : null,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }
  pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const d of this.diffFiles(repo, pull.mergeBaseSha, pull.headSha)) {
      const headContent = d.headOid ? repo.objects.get(d.headOid)?.data : null;
      const baseContent = d.baseOid ? repo.objects.get(d.baseOid)?.data : null;
      const additions = headContent ? headContent.toString('utf8').split('\n').length : 0;
      const deletions = baseContent ? baseContent.toString('utf8').split('\n').length : 0;
      out.push({
        filename: d.path, status: d.status === 'removed' ? 'removed' : (d.baseOid ? 'modified' : 'added'),
        additions: d.status === 'removed' ? 0 : Math.max(1, additions),
        deletions: d.status === 'added' ? 0 : deletions,
        changes: Math.max(1, additions + deletions),
        sha: d.headOid ?? d.baseOid, blob_url: '', raw_url: '', contents_url: '',
      });
    }
    return out;
  }
  globalId(kind: string, dbId: number): string {
    return Buffer.from(`${kind}:${dbId}`, 'utf8').toString('base64');
  }
  parseGlobalId(id: string): { kind: string; dbId: number } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const m = /^([A-Za-z]+):(\d+)$/.exec(text);
      if (!m) return null;
      return { kind: m[1], dbId: Number(m[2]) };
    } catch { return null; }
  }
  findRepoById(dbId: number): Repo | undefined {
    return [...this.repos.values()].find((r) => r.id === dbId);
  }
  findIssueById(dbId: number): { repo: Repo; issue: Issue } | undefined {
    for (const repo of this.repos.values()) {
      const issue = repo.issues.find((i) => i.id === dbId);
      if (issue) return { repo, issue };
    }
    return undefined;
  }
  findPullById(dbId: number): { repo: Repo; pull: Pull } | undefined {
    for (const repo of this.repos.values()) {
      const pull = repo.pulls.find((p) => p.id === dbId);
      if (pull) return { repo, pull };
    }
    return undefined;
  }
}
export { hashObject };
