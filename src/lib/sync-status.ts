export function cloudSyncLabel(
  config: { apiUrl?: string; apiKey?: string },
  cloud?: { ingested?: boolean; pulled?: boolean; error?: string | null },
): string {
  if (!config.apiUrl?.trim() || !config.apiKey?.trim()) return '未配置云端';
  if (cloud?.error) return cloud.error;
  if (cloud?.pulled) return '已从云端合并其它设备';
  return '已配置，尚未拉取';
}
