# Multi-Device Totals Implementation Plan

- [x] **Task 1: Host-aware merge helpers**
- [x] **Task 2: Incremental upload + remote.json pull**
- [x] **Task 3: dumpSnapshot cloud orchestration**
- [x] **Task 4: Cloudflare Worker + D1 store**
- [x] **Task 5: Settings UI, billing assertion, README**

**Goal:** Any AI Usage device shows combined token totals from all machines via the user’s Cloudflare Worker + D1 `ai-usage`, with local parsers remaining authoritative for this hostname.

**Architecture:** Sidecar still writes `~/.ai-usage/snapshot.json`. After a local collect, it incrementally POSTs changed buckets/sessions, GETs remote rows, then merges: other hostnames from `remote.json`, this hostname from this run’s collect. Tray and dashboard keep reading the merged snapshot. Worker is a small authenticated ingest/export API over D1.

**Tech Stack:** Node ≥20 ESM, vitest, existing vibe-usage `state.js` / `ingest` / `getJson`, Cloudflare Worker + D1, Tauri settings (vanilla TS).

**Spec:** `docs/superpowers/specs/2026-09-10-multi-device-totals-design.md`

## Global Constraints

- Do not upload to vibecafe.ai; do not require `vbu_` key prefix
- Cursor stays `VIBE_USAGE_CURSOR_MODE=device`; drop `cursor-cloud` before snapshot/upload
- Independent D1 database name `ai-usage`; never write comments/analytics tables
- Incremental ingest only — never DELETE-all-hostname then reinsert
- Unconfigured `apiUrl`+`apiKey`: no HTTP; existing dump tests must stay green
- Keys stay in `~/.ai-usage/config.json`; Chinese UI copy
- Do not commit unless the user explicitly asks (user rule overrides plan commit steps)

---

## File map

- Create: `sidecar/merge.mjs` — identity keys, host-scoped source merge, local+remote merge
- Create: `sidecar/remote-sync.mjs` — changed-item diff, ingest + GET pull, remote.json
- Modify: `sidecar/dump.mjs` — dump order: collect → ingest → pull → merge → write snapshot (including `cloud` status)
- Create: `cloudflare/schema.sql`, `cloudflare/src/store.js`, `cloudflare/src/worker.js`, `cloudflare/wrangler.toml`, `cloudflare/README.md`
- Create: `cloudflare/src/store.test.js`
- Modify: `sidecar/dump.test.js` — merge + dump cloud tests
- Modify: `src/lib/billing.test.ts` — multi-hostname subscription once
- Modify: `src/app.ts` — 多设备同步 settings; show `snapshot.cloud.error`
- Modify: `README.md` — four-step Worker setup

---

### Task 1: Host-aware merge helpers

**Files:**
- Create: `sidecar/merge.mjs`
- Test: `sidecar/dump.test.js` (new describe block importing merge.mjs)

**Interfaces:**
- Consumes: `dropCloudRows` from `sidecar/dump.mjs` (re-export from merge or pass through dump to avoid cycles). Prefer putting `dropCloudRows` in `merge.mjs` and having `dump.mjs` re-export it so existing dump tests keep importing from dump.
- Produces:
  - `bucketIdentity(b) → string` = `` `${source}|${model}|${project}|${hostname}|${bucketStart}` ``
  - `sessionIdentity(s) → string` = `` `${source}|${sessionHash}|${hostname||''}` ``
  - `upsertByIdentity(previous, incoming, idFn) → items` last-write-wins on incoming
  - `rowsForHost(items, hostname) → items` where `item.hostname === hostname`
  - `mergeSnapshotBySourceForHost(previous, collected, hostname)` — same semantics as today’s `mergeSnapshotBySource` but only on `rowsForHost(previous.*, hostname)`; collected is already this host
  - `mergeLocalAndRemote(local, remote, hostname) → { buckets, sessions }` = remote rows with `hostname !== hostname` ∪ local rows, then drop `cursor-cloud`

