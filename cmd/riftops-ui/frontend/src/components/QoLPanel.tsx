import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  CircleStop,
  Gift,
  Heart,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Swords,
  Zap,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import {
  fetchHonorBallot,
  fetchQoLPreferences,
  honorPlayer,
  lcuClaimEventRewards,
  lcuDodge,
  lcuPlayAgain,
  lcuQuitCustomSession,
  lcuSetAvailability,
  lcuSetStatusMessage,
  saveQoLPreferences,
  type QoLPreferences,
  type QoLState,
} from '../api';
import ConfirmModal from './ConfirmModal';
import SafeToolsPanel from './SafeToolsPanel';
import { StatusBadge, WorkspaceSection } from './DesignPrimitives';
import { useLCUConnection } from './lcuConnectionContext';
import type { ConfirmAction } from '../types';

const AVAILABILITY_OPTIONS = [
  { value: 'chat', label: 'Online', color: '#16c79d' },
  { value: 'away', label: 'Away', color: '#d69b42' },
  { value: 'mobile', label: 'Mobile', color: '#34a9dc' },
  { value: 'offline', label: 'Offline', color: '#666d78' },
] as const;

type ToastState = { message: string; ok: boolean } | null;
type HonorPlayer = { puuid: string; summonerId: number; summonerName: string; championName: string; championId: number };
type HonorBallot = { gameId: number; eligibleAllies: HonorPlayer[]; eligibleOpponents: HonorPlayer[]; votePool?: { votes: number } };

const DEFAULT_PREFERENCES: QoLPreferences = {
  autoAccept: false,
  autoAcceptDelaySeconds: 0,
  autoAcceptRandomDelay: false,
  autoPlayAgain: false,
  autoHonor: false,
  autoStartQueue: false,
  autoClaimRewards: false,
  grindMode: false,
};

