export type SkinView = 'grid' | 'list';

export const KNOWN_CHAMPION_ALIASES: Record<string, string> = {
  wukong: 'MonkeyKing',
  'monkey king': 'MonkeyKing',
  leblanc: 'Leblanc',
  'nunu & willump': 'Nunu',
  nunu: 'Nunu',
  'dr. mundo': 'DrMundo',
  'dr mundo': 'DrMundo',
  'renata glasc': 'Renata',
  'master yi': 'MasterYi',
  'jarvan iv': 'JarvanIV',
  'tahm kench': 'TahmKench',
  'twisted fate': 'TwistedFate',
  'xin zhao': 'XinZhao',
  'aurelion sol': 'AurelionSol',
  "cho'gath": 'Chogath',
  "kai'sa": 'Kaisa',
  "kha'zix": 'Khazix',
  "kog'maw": 'KogMaw',
  'rek\'sai': 'RekSai',
  reksai: 'RekSai',
  "vel'koz": 'Velkoz',
  "bel'veth": 'Belveth',
  "k'sante": 'KSante',
};

export function resolveChampionAlias(
  name?: string | null,
  id?: number | null,
  rawAlias?: string | null,
): string {
  if (rawAlias && typeof rawAlias === 'string' && rawAlias.trim()) {
    return rawAlias.trim();
  }
  const cleanName = String(name || '').trim();
  const normalized = cleanName.toLowerCase();
  if (KNOWN_CHAMPION_ALIASES[normalized]) {
    return KNOWN_CHAMPION_ALIASES[normalized];
  }
  const sanitized = cleanName.replace(/[^a-zA-Z0-9]/g, '');
  if (sanitized) {
    return sanitized;
  }
  return id ? `Champion${id}` : 'Unknown';
}

export function getSkinArtSources(
  skin: {
    id: number;
    championId: number;
    assetChampionId?: number | null;
    championName?: string;
    championAlias?: string;
    skinNum?: number;
  },
  viewMode: SkinView,
): string[] {
  const assetChampion = skin.assetChampionId || skin.championId;
  const alias = resolveChampionAlias(skin.championName, skin.championId, skin.championAlias);
  const skinNum = skin.skinNum ?? 0;

  const lcuSplash = `/lol-game-data/assets/v1/champion-splashes/${assetChampion}/${skin.id}.jpg`;
  const ddragonSplash = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${alias}_${skinNum}.jpg`;
  const lcuTile = `/lol-game-data/assets/v1/champion-tiles/${assetChampion}/${skin.id}.jpg`;
  const ddragonLoading = `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${alias}_${skinNum}.jpg`;

  if (viewMode === 'list') {
    return [lcuSplash, ddragonSplash, lcuTile, ddragonLoading];
  }
  return [lcuTile, ddragonLoading, lcuSplash, ddragonSplash];
}

const workingSourceIndexCache = new Map<string, number>();

export function getCachedWorkingIndex(viewMode: SkinView, skinId: number): number {
  return workingSourceIndexCache.get(`${viewMode}:${skinId}`) ?? 0;
}

export function setCachedWorkingIndex(viewMode: SkinView, skinId: number, index: number): void {
  workingSourceIndexCache.set(`${viewMode}:${skinId}`, index);
}

export function clearWorkingSourceCache(): void {
  workingSourceIndexCache.clear();
}
