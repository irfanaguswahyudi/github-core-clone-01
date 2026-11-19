// GraphQL v4: a restricted selection parser + resolvers over the shared store.
// Covers exactly the documents gh / github-mcp-server send (see kit checks-graphql):
// viewer, repository (+ issue/issues/pullRequests/pullRequest), node(id:),
// __type introspection, and the five mutations. Batched arrays are answered in order.
import { FIXED_ISO, VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------- tokenizer ----------
type Tok =
  | { k: 'name'; v: string } | { k: 'int'; v: string } | { k: 'float'; v: string }
  | { k: 'string'; v: string } | { k: 'punct'; v: string } | { k: 'spread' };
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push({ k: 'spread' }); i += 3; continue; }
    if ('{}()[]:!=$@|&'.includes(c)) { toks.push({ k: 'punct', v: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'u' ? String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)) : e;
          j += e === 'u' ? 6 : 2;
        } else { out += src[j]; j++; }
      }
      toks.push({ k: 'string', v: out }); i = j + 1; continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      toks.push(raw.includes('.') || raw.includes('e') || raw.includes('E') ? { k: 'float', v: raw } : { k: 'int', v: raw });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ k: 'name', v: src.slice(i, j) }); i = j; continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return toks;
}

// ---------- parser ----------
interface ValueNode { kind: string; value?: unknown; items?: ValueNode[]; fields?: Array<{ name: string; value: ValueNode }>; }
interface Selection { alias?: string; name: string; args: Record<string, ValueNode>; selections?: Selection[]; typeCondition?: string; fragment?: boolean; directives?: Array<{ name: string; args: Record<string, ValueNode> }>; }
interface Operation { type: 'query' | 'mutation'; name?: string; varDefs: Record<string, { default?: ValueNode }>; selections: Selection[]; }
interface Document { operations: Operation[]; fragments: Map<string, Selection[]>; }

