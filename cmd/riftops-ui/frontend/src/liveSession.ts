export type LiveSessionPhase =
  | 'IDLE'
  | 'QUEUE'
  | 'READY_CHECK'
  | 'CHAMP_SELECT'
  | 'LOADING'
  | 'IN_GAME'
  | 'RECONNECTING'
  | 'POST_GAME';
const ACTIVE_PHASES = new Set<LiveSessionPhase>([
  'QUEUE', 'READY_CHECK', 'CHAMP_SELECT', 'LOADING', 'IN_GAME', 'RECONNECTING', 'POST_GAME',
]);

/** Translate the LCU's current gameflow value into the small stable state
 * machine used by the Live Session page. */
export function normalizeLivePhase(rawPhase: string | null | undefined, queueState = ''): LiveSessionPhase {
  const phase = String(rawPhase || '').trim().toLowerCase().replace(/[_ -]/g, '');
  const queue = String(queueState || '').trim().toLowerCase();
  if (phase === 'matchmaking' || phase === 'searching' || phase === 'queue' || queue === 'searching' || queue === 'inprogress') return 'QUEUE';
  if (phase === 'readycheck' || phase === 'ready') return 'READY_CHECK';
  if (phase === 'champselect' || phase === 'championselect') return 'CHAMP_SELECT';
  if (phase === 'gamestart' || phase === 'loading' || phase === 'preendofgame') return 'LOADING';
  if (phase === 'inprogress' || phase === 'ingame' || phase === 'game') return 'IN_GAME';
  if (phase === 'reconnect' || phase === 'reconnecting') return 'RECONNECTING';
  if (phase === 'endofgame' || phase === 'postgame') return 'POST_GAME';
  return 'IDLE';
}

export function isActiveLivePhase(phase: LiveSessionPhase): boolean {
  return ACTIVE_PHASES.has(phase);
}

export function livePhaseLabel(phase: LiveSessionPhase): string {
  switch (phase) {
    case 'QUEUE': return 'Queue';
    case 'READY_CHECK': return 'Ready';
    case 'CHAMP_SELECT': return 'Champ Select';
    case 'LOADING': return 'Loading';
    case 'IN_GAME': return 'In Game';
    case 'RECONNECTING': return 'Reconnecting';
    case 'POST_GAME': return 'Post Game';
    default: return 'Idle';
  }
}

export function livePhaseDescription(phase: LiveSessionPhase): string {
  switch (phase) {
    case 'QUEUE': return 'Searching for a match';
    case 'READY_CHECK': return 'A match is waiting for your response';
    case 'CHAMP_SELECT': return 'Make your pick and ban decisions';
    case 'LOADING': return 'League is starting the match';
    case 'IN_GAME': return 'Match in progress';
    case 'RECONNECTING': return 'Trying to restore the League connection';
    case 'POST_GAME': return 'Match complete — results are ready';
    default: return 'No active queue or game';
  }
}

export function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}
