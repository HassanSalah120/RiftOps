import assert from 'node:assert/strict';
import test from 'node:test';
import {
  champSelectSessionKey,
  chooseChampSelectChampion,
  currentLocalChampSelectAction,
  draftTimingRemainingMs,
  firstLocalPendingPick,
  hasChampSelectActionID,
  liveLocalChampSelectAction,
  occupiedChampSelectChampionIDs,
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
});

test('fallback picks can use a dedicated rune page or inherit the primary page', () => {
  assert.equal(runePageForPick(12, 34, false), 12);
  assert.equal(runePageForPick(12, 34, true), 34);
  assert.equal(runePageForPick(12, 0, true), 12);
  assert.equal(runePageForPick(0, 0, true), 0);
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
