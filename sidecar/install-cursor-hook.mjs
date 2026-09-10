#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HOOK_EVENTS = ['stop', 'subagentStop'];
const SCRIPT_NAME = 'ai-usage-cursor-device.mjs';
const MARKER = 'ai-usage-cursor-device';

export function cursorHome(env = process.env) {
  const override = env.AI_USAGE_CURSOR_HOME?.trim() || env.VIBE_USAGE_CURSOR_HOME?.trim();
  if (override) return override;
  return join(homedir(), '.cursor');
}

export function hookScriptTemplate() {
  return join(dirname(fileURLToPath(import.meta.url)), 'cursor-device-hook.mjs');
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function isOurHook(entry) {
  const command = typeof entry === 'string' ? entry : entry?.command;
  return typeof command === 'string' && command.includes(MARKER);
}

function readHooksFile(path) {
  if (!existsSync(path)) return { version: 1, hooks: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') return { version: 1, hooks: {} };
  if (!parsed.hooks || typeof parsed.hooks !== 'object') parsed.hooks = {};
  return parsed;
}

export function installCursorHook({ env = process.env, execPath = process.execPath } = {}) {
  const home = cursorHome(env);
  if (!existsSync(home)) {
    throw new Error('未找到 Cursor 配置目录。请先安装并打开过一次 Cursor。');
  }
  const dest = join(home, 'hooks', SCRIPT_NAME);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(hookScriptTemplate(), dest);
  try { chmodSync(dest, 0o755); } catch { /* Windows */ }

  const nodePath = env.AI_USAGE_NODE?.trim() || execPath;
  const hooksPath = join(home, 'hooks.json');
  const doc = readHooksFile(hooksPath);
  const command = `${quote(nodePath)} ${quote(dest)}`;
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(doc.hooks[event]) ? doc.hooks[event].filter((entry) => !isOurHook(entry)) : [];
    list.push({ command });
    doc.hooks[event] = list;
  }
  if (!doc.version) doc.version = 1;
  writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n');
  return { dest, hooksPath };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const result = installCursorHook();
    console.log(`Installed Cursor device hook:\n  ${result.dest}\n  ${result.hooksPath}`);
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
}
