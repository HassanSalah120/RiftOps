import { Bot, Check, Loader2, Plus, Save, Swords, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { addLCUCustomBot, applyLobbyPreset, applyPreparationPreset, deleteLobbyPreset, deletePreparationPreset, fetchLCUCustomBots, fetchLobbyPresets, fetchPreparationPresets, saveLobbyPreset, savePreparationPreset, type LCUAvailableQueue, type LCURunePage, type LobbyPreset, type PreparationPreset } from '../api';
import { ActionFeedback, WorkspaceSection, type FeedbackState } from './DesignPrimitives';

type Props = { connected: boolean; remoteClient?: boolean; queueId: number; queue?: LCUAvailableQueue; firstRole: string; secondRole: string; championId: number; runePageId: number; fallbackRunePageId: number; runePages: LCURunePage[]; onToast: (message: string, type?: 'info' | 'success' | 'error') => void };

export default function PreparationPanel({ connected, remoteClient = false, queueId, queue, firstRole, secondRole, championId, runePageId, fallbackRunePageId, runePages, onToast }: Props) {
  const [lobbies, setLobbies] = useState<LobbyPreset[]>([]);
  const [preparations, setPreparations] = useState<PreparationPreset[]>([]);
  const [bots, setBots] = useState<any[]>([]);
  const [name, setName] = useState('Ranked preparation');
  const [lobbyName, setLobbyName] = useState('Quick lobby');
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const load = useCallback(async () => {
    if (!connected) return;
    try {
      const [nextLobbies, nextPreparations, nextBots] = await Promise.all([fetchLobbyPresets(), fetchPreparationPresets(), fetchLCUCustomBots().catch(() => [])]);
      setLobbies(nextLobbies); setPreparations(nextPreparations); setBots(nextBots);
    } catch (error: any) { setFeedback({ tone: 'error', message: error?.message || 'Preparation data is unavailable.' }); }
  }, [connected]);
  useEffect(() => { void load(); }, [load]);

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
    try { await savePreparationPreset({ name: name.trim() || 'Ranked preparation', championId, queueFamily: queue?.category || '', role: firstRole, runePageId, fallbackRunePageId }); await load(); setFeedback({ tone: 'success', message: 'Preparation preset saved.' }); }
    catch (error: any) { setFeedback({ tone: 'error', message: error?.message || 'Could not save preparation preset.' }); }
    finally { setBusy(''); }
  };
  const apply = async (id: string, kind: 'lobby' | 'preparation') => {
    setBusy(`${kind}:${id}`);
    try { const result = kind === 'lobby' ? await applyLobbyPreset(id) : await applyPreparationPreset(id); const results = kind === 'preparation' ? (result as { results?: Record<string, string> }).results || {} : {}; const partial = Object.values(results).some((value) => value.startsWith('unavailable') || value.startsWith('failed')); onToast(partial ? 'Preset partially applied; review the per-field result.' : `${kind === 'lobby' ? 'Lobby' : 'Preparation'} preset applied.`, partial ? 'info' : 'success'); }
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
  const addBot = async (bot: any) => {
    if (remoteClient) return;
    const champion = Number(bot.championId || bot.id || bot.champion?.id || 0); if (!champion) return;
    setBusy(`bot:${champion}`);
    try { await addLCUCustomBot(champion, String(bot.difficulty || 'MEDIUM').toUpperCase(), String(bot.teamId || '100') === '200' ? '200' : '100'); setFeedback({ tone: 'success', message: 'Bot added to the custom lobby.' }); }
    catch (error: any) { setFeedback({ tone: 'error', message: error?.message || 'League rejected the custom bot.' }); }
    finally { setBusy(''); }
  };

  return <div className="preparation-panel"><WorkspaceSection eyebrow="PREPARATION" title="Quick presets" description="Save the current queue, roles, champion, and rune choices for a manual preview-and-apply workflow."><ActionFeedback state={feedback} /><div className="preparation-panel__forms"><div><label>Lobby preset name<input value={lobbyName} maxLength={48} onChange={(event) => setLobbyName(event.target.value)} /></label><button type="button" className="btn-secondary" onClick={() => void saveCurrentLobby()} disabled={!connected || remoteClient || queueId <= 0 || busy !== ''}><Save />{busy === 'save-lobby' ? 'Saving…' : 'Save lobby'}</button></div><div><label>Preparation preset name<input value={name} maxLength={48} onChange={(event) => setName(event.target.value)} /></label><button type="button" className="btn-primary" onClick={() => void saveCurrentPreparation()} disabled={!connected || remoteClient || busy !== ''}><Plus />{busy === 'save-prep' ? 'Saving…' : 'Save preparation'}</button></div></div><div className="preparation-panel__lists"><div><h4><Swords /> Lobby presets</h4>{lobbies.length === 0 && <small>No lobby presets yet.</small>}{lobbies.map((preset) => <div className="preparation-panel__item" key={preset.id}><span><strong>{preset.name}</strong><small>{preset.queueName || `Queue ${preset.queueId}`} · {preset.firstRole || '—'} / {preset.secondRole || '—'}</small></span><button type="button" className="btn-secondary" onClick={() => void apply(preset.id, 'lobby')} disabled={busy !== ''}><Check />Apply</button><button type="button" className="btn-danger" onClick={() => void remove(preset.id, 'lobby')} disabled={busy !== ''}><Trash2 /></button></div>)}</div><div><h4><Check /> Preparation presets</h4>{preparations.length === 0 && <small>No preparation presets yet.</small>}{preparations.map((preset) => { const rune = runePages.find((page) => page.id === preset.runePageId); return <div className="preparation-panel__item" key={preset.id}><span><strong>{preset.name}</strong><small>{preset.role || 'Any role'} · {rune?.name || (preset.runePageId ? `Rune ${preset.runePageId}` : 'Current runes')}</small></span><button type="button" className="btn-secondary" onClick={() => void apply(preset.id, 'preparation')} disabled={busy !== ''}><Check />Apply</button><button type="button" className="btn-danger" onClick={() => void remove(preset.id, 'preparation')} disabled={busy !== ''}><Trash2 /></button></div>; })}</div></div></WorkspaceSection>{queue?.category?.toLowerCase() === 'custom' && <WorkspaceSection eyebrow="CUSTOM GAME" title="Bot catalogue" description="Only client-provided champions, teams, and difficulties are accepted."><div className="preparation-panel__bots">{bots.length === 0 && <small>League has not exposed a bot catalogue for this patch.</small>}{bots.slice(0, 24).map((bot, index) => <button type="button" key={`${bot.championId || bot.id || index}`} onClick={() => void addBot(bot)} disabled={busy !== ''}><Bot />{String(bot.name || bot.championName || bot.champion?.name || `Bot ${bot.championId || bot.id || index + 1}`)}{busy === `bot:${Number(bot.championId || bot.id || bot.champion?.id || 0)}` && <Loader2 className="animate-spin" />}</button>)}</div></WorkspaceSection>}</div>;
}
