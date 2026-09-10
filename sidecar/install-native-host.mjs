#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const NATIVE_HOST_NAME = 'com.aiusage.chatgpt';
export const EXTENSION_ID = 'mkcbknlcbjgbbabclannkpdeaigfjodl';

export function nativeHostTemplate() {
  return join(dirname(fileURLToPath(import.meta.url)), '../native-host/host.mjs');
}

export function chromeNativeHostDirs(env = process.env, home = homedir()) {
  const override = env.AI_USAGE_NATIVE_HOST_DIRS?.trim();
  if (override) return override.split(delimiter).filter(Boolean);
  if (process.platform === 'darwin') {
    const appSupport = join(home, 'Library', 'Application Support');
    return [
      join(appSupport, 'Google', 'Chrome', 'NativeMessagingHosts'),
      join(appSupport, 'Google', 'Chrome Beta', 'NativeMessagingHosts'),
      join(appSupport, 'Google', 'Chrome Canary', 'NativeMessagingHosts'),
      join(appSupport, 'Chromium', 'NativeMessagingHosts'),
      join(appSupport, 'Microsoft Edge', 'NativeMessagingHosts'),
      join(appSupport, 'Microsoft Edge Beta', 'NativeMessagingHosts'),
      join(appSupport, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      join(appSupport, 'Arc', 'User Data', 'NativeMessagingHosts'),
    ];
  }
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local');
    return [
      join(local, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts'),
      join(local, 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts'),
    ];
  }
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return [
    join(config, 'google-chrome', 'NativeMessagingHosts'),
    join(config, 'chromium', 'NativeMessagingHosts'),
    join(config, 'microsoft-edge', 'NativeMessagingHosts'),
  ];
}

function rewriteShebang(source, nodePath) {
  const text = readFileSync(source, 'utf8');
  const body = text.replace(/^#!.*\n/, '');
  return `#!${nodePath}\n${body}`;
}

export function installNativeHost({
  env = process.env,
  execPath = process.execPath,
  aiUsageHome,
} = {}) {
  const home = aiUsageHome || env.AI_USAGE_HOME?.trim() || join(homedir(), '.ai-usage');
  const nodePath = env.AI_USAGE_NODE?.trim() || execPath;
  const template = nativeHostTemplate();
  if (!existsSync(template)) {
    throw new Error(`找不到 Native host 脚本：${template}`);
  }

  mkdirSync(home, { recursive: true });
  const dest = join(home, 'native-host.mjs');
  writeFileSync(dest, rewriteShebang(template, nodePath));
  try { chmodSync(dest, 0o755); } catch { /* Windows */ }

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'AI Usage ChatGPT web workload jsonl writer',
    path: dest,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  const written = [];
  for (const dir of chromeNativeHostDirs(env)) {
    mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    written.push(manifestPath);
  }
  return { dest, written, extensionId: EXTENSION_ID };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const result = installNativeHost();
    console.log(`Native host: ${result.dest}\n${result.written.join('\n')}`);
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
}
