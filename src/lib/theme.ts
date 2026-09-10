export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export function resolvedTheme(pref: ThemePref, prefersDark: boolean): ResolvedTheme {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): ResolvedTheme {
  const prefersDark =
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = resolvedTheme(pref, prefersDark);
  root.dataset.theme = theme;
  return theme;
}