class Parser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok { const t = this.toks[this.pos++]; if (!t) throw new Error('unexpected end'); return t; }
  expectPunct(v: string): void { const t = this.next(); if (t.k !== 'punct' || t.v !== v) throw new Error(`expected ${v}`); }
  matchPunct(v: string): boolean { const t = this.peek(); if (t?.k === 'punct' && t.v === v) { this.pos++; return true; } return false; }
  expectName(): string { const t = this.next(); if (t.k !== 'name') throw new Error('expected name'); return t.v; }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.peek()) {
      const t = this.peek()!;
      if (t.k === 'punct' && t.v === '{') {
        operations.push({ type: 'query', varDefs: {}, selections: this.parseSelectionSet() });
        continue;
      }
      const kw = this.expectName();
      if (kw === 'fragment') {
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type name
        fragments.set(name, this.parseSelectionSet());
      } else if (kw === 'query' || kw === 'mutation') {
        let name: string | undefined;
        const nx = this.peek();
        if (nx?.k === 'name') name = this.next().v;
        const varDefs: Record<string, { default?: ValueNode }> = {};
        if (this.matchPunct('(')) {
          while (!this.matchPunct(')')) {
            this.expectPunct('$');
            const vname = this.expectName();
            this.expectPunct(':');
            this.parseTypeName();
            if (this.matchPunct('=')) varDefs[vname] = { default: this.parseValue() };
            else varDefs[vname] = {};
          }
        }
        operations.push({ type: kw, name, varDefs, selections: this.parseSelectionSet() });
      } else throw new Error(`unexpected ${kw}`);
    }
    return { operations, fragments };
  }
  parseTypeName(): void {
    if (this.matchPunct('[')) { this.parseTypeName(); this.expectPunct(']'); }
    else this.expectName();
    this.matchPunct('!');
  }
  parseDirectives(): Array<{ name: string; args: Record<string, ValueNode> }> {
    const dirs: Array<{ name: string; args: Record<string, ValueNode> }> = [];
    while (this.peek()?.k === 'punct' && this.peek()!.v === '@') {
      this.next();
      const name = this.expectName();
      const args: Record<string, ValueNode> = {};
      if (this.matchPunct('(')) {
        while (!this.matchPunct(')')) {
          const aname = this.expectName();
          this.expectPunct(':');
          args[aname] = this.parseValue();
        }
      }
      dirs.push({ name, args });
    }
    return dirs;
  }
  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!this.matchPunct('}')) sels.push(this.parseSelection());
    return sels;
  }
  parseSelection(): Selection {
    const t = this.peek()!;
    if (t.k === 'spread') {
      this.next();
      const nx = this.peek();
      if (nx?.k === 'name' && nx.v === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { name: '', args: {}, selections: this.parseSelectionSet(), typeCondition, fragment: true, directives };
      }
      const fragName = this.expectName();
      const directives = this.parseDirectives();
      return { name: '', args: {}, fragment: true, typeCondition: fragName, directives };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.matchPunct(':')) { alias = first; name = this.expectName(); }
    const args: Record<string, ValueNode> = {};
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        const aname = this.expectName();
        this.expectPunct(':');
        args[aname] = this.parseValue();
      }
    }
    const directives = this.parseDirectives();
    let selections: Selection[] | undefined;
    if (this.peek()?.k === 'punct' && this.peek()!.v === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections, directives };
  }
  parseValue(): ValueNode {
    const t = this.next();
    if (t.k === 'punct' && t.v === '$') return { kind: 'variable', value: this.expectName() };
    if (t.k === 'punct' && t.v === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.k === 'punct' && this.peek()!.v === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (t.k === 'punct' && t.v === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.k === 'punct' && this.peek()!.v === '}')) {
        const fname = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fname, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.k === 'string') return { kind: 'string', value: t.v };
    if (t.k === 'int') return { kind: 'int', value: Number(t.v) };
    if (t.k === 'float') return { kind: 'float', value: Number(t.v) };
    if (t.k === 'name') {
      if (t.v === 'true') return { kind: 'boolean', value: true };
      if (t.v === 'false') return { kind: 'boolean', value: false };
      if (t.v === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.v };
    }
    throw new Error('bad value');
  }
}

function resolveValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return vars[node.value as string];
    case 'list': return (node.items ?? []).map((i) => resolveValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields ?? []) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
    default: return node.value ?? null;
  }
}

// ---------- schema tables ----------
const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'mergedAt', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  CommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'type', 'args'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['queryType', 'mutationType', 'types', 'description'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};
const TYPE_KIND: Record<string, string> = {
  Issue: 'OBJECT', PullRequest: 'OBJECT', Repository: 'OBJECT', User: 'OBJECT',
  IssueConnection: 'OBJECT', PullRequestConnection: 'OBJECT', SearchType: 'ENUM',
  IssueState: 'ENUM', PullRequestState: 'ENUM', MergeableState: 'ENUM',
  RepositoryPermission: 'ENUM', IssueOrderField: 'ENUM', OrderDirection: 'ENUM',
  __Type: 'OBJECT', Query: 'OBJECT', Mutation: 'OBJECT',
};

// ---------- execution ----------
type GValue = { __type: string; [k: string]: unknown };
const isG = (v: unknown): v is GValue => v !== null && typeof v === 'object' && typeof (v as GValue).__type === 'string';

function issueState(issue: Issue): string { return issue.state === 'open' ? 'OPEN' : 'CLOSED'; }
function pullState(pull: Pull): string { return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'; }

export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  const ops = Array.isArray(body) ? body : [body];
  const results = ops.map((op) => executeOperation(store, op));
  return { status: 200, body: Array.isArray(body) ? results : results[0] };
}

