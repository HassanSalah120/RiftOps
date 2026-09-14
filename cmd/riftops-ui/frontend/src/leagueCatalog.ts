import type { DDChampion } from './api';
import { getSkinArtSources, resolveChampionAlias, type SkinView } from './skinAssets.ts';

export type ChampionCatalog = Record<string, DDChampion>;

export interface CatalogSkin {
  id: number;
  championId: number;
  assetChampionId: number;
  name: string;
  championName: string;
  championAlias: string;
  skinNum: number;
  rarity?: string;
  description?: string;
  chromaCount?: number;
  chromas?: unknown[];
  isLegacy?: boolean;
  stillObtainable?: boolean;
  disabled?: boolean;
  assetPaths: string[];
}

export interface LeagueCatalog {
  champions: ChampionCatalog;
  skins: Record<string, CatalogSkin>;
}

export interface RewardDisplay {
  label: string;
  detail: string;
  iconSources: string[];
  skin?: CatalogSkin;
}

let championCatalogPromise: Promise<ChampionCatalog> | null = null;
let skinCatalogPromise: Promise<Record<string, CatalogSkin>> | null = null;

function text(value: unknown, fallback = ''): string {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function numberField(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function safeAssetPath(value: unknown): string {
  const path = text(value).replaceAll('\\', '/');
  return path.startsWith('/lol-game-data/assets/') && !path.includes('..') ? path : '';
}

function summaryRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'));
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'));
}

function championFromSummary(row: Record<string, unknown>): DDChampion | null {
  const key = text(row.id ?? row.key ?? row.championId);
  if (!key) return null;
  const name = text(row.name ?? row.alias, `Champion ${key}`);
  return {
    id: text(row.alias ?? row.id ?? name),
    key,
    name,
    title: text(row.title),
    blurb: '',
    tags: [],
    image: { full: '', sprite: '', group: 'champion' },
  };
}

function mergeChampionSources(ddragon: unknown, summary: unknown): ChampionCatalog {
  const catalog: ChampionCatalog = {};
  const add = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const champion = raw as Partial<DDChampion>;
    const id = text(champion.key);
    if (!id || !champion.name) return;
    catalog[id] = {
      id: text(champion.id, champion.name),
      key: id,
      name: text(champion.name, `Champion ${id}`),
      title: text(champion.title),
      blurb: text(champion.blurb),
      tags: Array.isArray(champion.tags) ? champion.tags.map(String) : [],
      image: champion.image || { full: '', sprite: '', group: 'champion' },
    };
  };

  if (ddragon && typeof ddragon === 'object') {
    const data = (ddragon as { data?: unknown }).data;
    summaryRows(data).forEach(add);
  }
  summaryRows(summary).forEach((row) => {
    const champion = championFromSummary(row);
    if (champion && !catalog[champion.key]) add(champion);
  });
  return catalog;
}

export function championName(id: unknown, catalog: ChampionCatalog): string {
  const key = text(id);
  return catalog[key]?.name || (key ? `Champion ${key}` : 'Unknown champion');
}

export function championAlias(id: unknown, catalog: ChampionCatalog): string {
  const key = text(id);
  const champion = catalog[key];
  return resolveChampionAlias(champion?.name, numberField(key), champion?.id);
}

export function championIconSources(id: unknown, catalog: ChampionCatalog, version = ''): string[] {
  const key = text(id);
  if (!key) return [];
  const champion = catalog[key];
  const sources = [`/lol-game-data/assets/v1/champion-icons/${encodeURIComponent(key)}.png`];
  if (version && champion?.id) sources.push(`https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(version)}/img/champion/${encodeURIComponent(champion.id)}.png`);
  return sources;
}

function flattenSkinCatalog(value: unknown, championHint: number | null = null): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap((entry) => flattenSkinCatalog(entry, championHint));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const champion = record.champion && typeof record.champion === 'object' ? record.champion as Record<string, unknown> : {};
  const championId = numberField(record.championId, record.championID, record.assetChampionId, champion.id, championHint);
  const id = numberField(record.id, record.skinId, record.championSkinId, record.skinID, record.championSkinID);
  const entries: Array<Record<string, unknown>> = [];
  if (id !== null) entries.push({ ...record, id, championId: championId ?? undefined });
  for (const key of ['skins', 'championSkins', 'skinList', 'items', 'data', 'champions']) {
    const child = record[key];
    if (child && typeof child === 'object') entries.push(...flattenSkinCatalog(child, numberField(record.championId, record.id) ?? championHint));
  }
  if (!entries.length && id === null) {
    for (const [key, child] of Object.entries(record)) {
      if (['skins', 'championSkins', 'skinList', 'items', 'data', 'champions'].includes(key)) continue;
      if (!child || typeof child !== 'object') continue;
      entries.push(...flattenSkinCatalog(child, numberField(key) ?? championHint));
    }
  }
  return entries;
}

