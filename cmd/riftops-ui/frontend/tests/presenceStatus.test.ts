import assert from 'node:assert/strict';
import test from 'node:test';
import { displayedPresence, presenceRuntimeLabel } from '../src/presenceStatus.ts';

test('native fallback never claims the masking proxy is active', () => {
  const native = { Phase: 'active', ChatPort: 0, Enabled: false, Status: 'offline' };
  assert.equal(presenceRuntimeLabel(native), 'Native chat · masking unavailable');
  assert.equal(displayedPresence(native, 'chat'), 'online');
  assert.equal(displayedPresence(native), '');
});

test('masked outgoing presence remains Offline even if the local client says Online', () => {
  const masked = { Phase: 'active', ChatPort: 1234, Enabled: true, Status: 'offline' };
  assert.equal(presenceRuntimeLabel(masked), 'Proxy active');
  assert.equal(displayedPresence(masked, 'chat'), 'offline');
  assert.equal(displayedPresence({ ...masked, Enabled: false }, 'chat'), 'online');
  assert.equal(presenceRuntimeLabel({ ...masked, Phase: 'waiting-for-chat' }), 'Proxy connecting');
});
