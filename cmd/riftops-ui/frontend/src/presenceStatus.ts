import type { Snapshot } from './types';

type PresenceSnapshot = Pick<Snapshot, 'Phase' | 'ChatPort' | 'Enabled' | 'Status'>;

export function presenceRuntimeLabel(snapshot: PresenceSnapshot): string {
  if (snapshot.Phase === 'idle' || snapshot.Phase === 'error') return 'Proxy idle';
  if (snapshot.Phase === 'stopping') return 'Stopping';
  if (snapshot.ChatPort > 0) return snapshot.Phase === 'active' ? 'Proxy active' : 'Proxy connecting';
  return snapshot.Phase === 'active' ? 'Native chat · masking unavailable' : 'Starting Riot';
}

export function displayedPresence(snapshot: PresenceSnapshot, leagueAvailability?: string): string {
  const masked = snapshot.Enabled && snapshot.ChatPort > 0;
  const native = snapshot.Phase === 'active' && snapshot.ChatPort === 0;
  const value = masked ? snapshot.Status : leagueAvailability || (native ? '' : snapshot.Status);
  return value === 'chat' ? 'online' : value;
}
