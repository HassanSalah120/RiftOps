import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { fetchLCUSkins, fetchLCULoot } from '../api';
import {
  Sparkles,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  Heart,
  X,
  ChevronRight,
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
import { useDialogFocus } from './useDialogFocus';

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
type SkinView = 'grid' | 'list';
type SkinDensity = 'comfortable' | 'compact';
type SkinSort = 'rarity' | 'name';
type SkinStatusFilter = 'all' | 'owned' | 'missing' | 'available' | 'shard' | 'rental' | 'wishlist' | 'unavailable';
type SmartFilter = 'all' | 'near-complete' | 'missing-one' | 'rarest' | 'shard-candidates';

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

const SKIN_CACHE_KEY = 'riftops-skin-cache-v2';
const SKIN_CACHE_UPDATED_KEY = 'riftops-skin-cache-v2-updated';

function skinKey(skin: any) {
  return String(skin.id);
}

function legacySkinKey(skin: any) {
  return `${skin.championId}_${skin.skinNum}`;
}

function isSkinFavorite(favs: Set<string>, skin: any) {
  return favs.has(skinKey(skin)) || favs.has(legacySkinKey(skin));
}

function buildChampionTotals(skins: any[]) {
  const totals = new Map<number, {
    id: number;
    name: string;
    total: number;
    owned: number;
    shards: number;
    rentals: number;
    unavailable: number;
  }>();
  skins.forEach((skin) => {
    const current = totals.get(skin.championId) || {
      id: skin.championId,
      name: skin.championName,
      total: 0,
      owned: 0,
      shards: 0,
      rentals: 0,
      unavailable: 0,
    };
    current.total++;
    if (skin.owned) current.owned++;
    if (skin.shard) current.shards++;
    if (skin.rental) current.rentals++;
    if (skin.unavailable) current.unavailable++;
    totals.set(skin.championId, current);
  });
  return Array.from(totals.values());
}

export default function SkinShowcase({ remoteReadOnly = false }: { remoteReadOnly?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allSkins, setAllSkins] = useState<any[]>([]);
  const [search, setSearch] = useState(() => readPreference('riftops-skin-search', ''));
  const [tierFilter, setTierFilter] = useState<string>(() => readPreference('riftops-skin-tier', 'all'));
  const [championSort, setChampionSort] = useState<'completion' | 'owned' | 'name' | 'total'>(() => readPreference('riftops-skin-sort', 'completion'));
  const [skinCategory, setSkinCategory] = useState<SkinCategory>(() => readPreference('riftops-skin-category', 'normal'));
  const [shardsOnly, setShardsOnly] = useState(() => readPreference('riftops-skin-shards-only', false));
  const [selectedChampId, setSelectedChampId] = useState<number | null>(null);
  const [favsOnly, setFavsOnly] = useState(() => readPreference('riftops-skin-favs-only', false));
  const [statusFilter, setStatusFilter] = useState<SkinStatusFilter>(() => readPreference('riftops-skin-status', 'all'));
  const [smartFilter, setSmartFilter] = useState<SmartFilter>(() => readPreference('riftops-skin-smart-filter', 'all'));
  const [viewMode, setViewMode] = useState<SkinView>(() => readPreference('riftops-skin-view', 'grid'));
  const [density, setDensity] = useState<SkinDensity>(() => readPreference('riftops-skin-density', 'comfortable'));
  const [skinSort, setSkinSort] = useState<SkinSort>(() => readPreference('riftops-skin-item-sort', 'rarity'));
  const [filtersOpen, setFiltersOpen] = useState(() => readPreference('riftops-skin-filters-open', false));
  const [previewSkin, setPreviewSkin] = useState<any | null>(null);
  const [copyStatus, setCopyStatus] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [ownedDelta, setOwnedDelta] = useState<number | null>(null);
  const [usingCachedCatalog, setUsingCachedCatalog] = useState(false);
  const [championLimit, setChampionLimit] = useState(12);
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
    localStorage.setItem('riftops-skin-sort', JSON.stringify(championSort));
    localStorage.setItem('riftops-skin-category', JSON.stringify(skinCategory));
    localStorage.setItem('riftops-skin-shards-only', JSON.stringify(shardsOnly));
    localStorage.setItem('riftops-skin-favs-only', JSON.stringify(favsOnly));
    localStorage.setItem('riftops-skin-status', JSON.stringify(statusFilter));
    localStorage.setItem('riftops-skin-smart-filter', JSON.stringify(smartFilter));
    localStorage.setItem('riftops-skin-view', JSON.stringify(viewMode));
    localStorage.setItem('riftops-skin-density', JSON.stringify(density));
    localStorage.setItem('riftops-skin-item-sort', JSON.stringify(skinSort));
    localStorage.setItem('riftops-skin-filters-open', JSON.stringify(filtersOpen));
  }, [search, tierFilter, championSort, skinCategory, shardsOnly, favsOnly, statusFilter, smartFilter, viewMode, density, skinSort, filtersOpen]);

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
    const cached = readPreference<any[]>(SKIN_CACHE_KEY, []);
    if (!warmedFromCacheRef.current && cached.length > 0) {
      warmedFromCacheRef.current = true;
      setAllSkins(cached);
      setUsingCachedCatalog(true);
      const cachedAt = readPreference<string | null>(SKIN_CACHE_UPDATED_KEY, null);
      setLastUpdated(cachedAt ? new Date(cachedAt) : null);
    }
    setLoading(cached.length === 0);
    setError(null);
    try {
      const [ownedRaw, lootRaw, skinsDb, champsSummary] = await Promise.all([
        fetchLCUSkins(),
        remoteReadOnly ? Promise.resolve([]) : fetchLCULoot().catch(() => []),
        fetch('/lol-game-data/assets/v1/skins.json').then((r) => r.json()).catch(() => ({})),
        fetch('/lol-game-data/assets/v1/champion-summary.json').then((r) => r.json()).catch(() => []),
      ]);

      const shardSkinIds = new Set<number>();
      if (Array.isArray(lootRaw)) {
        lootRaw.forEach((item: any) => {
          if (item.lootId && (item.lootId.startsWith('CHAMPION_SKIN_RENTAL_') || item.lootId.startsWith('CHAMPION_SKIN_'))) {
            const idStr = item.lootId.replace(/^CHAMPION_SKIN_RENTAL_|^CHAMPION_SKIN_/, '');
            const id = parseInt(idStr, 10);
            if (id > 0) shardSkinIds.add(id);
          }
        });
      }

      const skinDbMap = new Map();
      if (skinsDb) {
        const dbArray = Array.isArray(skinsDb) ? skinsDb : Object.values(skinsDb);
        dbArray.forEach((s: any) => {
          const id = numberField(s.id, s.skinId, s.championSkinId);
          if (id !== null) skinDbMap.set(id, s);
        });
      }

      const champNames = new Map();
      const champArray = Array.isArray(champsSummary)
        ? champsSummary
        : champsSummary && typeof champsSummary === 'object'
        ? Object.values(champsSummary)
        : [];
      champArray.forEach((c: any) => {
        const championId = numberField(c.id, c.championId);
        if (championId !== null) champNames.set(championId, c.name || c.alias || `#${championId}`);
      });

      const ownedArr = flattenSkinRecords(ownedRaw);
      if (ownedArr.length === 0) {
        throw new Error('League returned no skin records. Open League and refresh the collection.');
      }

      const parsedSkins: any[] = [];

      ownedArr.forEach((s: any) => {
        const sourceChampionId = numberField(s.championId, s.assetChampionId);
        const skinId = numberField(s.id, s.skinId, s.championSkinId);
        if (sourceChampionId === null || skinId === null) return;
        const skinNum = skinId % 1000;
        if (s.isBase === true || skinNum === 0) return; // skip base skin

        const { isOwned, isRental } = skinOwnership(s);
        const hasShard = !isOwned && !isRental && shardSkinIds.has(skinId);
        const dbEntry = skinDbMap.get(skinId) || {};
        const skinName = s.name || dbEntry.name || `Skin #${skinNum}`;
        const isClassic = /^classic(?:\s|$)/i.test(String(skinName)) || (sourceChampionId >= 60000 && skinId >= 60000000);
        const cId = isClassic && sourceChampionId >= 60000 ? sourceChampionId - 60000 : sourceChampionId;
        const cName = champNames.get(cId) || dbEntry.championName || `Champion ${cId}`;
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

      const ownedCount = parsedSkins.filter((skin) => skin.owned).length;
      setOwnedDelta(previousOwnedRef.current == null ? null : ownedCount - previousOwnedRef.current);
      previousOwnedRef.current = ownedCount;
      setLastUpdated(new Date());
      setUsingCachedCatalog(false);
      setAllSkins(parsedSkins);
      try {
        localStorage.setItem(SKIN_CACHE_KEY, JSON.stringify(parsedSkins));
        localStorage.setItem(SKIN_CACHE_UPDATED_KEY, new Date().toISOString());
      } catch {
        // A full localStorage quota should not make the LCU refresh fail.
      }
    } catch (err: any) {
      const cached = readPreference<any[]>(SKIN_CACHE_KEY, []);
      if (cached.length > 0) {
        setAllSkins(cached);
        setUsingCachedCatalog(true);
        const cachedAt = readPreference<string | null>(SKIN_CACHE_UPDATED_KEY, null);
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

  useEffect(() => {
    if (!filtersOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFiltersOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    const compact = window.matchMedia('(max-width: 900px)').matches;
    const previousOverflow = document.body.style.overflow;
    if (compact) document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (compact) document.body.style.overflow = previousOverflow;
    };
  }, [filtersOpen]);

  const normalSkins = useMemo(() => allSkins.filter((skin) => !skin.isClassic), [allSkins]);
  const classicSkins = useMemo(() => allSkins.filter((skin) => skin.isClassic), [allSkins]);
  const categorySkins = useMemo(
    () => (skinCategory === 'classic' ? classicSkins : normalSkins),
    [skinCategory, classicSkins, normalSkins],
  );
  const categoryChamps = useMemo(() => buildChampionTotals(categorySkins), [categorySkins]);
  const champById = useMemo(() => new Map(categoryChamps.map((champ) => [champ.id, champ])), [categoryChamps]);

  // Derived statistics for the selected category. Skin completion is kept separate
  // from champion coverage so both numbers describe something meaningful.
  const totalOwned = categorySkins.filter((s) => s.owned).length;
  const totalShards = categorySkins.filter((s) => s.shard).length;
  const totalRentals = categorySkins.filter((s) => s.rental).length;
  const totalUnavailable = categorySkins.filter((s) => s.unavailable).length;
  const champsWithOwned = categoryChamps.filter((c) => c.owned > 0).length;
  const pct = categorySkins.length ? Math.round((totalOwned / categorySkins.length) * 100) : 0;
  const championPct = categoryChamps.length ? Math.round((champsWithOwned / categoryChamps.length) * 100) : 0;
  const activeFilterCount = [
    search.trim().length > 0,
    tierFilter !== 'all',
    statusFilter !== 'all',
    smartFilter !== 'all',
    shardsOnly,
    favsOnly,
    selectedChampId !== null,
  ].filter(Boolean).length;
  const clearFilters = () => {
    setSearch('');
    setTierFilter('all');
    setStatusFilter('all');
    setSmartFilter('all');
    setShardsOnly(false);
    setFavsOnly(false);
    setSelectedChampId(null);
  };

  const chooseStatus = (next: SkinStatusFilter) => {
    setStatusFilter(next);
    setShardsOnly(false);
    setChampionLimit(12);
  };

  const toggleStatus = (next: SkinStatusFilter) => {
    chooseStatus(statusFilter === next && !shardsOnly ? 'all' : next);
  };

  const visibleSkins = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rarityRank = (skin: any) => (TIER_MAP[skin.rarity] || TIER_MAP.standard).rank;

    return categorySkins.filter((skin) => {
      const champ = champById.get(skin.championId);
      if (selectedChampId !== null && skin.championId !== selectedChampId) return false;
      const matchesQuery = !query ||
        skin.championName.toLowerCase().includes(query) ||
        skin.name.toLowerCase().includes(query);
      if (!matchesQuery) return false;
      if (tierFilter !== 'all' && !skin.rarity.includes(tierFilter)) return false;
      if (shardsOnly && !skin.shard) return false;
      if (favsOnly && !isSkinFavorite(favs, skin)) return false;
      if (statusFilter === 'owned' && !skin.owned) return false;
      if (statusFilter === 'missing' && (skin.owned || skin.rental || skin.shard)) return false;
      if (statusFilter === 'available' && skin.unavailable) return false;
      if (statusFilter === 'shard' && !skin.shard) return false;
      if (statusFilter === 'rental' && !skin.rental) return false;
      if (statusFilter === 'wishlist' && !wishlist.has(skinKey(skin))) return false;
      if (statusFilter === 'unavailable' && !skin.unavailable) return false;
      if (smartFilter === 'rarest' && rarityRank(skin) < TIER_MAP.legendary.rank) return false;
      if (smartFilter === 'shard-candidates' && !skin.shard) return false;
      if (smartFilter === 'near-complete' && (!champ || champ.owned >= champ.total || champ.owned / champ.total < 0.75)) return false;
      if (smartFilter === 'missing-one' && (!champ || champ.total - champ.owned !== 1)) return false;
      return true;
    });
  }, [categorySkins, champById, selectedChampId, search, tierFilter, shardsOnly, favsOnly, favs, statusFilter, wishlist, smartFilter]);

  // Filtered champions grid. Cards retain full totals, while their drawer obeys
  // the active skin-level filters.
  const filteredChamps = categoryChamps.filter((champ) => visibleSkins.some((skin) => skin.championId === champ.id));

  // Completion is the default because it surfaces the champions closest to
  // being finished. Tie-break with owned count, then total size, so the order
  // remains useful and stable when several champions share the same percent.
  const sortedChamps = [...filteredChamps].sort((a, b) => {
    const completion = (champ: any) => champ.total > 0 ? champ.owned / champ.total : 0;
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

  const displayedChamps = sortedChamps.slice(0, championLimit);
  // Kept only for the non-rendered legacy drawer below while the new vault
  // layout settles existing saved preferences during this release.
  const champRows: any[][] = [];
  for (let index = 0; index < displayedChamps.length; index += 4) champRows.push(displayedChamps.slice(index, index + 4));
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
  const missingCount = categorySkins.filter((skin) => !skin.owned && !skin.rental && !skin.shard).length;
  const showLegacyDrawer = false;

  const headerMeta = (
    <>
      <span className="page-header__badge">{totalOwned} {skinCategory === 'classic' ? 'classic' : 'normal'} owned</span>
      {usingCachedCatalog && <span className="page-header__badge page-header__badge--warning">Offline catalogue</span>}
      {totalShards > 0 && <span className="page-header__badge page-header__badge--success">◆ {totalShards} shards</span>}
      {ownedDelta !== null && ownedDelta !== 0 && <span className={`page-header__badge ${ownedDelta > 0 ? 'page-header__badge--success' : 'page-header__badge--danger'}`}>{ownedDelta > 0 ? '+' : ''}{ownedDelta} since refresh</span>}
    </>
  );
  const headerActions = (
    <>
      {lastUpdated && <span className="page-header__updated"><Clock3 /> {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
      <button type="button" onClick={() => void loadData()} disabled={loading} className="page-header__icon-action" title="Refresh skin collection" aria-label="Refresh skin collection">
        <RefreshCw className={loading ? 'animate-spin' : ''} />
      </button>
    </>
  );

  return (
    <div className="page-content page-content--skins skin-vault-page">
      <PageHeader
        variant="collection"
        icon={Sparkles}
        eyebrow="COSMETIC VAULT"
        title="Collection"
        description="Every skin on your account, and the ones still missing."
        meta={headerMeta}
        actions={headerActions}
      />

      <section className="skin-vault-summary" aria-label="Collection progress">
        <div className="skin-vault-summary__progress">
          <div><strong>{totalOwned}</strong><span>/ {categorySkins.length}</span></div>
          <div className="skin-vault-summary__bar"><span style={{ width: `${pct}%` }} /></div>
          <small>{skinCategory === 'classic' ? 'Classic collection' : 'Normal skins'} · {pct}% complete</small>
        </div>
        <div className="skin-vault-summary__stat"><strong>{missingCount}</strong><span>Still missing</span></div>
        <div className="skin-vault-summary__stat is-shard"><strong>◆ {totalShards}</strong><span>Shards ready</span></div>
        <div className="skin-vault-summary__stat"><strong>{championPct}%</strong><span>Champion coverage</span></div>
      </section>

      <div className={`skin-vault ${filtersOpen ? 'is-filters-open' : ''}`}>
        <button type="button" className="skin-vault__scrim" onClick={() => setFiltersOpen(false)} aria-label="Close filters" />
        <aside className="skin-vault-filters" aria-label="Collection filters">
          <div className="skin-vault-filters__title"><span><SlidersHorizontal /> Filters</span><button type="button" onClick={() => setFiltersOpen(false)} aria-label="Close filters"><X /></button></div>
          <label className="skin-vault-filters__search"><Search /><input type="text" name="skin-search" autoComplete="off" placeholder="Search a skin" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search skins and champions" /></label>
          <div className="skin-vault-filters__segments" role="group" aria-label="Ownership filter">{(['all', 'owned', 'missing'] as SkinStatusFilter[]).map((filter) => <button type="button" key={filter} onClick={() => chooseStatus(filter)} className={statusFilter === filter && !shardsOnly ? 'is-selected' : ''} aria-pressed={statusFilter === filter && !shardsOnly}>{filter === 'all' ? 'All' : filter[0].toUpperCase() + filter.slice(1)}</button>)}</div>

          <div className="skin-vault-filter-group"><span>Champion</span><label className="skin-vault-filter-group__select"><select value={selectedChampId ?? ''} onChange={(event) => setSelectedChampId(event.target.value ? Number(event.target.value) : null)}><option value="">Every champion</option>{[...categoryChamps].sort((a, b) => a.name.localeCompare(b.name)).map((champ) => <option key={champ.id} value={champ.id}>{champ.name}</option>)}</select><ChevronDown /></label></div>

          <div className="skin-vault-filter-group"><span>Collection</span>{(['normal', 'classic'] as SkinCategory[]).map((category) => { const skins = category === 'classic' ? classicSkins : normalSkins; const owned = skins.filter((skin) => skin.owned).length; return <button type="button" key={category} className={`skin-vault-filter-row ${skinCategory === category ? 'is-selected' : ''}`} onClick={() => { setSkinCategory(category); setSelectedChampId(null); }}><i /><strong>{category === 'classic' ? 'Classic champions' : 'Normal skins'}</strong><small>{owned}/{skins.length}</small></button>; })}</div>

          <div className="skin-vault-filter-group"><span>Focus</span><label className="skin-vault-filter-group__select"><select value={smartFilter} onChange={(event) => setSmartFilter(event.target.value as SmartFilter)}><option value="all">Every collection</option><option value="near-complete">Near complete</option><option value="missing-one">Missing one skin</option><option value="rarest">Rare skins</option><option value="shard-candidates">Shard candidates</option></select><ChevronDown /></label></div>

          <div className="skin-vault-filter-group"><span>Tier</span><button type="button" className={`skin-vault-filter-row ${tierFilter === 'all' ? 'is-selected' : ''}`} onClick={() => setTierFilter('all')}><i /><strong>Every tier</strong><small>{totalOwned}/{categorySkins.length}</small></button>{tierOptions.map(([tier, info]) => { const skins = categorySkins.filter((skin) => skin.rarity === tier); return <button type="button" key={tier} className={`skin-vault-filter-row ${tierFilter === tier ? 'is-selected' : ''}`} onClick={() => setTierFilter(tierFilter === tier ? 'all' : tier)}><i style={{ '--tier-color': info.color } as React.CSSProperties} /><strong>{info.label}</strong><small>{skins.filter((skin) => skin.owned).length}/{skins.length}</small></button>; })}</div>

          <div className="skin-vault-filter-group"><span>Availability</span><button type="button" className={`skin-vault-filter-row ${statusFilter === 'available' ? 'is-selected' : ''}`} onClick={() => toggleStatus('available')}><i /><strong>Available</strong><small>{categorySkins.length - totalUnavailable}</small></button><button type="button" className={`skin-vault-filter-row ${statusFilter === 'unavailable' ? 'is-selected' : ''}`} onClick={() => toggleStatus('unavailable')}><i /><strong>Legacy / unavailable</strong><small>{totalUnavailable}</small></button><button type="button" className={`skin-vault-filter-row ${statusFilter === 'shard' || shardsOnly ? 'is-selected' : ''}`} onClick={() => toggleStatus('shard')}><Gem /><strong>Shard available</strong><small>{totalShards}</small></button><button type="button" className={`skin-vault-filter-row ${statusFilter === 'rental' ? 'is-selected' : ''}`} onClick={() => toggleStatus('rental')}><i /><strong>Rental</strong><small>{totalRentals}</small></button><button type="button" className={`skin-vault-filter-row ${statusFilter === 'wishlist' ? 'is-selected' : ''}`} onClick={() => toggleStatus('wishlist')}><Bookmark /><strong>Wishlist</strong><small>{wishlist.size}</small></button><button type="button" className={`skin-vault-filter-row ${favsOnly ? 'is-selected' : ''}`} onClick={() => setFavsOnly((value) => !value)}><Heart className={favsOnly ? 'fill-current' : ''} /><strong>Favorites</strong><small>{favs.size}</small></button></div>

          {activeFilterCount > 0 && <button type="button" className="skin-vault-filters__clear" onClick={clearFilters}><RotateCcw /> Clear {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}</button>}
        </aside>

        <main className="skin-vault-results">
          <div className="skin-vault-toolbar"><div><strong>{visibleSkins.length}</strong><span> skins · {filteredChamps.length} champions</span></div><button type="button" className="skin-vault-toolbar__mobile-filter" onClick={() => setFiltersOpen(true)}><SlidersHorizontal /> Filters {activeFilterCount > 0 && <b>{activeFilterCount}</b>}</button><label><span>Group</span><select value="champion" disabled><option value="champion">Champion</option></select><ChevronDown /></label><label><span>Champions</span><select value={championSort} onChange={(event) => setChampionSort(event.target.value as typeof championSort)}><option value="completion">Most complete</option><option value="owned">Most owned</option><option value="total">Most skins</option><option value="name">Name A–Z</option></select><ChevronDown /></label><label><span>Sort</span><select value={skinSort} onChange={(event) => setSkinSort(event.target.value as SkinSort)}><option value="rarity">Highest tier</option><option value="name">Name A–Z</option></select><ChevronDown /></label><label><span>Size</span><select value={density} onChange={(event) => setDensity(event.target.value as SkinDensity)}><option value="comfortable">Auto</option><option value="compact">Compact</option></select><ChevronDown /></label><div className="skin-vault-toolbar__view"><button type="button" className={viewMode === 'grid' ? 'is-selected' : ''} onClick={() => setViewMode('grid')} aria-label="Grid view"><LayoutGrid /></button><button type="button" className={viewMode === 'list' ? 'is-selected' : ''} onClick={() => setViewMode('list')} aria-label="List view"><List /></button></div></div>

      {/* Legacy control markup remains hidden as a compatibility fallback for
          saved layouts while the new explorer owns the visible interaction. */}
      <div className="skin-explorer__legacy">
      {/* Filter Toolbar */}
      <div className="page-toolbar page-toolbar--skins flex items-center gap-2 flex-wrap">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-dim" />
          <input
            type="text"
            placeholder="Search champion or skin..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-xs rounded-xl"
          />
        </div>

        <label className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-black uppercase tracking-wider text-text-dim">Sort</span>
          <select
            value={championSort}
            onChange={(e) => setChampionSort(e.target.value as typeof championSort)}
            aria-label="Sort champion collection"
            className="px-2.5 py-2 rounded-xl text-xs font-bold"
          >
            <option value="completion">Most complete</option>
            <option value="owned">Most owned</option>
            <option value="total">Largest collection</option>
            <option value="name">Name A–Z</option>
          </select>
        </label>

        <label className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-black uppercase tracking-wider text-text-dim">Status</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as SkinStatusFilter)}
            aria-label="Filter skins by ownership status"
            className="px-2.5 py-2 rounded-xl text-xs font-bold"
          >
            <option value="all">All skins</option>
            <option value="owned">Owned</option>
            <option value="missing">Missing</option>
            <option value="shard">Shard available</option>
            <option value="rental">Rental</option>
            <option value="wishlist">Wishlist</option>
            <option value="unavailable">Legacy / unavailable</option>
          </select>
        </label>

        <label className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-black uppercase tracking-wider text-text-dim">Smart view</span>
          <select
            value={smartFilter}
            onChange={(e) => setSmartFilter(e.target.value as SmartFilter)}
            aria-label="Choose a smart collection view"
            className="px-2.5 py-2 rounded-xl text-xs font-bold"
          >
            <option value="all">Everything</option>
            <option value="near-complete">Near complete</option>
            <option value="missing-one">Missing one skin</option>
            <option value="rarest">Rare skins</option>
            <option value="shard-candidates">Shard candidates</option>
          </select>
        </label>

        <div className="flex gap-1 shrink-0">
          {['all', 'legendary', 'epic', 'mythic', 'ultimate'].map((t) => (
            <button
              key={t}
              onClick={() => setTierFilter(t)}
              className={`px-2.5 py-1.5 rounded-xl text-xs font-bold transition capitalize border cursor-pointer ${
                tierFilter === t
                  ? 'bg-primary/20 text-primary border-primary/40 shadow-[0_0_12px_rgba(200,170,110,0.25)]'
                  : 'text-text-dim border-white/[0.06] hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Shards Only Toggle */}
        <button
          onClick={() => setShardsOnly(!shardsOnly)}
          className={`px-3 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 border cursor-pointer ${
            shardsOnly
              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-[0_0_12px_rgba(46,204,113,0.25)]'
              : 'text-text-dim border-white/[0.06] hover:text-white'
          }`}
        >
          <Gem className="w-3.5 h-3.5 text-emerald-400" />
          <span>◆ Shards ({totalShards})</span>
        </button>

        {/* Favorites Toggle */}
        <button
          onClick={() => setFavsOnly(!favsOnly)}
          className={`px-3 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 border cursor-pointer ${
            favsOnly
              ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
              : 'text-text-dim border-white/[0.06] hover:text-white'
          }`}
        >
          <Heart className={`w-3.5 h-3.5 ${favsOnly ? 'fill-rose-400' : ''}`} />
          <span>Favorites ({favs.size})</span>
        </button>

        <div className="flex items-center gap-1 p-1 rounded-xl border border-white/[0.06] bg-white/[0.02] shrink-0" aria-label="Skin card layout">
          <button
            type="button"
            onClick={() => setViewMode('grid')}
            className={`p-1.5 rounded-lg cursor-pointer ${viewMode === 'grid' ? 'bg-primary/20 text-primary' : 'text-text-dim hover:text-white'}`}
            title="Grid view"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode('list')}
            className={`p-1.5 rounded-lg cursor-pointer ${viewMode === 'list' ? 'bg-primary/20 text-primary' : 'text-text-dim hover:text-white'}`}
            title="List view"
          >
            <List className="w-3.5 h-3.5" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setDensity(density === 'comfortable' ? 'compact' : 'comfortable')}
          className="px-2.5 py-2 rounded-xl text-xs font-bold text-text-dim border border-white/[0.06] hover:text-white cursor-pointer"
          title="Toggle compact cards"
        >
          {density === 'comfortable' ? 'Compact' : 'Comfortable'}
        </button>
      </div>
      </div>

      {loading && <div className="skin-vault-state"><Loader2 className="animate-spin" /><strong>Loading your collection</strong><span>Reading skins and ownership from League Client…</span></div>}
      {error && !loading && <div className="skin-vault-state is-error"><Shield /><strong>Collection unavailable</strong><span>{error}</span><button type="button" onClick={() => void loadData()}>Retry connection</button></div>}
      {!loading && !error && displayedChamps.length === 0 && <div className="skin-vault-state"><Sparkles /><strong>No skins match these filters</strong><span>Clear a filter or search for another champion.</span>{activeFilterCount > 0 && <button type="button" onClick={clearFilters}>Clear filters</button>}</div>}

      {!loading && !error && displayedChamps.map((champ) => {
        const skins = visibleSkinsByChampion.get(champ.id) || [];
        const shownOwned = skins.filter((skin) => skin.owned).length;
        const completion = champ.total ? Math.round((champ.owned / champ.total) * 100) : 0;
        return (
          <section className="skin-vault-group" key={champ.id}>
            <header className="skin-vault-group__header">
              <img src={`/lol-game-data/assets/v1/champion-icons/${champ.id}.png`} alt="" width="32" height="32" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
              <strong>{champ.name}</strong>
              <span>{shownOwned} owned shown · {champ.owned}/{champ.total} total</span>
              {champ.shards > 0 && <em>◆ {champ.shards} shard{champ.shards === 1 ? '' : 's'}</em>}
              <div><span style={{ width: `${completion}%` }} /></div>
            </header>
            <div className={`skin-vault-cards is-${viewMode} is-${density}`}>
              {skins.map((skin) => {
                const isFav = isSkinFavorite(favs, skin);
                const isWishlisted = wishlist.has(skinKey(skin));
                const tier = TIER_MAP[skin.rarity] || TIER_MAP.standard;
                const status = skin.owned ? 'Owned' : skin.rental ? 'Rental' : skin.shard ? 'Shard ready' : skin.unavailable ? 'Legacy' : 'Missing';
                const assetChampion = skin.assetChampionId || skin.championId;
                return (
                  <article
                    key={skin.id}
                    className={`skin-vault-card ${skin.owned ? 'is-owned' : skin.rental ? 'is-rental' : skin.shard ? 'is-shard' : 'is-missing'} ${skin.unavailable ? 'is-unavailable' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Preview ${skin.name}, ${status}`}
                    onClick={() => setPreviewSkin(skin)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPreviewSkin(skin); } }}
                  >
                    <img
                      className="skin-vault-card__art"
                      src={`/lol-game-data/assets/v1/champion-tiles/${assetChampion}/${skin.id}.jpg`}
                      alt={skin.name}
                      width="320"
                      height="180"
                      loading="lazy"
                      onError={(event) => {
                        const image = event.currentTarget;
                        const stage = image.dataset.fallbackStage || 'tile';
                        if (stage === 'tile') {
                          image.dataset.fallbackStage = 'splash';
                          image.src = `/lol-game-data/assets/v1/champion-splashes/${assetChampion}/${skin.id}.jpg`;
                        } else if (stage === 'splash') {
                          image.dataset.fallbackStage = 'ddragon';
                          image.src = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${skin.championName.replace(/[^a-zA-Z0-9]/g, '')}_${skin.skinNum}.jpg`;
                        } else {
                          image.classList.add('is-missing');
                        }
                      }}
                    />
                    <div className="skin-vault-card__wash" />
                    <div className="skin-vault-card__tools">
                      <button type="button" className={isWishlisted ? 'is-selected' : ''} onClick={(event) => { event.stopPropagation(); toggleWishlist(skin); }} aria-label={isWishlisted ? `Remove ${skin.name} from wishlist` : `Add ${skin.name} to wishlist`}><Bookmark className={isWishlisted ? 'fill-current' : ''} /></button>
                      <button type="button" className={isFav ? 'is-favorite' : ''} onClick={(event) => { event.stopPropagation(); toggleFav(skin); }} aria-label={isFav ? `Remove ${skin.name} from favorites` : `Add ${skin.name} to favorites`}><Heart className={isFav ? 'fill-current' : ''} /></button>
                    </div>
                    <div className="skin-vault-card__copy">
                      <div><span style={{ '--tier-color': tier.color } as React.CSSProperties}><i />{tier.label}</span><em className={`is-${status.toLowerCase().replaceAll(' ', '-')}`}>{status}</em></div>
                      <strong>{skin.name}</strong>
                      <small>{skin.chromaCount > 0 ? `${skin.chromaCount} chroma${skin.chromaCount === 1 ? '' : 's'}` : skin.isLegacy ? 'Legacy cosmetic' : 'League cosmetic'}</small>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
      {!loading && !error && displayedChamps.length < sortedChamps.length && <div className="incremental-actions"><button type="button" className="skin-vault-results__more" onClick={() => setChampionLimit((limit) => Math.min(limit + 12, sortedChamps.length))}>Load {Math.min(12, sortedChamps.length - displayedChamps.length)} more champions <span>{sortedChamps.length - displayedChamps.length} remaining</span></button><button type="button" className="skin-vault-results__more" onClick={() => setChampionLimit(sortedChamps.length)}>Load all {sortedChamps.length} champions</button></div>}

      {/* The previous drawer renderer stays unreachable for one migration
          release so existing persisted view settings remain harmless. */}
      {showLegacyDrawer && <>
      {!loading && !error && (
        <div className="skin-results-summary">
          <span><strong>{filteredChamps.length}</strong> champions · <strong>{visibleSkins.length}</strong> skins in this view</span>
          <span>{wishlist.size} wishlisted · {favs.size} favorites</span>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="glass-card p-8 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <span className="text-xs text-text-muted font-semibold">Loading skin collection from local LCU...</span>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="glass-card p-6 flex flex-col items-center justify-center gap-2 text-center">
          <Shield className="w-8 h-8 text-text-dim/40" />
          <p className="text-xs text-text-muted font-bold">{error}</p>
          <button
            onClick={() => void loadData()}
            className="text-xs text-primary font-bold hover:underline mt-1 cursor-pointer"
          >
            Retry Connection
          </button>
        </div>
      )}

      {/* Champion Cards Grid with Inline Row-Expanded Skin Drawer */}
      {!loading && !error && (
        <div className="space-y-3">
          {champRows.length === 0 ? (
            <div className="glass-card p-8 text-center text-text-dim space-y-1">
              <Sparkles className="w-8 h-8 opacity-20 mx-auto" />
              <p className="text-xs font-bold text-text-muted">No champions match your filter criteria</p>
            </div>
          ) : (
            <>
            {champRows.map((row, rIdx) => {
              const containsSelected = row.some((c) => c.id === selectedChampId);

              return (
                <div key={rIdx} className="space-y-3">
                  {/* Row of 4 Champion Cards */}
                  <div className="skin-champion-grid grid grid-cols-4 gap-2.5">
                    {row.map((c) => {
                      const isSelected = selectedChampId === c.id;
                      const iconUrl = `/lol-game-data/assets/v1/champion-icons/${c.id}.png`;
                      const completion = c.total > 0 ? Math.round((c.owned / c.total) * 100) : 0;
                      const missing = Math.max(0, c.total - c.owned);

                      return (
                        <div
                          key={c.id}
                          onClick={() => setSelectedChampId(isSelected ? null : c.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedChampId(isSelected ? null : c.id);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          aria-expanded={isSelected}
                          aria-label={`${c.name}, ${completion}% complete`}
                          className={`skin-champion-card glass-card p-2.5 rounded-xl border transition flex items-center justify-between cursor-pointer ${
                            isSelected
                              ? 'bg-primary/20 border-primary shadow-[0_0_15px_rgba(200,170,110,0.3)]'
                              : 'hover:bg-white/[0.05] border-white/[0.06]'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <img
                              src={iconUrl}
                              alt={c.name}
                              width="32"
                              height="32"
                              loading="lazy"
                              className="w-8 h-8 rounded-lg border border-white/10 object-cover shrink-0"
                              onError={(e: any) => { e.target.style.display = 'none'; }}
                            />
                            <div className="min-w-0">
                              <p className="text-xs font-black text-white truncate">{c.name}</p>
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-text-muted font-bold">{c.owned} / {c.total} Skins</span>
                                {c.shards > 0 && (
                                  <span className="text-[9px] text-emerald-400 font-extrabold">◆ {c.shards}</span>
                                )}
                              </div>
                              <div className="skin-champion-card__progress" aria-hidden="true"><span style={{ width: `${completion}%` }} /></div>
                              <span className="skin-champion-card__hint">{completion === 100 ? 'Complete' : `${missing} missing`}</span>
                            </div>
                          </div>
                          <ChevronRight className={`w-4 h-4 text-text-dim shrink-0 transition-transform ${isSelected ? 'rotate-90 text-primary' : ''}`} />
                        </div>
                      );
                    })}
                  </div>

                  {/* Expanded Skin Drawer directly underneath the clicked row */}
                  {containsSelected && selectedChampId != null && (
                    <div className="glass-card p-4 rounded-2xl border border-primary/40 space-y-3 animate-fadeIn my-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-black text-white">
                            {categoryChamps.find((c) => c.id === selectedChampId)?.name} Skins
                          </h3>
                          <span className="text-xs text-primary font-bold">
                            ({visibleSkins.filter((s) => s.championId === selectedChampId && s.owned).length} shown · {categorySkins.filter((s) => s.championId === selectedChampId && s.owned).length} / {categorySkins.filter((s) => s.championId === selectedChampId).length})
                          </span>
                        </div>
                        <button
                          onClick={() => setSelectedChampId(null)}
                          className="p-1 rounded-lg hover:bg-white/10 text-text-dim hover:text-white cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Champion Skins List Grid */}
                      {visibleSkins.filter((s) => s.championId === selectedChampId).length === 0 && (
                        <div className="rounded-xl border border-dashed border-white/[0.1] p-6 text-center">
                          <p className="text-xs font-bold text-text-muted">No skins match the active filters.</p>
                          <p className="text-[10px] text-text-dim mt-1">Try switching Status, Smart view, or Year back to Everything.</p>
                        </div>
                      )}
                      <div className={viewMode === 'list' ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-2 sm:grid-cols-3 gap-3'}>
                        {visibleSkins
                          .filter((s) => s.championId === selectedChampId)
                          .map((skin) => {
                            const isFav = isSkinFavorite(favs, skin);
                            const isWishlisted = wishlist.has(skinKey(skin));
                            const tierInfo = TIER_MAP[skin.rarity] || TIER_MAP.standard;
                            const splashUrl = `/lol-game-data/assets/v1/champion-splashes/${skin.assetChampionId || skin.championId}/${skin.id}.jpg`;
                            const statusLabel = skin.owned ? 'Owned' : skin.rental ? 'Rental' : skin.shard ? 'Shard' : 'Missing';
                            const statusClass = skin.owned
                              ? 'text-emerald-300 bg-emerald-500/20 border-emerald-500/40'
                              : skin.rental
                              ? 'text-sky-300 bg-sky-500/20 border-sky-500/40'
                              : skin.shard
                              ? 'text-amber-300 bg-amber-500/20 border-amber-500/40'
                              : skin.unavailable
                              ? 'text-amber-300 bg-amber-500/15 border-amber-500/40'
                              : 'text-text-muted bg-black/50 border-white/10';

                            return (
                              <div
                                key={skin.id}
                                onClick={() => setPreviewSkin(skin)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    setPreviewSkin(skin);
                                  }
                                }}
                                role="button"
                                tabIndex={0}
                                aria-label={`Preview ${skin.name}`}
                                className={`skin-skin-card ${density === 'compact' ? 'is-compact' : ''} glass-card overflow-hidden rounded-xl border relative ${viewMode === 'list' ? 'h-24' : density === 'compact' ? 'h-32' : 'h-44'} flex flex-col justify-end p-2.5 group cursor-pointer transition ${
                                  skin.owned
                                    ? 'border-white/10 hover:border-primary/40'
                                    : skin.rental
                                    ? 'border-sky-500/50 bg-sky-950/20'
                                    : skin.shard
                                    ? 'border-emerald-500/50 bg-emerald-950/20'
                                    : skin.unavailable
                                    ? 'opacity-60 grayscale border-amber-500/30'
                                    : 'opacity-40 grayscale border-white/5'
                                }`}
                              >
                                <img
                                  src={splashUrl}
                                  alt={skin.name}
                                  width="320"
                                  height="180"
                                  loading="lazy"
                                  className="skin-skin-card__art absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                                  onError={(e: any) => {
                                    const image = e.currentTarget as HTMLImageElement;
                                    if (image.dataset.fallbackApplied) {
                                      image.classList.add('is-missing');
                                      return;
                                    }
                                    image.dataset.fallbackApplied = 'true';
                                    image.src = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${skin.championName.replace(/[^a-zA-Z0-9]/g, '')}_${skin.skinNum}.jpg`;
                                  }}
                                />
                                <div className="skin-skin-card__wash absolute inset-0" />

                                {/* Favorite button */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleFav(skin);
                                  }}
                                  className="absolute top-2 right-2 z-20 p-1.5 rounded-lg bg-black/50 hover:bg-black/80 text-white cursor-pointer"
                                >
                                  <Heart className={`w-3.5 h-3.5 ${isFav ? 'fill-rose-400 text-rose-400' : ''}`} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleWishlist(skin);
                                  }}
                                  className="absolute top-2 left-2 z-20 p-1.5 rounded-lg bg-black/50 hover:bg-black/80 text-white cursor-pointer"
                                  title={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
                                >
                                  <Bookmark className={`w-3.5 h-3.5 ${isWishlisted ? 'fill-amber-300 text-amber-300' : ''}`} />
                                </button>

                                <div className="relative z-10 space-y-0.5">
                                  <div className="flex items-center gap-1">
                                    <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-black/60 text-amber-300 border border-amber-400/20">
                                      {tierInfo.label}
                                    </span>
                                    <span className={`text-[9px] font-black px-2 py-0.5 rounded-full border ${statusClass}`}>
                                      {statusLabel}
                                    </span>
                                    {skin.shard && (
                                      <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                                        ◆ Shard
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs font-black text-white truncate">{skin.name}</p>
                                  <p className="text-[9px] text-text-muted font-bold truncate">
                                    {skin.chromaCount > 0 ? `${skin.chromaCount} chroma${skin.chromaCount === 1 ? '' : 's'}` : 'League cosmetic'}{skin.isLegacy ? ' · Legacy' : ''}
                                  </p>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {displayedChamps.length < sortedChamps.length && (
              <div className="incremental-actions"><button
                type="button"
                onClick={() => setChampionLimit((limit) => Math.min(limit + 48, sortedChamps.length))}
                className="w-full py-2 rounded-xl text-xs font-black text-primary border border-primary/30 bg-primary/10 hover:bg-primary/20 transition cursor-pointer"
              >
                Load more champions ({sortedChamps.length - displayedChamps.length} remaining)
              </button><button type="button" onClick={() => setChampionLimit(sortedChamps.length)} className="w-full py-2 rounded-xl text-xs font-black text-primary border border-primary/30 bg-primary/10 hover:bg-primary/20 transition cursor-pointer">Load all champions</button></div>
            )}
            </>
          )}
        </div>
      )}

      </>}
        </main>
      </div>

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
              src={`/lol-game-data/assets/v1/champion-splashes/${previewSkin.assetChampionId || previewSkin.championId}/${previewSkin.id}.jpg`}
              alt={previewSkin.name}
              width="1280"
              height="720"
              className="w-full h-96 object-cover rounded-xl border border-white/10"
              onError={(e: any) => {
                e.target.src = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${previewSkin.championName.replace(/[^a-zA-Z0-9]/g, '')}_${previewSkin.skinNum || 0}.jpg`;
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
