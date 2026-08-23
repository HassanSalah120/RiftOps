import assert from 'node:assert/strict';
import test from 'node:test';

import { PRACTICE_TOOL_QUEUE_ID, queueStartMode } from '../src/playFlowQueue.ts';

const queues = [
  { id: 420, category: 'PvP' },
  { id: 1_000, category: 'Custom' },
  { id: 1_001, category: ' custom ' },
];

test('custom and Practice Tool selections use the dedicated start-game action', () => {
  assert.equal(queueStartMode(PRACTICE_TOOL_QUEUE_ID, queues), 'custom');
  assert.equal(queueStartMode(1_000, queues), 'custom');
  assert.equal(queueStartMode(1_001, queues), 'custom');
});

test('matchmade and current lobbies keep the matchmaking action', () => {
  assert.equal(queueStartMode(420, queues), 'matchmaking');
  assert.equal(queueStartMode(0, queues), 'matchmaking');
  assert.equal(queueStartMode(999, queues), 'matchmaking');
});