export function normalizeSkinCatalog(raw: unknown, champions: ChampionCatalog): Record<string, CatalogSkin> {
  const catalog: Record<string, CatalogSkin> = {};
  for (const row of flattenSkinCatalog(raw)) {
    const id = numberField(row.id, row.skinId, row.championSkinId);
    if (id === null || catalog[String(id)]) continue;
    const sourceChampionId = numberField(row.assetChampionId, row.championId, row.championID) ?? (id >= 100000 ? Math.floor(id / 1000) : null);
    if (sourceChampionId === null) continue;
    const classicChampionId = sourceChampionId >= 60000 && id >= 60000000 ? sourceChampionId - 60000 : sourceChampionId;
    const championId = numberField(row.championId, classicChampionId) ?? classicChampionId;
    const name = text(row.name, `Skin #${id % 1000}`);
    const nestedChampion = row.champion && typeof row.champion === 'object' ? row.champion as Record<string, unknown> : {};
    const championNameValue = text(row.championName ?? nestedChampion.name, championName(championId, champions));
    const alias = resolveChampionAlias(championNameValue, championId, text(row.championAlias ?? nestedChampion.alias));
    const assetPaths = [row.uncenteredSplashPath, row.splashPath, row.tilePath, row.loadScreenPath, row.iconPath].map(safeAssetPath).filter(Boolean);
    catalog[String(id)] = {
      id,
      championId,
      assetChampionId: numberField(row.assetChampionId, sourceChampionId) ?? championId,
      name,
      championName: championNameValue,
      championAlias: alias,
      skinNum: numberField(row.skinNum) ?? id % 1000,
      rarity: text(row.rarity).replace(/^k/i, '').toLowerCase() || undefined,
      description: text(row.description ?? row.blurb) || undefined,
      chromaCount: Array.isArray(row.chromas) ? row.chromas.length : numberField(row.chromaCount) ?? undefined,
      chromas: Array.isArray(row.chromas) ? row.chromas : undefined,
      isLegacy: typeof row.isLegacy === 'boolean' ? row.isLegacy : undefined,
      stillObtainable: typeof row.stillObtainable === 'boolean' ? row.stillObtainable : undefined,
      disabled: typeof row.disabled === 'boolean' ? row.disabled : undefined,
      assetPaths,
    };
  }
  return catalog;
}

export async function loadChampionCatalog(): Promise<ChampionCatalog> {
  if (!championCatalogPromise) {
    championCatalogPromise = Promise.all([
      fetch('/api/ddragon/champions', { cache: 'force-cache' }).then((response) => response.ok ? response.json() : null).catch(() => null),
      fetch('/lol-game-data/assets/v1/champion-summary.json', { cache: 'force-cache' }).then((response) => response.ok ? response.json() : []).catch(() => []),
    ]).then(([ddragon, summary]) => mergeChampionSources(ddragon, summary));
  }
  return championCatalogPromise;
}

export async function loadSkinCatalog(): Promise<Record<string, CatalogSkin>> {
  if (!skinCatalogPromise) {
    skinCatalogPromise = Promise.all([
      loadChampionCatalog(),
      fetch('/lol-game-data/assets/v1/skins.json', { cache: 'force-cache' }).then((response) => response.ok ? response.json() : {}).catch(() => ({})),
    ]).then(([champions, skins]) => normalizeSkinCatalog(skins, champions));
  }
  return skinCatalogPromise;
}

export async function loadLeagueCatalog(): Promise<LeagueCatalog> {
  const [champions, skins] = await Promise.all([loadChampionCatalog(), loadSkinCatalog()]);
  return { champions, skins };
}

export function clearLeagueCatalogCache(): void {
  championCatalogPromise = null;
  skinCatalogPromise = null;
}

export function skinIDFromLootID(lootId: unknown): number | null {
  const match = text(lootId).match(/(?:^|_)CHAMPION_SKIN(?:_[A-Z]+)*_(\d+)$/i);
  return match ? numberField(match[1]) : null;
}

export function resolveLootDisplay(item: { lootId?: unknown; itemDesc?: unknown; localizedName?: unknown }, skins: Record<string, CatalogSkin>): { label: string; detail: string; skin?: CatalogSkin } {
  const skinId = skinIDFromLootID(item.lootId);
  const skin = skinId === null ? undefined : skins[String(skinId)];
  if (skin) return { label: skin.name, detail: `${skin.championName} · Skin`, skin };
  const label = text(item.itemDesc ?? item.localizedName ?? item.lootId, 'League loot');
  return { label, detail: 'League material' };
}

function opaqueID(value: string): boolean {
  return value.length > 20 || /^[a-f0-9]{8}-[a-f0-9-]{20,}$/i.test(value);
}

export function resolveRewardDisplay(reward: any, skins: Record<string, CatalogSkin>, champions: ChampionCatalog, index: number): RewardDisplay {
  const itemId = text(reward?.itemId ?? reward?.id ?? reward?.rewardId);
  const type = text(reward?.itemType ?? reward?.type, 'Reward').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const skin = itemId ? skins[itemId] : undefined;
  if (skin) {
    return { label: skin.name, detail: `${skin.championName} · ${type} · Quantity ${numberField(reward?.quantity) ?? 1}`, iconSources: getSkinArtSources(skin, 'grid'), skin };
  }
  const champion = type.toLowerCase().includes('champion') && itemId ? champions[itemId] : undefined;
  if (champion) {
    return { label: champion.name, detail: `${type} · Content ID ${itemId} · Quantity ${numberField(reward?.quantity) ?? 1}`, iconSources: championIconSources(itemId, champions) };
  }
  const named = text(reward?.name ?? reward?.localizedName ?? reward?.displayName);
  const label = named || (opaqueID(itemId) ? `${type} option ${index + 1}` : itemId ? `${type} · ${itemId}` : `${type} option ${index + 1}`);
  const detail = `${itemId ? (opaqueID(itemId) ? 'League reward' : 'Content ID') + ` ${itemId}` : 'League catalogued reward'} · Quantity ${numberField(reward?.quantity) ?? 1}`;
  return { label, detail, iconSources: [] };
}

export function skinArtSources(skin: CatalogSkin, view: SkinView = 'grid'): string[] {
  return [...skin.assetPaths, ...getSkinArtSources(skin, view)].filter((source, index, sources) => sources.indexOf(source) === index);
}
