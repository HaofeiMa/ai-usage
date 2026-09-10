import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname as osHostname } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export function mergeSnapshotBySource(previous, collected) {
  const succeeded = new Set(collected.succeededSources || []);
  const prevBuckets = Array.isArray(previous?.buckets) ? previous.buckets : [];
  const prevSessions = Array.isArray(previous?.sessions) ? previous.sessions : [];
  return {
    buckets: [
      ...(collected.buckets || []),
      ...prevBuckets.filter((item) => !succeeded.has(item?.source)),
    ],
    sessions: [
      ...(collected.sessions || []),
      ...prevSessions.filter((item) => !succeeded.has(item?.source)),
    ],
    syncedAt: collected.syncedAt,
  };
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

export function dropCloudRows(items) {
  return (items || []).filter((item) => item?.hostname !== 'cursor-cloud');
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

async function maybeIngest(buckets, sessions) {
  const { loadConfig, ingest } = await loadVibeUsageModules();
  const config = loadConfig();
  const apiUrl = config?.apiUrl?.trim();
  const apiKey = config?.apiKey?.trim();
  if (!apiUrl || !apiKey) return false;

  await ingest(apiUrl, apiKey, buckets, {}, sessions.length > 0 ? sessions : undefined);
  return true;
}

export async function dumpSnapshot({ aiUsageHome } = {}) {
  const home = applyAiUsageEnv(aiUsageHome);
  const collected = await collectLocal({ aiUsageHome: home });
  const merged = mergeSnapshotBySource(readSnapshot(home), collected);
  const snapshot = {
    ...merged,
    buckets: dropCloudRows(merged.buckets),
    sessions: dropCloudRows(merged.sessions),
  };
  const snapshotPath = join(home, 'snapshot.json');

  mkdirSync(home, { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  const ingested = await maybeIngest(snapshot.buckets, snapshot.sessions);
  return { snapshotPath, ingested, ...snapshot };
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
