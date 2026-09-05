import test from 'node:test';
import assert from 'node:assert/strict';
import { externalBuildURL, safeReleaseURL } from '../src/externalURL.ts';

test('release navigation only accepts the official HTTPS repository', () => {
  assert.equal(safeReleaseURL('https://github.com/HassanSalah120/RiftOps/releases/tag/v2.5.0'), 'https://github.com/HassanSalah120/RiftOps/releases/tag/v2.5.0');
  for (const value of [
    'javascript:alert(1)',
    'http://github.com/HassanSalah120/RiftOps/releases/tag/v2.5.0',
    'https://github.com.evil.test/HassanSalah120/RiftOps/releases/tag/v2.5.0',
    'https://github.com/another-owner/RiftOps/releases/tag/v2.5.0',
    'https://user:password@github.com/HassanSalah120/RiftOps/releases',
  ]) assert.equal(safeReleaseURL(value), null);
});

test('build links are generated only for fixed HTTPS providers and lanes', () => {
  assert.equal(externalBuildURL('opgg', "Kha'Zix", 'JUNGLE'), 'https://op.gg/lol/champions/khazix/build/jungle');
  assert.equal(externalBuildURL('ugg', 'Ahri', 'MIDDLE'), 'https://u.gg/lol/champions/ahri/build/middle');
  assert.equal(externalBuildURL('opgg', 'Ahri', 'invalid'), null);
  assert.equal(externalBuildURL('opgg', '', 'TOP'), null);
});
