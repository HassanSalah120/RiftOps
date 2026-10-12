import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { fetchLCUSkins, fetchLCULoot, fetchLCUProfile } from '../api';
import { clearLeagueCatalogCache, loadChampionCatalog, loadSkinCatalog } from '../leagueCatalog';
import {
  Sparkles,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  Heart,
  X,
  ChevronDown,
  Gem,
  LayoutGrid,
  List,
  Copy,
  Bookmark,
  Clock3,
  Check,
  SlidersHorizontal,
  RotateCcw,
} from 'lucide-react';
import PageHeader from './PageHeader';
import ChampionCollectionPortrait from './ChampionCollectionPortrait';
import { buildChampionTotals, completeSkinInventory, skinShardIds, uniqueCollectionSkins } from '../collectionProgress';
import './collection.css';
import { useDialogFocus } from './useDialogFocus';
import {
  type SkinView,
  getSkinArtSources,
  resolveChampionAlias,
  getCachedWorkingIndex,
  setCachedWorkingIndex,
  clearWorkingSourceCache,
} from '../skinAssets';

const TIER_MAP: Record<string, { label: string; color: string; rank: number }> = {
  transcendent: { label: 'Transcendent', color: '#45d8c1', rank: 8 },
  exalted: { label: 'Exalted', color: '#e75c9d', rank: 7 },
  ultimate: { label: 'Ultimate', color: '#e9c46a', rank: 6 },
  mythic: { label: 'Mythic', color: '#b76ce2', rank: 5 },
  legendary: { label: 'Legendary', color: '#ef7652', rank: 4 },
  epic: { label: 'Epic', color: '#4dbce9', rank: 3 },
  rare: { label: 'Rare', color: '#4386ad', rank: 2 },
  standard: { label: 'Standard', color: '#8b9298', rank: 1 },
};

type SkinCategory = 'normal' | 'classic';
type SkinDensity = 'comfortable' | 'compact';
type SkinSort = 'rarity' | 'name';
type ChampionSort = 'completion' | 'least-owned' | 'owned' | 'total' | 'name';
type SkinStatusFilter = 'all' | 'owned' | 'missing' | 'zero-owned' | 'available' | 'shard' | 'rental' | 'wishlist' | 'unavailable';
type SmartFilter = 'all' | 'zero-skins' | 'near-complete' | 'missing-one' | 'rarest' | 'shard-candidates';
type ChampionFilter = 'all' | 'owned' | 'incomplete' | 'complete';

function readPreference<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

