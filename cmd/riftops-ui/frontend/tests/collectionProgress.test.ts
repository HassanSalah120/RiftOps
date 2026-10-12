import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChampionTotals, completeSkinInventory, skinShardIds } from '../src/collectionProgress.ts';

test('an owned-only inventory still shows unowned champions and full catalogue totals', () => {
  const ownedSkin = { id: 103001, championId: 103, ownership: { owned: true } };
  const records = completeSkinInventory([ownedSkin], [
    { id: 103001, championId: 103 }, { id: 103002, championId: 103 }, { id: 22001, championId: 22 },
  ]);
  assert.equal(records.length, 3);
  assert.equal(records[0], ownedSkin);
  assert.deepEqual(records[1].ownership, { owned: false });
  assert.equal(records[2].championId, 22);
});

test('collection rings count distinct skins and give permanent ownership priority over shards', () => {
  const skins = Array.from({ length: 18 }, (_, index) => ({ id: 103001 + index, championId: 103, championName: 'Ahri', owned: index < 7, shard: index < 10 }));
  const [champion] = buildChampionTotals([...skins, skins[7], { ...skins[0], owned: false, shard: true }]);
  assert.equal(champion.total, 18);
  assert.equal(champion.owned, 7);
  assert.equal(champion.shards, 3);
  assert.equal(champion.total - champion.owned - champion.shards, 8);
});

test('duplicate loot shards and zero-count entries do not increase collection progress', () => {
  const ids = skinShardIds([
    { lootId: 'CHAMPION_SKIN_103008', count: 4 },
    { lootId: 'CHAMPION_SKIN_103008', count: 1 },
    { lootId: 'CHAMPION_SKIN_RENTAL_103009', count: 2 },
    { lootId: 'CHAMPION_SKIN_103010', count: 0 },
    { lootId: 'CHAMPION_103', count: 1 },
  ]);
  assert.deepEqual([...ids], [103008, 103009]);
});

test('shards and temporary rentals never make a champion fully owned', () => {
  const [champion] = buildChampionTotals([
    { id: 1001, championId: 1, championName: 'Annie', owned: true, shard: true },
    { id: 1002, championId: 1, championName: 'Annie', owned: false, shard: true },
    { id: 1003, championId: 1, championName: 'Annie', owned: false, shard: true, rental: true },
  ]);
  assert.equal(champion.owned, 1);
  assert.equal(champion.shards, 2);
  assert.equal(champion.rentals, 1);
  assert.notEqual(champion.owned, champion.total);
});
