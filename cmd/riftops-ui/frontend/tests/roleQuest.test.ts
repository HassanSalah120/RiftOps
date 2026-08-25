import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendedRoleQuestSpells, roleQuestPlan, roleQuestPlans } from '../src/roleQuest.ts';

test('Top role quest exposes the official threshold and safe Teleport loadout', () => {
  const plan = roleQuestPlan('top');
  assert.equal(plan?.progress, '1,200 points');
  assert.equal(plan?.reward, 'Enhanced Teleport reward');
  assert.match(plan?.details || '', /35% max-health shield for 10 seconds/);
  assert.deepEqual(recommendedRoleQuestSpells('TOP'), {
    spell1Id: 4,
    spell2Id: 12,
    spell1Name: 'Flash',
    spell2Name: 'Teleport',
  });
});

test('Bot role quest explains the dedicated inventory slot', () => {
  const plan = roleQuestPlan('BOTTOM');
  assert.equal(plan?.progress, '1,350 points');
  assert.match(plan?.details || '', /7th item slot/);
  assert.match(plan?.details || '', /\+40 gold per champion takedown/);
  assert.equal(recommendedRoleQuestSpells('BOTTOM'), null);
});

test('all assigned positions have a local explanation while Fill stays unassigned', () => {
  assert.equal(roleQuestPlans().length, 5);
  assert.ok(roleQuestPlan('MIDDLE'));
  assert.ok(roleQuestPlan('JUNGLE'));
  assert.ok(roleQuestPlan('UTILITY'));
  assert.equal(roleQuestPlan('FILL'), null);
});