function executeOperation(store: Store, opBody: unknown): Record<string, unknown> {
  const rec = (opBody !== null && typeof opBody === 'object' && !Array.isArray(opBody)) ? opBody as Record<string, unknown> : {};
  const query = typeof rec.query === 'string' ? rec.query : '';
  const variables = (rec.variables !== null && typeof rec.variables === 'object' && !Array.isArray(rec.variables)) ? rec.variables as Record<string, unknown> : {};
  const operationName = typeof rec.operationName === 'string' ? rec.operationName : undefined;
  try {
    const doc = new Parser(tokenize(query)).parseDocument();
    let operation = doc.operations[0];
    if (operationName) operation = doc.operations.find((o) => o.name === operationName) ?? operation;
    if (!operation) return { data: null, errors: [{ message: 'no operation' }] };
    const vars: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(operation.varDefs)) {
      if (k in variables) vars[k] = variables[k];
      else if (def.default) vars[k] = resolveValue(def.default, variables);
      else vars[k] = null;
    }
    for (const [k, v] of Object.entries(variables)) if (!(k in vars)) vars[k] = v;
    const errors: Array<{ message: string }> = [];
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data: Record<string, unknown> = {};
    for (const sel of expandSelections(operation.selections, doc, vars)) {
      const key = sel.alias ?? sel.name;
      const value = resolveTop(store, rootType, sel, vars, errors, doc);
      mergeInto(data, key, value);
    }
    const out: Record<string, unknown> = { data };
    if (errors.length) out.errors = errors;
    return out;
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}

function directiveApplies(sel: Selection, vars: Record<string, unknown>): boolean {
  for (const d of sel.directives ?? []) {
    const cond = resolveValue(d.args.if ?? { kind: 'boolean', value: false }, vars);
    if (d.name === 'skip' && cond === true) return false;
    if (d.name === 'include' && cond !== true) return false;
  }
  return true;
}

// Merge a projected field into its parent object: repeated selections of the
// same response key (e.g. `viewer { login } viewer { id }`) combine instead
// of the later one overwriting the earlier.
function mergeInto(out: Record<string, unknown>, key: string, value: unknown): void {
  const prev = out[key];
  const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isRec(prev) && isRec(value)) {
    for (const [k, v] of Object.entries(value)) mergeInto(prev, k, v);
    return;
  }
  out[key] = value;
}

function expandSelections(sels: Selection[], doc: Document, vars?: Record<string, unknown>): Selection[] {
  const out: Selection[] = [];
  for (const s of sels) {
    if (vars && !directiveApplies(s, vars)) continue;
    if (s.fragment) {
      if (s.typeCondition && doc.fragments.has(s.typeCondition)) {
        out.push(...expandSelections(doc.fragments.get(s.typeCondition)!, doc, vars));
      } else if (s.selections) {
        out.push(...expandSelections(s.selections, doc, vars));
      }
      continue;
    }
    out.push(s);
  }
  return out;
}

function validateSelections(typeName: string, sels: Selection[], errors: Array<{ message: string }>, doc: Document): boolean {
  let ok = true;
  for (const s of expandSelections(sels, doc)) {
    const allowed = FIELDS[typeName];
    if (allowed && !allowed.includes(s.name)) {
      errors.push({ message: `Cannot query field "${s.name}" on type "${typeName}".` });
      ok = false;
    }
  }
  return ok;
}

function argsOf(sel: Selection, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) out[k] = resolveValue(v, vars);
  return out;
}

function project(store: Store, typeName: string, value: GValue, sels: Selection[] | undefined, vars: Record<string, unknown>, errors: Array<{ message: string }>, doc: Document): Record<string, unknown> | null {
  if (!value) return null;
  if (!sels) return null;
  const out: Record<string, unknown> = {};
  for (const sel of expandSelections(sels, doc, vars)) {
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') { out[key] = typeName; continue; }
    const fieldValue = resolveField(store, typeName, value, sel, vars, errors, doc);
    mergeInto(out, key, fieldValue);
  }
  return out;
}

function projectValue(store: Store, typeName: string, value: unknown, sels: Selection[] | undefined, vars: Record<string, unknown>, errors: Array<{ message: string }>, doc: Document): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => projectValue(store, typeName, v, sels, vars, errors, doc));
  if (isG(value)) return project(store, value.__type, value, sels, vars, errors, doc);
  return value;
}

