/** Human-readable file size: "14.0 MB", "512 B", "—" for unknown (null/negative). */
export function formatBytes(bytes) {
  if (bytes == null || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}
