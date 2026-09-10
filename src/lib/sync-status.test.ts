import { describe, expect, it } from 'vitest';
import { cloudSyncLabel } from './sync-status.js';

describe('cloudSyncLabel', () => {
  it('says unconfigured when url or key is missing', () => {
    expect(cloudSyncLabel({}, undefined)).toBe('未配置云端');
    expect(cloudSyncLabel({ apiUrl: 'https://example.workers.dev' })).toBe('未配置云端');
    expect(cloudSyncLabel({ apiKey: 'secret' })).toBe('未配置云端');
  });

  it('prefers the cloud error when configured', () => {
    expect(
      cloudSyncLabel(
        { apiUrl: 'https://example.workers.dev', apiKey: 'secret' },
        { error: '拉取失败，合计可能不完整' },
      ),
    ).toBe('拉取失败，合计可能不完整');
  });

  it('reports a successful pull', () => {
    expect(
      cloudSyncLabel(
        { apiUrl: 'https://example.workers.dev', apiKey: 'secret' },
        { ingested: true, pulled: true },
      ),
    ).toBe('已从云端合并其它设备');
  });

  it('says configured but not yet pulled', () => {
    expect(
      cloudSyncLabel({ apiUrl: 'https://example.workers.dev', apiKey: 'secret' }, { pulled: false }),
    ).toBe('已配置，尚未拉取');
  });
});
