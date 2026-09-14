import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Award,
  BookOpen,
  CalendarClock,
  Check,
  ChevronRight,
  Clock3,
  Gem,
  Info,
  RefreshCw,
  Sparkles,
  Trophy,
} from 'lucide-react';
import {
  acknowledgeProgressMastery,
  executeReviewedOperation,
  fetchLeagueLoadouts,
  fetchProgressMastery,
  fetchProgressMissions,
  fetchProgressRewards,
  fetchReviewedOperation,
  previewExpandedReviewedOperation,
  type ProgressMastery,
  type ProgressMissions,
  type ProgressRewards,
} from '../api';
import { championName, loadLeagueCatalog, resolveRewardDisplay, type LeagueCatalog } from '../leagueCatalog';
import ReviewOperationModal, { type ReviewOperationData } from './ReviewOperationModal';
import { useLCUConnection } from './lcuConnectionContext';

type Feedback = { tone: 'success' | 'error'; message: string } | null;
type ChampionCatalog = LeagueCatalog['champions'];

function readNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value: unknown, fallback = ''): string {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function missionProgress(objective: any): { current: number; goal: number } {
  const current = readNumber(objective?.current ?? objective?.progress ?? objective?.currentProgress ?? objective?.value);
  const goal = readNumber(objective?.goal ?? objective?.target ?? objective?.total ?? objective?.max);
  return { current, goal };
}

function missionLabel(objective: any): string {
  return text(objective?.label ?? objective?.description ?? objective?.name, 'Objective');
}

function formatDate(value: unknown, fallback = 'Date unavailable'): string {
  const raw = text(value);
  if (!raw) return fallback;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPlayedAt(value: unknown): string {
  const timestamp = readNumber(value);
  if (!timestamp) return 'No recent match';
  const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? 'No recent match' : `Last played ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function rewardID(reward: any, index: number): string {
  return text(reward?.id ?? reward?.rewardId ?? reward?.itemId, `reward-${index + 1}`);
}

function grantID(grant: any): string {
  return text(grant?.id ?? grant?.info?.id);
}

function rewardList(grant: any): any[] {
  return Array.isArray(grant?.rewards) ? grant.rewards : Array.isArray(grant?.rewardGroup?.rewards) ? grant.rewardGroup.rewards : [];
}

function rewardLimits(grant: any, count: number): { minimum: number; maximum: number } {
  const minimum = Math.max(1, readNumber(grant?.minimumSelections ?? grant?.rewardGroup?.selectionStrategyConfig?.minSelectionsAllowed, 1));
  const maximum = Math.max(minimum, readNumber(grant?.maximumSelections ?? grant?.rewardGroup?.selectionStrategyConfig?.maxSelectionsAllowed, count || minimum));
  return { minimum, maximum };
}

function selectedForGrant(grant: any, selectedRewards: Record<string, string[]>): string[] {
  const id = grantID(grant);
  if (Object.prototype.hasOwnProperty.call(selectedRewards, id)) return selectedRewards[id];
  return Array.isArray(grant?.selectedIds) ? grant.selectedIds.map(String) : [];
}

function ChampionPortrait({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !id) return <span className="progress-champion-card__portrait progress-champion-card__portrait--fallback" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>;
  return <img className="progress-champion-card__portrait" src={`/lol-game-data/assets/v1/champion-icons/${encodeURIComponent(id)}.png`} alt="" width="42" height="42" loading="lazy" onError={() => setFailed(true)} />;
}

function SummaryStat({ label, value, detail, accent = false }: { label: string; value: string; detail: string; accent?: boolean }) {
  return <div className="progress-summary__item"><span>{label}</span><strong className={accent ? 'is-accent' : ''}>{value}</strong><small>{detail}</small></div>;
}

function MissionRow({ mission }: { mission: any }) {
  const objectives = Array.isArray(mission?.objectives) ? mission.objectives.slice(0, 3) : [];
  return <article className="progress-mission-row">
    <div className="progress-mission-row__heading">
      <div><strong>{text(mission?.title, 'Mission')}</strong><p>{text(mission?.description ?? mission?.helperText, 'Complete the objective in League.')}</p></div>
      {mission?.endAt && <span><Clock3 aria-hidden="true" /> Ends {formatDate(mission.endAt)}</span>}
    </div>
    {objectives.length > 0 ? <div className="progress-mission-row__objectives">{objectives.map((objective: any, index: number) => {
      const progress = missionProgress(objective);
      const ratio = progress.goal > 0 ? Math.min(100, (progress.current / progress.goal) * 100) : 0;
      return <div key={text(objective?.id, `${mission?.id || 'mission'}-${index}`)} className="progress-objective">
        <div><span>{missionLabel(objective)}</span><b>{progress.current}/{progress.goal || '—'}</b></div>
        <span className="progress-objective__track"><i style={{ width: `${ratio}%` }} /></span>
      </div>;
    })}</div> : <span className="progress-mission-row__empty">No objective details supplied by League yet.</span>}
  </article>;
}

function MasteryCard({ champion, catalog }: { champion: any; catalog: ChampionCatalog }) {
  const id = text(champion?.championId);
  const name = championName(id, catalog);
  const sinceLevel = readNumber(champion?.championPointsSinceLastLevel);
  const untilLevel = readNumber(champion?.championPointsUntilNextLevel);
  const progress = sinceLevel + untilLevel > 0 ? Math.min(100, (sinceLevel / (sinceLevel + untilLevel)) * 100) : 0;
  return <article className="progress-champion-card">
    <ChampionPortrait id={id} name={name} />
    <div className="progress-champion-card__body">
      <div className="progress-champion-card__title"><div><strong>{name}</strong><small>{formatPlayedAt(champion?.lastPlayTime)}</small></div><span>Level {readNumber(champion?.championLevel)}</span></div>
      <div className="progress-champion-card__points"><b>{readNumber(champion?.championPoints).toLocaleString()}</b> points {champion?.highestGrade ? <em>Grade {champion.highestGrade}</em> : null}</div>
      <span className="progress-objective__track"><i style={{ width: `${progress}%` }} /></span>
      <small className="progress-champion-card__next">{untilLevel ? `${untilLevel.toLocaleString()} points to next level` : 'Level progress unavailable'}</small>
    </div>
  </article>;
}

function RewardIcon({ sources }: { sources: string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [sources]);
  if (!sources[index]) return <Gem aria-hidden="true" />;
  return <img src={sources[index]} alt="" width="28" height="28" loading="lazy" onError={() => setIndex((current) => current + 1)} />;
}

function RewardChoice({ reward, index, active, disabled, catalog, onClick }: { reward: any; index: number; active: boolean; disabled: boolean; catalog: LeagueCatalog; onClick: () => void }) {
  const display = resolveRewardDisplay(reward, catalog.skins, catalog.champions, index);
  return <button type="button" className={`progress-reward-option${active ? ' is-selected' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={active}>
    <span className="progress-reward-option__icon"><RewardIcon sources={display.iconSources} /></span>
    <span className="progress-reward-option__copy"><strong>{display.label}</strong><small>{display.detail}{text(reward?.fulfillmentSource) ? ` · ${text(reward.fulfillmentSource)}` : ''}</small></span>
    <span className="progress-reward-option__check" aria-hidden="true">{active ? <Check /> : null}</span>
  </button>;
}

export default function ProgressPage({ remoteClient = false }: { remoteClient?: boolean }) {
  const { connected } = useLCUConnection();
  const [missions, setMissions] = useState<ProgressMissions | null>(null);
  const [rewards, setRewards] = useState<ProgressRewards | null>(null);
  const [mastery, setMastery] = useState<ProgressMastery | null>(null);
  const [catalog, setCatalog] = useState<LeagueCatalog>({ champions: {}, skins: {} });
  const [loadoutCount, setLoadoutCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [selectedRewards, setSelectedRewards] = useState<Record<string, string[]>>({});
  const [review, setReview] = useState<ReviewOperationData | null>(null);

  const refresh = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    setError('');
    const [missionResult, rewardResult, masteryResult, championResult] = await Promise.allSettled([
      fetchProgressMissions(),
      fetchProgressRewards(),
      fetchProgressMastery(),
      loadLeagueCatalog(),
    ]);
    if (missionResult.status === 'fulfilled') setMissions(missionResult.value);
    if (rewardResult.status === 'fulfilled') setRewards(rewardResult.value);
    if (masteryResult.status === 'fulfilled') setMastery(masteryResult.value);
    if (championResult.status === 'fulfilled') setCatalog(championResult.value);
    if (!remoteClient) {
      const loadouts = await fetchLeagueLoadouts().catch(() => null);
      if (loadouts) setLoadoutCount(loadouts.items.length);
    }
    if ([missionResult, rewardResult, masteryResult].every((result) => result.status === 'rejected')) setError('Progress endpoints are unavailable for this League patch.');
    setLoading(false);
  }, [connected, remoteClient]);

  useEffect(() => { void refresh(); }, [refresh]);

  const pendingRewards = useMemo(() => rewards?.grants?.filter((grant: any) => text(grant?.status ?? grant?.info?.status).toUpperCase() === 'PENDING_SELECTION') || [], [rewards]);
  const activeMissions = useMemo(() => missions?.missions?.filter((mission: any) => !text(mission?.status).toLowerCase().includes('complete')) || [], [missions]);
  const masteryChampions = useMemo(() => (mastery?.champions || []).slice().sort((a: any, b: any) => readNumber(b?.championPoints) - readNumber(a?.championPoints)).slice(0, 8), [mastery]);
  const score = readNumber(mastery?.totalScore);

  const toggleReward = (grant: any, choiceID: string) => {
    const id = grantID(grant);
    const current = selectedForGrant(grant, selectedRewards);
    const { maximum } = rewardLimits(grant, rewardList(grant).length);
    if (!current.includes(choiceID) && current.length >= maximum) {
      setFeedback({ tone: 'error', message: `This reward allows up to ${maximum} selection${maximum === 1 ? '' : 's'}.` });
      return;
    }
    setSelectedRewards((previous) => ({
      ...previous,
      [id]: current.includes(choiceID) ? current.filter((value) => value !== choiceID) : [...current, choiceID],
    }));
    setFeedback(null);
  };

  const reviewReward = async (grant: any) => {
    const id = grantID(grant);
    const groupID = text(grant?.groupId ?? grant?.info?.rewardGroupId ?? grant?.rewardGroup?.id);
    const options = rewardList(grant);
    const selections = selectedForGrant(grant, selectedRewards);
    const { minimum, maximum } = rewardLimits(grant, options.length);
    if (!id || !groupID || selections.length < minimum || selections.length > maximum) {
      setFeedback({ tone: 'error', message: `Choose between ${minimum} and ${maximum} rewards before reviewing.` });
      return;
    }
    try {
      const preview = await previewExpandedReviewedOperation({ kind: 'reward-select', rewardSelections: [{ grantId: id, rewardGroupId: groupID, selections }] });
      const labels = selections.map((selection) => {
        const index = options.findIndex((option: any, optionIndex: number) => rewardID(option, optionIndex) === selection);
        return index >= 0 ? resolveRewardDisplay(options[index], catalog.skins, catalog.champions, index).label : selection;
      });
      setReview({ previewId: preview.id, kind: preview.kind, title: 'Confirm reward selection', description: 'Review the exact choices before sending them to League. This action may not be reversible.', confirmation: preview.confirmation, targetCount: 1, targetLabels: labels });
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'Could not prepare the reward selection.' });
    }
  };

  const confirmReview = async (previewID: string, confirmation: string) => {
    await executeReviewedOperation(previewID, confirmation);
    let status = await fetchReviewedOperation(previewID);
    for (let attempt = 0; attempt < 8 && (status.state === 'running' || status.state === 'preview'); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      status = await fetchReviewedOperation(previewID);
    }
    if (status.state !== 'complete') throw new Error(`Operation ${status.state}`);
    setFeedback({ tone: 'success', message: 'Reward selection applied.' });
    setSelectedRewards({});
    await refresh();
  };

  const acknowledge = async () => {
    try {
      await acknowledgeProgressMastery();
      setFeedback({ tone: 'success', message: 'Mastery notification acknowledged.' });
      await refresh();
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'Could not acknowledge mastery notification.' });
    }
  };

  if (!connected) {
    return <main className="workspace-stage progress-page"><section className="progress-surface progress-empty"><BookOpen aria-hidden="true" /><h2>Progress is waiting for League</h2><p>Connect the League Client to load missions, mastery, and rewards.</p></section></main>;
  }

  return <main className="workspace-stage progress-page">
    <header className="progress-page__header">
      <div><span className="progress-page__eyebrow">PLAYER PROGRESS</span><h1>Progress</h1><p>See what is ready, what is growing, and what needs your choice.</p></div>
      <div className="progress-page__header-actions"><span className={`progress-sync${loading ? ' is-syncing' : ''}`}><span />{loading ? 'Syncing with League' : 'Synced'}</span><button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh</button></div>
    </header>

    {error && <div className="feedback-banner feedback-banner--error" role="status">{error}</div>}
    {feedback && <div className={`feedback-banner feedback-banner--${feedback.tone}`} role="status">{feedback.message}</div>}

    <section className="progress-summary" aria-label="Progress summary">
      <SummaryStat label="Active missions" value={String(activeMissions.length)} detail={missions ? `${missions.missions.length} tracked in League` : 'Waiting for League'} />
      <SummaryStat label="Pending rewards" value={String(pendingRewards.length)} detail={pendingRewards.length ? 'Your choice is needed' : 'Nothing waiting'} accent={pendingRewards.length > 0} />
      <SummaryStat label="Mastery score" value={score ? score.toLocaleString() : '—'} detail={mastery ? `${masteryChampions.length} champions shown` : 'Waiting for League'} />
      <SummaryStat label="League loadouts" value={remoteClient ? '—' : String(loadoutCount)} detail={remoteClient ? 'Desktop only' : 'Saved in your client'} />
    </section>

    <div className="progress-dashboard-grid">
      <section className="progress-surface">
        <header className="progress-surface__header"><div className="progress-section-title"><BookOpen aria-hidden="true" /><div><h2>Missions</h2><p>Track objectives before they expire.</p></div></div><span className="progress-section-count">{activeMissions.length} active</span></header>
        <div className="progress-surface__body">
          {activeMissions.length ? activeMissions.slice(0, 8).map((mission: any) => <MissionRow key={text(mission?.id)} mission={mission} />) : <div className="progress-empty progress-empty--inline"><CalendarClock aria-hidden="true" /><strong>{missions ? 'No active missions' : 'Mission data unavailable'}</strong><p>{missions ? 'League has no active objectives for this account right now.' : 'Refresh after the League Client is ready.'}</p></div>}
        </div>
      </section>

      <section className="progress-surface">
        <header className="progress-surface__header"><div className="progress-section-title"><Award aria-hidden="true" /><div><h2>Mastery</h2><p>Champion levels and recent progress.</p></div></div><span className="progress-section-count">{score ? `${score.toLocaleString()} score` : 'No score'}</span></header>
        {Boolean(mastery?.notification) && <div className="progress-notification"><div><Sparkles aria-hidden="true" /><span>New mastery progress is ready to review.</span></div>{!remoteClient && <button type="button" className="btn-secondary" onClick={() => void acknowledge()}>Acknowledge</button>}</div>}
        <div className="progress-surface__body progress-mastery-grid">
          {masteryChampions.length ? masteryChampions.map((champion: any) => <MasteryCard key={text(champion?.championId)} champion={champion} catalog={catalog.champions} />) : <div className="progress-empty progress-empty--inline"><Trophy aria-hidden="true" /><strong>Mastery data unavailable</strong><p>Champion levels will appear when League returns mastery data.</p></div>}
        </div>
        {!Object.keys(catalog.champions).length && masteryChampions.length > 0 && <div className="progress-data-note"><Info aria-hidden="true" /> Champion names are unavailable from League metadata; IDs will resolve on the next refresh.</div>}
      </section>
    </div>

    <section className="progress-surface progress-rewards">
      <header className="progress-surface__header"><div className="progress-section-title"><Gem aria-hidden="true" /><div><h2>Rewards</h2><p>Review each choice before sending it to League.</p></div></div><span className="progress-section-count">{pendingRewards.length} pending</span></header>
      <div className="progress-surface__body">
        {pendingRewards.length ? <>
          <div className="progress-rewards__guide"><div><Sparkles aria-hidden="true" /><span><strong>Choose your reward</strong><small>Selections are reviewed first and never sent automatically.</small></span></div><b>{pendingRewards.length} choice{pendingRewards.length === 1 ? '' : 's'} waiting</b></div>
          <div className="progress-rewards__list">{pendingRewards.map((grant: any, grantIndex: number) => {
            const id = grantID(grant) || `grant-${grantIndex + 1}`;
            const options = rewardList(grant);
            const selected = selectedForGrant(grant, selectedRewards);
            const { minimum, maximum } = rewardLimits(grant, options.length);
            return <article key={id} className="progress-reward-grant">
              <header className="progress-reward-grant__header"><div><strong>Reward selection</strong><span>{grant?.createdAt ? `Received ${formatDate(grant.createdAt)}` : 'Pending in League'}</span></div><span className="progress-reward-status">Pending choice</span></header>
              <div className="progress-reward-grant__meta"><span><b>{minimum === maximum ? `Choose ${minimum}` : `Choose ${minimum}–${maximum}`}</b> option{maximum === 1 ? '' : 's'}</span><span>{text(grant?.strategy, 'SELECTION')} strategy</span><span>{selected.length} selected</span></div>
              {options.length ? <div className="progress-reward-options">{options.slice(0, 12).map((reward: any, index: number) => {
                const choiceID = rewardID(reward, index);
                return <RewardChoice key={choiceID} reward={reward} index={index} active={selected.includes(choiceID)} disabled={remoteClient} catalog={catalog} onClick={() => toggleReward(grant, choiceID)} />;
              })}</div> : <div className="progress-empty progress-empty--compact"><Info aria-hidden="true" /><span>League returned this grant without selectable reward details.</span></div>}
              <footer className="progress-reward-grant__footer">{remoteClient ? <span className="progress-reward-remote"><Info aria-hidden="true" /> Reward choices can only be applied on the desktop app.</span> : <span>{selected.length < minimum ? `${minimum - selected.length} more required` : selected.length === maximum ? 'Ready to review' : `${maximum - selected.length} more allowed`}</span>}<button type="button" className="btn-primary" onClick={() => void reviewReward(grant)} disabled={remoteClient || selected.length < minimum || selected.length > maximum}>Review selection <ChevronRight aria-hidden="true" /></button></footer>
            </article>;
          })}</div>
        </> : <div className="progress-empty progress-empty--inline"><Gem aria-hidden="true" /><strong>No pending rewards</strong><p>New reward choices will appear here when League grants them.</p></div>}
      </div>
    </section>
    <ReviewOperationModal operation={review} onClose={() => setReview(null)} onConfirm={confirmReview} />
  </main>;
}
