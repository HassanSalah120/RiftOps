import { useCallback, useEffect, useState } from 'react';
import { Gift, Gem, Sparkles, Swords, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { fetchLCULoot } from '../api';

interface SkinShard {
  lootId: string;
  name: string;       // from itemDesc
  count: number;
  rarity: string;     // UPPERCASE from LCU: EPIC, LEGENDARY, etc.
  oeUpgrade: number;  // upgradeEssenceValue
  oeDisenchant: number; // disenchantValue
  skinPrice: number;  // value (skin price in RP terms)
  championId: number; // parentStoreItemId
}

interface ChampShard {
  lootId: string;
  name: string;
  count: number;
  beDisenchant: number;
}

interface CurrencyTotals {
  orangeEssence: number;
  blueEssence: number;
  rp: number;
  mythicEssence: number;
  hextechKeys: number;
  hextechKeyFragments: number;
  chests: number;
  eventTokens: number;
  clashTickets: number;
}

// Map LCU rarity (UPPERCASE) to our rarity tiers
function rarityTier(rarity: string): string {
  const r = (rarity || '').toUpperCase();
  if (r.includes('LEGENDARY')) return 'legendary';
  if (r.includes('EPIC')) return 'epic';
  if (r.includes('RARE')) return 'rare';
  if (r.includes('MYTHIC')) return 'mythic';
  return 'standard';
}

export default function LootDashboard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [skinShards, setSkinShards] = useState<SkinShard[]>([]);
  const [champShards, setChampShards] = useState<ChampShard[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyTotals>({ orangeEssence: 0, blueEssence: 0, rp: 0, mythicEssence: 0, hextechKeys: 0, hextechKeyFragments: 0, chests: 0, eventTokens: 0, clashTickets: 0 });
  const [showAllSkins, setShowAllSkins] = useState(false);
  const [showAllChamps, setShowAllChamps] = useState(false);
  const [rarityFilter, setRarityFilter] = useState<string>('all');
  const [rawLoot, setRawLoot] = useState<any[]>([]);
  const [rawSkinsDb, setRawSkinsDb] = useState<any>(null);
  const [rawChampsSummary, setRawChampsSummary] = useState<any>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugTab, setDebugTab] = useState<'loot' | 'currencies' | 'skins' | 'champs'>('loot');

  const loadLoot = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [raw, skinsDb, champsSummary] = await Promise.all([
        fetchLCULoot().catch(() => []),
        fetch('/lol-game-data/assets/v1/skins.json').then((r) => r.json()).catch(() => ({})),
        fetch('/lol-game-data/assets/v1/champion-summary.json').then((r) => r.json()).catch(() => []),
      ]);

      // Build lookup maps
      const champNameMap = new Map<number, string>();
      if (Array.isArray(champsSummary)) {
        champsSummary.forEach((c: any) => champNameMap.set(c.id, c.name || c.alias || `#${c.id}`));
      }

      // Store raw data for debug
      setRawLoot(Array.isArray(raw) ? raw : []);
      setRawSkinsDb(skinsDb);
      setRawChampsSummary(champsSummary);

      const items: any[] = Array.isArray(raw) ? raw : [];
      const skins: SkinShard[] = [];
      const champs: ChampShard[] = [];

      // Currency amounts from the same loot endpoint
      const curr: CurrencyTotals = { orangeEssence: 0, blueEssence: 0, rp: 0, hextechKeys: 0, hextechKeyFragments: 0, chests: 0, eventTokens: 0, mythicEssence: 0, clashTickets: 0 };

      items.forEach((item: any) => {
        const id: string = item.lootId || '';
        const name: string = item.itemDesc || item.localizedName || item.name || '';
        const count = Number(item.count) || 1;

        // ── Currencies (type === "CURRENCY") ──
        if (item.type === 'CURRENCY') {
          if (id === 'CURRENCY_cosmetic') curr.orangeEssence += count;
          else if (id === 'CURRENCY_champion') curr.blueEssence += count;
          else if (id === 'CURRENCY_RP') curr.rp += count;
          else if (id === 'CURRENCY_mythic') curr.mythicEssence += count;
          else if (id.includes('key_fragment') || id.includes('keyfragment')) curr.hextechKeyFragments += count;
          else if (id.includes('token') || id.includes('event')) curr.eventTokens += count;
          return;
        }

        // ── Materials (keys, clash tickets, etc.) ──
        if (item.type === 'MATERIAL') {
          if (id === 'MATERIAL_key') curr.hextechKeys += count;
          else if (id === 'MATERIAL_clashtickets') curr.clashTickets += count;
          else if (id.includes('chest')) curr.chests += count;
          return;
        }

        // ── Skin shards ──
        if (item.type === 'SKIN_RENTAL' || item.displayCategories === 'SKIN') {
          const championId = Number(item.parentStoreItemId) || 0;
          const champName = championId ? (champNameMap.get(championId) || '') : '';
          // Show as "Champion — Skin Name" or just the skin name
          const displayName = name
            ? (champName ? `${champName} — ${name}` : name)
            : `Skin #${id}`;
          skins.push({
            lootId: id,
            name: displayName,
            count,
            rarity: rarityTier(item.rarity || ''),
            oeUpgrade: Number(item.upgradeEssenceValue) || 0,
            oeDisenchant: Number(item.disenchantValue) || 0,
            skinPrice: Number(item.value) || 0,
            championId,
          });
          return;
        }

        // ── Champion shards ──
        if (item.type === 'CHAMPION' || item.type === 'CHAMPION_RENTAL' || item.displayCategories === 'CHAMPION') {
          const championId = Number(item.parentStoreItemId) || parseInt(id.replace(/^CHAMPION_SHARD_|^CHAMPION_RENTAL_/, ''), 10) || 0;
          const champName = championId ? (champNameMap.get(championId) || name) : name;
          champs.push({
            lootId: id,
            name: champName || `Champion #${championId || '?'}`,
            count,
            beDisenchant: Number(item.disenchantValue) || 0,
          });
          return;
        }

        // ── Catch-all: anything with displayCategories SKIN or CHAMPION ──
        if (item.displayCategories === 'SKIN') {
          skins.push({
            lootId: id,
            name: name || id,
            count,
            rarity: rarityTier(item.rarity || ''),
            oeUpgrade: Number(item.upgradeEssenceValue) || 0,
            oeDisenchant: Number(item.disenchantValue) || 0,
            skinPrice: Number(item.value) || 0,
            championId: Number(item.parentStoreItemId) || 0,
          });
        } else if (item.displayCategories === 'CHAMPION') {
          champs.push({
            lootId: id,
            name: name || id,
            count,
            beDisenchant: Number(item.disenchantValue) || 0,
          });
        }
      });

      setSkinShards(skins.sort((a, b) => b.oeUpgrade - a.oeUpgrade));
      setChampShards(champs.sort((a, b) => b.count - a.count));
      setCurrencies(curr);
    } catch {
      setError('Could not load loot data. Make sure the League client is running.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadLoot(); }, [loadLoot]);

  const rarities = [...new Set(skinShards.map((s) => s.rarity))].sort();
  const filteredSkins = rarityFilter === 'all' ? skinShards : skinShards.filter((s) => s.rarity === rarityFilter);
  const visibleSkins = showAllSkins ? filteredSkins : filteredSkins.slice(0, 12);
  const visibleChamps = showAllChamps ? champShards : champShards.slice(0, 12);

  const totalOEValue = skinShards.reduce((sum, s) => sum + s.oeDisenchant * s.count, 0);
  const canUpgrade = skinShards.filter((s) => s.oeUpgrade > 0 && s.oeUpgrade <= currencies.orangeEssence);
  const totalSkinShards = skinShards.reduce((sum, s) => sum + s.count, 0);
  const totalChampShards = champShards.reduce((sum, s) => sum + s.count, 0);

  // Unique loot types for debug
  const lootTypes = [...new Set(rawLoot.map((i: any) => i.type || i.displayCategories || 'unknown'))];
  const lootIds = [...new Set(rawLoot.map((i: any) => i.lootId?.split('_').slice(0, 3).join('_') || '?'))];

  return (
    <div className="qol-page">
      <header className="qol-hero">
        <div className="qol-hero__glow" />
        <div className="qol-hero__content">
          <div>
            <p className="qol-eyebrow">LOOT & COLLECTION</p>
            <h1>Your hextech inventory</h1>
            <p>Skin shards, champion shards, currencies, and upgrade costs at a glance.</p>
          </div>
          <div className="qol-hero__status">
            <button type="button" onClick={() => void loadLoot()} disabled={loading} className="qol-refresh">
              <RefreshCw className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      {error && <div className="qol-offline-banner"><Gift /><div><strong>{error}</strong></div></div>}

      {!loading && !error && (
        <>
          {/* Currency summary */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 20 }}>
            {currencies.orangeEssence > 0 && <CurrencyCard icon={<Gem />} label="Orange essence" value={currencies.orangeEssence} color="#e8956a" />}
            {currencies.blueEssence > 0 && <CurrencyCard icon={<Swords />} label="Blue essence" value={currencies.blueEssence} color="#5b8ad4" />}
            {currencies.rp > 0 && <CurrencyCard icon={<Sparkles />} label="RP" value={currencies.rp} color="#c8aa6e" />}
            {currencies.mythicEssence > 0 && <CurrencyCard icon={<Gem />} label="Mythic essence" value={currencies.mythicEssence} color="#a855f7" />}
            {currencies.hextechKeys > 0 && <CurrencyCard icon={<Sparkles />} label="Hextech keys" value={currencies.hextechKeys} color="#c8aa6e" />}
            {currencies.hextechKeyFragments > 0 && <CurrencyCard icon={<Gift />} label="Key fragments" value={currencies.hextechKeyFragments} color="#9b7dd4" />}
            {currencies.chests > 0 && <CurrencyCard icon={<Gift />} label="Hextech chests" value={currencies.chests} color="#c8aa6e" />}
            {currencies.eventTokens > 0 && <CurrencyCard icon={<Sparkles />} label="Event tokens" value={currencies.eventTokens} color="#10b981" />}
            {currencies.clashTickets > 0 && <CurrencyCard icon={<Swords />} label="Clash tickets" value={currencies.clashTickets} color="#f59e0b" />}
            {currencies.orangeEssence === 0 && currencies.blueEssence === 0 && currencies.hextechKeys === 0 && currencies.rp === 0 && (
              <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 12, fontSize: 11, color: '#6a6a88', background: 'rgba(255,255,255,0.025)', borderRadius: 8 }}>
                No currencies found. Check the debug tab to see if the currencies endpoint returned data.
              </div>
            )}
          </div>

          {/* Stats bar */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20, fontSize: 11, color: '#a0a0b8' }}>
            <span>{totalSkinShards} skin shard{totalSkinShards !== 1 ? 's' : ''}</span>
            <span>{totalChampShards} champion shard{totalChampShards !== 1 ? 's' : ''}</span>
            <span>{canUpgrade.length} upgradeable now</span>
            <span>{totalOEValue.toLocaleString()} OE disenchant total</span>
          </div>

          {/* Skin shards */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#d4d4d0' }}>Skin shards</h3>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => setRarityFilter('all')}
                  style={{ fontSize: 9, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', background: rarityFilter === 'all' ? 'rgba(200,170,110,0.25)' : 'rgba(255,255,255,0.05)', color: rarityFilter === 'all' ? '#c8aa6e' : '#6a6a88' }}
                >
                  All ({totalSkinShards})
                </button>
                {rarities.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRarityFilter(r)}
                    style={{ fontSize: 9, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', background: rarityFilter === r ? 'rgba(200,170,110,0.25)' : 'rgba(255,255,255,0.05)', color: rarityFilter === r ? '#c8aa6e' : '#6a6a88' }}
                  >
                    {r} ({skinShards.filter((s) => s.rarity === r).length})
                  </button>
                ))}
              </div>
            </div>
            {visibleSkins.length === 0 ? (
              <p style={{ fontSize: 11, color: '#6a6a88' }}>No skin shards found.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
                {visibleSkins.map((skin) => (
                  <div key={skin.lootId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.035)' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: '#d4d4d0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{skin.name}</div>
                      <div style={{ fontSize: 9, color: '#6a6a88', display: 'flex', gap: 6 }}>
                        <span>{skin.rarity}</span>
                        {skin.count > 1 && <span>×{skin.count}</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, marginLeft: 8 }}>
                      {skin.oeUpgrade > 0 && (
                        <span style={{ fontSize: 9, color: skin.oeUpgrade <= currencies.orangeEssence ? '#10b981' : '#6a6a88' }}>
                          {skin.oeUpgrade} upgrade
                        </span>
                      )}
                      {skin.oeDisenchant > 0 && (
                        <span style={{ fontSize: 9, color: '#e8956a' }}>
                          {skin.oeDisenchant} disenchant
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {filteredSkins.length > 12 && (
              <button
                type="button"
                onClick={() => setShowAllSkins(!showAllSkins)}
                style={{ marginTop: 8, fontSize: 10, color: '#c8aa6e', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                {showAllSkins ? <><ChevronUp /> Show less</> : <><ChevronDown /> Show all {filteredSkins.length} shards</>}
              </button>
            )}
          </div>

          {/* Champion shards */}
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: '#d4d4d0' }}>Champion shards</h3>
            {visibleChamps.length === 0 ? (
              <p style={{ fontSize: 11, color: '#6a6a88' }}>No champion shards found.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
                {visibleChamps.map((champ) => (
                  <div key={champ.lootId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.035)' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: '#d4d4d0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{champ.name}</div>
                      <div style={{ fontSize: 9, color: '#6a6a88' }}>×{champ.count}</div>
                    </div>
                    {champ.beDisenchant > 0 && (
                      <div style={{ fontSize: 10, color: '#5b8ad4', whiteSpace: 'nowrap', marginLeft: 8 }}>
                        {champ.beDisenchant.toLocaleString()} BE
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {champShards.length > 12 && (
              <button
                type="button"
                onClick={() => setShowAllChamps(!showAllChamps)}
                style={{ marginTop: 8, fontSize: 10, color: '#c8aa6e', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                {showAllChamps ? <><ChevronUp /> Show less</> : <><ChevronDown /> Show all {champShards.length} shards</>}
              </button>
            )}
          </div>

          {/* OE upgrade calculator */}
          {skinShards.length > 0 && (
            <div style={{ padding: 12, borderRadius: 8, background: 'rgba(232,149,106,0.08)', border: '1px solid rgba(232,149,106,0.15)' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: '#e8956a' }}>Upgrade calculator</h3>
              <div style={{ fontSize: 11, color: '#a0a0b8', lineHeight: 1.6 }}>
                <div>You have <strong style={{ color: '#e8956a' }}>{currencies.orangeEssence.toLocaleString()}</strong> orange essence</div>
                <div>Can upgrade <strong style={{ color: '#10b981' }}>{canUpgrade.length}</strong> of {totalSkinShards} shards now</div>
                <div>Total disenchant value: <strong>{totalOEValue.toLocaleString()}</strong> OE</div>
                {canUpgrade.length > 0 && (
                  <div style={{ marginTop: 4, color: '#10b981' }}>
                    Upgrading all affordable: {canUpgrade.reduce((s, sh) => s + sh.oeUpgrade * sh.count, 0).toLocaleString()} OE spent
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: 40, color: '#6a6a88', fontSize: 12 }}>
          <RefreshCw className="animate-spin" style={{ marginBottom: 8 }} />
          Loading loot data...
        </div>
      )}

      {/* Debug panel */}
      {!loading && (
        <div style={{ marginTop: 24 }}>
          <button
            type="button"
            onClick={() => setDebugOpen(!debugOpen)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', color: '#6a6a88', fontSize: 10 }}
          >
            {debugOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            Debug — raw API responses ({rawLoot.length} loot items, types: {lootTypes.join(', ')})
          </button>
          {debugOpen && (
            <div style={{ marginTop: 8, background: 'rgba(0,0,0,0.4)', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {(['loot', 'currencies', 'skins', 'champs'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setDebugTab(tab)}
                    style={{ flex: 1, padding: '6px 0', fontSize: 10, border: 'none', cursor: 'pointer', background: debugTab === tab ? 'rgba(200,170,110,0.15)' : 'transparent', color: debugTab === tab ? '#c8aa6e' : '#6a6a88', borderBottom: debugTab === tab ? '1px solid #c8aa6e' : '1px solid transparent' }}
                  >
                    {tab === 'loot' ? `Loot (${rawLoot.length})` : tab === 'currencies' ? 'Currencies' : tab === 'skins' ? 'Skins DB' : 'Champs Summary'}
                  </button>
                ))}
              </div>
              <div style={{ maxHeight: 400, overflow: 'auto', padding: 10 }}>
                {debugTab === 'loot' && (
                  <>
                    <div style={{ fontSize: 9, color: '#6a6a88', marginBottom: 6 }}>
                      Loot item types found: {lootTypes.join(', ')} | ID prefixes: {lootIds.join(', ')}
                    </div>
                    <div style={{ fontSize: 9, color: '#6a6a88', marginBottom: 6 }}>
                      Each item has: itemDesc (name), upgradeEssenceValue, disenchantValue, type, displayCategories, parentStoreItemId
                    </div>
                    <pre style={{ fontSize: 9, color: '#a0a0b8', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
                      {JSON.stringify(rawLoot.slice(0, 5), null, 2)}
                      {rawLoot.length > 5 && `\n\n... and ${rawLoot.length - 5} more items`}
                    </pre>
                  </>
                )}
                {debugTab === 'currencies' && (
                  <>
                    <div style={{ fontSize: 9, color: '#6a6a88', marginBottom: 6 }}>
                      Currencies from /lol-loot/v1/player-loot (type=CURRENCY):
                    </div>
                    <pre style={{ fontSize: 9, color: '#a0a0b8', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
                      {JSON.stringify(rawLoot.filter((i: any) => i.type === 'CURRENCY' || i.type === 'MATERIAL'), null, 2) || '(none found)'}
                    </pre>
                  </>
                )}
                {debugTab === 'skins' && (
                  <>
                    <div style={{ fontSize: 9, color: '#6a6a88', marginBottom: 6 }}>
                      {rawSkinsDb ? `Skins database: ${Array.isArray(rawSkinsDb) ? rawSkinsDb.length : Object.keys(rawSkinsDb).length} entries` : 'Not loaded'}
                    </div>
                    <pre style={{ fontSize: 9, color: '#a0a0b8', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
                      {JSON.stringify(rawSkinsDb, null, 2)?.slice(0, 15000)}
                      {JSON.stringify(rawSkinsDb, null, 2)?.length > 15000 && '\n... (truncated)'}
                    </pre>
                  </>
                )}
                {debugTab === 'champs' && (
                  <>
                    <div style={{ fontSize: 9, color: '#6a6a88', marginBottom: 6 }}>
                      {Array.isArray(rawChampsSummary) ? `Champion summary: ${rawChampsSummary.length} champions` : 'Not loaded'}
                    </div>
                    <pre style={{ fontSize: 9, color: '#a0a0b8', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
                      {JSON.stringify(rawChampsSummary, null, 2)?.slice(0, 15000)}
                      {JSON.stringify(rawChampsSummary, null, 2)?.length > 15000 && '\n... (truncated)'}
                    </pre>
                  </>
                )}
              </div>
              <div style={{ padding: '6px 10px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 9, color: '#6a6a88' }}>
                  {debugTab === 'loot' ? `Types: ${lootTypes.map(t => `${t}=${rawLoot.filter(i => (i.type || i.displayCategories) === t).length}`).join(', ')}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => { const d = debugTab === 'loot' ? rawLoot : debugTab === 'currencies' ? rawLoot.filter((i: any) => i.type === 'CURRENCY' || i.type === 'MATERIAL') : debugTab === 'skins' ? rawSkinsDb : rawChampsSummary; navigator.clipboard.writeText(JSON.stringify(d, null, 2)); }}
                  style={{ fontSize: 9, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', background: 'rgba(200,170,110,0.2)', color: '#c8aa6e' }}
                >
                  Copy JSON
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CurrencyCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(255,255,255,0.035)', display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ color, opacity: 0.8 }}>{icon}</div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#d4d4d0' }}>{value.toLocaleString()}</div>
        <div style={{ fontSize: 9, color: '#6a6a88' }}>{label}</div>
      </div>
    </div>
  );
}
