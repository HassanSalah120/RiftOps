import assert from 'node:assert/strict';
import test from 'node:test';
import { recipeActionLabel } from '../src/lootActions.ts';

test('loot recipes expose the action League actually describes', () => {
  assert.equal(recipeActionLabel({ type: 'REROLL_SKIN_SHARDS' }), 'Reroll');
  assert.equal(recipeActionLabel({ recipeName: 'DISENCHANT' }), 'Disenchant');
  assert.equal(recipeActionLabel({ name: 'Open capsule' }), 'Open');
  assert.equal(recipeActionLabel({ type: 'UPGRADE' }), 'Upgrade');
  assert.equal(recipeActionLabel({ type: 'CRAFT' }), 'Craft');
});
