import assert from 'node:assert/strict';
import test from 'node:test';
import { accountRankLabel } from '../src/utils/accountRank.ts';

test('account ranks show division and LP, but apex ranks have no division', () => {
  assert.equal(accountRankLabel({ tier: 'DIAMOND', division: 'II', leaguePoints: 64 }), 'Diamond II · 64 LP');
  assert.equal(accountRankLabel({ tier: 'CHALLENGER', division: 'I', leaguePoints: 1034 }), 'Challenger · 1034 LP');
});

test('confirmed unranked queues do not display divisions or LP', () => {
  assert.equal(accountRankLabel({ tier: 'UNRANKED', division: 'I', leaguePoints: 0 }), 'Unranked');
  assert.equal(accountRankLabel({ tier: 'NONE', leaguePoints: 0 }), 'Unranked');
});
