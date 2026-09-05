export type ChampSelectAction = {
  id?: number;
  actorCellId?: number;
  championId?: number;
  completed?: boolean;
  isAllyAction?: boolean;
  isInProgress?: boolean;
  pickTurn?: number;
  type?: string;
};

// LCU exposes pick-order and position swaps as small, versioned objects. The
// client has changed field names between League releases, so keep the shape
// intentionally permissive and resolve the useful fields at the UI boundary.
export type ChampSelectSwap = {
  id?: number;
  cellId?: number;
  requesterCellId?: number;
  requestingCellId?: number;
  targetCellId?: number;
  otherCellId?: number;
  state?: string;
  [key: string]: unknown;
};

export type ChampSelectSession = {
  actions?: ChampSelectAction[][];
  pickOrderSwaps?: ChampSelectSwap[];
  positionSwaps?: ChampSelectSwap[];
  localPlayerCellId?: number;
  gameId?: number | string;
  queueId?: number | string;
  gameMode?: string;
  gameType?: string;
  mapId?: number | string;
  myTeam?: Array<{
    cellId?: number;
    championId?: number;
    championPickIntent?: number;
    championName?: string;
    summonerId?: string | number;
    summonerName?: string;
    displayName?: string;
    selectedSkinId?: number;
    selectedSkinIndex?: number;
    spell1Id?: number;
    spell2Id?: number;
    assignedPosition?: string;
    assignedRole?: string;
    position?: string;
    role?: string;
    puuid?: string;
    muted?: boolean;
    isMuted?: boolean;
    team?: number;
    teamId?: number;
  }>;
  timer?: {
    phase?: string;
    timeLeft?: number;
    adjustedTimeLeftInPhase?: number;
    isInfinite?: boolean;
  };
};

export function localAssignedPosition(session: ChampSelectSession | null | undefined): string | null {
  const localCell = session?.localPlayerCellId;
  const member = localCell === undefined ? session?.myTeam?.[0] : session?.myTeam?.find((entry) => entry.cellId === localCell);
  const value = String(member?.assignedPosition || member?.assignedRole || member?.position || member?.role || '').trim().toUpperCase();
  if (!value || value === 'FILL' || value === 'NONE' || value === 'UNASSIGNED') return null;
  if (value === 'MID' || value === 'MIDDLE') return 'MIDDLE';
  if (value === 'BOT' || value === 'BOTTOM' || value === 'ADC') return 'BOTTOM';
  if (value === 'SUPPORT' || value === 'UTILITY' || value === 'SUP') return 'UTILITY';
  if (value === 'TOP') return 'TOP';
  if (value === 'JUNGLE' || value === 'JG') return 'JUNGLE';
  return null;
}

export type DraftTimingMode = 'immediate' | 'last-second' | 'after';

export function draftTimingRemainingMs(mode: DraftTimingMode, seconds: number, timer: ChampSelectSession['timer'], firstSeenAt: number, now: number): number {
  const threshold = Math.max(0, Number(seconds) || 0) * 1000;
  if (mode === 'immediate') return 0;
  if (mode === 'after') return Math.max(0, threshold - (now - firstSeenAt));
  if (timer?.isInfinite) return 0;
  const timeLeft = Number(timer?.adjustedTimeLeftInPhase ?? timer?.timeLeft);
  if (!Number.isFinite(timeLeft) || timeLeft <= 0) return 0;
  return Math.max(0, timeLeft - threshold);
}

export function hasChampSelectActionID(action: ChampSelectAction | null | undefined): action is ChampSelectAction & { id: number } {
  return action?.id !== undefined && action.id !== null && Number.isInteger(Number(action.id)) && Number(action.id) >= 0;
}

export function flattenChampSelectActions(session: ChampSelectSession | null | undefined): ChampSelectAction[] {
  return (session?.actions || []).flatMap((turn) => turn || []);
}

export function occupiedChampSelectChampionIDs(session: ChampSelectSession | null | undefined, excludedActionID?: number): Set<number> {
  return new Set(flattenChampSelectActions(session)
    .filter((action) => Number(action.id) !== excludedActionID)
    .filter((action) => action.type === 'ban' || action.type === 'pick')
    .map((action) => Number(action.championId || 0))
    .filter((championID) => championID > 0));
}

export function chooseChampSelectChampion(candidates: number[], occupied: Set<number>, available: number[] | null): number {
  const unique = candidates.filter((championID, index) => championID > 0 && candidates.indexOf(championID) === index);
  return unique.find((championID) => !occupied.has(championID) && (!available || available.length === 0 || available.includes(championID))) || 0;
}

// A zero fallback page intentionally inherits the primary pick's page. This
// keeps existing saved policies compatible while still allowing a dedicated
// loadout when the fallback champion is selected.
export function runePageForPick(primaryRunePageID: number, fallbackRunePageID: number, fallbackUsed: boolean): number {
  if (!fallbackUsed) return Math.max(0, Number(primaryRunePageID) || 0);
  return Math.max(0, Number(fallbackRunePageID) || Number(primaryRunePageID) || 0);
}

function isPendingDraftAction(action: ChampSelectAction): boolean {
  return !action.completed && (action.type === 'pick' || action.type === 'ban');
}

// LCU groups simultaneous actions into turns. The first group with an
// unfinished pick/ban is authoritative; future local actions are not yet
// lockable even when they already exist in the session payload.
export function currentChampSelectTurn(session: ChampSelectSession | null | undefined): ChampSelectAction[] {
  return (session?.actions || []).find((turn) => (turn || []).some(isPendingDraftAction)) || [];
}

export function currentLocalChampSelectAction(session: ChampSelectSession | null | undefined): ChampSelectAction | undefined {
  const localCell = session?.localPlayerCellId;
  if (localCell === undefined || localCell === null) return undefined;
  return currentChampSelectTurn(session).find((action) => action.actorCellId === localCell && isPendingDraftAction(action));
}

export function liveLocalChampSelectAction(session: ChampSelectSession | null | undefined): ChampSelectAction | undefined {
  const phase = String(session?.timer?.phase || '');
  if (phase && phase !== 'BAN_PICK') return undefined;
  return currentLocalChampSelectAction(session);
}

// During PLANNING, League permits declaring/hovering the first future pick,
// even though it is not the player's live BAN_PICK turn yet.
export function firstLocalPendingPick(session: ChampSelectSession | null | undefined): ChampSelectAction | undefined {
  const localCell = session?.localPlayerCellId;
  if (localCell === undefined || localCell === null) return undefined;
  return flattenChampSelectActions(session).find((action) => action.actorCellId === localCell && action.type === 'pick' && !action.completed);
}

export function champSelectSessionKey(session: ChampSelectSession): string {
  const gameID = String(session.gameId ?? '').trim();
  if (gameID && gameID !== '0') return `champselect:game:${gameID}`;

  // Action ids remain stable as champions are hovered and turns complete, so
  // this fallback changes for a genuinely new draft without resetting on every
  // poll of the current one.
  const actionIDs = flattenChampSelectActions(session)
    .filter(hasChampSelectActionID)
    .map((action) => Number(action.id))
    .join(',');
  return `champselect:actions:${session.localPlayerCellId ?? 'unknown'}:${actionIDs || 'pending'}`;
}
