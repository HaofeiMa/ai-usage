import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VIBE_USAGE_SRC = fileURLToPath(new URL('../../vibe-usage-chatgpt-web/src/', import.meta.url));

export function resolveAiUsageHome(env = process.env) {
  const override = env.AI_USAGE_HOME?.trim();
  return override || join(homedir(), '.ai-usage');
}

export function applyAiUsageEnv(aiUsageHome) {
  const home = aiUsageHome ?? resolveAiUsageHome();
  process.env.AI_USAGE_HOME = home;
  process.env.VIBE_USAGE_CONFIG_DIR = home;
  process.env.VIBE_USAGE_STATE_DIR = home;
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

async function loadVibeUsageModules() {
  const parsersMod = await import(pathToFileURL(join(VIBE_USAGE_SRC, 'parsers/index.js')).href);
  const contractMod = await import(pathToFileURL(join(VIBE_USAGE_SRC, 'parsers/contract.js')).href);
  const configMod = await import(pathToFileURL(join(VIBE_USAGE_SRC, 'config.js')).href);
  const apiMod = await import(pathToFileURL(join(VIBE_USAGE_SRC, 'api.js')).href);
  return {
    parsers: parsersMod.parsers,
    normalizeParserResult: contractMod.normalizeParserResult,
    loadConfig: configMod.loadConfig,
    ingest: apiMod.ingest,
  };
}

export async function collectLocal({ aiUsageHome } = {}) {
  applyAiUsageEnv(aiUsageHome);
  const { parsers, normalizeParserResult } = await loadVibeUsageModules();

  const buckets = [];
  const sessions = [];

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

    if (normalized.buckets.length > 0) buckets.push(...normalized.buckets);
    if (normalized.sessions.length > 0) sessions.push(...normalized.sessions);
  }

  const syncedAt = new Date().toISOString();
  return {
    buckets: stripText(buckets),
    sessions: stripText(sessions),
    syncedAt,
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
  const snapshot = await collectLocal({ aiUsageHome: home });
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
