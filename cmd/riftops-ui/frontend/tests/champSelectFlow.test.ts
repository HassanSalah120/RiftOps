import assert from 'node:assert/strict';
import test from 'node:test';
import {
  champSelectSessionKey,
  chooseChampSelectChampion,
  chooseLastPickOrderSwap,
  choosePickOrderSwap,
  currentLocalChampSelectAction,
  draftTimingRemainingMs,
  firstLocalPendingPick,
  hasChampSelectActionID,
  liveLocalChampSelectAction,
  localAssignedPosition,
  normalizeChampSelectPhase,
  normalizeChampSelectSession,
  champSelectActionType,
  isManualChampSelectHover,
  occupiedChampSelectChampionIDs,
  rolePickPlanFor,
  resolveDraftContext,
  runePageForPick,
  type ChampSelectSession,
} from '../src/champSelectFlow.ts';

test('action id zero is valid', () => {
  const action = { id: 0, actorCellId: 4, type: 'ban', completed: false };
  assert.equal(hasChampSelectActionID(action), true);
});

test('only the local action in the first unfinished turn is current', () => {
  const session: ChampSelectSession = {
    localPlayerCellId: 4,
    actions: [
      [{ id: 7, actorCellId: 2, type: 'ban', completed: false }],
      [{ id: 8, actorCellId: 4, type: 'pick', completed: false }],
    ],
  };
  assert.equal(currentLocalChampSelectAction(session), undefined);
  assert.equal(firstLocalPendingPick(session)?.id, 8);

  session.actions![0][0].completed = true;
  assert.equal(currentLocalChampSelectAction(session)?.id, 8);
});

test('optional isInProgress does not hide the authoritative current action', () => {
  const session: ChampSelectSession = {
    localPlayerCellId: 4,
    actions: [[{ id: 0, actorCellId: 4, type: 'pick', completed: false, isInProgress: false }]],
  };
  assert.equal(currentLocalChampSelectAction(session)?.id, 0);
});

test('planning permits pick intent but never exposes a live lock action', () => {
  const session: ChampSelectSession = {
    localPlayerCellId: 4,
    timer: { phase: 'PLANNING' },
    actions: [[{ id: 3, actorCellId: 4, type: 'pick', completed: false }]],
  };
  assert.equal(liveLocalChampSelectAction(session), undefined);
  assert.equal(firstLocalPendingPick(session)?.id, 3);
});

test('occupied champions include bans and teammate hovers but exclude the current action', () => {
  const session: ChampSelectSession = {
    localPlayerCellId: 4,
    actions: [[
      { id: 10, actorCellId: 4, type: 'ban', championId: 103, completed: false },
      { id: 11, actorCellId: 7, type: 'pick', championId: 84, completed: false },
    ]],
  };
  const occupied = occupiedChampSelectChampionIDs(session, 10);
  assert.equal(occupied.has(103), false);
  assert.equal(occupied.has(84), true);
});

test('draft timing supports immediate, delayed, and last-second policies', () => {
  const timer = { phase: 'BAN_PICK', adjustedTimeLeftInPhase: 10_000 };
  assert.equal(draftTimingRemainingMs('immediate', 2, timer, 0, 0), 0);
  assert.equal(draftTimingRemainingMs('after', 5, timer, 0, 4_000), 1_000);
  assert.equal(draftTimingRemainingMs('last-second', 2, timer, 0, 0), 8_000);
});

test('fallback candidate is selected when the primary is occupied or unavailable', () => {
  assert.equal(chooseChampSelectChampion([103, 84], new Set([103]), [103, 84]), 84);
  assert.equal(chooseChampSelectChampion([103, 84], new Set(), [84]), 84);
  assert.equal(chooseChampSelectChampion([103, 84], new Set([103, 84]), [103, 84]), 0);
  assert.equal(chooseChampSelectChampion([103, 84], new Set(), []), 0);
});

test('normalizes League action and phase dialects before draft decisions', () => {
  assert.equal(champSelectActionType({ type: 'CHAMPION_PICK' }), 'pick');
  assert.equal(champSelectActionType({ type: 'BAN' }), 'ban');
  assert.equal(normalizeChampSelectPhase('banpick'), 'BAN_PICK');
  assert.equal(normalizeChampSelectPhase('planning'), 'PLANNING');

  const session = normalizeChampSelectSession({
    localPlayerCellID: '4',
    timer: { phase: 'banpick' },
    actions: [[{ id: '0', actorCellID: '4', type: 'CHAMPION_PICK', completed: false }]],
  });
  assert.equal(session.localPlayerCellId, 4);
  assert.equal(session.timer?.phase, 'BAN_PICK');
  assert.equal(liveLocalChampSelectAction(session)?.type, 'pick');
  assert.equal(liveLocalChampSelectAction(session)?.actorCellId, 4);

  const flattened = normalizeChampSelectSession({
    localPlayerCellId: 4,
    actions: [{ id: 1, actorCellId: 4, type: 'pick', completed: false }],
  });
  assert.equal(currentLocalChampSelectAction(flattened)?.id, 1);
  const rawFlat = { localPlayerCellId: 4, actions: [{ id: 2, actorCellId: 4, type: 'PICK', completed: false }] } as unknown as ChampSelectSession;
  assert.equal(currentLocalChampSelectAction(rawFlat)?.id, 2);
});

