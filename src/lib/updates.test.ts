import { describe, expect, it } from 'vitest';
import { compareVersions, parseGithubRelease, updateStatus } from './updates.js';

describe('update helpers', () => {
  it('compares dotted versions and ignores a v prefix', () => {
    expect(compareVersions('0.1.1', 'v0.1.2')).toBe(-1);
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('v0.1.1', '0.1.1')).toBe(0);
  });

  it('reports whether a newer GitHub tag is available', () => {
    expect(updateStatus('0.1.1', 'v0.1.1')).toBe('current');
    expect(updateStatus('0.1.1', '0.1.2')).toBe('available');
    expect(updateStatus('0.1.1', null)).toBe('unknown');
  });

  it('reads the latest GitHub release payload', () => {
    expect(
      parseGithubRelease({
        tag_name: 'v0.1.2',
        name: 'AI Usage 0.1.2',
        body: '- dock hide\n',
        html_url: 'https://github.com/HaofeiMa/ai-usage/releases/tag/v0.1.2',
      }),
    ).toEqual({
      tagName: 'v0.1.2',
      name: 'AI Usage 0.1.2',
      notes: '- dock hide',
      url: 'https://github.com/HaofeiMa/ai-usage/releases/tag/v0.1.2',
    });
    expect(parseGithubRelease({})).toBeNull();
  });
});
