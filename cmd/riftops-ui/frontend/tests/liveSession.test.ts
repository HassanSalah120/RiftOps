import assert from 'node:assert/strict';
import test from 'node:test';
import { formatElapsed, livePhaseLabel, normalizeLivePhase } from '../src/liveSession.ts';
test('normalizes the LCU gameflow phases into one live-session state machine', () => {
  assert.equal(normalizeLivePhase('Matchmaking'), 'QUEUE');
  assert.equal(normalizeLivePhase('ReadyCheck'), 'READY_CHECK');
  assert.equal(normalizeLivePhase('ChampSelect'), 'CHAMP_SELECT');
  assert.equal(normalizeLivePhase('GameStart'), 'LOADING');
  assert.equal(normalizeLivePhase('InProgress'), 'IN_GAME');
  assert.equal(normalizeLivePhase('EndOfGame'), 'POST_GAME');
});

test('queue state can identify a search while the gameflow endpoint reports lobby', () => {
  assert.equal(normalizeLivePhase('Lobby', 'Searching'), 'QUEUE');
  assert.equal(normalizeLivePhase('Lobby', ''), 'IDLE');
});

test('labels and timers stay stable for the UI', () => {
  assert.equal(livePhaseLabel('READY_CHECK'), 'Ready');
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(125), '2:05');
});
