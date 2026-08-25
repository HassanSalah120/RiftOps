/**
 * Arena's Bravery choice is a League-owned special pick, not a champion ID.
 * Current LCU-compatible clients represent it as championId -3. Keep this
 * value isolated and only send it when the active queue/session is Arena.
 */
export const ARENA_BRAVERY_CHAMPION_ID = -3;

export type ArenaQueueLike = {
  id?: number;
  gameMode?: string;
  name?: string;
  description?: string;
} | number | null | undefined;

export function isArenaQueue(queue: ArenaQueueLike): boolean {
  if (typeof queue === 'number') return queue === 1700 || queue === 1710;
  if (!queue) return false;
  const mode = String(queue.gameMode || '').trim().toUpperCase();
  const name = String(queue.name || '').trim().toUpperCase();
  const description = String(queue.description || '').trim().toUpperCase();
  return Number(queue.id) === 1700
    || Number(queue.id) === 1710
    || mode === 'ARENA'
    || mode === 'CHERRY'
    || /\bARENA\b/.test(name)
    || /\bARENA\b/.test(description);
}

export function isArenaChampSelect(session: {
  queueId?: number | string;
  gameMode?: string;
  gameType?: string;
  mapId?: number | string;
} | null | undefined): boolean {
  if (!session) return false;
  return isArenaQueue(Number(session.queueId || 0))
    || ['ARENA', 'CHERRY'].includes(String(session.gameMode || '').toUpperCase())
    || ['ARENA', 'CHERRY'].includes(String(session.gameType || '').toUpperCase())
    || Number(session.mapId) === 30;
}

export function isArenaBraveryPick(championId: number | string | null | undefined): boolean {
  return Number(championId) === ARENA_BRAVERY_CHAMPION_ID;
}

export function shouldUseArenaBravery(enabled: boolean, queue: ArenaQueueLike, session?: Parameters<typeof isArenaChampSelect>[0]): boolean {
  return enabled && (isArenaQueue(queue) || isArenaChampSelect(session));
}