function resolveTop(store: Store, rootType: string, sel: Selection, vars: Record<string, unknown>, errors: Array<{ message: string }>, doc: Document): unknown {
  const allowed = FIELDS[rootType] ?? [];
  if (!allowed.includes(sel.name)) {
    errors.push({ message: `Cannot query field "${sel.name}" on type "${rootType}".` });
    return null;
  }
  const args = argsOf(sel, vars);
  if (rootType === 'Query') {
    if (sel.name === 'viewer') {
      return project(store, 'User', { __type: 'User', login: VIEWER_LOGIN }, sel.selections, vars, errors, doc);
    }
    if (sel.name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      return project(store, 'Repository', repoValue(store, repo), sel.selections, vars, errors, doc);
    }
    if (sel.name === 'node') {
      const parsed = store.parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = store.findRepoById(parsed.dbId);
        if (!repo) return null;
        return project(store, 'Repository', repoValue(store, repo), sel.selections, vars, errors, doc);
      }
      if (parsed.kind === 'Issue') {
        const found = store.findIssueById(parsed.dbId);
        if (!found) return null;
        return project(store, 'Issue', issueValue(store, found.repo, found.issue), sel.selections, vars, errors, doc);
      }
      if (parsed.kind === 'PullRequest') {
        const found = store.findPullById(parsed.dbId);
        if (!found) return null;
        return project(store, 'PullRequest', pullValue(store, found.repo, found.pull), sel.selections, vars, errors, doc);
      }
      return null;
    }
    if (sel.name === '__type') {
      const name = String(args.name ?? '');
      const tv = typeValue(name);
      if (!tv) return null;
      return project(store, '__Type', tv, sel.selections, vars, errors, doc) ?? null;
    }
    if (sel.name === '__schema') {
      return project(store, '__Schema', { __type: '__Schema' }, sel.selections, vars, errors, doc);
    }
    return null;
  }
  // Mutation
  const input = (args.input !== null && typeof args.input === 'object' ? args.input as Record<string, unknown> : {}) as Record<string, unknown>;
  if (sel.name === 'createIssue') {
    const parsed = store.parseGlobalId(String(input.repositoryId ?? ''));
    const repo = parsed?.kind === 'Repository' ? store.findRepoById(parsed.dbId) : undefined;
    if (!repo) { errors.push({ message: 'repository not found' }); return project(store, 'CreateIssuePayload', { __type: 'CreateIssuePayload', issue: null }, sel.selections, vars, errors, doc); }
    const issue = store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
    return project(store, 'CreateIssuePayload', { __type: 'CreateIssuePayload', issue: issueValue(store, repo, issue) }, sel.selections, vars, errors, doc);
  }
  if (sel.name === 'closeIssue') {
    const parsed = store.parseGlobalId(String(input.issueId ?? ''));
    const found = parsed?.kind === 'Issue' ? store.findIssueById(parsed.dbId) : undefined;
    if (!found) { errors.push({ message: 'issue not found' }); return null; }
    found.issue.state = 'closed';
    return project(store, 'CloseIssuePayload', { __type: 'CloseIssuePayload', issue: issueValue(store, found.repo, found.issue) }, sel.selections, vars, errors, doc);
  }
  if (sel.name === 'createPullRequest') {
    const parsed = store.parseGlobalId(String(input.repositoryId ?? ''));
    const repo = parsed?.kind === 'Repository' ? store.findRepoById(parsed.dbId) : undefined;
    if (!repo) { errors.push({ message: 'repository not found' }); return null; }
    const pull = store.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', String(input.headRefName ?? ''), String(input.baseRefName ?? repo.defaultBranch));
    if (!pull) { errors.push({ message: 'head or base branch not found' }); return project(store, 'CreatePullRequestPayload', { __type: 'CreatePullRequestPayload', pullRequest: null }, sel.selections, vars, errors, doc); }
    return project(store, 'CreatePullRequestPayload', { __type: 'CreatePullRequestPayload', pullRequest: pullValue(store, repo, pull) }, sel.selections, vars, errors, doc);
  }
  if (sel.name === 'mergePullRequest') {
    const parsed = store.parseGlobalId(String(input.pullRequestId ?? ''));
    const found = parsed?.kind === 'PullRequest' ? store.findPullById(parsed.dbId) : undefined;
    if (!found) { errors.push({ message: 'pull request not found' }); return null; }
    if (store.pullConflicted(found.repo, found.pull)) { errors.push({ message: 'merge conflict' }); return project(store, 'MergePullRequestPayload', { __type: 'MergePullRequestPayload', pullRequest: pullValue(store, found.repo, found.pull) }, sel.selections, vars, errors, doc); }
    store.squashMerge(found.repo, found.pull);
    return project(store, 'MergePullRequestPayload', { __type: 'MergePullRequestPayload', pullRequest: pullValue(store, found.repo, found.pull) }, sel.selections, vars, errors, doc);
  }
  if (sel.name === 'addComment') {
    const subject = String(input.subjectId ?? '');
    const parsed = store.parseGlobalId(subject);
    const found = parsed?.kind === 'Issue' ? store.findIssueById(parsed.dbId) : undefined;
    if (!found) { errors.push({ message: 'subject not found' }); return null; }
    const comment = { id: found.repo.nextCommentId++, body: String(input.body ?? ''), user: { login: VIEWER_LOGIN }, created_at: FIXED_ISO, updated_at: FIXED_ISO };
    found.issue.comments.push(comment);
    const node: GValue = { __type: 'IssueComment', id: Buffer.from(`IssueComment:${found.repo.id}:${found.issue.number}:${comment.id}`, 'utf8').toString('base64'), body: comment.body };
    return project(store, 'AddCommentPayload', { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node } }, sel.selections, vars, errors, doc);
  }
  return null;
}

