import { Archive, Check, Clipboard, Gift, Loader2, RefreshCw, RotateCcw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  createClientSettingsBackup,
  deleteClientSettingsBackup,
  fetchClientSettingsBackups,
  fetchPendingRewards,
  previewClientSettingsRestore,
  restoreClientSettingsBackup,
  selectPendingReward,
  fetchLCUCapabilities,
  fetchDDChampions,
  fetchGameflowPhase,
  fetchLCUAvailableQueues,
  fetchLCULobby,
  getLCUStatus,
  type CapabilityStatus,
  type ClientSettingsBackup,
  type LCUStatus,
} from '../api';
import ConfirmModal from './ConfirmModal';
import type { ConfirmAction } from '../types';

type Notice = { tone: 'success' | 'error' | 'info'; message: string } | null;

interface RestoreDialogState {
  backup: ClientSettingsBackup;
  changeCount: number;
  changes: string[];
  restoreConfirmation: string;
}

type UtilityState = {
  phase: string;
  queueID: number;
  queueName: string;
  mode: string;
  mapID: number;
  status: LCUStatus | null;
};

function records(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === 'object') as Record<string, any>[];
  if (value && typeof value === 'object') return Object.values(value).filter((entry) => entry && typeof entry === 'object') as Record<string, any>[];
  return [];
}

