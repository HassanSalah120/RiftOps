import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, Gem, Hammer, Loader2, PackageOpen, RefreshCw, XCircle } from 'lucide-react';
import { craftLCULootRecipe, fetchLCULoot, fetchLCULootRecipes, fetchLCUWallet } from '../api';
import { recipeActionLabel } from '../lootActions';
import type { ConfirmAction } from '../types';
import ConfirmModal from './ConfirmModal';
import { ActionFeedback, ContextPanel, EmptyState, type FeedbackState, StatusBadge, WorkspaceSection } from './DesignPrimitives';
import PageHeader from './PageHeader';
import { useLCUConnection } from './lcuConnectionContext';

type LootItem = {
  lootId: string;
  itemDesc?: string;
  localizedName?: string;
  count?: number;
  type?: string;
  rarity?: string;
  asset?: string;
  upgradeEssenceValue?: number;
};

type Recipe = {
  recipeName?: string;
  name?: string;
  contextMenuText?: string;
  type?: string;
  outputs?: unknown[];
};

type ActivityEntry = { id: string; name: string; delta: number; time: string };

const RESOURCE_DEFS = [
  { key: 'blue', label: 'Blue essence', match: (id: string) => id === 'CURRENCY_champion', fallback: 'BE', color: '#4ba5d8', icon: '/lol-game-data/assets/ASSETS/Currencies/images/blue-essence-icon.svg' },
  { key: 'orange', label: 'Orange essence', match: (id: string) => id === 'CURRENCY_cosmetic', fallback: 'OE', color: '#e69a68', icon: '/lol-game-data/assets/ASSETS/Currencies/images/orange-essence-icon.png' },
  { key: 'rp', label: 'Riot Points', match: (id: string) => id === 'CURRENCY_RP', fallback: 'RP', color: '#d8be76', icon: '/lol-game-data/assets/ASSETS/Currencies/images/riot-points-icon.svg' },
  { key: 'mythic', label: 'Mythic essence', match: (id: string) => id === 'CURRENCY_mythic', fallback: 'ME', color: '#b58bf1', icon: '/lol-game-data/assets/ASSETS/Currencies/images/mythic-essence-icon.svg' },
  { key: 'keys', label: 'Hextech keys', match: (id: string) => id === 'MATERIAL_key', fallback: 'KEY', color: '#d5b768', icon: '' },
  { key: 'tokens', label: 'Event tokens', match: (id: string) => /token|event/i.test(id), fallback: 'EV', color: '#57cbb0', icon: '' },
] as const;

function itemName(item: LootItem): string {
  return String(item.itemDesc || item.localizedName || item.lootId || 'League loot');
}


function GameAsset({ item, fallback, icon }: { item?: LootItem; fallback: string; icon?: string }) {
  const candidates = [icon || '', item?.asset || '', item ? `/lol-game-data/assets/v1/loot/${encodeURIComponent(item.lootId)}.png` : ''].filter(Boolean);
  const [index, setIndex] = useState(0);
  if (!candidates[index]) return <span className="loot-resource__fallback">{fallback}</span>;
  return <img src={candidates[index]} alt="" width="52" height="52" loading="lazy" onError={() => setIndex((current) => current + 1)} />;
}