function repoValue(store: Store, repo: Repo): GValue {
  return { __type: 'Repository', repo, id: store.globalId('Repository', repo.id), databaseId: repo.id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`, description: repo.description ?? '', url: `https://github.com/${repo.owner}/${repo.name}`, createdAt: FIXED_ISO };
}
function issueValue(store: Store, repo: Repo, issue: Issue): GValue {
  return { __type: 'Issue', repo, issue, id: store.globalId('Issue', issue.id), number: issue.number, title: issue.title, state: issueState(issue), body: issue.body, url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`, createdAt: FIXED_ISO, updatedAt: FIXED_ISO };
}
function pullValue(store: Store, repo: Repo, pull: Pull): GValue {
  return { __type: 'PullRequest', repo, pull, id: store.globalId('PullRequest', pull.id), number: pull.number, title: pull.title, body: pull.body, state: pullState(pull), merged: pull.merged, headRefName: pull.headRef, baseRefName: pull.baseRef, url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`, createdAt: FIXED_ISO, mergedAt: pull.mergedAt };
}
function typeValue(name: string): GValue | null {
  if (!name) return null;
  if (!FIELDS[name] && !ENUM_VALUES[name] && name !== '__Type' && name !== 'Query' && name !== 'Mutation') {
    // unknown type -> null, no error (GraphQL semantics)
    if (TYPE_KIND[name]) return { __type: '__Type', typeName: name };
    return null;
  }
  return { __type: '__Type', typeName: name };
}

function cursorFor(number: number): string { return Buffer.from(`cursor:${number}`, 'utf8').toString('base64'); }
function numberFromCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function resolveField(store: Store, typeName: string, value: GValue, sel: Selection, vars: Record<string, unknown>, errors: Array<{ message: string }>, doc: Document): unknown {
  const allowed = FIELDS[typeName] ?? [];
  if (sel.name !== '__typename' && !allowed.includes(sel.name)) {
    errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
    return null;
  }
  const args = argsOf(sel, vars);
  switch (typeName) {
    case 'User': {
      if (sel.name === 'login') return value.login ?? VIEWER_LOGIN;
      if (sel.name === 'id') return store.globalId('User', 1000);
      if (sel.name === 'name') return 'ada iversen';
      if (sel.name === 'email') return 'adaiversen@example.invalid';
      return null;
    }
    case 'Repository': {
      const repo = value.repo as Repo;
      if (sel.name === 'id' || sel.name === 'databaseId' || sel.name === 'name' || sel.name === 'nameWithOwner' || sel.name === 'description' || sel.name === 'url' || sel.name === 'createdAt') return value[sel.name];
      if (sel.name === 'owner') return project(store, 'User', { __type: 'User', login: repo.owner }, sel.selections, vars, errors, doc);
      if (sel.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return project(store, 'Ref', { __type: 'Ref', name: repo.defaultBranch }, sel.selections, vars, errors, doc);
      }
      if (sel.name === 'viewerPermission') return 'ADMIN';
      if (sel.name === 'hasIssuesEnabled') return true;
      if (sel.name === 'issue') {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        if (!issue) return null;
        return project(store, 'Issue', issueValue(store, repo, issue), sel.selections, vars, errors, doc);
      }
      if (sel.name === 'issues') {
        let list = repo.issues.slice();
        const states = Array.isArray(args.states) ? args.states as string[] : undefined;
        if (states) list = list.filter((i) => states.includes(issueState(i)));
        const orderBy = (args.orderBy !== null && typeof args.orderBy === 'object' ? args.orderBy as Record<string, unknown> : undefined);
        if (orderBy?.field === 'CREATED_AT') {
          list.sort((a, b) => orderBy.direction === 'DESC' ? (b.seq - a.seq || b.number - a.number) : (a.seq - b.seq || a.number - b.number));
        } else {
          list.sort((a, b) => a.seq - b.seq);
        }
        return issueConnection(store, repo, list, args, sel, vars, errors, doc);
      }
      if (sel.name === 'pullRequests') {
        let list = repo.pulls.slice();
        const states = Array.isArray(args.states) ? args.states as string[] : undefined;
        if (states) list = list.filter((p) => states.includes(pullState(p)));
        const orderBy = (args.orderBy !== null && typeof args.orderBy === 'object' ? args.orderBy as Record<string, unknown> : undefined);
        if (orderBy?.field === 'CREATED_AT') {
          list.sort((a, b) => orderBy.direction === 'DESC' ? (b.seq - a.seq || b.number - a.number) : (a.seq - b.seq || a.number - b.number));
        } else {
          list.sort((a, b) => b.seq - a.seq || b.number - a.number);
        }
        return pullConnection(store, repo, list, args, sel, vars, errors, doc);
      }
      if (sel.name === 'pullRequest') {
        const pull = repo.pulls.find((p) => p.number === Number(args.number));
        if (!pull) return null;
        return project(store, 'PullRequest', pullValue(store, repo, pull), sel.selections, vars, errors, doc);
      }
      return null;
    }
    case 'Issue': {
      const issue = value.issue as Issue;
      if (['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt'].includes(sel.name)) return value[sel.name];
      if (sel.name === 'author') return project(store, 'User', { __type: 'User', login: VIEWER_LOGIN }, sel.selections, vars, errors, doc);
      if (sel.name === 'comments') {
        const repo = value.repo as Repo;
        void repo; void issue;
        return project(store, 'IssueConnection', { __type: 'IssueConnection', nodes: [], pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null } }, sel.selections, vars, errors, doc);
      }
      return null;
    }
    case 'PullRequest': {
      const pull = value.pull as Pull;
      const repo = value.repo as Repo;
      if (['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'url', 'createdAt', 'mergedAt'].includes(sel.name)) return value[sel.name];
      if (sel.name === 'mergeable') return store.pullConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      if (sel.name === 'headRefOid') return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      if (sel.name === 'baseRefOid') return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      if (sel.name === 'author') return project(store, 'User', { __type: 'User', login: VIEWER_LOGIN }, sel.selections, vars, errors, doc);
      if (sel.name === 'files') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const files = store.pullFiles(repo, pull).slice(0, first);
        const nodes = files.map((f) => ({ __type: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: 'MODIFIED' }));
        const nodesSel = sel.selections?.find((s) => s.name === 'nodes')?.selections;
        const projected = nodes.map((n) => project(store, 'PullRequestChangedFile', n, nodesSel, vars, errors, doc));
        return project(store, 'PullRequestChangedFileConnection', { __type: 'PullRequestChangedFileConnection', nodes: projected, pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: null } }, sel.selections, vars, errors, doc);
      }
      return null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (sel.name === 'nodes') return value.nodes ?? [];
      if (sel.name === 'edges') return (value.nodes as unknown[] ?? []).map((n, i) => ({ __type: 'IssueEdge', node: n, cursor: (value.cursors as string[] | undefined)?.[i] ?? '' }));
      if (sel.name === 'pageInfo') return project(store, 'PageInfo', value.pageInfo as GValue, sel.selections, vars, errors, doc);
      if (sel.name === 'totalCount') return typeof value.total === 'number' ? value.total : (Array.isArray(value.nodes) ? value.nodes.length : 0);
      return null;
    }
    case 'PageInfo': {
      if (sel.name === 'hasNextPage') return value.hasNextPage ?? false;
      if (sel.name === 'hasPreviousPage') return false;
      if (sel.name === 'startCursor') return value.startCursor ?? null;
      if (sel.name === 'endCursor') return value.endCursor ?? null;
      return null;
    }
    case 'Ref': {
      if (sel.name === 'name') return value.name;
      if (sel.name === 'target') return null;
      return null;
    }
    case 'IssueComment': {
      if (sel.name === 'id' || sel.name === 'body') return value[sel.name];
      if (sel.name === 'author') return project(store, 'User', { __type: 'User', login: VIEWER_LOGIN }, sel.selections, vars, errors, doc);
      if (sel.name === 'createdAt') return FIXED_ISO;
      if (sel.name === 'updatedAt') return FIXED_ISO;
      return null;
    }
    case 'CommentEdge':
    case 'IssueEdge':
    case 'PullRequestEdge': {
      if (sel.name === 'node') {
        const node = value.node as GValue;
        if (!node) return null;
        return project(store, node.__type, node, sel.selections, vars, errors, doc);
      }
      if (sel.name === 'cursor') return value.cursor ?? '';
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (sel.name === 'issue') {
        const issue = value.issue as GValue | null;
        if (!issue) return null;
        return project(store, 'Issue', issue, sel.selections, vars, errors, doc);
      }
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (sel.name === 'pullRequest') {
        const pull = value.pullRequest as GValue | null;
        if (!pull) return null;
        return project(store, 'PullRequest', pull, sel.selections, vars, errors, doc);
      }
      return null;
    }
    case 'AddCommentPayload': {
      if (sel.name === 'commentEdge') {
        return project(store, 'CommentEdge', value.commentEdge as GValue, sel.selections, vars, errors, doc);
      }
      if (sel.name === 'subject') return null;
      return null;
    }
    case '__Type': {
      const typeName = value.typeName as string;
      if (sel.name === 'name') return typeName;
      if (sel.name === 'kind') return TYPE_KIND[typeName] ?? 'OBJECT';
      if (sel.name === 'description') return null;
      if (sel.name === 'fields') {
        const names = FIELDS[typeName] ?? [];
        const fields = names.map((n) => ({ __type: '__Field', name: n }));
        const fieldSel = sel.selections;
        return fields.map((f) => project(store, '__Field', f, fieldSel, vars, errors, doc));
      }
      if (sel.name === 'enumValues') {
        const names = ENUM_VALUES[typeName] ?? [];
        const vals = names.map((n) => ({ __type: '__EnumValue', name: n }));
        return vals.map((f) => project(store, '__EnumValue', f, sel.selections, vars, errors, doc));
      }
      if (sel.name === 'inputFields' || sel.name === 'interfaces' || sel.name === 'possibleTypes') return [];
      return null;
    }
    case '__Field': {
      if (sel.name === 'name') return value.name;
      if (sel.name === 'description') return null;
      if (sel.name === 'type') return project(store, '__Type', { __type: '__Type', typeName: 'String' }, sel.selections, vars, errors, doc);
      if (sel.name === 'args') return [];
      return null;
    }
    case '__EnumValue': {
      if (sel.name === 'name') return value.name;
      if (sel.name === 'description') return null;
      if (sel.name === 'isDeprecated') return false;
      if (sel.name === 'deprecationReason') return null;
      return null;
    }
    case '__Schema': {
      if (sel.name === 'queryType') return project(store, '__Type', { __type: '__Type', typeName: 'Query' }, sel.selections, vars, errors, doc);
      if (sel.name === 'mutationType') return project(store, '__Type', { __type: '__Type', typeName: 'Mutation' }, sel.selections, vars, errors, doc);
      if (sel.name === 'types') return Object.keys(FIELDS).map((n) => project(store, '__Type', { __type: '__Type', typeName: n }, sel.selections, vars, errors, doc));
      if (sel.name === 'description') return null;
      return null;
    }
    default:
      return value[sel.name] ?? null;
  }
}

