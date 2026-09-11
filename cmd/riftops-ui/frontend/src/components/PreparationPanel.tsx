import { Bot, Check, Loader2, PackagePlus, Plus, RotateCcw, Save, Swords, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addLCUCustomBot,
  applyLobbyPreset,
  applyManagedItemSet,
  applyPreparationPreset,
  applyProfilePreset,
  deleteLobbyPreset,
  deletePreparationPreset,
  fetchItemSetSnapshots,
  fetchLCUBalanceCatalog,
  fetchLCUCustomBots,
  fetchLobbyPresets,
  fetchPreparationPresets,
  fetchProfilePresets,
  previewLobbyPreset,
  previewPreparationPreset,
  previewProfilePreset,
  rollbackManagedItemSet,
  saveLobbyPreset,
  savePreparationPreset,
  type BalanceCatalog,
  type ItemSetSnapshot,
  type LCUAvailableQueue,
  type LCURunePage,
  type LobbyPreset,
  type PreparationPreset,
  type ProfilePreset,
} from '../api';
import { ActionFeedback, WorkspaceSection, type FeedbackState } from './DesignPrimitives';

type Spell = { id: number; name: string };
type Props = {
  connected: boolean;
  remoteClient?: boolean;
  queueId: number;
  queue?: LCUAvailableQueue;
  firstRole: string;
  secondRole: string;
  championId: number;
  runePageId: number;
  fallbackRunePageId: number;
  runePages: LCURunePage[];
  itemIds: number[];
  onPreparationApplied?: (preset: PreparationPreset) => void;
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void;
};

