import { describe, expect, it } from 'vitest';
import { applyTheme, resolvedTheme, windowTheme } from './theme.js';

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

describe('windowTheme', () => {
  it('lets the native title bar follow the OS when the preference is system', () => {
    expect(windowTheme('system', 'dark')).toBeNull();
    expect(windowTheme('system', 'light')).toBeNull();
  });

  it('pins the native title bar to an explicit light or dark choice', () => {
    expect(windowTheme('light', 'light')).toBe('light');
    expect(windowTheme('dark', 'dark')).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('sets data-theme and color-scheme so macOS chrome can follow the page', () => {
    const root = {
      dataset: {} as Record<string, string>,
      style: { colorScheme: '' },
    };
    expect(applyTheme('light', root as unknown as HTMLElement)).toBe('light');
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });
});