export default function SafeToolsPanel() {
  const [backups, setBackups] = useState<ClientSettingsBackup[]>([]);
  const [rewards, setRewards] = useState<Record<string, any>[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityStatus[]>([]);
  const [name, setName] = useState('Before RiftOps changes');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<Notice>(null);

  const [restoreDialog, setRestoreDialog] = useState<RestoreDialogState | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [utility, setUtility] = useState<UtilityState>({ phase: '', queueID: 0, queueName: '', mode: '', mapID: 0, status: null });
  const [champions, setChampions] = useState<Array<{ id: string; key: string; name: string }>>([]);
  const [championQuery, setChampionQuery] = useState('');
  const [selectedChampion, setSelectedChampion] = useState<{ id: string; key: string; name: string } | null>(null);
  const [utilityLoading, setUtilityLoading] = useState(false);
  const [copiedID, setCopiedID] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextBackups, nextRewards, nextCapabilities] = await Promise.all([
        fetchClientSettingsBackups(),
        fetchPendingRewards(),
        fetchLCUCapabilities().catch(() => []),
      ]);
      setBackups(nextBackups);
      setRewards(records(nextRewards));
      setCapabilities(nextCapabilities);
      setNotice(null);
    } catch (error: any) {
      setNotice({ tone: 'error', message: error?.message || 'Safe utilities are unavailable for this League patch.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadUtilities = useCallback(async () => {
    setUtilityLoading(true);
    const [statusResult, phaseResult, queuesResult, lobbyResult, championsResult] = await Promise.allSettled([
      getLCUStatus(),
      fetchGameflowPhase(),
      fetchLCUAvailableQueues(),
      fetchLCULobby(),
      fetchDDChampions(),
    ]);
    const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
    const phase = phaseResult.status === 'fulfilled' ? phaseResult.value : '';
    const queuesValue = queuesResult.status === 'fulfilled' ? queuesResult.value : [];
    const lobby = lobbyResult.status === 'fulfilled' ? lobbyResult.value : null;
    const queueID = Number(lobby?.gameConfig?.queueId || 0);
    const queue = queuesValue.find((entry) => entry.id === queueID);
    const championData = championsResult.status === 'fulfilled' ? championsResult.value.data : {};
    setUtility({
      phase,
      queueID,
      queueName: queue?.name || (queueID ? `Queue ${queueID}` : 'No active queue'),
      mode: lobby?.gameConfig?.gameMode || queue?.gameMode || 'No active mode',
      mapID: Number(lobby?.gameConfig?.mapId || queue?.mapId || 0),
      status,
    });
    setChampions(Object.values(championData || {}).map((entry: any) => ({ id: String(entry.id || ''), key: String(entry.key || ''), name: String(entry.name || entry.id || '') })).filter((entry) => entry.id && entry.name));
    setUtilityLoading(false);
  }, []);

  useEffect(() => { void loadUtilities(); }, [loadUtilities]);

  const championMatches = champions
    .filter((entry) => !championQuery.trim() || entry.name.toLowerCase().includes(championQuery.trim().toLowerCase()) || entry.key === championQuery.trim() || entry.id.toLowerCase() === championQuery.trim().toLowerCase())
    .slice(0, 6);

  const copyUtilityID = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); } catch { window.prompt(`Copy ${label}`, value); }
    setCopiedID(label);
    window.setTimeout(() => setCopiedID(''), 1400);
  };

  const createBackup = async () => {
    if (!name.trim()) return;
    setBusy('backup');
    try {
      await createClientSettingsBackup(name.trim());
      setNotice({ tone: 'success', message: 'Settings snapshot saved locally.' });
      await load();
    } catch (error: any) {
      setNotice({ tone: 'error', message: error?.message || 'Could not create a settings snapshot.' });
    } finally {
      setBusy('');
    }
  };

  const handleOpenRestore = async (backup: ClientSettingsBackup) => {
    setBusy(`restore:${backup.id}`);
    try {
      const preview = await previewClientSettingsRestore(backup.id);
      setRestoreDialog({
        backup,
        changeCount: preview.changeCount,
        changes: preview.changes,
        restoreConfirmation: preview.restoreConfirmation,
      });
      setConfirmInput('');
    } catch (error: any) {
      setNotice({ tone: 'error', message: error?.message || 'Failed to inspect backup changes.' });
    } finally {
      setBusy('');
    }
  };

  const handleExecuteRestore = async () => {
    if (!restoreDialog) return;
    const { backup, restoreConfirmation } = restoreDialog;
    if (confirmInput.trim() !== restoreConfirmation) return;

    setBusy(`execute-restore:${backup.id}`);
    try {
      await restoreClientSettingsBackup(backup.id, confirmInput.trim());
      setNotice({ tone: 'success', message: 'Settings restored. A pre-restore snapshot was kept for rollback.' });
      setRestoreDialog(null);
      await load();
    } catch (error: any) {
      setNotice({ tone: 'error', message: error?.message || 'Settings restore failed; League kept current values.' });
    } finally {
      setBusy('');
    }
  };

  const handleDeleteBackup = (backup: ClientSettingsBackup) => {
    setConfirmAction({
      open: true,
      title: `Delete Snapshot: “${backup.name}”?`,
      message: 'This will permanently remove this settings backup from local storage. This action cannot be undone.',
      actionLabel: 'Delete Snapshot',
      danger: true,
      onConfirm: () => {
        setConfirmAction(null);
        setBusy(`delete:${backup.id}`);
        void deleteClientSettingsBackup(backup.id)
          .then(() => {
            setNotice({ tone: 'info', message: 'Snapshot deleted.' });
            return load();
          })
          .catch((error: any) => setNotice({ tone: 'error', message: error?.message || 'Could not delete backup.' }))
          .finally(() => setBusy(''));
      },
    });
  };

  const chooseReward = async (group: Record<string, any>, reward: Record<string, any>) => {
    const grantId = String(group.grantId || group.id || '');
    const groupId = String(group.rewardGroupId || group.groupId || reward.groupId || '');
    const rewardId = String(reward.id || reward.rewardId || reward.itemId || '');
    if (!groupId || !rewardId) return;
    setBusy(`reward:${groupId}:${rewardId}`);
    try {
      await selectPendingReward(grantId, groupId, [rewardId]);
      setNotice({ tone: 'success', message: 'Reward selection sent to League.' });
      await load();
    } catch (error: any) {
      setNotice({ tone: 'error', message: error?.message || 'League rejected the reward selection.' });
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="safe-tools-panel glass-card" aria-label="Reviewed client utilities">
      {confirmAction && <ConfirmModal action={confirmAction} onClose={() => setConfirmAction(null)} />}

      {/* Restore Preview Modal */}
      {restoreDialog && (
        <div
          className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fadeIn"
          role="dialog"
          aria-modal="true"
          onClick={() => setRestoreDialog(null)}
        >
          <div
            className="hextech-modal max-w-lg w-full p-5 space-y-4 shadow-2xl relative overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute top-0 left-0 right-0 h-1 bg-primary shadow-[0_0_12px_#c8aa6e]" />

            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center text-primary">
                  <RotateCcw className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-sm font-black text-white">Restore Settings Snapshot</h4>
                  <p className="text-xs text-text-muted">{restoreDialog.backup.name}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRestoreDialog(null)}
                className="p-1 rounded-lg hover:bg-white/10 text-text-dim hover:text-white"
                aria-label="Close dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-text-dim uppercase tracking-wider text-[10px]">Detected Changes</span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-primary/20 text-primary border border-primary/30">
                  {restoreDialog.changeCount} change{restoreDialog.changeCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="max-h-48 overflow-y-auto rounded-xl p-3 bg-black/40 border border-white/[0.08] text-xs font-mono space-y-1">
                {restoreDialog.changes.length > 0 ? (
                  restoreDialog.changes.map((change, idx) => (
                    <div key={idx} className="text-text-muted truncate">
                      {change}
                    </div>
                  ))
                ) : (
                  <p className="text-text-dim italic">No changes detected from current settings.</p>
                )}
              </div>
            </div>

            <div className="space-y-1.5 pt-2 border-t border-white/[0.06]">
              <label className="text-xs font-bold text-text-muted block">
                Type <code className="px-1.5 py-0.5 rounded bg-primary/20 text-primary font-mono font-bold text-xs">{restoreDialog.restoreConfirmation}</code> to confirm:
              </label>
              <input
                type="text"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder={restoreDialog.restoreConfirmation}
                className="w-full px-3 py-2 rounded-xl bg-black/30 border border-white/[0.1] text-xs text-white focus:border-primary/50 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setRestoreDialog(null)}
                className="px-4 py-2 rounded-xl text-xs font-bold text-text-muted hover:text-white bg-white/[0.04] hover:bg-white/[0.08] transition border border-white/[0.06]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteRestore}
                disabled={confirmInput.trim() !== restoreDialog.restoreConfirmation || busy.startsWith('execute-restore')}
                className="btn-primary"
              >
                {busy.startsWith('execute-restore') ? <Loader2 className="animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                <span>Restore Settings</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <span className="page-header__eyebrow">SAFE UTILITIES</span>
          <h3 className="text-base font-bold text-white">Snapshots & Rewards</h3>
          <p className="text-xs text-text-muted">Save client settings before making changes, and claim pending rewards.</p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {notice && (
        <div className={`p-3 rounded-xl border text-xs flex items-center gap-2 mb-4 ${
          notice.tone === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' :
          notice.tone === 'error' ? 'bg-rose-500/10 border-rose-500/20 text-rose-300' :
          'bg-sky-500/10 border-sky-500/20 text-sky-300'
        }`}>
          {notice.message}
        </div>
      )}

      {capabilities.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-dark-bg/40 border border-white/5 text-xs mb-4">
          <span className="text-text-muted">
            LCU capability status <small className="text-text-dim">Patch {capabilities.find((entry) => entry.patch)?.patch || 'current'}</small>
          </span>
          {capabilities.map((capability) => (
            <span
              key={capability.id}
              className={`px-2 py-0.5 rounded-md text-[11px] font-mono ${
                capability.status === 'supported' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-500/10 text-text-muted border border-white/5'
              }`}
              title={capability.detail || capability.status}
            >
              {capability.id} · {capability.status}
            </span>
          ))}
        </div>
      )}

      <div className="glass-card p-4 rounded-xl border border-white/5 space-y-4 mb-4" aria-label="League utilities">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <strong className="text-xs font-bold text-white block">League quick utilities</strong>
            <small className="text-[11px] text-text-muted">Read-only identifiers and status from the connected local client.</small>
          </div>
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => void loadUtilities()} disabled={utilityLoading}>
            <RefreshCw className={`w-3 h-3 ${utilityLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="p-3 rounded-lg bg-dark-bg/50 border border-white/5">
            <small className="text-[10px] uppercase tracking-wider text-text-dim">Account status</small>
            <strong className="block text-xs text-white mt-1">{utility.status?.connected ? utility.status.leagueReady ? 'League ready' : 'Riot Client connected' : 'Client offline'}</strong>
            <span className="text-[10px] text-text-muted">{utility.status?.detail || (utility.status?.connected ? `Auth: ${utility.status.authSource}` : 'Open Riot Client and sign in.')}</span>
          </div>
          <div className="p-3 rounded-lg bg-dark-bg/50 border border-white/5">
            <small className="text-[10px] uppercase tracking-wider text-text-dim">Gameflow</small>
            <strong className="block text-xs text-white mt-1">{utility.phase || 'Unavailable'}</strong>
            <span className="text-[10px] text-text-muted">{utility.phase ? 'Reported by League LCU' : 'No live phase reported'}</span>
          </div>
          <div className="p-3 rounded-lg bg-dark-bg/50 border border-white/5">
            <small className="text-[10px] uppercase tracking-wider text-text-dim">Current queue / mode</small>
            <strong className="block text-xs text-white mt-1">{utility.queueID ? `${utility.queueName} · ${utility.queueID}` : 'No active queue'}</strong>
            <span className="text-[10px] text-text-muted">{utility.mode}{utility.mapID ? ` · Map ${utility.mapID}` : ''}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3 items-start">
          <div className="relative">
            <label className="text-[10px] uppercase tracking-wider text-text-dim block mb-1.5" htmlFor="champion-id-lookup">Champion name ↔ ID</label>
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-dark-bg/60 border border-white/10">
              <Search className="w-3.5 h-3.5 text-text-dim" />
              <input id="champion-id-lookup" value={championQuery} onChange={(event) => { setChampionQuery(event.target.value); setSelectedChampion(null); }} placeholder="Search Ahri or enter a champion ID…" className="w-full bg-transparent text-xs text-white placeholder:text-text-dim focus:outline-none" />
            </div>
            {championQuery.trim() && !selectedChampion && <div className="absolute left-0 right-0 top-[55px] z-10 p-1 rounded-lg bg-dark-card border border-white/10 shadow-xl">{championMatches.map((champion) => <button type="button" key={champion.key || champion.id} className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-white/10 text-left text-xs" onClick={() => { setSelectedChampion(champion); setChampionQuery(champion.name); }}><span className="text-white truncate">{champion.name}</span><code className="text-text-dim">{champion.key || champion.id}</code></button>)}{championMatches.length === 0 && <span className="block px-2 py-2 text-[11px] text-text-dim">No champion found in the current catalogue.</span>}</div>}
          </div>
          <div className="p-3 rounded-lg bg-dark-bg/50 border border-white/5 min-w-[170px]">
            <small className="text-[10px] uppercase tracking-wider text-text-dim">Resolved ID</small>
            <div className="flex items-center justify-between gap-2 mt-1"><strong className="text-sm text-white">{selectedChampion?.key || selectedChampion?.id || '—'}</strong>{selectedChampion && <button type="button" className="btn-secondary px-2 py-1 text-[10px]" onClick={() => void copyUtilityID(selectedChampion.key || selectedChampion.id, 'Champion ID')}><Clipboard className="w-3 h-3" />{copiedID === 'Champion ID' ? 'Copied' : 'Copy'}</button>}</div>
            {selectedChampion && <span className="text-[10px] text-text-muted">{selectedChampion.name}</span>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Settings Snapshots Card */}
        <div className="glass-card p-4 rounded-xl border border-white/5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
              <Archive className="w-4 h-4" />
            </div>
            <div>
              <strong className="text-xs font-bold text-white block">Client Settings Snapshots</strong>
              <small className="text-[11px] text-text-muted">{backups.length}/10 retained for this account</small>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              className="flex-1 px-3 py-1.5 rounded-lg bg-dark-bg/60 border border-white/10 text-xs text-white focus:border-primary/50 focus:outline-none"
              value={name}
              maxLength={48}
              onChange={(event) => setName(event.target.value)}
              aria-label="Backup name"
              placeholder="Snapshot label..."
            />
            <button
              type="button"
              className="btn-primary flex items-center gap-1.5 px-3 py-1.5 text-xs"
              onClick={() => void createBackup()}
              disabled={busy !== '' || !name.trim()}
            >
              {busy === 'backup' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />} Snapshot
            </button>
          </div>

          <div className="space-y-2 max-h-60 overflow-y-auto">
            {backups.map((backup) => (
              <div key={backup.id} className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-dark-bg/50 border border-white/5">
                <span className="flex flex-col min-w-0">
                  <strong className="text-xs text-white truncate">{backup.name}</strong>
                  <small className="text-[10px] text-text-dim">{new Date(backup.createdAt).toLocaleString()}</small>
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="btn-secondary px-2.5 py-1 text-xs"
                    onClick={() => void handleOpenRestore(backup)}
                    disabled={busy !== ''}
                  >
                    <RotateCcw className="w-3 h-3" />
                    {busy === `restore:${backup.id}` ? 'Reading…' : 'Restore'}
                  </button>
                  <button
                    type="button"
                    className="btn-danger p-1 text-xs"
                    onClick={() => handleDeleteBackup(backup)}
                    disabled={busy !== ''}
                    aria-label={`Delete ${backup.name}`}
                    title="Delete snapshot"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {!loading && backups.length === 0 && (
            <p className="text-xs text-text-dim italic">No snapshots yet. Create one before changing League settings.</p>
          )}
        </div>

        {/* Pending Rewards Card */}
        <div className="glass-card p-4 rounded-xl border border-white/5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400">
              <Gift className="w-4 h-4" />
            </div>
            <div>
              <strong className="text-xs font-bold text-white block">Pending Rewards</strong>
              <small className="text-[11px] text-text-muted">Selectable choice rewards waiting in League client</small>
            </div>
          </div>

          {!loading && rewards.length === 0 && (
            <p className="text-xs text-text-dim italic">No selectable pending rewards available.</p>
          )}

          <div className="space-y-3 max-h-60 overflow-y-auto">
            {rewards.map((group, index) => {
              const options = records(group.rewards || group.options || group.choices || group.items);
              return (
                <div key={String(group.id || index)} className="p-3 rounded-lg bg-dark-bg/50 border border-white/5 space-y-2">
                  <strong className="text-xs text-white block">{String(group.name || group.title || 'Reward Group')}</strong>
                  <div className="flex flex-wrap gap-2">
                    {options.map((reward, rewardIndex) => {
                      const rewardId = String(reward.id || reward.rewardId || reward.itemId || rewardIndex);
                      const key = `reward:${String(group.id || group.rewardGroupId || index)}:${rewardId}`;
                      return (
                        <button
                          type="button"
                          key={rewardId}
                          className="btn-secondary text-xs flex items-center gap-1.5 px-2.5 py-1"
                          disabled={busy !== ''}
                          onClick={() => void chooseReward(group, reward)}
                        >
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span>{String(reward.name || reward.title || reward.itemName || rewardId)}</span>
                          {busy === key && <Loader2 className="w-3 h-3 animate-spin" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
