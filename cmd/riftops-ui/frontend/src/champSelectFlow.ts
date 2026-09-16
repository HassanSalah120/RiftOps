export type ChampSelectAction = {
  id?: number;
  actorCellId?: number;
  championId?: number;
  completed?: boolean;
  isAllyAction?: boolean;
  isInProgress?: boolean;
  pickTurn?: number;
  type?: string;
  [key: string]: unknown;
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

export type PickOrderSwapChoice = {
  swap: ChampSelectSwap;
  id: number;
  targetCellId?: number;
  targetPickTurn: number;
};

export type PickOrderSwapTarget = 'latest' | 'pick-1' | 'pick-2' | 'pick-3' | 'pick-4' | 'pick-5';

export type PickRole = 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY';

export type RolePickPlan = {
  pickChampionId: number;
  fallbackPickChampionId: number;
  pickRunePageId: number;
  fallbackPickRunePageId: number;
};

export type DraftQueueKind = 'role-based' | 'roleless' | 'arena' | 'aram' | 'practice' | 'custom';
export type DraftDecisionState = 'ready' | 'waiting-for-role' | 'missing-plan' | 'manual-override' | 'blocked';
export type DraftPickPlanSource = 'role' | 'legacy' | 'none';

export type DraftContext = {
  localCellId: number | null;
  assignedRole: PickRole | null;
  queueKind: DraftQueueKind;
  pickPlan: RolePickPlan | null;
  planSource: DraftPickPlanSource;
  state: DraftDecisionState;
  reason?: string;
};

export type DraftContextOptions = {
  roleAwarePicks: boolean;
  rolePickPlans?: Partial<Record<PickRole, RolePickPlan>> | null;
  legacyPickPlan?: RolePickPlan | null;
  queueKind?: DraftQueueKind;
};

export type ChampSelectSession = {
  actions?: ChampSelectAction[][];
  id?: string | number;
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
    pickTurn?: number;
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

function numericField(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/**
 * League has kept the champion-select payload mostly stable, but a few
 * client/legacy routes use different casing (and `actorCellID`). Keep that
 * dialect handling here so the automation loop has one canonical vocabulary.
 */
export function champSelectActionType(action: ChampSelectAction | null | undefined): 'pick' | 'ban' | null {
  const value = String(action?.type || '').trim().toUpperCase().replace(/[-\s]/g, '_');
  if (value === 'PICK' || value === 'CHAMPION_PICK' || value === 'CHAMPIONPICK') return 'pick';
  if (value === 'BAN' || value === 'CHAMPION_BAN' || value === 'CHAMPIONBAN') return 'ban';
  return null;
}

export function normalizeChampSelectPhase(value: unknown): string {
  const phase = String(value || '').trim().toUpperCase().replace(/[-\s]/g, '_');
  if (phase === 'BANPICK' || phase === 'BAN_PICK') return 'BAN_PICK';
  if (phase === 'FINALIZATION' || phase === 'PLANNING') return phase;
  return phase;
}

export function normalizeChampSelectSession(value: unknown): ChampSelectSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
  // A few legacy/custom-session responses flatten actions into one array.
  // Treat that as a single turn instead of silently dropping every action.
  const actionTurns = rawActions.length > 0 && !Array.isArray(rawActions[0]) ? [rawActions] : rawActions;
  const actions = actionTurns.map((turn) => (Array.isArray(turn) ? turn : [])
    .filter((action): action is Record<string, unknown> => Boolean(action && typeof action === 'object' && !Array.isArray(action)))
    .map((action) => {
      const normalizedType = champSelectActionType({ type: String(action.type || '') });
      return {
        ...action,
        id: numericField(action.id),
        actorCellId: numericField(action.actorCellId ?? action.actorCellID),
        championId: numericField(action.championId ?? action.championID),
        type: normalizedType || String(action.type || '').trim().toLowerCase().replace(/[-\s]/g, '_') || undefined,
      } as ChampSelectAction;
    }));
  const rawTimer = raw.timer && typeof raw.timer === 'object' && !Array.isArray(raw.timer)
    ? raw.timer as Record<string, unknown>
    : undefined;
  const myTeam = Array.isArray(raw.myTeam)
    ? raw.myTeam.filter((member): member is Record<string, unknown> => Boolean(member && typeof member === 'object' && !Array.isArray(member))).map((member) => ({
      ...member,
      cellId: numericField(member.cellId ?? member.cellID),
      pickTurn: numericField(member.pickTurn),
      championId: numericField(member.championId ?? member.championID),
    }))
    : undefined;
  return {
    ...raw as ChampSelectSession,
    localPlayerCellId: numericField(raw.localPlayerCellId ?? raw.localPlayerCellID),
    gameId: (raw.gameId ?? raw.gameID) as string | number | undefined,
    queueId: (raw.queueId ?? raw.queueID) as string | number | undefined,
    actions,
    myTeam,
    timer: rawTimer ? {
      ...rawTimer,
      phase: normalizeChampSelectPhase(rawTimer.phase),
      timeLeft: Number(rawTimer.timeLeft ?? rawTimer.timeLeftInPhase),
      adjustedTimeLeftInPhase: Number(rawTimer.adjustedTimeLeftInPhase ?? rawTimer.adjustedTimeLeft),
    } : undefined,
  };
}

export function localAssignedPosition(session: ChampSelectSession | null | undefined): string | null {
  const localCell = numericField(session?.localPlayerCellId);
  const member = localCell === undefined ? session?.myTeam?.[0] : session?.myTeam?.find((entry) => numericField(entry.cellId) === localCell);
  const value = String(member?.assignedPosition || member?.assignedRole || member?.position || member?.role || '').trim().toUpperCase();
  if (!value || value === 'FILL' || value === 'NONE' || value === 'UNASSIGNED') return null;
  if (value === 'MID' || value === 'MIDDLE') return 'MIDDLE';
  if (value === 'BOT' || value === 'BOTTOM' || value === 'ADC') return 'BOTTOM';
  if (value === 'SUPPORT' || value === 'UTILITY' || value === 'SUP') return 'UTILITY';
  if (value === 'TOP') return 'TOP';
  if (value === 'JUNGLE' || value === 'JG') return 'JUNGLE';
  return null;
}

export function rolePickPlanFor(role: string | null | undefined, plans: Partial<Record<PickRole, RolePickPlan>> | null | undefined): RolePickPlan | null {
  const normalized = String(role || '').trim().toUpperCase() as PickRole;
  if (!['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].includes(normalized)) return null;
  return plans?.[normalized] || null;
}

export function resolveDraftContext(session: ChampSelectSession | null | undefined, options: DraftContextOptions): DraftContext {
  const localCellValue = Number(session?.localPlayerCellId);
  const localCellId = Number.isSafeInteger(localCellValue) && localCellValue >= 0 ? localCellValue : null;
  const assignedRole = localAssignedPosition(session) as PickRole | null;
  const queueKind = options.queueKind || 'role-based';
  const legacyPickPlan = options.legacyPickPlan || null;

  // ARAM cards/bench state are authoritative. Never surface a ranked/global
  // champion plan here: doing so can make Full Auto select an unrelated lane
  // champion in custom Howling Abyss sessions.
  if (queueKind === 'aram') {
    return {
      localCellId,
      assignedRole,
      queueKind,
      pickPlan: null,
      planSource: 'none',
      state: 'ready',
      reason: 'ARAM uses League’s assigned champion or live cards; ranked pick plans are ignored.',
    };
  }

  if (!options.roleAwarePicks || queueKind !== 'role-based') {
    return {
      localCellId,
      assignedRole,
      queueKind,
      pickPlan: legacyPickPlan,
      planSource: legacyPickPlan ? 'legacy' : 'none',
      state: legacyPickPlan && (legacyPickPlan.pickChampionId > 0 || legacyPickPlan.fallbackPickChampionId > 0) ? 'ready' : 'blocked',
      reason: legacyPickPlan && (legacyPickPlan.pickChampionId > 0 || legacyPickPlan.fallbackPickChampionId > 0) ? undefined : 'Choose a champion in the global pick plan.',
    };
  }

  if (!assignedRole) {
    return {
      localCellId,
      assignedRole: null,
      queueKind,
      pickPlan: null,
      planSource: 'none',
      state: 'waiting-for-role',
      reason: 'Waiting for League to assign a concrete lane.',
    };
  }

  const pickPlan = rolePickPlanFor(assignedRole, options.rolePickPlans);
  if (!pickPlan || (pickPlan.pickChampionId <= 0 && pickPlan.fallbackPickChampionId <= 0)) {
    return {
      localCellId,
      assignedRole,
      queueKind,
      pickPlan: pickPlan || null,
      planSource: 'none',
      state: 'missing-plan',
      reason: `No ${assignedRole} pick plan is configured.`,
    };
  }

  return { localCellId, assignedRole, queueKind, pickPlan, planSource: 'role', state: 'ready' };
}

export function isManualChampSelectHover(currentHoverId: number, selectedChampionId: number, ownHoverPending: boolean): boolean {
  return currentHoverId > 0 && currentHoverId !== selectedChampionId && !ownHoverPending;
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
  const turns = session?.actions || [];
  if (turns.length > 0 && !Array.isArray(turns[0])) {
    return turns as unknown as ChampSelectAction[];
  }
  return turns.flatMap((turn) => turn || []);
}

export function occupiedChampSelectChampionIDs(session: ChampSelectSession | null | undefined, excludedActionID?: number): Set<number> {
  return new Set(flattenChampSelectActions(session)
    .filter((action) => Number(action.id) !== excludedActionID)
    .filter((action) => champSelectActionType(action) !== null)
    .map((action) => Number(action.championId || 0))
    .filter((championID) => championID > 0));
}

export function chooseChampSelectChampion(candidates: number[], occupied: Set<number>, available: number[] | null): number {
  const unique = candidates.filter((championID, index) => championID > 0 && candidates.indexOf(championID) === index);
  return unique.find((championID) => !occupied.has(championID) && (!available || available.includes(championID))) || 0;
}

function integerField(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function swapField(swap: ChampSelectSwap, fields: string[]): number | undefined {
  for (const field of fields) {
    const value = integerField(swap[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function swapState(swap: ChampSelectSwap): string {
  return String(swap.state || swap.status || '').trim().toUpperCase();
}

function finishedSwap(swap: ChampSelectSwap): boolean {
  const state = swapState(swap);
  return state.includes('ACCEPT') || state.includes('DECLIN') || state.includes('CANCEL') || state.includes('COMPLETE') || state.includes('REJECT');
}

function pendingSwap(swap: ChampSelectSwap): boolean {
  const state = swapState(swap);
  return state.includes('PENDING') || state.includes('REQUEST') || state.includes('OFFER');
}

function swapTargetCell(swap: ChampSelectSwap, localCellID: number): number | undefined {
  const target = swapField(swap, ['targetCellId', 'targetCellID', 'otherCellId', 'otherCellID', 'cellId', 'cellID']);
  if (target !== undefined && target !== localCellID) return target;
  const requester = swapField(swap, ['requesterCellId', 'requesterCellID', 'requestingCellId', 'requestingCellID']);
  return requester !== localCellID ? requester : undefined;
}

function swapID(swap: ChampSelectSwap): number | undefined {
  return swapField(swap, ['id', 'swapId', 'requestId', 'cellId', 'targetCellId', 'otherCellId']);
}

function swapTargetPickTurn(swap: ChampSelectSwap): number | undefined {
  return swapField(swap, ['targetPickTurn', 'targetTurn', 'otherPickTurn', 'otherTurn', 'pickTurn']);
}

function pickTurnForCell(session: ChampSelectSession, cellID: number): number {
  let highest = -1;
  for (const member of session.myTeam || []) {
    if (integerField(member.cellId) === cellID) highest = Math.max(highest, integerField(member.pickTurn) ?? -1);
  }
  for (const action of flattenChampSelectActions(session)) {
    if (champSelectActionType(action) !== 'pick' || integerField(action.actorCellId) !== cellID) continue;
    highest = Math.max(highest, integerField(action.pickTurn) ?? -1);
  }
  return highest;
}

// Returns the safest available swap that moves the local player behind the
// requested teammate pick turn. League still requires that teammate to accept
// the request; this helper never chooses an incoming or already-finished request.
export function choosePickOrderSwap(session: ChampSelectSession | null | undefined, swaps: ChampSelectSwap[], target: PickOrderSwapTarget = 'latest'): PickOrderSwapChoice | null {
  const localCellID = integerField(session?.localPlayerCellId);
  if (!session || localCellID === undefined || !swaps.length) return null;

  const cells = new Set<number>();
  for (const member of session.myTeam || []) {
    const cellID = integerField(member.cellId);
    if (cellID !== undefined) cells.add(cellID);
  }
  if (!cells.size) {
    for (const action of flattenChampSelectActions(session)) {
      const cellID = integerField(action.actorCellId);
      if (cellID !== undefined && action.isAllyAction !== false) cells.add(cellID);
    }
  }
  cells.delete(localCellID);

  const localPickTurn = pickTurnForCell(session, localCellID);
  let targetCellID: number | undefined;
  let targetPickTurn = localPickTurn;
  if (target === 'latest') {
    for (const cellID of cells) {
      const pickTurn = pickTurnForCell(session, cellID);
      if (pickTurn > targetPickTurn) {
        targetPickTurn = pickTurn;
        targetCellID = cellID;
      }
    }
  } else {
    const requestedTurn = Number(target.slice('pick-'.length));
    if (!Number.isInteger(requestedTurn) || requestedTurn < 1 || requestedTurn > 5 || requestedTurn <= localPickTurn) return null;
    targetPickTurn = requestedTurn;
    targetCellID = Array.from(cells).find((cellID) => pickTurnForCell(session, cellID) === requestedTurn);
    if (targetCellID === undefined && !Array.from(cells).some((cellID) => pickTurnForCell(session, cellID) === requestedTurn)) return null;
  }
  if (targetPickTurn < 0 || (target === 'latest' && targetCellID === undefined)) return null;

  const candidates = swaps
    .filter((swap) => !finishedSwap(swap) && !pendingSwap(swap))
    .map((swap) => ({
      swap,
      id: swapID(swap),
      targetCellId: swapTargetCell(swap, localCellID),
      targetPickTurn: swapTargetPickTurn(swap),
    }))
    .filter((candidate): candidate is typeof candidate & { id: number } => candidate.id !== undefined);
  if (!candidates.length) return null;

  const exactTarget = targetCellID === undefined ? undefined : candidates.find((candidate) => candidate.targetCellId === targetCellID);
  const latestTurnTarget = candidates
    .filter((candidate) => candidate.targetPickTurn === targetPickTurn)
    .sort((left, right) => (right.targetPickTurn || -1) - (left.targetPickTurn || -1))[0];
  const unknownTarget = target === 'latest' && candidates.length === 1 && candidates[0].targetCellId === undefined && candidates[0].targetPickTurn === undefined
    ? candidates[0]
    : undefined;
  const chosen = exactTarget || latestTurnTarget || unknownTarget;
  if (!chosen) return null;
  return {
    swap: chosen.swap,
    id: chosen.id,
    targetCellId: chosen.targetCellId,
    targetPickTurn,
  };
}

export function chooseLastPickOrderSwap(session: ChampSelectSession | null | undefined, swaps: ChampSelectSwap[]): PickOrderSwapChoice | null {
  return choosePickOrderSwap(session, swaps, 'latest');
}

// A zero fallback page intentionally inherits the primary pick's page. This
// keeps existing saved policies compatible while still allowing a dedicated
// loadout when the fallback champion is selected.
export function runePageForPick(primaryRunePageID: number, fallbackRunePageID: number, fallbackUsed: boolean): number {
  if (!fallbackUsed) return Math.max(0, Number(primaryRunePageID) || 0);
  return Math.max(0, Number(fallbackRunePageID) || Number(primaryRunePageID) || 0);
}

function isPendingDraftAction(action: ChampSelectAction): boolean {
  return !action.completed && champSelectActionType(action) !== null;
}

// LCU groups simultaneous actions into turns. The first group with an
// unfinished pick/ban is authoritative; future local actions are not yet
// lockable even when they already exist in the session payload.
export function currentChampSelectTurn(session: ChampSelectSession | null | undefined): ChampSelectAction[] {
  const turns = session?.actions || [];
  if (turns.length > 0 && !Array.isArray(turns[0])) {
    const flat = turns as unknown as ChampSelectAction[];
    return flat.some(isPendingDraftAction) ? flat : [];
  }
  return turns.find((turn) => (turn || []).some(isPendingDraftAction)) || [];
}

export function currentLocalChampSelectAction(session: ChampSelectSession | null | undefined): ChampSelectAction | undefined {
  const localCell = numericField(session?.localPlayerCellId);
  if (localCell === undefined || localCell === null) return undefined;
  return currentChampSelectTurn(session).find((action) => integerField(action.actorCellId) === localCell && isPendingDraftAction(action));
}

export function liveLocalChampSelectAction(session: ChampSelectSession | null | undefined): ChampSelectAction | undefined {
  const phase = normalizeChampSelectPhase(session?.timer?.phase);
  if (phase && phase !== 'BAN_PICK') return undefined;
  return currentLocalChampSelectAction(session);
}

// During PLANNING, League permits declaring/hovering the first future pick,
// even though it is not the player's live BAN_PICK turn yet.
export function firstLocalPendingPick(session: ChampSelectSession | null | undefined): ChampSelectAction | undefined {
  const localCell = numericField(session?.localPlayerCellId);
  if (localCell === undefined || localCell === null) return undefined;
  return flattenChampSelectActions(session).find((action) => integerField(action.actorCellId) === localCell && champSelectActionType(action) === 'pick' && !action.completed);
}

export function champSelectSessionKey(session: ChampSelectSession): string {
  const sessionID = String(session.id ?? '').trim();
  if (sessionID && sessionID !== '0') return `champselect:session:${sessionID}`;
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
