import { Archive, Check, Gift, Loader2, RefreshCw, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  createClientSettingsBackup, deleteClientSettingsBackup, fetchClientSettingsBackups,
  fetchPendingRewards, previewClientSettingsRestore, restoreClientSettingsBackup,
  selectPendingReward, fetchLCUCapabilities, type CapabilityStatus, type ClientSettingsBackup,
} from '../api';

type Notice = { tone: 'success' | 'error' | 'info'; message: string } | null;

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextBackups, nextRewards, nextCapabilities] = await Promise.all([fetchClientSettingsBackups(), fetchPendingRewards(), fetchLCUCapabilities().catch(() => [])]);
      setBackups(nextBackups);
      setRewards(records(nextRewards));
      setCapabilities(nextCapabilities);
      setNotice(null);
    } catch (error: any) {
      setNotice({ tone: 'error', message: error?.message || 'Safe utilities are unavailable for this League patch.' });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createBackup = async () => {
    if (!name.trim()) return;
    setBusy('backup');
    try {
      await createClientSettingsBackup(name.trim());
      setNotice({ tone: 'success', message: 'Settings snapshot saved locally.' });
      await load();
    } catch (error: any) { setNotice({ tone: 'error', message: error?.message || 'Could not create a settings snapshot.' }); }
    finally { setBusy(''); }
  };

  const restore = async (backup: ClientSettingsBackup) => {
    setBusy(`restore:${backup.id}`);
    try {
      const preview = await previewClientSettingsRestore(backup.id);
      const confirmation = window.prompt(`Review the settings diff for “${backup.name}”. Type ${preview.restoreConfirmation} to continue.`) || '';
      if (confirmation.trim() !== preview.restoreConfirmation) {
        setNotice({ tone: 'info', message: 'Restore cancelled.' });
        return;
      }
      await restoreClientSettingsBackup(backup.id, confirmation.trim());
      setNotice({ tone: 'success', message: 'Settings restored. A pre-restore snapshot was kept for rollback.' });
      await load();
    } catch (error: any) { setNotice({ tone: 'error', message: error?.message || 'Settings restore failed; League kept the current values.' }); }
    finally { setBusy(''); }
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
    } catch (error: any) { setNotice({ tone: 'error', message: error?.message || 'League rejected the reward selection.' }); }
    finally { setBusy(''); }
  };

  return <section className="safe-tools-panel glass-card" aria-label="Reviewed client utilities">
    <div className="safe-tools-panel__heading"><div><span className="page-header__eyebrow">SAFE UTILITIES</span><h3>Snapshots & rewards</h3><p>Reviewed, local-only tools. RiftOps never stores credentials or sends arbitrary LCU requests.</p></div><button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh</button></div>
    {notice && <div className={`safe-tools-panel__notice is-${notice.tone}`}>{notice.message}</div>}
    {capabilities.length > 0 && <div className="safe-tools-panel__capabilities"><span>LCU capability status</span>{capabilities.map((capability) => <b key={capability.id} className={`is-${capability.status}`}>{capability.id} · {capability.status}</b>)}</div>}
    <div className="safe-tools-panel__grid">
      <div className="safe-tools-panel__card"><div className="safe-tools-panel__card-head"><span><Archive /></span><div><strong>Client settings backups</strong><small>{backups.length}/10 retained for this account</small></div></div><div className="safe-tools-panel__create"><input value={name} maxLength={48} onChange={(event) => setName(event.target.value)} aria-label="Backup name" /><button type="button" className="btn-primary" onClick={() => void createBackup()} disabled={busy !== '' || !name.trim()}>{busy === 'backup' ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Snapshot</button></div><div className="safe-tools-panel__list">{backups.map((backup) => <div key={backup.id}><span><strong>{backup.name}</strong><small>{new Date(backup.createdAt).toLocaleString()}</small></span><button type="button" className="btn-secondary" onClick={() => void restore(backup)} disabled={busy !== ''}><RotateCcw />{busy === `restore:${backup.id}` ? 'Restoring…' : 'Preview & restore'}</button><button type="button" className="btn-danger" onClick={() => { if (window.confirm(`Delete ${backup.name}?`)) { setBusy(`delete:${backup.id}`); void deleteClientSettingsBackup(backup.id).then(load).catch((error) => setNotice({ tone: 'error', message: error?.message || 'Could not delete backup.' })).finally(() => setBusy('')); } }} disabled={busy !== ''} aria-label={`Delete ${backup.name}`}><Trash2 /></button></div>)}</div>{!loading && backups.length === 0 && <p className="safe-tools-panel__empty">No snapshots yet. Create one before changing League settings.</p>}</div>
      <div className="safe-tools-panel__card"><div className="safe-tools-panel__card-head"><span><Gift /></span><div><strong>Pending rewards</strong><small>Choose only the options League currently exposes</small></div></div>{!loading && rewards.length === 0 && <p className="safe-tools-panel__empty">No selectable pending rewards.</p>}<div className="safe-tools-panel__rewards">{rewards.map((group, index) => { const options = records(group.rewards || group.options || group.choices || group.items); return <div key={String(group.id || index)}><strong>{String(group.name || group.title || 'Reward group')}</strong><div>{options.map((reward, rewardIndex) => { const rewardId = String(reward.id || reward.rewardId || reward.itemId || rewardIndex); const key = `reward:${String(group.id || group.rewardGroupId || index)}:${rewardId}`; return <button type="button" key={rewardId} className="btn-secondary" disabled={busy !== ''} onClick={() => void chooseReward(group, reward)}><Check />{String(reward.name || reward.title || reward.itemName || rewardId)}{busy === key && <Loader2 className="animate-spin" />}</button>; })}</div></div>; })}</div></div>
    </div>
  </section>;
}
