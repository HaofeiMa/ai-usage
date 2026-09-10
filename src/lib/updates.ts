export const GITHUB_REPO = 'HaofeiMa/ai-usage';
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;
export const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export function normalizeVersion(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^v/i, '');
}

export function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a)
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10));
  const right = normalizeVersion(b)
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10));
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

export type UpdateStatus = 'current' | 'available' | 'unknown';

export function updateStatus(current: string, latest: string | null | undefined): UpdateStatus {
  if (!current || !latest) return 'unknown';
  return compareVersions(latest, current) > 0 ? 'available' : 'current';
}

export type GithubRelease = {
  tagName: string;
  name: string;
  notes: string;
  url: string;
};

export function parseGithubRelease(payload: unknown): GithubRelease | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  const tagName = typeof row.tag_name === 'string' ? row.tag_name : '';
  if (!tagName) return null;
  const htmlUrl = typeof row.html_url === 'string' ? row.html_url : GITHUB_RELEASES_URL;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name : tagName;
  const notes = typeof row.body === 'string' ? row.body.trim() : '';
  return { tagName, name, notes, url: htmlUrl };
}
