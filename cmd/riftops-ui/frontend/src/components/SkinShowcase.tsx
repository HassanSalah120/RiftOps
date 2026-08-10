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
  Gem,
  LayoutGrid,
  List,
  Copy,
  Bookmark,
  BarChart3,
  Clock3,
  Check,
} from 'lucide-react';

const TIER_MAP: Record<string, { label: string; color: string; rank: number }> = {
  ultimate: { label: 'Ultimate', color: '#e9c46a', rank: 5 },
  mythic: { label: 'Mythic', color: '#e76f51', rank: 4 },
  legendary: { label: 'Legendary', color: '#c89b3c', rank: 3 },
  epic: { label: 'Epic', color: '#9b59b6', rank: 2 },
  standard: { label: 'Standard', color: '#6b6556', rank: 1 },
};

const MILESTONES = [
  { count: 50, label: 'Collector', icon: '★' },
  { count: 100, label: 'Enthusiast', icon: '★★' },
  { count: 200, label: 'Connoisseur', icon: '★★★' },
  { count: 350, label: 'Curator', icon: '◆' },
  { count: 500, label: 'Mythic', icon: '◆◆' },
  { count: 750, label: 'Legend', icon: '◆◆◆' },
  { count: 1000, label: 'Transcendent', icon: '✦' },
];

type SkinCategory = 'normal' | 'classic';
type SkinView = 'grid' | 'list';
type SkinDensity = 'comfortable' | 'compact';
type SkinStatusFilter = 'all' | 'owned' | 'missing' | 'shard' | 'rental' | 'wishlist' | 'unavailable';
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

