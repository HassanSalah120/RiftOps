import { useState, useEffect, useCallback } from 'react';
import { fetchLCUSkins, fetchLCULoot } from '../api';
import { Sparkles, Loader2, RefreshCw, Search, Shield, Heart, X, ChevronRight, Gem } from 'lucide-react';

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

export default function SkinShowcase() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allSkins, setAllSkins] = useState<any[]>([]);
  const [allChamps, setAllChamps] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [shardsOnly, setShardsOnly] = useState(false);
  const [selectedChampId, setSelectedChampId] = useState<number | null>(null);
  const [favsOnly, setFavsOnly] = useState(false);
  const [previewSkin, setPreviewSkin] = useState<any | null>(null);
  const [favs, setFavs] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('riftops-skin-favs');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const toggleFav = (compositeId: string) => {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(compositeId)) next.delete(compositeId);
      else next.add(compositeId);
      localStorage.setItem('riftops-skin-favs', JSON.stringify([...next]));
      return next;
    });
  };

  const loadData = useCallback(async () => {
    setLoading(true);
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
        dbArray.forEach((s: any) => skinDbMap.set(s.id, s));
      }

      const champNames = new Map();
      if (Array.isArray(champsSummary)) {
        champsSummary.forEach((c: any) => champNames.set(c.id, c.name || c.alias || `#${c.id}`));
      }

      const toArray = (v: any) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
      const ownedArr = toArray(ownedRaw);

      const parsedSkins: any[] = [];
      const champTotals = new Map<number, { id: number; name: string; total: number; owned: number; shards: number }>();

      ownedArr.forEach((s: any) => {
        const cId = s.championId;
        if (cId == null) return;
        const skinNum = s.id % 1000;
        if (skinNum === 0) return; // skip base skin

        const isOwned = !!(s.ownership?.owned || s.ownership?.isOwned || s.owned || s.isOwned);
        const hasShard = !isOwned && shardSkinIds.has(s.id);
        const dbEntry = skinDbMap.get(s.id) || {};
        const cName = champNames.get(cId) || dbEntry.championName || `Champion ${cId}`;
        const rawRarity = (dbEntry.rarity || s.rarity || '').replace(/^k/i, '').toLowerCase();

        const skinObj = {
          id: s.id,
          championId: cId,
          championName: cName,
          skinNum,
          name: s.name || dbEntry.name || `Skin #${skinNum}`,
          owned: isOwned,
          shard: hasShard,
          rarity: rawRarity || 'standard',
        };

        parsedSkins.push(skinObj);

        if (!champTotals.has(cId)) {
          champTotals.set(cId, { id: cId, name: cName, total: 0, owned: 0, shards: 0 });
        }
        const ct = champTotals.get(cId)!;
        ct.total++;
        if (isOwned) ct.owned++;
        if (hasShard) ct.shards++;
      });

      setAllSkins(parsedSkins);
      setAllChamps(Array.from(champTotals.values()));
    } catch (err: any) {
      setError(err.message || 'Failed to load skin collection — launch League first.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Derived statistics
  const ownedSkinsList = allSkins.filter((s) => s.owned);
  const totalOwned = ownedSkinsList.length;
  const totalShards = allSkins.filter((s) => s.shard).length;
  const champsWithOwned = allChamps.filter((c) => c.owned > 0).length;
  const pct = allChamps.length ? Math.round((champsWithOwned / allChamps.length) * 100) : 0;

  // Filtered champions grid
  const filteredChamps = allChamps.filter((c) => {
    if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (tierFilter !== 'all') {
      const champSkins = allSkins.filter((s) => s.championId === c.id);
      if (!champSkins.some((s) => s.rarity.includes(tierFilter))) return false;
    }
    if (favsOnly) {
      const champSkinIds = allSkins.filter((s) => s.championId === c.id).map((s) => `${s.championId}_${s.skinNum}`);
      if (!champSkinIds.some((id) => favs.has(id))) return false;
    }
    if (shardsOnly && c.shards === 0) return false;
    return true;
  });

  // Group champions into rows of 4 for inline drawer expansion
  const champRows: any[][] = [];
  for (let i = 0; i < filteredChamps.length; i += 4) {
    champRows.push(filteredChamps.slice(i, i + 4));
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h2 className="text-base font-black text-white">Skin Showcase</h2>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
            {totalOwned} Skins Owned
          </span>
          {totalShards > 0 && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              ◆ {totalShards} Shards
            </span>
          )}
        </div>
        <button
          onClick={() => void loadData()}
          disabled={loading}
          className="p-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-text-muted hover:text-white transition cursor-pointer border border-white/[0.06]"
          title="Refresh Skins"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Top Stats Banner */}
      <div className="glass-card p-4 space-y-3">
        <div className="grid grid-cols-5 gap-3 text-center">
          <div>
            <p className="text-lg font-black text-white">{totalOwned}</p>
            <p className="text-[10px] text-text-muted font-bold">Total Skins</p>
          </div>
          <div>
            <p className="text-lg font-black text-white">{champsWithOwned}</p>
            <p className="text-[10px] text-text-muted font-bold">Champions</p>
          </div>
          <div>
            <p className="text-lg font-black text-primary">{pct}%</p>
            <p className="text-[10px] text-text-muted font-bold">Collection</p>
          </div>
          <div>
            <p className="text-lg font-black text-emerald-400">◆ {totalShards}</p>
            <p className="text-[10px] text-emerald-400/80 font-bold">Shards</p>
          </div>
          <div>
            <p className="text-lg font-black text-amber-400">{allSkins.length}</p>
            <p className="text-[10px] text-text-muted font-bold">Available</p>
          </div>
        </div>

        {/* Collection Bar */}
        <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>

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

      {/* Filter Toolbar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-dim" />
          <input
            type="text"
            placeholder="Search champion name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-xs rounded-xl"
          />
        </div>

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
      </div>

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
            champRows.map((row, rIdx) => {
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
                            {allChamps.find((c) => c.id === selectedChampId)?.name} Skins
                          </h3>
                          <span className="text-xs text-primary font-bold">
                            ({allSkins.filter((s) => s.championId === selectedChampId && s.owned).length} / {allSkins.filter((s) => s.championId === selectedChampId).length})
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
                      <div className="grid grid-cols-3 gap-3">
                        {allSkins
                          .filter((s) => s.championId === selectedChampId)
                          .map((skin) => {
                            const compositeId = `${skin.championId}_${skin.skinNum}`;
                            const isFav = favs.has(compositeId);
                            const tierInfo = TIER_MAP[skin.rarity] || TIER_MAP.standard;
                            const tileUrl = `/lol-game-data/assets/v1/champion-tiles/${skin.championId}/${skin.id}.jpg`;

                            return (
                              <div
                                key={skin.id}
                                onClick={() => setPreviewSkin(skin)}
                                className={`glass-card overflow-hidden rounded-xl border relative h-36 flex flex-col justify-end p-2.5 group cursor-pointer transition ${
                                  skin.owned
                                    ? 'border-white/10 hover:border-primary/40'
                                    : skin.shard
                                    ? 'border-emerald-500/50 bg-emerald-950/20'
                                    : 'opacity-40 grayscale border-white/5'
                                }`}
                              >
                                <img
                                  src={tileUrl}
                                  alt={skin.name}
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
                                    toggleFav(compositeId);
                                  }}
                                  className="absolute top-2 right-2 z-20 p-1.5 rounded-lg bg-black/50 hover:bg-black/80 text-white cursor-pointer"
                                >
                                  <Heart className={`w-3.5 h-3.5 ${isFav ? 'fill-rose-400 text-rose-400' : ''}`} />
                                </button>

                                <div className="relative z-10 space-y-0.5">
                                  <div className="flex items-center gap-1">
                                    <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-black/60 text-amber-300 border border-amber-400/20">
                                      {tierInfo.label}
                                    </span>
                                    {skin.shard && (
                                      <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                                        ◆ Shard
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs font-black text-white truncate">{skin.name}</p>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Fullsplash Modal Preview */}
      {previewSkin && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-6 animate-fadeIn">
          <div className="relative max-w-3xl w-full bg-base rounded-2xl border border-primary/30 overflow-hidden shadow-2xl space-y-4 p-4">
            <button
              onClick={() => setPreviewSkin(null)}
              className="absolute top-3 right-3 p-2 rounded-xl bg-black/60 text-white hover:bg-black/90 transition z-20 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <img
              src={`/lol-game-data/assets/v1/champion-splashes/${previewSkin.championId}/${previewSkin.id}.jpg`}
              alt={previewSkin.name}
              className="w-full h-96 object-cover rounded-xl border border-white/10"
              onError={(e: any) => {
                e.target.src = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${previewSkin.championName.replace(/[^a-zA-Z0-9]/g, '')}_${previewSkin.skinNum || 0}.jpg`;
              }}
            />

            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-black text-white">{previewSkin.name}</h3>
                <p className="text-xs text-text-muted font-bold">{previewSkin.championName} · Skin #{previewSkin.skinNum}</p>
              </div>
              <button
                onClick={() => toggleFav(`${previewSkin.championId}_${previewSkin.skinNum}`)}
                className="px-4 py-2 rounded-xl bg-rose-500/20 text-rose-300 border border-rose-500/40 font-bold text-xs flex items-center gap-2 cursor-pointer"
              >
                <Heart className={`w-4 h-4 ${favs.has(`${previewSkin.championId}_${previewSkin.skinNum}`) ? 'fill-rose-400' : ''}`} />
                <span>{favs.has(`${previewSkin.championId}_${previewSkin.skinNum}`) ? 'Favorited' : 'Add Favorite'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
