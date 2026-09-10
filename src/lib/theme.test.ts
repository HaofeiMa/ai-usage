import { describe, expect, it } from 'vitest';
import { resolvedTheme } from './theme.js';

describe('resolvedTheme', () => {
  it('follows the OS preference when set to system', () => {
    expect(resolvedTheme('system', true)).toBe('dark');
    expect(resolvedTheme('system', false)).toBe('light');
  });

  it('honors an explicit light or dark choice', () => {
    expect(resolvedTheme('light', true)).toBe('light');
    expect(resolvedTheme('dark', false)).toBe('dark');
  });
});
