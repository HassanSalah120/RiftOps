import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBuildItems } from '../src/buildPlanner.ts';

test('build planner normalizes array and object item catalogues', () => {
  const items = normalizeBuildItems({ a: { id: '3089', name: "Rabadon's Deathcap", description: '<main>Power</main>' }, b: { itemId: 0, name: '' }, c: { id: 6655, displayName: 'Luden' } });
  assert.deepEqual(items.map((item) => item.id), [6655, 3089]);
  assert.equal(items.find((item) => item.id === 3089)?.description, 'Power');
});
