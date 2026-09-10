import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EXTENSION_ID, installNativeHost, NATIVE_HOST_NAME } from './install-native-host.mjs';

describe('installNativeHost', () => {
  it('copies the host and writes manifests for override dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-usage-native-'));
    const dirA = join(root, 'chrome', 'NativeMessagingHosts');
    const dirB = join(root, 'edge', 'NativeMessagingHosts');
    const home = join(root, 'home');
    try {
      const result = installNativeHost({
        env: {
          AI_USAGE_HOME: home,
          AI_USAGE_NODE: '/opt/homebrew/bin/node',
          AI_USAGE_NATIVE_HOST_DIRS: [dirA, dirB].join(':'),
        },
      });
      expect(result.extensionId).toBe(EXTENSION_ID);
      expect(existsSync(result.dest)).toBe(true);
      expect(readFileSync(result.dest, 'utf8').startsWith('#!/opt/homebrew/bin/node\n')).toBe(true);
      expect(result.written).toEqual([
        join(dirA, `${NATIVE_HOST_NAME}.json`),
        join(dirB, `${NATIVE_HOST_NAME}.json`),
      ]);
      const manifest = JSON.parse(readFileSync(result.written[0], 'utf8'));
      expect(manifest.path).toBe(result.dest);
      expect(manifest.allowed_origins).toEqual([`chrome-extension://${EXTENSION_ID}/`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