export default function LootDashboard() {
  const { connected } = useLCUConnection();
  const [loot, setLoot] = useState<LootItem[]>([]);
  const [wallet, setWallet] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [selectedLootId, setSelectedLootId] = useState('');
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipesLoading, setRecipesLoading] = useState(false);
  const [crafting, setCrafting] = useState('');
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const loadLoot = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [body, walletBody] = await Promise.all([fetchLCULoot(), fetchLCUWallet().catch(() => ({}))]);
      const items = (Array.isArray(body) ? body : []) as LootItem[];
      setLoot(items);
      setWallet(walletBody);
      const nextCounts = Object.fromEntries(items.map((item) => [item.lootId, Number(item.count) || 0]));
      try {
        const previous = JSON.parse(localStorage.getItem('riftops.loot.snapshot') || '{}') as Record<string, number>;
        const changes = items.map((item) => ({ id: item.lootId, name: itemName(item), delta: (Number(item.count) || 0) - (previous[item.lootId] || 0), time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })).filter((entry) => Object.keys(previous).length > 0 && entry.delta !== 0).slice(0, 8);
        if (changes.length) setActivity((current) => [...changes, ...current].slice(0, 8));
        localStorage.setItem('riftops.loot.snapshot', JSON.stringify(nextCounts));
      } catch { /* Local inventory history is optional. */ }
    } catch (reason: any) {
      setError(reason?.message || 'Loot inventory is unavailable. Launch League and try again.');
      setLoot([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadLoot(); }, [loadLoot]);

  useEffect(() => {
    if (!selectedLootId) { setRecipes([]); setFeedback(null); return; }
    setRecipesLoading(true);
    setFeedback({ tone: 'working', message: 'Reading live recipes from League…' });
    fetchLCULootRecipes(selectedLootId)
      .then((next) => {
        setRecipes(next);
        setFeedback(next.length ? { tone: 'info', message: `${next.length} League recipe${next.length === 1 ? '' : 's'} available for this material.` } : { tone: 'info', message: 'League does not expose a recipe for this material right now.' });
      })
      .catch((reason) => { setRecipes([]); setFeedback({ tone: 'error', message: reason?.message || 'Recipes are unavailable for this item.' }); })
      .finally(() => setRecipesLoading(false));
  }, [selectedLootId]);

  const resources = RESOURCE_DEFS.map((definition) => {
    const items = loot.filter((item) => definition.match(item.lootId || ''));
    const inventoryValue = items.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    const walletValue = definition.key === 'blue' ? wallet.ip ?? wallet.blueEssence ?? wallet.blue_essence : definition.key === 'rp' ? wallet.rp ?? wallet.RP : undefined;
    return { ...definition, item: items[0], value: typeof walletValue === 'number' ? walletValue : inventoryValue };
  });
  const craftableItems = useMemo(() => loot.filter((item) => (Number(item.count) || 0) > 0 && item.type !== 'CURRENCY').sort((a, b) => itemName(a).localeCompare(itemName(b))), [loot]);
  const selectedItem = craftableItems.find((item) => item.lootId === selectedLootId);
  const orange = resources.find((resource) => resource.key === 'orange')?.value || 0;
  const affordableUpgrades = loot.filter((item) => Number(item.upgradeEssenceValue) > 0 && Number(item.upgradeEssenceValue) <= orange).length;

  const runCraft = async (recipe: Recipe) => {
    if (!recipe.recipeName) return;
    setCrafting(recipe.recipeName);
    setFeedback({ tone: 'working', message: 'League is crafting the selected recipe…' });
    try {
      await craftLCULootRecipe(recipe.recipeName, [selectedLootId], 1);
      setFeedback({ tone: 'success', message: 'Craft complete. The wallet and inventory are refreshed.' });
      await loadLoot();
      setRecipes(await fetchLCULootRecipes(selectedLootId));
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'League rejected the crafting action.' });
    } finally {
      setCrafting('');
    }
  };

  return (
    <div className="loot-workshop">
      {confirmAction && <ConfirmModal action={confirmAction} onClose={() => setConfirmAction(null)} />}
      <PageHeader variant="workspace" icon={Gem} eyebrow="HEXTECH INVENTORY" title="Loot workshop" description="Inspect live balances, choose one material, and complete its recipe in the same context." meta={<StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>{connected ? 'Live inventory' : 'League offline'}</StatusBadge>} actions={<button type="button" className="page-header__button" onClick={() => void loadLoot()} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : ''} />Refresh inventory</button>} />

      {error && <EmptyState tone="error" icon={XCircle} title="Inventory unavailable" description={error} action={<button type="button" className="btn-secondary" onClick={() => void loadLoot()}><RefreshCw />Retry</button>} />}

      {!error && <>
        <WorkspaceSection eyebrow="RESOURCE WALLET" title="Spendable balances" description={`${craftableItems.length} materials with possible recipes · ${affordableUpgrades} affordable upgrades`} className="loot-wallet">
          <div className="loot-wallet__grid">{resources.map((resource) => <article className="loot-resource" key={resource.key} style={{ '--resource-color': resource.color } as React.CSSProperties}><div className="loot-resource__icon"><GameAsset item={resource.item} fallback={resource.fallback} icon={resource.icon} /></div><div><strong>{loading ? '—' : resource.value.toLocaleString()}</strong><span>{resource.label}</span></div></article>)}</div>
        </WorkspaceSection>

        <div className="loot-workshop__flow">
          <WorkspaceSection eyebrow="SELECT" title="Choose a material" description="RiftOps asks League for the exact recipes attached to your selection." className="loot-forge">
            {loading ? <ActionFeedback state={{ tone: 'working', message: 'Loading inventory materials…' }} /> : craftableItems.length === 0 ? <EmptyState icon={PackageOpen} title="No craftable materials" description="Loot shards, tokens, and capsules will appear here when League reports them." /> : <div className="loot-material-list">{craftableItems.map((item) => {
              const selected = item.lootId === selectedLootId;
              return <button type="button" key={item.lootId} className={selected ? 'is-selected' : ''} onClick={() => setSelectedLootId(item.lootId)} aria-pressed={selected}><span><GameAsset item={item} fallback="LOOT" /></span><div><strong>{itemName(item)}</strong><small>{item.rarity || item.type || 'League material'}</small></div><b>×{Number(item.count) || 0}</b></button>;
            })}</div>}
          </WorkspaceSection>

          <ContextPanel eyebrow="RECIPE INSPECTOR" title={selectedItem ? itemName(selectedItem) : 'Select a material'} description={selectedItem ? 'Available actions come directly from the signed-in League Client.' : 'Choose one inventory material to inspect its current recipes.'} footer={<ActionFeedback state={feedback} />}>
            {!selectedItem && <EmptyState icon={Hammer} title="Nothing selected" description="Pick a material from the list to keep selection, result, and follow-up actions together." />}
            {selectedItem && recipesLoading && <ActionFeedback state={{ tone: 'working', message: 'Reading live recipes…' }} />}
            {selectedItem && !recipesLoading && recipes.length === 0 && <EmptyState icon={Gem} title="No recipe available" description="This material cannot be crafted through the current League inventory state." />}
            {recipes.map((recipe, index) => {
              const label = recipe.contextMenuText || recipe.name || recipe.type || recipe.recipeName || `Recipe ${index + 1}`;
              const actionLabel = recipeActionLabel(recipe);
              return <article className="loot-recipe" key={recipe.recipeName || `${label}-${index}`}><div><strong>{label}</strong><span>{recipe.type || 'League crafting recipe'} · {(recipe.outputs || []).length || 1} output</span></div><button type="button" disabled={!recipe.recipeName || crafting !== ''} onClick={() => setConfirmAction({ open: true, title: `${actionLabel} ${label}?`, message: 'League will consume the recipe inputs immediately. This inventory action cannot be undone.', actionLabel: `${actionLabel} item`, danger: false, onConfirm: () => { setConfirmAction(null); void runCraft(recipe); } })}>{crafting === recipe.recipeName ? <Loader2 className="animate-spin" /> : <Hammer />}{actionLabel}</button></article>;
            })}
          </ContextPanel>
        </div>

        <WorkspaceSection eyebrow="LOCAL LEDGER" title="Recent inventory changes" description="Changes detected between refreshes on this device." className="loot-activity">
          {activity.length === 0 ? <EmptyState icon={Clock3} title="No changes recorded" description="Refresh after a craft or reward to record the difference here." /> : <div className="loot-activity__list">{activity.map((entry, index) => <div key={`${entry.id}-${entry.time}-${index}`}><span className={entry.delta > 0 ? 'is-positive' : 'is-negative'}>{entry.delta > 0 ? '+' : ''}{entry.delta}</span><strong>{entry.name}</strong><time>{entry.time}</time></div>)}</div>}
        </WorkspaceSection>
      </>}
    </div>
  );
}