test('fallback picks can use a dedicated rune page or inherit the primary page', () => {
  assert.equal(runePageForPick(12, 34, false), 12);
  assert.equal(runePageForPick(12, 34, true), 34);
  assert.equal(runePageForPick(12, 0, true), 12);
  assert.equal(runePageForPick(0, 0, true), 0);
});

test('last-pick swap chooses the latest teammate and ignores pending requests', () => {
  const session: ChampSelectSession = {
    localPlayerCellId: 4,
    myTeam: [
      { cellId: 4, pickTurn: 2 },
      { cellId: 7, pickTurn: 4 },
      { cellId: 9, pickTurn: 6 },
    ],
  };
  const choice = chooseLastPickOrderSwap(session, [
    { id: 11, targetCellId: 7, targetPickTurn: 4, state: 'AVAILABLE' },
    { id: 12, targetCellId: 9, targetPickTurn: 6, state: 'AVAILABLE' },
    { id: 13, targetCellId: 9, targetPickTurn: 6, state: 'PENDING' },
  ]);
  assert.equal(choice?.id, 12);
  assert.equal(choice?.targetCellId, 9);
  assert.equal(choice?.targetPickTurn, 6);
});

test('last-pick swap is unnecessary when the local player is already latest', () => {
  const session: ChampSelectSession = {
    localPlayerCellId: 4,
    myTeam: [{ cellId: 4, pickTurn: 6 }, { cellId: 7, pickTurn: 4 }],
  };
  assert.equal(chooseLastPickOrderSwap(session, [{ id: 11, targetCellId: 7, targetPickTurn: 4 }]), null);
});

test('last-pick swap does not choose a known earlier teammate', () => {
  const session: ChampSelectSession = {
    localPlayerCellId: 4,
    myTeam: [{ cellId: 4, pickTurn: 2 }, { cellId: 7, pickTurn: 4 }, { cellId: 9, pickTurn: 6 }],
  };
  assert.equal(chooseLastPickOrderSwap(session, [{ id: 11, targetCellId: 7, targetPickTurn: 4 }]), null);
});

test('pick-order swap can target a specific teammate pick', () => {
  const session: ChampSelectSession = {
    localPlayerCellId: 4,
    myTeam: [{ cellId: 4, pickTurn: 1 }, { cellId: 7, pickTurn: 3 }, { cellId: 9, pickTurn: 5 }],
  };
  const choice = choosePickOrderSwap(session, [
    { id: 11, targetCellId: 7, targetPickTurn: 3, state: 'AVAILABLE' },
    { id: 12, targetCellId: 9, targetPickTurn: 5, state: 'AVAILABLE' },
  ], 'pick-3');
  assert.equal(choice?.id, 11);
  assert.equal(choice?.targetPickTurn, 3);
});

test('specific pick-order target is skipped when it is local or unavailable', () => {
  const session: ChampSelectSession = {
    localPlayerCellId: 4,
    myTeam: [{ cellId: 4, pickTurn: 3 }, { cellId: 9, pickTurn: 5 }],
  };
  assert.equal(choosePickOrderSwap(session, [{ id: 12, targetCellId: 9, targetPickTurn: 5 }], 'pick-3'), null);
  assert.equal(choosePickOrderSwap(session, [{ id: 12, targetCellId: 9, targetPickTurn: 5 }], 'pick-4'), null);
});

test('session fallback key is stable across hover and completion updates', () => {
  const session: ChampSelectSession = {
    localPlayerCellId: 4,
    actions: [[{ id: 2, actorCellId: 4, type: 'pick', championId: 0, completed: false }]],
  };
  const initial = champSelectSessionKey(session);
  session.actions![0][0].championId = 103;
  session.actions![0][0].completed = true;
  assert.equal(champSelectSessionKey(session), initial);
});