function formatPhaseLabel(rawPhase?: string): string {
  if (!rawPhase || rawPhase === 'None' || rawPhase === 'Disconnected') return 'Client menu';
  switch (rawPhase) {
    case 'Lobby': return 'Party lobby';
    case 'Matchmaking': return 'In queue';
    case 'ReadyCheck': return 'Ready check';
    case 'ChampSelect': return 'Champion select';
    case 'InProgress': return 'In game';
    case 'EndOfGame':
    case 'PreEndOfGame':
    case 'WaitingForStats': return 'Post game';
    default: return rawPhase.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
}

function formatDisplayStatus(rawPhase?: string, rawQueueState?: string, connected = false): string {
  if (!connected) return 'League client offline';
  const queueState = (rawQueueState || '').trim();
  if (queueState && !['invalid', 'none', 'default'].includes(queueState.toLowerCase())) return queueState;
  switch ((rawPhase || '').trim()) {
    case 'Lobby': return 'In party lobby';
    case 'Matchmaking': return 'Searching for a match';
    case 'ReadyCheck': return 'Match ready';
    case 'ChampSelect': return 'In champion select';
    case 'InProgress': return 'Match in progress';
    case 'EndOfGame':
    case 'PreEndOfGame':
    case 'WaitingForStats': return 'Post-game results';
    default: return 'Standing by in menu';
  }
}

function SwitchRow({
  title,
  description,
  checked,
  disabled,
  onChange,
  accent = 'gold',
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  accent?: 'gold' | 'teal' | 'rose' | 'violet';
}) {
  return (
    <div className={`qol-switch-row ${checked ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''} accent-${accent}`}>
      <div className="qol-switch-row__copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-label={title}
        aria-checked={checked}
        disabled={disabled}
        onClick={onChange}
        className="qol-switch cursor-pointer"
      >
        <span className="qol-switch__track"><span /></span>
        <b>{checked ? 'On' : 'Off'}</b>
      </button>
    </div>
  );
}

export default function QoLPanel({ onOpenLive, onOpenPlayFlow }: { onOpenLive?: () => void; onOpenPlayFlow?: () => void }) {
  const { qol: sharedQolState, connected: sharedConnected, refresh: refreshConnection } = useLCUConnection();
  const [state, setState] = useState<QoLState | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [preferences, setPreferences] = useState<QoLPreferences>(DEFAULT_PREFERENCES);
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [activeAction, setActiveAction] = useState('');
  const actionLock = useRef(false);
  const preferencesLock = useRef(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const statusHydrated = useRef(false);
  const [honorBallot, setHonorBallot] = useState<HonorBallot | null>(null);

  const showToast = useCallback((message: string, ok = true) => {
    setToast({ message, ok });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  const refreshState = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      await refreshConnection();
      setConnected(sharedConnected);
      setState(sharedQolState);
      if (sharedQolState && !statusHydrated.current) {
        setStatusMessage(sharedQolState.statusMessage || '');
        statusHydrated.current = true;
      }
    } catch {
      setConnected(false);
      setState(null);
      statusHydrated.current = false;
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  }, [refreshConnection, sharedConnected, sharedQolState]);

  useEffect(() => {
    setState(sharedQolState);
    setConnected(sharedConnected);
    if (sharedQolState && !statusHydrated.current) {
      setStatusMessage(sharedQolState.statusMessage || '');
      statusHydrated.current = true;
    }
  }, [sharedQolState, sharedConnected]);

  useEffect(() => {
    fetchQoLPreferences()
      .then(setPreferences)
      .catch((error) => showToast(error.message || 'Could not load automation preferences.', false))
      .finally(() => setPreferencesLoading(false));
  }, [showToast]);

  const runAction = useCallback(async (key: string, successMessage: string, action: () => Promise<unknown>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setActiveAction(key);
    try {
      await action();
      showToast(successMessage);
      await refreshState();
    } catch (error: any) {
      showToast(error.message || 'The action could not be completed.', false);
    } finally {
      actionLock.current = false;
      setActiveAction('');
    }
  }, [refreshState, showToast]);

  const updatePreferences = async (next: QoLPreferences) => {
    if (preferencesLock.current) return;
    preferencesLock.current = true;
    setSavingPreferences(true);
    const previous = preferences;
    setPreferences(next);
    try {
      setPreferences(await saveQoLPreferences(next));
      showToast('Automation preferences saved.');
    } catch (error: any) {
      setPreferences(previous);
      showToast(error.message || 'Could not save automation preferences.', false);
    } finally {
      preferencesLock.current = false;
      setSavingPreferences(false);
    }
  };

  const loadHonorBallot = () => runAction('honor-load', 'Honor ballot loaded.', async () => {
    const ballot = await fetchHonorBallot();
    setHonorBallot(ballot);
  });

  const honorPlayerAction = (player: HonorPlayer) => runAction(`honor-${player.puuid}`, `${player.summonerName} honored.`, () => honorPlayer({
    summonerId: player.summonerId,
    puuid: player.puuid,
    gameId: honorBallot?.gameId,
    honorType: 'HEART',
  }));

  const phase = state?.phase || 'Disconnected';
  const inChampSelect = phase === 'ChampSelect';
  const postGame = ['EndOfGame', 'PreEndOfGame', 'WaitingForStats'].includes(phase);
  const customSession = Boolean(state?.isCustom || state?.queueId === 3140);
  const customQuitAvailable = customSession && ['Lobby', 'Matchmaking', 'ChampSelect', 'GameStart', 'Loading', 'InProgress', 'Reconnect'].includes(phase);

  return (
    <div className="home-command-center">
      {confirmAction && <ConfirmModal action={confirmAction} onClose={() => setConfirmAction(null)} />}

      <div className="home-phase-strip">
        <div className="home-phase-strip__left">
          <StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>{connected ? formatPhaseLabel(phase) : 'League offline'}</StatusBadge>
          <div className="home-phase-strip__details">
            <div className="home-phase-strip__title">Automations Hub</div>
            <div className="home-phase-strip__desc">{connected ? formatDisplayStatus(state?.phase, state?.queueState, connected) : 'League client offline'}</div>
          </div>
        </div>
        <div className="home-phase-strip__right">
          <button type="button" className="home-phase-strip__action-btn home-phase-strip__action-btn--secondary cursor-pointer" onClick={() => void refreshState(true)} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {toast && (
        <div className={`p-3 rounded-xl border text-xs flex items-center gap-2 ${toast.ok ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300' : 'bg-red-950/40 border-red-500/30 text-red-300'}`}>
          {toast.ok ? <CheckCircle2 size={14} /> : <CircleStop size={14} />}
          <span>{toast.message}</span>
        </div>
      )}

      <div className="home-dashboard-grid">
        <div className="home-col-primary space-y-4">
          <WorkspaceSection eyebrow="BACKGROUND ROUTINES" title="Match automations" id="qol-match-heading">
            <SwitchRow
              title="Grind mode"
              description="Automates the full post-game cycle: return to lobby, honor first teammate, requeue, and claim rewards."
              checked={preferences.grindMode}
              disabled={preferencesLoading || savingPreferences}
              accent="gold"
              onChange={() => preferences.grindMode
                ? void updatePreferences({ ...preferences, grindMode: false })
                : setConfirmAction({
                    open: true,
                    title: 'Enable Grind mode?',
                    message: 'After each match, Grind mode automatically returns to the lobby, honors an ally, requeues, and claims battle-pass rewards. Queue and draft configurations are managed in Play & Queue.',
                    actionLabel: 'Enable Grind mode',
                    danger: false,
                    onConfirm: () => {
                      setConfirmAction(null);
                      void updatePreferences({ ...preferences, grindMode: true });
                    },
                  })
              }
            />

            <div className="qol-rule-list space-y-2 mt-3" aria-label="Individual background automation rules">
              <SwitchRow
                title="Auto-accept ready checks"
                description="Automatically accept ready checks when matchmaking finds a game."
                checked={preferences.autoAccept}
                disabled={preferencesLoading || savingPreferences}
                accent="teal"
                onChange={() => void updatePreferences({ ...preferences, autoAccept: !preferences.autoAccept })}
              />
              <SwitchRow
                title="Return to lobby"
                description="Click Play Again when the post-game summary appears."
                checked={preferences.autoPlayAgain}
                disabled={preferencesLoading || savingPreferences}
                accent="teal"
                onChange={() => void updatePreferences({ ...preferences, autoPlayAgain: !preferences.autoPlayAgain })}
              />
              <SwitchRow
                title="Honor first teammate"
                description="Honor the first eligible ally after each completed match."
                checked={preferences.autoHonor}
                disabled={preferencesLoading || savingPreferences}
                accent="rose"
                onChange={() => void updatePreferences({ ...preferences, autoHonor: !preferences.autoHonor })}
              />
              <SwitchRow
                title="Claim event rewards"
                description="Claim unlocked battle-pass and event-track rewards after each game."
                checked={preferences.autoClaimRewards}
                disabled={preferencesLoading || savingPreferences}
                accent="violet"
                onChange={() => void updatePreferences({ ...preferences, autoClaimRewards: !preferences.autoClaimRewards })}
              />
            </div>
          </WorkspaceSection>

          {/* Compact Routine Execution Summary Card */}
          <div className="p-4 rounded-2xl border border-white/10 bg-gradient-to-b from-dark-card/80 to-dark-bg/90 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold text-white">
                <Zap size={14} className="text-hextech-gold" />
                <span>Background Rules Execution Summary</span>
              </div>
              <span className="text-[10px] text-text-dim uppercase font-semibold">Active Engine</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5">
                <span className="text-[10px] text-text-dim block">Auto Accept</span>
                <span className={`font-bold ${preferences.autoAccept ? 'text-teal-400' : 'text-text-muted'}`}>
                  {preferences.autoAccept ? 'Ready' : 'Off'}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5">
                <span className="text-[10px] text-text-dim block">Play Again</span>
                <span className={`font-bold ${preferences.autoPlayAgain || preferences.grindMode ? 'text-teal-400' : 'text-text-muted'}`}>
                  {preferences.autoPlayAgain || preferences.grindMode ? 'Ready' : 'Off'}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5">
                <span className="text-[10px] text-text-dim block">Auto Honor</span>
                <span className={`font-bold ${preferences.autoHonor || preferences.grindMode ? 'text-rose-400' : 'text-text-muted'}`}>
                  {preferences.autoHonor || preferences.grindMode ? 'Ready' : 'Off'}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5">
                <span className="text-[10px] text-text-dim block">Claim Rewards</span>
                <span className={`font-bold ${preferences.autoClaimRewards || preferences.grindMode ? 'text-purple-400' : 'text-text-muted'}`}>
                  {preferences.autoClaimRewards || preferences.grindMode ? 'Ready' : 'Off'}
                </span>
              </div>
            </div>

            {/* Seamless Link to Play & Queue Draft Execution Monitor */}
            <div className="pt-2 border-t border-white/5 flex items-center justify-between text-xs">
              <span className="text-text-dim text-[11px]">
                Draft execution diagnostics &amp; pick/ban timeline:
              </span>
              {onOpenPlayFlow && (
                <button
                  type="button"
                  onClick={onOpenPlayFlow}
                  className="inline-flex items-center gap-1.5 text-hextech-gold hover:text-white font-bold text-xs transition cursor-pointer"
                >
                  <Swords size={13} />
                  <span>Open Draft Monitor in Play &amp; Queue</span>
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="home-col-secondary space-y-4">
          <WorkspaceSection eyebrow="SOCIAL" title="Presence" id="qol-presence-heading">
            <div className="qol-availability" role="group" aria-label="Availability">
              {AVAILABILITY_OPTIONS.map(({ value, label, color }) => (
                <button
                  key={value}
                  type="button"
                  disabled={!connected || activeAction !== ''}
                  className={`${state?.availability === value ? 'is-selected' : ''} cursor-pointer`}
                  onClick={() => void runAction('presence', `Availability set to ${label}.`, () => lcuSetAvailability(value))}
                >
                  <span style={{ backgroundColor: color }} />
                  {label}
                </button>
              ))}
            </div>
            <div className="qol-status-editor mt-3">
              <label htmlFor="qol-status-input" className="text-xs text-text-muted block mb-1">
                Custom status <small className="text-text-dim">{statusMessage.length}/255</small>
              </label>
              <div className="flex gap-2">
                <input
                  id="qol-status-input"
                  className="flex-grow px-3 py-1.5 rounded-xl bg-dark-card border border-white/10 text-white text-xs focus:outline-none"
                  value={statusMessage}
                  maxLength={255}
                  disabled={!connected}
                  placeholder="What should friends see?"
                  onChange={(event) => setStatusMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void runAction('status', 'Status message updated.', () => lcuSetStatusMessage(statusMessage.trim()));
                  }}
                />
                <button
                  type="button"
                  className="btn-primary px-3 py-1.5 text-xs rounded-xl cursor-pointer"
                  disabled={!connected || !statusMessage.trim() || activeAction === 'status'}
                  onClick={() => void runAction('status', 'Status message updated.', () => lcuSetStatusMessage(statusMessage.trim()))}
                >
                  {activeAction === 'status' ? <Loader2 className="animate-spin h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          </WorkspaceSection>

          <WorkspaceSection eyebrow="SESSION" title="Safety & Utilities" id="qol-safety-heading">
            <div className="qol-task-group__body space-y-3">
              {inChampSelect && (
                <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/30 text-xs space-y-2">
                  <div className="flex items-center gap-2 text-rose-300 font-bold">
                    <Swords size={14} />
                    <span>Champion select is live</span>
                  </div>
                  <p className="text-text-dim text-[11px]">
                    Open the live draft workspace or apply a standard queue dodge.
                  </p>
                  <div className="flex gap-2 pt-1">
                    {onOpenLive && (
                      <button type="button" className="btn-primary text-xs px-3 py-1.5 cursor-pointer" onClick={onOpenLive}>
                        <Swords size={13} className="inline mr-1" /> Open live draft
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-danger text-xs px-3 py-1.5 cursor-pointer"
                      onClick={() => setConfirmAction({
                        open: true,
                        title: 'Dodge this champion select?',
                        message: 'League will apply standard queue dodge penalties. This action cannot be undone.',
                        actionLabel: 'Dodge game',
                        danger: true,
                        onConfirm: () => {
                          setConfirmAction(null);
                          void runAction('dodge', 'Dodge request sent to League.', lcuDodge);
                        },
                      })}
                    >
                      <CircleStop size={13} className="inline mr-1" /> Dodge game
                    </button>
                  </div>
                </div>
              )}

              {customSession && customQuitAvailable && !inChampSelect && (
                <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/30 text-xs space-y-2">
                  <div className="text-amber-300 font-bold">Custom or practice session</div>
                  <p className="text-text-dim text-[11px]">Leave the custom lobby without sending a dodge penalty.</p>
                  <button
                    type="button"
                    className="btn-danger text-xs px-3 py-1.5 cursor-pointer"
                    disabled={activeAction === 'quit-custom'}
                    onClick={() => void runAction('quit-custom', 'Custom session closed.', lcuQuitCustomSession)}
                  >
                    <CircleStop size={13} className="inline mr-1" /> Quit custom
                  </button>
                </div>
              )}

              {postGame && (
                <div className="p-3 rounded-xl bg-white/[0.03] border border-white/10 space-y-2.5">
                  <div className="text-xs font-bold text-white flex items-center gap-1.5">
                    <Sparkles size={13} className="text-hextech-gold" />
                    <span>Post-game actions</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-primary text-xs px-3 py-1.5 cursor-pointer"
                      disabled={activeAction !== ''}
                      onClick={() => void runAction('play-again', 'Returning to lobby.', lcuPlayAgain)}
                    >
                      <Play size={13} className="inline mr-1" /> Play again
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs px-3 py-1.5 cursor-pointer"
                      disabled={activeAction !== ''}
                      onClick={() => void loadHonorBallot()}
                    >
                      <Heart size={13} className="inline mr-1" /> Load honor ballot
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs px-3 py-1.5 cursor-pointer"
                      disabled={activeAction !== ''}
                      onClick={() => void runAction('rewards', 'Event rewards checked.', lcuClaimEventRewards)}
                    >
                      <Gift size={13} className="inline mr-1" /> Claim rewards
                    </button>
                  </div>
                  {honorBallot && (
                    <div className="pt-2 border-t border-white/5 space-y-1">
                      <span className="text-[10px] text-text-dim block uppercase font-bold">Eligible Players</span>
                      {[...(honorBallot.eligibleAllies || []), ...(honorBallot.eligibleOpponents || [])].map((player) => (
                        <button
                          type="button"
                          key={player.puuid}
                          disabled={activeAction !== ''}
                          onClick={() => void honorPlayerAction(player)}
                          className="w-full flex items-center justify-between p-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.05] text-xs text-left cursor-pointer"
                        >
                          <span>
                            <strong className="text-white block">{player.summonerName}</strong>
                            <small className="text-text-dim">{player.championName}</small>
                          </span>
                          <Heart size={14} className="text-rose-400" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!inChampSelect && !customSession && !postGame && (
                <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 flex items-center gap-3">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0 animate-pulse" />
                  <div>
                    <strong className="text-xs text-white block">
                      {connected ? 'Automations standing by' : 'Connect League to unlock actions'}
                    </strong>
                    <small className="text-text-dim text-[11px]">
                      {connected ? `Phase: ${formatPhaseLabel(phase)}` : 'Launch Riot Client to begin.'}
                    </small>
                  </div>
                </div>
              )}

              <details className="qol-disclosure mt-4">
                <summary className="cursor-pointer text-xs font-semibold text-text-muted hover:text-white flex items-center gap-1.5">
                  <ShieldCheck size={14} className="text-hextech-cyan" />
                  <span>Reviewed client utilities</span>
                </summary>
                <div className="qol-disclosure__body mt-3">
                  <SafeToolsPanel />
                </div>
              </details>
            </div>
          </WorkspaceSection>
        </div>
      </div>
    </div>
  );
}
