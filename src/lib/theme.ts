export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export function resolvedTheme(pref: ThemePref, prefersDark: boolean): ResolvedTheme {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

export function windowTheme(pref: ThemePref, resolved: ResolvedTheme): ResolvedTheme | null {
  if (pref === 'system') return null;
  return resolved;
}

export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): ResolvedTheme {
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = resolvedTheme(pref, prefersDark);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  void syncWindowTheme(windowTheme(pref, theme));
  return theme;
}

async function syncWindowTheme(theme: ResolvedTheme | null): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTheme(theme);
  } catch {
    // Browser preview and unit tests have no Tauri window.
  }
}