**Why host-scoped source merge:** today’s `mergeSnapshotBySource` on a already-merged snapshot would replace all `chatgpt-web` rows (every device) with this machine’s collect when that parser succeeds. If GET then fails, other devices disappear. Local merge must be this hostname only; other hosts come from `remote.json`.

- [ ] **Step 1: Write failing tests** in `sidecar/dump.test.js`:

```js
describe('host-aware merge', () => {
  it('keeps other hostnames from remote and uses local for this host', async () => {
    const { mergeLocalAndRemote } = await import('./merge.mjs');
    const local = {
      buckets: [{ source: 'codex', hostname: 'mbp', inputTokens: 3, bucketStart: 'a' }],
      sessions: [{ source: 'codex', sessionHash: 's-mbp', hostname: 'mbp' }],
    };
    const remote = {
      buckets: [
        { source: 'codex', hostname: 'mbp', inputTokens: 1, bucketStart: 'a' },
        { source: 'codex', hostname: 'linux', inputTokens: 9, bucketStart: 'a' },
        { source: 'cursor', hostname: 'cursor-cloud', inputTokens: 8, bucketStart: 'a' },
      ],
      sessions: [
        { source: 'codex', sessionHash: 's-linux', hostname: 'linux' },
        { source: 'codex', sessionHash: 's-mbp', hostname: 'mbp' },
      ],
    };
    const merged = mergeLocalAndRemote(local, remote, 'mbp');
    expect(merged.buckets).toEqual([
      { source: 'codex', hostname: 'linux', inputTokens: 9, bucketStart: 'a' },
      { source: 'codex', hostname: 'mbp', inputTokens: 3, bucketStart: 'a' },
    ]);
    expect(merged.sessions.map((s) => s.sessionHash).sort()).toEqual(['s-linux', 's-mbp']);
  });

  it('mergeSnapshotBySourceForHost does not drop other hostnames in previous', async () => {
    const { mergeSnapshotBySourceForHost } = await import('./merge.mjs');
    const previous = {
      buckets: [
        { source: 'chatgpt-web', hostname: 'linux', inputTokens: 50 },
        { source: 'chatgpt-web', hostname: 'mbp', inputTokens: 1 },
        { source: 'cursor', hostname: 'mbp', inputTokens: 7 },
      ],
      sessions: [],
    };
    const collected = {
      buckets: [{ source: 'chatgpt-web', hostname: 'mbp', inputTokens: 40 }],
      sessions: [],
      succeededSources: ['chatgpt-web'],
      syncedAt: 'new',
    };
    const local = mergeSnapshotBySourceForHost(previous, collected, 'mbp');
    expect(local.buckets).toEqual([
      { source: 'chatgpt-web', hostname: 'mbp', inputTokens: 40 },
      { source: 'cursor', hostname: 'mbp', inputTokens: 7 },
    ]);
  });

  it('upsertByIdentity last-write-wins without dropping untouched keys', async () => {
    const { upsertByIdentity, bucketIdentity } = await import('./merge.mjs');
    const prev = [
      { source: 'codex', model: 'g', project: 'p', hostname: 'linux', bucketStart: 't1', inputTokens: 1 },
      { source: 'codex', model: 'g', project: 'p', hostname: 'win', bucketStart: 't1', inputTokens: 2 },
    ];
    const incoming = [
      { source: 'codex', model: 'g', project: 'p', hostname: 'win', bucketStart: 't1', inputTokens: 5 },
    ];
    const out = upsertByIdentity(prev, incoming, bucketIdentity);
    expect(out.find((b) => b.hostname === 'win').inputTokens).toBe(5);
    expect(out.find((b) => b.hostname === 'linux').inputTokens).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run sidecar/dump.test.js`
Expected: FAIL importing `./merge.mjs` or missing exports

