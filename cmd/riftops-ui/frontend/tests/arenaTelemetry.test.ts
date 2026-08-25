import assert from 'node:assert/strict';
import test from 'node:test';
import { arenaEventKey, arenaEventLabel, normalizeArenaAugments, normalizeArenaMatch, normalizeArenaTelemetry } from '../src/arenaTelemetry.ts';

test('Arena event metadata is normalized without inventing a mode', () => {
  assert.equal(arenaEventKey({ id: 1700, name: 'Arena Bravery' }), 'bravery');
  assert.equal(arenaEventKey({ id: 1700, name: 'Crowd Favorites Arena' }), 'crowd-favorites');
  assert.equal(arenaEventKey({ id: 440, name: 'Ranked Flex' }), 'unknown');
  assert.equal(arenaEventLabel('three-by-six'), '3 × 6 Arena');
});

test('Arena telemetry keeps exposed progress and honest nulls', () => {
  const telemetry = normalizeArenaTelemetry({
    gameData: { queueId: 1700, gameMode: 'CHERRY', mapNumber: 30 },
    arena: { eventName: 'Swift Arena', round: 4, teamsRemaining: 3, fame: 120, partnerName: 'Duo' },
    activePlayer: { challenges: { augments: [{ id: 12, name: 'Jeweled Gauntlet', tier: 'Prismatic' }] } },
    events: [{ eventName: 'ArenaRoundStart', roundNumber: 5 }],
  });
  assert.equal(telemetry.isArena, true);
  assert.equal(telemetry.event, 'swift');
  assert.equal(telemetry.round, 4);
  assert.equal(telemetry.teamsRemaining, 3);
  assert.equal(telemetry.placement, null);
  assert.equal(telemetry.partnerName, 'Duo');
  assert.deepEqual(telemetry.augments, [{ id: 12, name: 'Jeweled Gauntlet', tier: 'Prismatic' }]);
  assert.equal(normalizeArenaTelemetry({ gameData: { queueId: 1700, gameMode: 'CHERRY' }, events: [{ eventName: 'ArenaRoundStart', roundNumber: 5 }] }).round, 5);
});

test('augment catalog de-duplicates and caps client payloads', () => {
  const augments = normalizeArenaAugments({ augments: [{ id: 1, name: 'A' }, { id: 1, name: 'A' }, { id: 2, displayName: 'B' }] });
  assert.deepEqual(augments.map((augment) => augment.name), ['A', 'B']);
});

test('Riot match history can normalize both Match-V5 and flat LCU shapes', () => {
  assert.equal(normalizeArenaMatch({ info: { queueId: 1700, gameMode: 'CHERRY', participants: [{ puuid: 'me', challenges: { arenaFame: 45 } }] } }, 'me').fame, 45);
  assert.equal(normalizeArenaMatch({ queueId: 1700, gameMode: 'CHERRY', mapId: 30, round: 2 }).round, 2);
});
