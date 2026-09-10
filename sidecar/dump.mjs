import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname as osHostname } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  dropCloudRows,
  mergeSnapshotBySource,
  mergeSnapshotBySourceForHost,
  mergeLocalAndRemote,
} from './merge.mjs';
import {
  changedBuckets,
  changedSessions,
  markUploaded,
  readRemoteCache,
  writeRemoteCache,
  applyPull,
  cloudStatus,
} from './remote-sync.mjs';
import {
  loadState,
  saveState,
  pruneState,
  bucketKey,
  sessionKey,
} from '../vendor/vibe-usage/src/state.js';

export { dropCloudRows, mergeSnapshotBySource };

export function defaultRepoRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}

export function resolveVibeUsageSrc(env = process.env, repoRoot = defaultRepoRoot()) {
  const override = typeof env.AI_USAGE_VIBE_USAGE_SRC === 'string' ? env.AI_USAGE_VIBE_USAGE_SRC.trim() : '';
  if (override) return override;
  const candidates = [
    join(repoRoot, 'vendor/vibe-usage/src'),
    join(repoRoot, '../vibe-usage-chatgpt-web/src'),
    join(repoRoot, '../vibe-usage/src'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'parsers/index.js'))) return dir;
  }
  return candidates[0];
}

export function resolveAiUsageHome(env = process.env) {
  const override = env.AI_USAGE_HOME?.trim();
  return override || join(homedir(), '.ai-usage');
}

export function applyAiUsageEnv(aiUsageHome) {
  const home = aiUsageHome ?? resolveAiUsageHome();
  process.env.AI_USAGE_HOME = home;
  process.env.VIBE_USAGE_CONFIG_DIR = home;
  process.env.VIBE_USAGE_STATE_DIR = home;
  process.env.VIBE_USAGE_CACHE_DIR = join(home, 'cache');
  process.env.VIBE_USAGE_CURSOR_MODE = 'device';
  process.env.VIBE_USAGE_CURSOR_DEVICE_LOG = join(home, 'cursor-device.jsonl');
  return home;
}

export function stripText(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripText);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'text') continue;
    out[key] = stripText(child);
  }
  return out;
}

function readSnapshot(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'snapshot.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function loadVibeUsageModules() {
  const vibeUsageSrc = resolveVibeUsageSrc();
  const parsersMod = await import(pathToFileURL(join(vibeUsageSrc, 'parsers/index.js')).href);
  const contractMod = await import(pathToFileURL(join(vibeUsageSrc, 'parsers/contract.js')).href);
  const configMod = await import(pathToFileURL(join(vibeUsageSrc, 'config.js')).href);
  const apiMod = await import(pathToFileURL(join(vibeUsageSrc, 'api.js')).href);
  return {
    parsers: parsersMod.parsers,
    normalizeParserResult: contractMod.normalizeParserResult,
    loadConfig: configMod.loadConfig,
    saveConfig: configMod.saveConfig,
    ingest: apiMod.ingest,
    getJson: apiMod.getJson,
  };
}

export function resolveStableHostname(config, hostname = osHostname()) {
  const fromConfig = typeof config?.hostname === 'string' ? config.hostname.trim() : '';
  if (fromConfig) return fromConfig;
  return String(hostname || '').replace(/\.local$/, '');
}

export function stampHostname(items, hostname) {
  if (!hostname) return items;
  for (const item of items) {
    if (!item?.hostname) item.hostname = hostname;
  }
  return items;
}