- [ ] **Step 3: Implement `sidecar/merge.mjs`** and move `dropCloudRows` here; `dump.mjs` re-exports `dropCloudRows` (and keep `mergeSnapshotBySource` as a wrapper around all hostnames for existing tests — do not change that function’s contract).

```js
export function dropCloudRows(items) {
  return (items || []).filter((item) => item?.hostname !== 'cursor-cloud');
}

export function bucketIdentity(b) {
  return `${b.source}|${b.model}|${b.project}|${b.hostname}|${b.bucketStart}`;
}

export function sessionIdentity(s) {
  return `${s.source}|${s.sessionHash}|${s.hostname || ''}`;
}

export function rowsForHost(items, hostname) {
  return (items || []).filter((item) => item?.hostname === hostname);
}

export function upsertByIdentity(previous, incoming, idFn) {
  const map = new Map();
  for (const item of previous || []) map.set(idFn(item), item);
  for (const item of incoming || []) map.set(idFn(item), item);
  return [...map.values()];
}

export function mergeSnapshotBySourceForHost(previous, collected, hostname) {
  const prevHost = {
    buckets: rowsForHost(previous?.buckets, hostname),
    sessions: rowsForHost(previous?.sessions, hostname),
    syncedAt: previous?.syncedAt,
  };
  // reuse mergeSnapshotBySource from dump.mjs would cycle; duplicate the 12-line function here
  // or export mergeSnapshotBySource from merge.mjs and switch dump.mjs to import it.
}

export function mergeLocalAndRemote(local, remote, hostname) {
  const otherBuckets = (remote?.buckets || []).filter((b) => b?.hostname && b.hostname !== hostname);
  const otherSessions = (remote?.sessions || []).filter((s) => s?.hostname && s.hostname !== hostname);
  return {
    buckets: dropCloudRows([...(otherBuckets), ...(local.buckets || [])]),
    sessions: dropCloudRows([...(otherSessions), ...(local.sessions || [])]),
  };
}
```

Prefer: move `mergeSnapshotBySource` into `merge.mjs` as well, update dump.mjs imports, keep dump.test.js imports from dump.mjs via re-export.

- [ ] **Step 4: Run tests**

Run: `npx vitest run sidecar/dump.test.js src/lib/usage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** — skip unless the user asks

---

### Task 2: Incremental upload + remote.json pull (pure functions)

**Files:**
- Create: `sidecar/remote-sync.mjs`
- Test: `sidecar/dump.test.js` (or `sidecar/remote-sync.test.js`)

**Interfaces:**
- Consumes: `vendor/vibe-usage/src/state.js` `bucketKey`, `bucketHash`, `sessionKey`, `sessionHash`, `loadState`, `saveState`, `pruneState`
- Produces:
  - `changedBuckets(items, state) → buckets` where `state.buckets[bucketKey(b)] !== bucketHash(b)`
  - `changedSessions(items, state) → sessions` same with sessionKey/sessionHash
  - `markUploaded(state, buckets, sessions) → state` writes hashes for those items
  - `readRemoteCache(home) → { buckets, sessions, since }` missing file → `{ buckets:[], sessions:[], since:null }`
  - `writeRemoteCache(home, cache)` atomic write `remote.json`
  - `applyPull(cache, payload) → cache` upsertByIdentity on buckets/sessions; set `since` from `payload.until` (required string)
  - `cloudStatus({ configured, ingested, pulled, error })`

Do not call network in these functions.

- [ ] **Step 1: Failing tests** `sidecar/remote-sync.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { changedBuckets, changedSessions, markUploaded, applyPull } from './remote-sync.mjs';

const bucket = {
  source: 'codex', model: 'g', project: 'p', hostname: 'mbp',
  bucketStart: '2026-09-10T00:00:00.000Z', inputTokens: 10, outputTokens: 0,
  cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 10,
};

