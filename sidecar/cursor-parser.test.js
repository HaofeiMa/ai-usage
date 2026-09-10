import { describe, expect, it } from 'vitest';
import { entriesFromDeviceLog } from '../vendor/vibe-usage/src/parsers/cursor.js';

describe('cursor device log parser', () => {
  it('keeps the recorded project name from the hook jsonl', () => {
    const text = JSON.stringify({
      v: 1,
      event: 'stop',
      ts: '2026-09-10T06:50:18.215Z',
      model: 'cursor-grok-4.6-xhigh',
      input_tokens: 12,
      output_tokens: 3,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      generation_id: 'gen-project',
      project: 'ai-usage',
    });
    const entries = entriesFromDeviceLog(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].project).toBe('ai-usage');
  });
});