export async function collectLocal({ aiUsageHome } = {}) {
  applyAiUsageEnv(aiUsageHome);
  const { parsers, normalizeParserResult, loadConfig, saveConfig } = await loadVibeUsageModules();

  const buckets = [];
  const sessions = [];
  const succeededSources = [];

  for (const [source, parse] of Object.entries(parsers)) {
    let result;
    try {
      result = await parse();
    } catch (err) {
      process.stderr.write(`  ${source}: ${err.message}\n`);
      continue;
    }

    let normalized;
    try {
      normalized = normalizeParserResult(source, result);
    } catch (err) {
      process.stderr.write(`  ${source}: ${err.message}\n`);
      continue;
    }

    if (normalized.skipped) continue;

    succeededSources.push(source);
    if (normalized.buckets.length > 0) buckets.push(...normalized.buckets);
    if (normalized.sessions.length > 0) sessions.push(...normalized.sessions);
  }

  const config = loadConfig() || {};
  const host = resolveStableHostname(config);
  if (!config.hostname && host) {
    config.hostname = host;
    saveConfig(config);
  }
  stampHostname(buckets, host);
  stampHostname(sessions, host);

  const syncedAt = new Date().toISOString();
  return {
    buckets: stripText(buckets),
    sessions: stripText(sessions),
    syncedAt,
    succeededSources,
  };
}

function cloudErrorMessage(kind, err) {
  if (err?.message === 'UNAUTHORIZED' || err?.statusCode === 401) return '密钥无效';
  if (kind === 'ingest') return `上传失败：${err?.message || err}`;
  return '拉取失败，合计可能不完整';
}

async function defaultIngest(apiUrl, apiKey, buckets, sessions) {
  if (!buckets.length && !(sessions?.length)) return { ingested: 0 };
  const { ingest } = await loadVibeUsageModules();
  return ingest(apiUrl, apiKey, buckets, {}, sessions?.length ? sessions : undefined);
}

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

export async function dumpSnapshot({ aiUsageHome, ingestImpl, pullImpl } = {}) {
  const home = applyAiUsageEnv(aiUsageHome);
  const collected = await collectLocal({ aiUsageHome: home });
  const { loadConfig } = await loadVibeUsageModules();
  const config = loadConfig() || {};
  const host = resolveStableHostname(config);
  const previous = readSnapshot(home) || { buckets: [], sessions: [] };
  stampHostname(previous.buckets || [], host);
  stampHostname(previous.sessions || [], host);
  const local = mergeSnapshotBySourceForHost(previous, collected, host);
  local.buckets = dropCloudRows(local.buckets);
  local.sessions = dropCloudRows(local.sessions);

  const apiUrl = typeof config.apiUrl === 'string' ? config.apiUrl.trim() : '';
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const configured = Boolean(apiUrl && apiKey);

  let ingested = false;
  let pulled = false;
  let error = null;
  let remote = configured ? readRemoteCache(home) : { buckets: [], sessions: [], since: null };

  if (configured) {
    const doIngest = ingestImpl || defaultIngest;
    const doPull = pullImpl || defaultPull;
    try {
      const state = loadState();
      const bucketsOut = changedBuckets(local.buckets, state);
      const sessionsOut = changedSessions(local.sessions, state);
      await doIngest(apiUrl, apiKey, bucketsOut, sessionsOut);
      ingested = true;
      const next = markUploaded(state, bucketsOut, sessionsOut);
      pruneState(
        next,
        new Set(local.buckets.map((item) => bucketKey(item))),
        new Set(local.sessions.map((item) => sessionKey(item))),
        new Set(collected.succeededSources || []),
      );
      saveState(next);
    } catch (err) {
      error = cloudErrorMessage('ingest', err);
    }
    try {
      const page = await doPull({ apiUrl, apiKey, since: remote.since });
      remote = applyPull(remote, page);
      writeRemoteCache(home, remote);
      pulled = true;
    } catch (err) {
      const pullErr = cloudErrorMessage('pull', err);
      error = error ? `${error}；${pullErr}` : pullErr;
    }
  }

  const merged = mergeLocalAndRemote(local, remote, host);
  const snapshot = {
    buckets: dropCloudRows(merged.buckets),
    sessions: dropCloudRows(merged.sessions),
    syncedAt: collected.syncedAt,
    cloud: cloudStatus({ configured, ingested, pulled, error }),
  };
  const snapshotPath = join(home, 'snapshot.json');

  mkdirSync(home, { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  return { snapshotPath, ingested, pulled, cloudError: error, ...snapshot };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  dumpSnapshot()
    .then(({ snapshotPath, buckets, sessions }) => {
      console.log(`Wrote ${snapshotPath} (${buckets.length} buckets, ${sessions.length} sessions)`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