it('changedBuckets skips items whose hash is already in state', () => {
  const state = { buckets: {}, sessions: {} };
  const first = changedBuckets([bucket], state);
  expect(first).toEqual([bucket]);
  const nextState = markUploaded(state, first, []);
  expect(changedBuckets([bucket], nextState)).toEqual([]);
  const updated = { ...bucket, inputTokens: 11, totalTokens: 11 };
  expect(changedBuckets([updated], nextState)).toEqual([updated]);
});

it('applyPull upserts incoming and keeps older host rows', async () => {
  const cache = {
    buckets: [{ ...bucket, hostname: 'linux', inputTokens: 4 }],
    sessions: [],
    since: null,
  };
  const out = applyPull(cache, {
    buckets: [{ ...bucket, inputTokens: 10 }],
    sessions: [],
    until: '2026-09-10T04:00:00.000Z',
  });
  expect(out.since).toBe('2026-09-10T04:00:00.000Z');
  expect(out.buckets).toHaveLength(2);
});
```

- [ ] **Step 2: Run to fail** `npx vitest run sidecar/remote-sync.test.js`

- [ ] **Step 3: Implement `sidecar/remote-sync.mjs`**

Import state helpers via `pathToFileURL` + `resolveVibeUsageSrc` OR duplicate the 3-line key/hash by importing from the vendored path using the same `resolveVibeUsageSrc` as dump. To keep tests fast and avoid dump env, import:

```js
import { bucketKey, bucketHash, sessionKey, sessionHash } from '../vendor/vibe-usage/src/state.js';
```

Vendored path is stable in this repo.

`markUploaded` must not prune here; dump will prune with `okSources` after a successful ingest using live keys from the full local list.

- [ ] **Step 4: Tests pass** `npx vitest run sidecar/remote-sync.test.js`

- [ ] **Step 5: Commit** — skip unless asked

---

### Task 3: dumpSnapshot cloud orchestration

**Files:**
- Modify: `sidecar/dump.mjs`
- Modify: `sidecar/dump.test.js`

**Interfaces:**
- Consumes: merge helpers, remote-sync helpers, vibe-usage `ingest` + `getJson`
- Produces: `dumpSnapshot({ aiUsageHome, ingestImpl, pullImpl } = {})`  
  Return `{ snapshotPath, ingested, pulled, cloudError, buckets, sessions, syncedAt }`  
  Snapshot JSON also contains `cloud: { configured, ingested, pulled, error }`  
  `error` Chinese: `上传失败：...` / `拉取失败，合计可能不完整` / `密钥无效`

**dump order:**

1. `applyAiUsageEnv` + `collectLocal`
2. `local = mergeSnapshotBySourceForHost(readSnapshot(home), collected, host)`
3. Write is NOT yet — first network:
   - if no apiUrl/apiKey: `ingested=false`, `pulled=false`, `configured=false`, skip HTTP
   - else `changed = changedBuckets/Sessions(local, loadState())`; if any, `ingestImpl` (default vibe-usage ingest). On success `saveState(markUploaded + pruneState with live keys of local + okSources=succeededSources)`. On failure do not update state.
   - `pullImpl` default: GET `/api/usage?since=` if cache.since else `/api/usage?days=90`, loop `?cursor=` while `payload.cursor` present. `getJson` from vibe-usage.
   - `remote = applyPull(readRemoteCache, payload)` on success and `writeRemoteCache`; on failure keep previous cache
4. `merged = mergeLocalAndRemote(local, remote, host)` then `dropCloudRows` already inside merge
5. write snapshot (buckets/sessions/syncedAt/cloud)
6. dump exit 0 even if ingest/pull failed (so tray keeps last merged numbers). Only throw if collect itself throws.

Inject `ingestImpl(apiUrl, apiKey, buckets, sessions)` and `pullImpl({ apiUrl, apiKey, since }) → { buckets, sessions, until, cursor? }` in tests. Default wrappers must not run when unconfigured (existing test).

- [ ] **Step 1: Failing tests** add to dump.test.js:

```js
it('dumpSnapshot with injectables uploads only changed buckets and merges other hosts', async () => {
  writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({
    apiUrl: 'http://127.0.0.1:9',
    apiKey: 'secret',
    hostname: 'mbp',
  }) + '\n');
  const posts = [];
  const { dumpSnapshot } = await import('./dump.mjs');
  const ingestImpl = async (_url, _key, buckets, sessions) => {
    posts.push({ buckets, sessions });
    return { ingested: buckets.length };
  };
  const pullImpl = async () => ({
    buckets: [{ source: 'codex', hostname: 'linux', model: 'g', project: 'p', bucketStart: 't', inputTokens: 9 }],
    sessions: [],
    until: '2026-09-10T05:00:00.000Z',
  });
  await dumpSnapshot({ ingestImpl, pullImpl });
  const snap = JSON.parse(readFileSync(join(tmpHome, 'snapshot.json'), 'utf8'));
  expect(snap.buckets.some((b) => b.hostname === 'linux' && b.inputTokens === 9)).toBe(true);
  expect(snap.cloud.ingested).toBe(true);
  expect(snap.cloud.pulled).toBe(true);
  const firstCount = posts[0].buckets.length;
  expect(firstCount).toBeGreaterThan(0);
  await dumpSnapshot({ ingestImpl, pullImpl });
  expect(posts[1].buckets.length).toBe(0);
});

