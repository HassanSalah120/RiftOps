const RELEASE_PREFIX = '/HassanSalah120/RiftOps/';

export function safeReleaseURL(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    if (!parsed.pathname.toLowerCase().startsWith(RELEASE_PREFIX.toLowerCase())) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function externalBuildURL(provider: 'opgg' | 'ugg', championName: string, role: string): string | null {
  const champion = championName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const lane = role.trim().toLowerCase();
  const allowedLanes = new Set(['top', 'jungle', 'middle', 'bottom', 'utility', 'support', 'fill']);
  if (!champion || !allowedLanes.has(lane)) return null;
  const normalizedLane = lane === 'utility' ? 'support' : lane === 'fill' ? 'top' : lane;
  if (provider === 'opgg') return `https://op.gg/lol/champions/${encodeURIComponent(champion)}/build/${encodeURIComponent(normalizedLane)}`;
  if (provider === 'ugg') return `https://u.gg/lol/champions/${encodeURIComponent(champion)}/build/${encodeURIComponent(normalizedLane)}`;
  return null;
}
