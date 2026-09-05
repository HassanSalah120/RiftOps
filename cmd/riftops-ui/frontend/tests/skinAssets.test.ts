import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveChampionAlias,
  getSkinArtSources,
  getCachedWorkingIndex,
  setCachedWorkingIndex,
  clearWorkingSourceCache,
} from '../src/skinAssets.ts';

test('resolveChampionAlias handles special DDragon exceptions and irregular champion names', () => {
  assert.equal(resolveChampionAlias('Wukong', 62), 'MonkeyKing');
  assert.equal(resolveChampionAlias('Monkey King', 62), 'MonkeyKing');
  assert.equal(resolveChampionAlias('LeBlanc', 7), 'Leblanc');
  assert.equal(resolveChampionAlias('Nunu & Willump', 20), 'Nunu');
  assert.equal(resolveChampionAlias('Dr. Mundo', 36), 'DrMundo');
  assert.equal(resolveChampionAlias('Renata Glasc', 888), 'Renata');
  assert.equal(resolveChampionAlias("Cho'Gath", 31), 'Chogath');
  assert.equal(resolveChampionAlias("Kai'Sa", 145), 'Kaisa');
  assert.equal(resolveChampionAlias("Kha'Zix", 121), 'Khazix');
  assert.equal(resolveChampionAlias("Kog'Maw", 96), 'KogMaw');
  assert.equal(resolveChampionAlias("Vel'Koz", 161), 'Velkoz');
  assert.equal(resolveChampionAlias("K'Sante", 897), 'KSante');
  assert.equal(resolveChampionAlias('Ahri', 103), 'Ahri');
});

test('resolveChampionAlias prioritizes explicit raw alias when provided', () => {
  assert.equal(resolveChampionAlias('Wukong', 62, 'CustomMonkey'), 'CustomMonkey');
  assert.equal(resolveChampionAlias(null, 103, 'Ahri'), 'Ahri');
});

test('getSkinArtSources prioritizes landscape splash in list mode and portrait tile in grid mode', () => {
  const skin = {
    id: 103001,
    championId: 103,
    championName: 'Ahri',
    skinNum: 1,
  };

  const listSources = getSkinArtSources(skin, 'list');
  assert.equal(listSources[0], '/lol-game-data/assets/v1/champion-splashes/103/103001.jpg');
  assert.equal(listSources[1], 'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Ahri_1.jpg');

  const gridSources = getSkinArtSources(skin, 'grid');
  assert.equal(gridSources[0], '/lol-game-data/assets/v1/champion-tiles/103/103001.jpg');
  assert.equal(gridSources[1], 'https://ddragon.leagueoflegends.com/cdn/img/champion/loading/Ahri_1.jpg');
});

test('workingSourceIndexCache stores and clears indices per view mode', () => {
  clearWorkingSourceCache();
  assert.equal(getCachedWorkingIndex('list', 103001), 0);
  assert.equal(getCachedWorkingIndex('grid', 103001), 0);

  setCachedWorkingIndex('list', 103001, 1);
  assert.equal(getCachedWorkingIndex('list', 103001), 1);
  assert.equal(getCachedWorkingIndex('grid', 103001), 0);

  setCachedWorkingIndex('grid', 103001, 2);
  assert.equal(getCachedWorkingIndex('grid', 103001), 2);

  clearWorkingSourceCache();
  assert.equal(getCachedWorkingIndex('list', 103001), 0);
  assert.equal(getCachedWorkingIndex('grid', 103001), 0);
});