it('dumpSnapshot keeps other hosts from remote.json when pullImpl throws', async () => {
  writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({
    apiUrl: 'http://127.0.0.1:9', apiKey: 'secret', hostname: 'mbp',
  }) + '\n');
  writeFileSync(join(tmpHome, 'remote.json'), JSON.stringify({
    buckets: [{ source: 'codex', hostname: 'linux', inputTokens: 9, bucketStart: 't' }],
    sessions: [],
    since: '2026-09-01T00:00:00.000Z',
  }) + '\n');
  const { dumpSnapshot } = await import('./dump.mjs');
  const result = await dumpSnapshot({
    ingestImpl: async () => ({ ingested: 0 }),
    pullImpl: async () => { throw new Error('HTTP 500'); },
  });
  const snap = JSON.parse(readFileSync(join(tmpHome, 'snapshot.json'), 'utf8'));
  expect(snap.buckets.some((b) => b.hostname === 'linux')).toBe(true);
  expect(snap.cloud.pulled).toBe(false);
  expect(snap.cloud.error).toMatch(/拉取失败/);
  expect(result.pulled).toBe(false);
});
```

Keep the existing unconfigured test: `ingested === false` and no ingestImpl called. If dump starts calling ingestImpl only when configured, the old test still works with no config.

- [ ] **Step 2: Run dump tests, confirm new ones fail**

- [ ] **Step 3: Wire dump.mjs** as specified. Move `dropCloudRows` re-exports if Task 1 already did.

Default `ingestImpl`:

```js
async function defaultIngest(apiUrl, apiKey, buckets, sessions) {
  if (!buckets.length && !(sessions?.length)) return { ingested: 0 };
  const { ingest } = await loadVibeUsageModules();
  return ingest(apiUrl, apiKey, buckets, {}, sessions?.length ? sessions : undefined);
}
```

Default `pullImpl`:

```js
async function defaultPull({ apiUrl, apiKey, since }) {
  const { getJson } = await loadVibeUsageModules();
  const items = { buckets: [], sessions: [] };
  let cursor;
  let until;
  do {
    const qs = new URLSearchParams();
    if (since) qs.set('since', since);
    else qs.set('days', '90');
    if (cursor) qs.set('cursor', cursor);
    const page = await getJson(apiUrl, apiKey, `/api/usage?${qs}`, { timeoutMs: 30_000 });
    items.buckets.push(...(page.buckets || []));
    items.sessions.push(...(page.sessions || []));
    cursor = page.cursor;
    until = page.until || until;
  } while (cursor);
  return { ...items, until: until || new Date().toISOString() };
}
```

401 → `cloud.error = '密钥无效'`. Other errors: ingest vs pull messages from spec.

- [ ] **Step 4: `npx vitest run sidecar`** all pass, including unconfigured no network

- [ ] **Step 5: Commit** — skip unless asked

---

### Task 4: Cloudflare Worker + D1 store

**Files:**
- Create: `cloudflare/schema.sql` (copy from spec)
- Create: `cloudflare/src/store.js` — `upsert(db, {buckets, sessions})`, `exportUsage(db, {since, days, cursor, limit})`
- Create: `cloudflare/src/worker.js` — `handleRequest(request, env)`
- Create: `cloudflare/src/store.test.js`
- Create: `cloudflare/wrangler.toml`
- Create: `cloudflare/README.md` (Chinese deploy: bind existing `ai-usage`, `wrangler secret put AUTH_TOKEN`)

**Interfaces:**
- D1 via `env.DB.prepare(sql).bind(...).all()` / `.run()`
- Auth: `Authorization: Bearer ${env.AUTH_TOKEN}` else 401 `{ error: 'UNAUTHORIZED' }`
- POST `/api/usage/ingest` — parse JSON; if `Content-Encoding: gzip`, decompress with `DecompressionStream` then JSON.parse. Upsert only body rows. Accept any source string. Ignore `estimatedCost`.
- GET `/api/usage` — `since` wins; else `days` default 90 meaning `bucket_start` or `updated_at >= now-days`. Return `{ buckets, sessions, until }` camelCase field names matching ingest (`bucketStart`, `inputTokens`, …). `limit` default 2000; if more rows, `cursor` = last `updated_at|rowid` opaque string.
- `until` = ISO now at start of GET
- Filter `WHERE updated_at > ?` when since set (string compare ISO)
- Do not implement `/api/usage/settings`

**In-memory fake DB for tests** (no wrangler):

```js
export function createMemoryDb() {
  const buckets = new Map();
  const sessions = new Map();
  return {
    async exec(sql, params) { /* only used if you go SQL */ },
    buckets,
    sessions,
  };
}
```

Implement store against a tiny adapter:

```js
export function memoryAdapter() {
  const buckets = new Map();
  const sessions = new Map();
  return {
    async putBucket(row) { buckets.set(pk(row), { ...row, updatedAt: row.updatedAt }); },
    async putSession(row) { sessions.set(spk(row), { ...row, updatedAt: row.updatedAt }); },
    async listBucketsSince(since, limit, afterKey) { /* sort by updatedAt */ },
    async listSessionsSince(since, limit, afterKey) {},
  };
}
```

Worker production adapter wraps D1 to the same methods. Tests hit store + handleRequest with memoryAdapter.

- [ ] **Step 1: store.test.js failing tests** — upsert chatgpt-web, second upsert same PK overwrites tokens, GET since skips older, 401 without bearer, gzip JSON ingest (use `gzipSync` from node:zlib in test by constructing a Request)

```js
it('rejects missing bearer', async () => {
  const { handleRequest } = await import('./worker.js');
  const res = await handleRequest(new Request('http://x/api/usage'), { AUTH_TOKEN: 't', DB: memoryAdapter() });
  expect(res.status).toBe(401);
});

