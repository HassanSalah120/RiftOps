import type { QueueRank } from '../api';

export function accountRankLabel(rank: QueueRank): string {
  const tier = rank.tier?.trim().toUpperCase();
  if (!tier || tier === 'NONE' || tier === 'UNRANKED') return 'Unranked';
  const name = tier.charAt(0) + tier.slice(1).toLowerCase();
  const division = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier) ? '' : rank.division?.trim() || '';
  return `${name}${division ? ` ${division}` : ''} · ${rank.leaguePoints} LP`;
}

export function normalizeRegionLabel(region?: string): string {
  if (!region) return 'EUW';
  const r = region.trim().toUpperCase();
  const map: Record<string, string> = {
    EUW1: 'EUW',
    EUW: 'EUW',
    EUN1: 'EUNE',
    EUN: 'EUNE',
    EUNE: 'EUNE',
    NA1: 'NA',
    NA: 'NA',
    KR: 'KR',
    BR1: 'BR',
    BR: 'BR',
    LA1: 'LAN',
    LAN: 'LAN',
    LA2: 'LAS',
    LAS: 'LAS',
    OC1: 'OCE',
    OCE: 'OCE',
    JP1: 'JP',
    JP: 'JP',
    TR1: 'TR',
    TR: 'TR',
    RU: 'RU',
    SG2: 'SG',
    SG: 'SG',
    PH2: 'PH',
    PH: 'PH',
    TW2: 'TW',
    TW: 'TW',
    VN2: 'VN',
    VN: 'VN',
    TH2: 'TH',
    TH: 'TH',
    ME1: 'ME',
    ME: 'ME',
  };
  return map[r] || r;
}
