import assert from 'node:assert/strict';
import test from 'node:test';
import {
  championIconSources,
  championName,
  normalizeSkinCatalog,
  resolveLootDisplay,
  resolveRewardDisplay,
  skinIDFromLootID,
  type ChampionCatalog,
} from '../src/leagueCatalog.ts';

const champions: ChampionCatalog = {
  '103': {
    id: 'Ahri',
    key: '103',
    name: 'Ahri',
    title: 'the Nine-Tailed Fox',
    blurb: '',
    tags: ['Mage'],
    image: { full: 'Ahri.png', sprite: '', group: 'champion' },
  },
};

test('champion catalog returns names and stable local icon fallback', () => {
  assert.equal(championName(103, champions), 'Ahri');
  assert.equal(championName(999, champions), 'Champion 999');
  assert.deepEqual(championIconSources(103, champions), ['/lol-game-data/assets/v1/champion-icons/103.png']);
});

test('skin catalog normalizes nested LCU records and preserves art metadata', () => {
  const skins = normalizeSkinCatalog({
    champions: [{
      championId: 103,
      skins: [{
        id: 103001,
        name: 'Dynasty Ahri',
        splashPath: '/lol-game-data/assets/ASSETS/Characters/Ahri/Skins/Skin01/Images/ahri.jpg',
        championId: 103,
      }],
    }],
  }, champions);
  assert.equal(skins['103001']?.name, 'Dynasty Ahri');
  assert.equal(skins['103001']?.championName, 'Ahri');
  assert.equal(skins['103001']?.assetPaths.length, 1);
});

test('loot and reward IDs resolve to readable skin details', () => {
  const skins = normalizeSkinCatalog([{ id: 103001, championId: 103, name: 'Dynasty Ahri' }], champions);
  assert.equal(skinIDFromLootID('CHAMPION_SKIN_103001'), 103001);
  assert.equal(resolveLootDisplay({ lootId: 'CHAMPION_SKIN_103001' }, skins).label, 'Dynasty Ahri');
  const reward = resolveRewardDisplay({ itemId: '103001', itemType: 'SKIN', quantity: 1 }, skins, champions, 0);
  assert.equal(reward.label, 'Dynasty Ahri');
  assert.match(reward.detail, /Ahri/);
  assert.ok(reward.iconSources.length > 0);
});