function issueConnection(store: Store, repo: Repo, list: Issue[], args: Record<string, unknown>, sel: Selection, vars: Record<string, unknown>, errors: Array<{ message: string }>, doc: Document): unknown {
  const first = typeof args.first === 'number' ? args.first : list.length;
  const afterNum = numberFromCursor(typeof args.after === 'string' ? args.after : undefined);
  let start = 0;
  if (afterNum !== null) {
    const idx = list.findIndex((i) => i.number === afterNum);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
  const nodesSel = sel.selections?.find((s) => s.name === 'nodes')?.selections
    ?? sel.selections?.find((s) => s.name === 'edges')?.selections?.find((s) => s.name === 'node')?.selections;
  const nodes = page.map((i) => project(store, 'Issue', issueValue(store, repo, i), nodesSel, vars, errors, doc));
  const conn: GValue = { __type: 'IssueConnection', nodes, total: list.length, cursors: page.map((i) => cursorFor(i.number)), pageInfo: { __type: 'PageInfo', hasNextPage, endCursor, startCursor: page.length ? cursorFor(page[0].number) : null } };
  return project(store, 'IssueConnection', conn, sel.selections, vars, errors, doc);
}

function pullConnection(store: Store, repo: Repo, list: Pull[], args: Record<string, unknown>, sel: Selection, vars: Record<string, unknown>, errors: Array<{ message: string }>, doc: Document): unknown {
  const first = typeof args.first === 'number' ? args.first : list.length;
  const afterNum = numberFromCursor(typeof args.after === 'string' ? args.after : undefined);
  let start = 0;
  if (afterNum !== null) {
    const idx = list.findIndex((p) => p.number === afterNum);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
  const nodesSel = sel.selections?.find((s) => s.name === 'nodes')?.selections
    ?? sel.selections?.find((s) => s.name === 'edges')?.selections?.find((s) => s.name === 'node')?.selections;
  const nodes = page.map((p) => project(store, 'PullRequest', pullValue(store, repo, p), nodesSel, vars, errors, doc));
  const conn: GValue = { __type: 'PullRequestConnection', nodes, total: list.length, cursors: page.map((p) => cursorFor(p.number)), pageInfo: { __type: 'PageInfo', hasNextPage, endCursor, startCursor: page.length ? cursorFor(page[0].number) : null } };
  return project(store, 'PullRequestConnection', conn, sel.selections, vars, errors, doc);
}