test('local assigned position normalizes lane aliases and ignores Fill', () => {
  assert.equal(localAssignedPosition({ localPlayerCellId: 4, myTeam: [{ cellId: 4, assignedPosition: 'MIDDLE' }] }), 'MIDDLE');
  assert.equal(localAssignedPosition({ localPlayerCellId: 4, myTeam: [{ cellId: 4, position: 'ADC' }] }), 'BOTTOM');
  assert.equal(localAssignedPosition({ localPlayerCellId: 4, myTeam: [{ cellId: 4, assignedRole: 'FILL' }] }), null);
  assert.equal(localAssignedPosition({ localPlayerCellId: 4, myTeam: [{ cellId: 9, assignedPosition: 'TOP' }] }), null);
});

test('role-aware pick plans resolve only after Fill becomes a concrete lane', () => {
  const plans = {
    JUNGLE: { pickChampionId: 19, fallbackPickChampionId: 32, pickRunePageId: 4, fallbackPickRunePageId: 0 },
  } as const;
  assert.equal(rolePickPlanFor('JUNGLE', plans)?.pickChampionId, 19);
  assert.equal(rolePickPlanFor('jungle', plans)?.fallbackPickChampionId, 32);
  assert.equal(rolePickPlanFor('FILL', plans), null);
  assert.equal(rolePickPlanFor(null, plans), null);
});

test('draft context blocks missing lanes and selects the assigned role profile', () => {
  const legacy = { pickChampionId: 103, fallbackPickChampionId: 84, pickRunePageId: 1, fallbackPickRunePageId: 0 };
  const plans = { JUNGLE: { pickChampionId: 19, fallbackPickChampionId: 32, pickRunePageId: 4, fallbackPickRunePageId: 0 } };
  const waiting = resolveDraftContext({ localPlayerCellId: 4, myTeam: [{ cellId: 4, assignedPosition: 'FILL' }] }, { roleAwarePicks: true, rolePickPlans: plans, legacyPickPlan: legacy });
  assert.equal(waiting.state, 'waiting-for-role');
  assert.equal(waiting.pickPlan, null);

  const ready = resolveDraftContext({ localPlayerCellId: 4, myTeam: [{ cellId: 4, assignedRole: 'JG' }] }, { roleAwarePicks: true, rolePickPlans: plans, legacyPickPlan: legacy });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.planSource, 'role');
  assert.equal(ready.pickPlan?.pickChampionId, 19);

  const missing = resolveDraftContext({ localPlayerCellId: 4, myTeam: [{ cellId: 4, assignedRole: 'SUPPORT' }] }, { roleAwarePicks: true, rolePickPlans: plans, legacyPickPlan: legacy });
  assert.equal(missing.state, 'missing-plan');
  assert.equal(missing.pickPlan, null);
});

test('roleless queues keep the legacy pick plan even when role-aware mode is enabled', () => {
  const legacy = { pickChampionId: 103, fallbackPickChampionId: 84, pickRunePageId: 1, fallbackPickRunePageId: 0 };
  const context = resolveDraftContext({ localPlayerCellId: 4, myTeam: [{ cellId: 4, assignedPosition: 'FILL' }] }, { roleAwarePicks: true, rolePickPlans: {}, legacyPickPlan: legacy, queueKind: 'roleless' });
  assert.equal(context.state, 'ready');
  assert.equal(context.planSource, 'legacy');
  assert.equal(context.pickPlan?.pickChampionId, 103);
});

test('ARAM context never falls back to a ranked or legacy pick plan', () => {
  const context = resolveDraftContext(
    { localPlayerCellId: 4, myTeam: [{ cellId: 4, assignedPosition: 'FILL' }] },
    {
      roleAwarePicks: true,
      rolePickPlans: { UTILITY: { pickChampionId: 40, fallbackPickChampionId: 37, pickRunePageId: 1, fallbackPickRunePageId: 0 } },
      legacyPickPlan: { pickChampionId: 103, fallbackPickChampionId: 84, pickRunePageId: 2, fallbackPickRunePageId: 0 },
      queueKind: 'aram',
    },
  );
  assert.equal(context.queueKind, 'aram');
  assert.equal(context.state, 'ready');
  assert.equal(context.planSource, 'none');
  assert.equal(context.pickPlan, null);
  assert.match(context.reason || '', /ARAM/i);
});

test('manual champion hovers are respected unless RiftOps is still waiting for its own hover', () => {
  assert.equal(isManualChampSelectHover(84, 103, false), true);
  assert.equal(isManualChampSelectHover(84, 103, true), false);
  assert.equal(isManualChampSelectHover(103, 103, false), false);
  assert.equal(isManualChampSelectHover(0, 103, false), false);
});
