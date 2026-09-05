import { Archive, Check, Gift, Loader2, RefreshCw, RotateCcw, ShieldCheck, Trash2, X } from 'lucide-react';
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
  type CapabilityStatus,
  type ClientSettingsBackup,
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

      <div className="safe-tools-panel__heading">
        <div>
          <span className="page-header__eyebrow">SAFE UTILITIES</span>
          <h3>Snapshots & Rewards</h3>
          <p>Local-only utilities. RiftOps never stores credentials or sends arbitrary LCU requests.</p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {notice && <div className={`safe-tools-panel__notice is-${notice.tone}`}>{notice.message}</div>}

      {capabilities.length > 0 && (
        <div className="safe-tools-panel__capabilities">
          <span>
            LCU capability status <small>Patch {capabilities.find((entry) => entry.patch)?.patch || 'current'}</small>
          </span>
          {capabilities.map((capability) => (
            <b key={capability.id} className={`is-${capability.status}`} title={capability.detail || capability.status}>
              {capability.id} · {capability.status}
            </b>
          ))}
        </div>
      )}

      <div className="safe-tools-panel__grid">
        {/* Settings Snapshots Card */}
        <div className="safe-tools-panel__card">
          <div className="safe-tools-panel__card-head">
            <span>
              <Archive />
            </span>
            <div>
              <strong>Client Settings Snapshots</strong>
              <small>{backups.length}/10 retained for this account</small>
            </div>
          </div>

          <div className="safe-tools-panel__create">
            <input
              value={name}
              maxLength={48}
              onChange={(event) => setName(event.target.value)}
              aria-label="Backup name"
              placeholder="Snapshot label..."
            />
            <button
              type="button"
              className="btn-primary"
              onClick={() => void createBackup()}
              disabled={busy !== '' || !name.trim()}
            >
              {busy === 'backup' ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Snapshot
            </button>
          </div>

          <div className="safe-tools-panel__list">
            {backups.map((backup) => (
              <div key={backup.id}>
                <span>
                  <strong>{backup.name}</strong>
                  <small>{new Date(backup.createdAt).toLocaleString()}</small>
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void handleOpenRestore(backup)}
                  disabled={busy !== ''}
                >
                  <RotateCcw />
                  {busy === `restore:${backup.id}` ? 'Reading…' : 'Restore'}
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => handleDeleteBackup(backup)}
                  disabled={busy !== ''}
                  aria-label={`Delete ${backup.name}`}
                  title="Delete snapshot"
                >
                  <Trash2 />
                </button>
              </div>
            ))}
          </div>
          {!loading && backups.length === 0 && (
            <p className="safe-tools-panel__empty">No snapshots yet. Create one before changing League settings.</p>
          )}
        </div>

        {/* Pending Rewards Card */}
        <div className="safe-tools-panel__card">
          <div className="safe-tools-panel__card-head">
            <span>
              <Gift />
            </span>
            <div>
              <strong>Pending Rewards</strong>
              <small>Selectable choice rewards waiting in League client</small>
            </div>
          </div>

          {!loading && rewards.length === 0 && (
            <p className="safe-tools-panel__empty">No selectable pending rewards available.</p>
          )}

          <div className="safe-tools-panel__rewards">
            {rewards.map((group, index) => {
              const options = records(group.rewards || group.options || group.choices || group.items);
              return (
                <div key={String(group.id || index)}>
                  <strong>{String(group.name || group.title || 'Reward Group')}</strong>
                  <div>
                    {options.map((reward, rewardIndex) => {
                      const rewardId = String(reward.id || reward.rewardId || reward.itemId || rewardIndex);
                      const key = `reward:${String(group.id || group.rewardGroupId || index)}:${rewardId}`;
                      return (
                        <button
                          type="button"
                          key={rewardId}
                          className="btn-secondary"
                          disabled={busy !== ''}
                          onClick={() => void chooseReward(group, reward)}
                        >
                          <Check />
                          {String(reward.name || reward.title || reward.itemName || rewardId)}
                          {busy === key && <Loader2 className="animate-spin" />}
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
