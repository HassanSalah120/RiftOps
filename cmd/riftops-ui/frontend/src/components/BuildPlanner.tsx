import { useEffect, useMemo, useState } from 'react';
import { Bookmark, Check, Search, Trash2 } from 'lucide-react';
import { normalizeBuildItems, type BuildItem, type BuildPlan } from '../buildPlanner';

const STORAGE_KEY = 'riftops.buildPlans';


function loadPlans(): Record<string, BuildPlan> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function planKey(championId: number, role: string): string {
  return `${championId}:${String(role || 'FILL').toUpperCase()}`;
}

export default function BuildPlanner({ championId, championName, fallbackChampionId, fallbackChampionName, role, onNotice }: {
  championId: number;
  championName: string;
  fallbackChampionId: number;
  fallbackChampionName: string;
  role: string;
  onNotice?: (message: string, type?: 'info' | 'success' | 'error') => void;
}) {
  const [items, setItems] = useState<BuildItem[]>([]);
  const [plans, setPlans] = useState<Record<string, BuildPlan>>(loadPlans);
  const [target, setTarget] = useState<'primary' | 'fallback'>('primary');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const targetId = target === 'primary' ? championId : fallbackChampionId;
  const targetName = target === 'primary' ? championName : fallbackChampionName;
  const key = planKey(targetId, role);

  useEffect(() => {
    let cancelled = false;
    void fetch('/lol-game-data/assets/v1/items.json', { cache: 'force-cache' }).then((response) => response.ok ? response.json() : []).then((raw) => {
      if (!cancelled) setItems(normalizeBuildItems(raw));
    }).catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setSelected(plans[key]?.itemIds || []);
  }, [key, plans]);

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    return items.filter((item) => item.name.toLowerCase().includes(term)).slice(0, 8);
  }, [items, query]);
  const selectedItems = selected.map((id) => items.find((item) => item.id === id) || { id, name: `Item ${id}` });

  const addItem = (id: number) => {
    if (selected.includes(id) || selected.length >= 6) return;
    setSelected((current) => [...current, id]);
    setQuery('');
  };
  const save = () => {
    if (!targetId || selected.length === 0) {
      onNotice?.('Choose a champion and at least one item before saving a build.', 'info');
      return;
    }
    const next = { ...plans, [key]: { championId: targetId, role: role || 'FILL', itemIds: selected, updatedAt: new Date().toISOString() } };
    setPlans(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Local planning is optional. */ }
    onNotice?.(`${targetName || 'Champion'} build saved for ${role || 'Fill'}.`, 'success');
  };

  return <section className="play-flow__build-planner" aria-labelledby="build-planner-title">
    <div className="play-flow__build-header"><div><span><Bookmark /> BUILD MEMORY</span><h4 id="build-planner-title">Fallback-safe item plans</h4><p>Keep a six-item reference for your primary and fallback pick. This is local planning; League item inventory is never mutated.</p></div><small>{selected.length}/6</small></div>
    <div className="play-flow__build-targets"><button type="button" className={target === 'primary' ? 'is-selected' : ''} onClick={() => setTarget('primary')} disabled={!championId}><span>PRIMARY</span><strong>{championName || 'Choose a pick'}</strong></button><button type="button" className={target === 'fallback' ? 'is-selected' : ''} onClick={() => setTarget('fallback')} disabled={!fallbackChampionId}><span>FALLBACK</span><strong>{fallbackChampionName || 'Choose a fallback'}</strong></button></div>
    <div className="play-flow__build-selected">{selectedItems.length ? selectedItems.map((item, index) => <button type="button" key={`${item.id}-${index}`} title="Remove item" onClick={() => setSelected((current) => current.filter((_, itemIndex) => itemIndex !== index))}><span>{index + 1}</span><strong>{item.name}</strong><Trash2 /></button>) : <p>No items saved for this pick yet.</p>}</div>
    <div className="play-flow__build-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search an item to add…" aria-label="Search build items" />{matches.length > 0 && <div className="play-flow__build-results">{matches.map((item) => <button type="button" key={item.id} onClick={() => addItem(item.id)} disabled={selected.includes(item.id) || selected.length >= 6}><span>{item.name}</span>{selected.includes(item.id) ? <Check /> : <small>{item.id}</small>}</button>)}</div>}</div>
    <div className="play-flow__build-footer"><span>{plans[key] ? `Saved ${new Date(plans[key].updatedAt).toLocaleDateString()}` : 'Not saved yet'}</span><button type="button" className="btn-secondary" onClick={save} disabled={!targetId || selected.length === 0}>Save item plan</button></div>
  </section>;
}
