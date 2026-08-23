import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TABS, PHONE_TABS, availableTabs, commandAvailable, tabAvailable } from '../src/clientCapabilities.ts';

test('phone navigation contains only live and read-only League surfaces', () => {
  assert.deepEqual(availableTabs(true), PHONE_TABS);
  for (const tab of ['loot', 'qol', 'remote', 'settings'] as const) {
    assert.equal(tabAvailable(tab, true), false);
  }
  assert.equal(tabAvailable('live', true), true);
  assert.deepEqual(availableTabs(false), ALL_TABS);
});

test('phone command policy rejects desktop engine and administration actions', () => {
  assert.equal(commandAvailable({ tab: 'settings' }, true), false);
  assert.equal(commandAvailable({ tab: 'qol' }, true), false);
  assert.equal(commandAvailable({ action: 'launch' }, true), false);
  assert.equal(commandAvailable({ action: 'stop' }, true), false);
  assert.equal(commandAvailable({ action: 'toggle-mask' }, true), false);
  assert.equal(commandAvailable({ action: 'accept' }, true), true);
  assert.equal(commandAvailable({ tab: 'live' }, true), true);
});