// LCU has returned a few different envelopes for the same inventory over
// time. Current clients usually return a flat skins-minimal array, while some
// versions return champions with a nested `skins` array. Normalize both here
// so ownership is read from the actual skin object rather than silently
// dropping every nested record.
function numberField(...values: any[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function booleanField(value: any): boolean {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function flattenSkinRecords(value: any, championHint: number | null = null, nestedSkin = false): any[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenSkinRecords(item, championHint, nestedSkin));
  }
  if (!value || typeof value !== 'object') return [];

  const explicitSkinId = numberField(value.skinId, value.championSkinId, value.skinID, value.championSkinID);
  const ownId = numberField(value.id);
  const ownChampionId = numberField(
    value.championId,
    value.championID,
    value.assetChampionId,
    value.champion?.id,
    value.champion?.championId,
  );
  const championId = ownChampionId ?? championHint;
  const id = explicitSkinId ?? ownId;
  const hasSkinIdentity = id !== null && championId !== null && (
    nestedSkin ||
    explicitSkinId !== null ||
    ownChampionId !== null ||
    value.isBase !== undefined ||
    value.ownership !== undefined
  );

  const records: any[] = [];
  if (hasSkinIdentity) {
    records.push({ ...value, id, championId });
  }

  const nestedKeys = ['skins', 'championSkins', 'skinList', 'items', 'data', 'champions'];
  const nestedKeySet = new Set(nestedKeys);
  let nestedRecords = 0;
  for (const key of nestedKeys) {
    const child = value[key];
    if (!child || typeof child !== 'object') continue;
    const childRecords = flattenSkinRecords(
      child,
      numberField(value.championId, value.id) ?? championHint,
      key === 'skins' || key === 'championSkins' || nestedSkin,
    );
    nestedRecords += childRecords.length;
    records.push(...childRecords);
  }

  // Some LCU revisions key the response by champion id instead of returning
  // a named `champions`/`skins` property. Only recurse into map-like values if
  // this object was not already recognized as a record, avoiding ownership and
  // rental metadata being mistaken for skins.
  if (!hasSkinIdentity && nestedRecords === 0) {
    for (const [key, child] of Object.entries(value)) {
      if (nestedKeySet.has(key) || !child || typeof child !== 'object') continue;
      const keyedChampion = numberField(key) ?? championHint;
      records.push(...flattenSkinRecords(child, keyedChampion, true));
    }
  }

  return records;
}

function skinOwnership(raw: any) {
  const ownership = raw?.ownership;
  const ownershipObject = ownership && typeof ownership === 'object' ? ownership : {};
  const rental = ownershipObject.rental;
  const rentalObject = rental && typeof rental === 'object' ? rental : {};
  const rentalEnd = Number(rentalObject.endDate) || Date.parse(String(rentalObject.endDate || ''));
  const status = String(
    raw?.ownershipType ?? raw?.status ?? ownershipObject.ownershipType ?? ownershipObject.status ?? ownership ?? '',
  ).toUpperCase();
  const isRental = booleanField(raw?.rental) || booleanField(raw?.isRental) ||
    booleanField(raw?.isRented) || booleanField(ownershipObject.rental) ||
    booleanField(rentalObject.rented) || booleanField(rentalObject.isRental) ||
    (rentalEnd > Date.now()) || status === 'RENTED' || status === 'RENTAL';
  const isOwned = !isRental && (
    booleanField(raw?.owned) || booleanField(raw?.isOwned) ||
    booleanField(ownershipObject.owned) || booleanField(ownershipObject.isOwned) ||
    status === 'OWNED' || status === 'SKIN_OWNED'
  );
  return { isOwned, isRental };
}

const SKIN_CACHE_PREFIX = 'riftops-skin-cache-v4:';

function skinCacheKeys(puuid: string) {
  const suffix = encodeURIComponent(puuid);
  return { data: `${SKIN_CACHE_PREFIX}${suffix}`, updated: `${SKIN_CACHE_PREFIX}${suffix}:updated`, shardsAvailable: `${SKIN_CACHE_PREFIX}${suffix}:shards-available` };
}

function skinKey(skin: any) {
  return String(skin.id);
}

function legacySkinKey(skin: any) {
  return `${skin.championId}_${skin.skinNum}`;
}

function isSkinFavorite(favs: Set<string>, skin: any) {
  return favs.has(skinKey(skin)) || favs.has(legacySkinKey(skin));
}

function SkinCardArt({
  skin,
  viewMode,
  alt,
}: {
  skin: any;
  viewMode: SkinView;
  alt: string;
}) {
  const [stage, setStage] = useState(() => getCachedWorkingIndex(viewMode, skin.id));

  const sources = useMemo(() => {
    return getSkinArtSources(skin, viewMode);
  }, [skin, viewMode]);

  if (stage >= sources.length) {
    return <div className="skin-vault-card__art is-missing" />;
  }

  return (
    <img
      key={stage}
      className="skin-vault-card__art"
      src={sources[stage]}
      alt={alt}
      width="320"
      height="180"
      loading="lazy"
      onLoad={() => {
        setCachedWorkingIndex(viewMode, skin.id, stage);
      }}
      onError={() => {
        setStage((prev) => (prev < sources.length ? prev + 1 : prev));
      }}
    />
  );
}

export default function SkinShowcase({ remoteReadOnly = false }: { remoteReadOnly?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allSkins, setAllSkins] = useState<any[]>([]);
  const [search, setSearch] = useState(() => readPreference('riftops-skin-search', ''));
  const [tierFilter, setTierFilter] = useState<string>(() => readPreference('riftops-skin-tier', 'all'));
  const [championSort, setChampionSort] = useState<ChampionSort>(() => readPreference('riftops-collection-champion-sort', 'name'));
  const [skinCategory, setSkinCategory] = useState<SkinCategory>(() => readPreference('riftops-skin-category', 'normal'));
  const [shardsOnly, setShardsOnly] = useState(() => readPreference('riftops-skin-shards-only', false));
  const [selectedChampId, setSelectedChampId] = useState<number | null>(null);
  const [favsOnly, setFavsOnly] = useState(() => readPreference('riftops-skin-favs-only', false));
  const [statusFilter, setStatusFilter] = useState<SkinStatusFilter>(() => readPreference('riftops-skin-status', 'all'));
  const [smartFilter, setSmartFilter] = useState<SmartFilter>(() => readPreference('riftops-skin-smart-filter', 'all'));
  const [championFilter, setChampionFilter] = useState<ChampionFilter>('all');
  const [shardsAvailable, setShardsAvailable] = useState(false);
  const [viewMode, setViewMode] = useState<SkinView>(() => readPreference('riftops-skin-view', 'grid'));
  const [density, setDensity] = useState<SkinDensity>(() => readPreference('riftops-skin-density', 'comfortable'));
  const [skinSort, setSkinSort] = useState<SkinSort>(() => readPreference('riftops-skin-item-sort', 'rarity'));
  const [previewSkin, setPreviewSkin] = useState<any | null>(null);
  const [copyStatus, setCopyStatus] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [ownedDelta, setOwnedDelta] = useState<number | null>(null);
  const [usingCachedCatalog, setUsingCachedCatalog] = useState(false);
  const previousOwnedRef = useRef<number | null>(null);
  const warmedFromCacheRef = useRef(false);
  const previewDialogRef = useDialogFocus<HTMLDivElement>(previewSkin !== null, () => setPreviewSkin(null));
  const [favs, setFavs] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('riftops-skin-favs');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [wishlist, setWishlist] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('riftops-skin-wishlist');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    localStorage.setItem('riftops-skin-search', JSON.stringify(search));
    localStorage.setItem('riftops-skin-tier', JSON.stringify(tierFilter));
    localStorage.setItem('riftops-collection-champion-sort', JSON.stringify(championSort));
    localStorage.setItem('riftops-skin-category', JSON.stringify(skinCategory));
    localStorage.setItem('riftops-skin-shards-only', JSON.stringify(shardsOnly));
    localStorage.setItem('riftops-skin-favs-only', JSON.stringify(favsOnly));
    localStorage.setItem('riftops-skin-status', JSON.stringify(statusFilter));
    localStorage.setItem('riftops-skin-smart-filter', JSON.stringify(smartFilter));
    localStorage.setItem('riftops-skin-view', JSON.stringify(viewMode));
    localStorage.setItem('riftops-skin-density', JSON.stringify(density));
    localStorage.setItem('riftops-skin-item-sort', JSON.stringify(skinSort));
  }, [search, tierFilter, championSort, skinCategory, shardsOnly, favsOnly, statusFilter, smartFilter, viewMode, density, skinSort]);

  const toggleFav = (skinOrId: any) => {
    setFavs((prev) => {
      const next = new Set(prev);
      const primaryId = typeof skinOrId === 'string' ? skinOrId : skinKey(skinOrId);
      const aliases = typeof skinOrId === 'string' ? [skinOrId] : [skinKey(skinOrId), legacySkinKey(skinOrId)];
      if (aliases.some((id) => next.has(id))) aliases.forEach((id) => next.delete(id));
      else next.add(primaryId);
      localStorage.setItem('riftops-skin-favs', JSON.stringify([...next]));
      return next;
    });
  };

  const toggleWishlist = (skin: any) => {
    const id = skinKey(skin);
    setWishlist((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem('riftops-skin-wishlist', JSON.stringify([...next]));
      return next;
    });
  };

  const loadData = useCallback(async () => {
    clearWorkingSourceCache();
    let cached: any[] = [];
    let cacheKeys: ReturnType<typeof skinCacheKeys> | null = null;
    setLoading(true);
    setError(null);
    try {
      // Cache by PUUID so a signed-out/switching account can never display
      // another account's ownership state while the LCU is reconnecting.
      const profile = await fetchLCUProfile().catch(() => null);
      const puuid = String(profile?.summoner?.puuid || '').trim();
      if (puuid) {
        cacheKeys = skinCacheKeys(puuid);
        cached = readPreference<any[]>(cacheKeys.data, []);
        if (!warmedFromCacheRef.current && cached.length > 0) {
          warmedFromCacheRef.current = true;
          setAllSkins(cached);
          setUsingCachedCatalog(true);
          setShardsAvailable(readPreference(cacheKeys.shardsAvailable, false));
          const cachedAt = readPreference<string | null>(cacheKeys.updated, null);
          setLastUpdated(cachedAt ? new Date(cachedAt) : null);
        }
      }
      const [ownedRaw, lootResult, skinCatalog, championCatalog] = await Promise.all([
        fetchLCUSkins(),
        remoteReadOnly ? Promise.resolve({ data: [], available: false }) : fetchLCULoot().then((data) => ({ data, available: Array.isArray(data) })).catch(() => ({ data: [], available: false })),
        loadSkinCatalog(),
        loadChampionCatalog(),
      ]);

      setShardsAvailable(lootResult.available);
      const shardSkinIds = skinShardIds(lootResult.data);

      const skinDbMap = new Map<number, any>(Object.values(skinCatalog).map((skin) => [skin.id, skin]));
      if (skinDbMap.size === 0) {
        clearLeagueCatalogCache();
        throw new Error('Skin catalogue unavailable. Refresh to load complete champion collections.');
      }

      const champNames = new Map<number, string>();
      const champAliases = new Map<number, string>();
      Object.values(championCatalog).forEach((champion) => {
        const championId = numberField(champion.key);
        if (championId !== null) {
          champNames.set(championId, champion.name);
          if (champion.id) champAliases.set(championId, String(champion.id));
        }
      });

      const ownedArr = flattenSkinRecords(ownedRaw);
      if (ownedArr.length === 0 && !(puuid && Array.isArray(ownedRaw) && ownedRaw.length === 0)) {
        throw new Error('League returned no skin records. Open League and refresh the collection.');
      }

      const parsedSkins: any[] = [];

      completeSkinInventory(ownedArr, Object.values(skinCatalog)).forEach((s: any) => {
        const sourceChampionId = numberField(s.championId, s.assetChampionId);
        const skinId = numberField(s.id, s.skinId, s.championSkinId);
        if (sourceChampionId === null || skinId === null) return;
        const skinNum = skinId % 1000;
        if (s.isBase === true || skinNum === 0) return; // skip base skin

        const { isOwned, isRental } = skinOwnership(s);
        const hasShard = !isOwned && shardSkinIds.has(skinId);
        const dbEntry = skinDbMap.get(skinId) || {};
        const skinName = s.name || dbEntry.name || `Skin #${skinNum}`;
        const isClassic = /^classic(?:\s|$)/i.test(String(skinName)) || (sourceChampionId >= 60000 && skinId >= 60000000);
        const cId = isClassic && sourceChampionId >= 60000 ? sourceChampionId - 60000 : sourceChampionId;
        const cName = champNames.get(cId) || dbEntry.championName || `Champion ${cId}`;
        const championAlias = resolveChampionAlias(cName, cId, champAliases.get(cId) || dbEntry.alias || dbEntry.championAlias);
        const rawRarity = (dbEntry.rarity || s.rarity || '').replace(/^k/i, '').toLowerCase();
        const isLegacy = !!(dbEntry.isLegacy ?? s.isLegacy);
        const stillObtainable = dbEntry.stillObtainable ?? s.stillObtainable;
        const unavailable = !!(s.disabled || dbEntry.disabled || isLegacy || stillObtainable === false);
        const chromaCount = Array.isArray(dbEntry.chromas)
          ? dbEntry.chromas.length
          : Array.isArray(s.chromas)
          ? s.chromas.length
          : Number(dbEntry.chromaCount ?? s.chromaCount ?? 0);

        const skinObj = {
          id: skinId,
          championId: cId,
          assetChampionId: sourceChampionId,
          championName: cName,
          championAlias,
          skinNum,
          name: skinName,
          owned: isOwned,
          shard: hasShard,
          rental: isRental,
          rarity: rawRarity || 'standard',
          description: dbEntry.description || dbEntry.blurb || s.description || '',
          chromaCount: Number.isFinite(chromaCount) ? chromaCount : 0,
          isLegacy,
          stillObtainable,
          unavailable,
          disabled: !!(s.disabled || dbEntry.disabled),
          isClassic,
        };

        parsedSkins.push(skinObj);
      });

      if (parsedSkins.length === 0) {
        throw new Error('League returned no usable skin records. Refresh after the client reaches the home screen.');
      }

      const ownedCount = uniqueCollectionSkins(parsedSkins).filter((skin) => skin.owned).length;
      setOwnedDelta(previousOwnedRef.current == null ? null : ownedCount - previousOwnedRef.current);
      previousOwnedRef.current = ownedCount;
      setLastUpdated(new Date());
      setUsingCachedCatalog(false);
      setAllSkins(parsedSkins);
      try {
        if (cacheKeys) {
          localStorage.setItem(cacheKeys.data, JSON.stringify(parsedSkins));
          localStorage.setItem(cacheKeys.updated, new Date().toISOString());
          localStorage.setItem(cacheKeys.shardsAvailable, JSON.stringify(lootResult.available));
        }
      } catch {
        // A full localStorage quota should not make the LCU refresh fail.
      }
    } catch (err: any) {
      if (cached.length > 0) {
        setAllSkins(cached);
        setUsingCachedCatalog(true);
        setShardsAvailable(cacheKeys ? readPreference(cacheKeys.shardsAvailable, false) : false);
        const cachedAt = cacheKeys ? readPreference<string | null>(cacheKeys.updated, null) : null;
        setLastUpdated(cachedAt ? new Date(cachedAt) : null);
        setError(null);
      } else {
        setError(err.message || 'Failed to load skin collection — launch League first.');
      }
    } finally {
      setLoading(false);
    }
  }, [remoteReadOnly]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const uniqueSkins = useMemo(() => uniqueCollectionSkins(allSkins), [allSkins]);
  const normalSkins = useMemo(() => uniqueSkins.filter((skin) => !skin.isClassic), [uniqueSkins]);
  const classicSkins = useMemo(() => uniqueSkins.filter((skin) => skin.isClassic), [uniqueSkins]);
  const categorySkins = useMemo(
    () => (skinCategory === 'classic' ? classicSkins : normalSkins),
    [skinCategory, classicSkins, normalSkins],
  );
  const categoryChamps = useMemo(() => buildChampionTotals(categorySkins), [categorySkins]);
  const champById = useMemo(() => new Map(categoryChamps.map((champ) => [champ.id, champ])), [categoryChamps]);

  // Totals use distinct skins and always describe the whole selected category.
  const totalOwned = categorySkins.filter((s) => s.owned).length;
  const totalShards = categorySkins.filter((s) => s.shard).length;
  const totalUnavailable = categorySkins.filter((s) => s.unavailable).length;
  const activeFilterCount = [
    search.trim().length > 0,
    tierFilter !== 'all',
    statusFilter !== 'all',
    smartFilter !== 'all',
    shardsOnly,
    favsOnly,
    championFilter !== 'all',
  ].filter(Boolean).length;

  const clearFilters = () => {
    setSearch('');
    setTierFilter('all');
    setStatusFilter('all');
    setSmartFilter('all');
    setShardsOnly(false);
    setFavsOnly(false);
    setSelectedChampId(null);
    setChampionFilter('all');
  };

  const chooseStatus = (next: SkinStatusFilter) => {
    setStatusFilter(next);
    setShardsOnly(false);
  };

  const toggleStatus = (next: SkinStatusFilter) => {
    chooseStatus(statusFilter === next && !shardsOnly ? 'all' : next);
  };

  const visibleSkins = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rarityRank = (skin: any) => (TIER_MAP[skin.rarity] || TIER_MAP.standard).rank;

    return categorySkins.filter((skin) => {
      const champ = champById.get(skin.championId);
      const matchesQuery = !query ||
        skin.championName.toLowerCase().includes(query) ||
        skin.name.toLowerCase().includes(query);
      if (!matchesQuery) return false;
      if (tierFilter !== 'all' && !skin.rarity.includes(tierFilter)) return false;
      if (shardsOnly && !skin.shard) return false;
      if (favsOnly && !isSkinFavorite(favs, skin)) return false;
      if (statusFilter === 'owned' && !skin.owned) return false;
      if (statusFilter === 'missing' && (skin.owned || skin.rental || skin.shard)) return false;
      if (statusFilter === 'zero-owned' && (!champ || champ.owned > 0)) return false;
      if (statusFilter === 'available' && skin.unavailable) return false;
      if (statusFilter === 'shard' && !skin.shard) return false;
      if (statusFilter === 'rental' && !skin.rental) return false;
      if (statusFilter === 'wishlist' && !wishlist.has(skinKey(skin))) return false;
      if (statusFilter === 'unavailable' && !skin.unavailable) return false;
      if (smartFilter === 'zero-skins' && (!champ || champ.owned > 0)) return false;
      if (smartFilter === 'rarest' && rarityRank(skin) < TIER_MAP.legendary.rank) return false;
      if (smartFilter === 'shard-candidates' && !skin.shard) return false;
      if (smartFilter === 'near-complete' && (!champ || champ.owned >= champ.total || champ.owned / champ.total < 0.75)) return false;
      if (smartFilter === 'missing-one' && (!champ || champ.total - champ.owned !== 1)) return false;
      return true;
    });
  }, [categorySkins, champById, search, tierFilter, shardsOnly, favsOnly, favs, statusFilter, wishlist, smartFilter]);

  // Filtered champions grid. Portraits retain full totals, while their panel obeys
  // the active skin-level filters.
  const visibleChampionIds = new Set(visibleSkins.map((skin) => skin.championId));
  const filteredChamps = categoryChamps.filter((champ) => visibleChampionIds.has(champ.id) && (
    championFilter === 'all' ||
    (championFilter === 'owned' && champ.owned > 0) ||
    (championFilter === 'incomplete' && champ.owned < champ.total) ||
    (championFilter === 'complete' && champ.total > 0 && champ.owned === champ.total)
  ));

  // Start alphabetically; optional progress sorts keep stable name tie-breaks.
  const sortedChamps = [...filteredChamps].sort((a, b) => {
    const completion = (champ: any) => champ.total > 0 ? champ.owned / champ.total : 0;
    if (championSort === 'least-owned') {
      return a.owned - b.owned || completion(a) - completion(b) || b.total - a.total || a.name.localeCompare(b.name);
    }
    if (championSort === 'completion') {
      return completion(b) - completion(a) || b.owned - a.owned || b.total - a.total || a.name.localeCompare(b.name);
    }
    if (championSort === 'owned') {
      return b.owned - a.owned || completion(b) - completion(a) || a.name.localeCompare(b.name);
    }
    if (championSort === 'total') {
      return b.total - a.total || b.owned - a.owned || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
  });

  const displayedChamps = sortedChamps;
  const selectedChampion = selectedChampId === null ? null : champById.get(selectedChampId);
  useEffect(() => {
    if (selectedChampId === null) return;
    document.getElementById('collection-detail-title')?.focus();
    document.getElementById('collection-champion-skins')?.scrollIntoView({ block: 'nearest' });
  }, [selectedChampId]);
  const closeChampion = () => {
    const id = selectedChampId;
    setSelectedChampId(null);
    requestAnimationFrame(() => document.getElementById(`collection-champion-${id}`)?.focus());
  };
  const visibleSkinsByChampion = useMemo(() => {
    const rarityRank = (skin: any) => (TIER_MAP[skin.rarity] || TIER_MAP.standard).rank;
    const sorted = [...visibleSkins].sort((a, b) => {
      if (skinSort === 'rarity') return rarityRank(b) - rarityRank(a) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
    const groups = new Map<number, any[]>();
    sorted.forEach((skin) => groups.set(skin.championId, [...(groups.get(skin.championId) || []), skin]));
    return groups;
  }, [skinSort, visibleSkins]);
  const tierOptions = Object.entries(TIER_MAP).filter(([tier]) => categorySkins.some((skin) => skin.rarity === tier));


  const renderSkinCard = (skin: any) => {
    const isFav = isSkinFavorite(favs, skin);
    const isWishlisted = wishlist.has(skinKey(skin));
    const tier = TIER_MAP[skin.rarity] || TIER_MAP.standard;
    const status = skin.owned ? 'Owned' : skin.rental ? 'Rental' : skin.shard ? 'Shard ready' : skin.unavailable ? 'Legacy' : 'Missing';

    return (
      <article
        key={skin.id}
        className={`skin-vault-card ${skin.owned ? 'is-owned' : skin.rental ? 'is-rental' : skin.shard ? 'is-shard' : 'is-missing'} ${skin.unavailable ? 'is-unavailable' : ''}`}
      >
        <button type="button" className="collection-skin-preview" aria-label={`Preview ${skin.name}, ${status}`} onClick={() => setPreviewSkin(skin)} />
        <div className="skin-vault-card__media">
          <SkinCardArt
            key={`${viewMode}-${skin.id}`}
            skin={skin}
            viewMode={viewMode}
            alt={skin.name}
          />
          <div className="skin-vault-card__wash" />
        </div>
        <div className="skin-vault-card__body">
          <div className="skin-vault-card__header">
            <div className="skin-vault-card__badges">
              <span style={{ '--tier-color': tier.color } as React.CSSProperties}><i />{tier.label}</span>
              <em className={`is-${status.toLowerCase().replaceAll(' ', '-')}`}>{status}</em>
              {skin.shard && <em className="is-shard-tag">◆ Shard</em>}
            </div>
            <div className="skin-vault-card__tools">
              <button
                type="button"
                className={isWishlisted ? 'is-selected' : ''}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleWishlist(skin);
                }}
                aria-label={isWishlisted ? `Remove ${skin.name} from wishlist` : `Add ${skin.name} to wishlist`}
                title={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
              >
                <Bookmark className={isWishlisted ? 'fill-current text-amber-300' : ''} />
              </button>
              <button
                type="button"
                className={isFav ? 'is-favorite' : ''}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleFav(skin);
                }}
                aria-label={isFav ? `Remove ${skin.name} from favorites` : `Add ${skin.name} to favorites`}
                title={isFav ? 'Remove from favorites' : 'Add to favorites'}
              >
                <Heart className={isFav ? 'fill-current text-rose-400' : ''} />
              </button>
            </div>
          </div>
          <div className="skin-vault-card__copy">
            <strong>{skin.name}</strong>
            <small>{skin.chromaCount > 0 ? `${skin.chromaCount} chroma${skin.chromaCount === 1 ? '' : 's'}` : skin.isLegacy ? 'Legacy cosmetic' : 'League cosmetic'}</small>
          </div>
        </div>
      </article>
    );
  };

  const completeChampions = categoryChamps.filter((champ) => champ.total > 0 && champ.owned === champ.total).length;
  return (
    <div className="page-content page-content--skins collection-page">
      <PageHeader icon={Sparkles} eyebrow="COLLECTION" title="Collection" description="Your champions. Your skins. Your collection."
        meta={loading ? <span className="page-header__badge">Loading collection</span> : error ? <span className="page-header__badge">Collection unavailable</span> : <span className="collection-totals"><b>{categoryChamps.length}</b> champions <span>·</span> <b>{totalOwned}</b> skins <span>·</span> <b>{completeChampions}</b> complete</span>}
        actions={<>{lastUpdated && <span className="page-header__updated"><Clock3 /> {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}<button type="button" onClick={() => void loadData()} disabled={loading} className="page-header__icon-action" aria-label="Refresh skin collection"><RefreshCw className={loading ? 'animate-spin' : ''} /></button></>}
      />
      {usingCachedCatalog && <p className="collection-notice" role="status">Showing this account's saved collection. Refresh when League reconnects.</p>}
      {ownedDelta !== null && ownedDelta !== 0 && <p className="collection-notice" role="status">{ownedDelta > 0 ? '+' : ''}{ownedDelta} owned skins since the previous refresh.</p>}
      {!loading && !error && <>
        <div className="collection-toolbar">
          <label className="collection-search"><Search aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search champions or skins…" aria-label="Search champions or skins" />{search && <button type="button" onClick={() => setSearch('')} aria-label="Clear collection search"><X /></button>}</label>
          <div className="collection-tabs" role="group" aria-label="Champion collection filter">
            {(['all', 'owned', 'incomplete', 'complete'] as ChampionFilter[]).map((filter) => <button type="button" key={filter} onClick={() => setChampionFilter(filter)} aria-pressed={championFilter === filter}>{filter[0].toUpperCase() + filter.slice(1)}</button>)}
          </div>
          <label className="collection-sort"><span className="sr-only">Sort champions</span><select value={championSort} onChange={(event) => setChampionSort(event.target.value as ChampionSort)}><option value="name">Name A–Z</option><option value="completion">Most complete</option><option value="least-owned">Least owned</option><option value="owned">Most owned</option><option value="total">Most skins</option></select><ChevronDown aria-hidden="true" /></label>
        </div>
        <details className="collection-advanced"><summary><SlidersHorizontal aria-hidden="true" /> More filters{activeFilterCount > 0 && <span>{activeFilterCount} active</span>}</summary><div className="collection-advanced__body">
          <div className="skin-vault-filter-group"><span>Skin card size</span><label className="skin-vault-filter-group__select"><select aria-label="Skin card size" value={density} onChange={(event) => setDensity(event.target.value as SkinDensity)}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select><ChevronDown aria-hidden="true" /></label></div>
          <div className="skin-vault-filter-group"><span>Skin status</span><label className="skin-vault-filter-group__select"><select aria-label="Skin status" value={statusFilter} onChange={(event) => chooseStatus(event.target.value as SkinStatusFilter)}><option value="all">All skins</option><option value="owned">Owned skins</option><option value="missing">Missing without shards</option><option value="zero-owned">Champions with no owned skins</option><option value="available">Available in store</option><option value="shard">Shard available</option><option value="rental">Temporary rentals</option><option value="wishlist">Wishlisted</option><option value="unavailable">Legacy / unavailable</option></select><ChevronDown aria-hidden="true" /></label></div>

          <div className="skin-vault-filter-group">
            <span>Collection</span>
            <div className="skin-vault-filters__collection-toggle">
              {(['normal', 'classic'] as SkinCategory[]).map((category) => {
                const skins = category === 'classic' ? classicSkins : normalSkins;
                const owned = skins.filter((skin) => skin.owned).length;
                return (
                  <button
                    type="button"
                    key={category}
                    aria-pressed={skinCategory === category}
                    className={skinCategory === category ? 'is-selected' : ''}
                    onClick={() => {
                      setSkinCategory(category);
                      setSelectedChampId(null);
                    }}
                  >
                    <span>{category === 'classic' ? 'Classic' : 'Normal'}</span>
                    <small>{owned}/{skins.length}</small>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="skin-vault-filter-group">
            <span>Focus</span>
            <label className="skin-vault-filter-group__select">
              <select aria-label="Collection focus" value={smartFilter} onChange={(event) => setSmartFilter(event.target.value as SmartFilter)}>
                <option value="all">Every collection</option>
                <option value="zero-skins">No skins owned (0 skins)</option>
                <option value="near-complete">Near complete (75%+)</option>
                <option value="missing-one">Missing one skin</option>
                <option value="rarest">Rare skins (Legendary+)</option>
                <option value="shard-candidates">Shard candidates</option>
              </select>
              <ChevronDown />
            </label>
          </div>

          <div className="skin-vault-filter-group">
            <span>Tier</span>
            <label className="skin-vault-filter-group__select">
              <select aria-label="Skin tier" value={tierFilter} onChange={(event) => setTierFilter(event.target.value)}>
                <option value="all">Every tier ({totalOwned}/{categorySkins.length})</option>
                {tierOptions.map(([tier, info]) => {
                  const skins = categorySkins.filter((skin) => skin.rarity === tier);
                  const owned = skins.filter((skin) => skin.owned).length;
                  return (
                    <option key={tier} value={tier}>
                      {info.label} ({owned}/{skins.length})
                    </option>
                  );
                })}
              </select>
              <ChevronDown />
            </label>
          </div>

          <div className="skin-vault-filter-group">
            <span>Quick Toggles</span>
            <div className="skin-vault-filter-chips">
              <button
                type="button"
                className={`skin-vault-filter-chip ${statusFilter === 'shard' || shardsOnly ? 'is-selected' : ''}`}
                onClick={() => toggleStatus('shard')}
                aria-pressed={statusFilter === 'shard' || shardsOnly}
                disabled={!shardsAvailable}
              >
                <Gem className="w-3 h-3 text-emerald-400" />
                <span>Shards</span>
                <small>{totalShards}</small>
              </button>
              <button
                type="button"
                className={`skin-vault-filter-chip ${favsOnly ? 'is-selected' : ''}`}
                onClick={() => setFavsOnly((value) => !value)} aria-pressed={favsOnly}
              >
                <Heart className={`w-3 h-3 ${favsOnly ? 'fill-current text-rose-400' : 'text-rose-400'}`} />
                <span>Favorites</span>
                <small>{favs.size}</small>
              </button>
              <button
                type="button"
                className={`skin-vault-filter-chip ${statusFilter === 'wishlist' ? 'is-selected' : ''}`}
                onClick={() => toggleStatus('wishlist')}
              >
                <Bookmark className={`w-3 h-3 ${statusFilter === 'wishlist' ? 'fill-current text-amber-300' : 'text-amber-300'}`} />
                <span>Wishlist</span>
                <small>{wishlist.size}</small>
              </button>
              <button
                type="button"
                className={`skin-vault-filter-chip ${statusFilter === 'unavailable' ? 'is-selected' : ''}`}
                onClick={() => toggleStatus('unavailable')}
              >
                <span>Legacy</span>
                <small>{totalUnavailable}</small>
              </button>
            </div>
          </div>


        </div></details>
        {activeFilterCount > 0 && <div className="collection-filter-summary"><span>{filteredChamps.length} champions match your filters</span><button type="button" onClick={clearFilters}><RotateCcw aria-hidden="true" /> Clear filters</button></div>}
        {!shardsAvailable && <p className="collection-notice" role="status">{remoteReadOnly ? 'Shard inventory is available on the desktop.' : 'Shard inventory unavailable. Owned skins are shown; refresh to check your shards.'}</p>}
        <div className="collection-legend" aria-label="Collection ring colors"><span><i className="is-owned" />Owned skins</span><span><i className="is-shard" />Shards to unlock</span><span><i className="is-missing" />Missing skins</span><small>Shards do not count as owned skins.</small></div>
        {selectedChampion && <section className="collection-detail" id="collection-champion-skins" aria-labelledby="collection-detail-title">
          <header><div><h2 id="collection-detail-title" tabIndex={-1}>{selectedChampion.name} skins</h2><p>{selectedChampion.owned} / {selectedChampion.total} owned{selectedChampion.shards > 0 ? ` · ${selectedChampion.shards} shards to unlock` : ''}</p></div><div className="collection-detail__actions"><label><span className="sr-only">Sort skins</span><select value={skinSort} onChange={(event) => setSkinSort(event.target.value as SkinSort)}><option value="rarity">Highest tier</option><option value="name">Name A–Z</option></select></label><button type="button" onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')} aria-label={viewMode === 'grid' ? 'Show skins in a list' : 'Show skins in a grid'}>{viewMode === 'grid' ? <List /> : <LayoutGrid />}</button><button type="button" onClick={closeChampion} aria-label="Close champion skins"><X /></button></div></header>
          <div className="collection-detail__body">{(visibleSkinsByChampion.get(selectedChampion.id) || []).length > 0 ? <div className={`skin-vault-cards is-${viewMode} is-${density}`}>{(visibleSkinsByChampion.get(selectedChampion.id) || []).map(renderSkinCard)}</div> : <p>No skins match the active filters for this champion. Clear filters to see every skin.</p>}</div>
        </section>}
        <div className="collection-champion-grid" aria-label="Champion skin collections">
          {displayedChamps.map((champion) => <ChampionCollectionPortrait key={champion.id} champion={champion} shardsKnown={shardsAvailable} selected={selectedChampId === champion.id} onSelect={() => selectedChampId === champion.id ? closeChampion() : setSelectedChampId(champion.id)} />)}
        </div>
        {displayedChamps.length === 0 && <div className="skin-vault-state"><Search aria-hidden="true" /><strong>No champions match these filters</strong><span>Try another search or clear your filters.</span><button type="button" onClick={clearFilters}>Clear filters</button></div>}
      </>}
      {loading && <div className="skin-vault-state" role="status"><Loader2 className="animate-spin" /><strong>Loading your collection</strong><span>Reading skins and ownership from League Client…</span></div>}
      {error && !loading && <div className="skin-vault-state is-error" role="status"><Shield /><strong>Collection unavailable</strong><span>{error}</span><button type="button" onClick={() => void loadData()}>Retry connection</button></div>}

      {/* Fullsplash Modal Preview */}
      {previewSkin && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-6 animate-fadeIn" onClick={() => setPreviewSkin(null)}>
          <div ref={previewDialogRef} tabIndex={-1} className="skin-vault-preview relative max-w-5xl w-full max-h-[92vh] overflow-y-auto bg-base rounded-2xl border border-primary/30 shadow-2xl space-y-4 p-4" role="dialog" aria-modal="true" aria-label={`${previewSkin.name} preview`} onClick={(event) => event.stopPropagation()}>
            <button
              onClick={() => setPreviewSkin(null)}
              className="absolute top-3 right-3 p-2 rounded-xl bg-black/60 text-white hover:bg-black/90 transition z-20 cursor-pointer"
              aria-label="Close skin preview"
            >
              <X className="w-5 h-5" />
            </button>

            <img
              key={previewSkin.id}
              src={`/lol-game-data/assets/v1/champion-splashes/${previewSkin.assetChampionId || previewSkin.championId}/${previewSkin.id}.jpg`}
              alt={previewSkin.name}
              width="1280"
              height="720"
              className="w-full h-96 object-cover rounded-xl border border-white/10"
              onError={(e: any) => {
                const alias = resolveChampionAlias(previewSkin.championName, previewSkin.championId, previewSkin.championAlias);
                e.currentTarget.src = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${alias}_${previewSkin.skinNum || 0}.jpg`;
              }}
            />

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-2.5">
                <p className="text-[9px] uppercase font-black tracking-wider text-text-dim">Status</p>
                <p className="text-xs font-black text-white mt-1">{previewSkin.owned ? 'Owned' : previewSkin.rental ? 'Rental' : previewSkin.shard ? 'Shard available' : 'Not owned'}</p>
              </div>
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-2.5">
                <p className="text-[9px] uppercase font-black tracking-wider text-text-dim">Rarity</p>
                <p className="text-xs font-black text-white mt-1">{(TIER_MAP[previewSkin.rarity] || TIER_MAP.standard).label}</p>
              </div>
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-2.5">
                <p className="text-[9px] uppercase font-black tracking-wider text-text-dim">Chromas</p>
                <p className="text-xs font-black text-white mt-1">{previewSkin.chromaCount || 0}</p>
              </div>
            </div>

            {(previewSkin.description || previewSkin.isLegacy || previewSkin.unavailable) && (
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 space-y-1">
                <p className="text-[9px] uppercase font-black tracking-wider text-text-dim">Collection notes</p>
                {previewSkin.description && <p className="text-xs text-text-muted leading-relaxed">{previewSkin.description}</p>}
                {(previewSkin.isLegacy || previewSkin.unavailable) && <p className="text-[10px] text-amber-300 font-bold">Legacy or currently unavailable in the store.</p>}
              </div>
            )}

            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-black text-white">{previewSkin.name}</h3>
                <p className="text-xs text-text-muted font-bold">{previewSkin.championName} · Skin #{previewSkin.skinNum}</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                <button
                  onClick={() => toggleFav(previewSkin)}
                  className="px-3 py-2 rounded-xl bg-rose-500/20 text-rose-300 border border-rose-500/40 font-bold text-xs flex items-center gap-2 cursor-pointer"
                >
                  <Heart className={`w-4 h-4 ${isSkinFavorite(favs, previewSkin) ? 'fill-rose-400' : ''}`} />
                  <span>{isSkinFavorite(favs, previewSkin) ? 'Favorited' : 'Add favorite'}</span>
                </button>
                <button
                  onClick={() => toggleWishlist(previewSkin)}
                  className="px-3 py-2 rounded-xl bg-amber-500/15 text-amber-300 border border-amber-500/30 font-bold text-xs flex items-center gap-2 cursor-pointer"
                >
                  <Bookmark className={`w-4 h-4 ${wishlist.has(skinKey(previewSkin)) ? 'fill-amber-300' : ''}`} />
                  <span>{wishlist.has(skinKey(previewSkin)) ? 'Wishlisted' : 'Wishlist'}</span>
                </button>
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(String(previewSkin.id));
                    setCopyStatus(true);
                    window.setTimeout(() => setCopyStatus(false), 1400);
                  }}
                  className="px-3 py-2 rounded-xl bg-white/[0.04] text-text-muted border border-white/[0.08] font-bold text-xs flex items-center gap-2 cursor-pointer hover:text-white"
                >
                  {copyStatus ? <Check className="w-4 h-4 text-emerald-300" /> : <Copy className="w-4 h-4" />}
                  <span>{copyStatus ? 'Copied' : 'Copy ID'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
