import { runReviewedOperation } from '../reviewedOperation';
import { useCallback, useEffect, useState } from 'react';
import { Layers3, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import {
  fetchLeagueLoadouts,
  previewExpandedReviewedOperation,
  type LeagueLoadouts,
} from '../api';
import ReviewOperationModal, { type ReviewOperationData } from './ReviewOperationModal';
import { EmptyState, StatusBadge, WorkspaceSection } from './DesignPrimitives';
import PageHeader from './PageHeader';
import { useLCUConnection } from './lcuConnectionContext';

type Feedback = { tone: 'success' | 'error'; message: string } | null;

export default function LeagueLoadoutsPanel() {
  const { connected } = useLCUConnection();
  const [data, setData] = useState<LeagueLoadouts | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [renameTarget, setRenameTarget] = useState<any>(null);
  const [renameName, setRenameName] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [review, setReview] = useState<ReviewOperationData | null>(null);

  const refresh = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    try {
      setData(await fetchLeagueLoadouts());
      setFeedback(null);
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'League loadouts are unavailable for this patch.' });
    } finally {
      setLoading(false);
    }
  }, [connected]);

  useEffect(() => { void refresh(); }, [refresh]);

  const reviewChange = async (loadout: any, kind: 'loadout-rename' | 'loadout-delete', nameOverride?: string) => {
    const id = String(loadout?.id || '').trim();
    if (!id) return;
    let name = String(loadout?.name || 'League loadout');
    if (preparing) return;
    if (kind === 'loadout-rename') {
      const nextName = nameOverride?.trim();
      if (!nextName || nextName === name) return;
      name = nextName;
    }
    setPreparing(true);
    try {
      const preview = await previewExpandedReviewedOperation({ kind, loadoutChange: { id, ...(kind === 'loadout-rename' ? { name } : {}) } });
      setRenameTarget(null);
      setReview({ previewId: preview.id, kind: preview.kind, title: kind === 'loadout-delete' ? 'Delete League loadout' : 'Rename League loadout', description: 'Review this League profile-loadout change before sending it.', confirmation: preview.confirmation, targetCount: 1, targetLabels: [name] });
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'Could not prepare the loadout change.' });
    } finally { setPreparing(false); }
  };

  const confirmReview = async (previewID: string, confirmation: string) => {
    const status = await runReviewedOperation(previewID, confirmation);
    if (status.state !== 'complete') throw new Error(`Operation ${status.state}`);
    setReview(null);
    setFeedback({ tone: 'success', message: 'League loadout updated.' });
    await refresh();
  };

  if (!connected) {
    return (
      <div className="space-y-4">
        <PageHeader
          variant="collection"
          icon={Layers3}
          eyebrow="PROFILE STUDIO"
          title="League loadouts"
          description="Inspect account-scoped cosmetic loadouts from the local League Client."
          meta={<StatusBadge tone="neutral">League offline</StatusBadge>}
        />
        <EmptyState icon={Layers3} title="Connect League to inspect loadouts" description="League profile loadouts are read from the signed-in client." action={<button type="button" className="btn-primary" onClick={() => window.dispatchEvent(new CustomEvent('riftops:navigate', { detail: 'play' }))}>Open Play &amp; Queue</button>} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        variant="collection"
        icon={Layers3}
        eyebrow="PROFILE STUDIO"
        title="League loadouts"
        description="Inspect account-scoped cosmetic loadouts. Slot composition stays read-only until League semantics are verified."
        meta={<StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>{connected ? 'Live loadouts' : 'League offline'}</StatusBadge>}
        actions={<button type="button" className="page-header__button" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh</button>}
      />
      {renameTarget && <form className="loadout-rename" onSubmit={(event) => { event.preventDefault(); void reviewChange(renameTarget, 'loadout-rename', renameName); }}><label>New loadout name<input autoFocus maxLength={64} value={renameName} onChange={(event) => setRenameName(event.target.value)} required /></label><button type="submit" className="btn-primary" disabled={preparing || !renameName.trim()}>Review rename</button><button type="button" className="btn-secondary" onClick={() => setRenameTarget(null)} disabled={preparing}>Cancel</button></form>}
      <WorkspaceSection eyebrow="LOADOUT INVENTORY" title="Saved loadouts" description={`${data?.items?.length || 0} cosmetic loadouts found in client`}>
        {feedback && <div className={`feedback-banner feedback-banner--${feedback.tone} mb-3`} role="status">{feedback.message}</div>}
        {!data?.ready && <p className="text-xs text-text-dim mb-3">League has not marked profile loadouts ready yet.</p>}
        {!data?.items?.length && <p className="text-sm text-text-muted py-5">No account loadouts were returned by League.</p>}
        <div className="space-y-2">{(data?.items || []).map((loadout: any) => <article key={String(loadout.id)} className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-3"><div className="min-w-0"><strong className="text-sm text-white">{loadout.name || 'Unnamed loadout'}</strong><small className="block text-xs text-text-muted">{loadout.scope || 'account'} · ID {loadout.id} · {Object.keys(loadout.loadout || loadout.slots || {}).length} slots</small></div><div className="flex gap-2"><button type="button" className="btn-secondary text-xs" disabled={preparing} onClick={() => { setRenameTarget(loadout); setRenameName(loadout.name || ''); }}><Pencil /> Rename</button><button type="button" className="btn-danger text-xs" disabled={preparing} onClick={() => void reviewChange(loadout, 'loadout-delete')}><Trash2 /> Delete</button></div></article>)}</div>
      </WorkspaceSection>
      <ReviewOperationModal operation={review} onClose={() => setReview(null)} onConfirm={confirmReview} />
    </div>
  );
}
