import type { QueueRank } from '../api';

export function accountRankLabel(rank: QueueRank): string {
  const tier = rank.tier?.trim().toUpperCase();
  if (!tier || tier === 'NONE' || tier === 'UNRANKED') return 'Unranked';
  const name = tier.charAt(0) + tier.slice(1).toLowerCase();
  const division = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier) ? '' : rank.division?.trim() || '';
  return `${name}${division ? ` ${division}` : ''} · ${rank.leaguePoints} LP`;
}
