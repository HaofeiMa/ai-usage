import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cursorDeviceLogPath, recordFromPayload } from './cursor-device-hook.mjs';
import { installCursorHook } from './install-cursor-hook.mjs';

const hookScript = fileURLToPath(new URL('./cursor-device-hook.mjs', import.meta.url));

describe('cursor device hook', () => {
  it('defaults the log path to ~/.ai-usage/cursor-device.jsonl', () => {
    expect(cursorDeviceLogPath({ AI_USAGE_HOME: '/tmp/ai-home' })).toBe('/tmp/ai-home/cursor-device.jsonl');
    expect(cursorDeviceLogPath({ VIBE_USAGE_CURSOR_DEVICE_LOG: '/tmp/custom.jsonl' })).toBe('/tmp/custom.jsonl');
  });

  it('writes JSONL and stays fail-open on garbage stdin', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-usage-cursor-hook-'));
    const logPath = join(root, 'cursor-device.jsonl');
    try {
      const ok = spawnSync(process.execPath, [hookScript], {
        encoding: 'utf-8',
        input: JSON.stringify({
          hook_event_name: 'stop',
          model: 'composer-1.5',
          input_tokens: 12,
          output_tokens: 3,
          generation_id: 'gen-hook',
        }),
        env: { ...process.env, VIBE_USAGE_CURSOR_DEVICE_LOG: logPath },
      });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toMatch(/\{\}/);
      const rec = JSON.parse(readFileSync(logPath, 'utf8').trim());
      expect(rec.v).toBe(1);
      expect(rec.model).toBe('composer-1.5');
      expect(rec.input_tokens).toBe(12);

      const garbage = spawnSync(process.execPath, [hookScript], {
        encoding: 'utf-8',
        input: 'not-json',
        env: { ...process.env, VIBE_USAGE_CURSOR_DEVICE_LOG: logPath },
      });
      expect(garbage.status).toBe(0);
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs into a fake Cursor home', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-usage-cursor-home-'));
    try {
      const result = installCursorHook({
        env: { AI_USAGE_CURSOR_HOME: root, AI_USAGE_NODE: '/opt/homebrew/bin/node' },
      });
      expect(existsSync(result.dest)).toBe(true);
      const hooks = JSON.parse(readFileSync(join(root, 'hooks.json'), 'utf8'));
      expect(hooks.hooks.stop[0].command).toContain('/opt/homebrew/bin/node');
      expect(hooks.hooks.stop[0].command).toContain('ai-usage-cursor-device.mjs');
      expect(hooks.hooks.subagentStop[0].command).toContain('ai-usage-cursor-device.mjs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recordFromPayload ignores prompt-only payloads', () => {
    expect(recordFromPayload({ model: 'x' })).toBeNull();
    expect(recordFromPayload({ model: 'x', input_tokens: 4 }).input_tokens).toBe(4);
  });

  it('records the workspace folder name as project', () => {
    const rec = recordFromPayload({
      model: 'composer-1.5',
      input_tokens: 12,
      workspace_roots: ['/Volumes/MobileSSD/Program/My/ai-usage'],
    });
    expect(rec?.project).toBe('ai-usage');
  });

  it('uses the first workspace root and strips a trailing slash', () => {
    const rec = recordFromPayload({
      model: 'composer-1.5',
      input_tokens: 4,
      workspace_roots: ['/Users/me/vibe-usage/', '/Users/me/other'],
    });
    expect(rec?.project).toBe('vibe-usage');
  });
});
