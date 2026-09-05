import { Bot, Check, Loader2, PackagePlus, Plus, RotateCcw, Save, Swords, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { addLCUCustomBot, applyLobbyPreset, applyManagedItemSet, applyPreparationPreset, applyProfilePreset, deleteLobbyPreset, deletePreparationPreset, fetchItemSetSnapshots, fetchLCUBalanceCatalog, fetchLCUCustomBots, fetchLobbyPresets, fetchPreparationPresets, fetchProfilePresets, previewLobbyPreset, previewPreparationPreset, previewProfilePreset, rollbackManagedItemSet, saveLobbyPreset, savePreparationPreset, type BalanceCatalog, type ItemSetSnapshot, type LCUAvailableQueue, type LCURunePage, type LobbyPreset, type PreparationPreset, type ProfilePreset } from '../api';
import { ActionFeedback, WorkspaceSection, type FeedbackState } from './DesignPrimitives';

type Spell = { id: number; name: string };
type Props = { connected: boolean; remoteClient?: boolean; queueId: number; queue?: LCUAvailableQueue; firstRole: string; secondRole: string; championId: number; runePageId: number; fallbackRunePageId: number; runePages: LCURunePage[]; itemIds: number[]; onPreparationApplied?: (preset: PreparationPreset) => void; onToast: (message: string, type?: 'info' | 'success' | 'error') => void };

export default function PreparationPanel({ connected, remoteClient = false, queueId, queue, firstRole, secondRole, championId, runePageId, fallbackRunePageId, runePages, itemIds, onPreparationApplied, onToast }: Props) {
  const [lobbies, setLobbies] = useState<LobbyPreset[]>([]);
  const [preparations, setPreparations] = useState<PreparationPreset[]>([]);
  const [bots, setBots] = useState<any[]>([]);
  const [name, setName] = useState('Ranked preparation');
  const [lobbyName, setLobbyName] = useState('Quick lobby');
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [spells, setSpells] = useState<Spell[]>([]);
  const [spell1Id, setSpell1Id] = useState(0);
  const [spell2Id, setSpell2Id] = useState(0);
  const [snapshots, setSnapshots] = useState<ItemSetSnapshot[]>([]);
  const [balance, setBalance] = useState<BalanceCatalog | null>(null);
  const [profiles, setProfiles] = useState<ProfilePreset[]>([]);
  const [augmentQuery, setAugmentQuery] = useState('');

  const load = useCallback(async () => {
    if (!connected) return;
    try {
      const [nextLobbies, nextPreparations, nextBots, nextProfiles] = await Promise.all([fetchLobbyPresets(), fetchPreparationPresets(), remoteClient ? Promise.resolve([]) : fetchLCUCustomBots().catch(() => []), remoteClient ? fetchProfilePresets().catch(() => []) : Promise.resolve([])]);
      setLobbies(nextLobbies); setPreparations(nextPreparations); setBots(nextBots); setProfiles(nextProfiles);
    } catch (error: any) { setFeedback({ tone: 'error', message: error?.message || 'Preparation data is unavailable.' }); }
  }, [connected, remoteClient]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    void Promise.all([
      fetch('/lol-game-data/assets/v1/summoner-spells.json', { signal: controller.signal }).then((response) => response.ok ? response.json() : []),
      remoteClient ? Promise.resolve([]) : fetchItemSetSnapshots().catch(() => []),
      fetchLCUBalanceCatalog(controller.signal).catch(() => null),
    ]).then(([rawSpells, nextSnapshots, nextBalance]) => {
      const values = Array.isArray(rawSpells) ? rawSpells : Object.values(rawSpells || {});
      setSpells(values.map((spell: any) => ({ id: Number(spell.id), name: String(spell.name || `Spell ${spell.id}`) })).filter((spell: Spell) => spell.id > 0));
      setSnapshots(nextSnapshots as ItemSetSnapshot[]);
      setBalance(nextBalance as BalanceCatalog | null);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [connected, remoteClient]);

  const saveCurrentLobby = async () => {
    if (queueId <= 0 || remoteClient) return;
    setBusy('save-lobby');
    try { await saveLobbyPreset({ name: lobbyName.trim() || 'Quick lobby', queueId, queueName: queue?.name, firstRole, secondRole, mapId: queue?.mapId, gameMode: queue?.gameMode }); await load(); setFeedback({ tone: 'success', message: 'Quick lobby preset saved.' }); }
    catch (error: any) { setFeedback({ tone: 'error', message: error?.message || 'Could not save lobby preset.' }); }
    finally { setBusy(''); }
  };
  const saveCurrentPreparation = async () => {
    if (remoteClient) return;
    setBusy('save-prep');
    try { await savePreparationPreset({ name: name.trim() || 'Ranked preparation', championId, queueFamily: queue?.category || '', role: firstRole, runePageId, fallbackRunePageId, spell1Id, spell2Id, itemIds }); await load(); setFeedback({ tone: 'success', message: 'Preparation preset saved.' }); }
    catch (error: any) { setFeedback({ tone: 'error', message: error?.message || 'Could not save preparation preset.' }); }
    finally { setBusy(''); }
  };
  const apply = async (id: string, kind: 'lobby' | 'preparation') => {
    setBusy(`${kind}:${id}`);
    try {
      const preview = kind === 'lobby' ? await previewLobbyPreset(id) : await previewPreparationPreset(id);
      const proposed = preview.proposed;
      const summary = kind === 'lobby'
        ? `Current lobby → ${(proposed as LobbyPreset).queueName || `Queue ${(proposed as LobbyPreset).queueId}`}\nRoles → ${(proposed as LobbyPreset).firstRole || 'No role'} / ${(proposed as LobbyPreset).secondRole || 'No role'}`
        : `Current phase → ${String((preview.current as { gameflowPhase?: string }).gameflowPhase || 'unknown')}\nChampion → ${(proposed as PreparationPreset).championId || 'any'}\nRole → ${(proposed as PreparationPreset).role || 'any role'}\nRunes → ${(proposed as PreparationPreset).runePageId || 'current'} (fallback ${(proposed as PreparationPreset).fallbackRunePageId || 'current'})\nSpells → ${(proposed as PreparationPreset).spell1Id || 'current'} / ${(proposed as PreparationPreset).spell2Id || 'current'}\nItems → ${(proposed as PreparationPreset).itemIds?.length || 0}/6 planned`;
      if (!window.confirm(`Review ${kind} preset\n\n${summary}\n\nApply these values to League?`)) return;
      const result = kind === 'lobby' ? await applyLobbyPreset(id, preview.previewId) : await applyPreparationPreset(id, preview.previewId);
      if (kind === 'preparation') onPreparationApplied?.((result as { preset: PreparationPreset }).preset);
      const results = (result as { results?: Record<string, string> }).results || {};
      const partial = Object.values(results).some((value) => value.startsWith('unavailable') || value.startsWith('failed') || value.startsWith('skipped') || value.startsWith('waiting'));
      onToast(partial ? 'Preset partially applied; review the per-field result.' : `${kind === 'lobby' ? 'Lobby' : 'Preparation'} preset applied.`, partial ? 'info' : 'success');
    }
    catch (error: any) { onToast(error?.message || 'Preset could not be applied.', 'error'); }
    finally { setBusy(''); }
  };
  const remove = async (id: string, kind: 'lobby' | 'preparation') => {
    if (!window.confirm('Delete this preset?')) return;
    setBusy(`delete:${id}`);
    try { if (kind === 'lobby') await deleteLobbyPreset(id); else await deletePreparationPreset(id); await load(); }
    catch (error: any) { setFeedback({ tone: 'error', message: error?.message || 'Preset could not be deleted.' }); }
    finally { setBusy(''); }
  };
  const applyPhoneProfile = async (preset: ProfilePreset) => {
    setBusy(`profile:${preset.id}`);
    try {
      const preview = await previewProfilePreset(preset.id);
      if (!window.confirm(`Apply profile preset “${preset.name}”? RiftOps will revalidate every owned asset first.`)) return;
      const result = await applyProfilePreset(preset.id, preview.previewId);
      const partial = Object.values(result.results || {}).some((value) => value.startsWith('failed') || value.startsWith('skipped') || value.startsWith('unavailable') || value.startsWith('waiting'));
      onToast(partial ? 'Profile preset partially applied; review it on desktop.' : 'Profile preset applied.', partial ? 'info' : 'success');
    } catch (error: any) { onToast(error?.message || 'Profile preset could not be applied.', 'error'); }
    finally { setBusy(''); }
  };
  const addBot = async (bot: any) => {
    if (remoteClient) return;
    const champion = Number(bot.championId || bot.id || bot.champion?.id || 0); if (!champion) return;
    setBusy(`bot:${champion}`);
    try { await addLCUCustomBot(champion, String(bot.difficulty || 'MEDIUM').toUpperCase(), String(bot.teamId || '100') === '200' ? '200' : '100'); setFeedback({ tone: 'success', message: 'Bot added to the custom lobby.' }); }
    catch (error: any) { setFeedback({ tone: 'error', message: error?.message || 'League rejected the custom bot.' }); }
    finally { setBusy(''); }
  };
  const createItemSet = async (preset: PreparationPreset) => {
    if (remoteClient || !preset.championId || !preset.itemIds?.length) return;
    setBusy(`itemset:${preset.id}`);
    try {
      await applyManagedItemSet({ name: preset.name, championIds: [String(preset.championId)], mode: 'any', map: 'any', blocks: [{ type: 'Planned build', items: preset.itemIds.map((id) => ({ id: String(id), count: 1 })) }] });
      setSnapshots(await fetchItemSetSnapshots());
      setFeedback({ tone: 'success', message: 'RiftOps-managed League item set applied. A rollback snapshot was saved.' });
    } catch (error: any) { setFeedback({ tone: 'error', message: error?.message || 'Could not apply the managed item set.' }); }
    finally { setBusy(''); }
  };
  const rollbackLatest = async () => {
    if (!snapshots[0] || remoteClient) return;
    setBusy('rollback-itemset');
    try { await rollbackManagedItemSet(snapshots[0].id); setFeedback({ tone: 'success', message: 'League item sets restored from the latest snapshot.' }); }
    catch (error: any) { setFeedback({ tone: 'error', message: error?.message || 'Could not restore the item-set snapshot.' }); }
    finally { setBusy(''); }
  };
  const visibleAugments = useMemo(() => (balance?.arenaAugments || []).filter((augment) => {
    const name = String(augment.name || augment.nameTRA || augment.simpleNameTRA || `Augment ${augment.id || ''}`);
    return !augmentQuery.trim() || name.toLowerCase().includes(augmentQuery.trim().toLowerCase());
  }).slice(0, 24), [augmentQuery, balance]);

  return <div className="preparation-panel"><WorkspaceSection eyebrow="PREPARATION" title="Quick presets" description="Save the current queue, roles, champion, runes, spells, and six-item plan for a manual preview-and-apply workflow."><ActionFeedback state={feedback} />{!remoteClient && <div className="preparation-panel__forms"><div><label>Lobby preset name<input value={lobbyName} maxLength={48} onChange={(event) => setLobbyName(event.target.value)} /></label><button type="button" className="btn-secondary" onClick={() => void saveCurrentLobby()} disabled={!connected || queueId <= 0 || busy !== ''}><Save />{busy === 'save-lobby' ? 'Saving…' : 'Save lobby'}</button></div><div><label>Preparation preset name<input value={name} maxLength={48} onChange={(event) => setName(event.target.value)} /></label><button type="button" className="btn-primary" onClick={() => void saveCurrentPreparation()} disabled={!connected || busy !== ''}><Plus />{busy === 'save-prep' ? 'Saving…' : 'Save preparation'}</button></div></div>}{!remoteClient && <div className="preparation-panel__spell-grid"><label>Summoner spell 1<select value={spell1Id || ''} onChange={(event) => setSpell1Id(Number(event.target.value))}><option value="">No change</option>{spells.map((spell) => <option key={spell.id} value={spell.id}>{spell.name}</option>)}</select></label><label>Summoner spell 2<select value={spell2Id || ''} onChange={(event) => setSpell2Id(Number(event.target.value))}><option value="">No change</option>{spells.map((spell) => <option key={spell.id} value={spell.id}>{spell.name}</option>)}</select></label><span>{itemIds.length ? `${itemIds.length}/6 saved build items will be included.` : 'Save a primary item plan below to include it.'}</span></div>}<div className="preparation-panel__lists"><div><h4><Swords /> Lobby presets</h4>{lobbies.length === 0 && <small>No lobby presets yet.</small>}{lobbies.map((preset) => <div className="preparation-panel__item" key={preset.id}><span><strong>{preset.name}</strong><small>{preset.queueName || `Queue ${preset.queueId}`} · {preset.firstRole || '—'} / {preset.secondRole || '—'}</small></span><button type="button" className="btn-secondary" onClick={() => void apply(preset.id, 'lobby')} disabled={busy !== ''}><Check />Preview</button>{!remoteClient && <button type="button" className="btn-danger" onClick={() => void remove(preset.id, 'lobby')} disabled={busy !== ''}><Trash2 /></button>}</div>)}</div><div><h4><Check /> Preparation presets</h4>{preparations.length === 0 && <small>No preparation presets yet.</small>}{preparations.map((preset) => { const rune = runePages.find((page) => page.id === preset.runePageId); return <div className="preparation-panel__item" key={preset.id}><span><strong>{preset.name}</strong><small>Champion {preset.championId || 'any'} · {preset.queueFamily || 'any queue'} · {preset.role || 'any role'} · {rune?.name || (preset.runePageId ? `Rune ${preset.runePageId}` : 'Current runes')} · {preset.itemIds?.length || 0} items</small></span><button type="button" className="btn-secondary" onClick={() => void apply(preset.id, 'preparation')} disabled={busy !== ''}><Check />Preview</button>{!remoteClient && !!preset.itemIds?.length && <button type="button" className="btn-secondary" onClick={() => void createItemSet(preset)} disabled={busy !== ''}><PackagePlus />Item set</button>}{!remoteClient && <button type="button" className="btn-danger" onClick={() => void remove(preset.id, 'preparation')} disabled={busy !== ''}><Trash2 /></button>}</div>; })}{!remoteClient && snapshots.length > 0 && <button type="button" className="btn-secondary preparation-panel__rollback" onClick={() => void rollbackLatest()} disabled={busy !== ''}><RotateCcw />Rollback latest item-set write</button>}</div></div></WorkspaceSection>{!remoteClient && queue?.category?.toLowerCase() === 'custom' && <WorkspaceSection eyebrow="CUSTOM GAME" title="Bot catalogue" description="Only client-provided champions, teams, and difficulties are accepted."><div className="preparation-panel__bots">{bots.length === 0 && <small>League has not exposed a bot catalogue for this patch.</small>}{bots.slice(0, 24).map((bot, index) => <button type="button" key={`${bot.championId || bot.id || index}`} onClick={() => void addBot(bot)} disabled={busy !== ''}><Bot />{String(bot.name || bot.championName || bot.champion?.name || `Bot ${bot.championId || bot.id || index + 1}`)}{busy === `bot:${Number(bot.championId || bot.id || bot.champion?.id || 0)}` && <Loader2 className="animate-spin" />}</button>)}</div></WorkspaceSection>}{!remoteClient && <WorkspaceSection eyebrow="PATCH CATALOGUE" title="Arena augments & ARAM balance" description={`Read-only data from the installed League client · patch ${balance?.patch || 'unavailable'}.`}><div className="preparation-panel__catalog-status"><span>Arena augments: <strong>{balance?.arenaStatus === 'supported' ? balance.arenaAugments.length : 'Unavailable'}</strong></span><span>ARAM balance: <strong>{balance?.aramStatus === 'supported' ? balance.aramBalance.length : 'Unavailable for this patch'}</strong></span></div>{balance?.arenaStatus === 'supported' && <><input className="preparation-panel__catalog-search" value={augmentQuery} onChange={(event) => setAugmentQuery(event.target.value)} placeholder="Search Arena augments" aria-label="Search Arena augments" /><div className="preparation-panel__augments">{visibleAugments.map((augment) => <span key={augment.id}><strong>{augment.name || augment.nameTRA || augment.simpleNameTRA || `Augment ${augment.id}`}</strong><small>{augment.rarity || 'League augment'}</small></span>)}</div></>}{balance?.aramStatus === 'unavailable' && <small>{balance.aramDetail}</small>}</WorkspaceSection>}{remoteClient && <WorkspaceSection eyebrow="PROFILE PRESETS" title="Saved identity presets" description="Phone access can preview and apply existing presets. Create or delete them from the desktop app."><div className="preparation-panel__lists preparation-panel__lists--single"><div>{profiles.length === 0 && <small>No saved profile presets for this account.</small>}{profiles.map((preset) => <div className="preparation-panel__item" key={preset.id}><span><strong>{preset.name}</strong><small>{preset.iconId ? `Icon #${preset.iconId}` : 'Icon unchanged'} · {preset.backgroundSkinId ? `Skin #${preset.backgroundSkinId}` : 'Background unchanged'}</small></span><button type="button" className="btn-secondary" onClick={() => void applyPhoneProfile(preset)} disabled={busy !== ''}><Check />{busy === `profile:${preset.id}` ? 'Applying…' : 'Preview'}</button></div>)}</div></div></WorkspaceSection>}</div>;
}
