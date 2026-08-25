import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARENA_BRAVERY_CHAMPION_ID,
  isArenaBraveryPick,
  isArenaChampSelect,
  isArenaQueue,
  shouldUseArenaBravery,
} from '../src/arenaBravery.ts';

test('Arena queues are detected by current queue ids and metadata', () => {
  assert.equal(isArenaQueue(1700), true);
  assert.equal(isArenaQueue({ id: 1710, name: 'Arena' }), true);
  assert.equal(isArenaQueue({ id: 440, name: 'Ranked Flex', gameMode: 'CLASSIC' }), false);
});

test('Arena champ-select sessions are detected without trusting normal queues', () => {
  assert.equal(isArenaChampSelect({ queueId: 1700 }), true);
  assert.equal(isArenaChampSelect({ gameMode: 'ARENA' }), true);
  assert.equal(isArenaChampSelect({ mapId: 30 }), true);
  assert.equal(isArenaChampSelect({ queueId: 440, gameMode: 'CLASSIC' }), false);
});

test('Bravery is an explicit Arena-only special pick', () => {
  assert.equal(ARENA_BRAVERY_CHAMPION_ID, -3);
  assert.equal(isArenaBraveryPick(-3), true);
  assert.equal(isArenaBraveryPick(103), false);
  assert.equal(shouldUseArenaBravery(true, 1700), true);
  assert.equal(shouldUseArenaBravery(false, 1700), false);
  assert.equal(shouldUseArenaBravery(true, 440), false);
  assert.equal(shouldUseArenaBravery(true, 440, { gameMode: 'ARENA' }), true);
});