it('upserts chatgpt-web and returns it on GET', async () => { /* POST then GET days=90 */ });
```

- [ ] **Step 2: Run `npx vitest run cloudflare/src/store.test.js`** fail

- [ ] **Step 3: Implement schema, store, worker, wrangler.toml**

wrangler.toml:

```toml
name = "ai-usage"
main = "src/worker.js"
compatibility_date = "2026-09-10"

[[d1_databases]]
binding = "DB"
database_name = "ai-usage"
database_id = "REPLACE_WITH_D1_ID"
```

Map D1 columns snake_case ↔ camelCase in store.js. `user_prompt_hours` TEXT JSON.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit** — skip unless asked

---

### Task 5: Settings UI, billing assertion, README

**Files:**
- Modify: `src/app.ts` — AppConfig `apiUrl?`, `apiKey?`, `hostname?`; settings card; persist on blur/save; password input for key; hint 四台同一地址和密钥；设备名需唯一
- Modify: `src/app.ts` dashboard banner: if `snapshot.cloud?.error` show it (in addition to lastError)
- Test: `src/lib/billing.test.ts` — two hostnames both cursor subscription still $20; API sums tokens
- Create optional: `src/lib/sync-status.ts` + test for label helper if logic is more than string concat
- Modify: `README.md`

**sync status copy helper** (testable):

```ts
export function cloudSyncLabel(config: { apiUrl?: string; apiKey?: string }, cloud?: { ingested?: boolean; pulled?: boolean; error?: string | null }): string {
  if (!config.apiUrl?.trim() || !config.apiKey?.trim()) return '未配置云端';
  if (cloud?.error) return cloud.error;
  if (cloud?.pulled) return '已从云端合并其它设备';
  return '已配置，尚未拉取';
}
```

Settings fields bind `#sync-api-url`, `#sync-api-key`, `#sync-hostname` and `persistConfig`.