export default function SkinShowcase() {
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
  const [releaseYear, setReleaseYear] = useState(() => readPreference('riftops-skin-year', 'all'));
  const [viewMode, setViewMode] = useState<SkinView>(() => readPreference('riftops-skin-view', 'grid'));
  const [density, setDensity] = useState<SkinDensity>(() => readPreference('riftops-skin-density', 'comfortable'));
  const [previewSkin, setPreviewSkin] = useState<any | null>(null);
  const [copyStatus, setCopyStatus] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [ownedDelta, setOwnedDelta] = useState<number | null>(null);
  const [usingCachedCatalog, setUsingCachedCatalog] = useState(false);
  const [championLimit, setChampionLimit] = useState(48);
  const previousOwnedRef = useRef<number | null>(null);
  const warmedFromCacheRef = useRef(false);
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
    localStorage.setItem('riftops-skin-year', JSON.stringify(releaseYear));
    localStorage.setItem('riftops-skin-view', JSON.stringify(viewMode));
    localStorage.setItem('riftops-skin-density', JSON.stringify(density));
  }, [search, tierFilter, championSort, skinCategory, shardsOnly, favsOnly, statusFilter, smartFilter, releaseYear, viewMode, density]);

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
        fetchLCULoot().catch(() => []),
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
        const releaseYearValue = dbEntry.releaseYear ?? dbEntry.yearReleased ?? s.releaseYear ?? s.yearReleased;
        const parsedReleaseYear = Number(releaseYearValue);
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
          releaseYear: Number.isFinite(parsedReleaseYear) && parsedReleaseYear > 0 ? parsedReleaseYear : null,
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
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!previewSkin) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewSkin(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [previewSkin]);

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
  const normalPct = normalSkins.length ? Math.round((normalSkins.filter((skin) => skin.owned).length / normalSkins.length) * 100) : 0;
  const classicPct = classicSkins.length ? Math.round((classicSkins.filter((skin) => skin.owned).length / classicSkins.length) * 100) : 0;
  const releaseYears = useMemo(
    () => Array.from(new Set(categorySkins.map((skin) => skin.releaseYear).filter(Boolean))).sort((a, b) => b - a),
    [categorySkins],
  );

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
      if (releaseYear !== 'all' && String(skin.releaseYear || '') !== releaseYear) return false;
      if (shardsOnly && !skin.shard) return false;
      if (favsOnly && !isSkinFavorite(favs, skin)) return false;
      if (statusFilter === 'owned' && !skin.owned) return false;
      if (statusFilter === 'missing' && (skin.owned || skin.rental || skin.shard)) return false;
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
  }, [categorySkins, champById, search, tierFilter, releaseYear, shardsOnly, favsOnly, favs, statusFilter, wishlist, smartFilter]);

  // Filtered champions grid. Cards retain full totals, while their drawer obeys
  // the active skin-level filters.
  const filteredChamps = categoryChamps.filter((champ) => visibleSkins.some((skin) => skin.championId === champ.id));

  const closestChampions = [...categoryChamps]
    .filter((champ) => champ.owned > 0 && champ.owned < champ.total)
    .sort((a, b) => (b.owned / b.total) - (a.owned / a.total) || (b.owned - a.owned))
    .slice(0, 3);

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

  // Group champions into rows of 4 for inline drawer expansion
  const champRows: any[][] = [];
  const displayedChamps = sortedChamps.slice(0, championLimit);
  for (let i = 0; i < displayedChamps.length; i += 4) {
    champRows.push(displayedChamps.slice(i, i + 4));
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h2 className="text-base font-black text-white">Skin Showcase</h2>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
            {totalOwned} {skinCategory === 'classic' ? 'Classic' : 'Normal'} Skins Owned
          </span>
          {ownedDelta !== null && ownedDelta !== 0 && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${ownedDelta > 0 ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' : 'text-rose-300 bg-rose-500/10 border-rose-500/20'}`}>
              {ownedDelta > 0 ? '+' : ''}{ownedDelta} since refresh
            </span>
          )}
          {usingCachedCatalog && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border text-amber-300 bg-amber-500/10 border-amber-500/20">
              Offline catalogue
            </span>
          )}
          {totalShards > 0 && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              ◆ {totalShards} Shards
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="hidden sm:flex items-center gap-1 text-[10px] text-text-dim font-bold">
              <Clock3 className="w-3 h-3" /> Updated {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={() => void loadData()}
            disabled={loading}
            className="p-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-text-muted hover:text-white transition cursor-pointer border border-white/[0.06]"
            title="Refresh Skins"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Top Stats Banner */}
      <div className="glass-card p-4 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 text-center">
          <div>
            <p className="text-lg font-black text-white">{totalOwned}</p>
            <p className="text-[10px] text-text-muted font-bold">Owned</p>
          </div>
          <div>
            <p className="text-lg font-black text-white">{champsWithOwned}</p>
            <p className="text-[10px] text-text-muted font-bold">Champions</p>
          </div>
          <div>
            <p className="text-lg font-black text-primary">{pct}%</p>
            <p className="text-[10px] text-text-muted font-bold">Skin completion</p>
          </div>
          <div>
            <p className="text-lg font-black text-emerald-400">◆ {totalShards}</p>
            <p className="text-[10px] text-emerald-400/80 font-bold">Shards</p>
          </div>
          <div>
            <p className="text-lg font-black text-amber-400">{categorySkins.length - totalUnavailable}</p>
            <p className="text-[10px] text-text-muted font-bold">Obtainable</p>
          </div>
          <div>
            <p className="text-lg font-black text-sky-300">{totalRentals}</p>
            <p className="text-[10px] text-text-muted font-bold">Rentals</p>
          </div>
          <div>
            <p className="text-lg font-black text-violet-300">{championPct}%</p>
            <p className="text-[10px] text-text-muted font-bold">Champion coverage</p>
          </div>
          <div>
            <p className="text-lg font-black text-rose-300">{totalUnavailable}</p>
            <p className="text-[10px] text-text-muted font-bold">Legacy / unavailable</p>
          </div>
        </div>

        {/* Collection Bar */}
        <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>

        {closestChampions.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto pt-1">
            <span className="text-[10px] font-bold text-text-dim uppercase shrink-0 flex items-center gap-1">
              <BarChart3 className="w-3 h-3" /> Closest to complete
            </span>
            {closestChampions.map((champ) => (
              <button
                key={champ.id}
                type="button"
                onClick={() => setSelectedChampId(champ.id)}
                className="shrink-0 px-2.5 py-1 rounded-xl text-[10px] font-extrabold bg-white/[0.03] border border-white/[0.06] text-text-muted hover:text-white hover:border-primary/40 transition cursor-pointer"
              >
                {champ.name} <span className="text-primary">{champ.owned}/{champ.total}</span>
              </button>
            ))}
          </div>
        )}

        {/* Milestones Row */}
        <div className="flex items-center gap-2 overflow-x-auto pt-1">
          <span className="text-[10px] font-bold text-text-dim uppercase shrink-0">Milestones:</span>
          {MILESTONES.map((m) => {
            const achieved = totalOwned >= m.count;
            return (
              <div
                key={m.label}
                className={`px-2.5 py-1 rounded-xl text-[10px] font-extrabold flex items-center gap-1 shrink-0 border ${
                  achieved
                    ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                    : 'bg-white/[0.02] text-text-dim border-white/[0.04]'
                }`}
              >
                <span>{m.icon}</span>
                <span>{m.label} ({m.count})</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Keep Riot's legacy Classic champion skins separate from regular skins. */}
      <div className="flex items-center gap-1 p-1 rounded-2xl bg-white/[0.03] border border-white/[0.06] w-fit">
        {(['normal', 'classic'] as SkinCategory[]).map((category) => {
          const count = category === 'classic' ? classicSkins.length : normalSkins.length;
          const active = skinCategory === category;
          return (
            <button
              key={category}
              type="button"
              onClick={() => {
                setSkinCategory(category);
                setSelectedChampId(null);
              }}
              className={`px-3 py-2 rounded-xl text-xs font-black transition capitalize border cursor-pointer ${
                active
                  ? 'bg-primary/20 text-primary border-primary/40 shadow-[0_0_12px_rgba(200,170,110,0.2)]'
                  : 'text-text-dim border-transparent hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              {category === 'classic' ? 'Classic champions' : 'Normal skins'}
              <span className="ml-1.5 text-[10px] opacity-70">{count} · {category === 'classic' ? classicPct : normalPct}%</span>
            </button>
          );
        })}
      </div>

      {/* Filter Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
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

        <label className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-black uppercase tracking-wider text-text-dim">Year</span>
          <select
            value={releaseYear}
            onChange={(e) => setReleaseYear(e.target.value)}
            aria-label="Filter skins by release year"
            className="px-2.5 py-2 rounded-xl text-xs font-bold"
          >
            <option value="all">Any year</option>
            {releaseYears.map((year) => <option key={year} value={String(year)}>{year}</option>)}
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
      {!loading && !error && (
        <div className="flex items-center justify-between text-[10px] text-text-dim font-bold px-1">
          <span>{filteredChamps.length} champions · {visibleSkins.length} skins match the current view</span>
          <span>{wishlist.size} wishlisted</span>
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
                  <div className="grid grid-cols-4 gap-2.5">
                    {row.map((c) => {
                      const isSelected = selectedChampId === c.id;
                      const iconUrl = `/lol-game-data/assets/v1/champion-icons/${c.id}.png`;

                      return (
                        <div
                          key={c.id}
                          onClick={() => setSelectedChampId(isSelected ? null : c.id)}
                          className={`glass-card p-2.5 rounded-xl border transition flex items-center justify-between cursor-pointer ${
                            isSelected
                              ? 'bg-primary/20 border-primary shadow-[0_0_15px_rgba(200,170,110,0.3)]'
                              : 'hover:bg-white/[0.05] border-white/[0.06]'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <img
                              src={iconUrl}
                              alt={c.name}
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
                            const tileUrl = `/lol-game-data/assets/v1/champion-tiles/${skin.assetChampionId || skin.championId}/${skin.id}.jpg`;
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
                                className={`glass-card overflow-hidden rounded-xl border relative ${viewMode === 'list' ? 'h-24' : density === 'compact' ? 'h-28' : 'h-36'} flex flex-col justify-end p-2.5 group cursor-pointer transition ${
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
                                  src={tileUrl}
                                  alt={skin.name}
                                  loading="lazy"
                                  className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                                  onError={(e: any) => {
                                    e.target.src = `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${skin.championName.replace(/[^a-zA-Z0-9]/g, '')}_${skin.skinNum}.jpg`;
                                  }}
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-base via-base/40 to-transparent" />

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
                                    {skin.releaseYear || 'Release unknown'}{skin.chromaCount > 0 ? ` · ${skin.chromaCount} chroma${skin.chromaCount === 1 ? '' : 's'}` : ''}{skin.isLegacy ? ' · Legacy' : ''}
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
              <button
                type="button"
                onClick={() => setChampionLimit((limit) => Math.min(limit + 48, sortedChamps.length))}
                className="w-full py-2 rounded-xl text-xs font-black text-primary border border-primary/30 bg-primary/10 hover:bg-primary/20 transition cursor-pointer"
              >
                Load more champions ({sortedChamps.length - displayedChamps.length} remaining)
              </button>
            )}
            </>
          )}
        </div>
      )}

      {/* Fullsplash Modal Preview */}
      {previewSkin && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-6 animate-fadeIn">
          <div className="relative max-w-5xl w-full max-h-[92vh] overflow-y-auto bg-base rounded-2xl border border-primary/30 shadow-2xl space-y-4 p-4">
            <button
              onClick={() => setPreviewSkin(null)}
              className="absolute top-3 right-3 p-2 rounded-xl bg-black/60 text-white hover:bg-black/90 transition z-20 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <img
              src={`/lol-game-data/assets/v1/champion-splashes/${previewSkin.assetChampionId || previewSkin.championId}/${previewSkin.id}.jpg`}
              alt={previewSkin.name}
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
                <p className="text-[9px] uppercase font-black tracking-wider text-text-dim">Release</p>
                <p className="text-xs font-black text-white mt-1">{previewSkin.releaseYear || 'Unknown'}</p>
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
