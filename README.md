# github-core-clone-01 — GitHub-compatible git forge (Node 22 stdlib only)

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/irfanaguswahyudi/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/irfanaguswahyudi/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)


A single-process, in-memory, deterministic GitHub-compatible git forge. No
dependencies, no git binary, no network at runtime. Implements the full
bounty surface: REST `/api/v3`, GraphQL `/api/graphql`, MCP `/mcp`, and git
smart HTTP (`git-upload-pack` v2 + v0, `git-receive-pack` v0) with hand-rolled
packfile read/write (OFS/REF deltas, thin packs).

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the starter lifecycle verbatim: it binds an ephemeral port,
registers it at `$MAKEFUN_ENV_URL/register`, and polls `$MAKEFUN_ENV_URL/done`
until the trial ends. The forge itself is `createApp()` in `app.ts`.

Auth: every API call needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
(except `GET /healthz` → `200 {"ok":true}`). The viewer is fixed by the
trial scenario: `adaiversen` (id 1000). All state timestamps are the fixed
`2025-01-01T00:00:00Z` — the forge never calls `Date.now()` or `Math.random()`.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Starter lifecycle (unchanged). |
| `app.ts` | HTTP server: routing, auth, JSON envelopes, `X-GitHub-Request-Id`. |
| `src/store.ts` | Authoritative in-memory model: repos, objects, refs, labels, issues, PRs (shared number counter), three-way squash merge, JSON views, global IDs. |
| `src/gitobj.ts` | SHA-1, pkt-lines, tree/commit/tag parse/build, delta apply, pack read/write. |
| `src/git.ts` | Smart HTTP: v0/v2 advertisements, `ls-refs`, fetch (shallow-aware, depth-limited), receive-pack (fast-forward only), pack cache. |
| `src/rest.ts` | REST `/api/v3`: repos, branches, commits, refs, contents, labels, issues, comments, pulls + merge. |
| `src/graphql.ts` | Hand-written GraphQL selection parser + resolvers, introspection, batched documents. |
| `src/mcp.ts` | MCP JSON-RPC 2.0 Streamable HTTP: `server/discover`, `initialize`, 6 tools, `tools/call`. |

## Test in seconds

From the kit directory, with the server on an ephemeral port and
`MAKEFUN_SHOP_TOKEN=test-token`:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token --json
```

See `TEST_RESULTS.md` for the real local-grade output: **120/120 checks,
feature 600, agent 200, perf 192, total 992/1000** (sdk/run.ts `--perf`);
`grade-local` reproduces **987** through the full trial driver.
---

<sub>Entered on [make.fun](https://make.fun/?ref=rxbkfby6&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
