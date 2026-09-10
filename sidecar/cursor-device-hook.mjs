#!/usr/bin/env node
// Cursor device hook for AI Usage. Observes stop / subagentStop, appends
// token counts, never prints prompt text. Always fail-open.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

function token(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function pick(input, ...keys) {
  for (const key of keys) {
    const value = input?.[key];
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function projectFromWorkspace(input) {
  const roots = pick(input, 'workspace_roots', 'workspaceRoots');
  const list = Array.isArray(roots) ? roots : roots ? [roots] : [];
  const first = String(list[0] || '')
    .trim()
    .replace(/^\/([a-zA-Z]:)/, '$1')
    .replace(/[\\/]+$/, '');
  if (!first) return undefined;
  return first.split(/[\\/]/).filter(Boolean).at(-1) || undefined;
}

export function cursorDeviceLogPath(env = process.env) {
  const explicit = env.VIBE_USAGE_CURSOR_DEVICE_LOG?.trim() || env.AI_USAGE_CURSOR_DEVICE_LOG?.trim();
  if (explicit) return explicit;
  const home = env.AI_USAGE_HOME?.trim() || join(homedir(), '.ai-usage');
  return join(home, 'cursor-device.jsonl');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

export function recordFromPayload(input) {
  const event = String(pick(input, 'hook_event_name', 'hookEventName', 'event') || 'stop');
  const model = String(pick(input, 'model', 'model_name', 'modelName') || '').trim();
  const inputTokens = token(pick(input, 'input_tokens', 'inputTokens'));
  const outputTokens = token(pick(input, 'output_tokens', 'outputTokens'));
  const cacheRead = token(pick(input, 'cache_read_tokens', 'cacheReadTokens'));
  const cacheWrite = token(pick(input, 'cache_write_tokens', 'cacheWriteTokens'));
  if (!model) return null;
  if (inputTokens + outputTokens + cacheRead + cacheWrite === 0) return null;

  return {
    v: 1,
    event,
    ts: new Date().toISOString(),
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    conversation_id: pick(input, 'conversation_id', 'conversationId') || undefined,
    generation_id: pick(input, 'generation_id', 'generationId') || undefined,
    subagent_id: pick(input, 'subagent_id', 'subagentId') || undefined,
    project: projectFromWorkspace(input),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const raw = await readStdin();
    if (raw) {
      let input;
      try { input = JSON.parse(raw); } catch { input = null; }
      const record = input ? recordFromPayload(input) : null;
      if (record) {
        const path = cursorDeviceLogPath();
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify(record) + '\n');
      }
    }
  } catch {
    // fail open
  }

  process.stdout.write('{}\n');
  process.exit(0);
}
