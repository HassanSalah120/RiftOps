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