- [ ] **Step 1: billing + cloudSyncLabel failing tests**

```ts
it('counts a subscription source once even when two hostnames appear', () => {
  const result = costBreakdown({
    buckets: [
      { source: 'cursor', hostname: 'mbp', inputTokens: 1 },
      { source: 'cursor', hostname: 'linux', inputTokens: 1 },
    ],
    billing: { cursor: { kind: 'subscription', monthly: 20 } },
    includeChatgptInTotal: true,
    currency: 'USD',
  });
  expect(result.coding.subscription).toBe(20);
});

it('sums API tokens across hostnames', () => {
  const result = costBreakdown({
    buckets: [
      { source: 'codex', hostname: 'mbp', inputTokens: 1_000_000, outputTokens: 0 },
      { source: 'codex', hostname: 'linux', inputTokens: 1_000_000, outputTokens: 0 },
    ],
    billing: { codex: { kind: 'api', inputPerMillion: 2, outputPerMillion: 2 } },
    includeChatgptInTotal: true,
    currency: 'USD',
  });
  expect(result.coding.api).toBe(4);
});
```

Subscription test may already pass (uniqueSources). Still add it as a regression lock. If it passes immediately, that is acceptable for this existing behavior lock — do not change billing.ts.

cloudSyncLabel tests should fail until the helper exists.

- [ ] **Step 2: Run those tests**

- [ ] **Step 3: Implement helper, settings card, README four steps, dashboard cloud error banner**

README 增加「多设备合计」：

1. 每台安装应用  
2. 一次：`cd cloudflare && npx wrangler d1 execute ai-usage --file=schema.sql` 然后把 `database_id` 写入 wrangler.toml，`npx wrangler secret put AUTH_TOKEN`，`npx wrangler deploy`  
3. 设置里填 Worker URL 和密钥（四台相同）  
4. 点同步；Ubuntu 主机名冲突则改设备名  

Note D1 quota is account-wide.

- [ ] **Step 4: `npx vitest run` and `npm test`**

- [ ] **Step 5: Commit** — skip unless asked

---

## Spec coverage

| Spec item | Task |
|---|---|
| Any device + tray sees all hostnames | 3 (merged snapshot) |
| Incremental ingest / no full rewrite | 2, 3 |
| since pull + remote.json fallback | 2, 3 |
| This host authoritative | 1, 3 |
| Worker ingest/GET/401/gzip/chatgpt-web | 4 |
| Settings URL/key/hostname | 5 |
| Unconfigured no HTTP | 3 |
| Subscription not × devices | 5 |
| cursor-cloud dropped | 1, 3 |
| Chinese errors | 3, 5 |
| README deploy | 5 |