export default function PreparationPanel({
  connected,
  remoteClient = false,
  queueId,
  queue,
  firstRole,
  secondRole,
  championId,
  runePageId,
  fallbackRunePageId,
  runePages,
  itemIds,
  onPreparationApplied,
  onToast,
}: Props) {
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
      const [nextLobbies, nextPreparations, nextBots, nextProfiles] = await Promise.all([
        fetchLobbyPresets(),
        fetchPreparationPresets(),
        remoteClient ? Promise.resolve([]) : fetchLCUCustomBots().catch(() => []),
        remoteClient ? fetchProfilePresets().catch(() => []) : Promise.resolve([]),
      ]);
      setLobbies(nextLobbies);
      setPreparations(nextPreparations);
      setBots(nextBots);
      setProfiles(nextProfiles);
    } catch (error: any) {
      setFeedback({ tone: 'error', message: error?.message || 'Preparation data is unavailable.' });
    }
  }, [connected, remoteClient]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    void Promise.all([
      fetch('/lol-game-data/assets/v1/summoner-spells.json', { signal: controller.signal }).then((response) =>
        response.ok ? response.json() : [],
      ),
      remoteClient ? Promise.resolve([]) : fetchItemSetSnapshots().catch(() => []),
      fetchLCUBalanceCatalog(controller.signal).catch(() => null),
    ])
      .then(([rawSpells, nextSnapshots, nextBalance]) => {
        const values = Array.isArray(rawSpells) ? rawSpells : Object.values(rawSpells || {});
        setSpells(
          values
            .map((spell: any) => ({ id: Number(spell.id), name: String(spell.name || `Spell ${spell.id}`) }))
            .filter((spell: Spell) => spell.id > 0),
        );
        setSnapshots(nextSnapshots as ItemSetSnapshot[]);
        setBalance(nextBalance as BalanceCatalog | null);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [connected, remoteClient]);

  const saveCurrentLobby = async () => {
    if (queueId <= 0 || remoteClient) return;
    setBusy('save-lobby');
    try {
      await saveLobbyPreset({
        name: lobbyName.trim() || 'Quick lobby',
        queueId,
        queueName: queue?.name,
        firstRole,
        secondRole,
        mapId: queue?.mapId,
        gameMode: queue?.gameMode,
      });
      await load();
      setFeedback({ tone: 'success', message: 'Quick lobby preset saved.' });
    } catch (error: any) {
      setFeedback({ tone: 'error', message: error?.message || 'Could not save lobby preset.' });
    } finally {
      setBusy('');
    }
  };

  const saveCurrentPreparation = async () => {
    if (remoteClient) return;
    setBusy('save-prep');
    try {
      await savePreparationPreset({
        name: name.trim() || 'Ranked preparation',
        championId,
        queueFamily: queue?.category || '',
        role: firstRole,
        runePageId,
        fallbackRunePageId,
        spell1Id,
        spell2Id,
        itemIds,
      });
      await load();
      setFeedback({ tone: 'success', message: 'Preparation preset saved.' });
    } catch (error: any) {
      setFeedback({ tone: 'error', message: error?.message || 'Could not save preparation preset.' });
    } finally {
      setBusy('');
    }
  };

  const apply = async (id: string, kind: 'lobby' | 'preparation') => {
    setBusy(`${kind}:${id}`);
    try {
      const preview = kind === 'lobby' ? await previewLobbyPreset(id) : await previewPreparationPreset(id);
      const proposed = preview.proposed;
      const summary =
        kind === 'lobby'
          ? `Current lobby → ${(proposed as LobbyPreset).queueName || `Queue ${(proposed as LobbyPreset).queueId}`}\nRoles → ${(proposed as LobbyPreset).firstRole || 'No role'} / ${(proposed as LobbyPreset).secondRole || 'No role'}`
          : `Current phase → ${String((preview.current as { gameflowPhase?: string }).gameflowPhase || 'unknown')}\nChampion → ${(proposed as PreparationPreset).championId || 'any'}\nRole → ${(proposed as PreparationPreset).role || 'any role'}\nRunes → ${(proposed as PreparationPreset).runePageId || 'current'} (fallback ${(proposed as PreparationPreset).fallbackRunePageId || 'current'})\nSpells → ${(proposed as PreparationPreset).spell1Id || 'current'} / ${(proposed as PreparationPreset).spell2Id || 'current'}\nItems → ${(proposed as PreparationPreset).itemIds?.length || 0}/6 planned`;
      if (!window.confirm(`Review ${kind} preset\n\n${summary}\n\nApply these values to League?`)) return;
      const result =
        kind === 'lobby'
          ? await applyLobbyPreset(id, preview.previewId)
          : await applyPreparationPreset(id, preview.previewId);
      if (kind === 'preparation') onPreparationApplied?.((result as { preset: PreparationPreset }).preset);
      const results = (result as { results?: Record<string, string> }).results || {};
      const partial = Object.values(results).some(
        (value) =>
          value.startsWith('unavailable') ||
          value.startsWith('failed') ||
          value.startsWith('skipped') ||
          value.startsWith('waiting'),
      );
      onToast(
        partial ? 'Preset partially applied; review the per-field result.' : `${kind === 'lobby' ? 'Lobby' : 'Preparation'} preset applied.`,
        partial ? 'info' : 'success',
      );
    } catch (error: any) {
      onToast(error?.message || 'Preset could not be applied.', 'error');
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string, kind: 'lobby' | 'preparation') => {
    if (!window.confirm('Delete this preset?')) return;
    setBusy(`delete:${id}`);
    try {
      if (kind === 'lobby') await deleteLobbyPreset(id);
      else await deletePreparationPreset(id);
      await load();
    } catch (error: any) {
      setFeedback({ tone: 'error', message: error?.message || 'Preset could not be deleted.' });
    } finally {
      setBusy('');
    }
  };

  const applyPhoneProfile = async (preset: ProfilePreset) => {
    setBusy(`profile:${preset.id}`);
    try {
      const preview = await previewProfilePreset(preset.id);
      if (!window.confirm(`Apply profile preset “${preset.name}”? RiftOps will revalidate every owned asset first.`))
        return;
      const result = await applyProfilePreset(preset.id, preview.previewId);
      const partial = Object.values(result.results || {}).some(
        (value) =>
          value.startsWith('failed') ||
          value.startsWith('skipped') ||
          value.startsWith('unavailable') ||
          value.startsWith('waiting'),
      );
      onToast(
        partial ? 'Profile preset partially applied; review it on desktop.' : 'Profile preset applied.',
        partial ? 'info' : 'success',
      );
    } catch (error: any) {
      onToast(error?.message || 'Profile preset could not be applied.', 'error');
    } finally {
      setBusy('');
    }
  };

  const addBot = async (bot: any) => {
    if (remoteClient) return;
    const champion = Number(bot.championId || bot.id || bot.champion?.id || 0);
    if (!champion) return;
    setBusy(`bot:${champion}`);
    try {
      await addLCUCustomBot(
        champion,
        String(bot.difficulty || 'MEDIUM').toUpperCase(),
        String(bot.teamId || '100') === '200' ? '200' : '100',
      );
      setFeedback({ tone: 'success', message: 'Bot added to the custom lobby.' });
    } catch (error: any) {
      setFeedback({ tone: 'error', message: error?.message || 'League rejected the custom bot.' });
    } finally {
      setBusy('');
    }
  };

  const createItemSet = async (preset: PreparationPreset) => {
    if (remoteClient || !preset.championId || !preset.itemIds?.length) return;
    setBusy(`itemset:${preset.id}`);
    try {
      await applyManagedItemSet({
        name: preset.name,
        championIds: [String(preset.championId)],
        mode: 'any',
        map: 'any',
        blocks: [{ type: 'Planned build', items: preset.itemIds.map((id) => ({ id: String(id), count: 1 })) }],
      });
      setSnapshots(await fetchItemSetSnapshots());
      setFeedback({ tone: 'success', message: 'RiftOps-managed League item set applied. A rollback snapshot was saved.' });
    } catch (error: any) {
      setFeedback({ tone: 'error', message: error?.message || 'Could not apply the managed item set.' });
    } finally {
      setBusy('');
    }
  };

  const rollbackLatest = async () => {
    if (!snapshots[0] || remoteClient) return;
    setBusy('rollback-itemset');
    try {
      await rollbackManagedItemSet(snapshots[0].id);
      setFeedback({ tone: 'success', message: 'League item sets restored from the latest snapshot.' });
    } catch (error: any) {
      setFeedback({ tone: 'error', message: error?.message || 'Could not restore the item-set snapshot.' });
    } finally {
      setBusy('');
    }
  };

  const visibleAugments = useMemo(
    () =>
      (balance?.arenaAugments || [])
        .filter((augment) => {
          const name = String(augment.name || augment.nameTRA || augment.simpleNameTRA || `Augment ${augment.id || ''}`);
          return !augmentQuery.trim() || name.toLowerCase().includes(augmentQuery.trim().toLowerCase());
        })
        .slice(0, 24),
    [augmentQuery, balance],
  );

  return (
    <div className="space-y-6">
      <WorkspaceSection
        eyebrow="PREPARATION"
        title="Quick presets"
        description="Save your favourite lobby settings, lane roles, champion runes, and spells for one-click setup."
      >
        <ActionFeedback state={feedback} />

        {!remoteClient && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <div className="flex items-end gap-2 p-3 rounded-xl bg-dark-bg/50 border border-white/5">
              <label className="flex-1 flex flex-col gap-1 text-xs text-text-muted">
                <span>Lobby preset name</span>
                <input
                  className="px-3 py-1.5 rounded-lg bg-dark-card border border-white/10 text-white text-xs focus:border-primary/50 focus:outline-none"
                  value={lobbyName}
                  maxLength={48}
                  onChange={(event) => setLobbyName(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs"
                onClick={() => void saveCurrentLobby()}
                disabled={!connected || queueId <= 0 || busy !== ''}
              >
                <Save className="w-3.5 h-3.5" />
                {busy === 'save-lobby' ? 'Saving…' : 'Save lobby'}
              </button>
            </div>

            <div className="flex items-end gap-2 p-3 rounded-xl bg-dark-bg/50 border border-white/5">
              <label className="flex-1 flex flex-col gap-1 text-xs text-text-muted">
                <span>Preparation preset name</span>
                <input
                  className="px-3 py-1.5 rounded-lg bg-dark-card border border-white/10 text-white text-xs focus:border-primary/50 focus:outline-none"
                  value={name}
                  maxLength={48}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn-primary flex items-center gap-1.5 px-3 py-2 text-xs"
                onClick={() => void saveCurrentPreparation()}
                disabled={!connected || busy !== ''}
              >
                <Plus className="w-3.5 h-3.5" />
                {busy === 'save-prep' ? 'Saving…' : 'Save preset'}
              </button>
            </div>
          </div>
        )}

        {!remoteClient && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 mb-4 items-center">
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              <span>Summoner spell 1</span>
              <select
                className="px-3 py-1.5 rounded-lg bg-dark-card border border-white/10 text-white text-xs focus:border-primary/50 focus:outline-none"
                value={spell1Id || ''}
                onChange={(event) => setSpell1Id(Number(event.target.value))}
              >
                <option value="">No change</option>
                {spells.map((spell) => (
                  <option key={spell.id} value={spell.id}>
                    {spell.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-text-muted">
              <span>Summoner spell 2</span>
              <select
                className="px-3 py-1.5 rounded-lg bg-dark-card border border-white/10 text-white text-xs focus:border-primary/50 focus:outline-none"
                value={spell2Id || ''}
                onChange={(event) => setSpell2Id(Number(event.target.value))}
              >
                <option value="">No change</option>
                {spells.map((spell) => (
                  <option key={spell.id} value={spell.id}>
                    {spell.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="text-xs text-text-dim sm:text-right">
              {itemIds.length
                ? `${itemIds.length}/6 saved build items will be included.`
                : 'Save a primary item plan below to include it.'}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl bg-dark-card/50 border border-white/5 space-y-3">
            <h4 className="flex items-center gap-2 text-xs font-bold text-text-primary uppercase tracking-wider">
              <Swords className="w-3.5 h-3.5 text-primary" /> Lobby presets
            </h4>
            {lobbies.length === 0 && <p className="text-xs text-text-dim italic">No lobby presets yet.</p>}
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {lobbies.map((preset) => (
                <div
                  className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-dark-bg/60 border border-white/5"
                  key={preset.id}
                >
                  <span className="flex flex-col min-w-0">
                    <strong className="text-xs text-white truncate">{preset.name}</strong>
                    <small className="text-[11px] text-text-muted truncate">
                      {preset.queueName || `Queue ${preset.queueId}`} · {preset.firstRole || '—'} / {preset.secondRole || '—'}
                    </small>
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      className="btn-secondary px-2.5 py-1 text-xs"
                      onClick={() => void apply(preset.id, 'lobby')}
                      disabled={busy !== ''}
                    >
                      <Check className="w-3 h-3" /> Preview
                    </button>
                    {!remoteClient && (
                      <button
                        type="button"
                        className="btn-danger p-1 text-xs"
                        onClick={() => void remove(preset.id, 'lobby')}
                        disabled={busy !== ''}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="p-4 rounded-xl bg-dark-card/50 border border-white/5 space-y-3">
            <h4 className="flex items-center gap-2 text-xs font-bold text-text-primary uppercase tracking-wider">
              <Check className="w-3.5 h-3.5 text-emerald-400" /> Preparation presets
            </h4>
            {preparations.length === 0 && (
              <p className="text-xs text-text-dim italic">No preparation presets yet.</p>
            )}
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {preparations.map((preset) => {
                const rune = runePages.find((page) => page.id === preset.runePageId);
                return (
                  <div
                    className="flex items-center justify-between gap-3 p-2.5 rounded-lg bg-dark-bg/60 border border-white/5"
                    key={preset.id}
                  >
                    <span className="flex flex-col min-w-0">
                      <strong className="text-xs text-white truncate">{preset.name}</strong>
                      <small className="text-[11px] text-text-muted truncate">
                        Champion {preset.championId || 'any'} · {preset.role || 'any role'} ·{' '}
                        {rune?.name || (preset.runePageId ? `Rune ${preset.runePageId}` : 'Current runes')} ·{' '}
                        {preset.itemIds?.length || 0} items
                      </small>
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        className="btn-secondary px-2.5 py-1 text-xs"
                        onClick={() => void apply(preset.id, 'preparation')}
                        disabled={busy !== ''}
                      >
                        <Check className="w-3 h-3" /> Preview
                      </button>
                      {!remoteClient && !!preset.itemIds?.length && (
                        <button
                          type="button"
                          className="btn-secondary px-2.5 py-1 text-xs"
                          onClick={() => void createItemSet(preset)}
                          disabled={busy !== ''}
                        >
                          <PackagePlus className="w-3 h-3" /> Item set
                        </button>
                      )}
                      {!remoteClient && (
                        <button
                          type="button"
                          className="btn-danger p-1 text-xs"
                          onClick={() => void remove(preset.id, 'preparation')}
                          disabled={busy !== ''}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {!remoteClient && snapshots.length > 0 && (
              <button
                type="button"
                className="btn-secondary flex items-center justify-center gap-2 w-full mt-2 py-1.5 text-xs text-text-muted"
                onClick={() => void rollbackLatest()}
                disabled={busy !== ''}
              >
                <RotateCcw className="w-3.5 h-3.5" /> Rollback latest item set
              </button>
            )}
          </div>
        </div>
      </WorkspaceSection>

      {!remoteClient && queue?.category?.toLowerCase() === 'custom' && (
        <WorkspaceSection
          eyebrow="CUSTOM GAME"
          title="Bot catalogue"
          description="Add AI bots to practice with directly in your custom game."
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {bots.length === 0 && (
              <small className="text-xs text-text-dim italic col-span-full">
                League has not exposed a bot catalogue for this patch.
              </small>
            )}
            {bots.slice(0, 24).map((bot, index) => (
              <button
                type="button"
                key={`${bot.championId || bot.id || index}`}
                onClick={() => void addBot(bot)}
                disabled={busy !== ''}
                className="flex items-center gap-1.5 p-2 rounded-lg bg-dark-bg/60 hover:bg-dark-card border border-white/5 hover:border-white/10 text-xs text-text-muted hover:text-white transition"
              >
                <Bot className="w-3.5 h-3.5 text-primary" />
                <span className="truncate">
                  {String(bot.name || bot.championName || bot.champion?.name || `Bot ${bot.championId || bot.id || index + 1}`)}
                </span>
                {busy === `bot:${Number(bot.championId || bot.id || bot.champion?.id || 0)}` && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" />
                )}
              </button>
            ))}
          </div>
        </WorkspaceSection>
      )}

      {!remoteClient && (
        <WorkspaceSection
          eyebrow="PATCH CATALOGUE"
          title="Arena augments & ARAM balance"
          description={`Read-only data from the installed League client · patch ${balance?.patch || 'unavailable'}.`}
        >
          <div className="flex items-center gap-4 text-xs text-text-muted mb-3">
            <span>
              Arena augments: <strong className="text-white">{balance?.arenaStatus === 'supported' ? balance.arenaAugments.length : 'Unavailable'}</strong>
            </span>
            <span>
              ARAM balance: <strong className="text-white">{balance?.aramStatus === 'supported' ? balance.aramBalance.length : 'Unavailable for this patch'}</strong>
            </span>
          </div>
          {balance?.arenaStatus === 'supported' && (
            <>
              <input
                className="w-full px-3 py-2 rounded-xl bg-dark-bg/60 border border-white/10 text-xs text-white focus:border-primary/50 focus:outline-none mb-3"
                value={augmentQuery}
                onChange={(event) => setAugmentQuery(event.target.value)}
                placeholder="Search Arena augments..."
                aria-label="Search Arena augments"
              />
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-60 overflow-y-auto">
                {visibleAugments.map((augment) => (
                  <div key={augment.id} className="p-2 rounded-lg bg-dark-bg/50 border border-white/5 flex flex-col">
                    <strong className="text-xs text-white truncate">
                      {augment.name || augment.nameTRA || augment.simpleNameTRA || `Augment ${augment.id}`}
                    </strong>
                    <small className="text-[10px] text-text-dim">{augment.rarity || 'League augment'}</small>
                  </div>
                ))}
              </div>
            </>
          )}
          {balance?.aramStatus === 'unavailable' && <small className="text-xs text-text-dim">{balance.aramDetail}</small>}
        </WorkspaceSection>
      )}

      {remoteClient && (
        <WorkspaceSection
          eyebrow="PROFILE PRESETS"
          title="Saved identity presets"
          description="Preview and apply existing presets. Create or delete them from the desktop app."
        >
          <div className="space-y-2">
            {profiles.length === 0 && (
              <small className="text-xs text-text-dim italic">No saved profile presets for this account.</small>
            )}
            {profiles.map((preset) => (
              <div
                className="flex items-center justify-between gap-3 p-3 rounded-xl bg-dark-bg/60 border border-white/5"
                key={preset.id}
              >
                <span className="flex flex-col">
                  <strong className="text-xs text-white">{preset.name}</strong>
                  <small className="text-[11px] text-text-muted">
                    {preset.iconId ? `Icon #${preset.iconId}` : 'Icon unchanged'} ·{' '}
                    {preset.backgroundSkinId ? `Skin #${preset.backgroundSkinId}` : 'Background unchanged'}
                  </small>
                </span>
                <button
                  type="button"
                  className="btn-secondary px-3 py-1.5 text-xs"
                  onClick={() => void applyPhoneProfile(preset)}
                  disabled={busy !== ''}
                >
                  <Check className="w-3.5 h-3.5" />
                  {busy === `profile:${preset.id}` ? 'Applying…' : 'Preview'}
                </button>
              </div>
            ))}
          </div>
        </WorkspaceSection>
      )}
    </div>
  );
}
