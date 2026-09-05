import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  BellRing,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Flame,
  Gift,
  Heart,
  Loader2,
  MessageSquareText,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Swords,
  Users,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  fetchQueuePresets,
  fetchQoLPreferences,
  lcuAutoAccept,
  lcuAutoRequeue,
  lcuAutoRoles,
  lcuQuitCustomSession,
  lcuStopQueue,
  saveQueuePreset,
  saveQoLPreferences,
  type QoLPreferences,
  type QoLState,
} from '../api';
import PageHeader from './PageHeader';
import ConfirmModal from './ConfirmModal';
import SafeToolsPanel from './SafeToolsPanel';
import { StatusBadge } from './DesignPrimitives';
import { useLCUConnection } from './lcuConnectionContext';
import type { ConfirmAction } from '../types';

const ROLE_OPTIONS = [
  ['TOP', 'Top Lane', '🛡️'],
  ['JUNGLE', 'Jungle', '🌲'],
  ['MIDDLE', 'Mid Lane', '⚡'],
  ['BOTTOM', 'Bottom Lane', '🏹'],
  ['UTILITY', 'Support', '✨'],
  ['FILL', 'Fill Any Role', '🎲'],
] as const;

const AVAILABILITY_OPTIONS = [
  { value: 'chat', label: 'Online', color: '#16c79d' },
  { value: 'away', label: 'Away', color: '#d69b42' },
  { value: 'mobile', label: 'Mobile', color: '#34a9dc' },
  { value: 'offline', label: 'Offline', color: '#666d78' },
] as const;

const PHASES = [
  { key: 'Lobby', label: 'LOBBY' },
  { key: 'Matchmaking', label: 'QUEUE' },
  { key: 'ReadyCheck', label: 'READY CHECK' },
  { key: 'ChampSelect', label: 'CHAMP SELECT' },
  { key: 'InProgress', label: 'IN GAME' },
  { key: 'EndOfGame', label: 'POST GAME' },
] as const;

type QoLCategory = 'all' | 'automations' | 'queue' | 'social' | 'safety';

const CATEGORIES: { id: QoLCategory; label: string; icon: LucideIcon }[] = [
  { id: 'all', label: 'All Controls', icon: Zap },
  { id: 'automations', label: 'Automations', icon: BellRing },
  { id: 'queue', label: 'Queue & Roles', icon: Activity },
  { id: 'social', label: 'Chat & Presence', icon: MessageSquareText },
  { id: 'safety', label: 'Safety & Snapshots', icon: ShieldCheck },
];

type ToastState = { message: string; ok: boolean } | null;

type HonorPlayer = {
  puuid: string;
  summonerId: number;
  summonerName: string;
  championName: string;
  championId: number;
};

type HonorBallot = {
  gameId: number;
  eligibleAllies: HonorPlayer[];
  eligibleOpponents: HonorPlayer[];
  votePool?: { votes: number };
};

async function readError(response: Response, fallback: string) {
  const text = (await response.text()).trim();
  return text || fallback;
}

async function post(path: string, body?: object) {
  const response = await fetch(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(await readError(response, 'The League client rejected this action.'));
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json') ? response.json() : null;
}

export default function QoLPanel({ onOpenLive }: { onOpenLive?: () => void }) {
  const { qol: sharedQolState, connected: sharedConnected, refresh: refreshConnection } = useLCUConnection();

  const [state, setState] = useState<QoLState | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeCategory, setActiveCategory] = useState<QoLCategory>('all');

  const [preferences, setPreferences] = useState<QoLPreferences>({
    autoAccept: false,
    autoPlayAgain: false,
    autoHonor: false,
    autoStartQueue: false,
    autoClaimRewards: false,
    grindMode: false,
  });
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [activeAction, setActiveAction] = useState('');
  const [toast, setToast] = useState<ToastState>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const [statusMessage, setStatusMessage] = useState('');
  const statusHydrated = useRef(false);
  const rolesHydrated = useRef(false);
  const [firstRole, setFirstRole] = useState('MIDDLE');
  const [secondRole, setSecondRole] = useState('TOP');

  const [honorBallot, setHonorBallot] = useState<HonorBallot | null>(null);
  const honorType = 'HEART';

  const [queuePresets, setQueuePresets] = useState<Record<string, { first: string; second: string }>>({});
  const [queueLabels, setQueueLabels] = useState<Record<string, string>>({});
  const [presetQueue, setPresetQueue] = useState('ranked_solo');
  const [presetFirst, setPresetFirst] = useState('MIDDLE');
  const [presetSecond, setPresetSecond] = useState('TOP');

  const showToast = useCallback((message: string, ok = true) => {
    setToast({ message, ok });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  const refreshState = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      await refreshConnection();
      if (!sharedQolState) {
        setConnected(sharedConnected);
        return;
      }
      setState(sharedQolState);
      setConnected(sharedConnected);
      if (!statusHydrated.current) {
        setStatusMessage(sharedQolState.statusMessage || '');
        statusHydrated.current = true;
      }
      if (!rolesHydrated.current && sharedQolState.firstRole) {
        setFirstRole(sharedQolState.firstRole);
        setSecondRole(sharedQolState.secondRole || 'FILL');
        rolesHydrated.current = true;
      }
    } catch {
      setConnected(false);
      setState(null);
      statusHydrated.current = false;
      rolesHydrated.current = false;
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
    if (sharedQolState?.firstRole && !rolesHydrated.current) {
      setFirstRole(sharedQolState.firstRole);
      setSecondRole(sharedQolState.secondRole || 'FILL');
      rolesHydrated.current = true;
    }
  }, [sharedQolState, sharedConnected]);

  useEffect(() => {
    fetchQoLPreferences()
      .then(setPreferences)
      .catch((error) => showToast(error.message || 'Could not load automation preferences.', false))
      .finally(() => setPreferencesLoading(false));
  }, [showToast]);

  useEffect(() => {
    fetchQueuePresets()
      .then((data) => {
        setQueuePresets(data.presets || {});
        setQueueLabels(data.queues || {});
      })
      .catch(() => {});
  }, []);

  const runAction = useCallback(
    async (key: string, successMessage: string, action: () => Promise<unknown>) => {
      setActiveAction(key);
      try {
        await action();
        showToast(successMessage);
        await refreshState();
      } catch (error: any) {
        showToast(error.message || 'The action could not be completed.', false);
      } finally {
        setActiveAction('');
      }
    },
    [refreshState, showToast],
  );

  const updatePreferences = async (next: QoLPreferences) => {
    const previous = preferences;
    setPreferences(next);
    try {
      setPreferences(await saveQoLPreferences(next));
      showToast('Automation preferences saved.');
    } catch (error: any) {
      setPreferences(previous);
      showToast(error.message || 'Could not save automation preferences.', false);
    }
  };

  const loadHonorBallot = () =>
    runAction('honor-load', 'Honor ballot loaded.', async () => {
      const response = await fetch('/api/lcu/honor-ballot');
      if (!response.ok) throw new Error(await readError(response, 'Honor is not available right now.'));
      setHonorBallot(await response.json());
    });

  const honorPlayer = (player: HonorPlayer) =>
    runAction(`honor-${player.puuid}`, `${player.summonerName} honored.`, () =>
      post('/api/lcu/honor-player', {
        summonerId: player.summonerId,
        puuid: player.puuid,
        gameId: honorBallot?.gameId,
        honorType,
      }),
    );

  const phase = state?.phase || 'Disconnected';
  const inLobby = phase === 'Lobby';
  const inQueue = phase === 'Matchmaking';
  const readyCheck = phase === 'ReadyCheck';
  const inChampSelect = phase === 'ChampSelect';
  const postGame = phase === 'EndOfGame' || phase === 'PreEndOfGame' || phase === 'WaitingForStats';
  const customSession = Boolean(state?.isCustom || state?.queueId === 3140);
  const customQuitAvailable =
    customSession &&
    ['Lobby', 'Matchmaking', 'ChampSelect', 'GameStart', 'Loading', 'InProgress', 'Reconnect'].includes(phase);

  const automationCount = [
    preferences.autoAccept,
    preferences.autoPlayAgain,
    preferences.autoHonor,
    preferences.autoStartQueue,
    preferences.autoClaimRewards,
    preferences.grindMode,
  ].filter(Boolean).length;

  const primaryAction = !connected
    ? {
        label: 'Reconnect to League',
        detail: 'Click to scan local LCU client',
        tone: 'neutral' as const,
        action: () => void refreshState(true),
      }
    : readyCheck
    ? {
        label: 'Accept Ready Check',
        detail: 'Match found! Click to accept',
        tone: 'success' as const,
        action: () => void runAction('accept', 'Ready check accepted.', lcuAutoAccept),
      }
    : inLobby
    ? {
        label: 'Start Matchmaking',
        detail: `${firstRole} / ${secondRole}`,
        tone: 'gold' as const,
        action: () => void runAction('queue-start', 'Matchmaking started.', lcuAutoRequeue),
      }
    : inQueue
    ? {
        label: 'Cancel Queue',
        detail: state?.queueState || 'Searching for match...',
        tone: 'danger' as const,
        action: () => void runAction('queue-stop', 'Matchmaking stopped.', lcuStopQueue),
      }
    : inChampSelect
    ? {
        label: 'Go to Live Draft',
        detail: 'Champion select is active',
        tone: 'rose' as const,
        action: () => (onOpenLive ? onOpenLive() : null),
      }
    : postGame
    ? {
        label: 'Return to Lobby',
        detail: 'Match completed',
        tone: 'gold' as const,
        action: () => void runAction('play-again', 'Returning to lobby.', () => post('/api/lcu/play-again')),
      }
    : {
        label: 'Standing By',
        detail: 'LCU connected & idle',
        tone: 'neutral' as const,
        action: () => void refreshState(true),
      };

  const isCurrentPhase = (key: string) => {
    if (key === 'EndOfGame') return postGame;
    return phase === key;
  };

  const AUTOMATION_RULES = [
    {
      key: 'autoAccept' as keyof QoLPreferences,
      title: 'Auto-Accept Ready Checks',
      description: 'Accept queue pops automatically as soon as League enters Ready Check.',
      icon: BellRing,
      accent: '#0ac8b9',
    },
    {
      key: 'autoPlayAgain' as keyof QoLPreferences,
      title: 'Auto Return to Lobby',
      description: 'Use Play Again automatically when the post-game summary screen is ready.',
      icon: RotateCcw,
      accent: '#29cc99',
    },
    {
      key: 'autoHonor' as keyof QoLPreferences,
      title: 'Auto-Honor First Teammate',
      description: 'Automatically honors the first eligible ally after every completed match.',
      icon: Heart,
      accent: '#e75c9d',
    },
    {
      key: 'autoStartQueue' as keyof QoLPreferences,
      title: 'Auto-Start Matchmaking',
      description: 'Starts searching for a match automatically upon entering or returning to a lobby.',
      icon: Play,
      accent: '#c8aa6e',
    },
    {
      key: 'autoClaimRewards' as keyof QoLPreferences,
      title: 'Auto-Claim Event Rewards',
      description: 'Claims unlocked battle pass and event-track milestone rewards after each game.',
      icon: Gift,
      accent: '#a076e8',
    },
  ];

  return (
    <div className="qol-page">
      {/* Toast Feedback */}
      {toast && (
        <div className={`qol-toast ${toast.ok ? 'is-success' : 'is-error'}`} role="status" aria-live="polite">
          {toast.ok ? <CheckCircle2 /> : <XCircle />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmAction && <ConfirmModal action={confirmAction} onClose={() => setConfirmAction(null)} />}

      {/* Top Header */}
      <PageHeader
        icon={Sparkles}
        eyebrow="CLIENT AUTOMATION & UTILITIES"
        title="Quality of Life"
        description="Automate repetitive League client tasks, save queue position presets, manage chat presence, and create safe settings snapshots."
        meta={
          <StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>
            {connected ? `Phase: ${phase}` : 'League offline'}
          </StatusBadge>
        }
        actions={
          <div className="flex items-center gap-2">
            <span className="qol-rules-pill">
              <Zap className="w-3.5 h-3.5 text-amber-300" />
              <span>{automationCount}/6 Automations Active</span>
            </span>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void refreshState(true)}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
        }
      />

      {/* Interactive Phase Cockpit Bar */}
      <section className="qol-cockpit-bar" aria-label="League Client live pipeline">
        <div className="qol-cockpit-bar__pipeline">
          <span className="qol-cockpit-bar__label">PHASE</span>
          <div className="qol-cockpit-bar__steps">
            {PHASES.map(({ key, label }) => {
              const active = isCurrentPhase(key);
              return (
                <div key={key} className={`qol-cockpit-step ${active ? 'is-active' : ''}`}>
                  <span className="qol-cockpit-step__dot" />
                  <span className="qol-cockpit-step__name">{label}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="qol-cockpit-bar__action">
          <div className="qol-cockpit-bar__state-info">
            <span className={`qol-connection-dot ${connected ? 'is-online' : ''}`} />
            <span className="truncate max-w-[220px]">
              {state?.queueState || (connected ? 'Standing by' : 'League client offline')}
            </span>
          </div>
          <button
            type="button"
            onClick={primaryAction.action}
            disabled={activeAction !== ''}
            className={`qol-primary-action-btn qol-primary-action-btn--${primaryAction.tone}`}
          >
            {activeAction ? <Loader2 className="animate-spin" /> : <ChevronRight />}
            <span>{primaryAction.label}</span>
          </button>
        </div>
      </section>

      {/* Section Filter Pills */}
      <nav className="qol-filter-tabs" aria-label="QoL section filters">
        {CATEGORIES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={`qol-filter-tab ${activeCategory === id ? 'is-active' : ''}`}
            onClick={() => setActiveCategory(id)}
          >
            <Icon className="w-3.5 h-3.5" />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {/* Main 2-Column Cockpit Grid */}
      <div className="qol-cockpit-grid">
        {/* ══════════════════════════════════════════════════════
            COLUMN 1: AUTOMATIONS & MATCHMAKING
            ══════════════════════════════════════════════════════ */}
        {(activeCategory === 'all' || activeCategory === 'automations' || activeCategory === 'queue') && (
          <div className="qol-column">
            {/* CARD: AUTOMATIONS ENGINE */}
            {(activeCategory === 'all' || activeCategory === 'automations') && (
              <section className="qol-card">
                <div className="qol-card__head">
                  <div className="qol-card__icon qol-card__icon--gold">
                    <BellRing />
                  </div>
                  <div>
                    <span className="qol-card__eyebrow">CONTINUOUS LOOP</span>
                    <h3>Automations Engine</h3>
                    <p>Opt-in automation rules that run smoothly in the background.</p>
                  </div>
                </div>

                {/* Master Grind Mode Banner */}
                <div className={`qol-grind-banner ${preferences.grindMode ? 'is-active' : ''}`}>
                  <div className="qol-grind-banner__info">
                    <div className="qol-grind-banner__badge">
                      <Flame className="w-3.5 h-3.5 text-amber-300" />
                      <span>MASTER LOOP</span>
                    </div>
                    <h4>Grind Mode</h4>
                    <p>
                      Full automated loop: auto-accept queue pops, return to lobby, honor teammates, auto-requeue, and claim rewards.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={preferences.grindMode}
                    disabled={preferencesLoading}
                    onClick={() => void updatePreferences({ ...preferences, grindMode: !preferences.grindMode })}
                    className={`qol-switch-btn ${preferences.grindMode ? 'is-active' : ''}`}
                  >
                    <span className="qol-switch-btn__track">
                      <span className="qol-switch-btn__thumb" />
                    </span>
                    <span className="qol-switch-btn__label">{preferences.grindMode ? 'ACTIVE' : 'OFF'}</span>
                  </button>
                </div>

                {/* Granular Rules Stack */}
                <div className="qol-rules-stack">
                  {AUTOMATION_RULES.map(({ key, title, description, icon: Icon, accent }) => {
                    const isChecked = Boolean(preferences[key]);
                    return (
                      <div key={key} className={`qol-rule-row ${isChecked ? 'is-active' : ''}`}>
                        <div className="qol-rule-row__media" style={{ color: accent, borderColor: `${accent}40`, backgroundColor: `${accent}14` }}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="qol-rule-row__copy">
                          <strong>{title}</strong>
                          <small>{description}</small>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isChecked}
                          disabled={preferencesLoading}
                          onClick={() => void updatePreferences({ ...preferences, [key]: !isChecked })}
                          className={`qol-switch-btn ${isChecked ? 'is-active' : ''}`}
                        >
                          <span className="qol-switch-btn__track">
                            <span className="qol-switch-btn__thumb" />
                          </span>
                          <span className="qol-switch-btn__label">{isChecked ? 'ON' : 'OFF'}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* CARD: QUEUE & POSITIONS */}
            {(activeCategory === 'all' || activeCategory === 'queue') && (
              <section className="qol-card">
                <div className="qol-card__head">
                  <div className="qol-card__icon qol-card__icon--cyan">
                    <Activity />
                  </div>
                  <div>
                    <span className="qol-card__eyebrow">MATCHMAKING</span>
                    <h3>Queue Command & Roles</h3>
                    <p>Live matchmaking controls, position assignment, and saved role presets.</p>
                  </div>
                </div>

                {/* Quick Matchmaking Actions */}
                <div className="qol-action-button-grid">
                  <button
                    type="button"
                    disabled={!readyCheck}
                    onClick={() => void runAction('accept', 'Ready check accepted.', lcuAutoAccept)}
                    className="btn-primary qol-action-btn qol-action-btn--success"
                  >
                    {activeAction === 'accept' ? <Loader2 className="animate-spin" /> : <Check />}
                    <span>Accept Ready Check</span>
                  </button>
                  <button
                    type="button"
                    disabled={!inLobby}
                    onClick={() => void runAction('queue-start', 'Matchmaking started.', lcuAutoRequeue)}
                    className="btn-primary qol-action-btn"
                  >
                    {activeAction === 'queue-start' ? <Loader2 className="animate-spin" /> : <Play />}
                    <span>Start Queue</span>
                  </button>
                  <button
                    type="button"
                    disabled={!inQueue}
                    onClick={() => void runAction('queue-stop', 'Matchmaking stopped.', lcuStopQueue)}
                    className="btn-secondary qol-action-btn"
                  >
                    {activeAction === 'queue-stop' ? <Loader2 className="animate-spin" /> : <CircleStop />}
                    <span>Cancel Queue</span>
                  </button>
                </div>

                {/* Live Lobby Position Selector */}
                <div className="qol-sub-box">
                  <div className="qol-sub-box__header">
                    <span>
                      <Users className="w-3.5 h-3.5 text-primary" /> Active Lobby Positions
                    </span>
                    <small>Syncs directly to your current League party</small>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                    <div>
                      <label className="text-[10px] uppercase font-bold text-text-muted block mb-1">Primary Role</label>
                      <select
                        value={firstRole}
                        disabled={!inLobby}
                        onChange={(e) => setFirstRole(e.target.value)}
                        className="qol-select"
                      >
                        {ROLE_OPTIONS.map(([val, label, icon]) => (
                          <option key={val} value={val}>
                            {icon} {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] uppercase font-bold text-text-muted block mb-1">Secondary Role</label>
                      <select
                        value={secondRole}
                        disabled={!inLobby}
                        onChange={(e) => setSecondRole(e.target.value)}
                        className="qol-select"
                      >
                        {ROLE_OPTIONS.map(([val, label, icon]) => (
                          <option key={val} value={val}>
                            {icon} {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {firstRole === secondRole && (
                    <p className="text-[10px] text-danger mt-1.5 font-bold">Primary and secondary roles must be different.</p>
                  )}

                  <div className="flex justify-end mt-2.5">
                    <button
                      type="button"
                      disabled={!inLobby || firstRole === secondRole}
                      onClick={() => void runAction('roles', 'Position preferences synced.', () => lcuAutoRoles(firstRole, secondRole))}
                      className="btn-primary text-xs"
                    >
                      {activeAction === 'roles' ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                      <span>Sync Roles to Lobby</span>
                    </button>
                  </div>
                </div>

                {/* Queue Role Presets */}
                <div className="qol-sub-box mt-3">
                  <div className="qol-sub-box__header">
                    <span>
                      <Sparkles className="w-3.5 h-3.5 text-amber-300" /> Queue Role Presets
                    </span>
                    <small>Auto-applies when you enter a matching queue</small>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
                    <div>
                      <label className="text-[10px] uppercase font-bold text-text-muted block mb-1">Target Queue</label>
                      <select
                        value={presetQueue}
                        onChange={(e) => {
                          const q = e.target.value;
                          setPresetQueue(q);
                          const p = queuePresets[q];
                          if (p) {
                            setPresetFirst(p.first);
                            setPresetSecond(p.second);
                          }
                        }}
                        className="qol-select"
                      >
                        {Object.entries(queueLabels).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label} {queuePresets[k] ? '✓' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] uppercase font-bold text-text-muted block mb-1">Preset Primary</label>
                      <select
                        value={presetFirst}
                        onChange={(e) => setPresetFirst(e.target.value)}
                        className="qol-select"
                      >
                        {ROLE_OPTIONS.map(([val, label, icon]) => (
                          <option key={val} value={val}>
                            {icon} {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] uppercase font-bold text-text-muted block mb-1">Preset Secondary</label>
                      <select
                        value={presetSecond}
                        onChange={(e) => setPresetSecond(e.target.value)}
                        className="qol-select"
                      >
                        {ROLE_OPTIONS.map(([val, label, icon]) => (
                          <option key={val} value={val}>
                            {icon} {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {presetFirst === presetSecond && (
                    <p className="text-[10px] text-danger mt-1.5 font-bold">Primary and secondary roles must be different.</p>
                  )}

                  <div className="flex justify-end mt-2.5">
                    <button
                      type="button"
                      disabled={presetFirst === presetSecond}
                      onClick={() =>
                        void runAction(
                          `preset-${presetQueue}`,
                          `Preset saved for ${queueLabels[presetQueue] || presetQueue}.`,
                          async () => {
                            const result = await saveQueuePreset(presetQueue, presetFirst, presetSecond);
                            setQueuePresets(result);
                          },
                        )
                      }
                      className="btn-secondary text-xs"
                    >
                      {activeAction === `preset-${presetQueue}` ? <Loader2 className="animate-spin" /> : <Check />}
                      <span>Save Queue Preset</span>
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════
            COLUMN 2: PRESENCE, SESSION CONTROLS & SAFETY
            ══════════════════════════════════════════════════════ */}
        {(activeCategory === 'all' || activeCategory === 'social' || activeCategory === 'safety') && (
          <div className="qol-column">
            {/* CARD: SOCIAL PRESENCE */}
            {(activeCategory === 'all' || activeCategory === 'social') && (
              <section className="qol-card">
                <div className="qol-card__head">
                  <div className="qol-card__icon qol-card__icon--emerald">
                    <MessageSquareText />
                  </div>
                  <div>
                    <span className="qol-card__eyebrow">SOCIAL PRESENCE</span>
                    <h3>Chat Availability & Status</h3>
                    <p>Live visibility controls synchronized directly with the League chat service.</p>
                  </div>
                </div>

                {/* Availability Segmented Buttons */}
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase font-bold text-text-muted block">Availability</label>
                  <div className="qol-segmented-presence">
                    {AVAILABILITY_OPTIONS.map(({ value, label, color }) => {
                      const isSelected = state?.availability === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          disabled={!connected || activeAction === 'presence'}
                          className={`qol-presence-btn ${isSelected ? 'is-selected' : ''}`}
                          onClick={() =>
                            void runAction('presence', `Availability set to ${label}.`, () =>
                              post('/api/lcu/availability', { availability: value }),
                            )
                          }
                        >
                          <span
                            className="qol-presence-indicator-dot"
                            style={{ backgroundColor: color, boxShadow: isSelected ? `0 0 10px ${color}` : 'none' }}
                          />
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Custom Status Message */}
                <div className="space-y-1.5 mt-3 pt-3 border-t border-white/[0.06]">
                  <div className="flex items-center justify-between">
                    <label htmlFor="qol-status-input" className="text-[10px] uppercase font-bold text-text-muted">
                      Custom Status Message
                    </label>
                    <small className="text-[9px] text-text-dim">{statusMessage.length}/255</small>
                  </div>
                  <div className="flex gap-2">
                    <input
                      id="qol-status-input"
                      value={statusMessage}
                      maxLength={255}
                      disabled={!connected}
                      placeholder="What should friends see?"
                      onChange={(e) => setStatusMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && statusMessage.trim()) {
                          void runAction('status', 'Status message updated.', () =>
                            post('/api/lcu/status-message', { message: statusMessage.trim() }),
                          );
                        }
                      }}
                      className="qol-input flex-1"
                    />
                    <button
                      type="button"
                      disabled={!connected || !statusMessage.trim() || activeAction === 'status'}
                      onClick={() =>
                        void runAction('status', 'Status message updated.', () =>
                          post('/api/lcu/status-message', { message: statusMessage.trim() }),
                        )
                      }
                      className="btn-primary text-xs"
                    >
                      {activeAction === 'status' ? <Loader2 className="animate-spin" /> : <Check />}
                      <span>Update</span>
                    </button>
                  </div>
                </div>
              </section>
            )}

            {/* CARD: SESSION MATCH CONTROLS */}
            {(activeCategory === 'all' || activeCategory === 'safety') && (
              <section className="qol-card">
                <div className="qol-card__head">
                  <div className="qol-card__icon qol-card__icon--rose">
                    <Swords />
                  </div>
                  <div>
                    <span className="qol-card__eyebrow">ACTIVE SESSION</span>
                    <h3>Game Phase & Match Controls</h3>
                    <p>Actions context-aware of the current gameflow phase.</p>
                  </div>
                </div>

                {/* Champ Select Context */}
                {inChampSelect && (
                  <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-rose-400 animate-ping" />
                        <strong className="text-xs font-black text-white">Champion Select is Live</strong>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-[9px] font-black bg-rose-500/20 text-rose-300 border border-rose-500/40">
                        ACTIVE DRAFT
                      </span>
                    </div>
                    <p className="text-[11px] text-text-muted leading-relaxed">
                      Pick, ban, runes, and teammate scouting are live. Switch to the dedicated drafting workspace or trigger a safe dodge.
                    </p>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {onOpenLive && (
                        <button type="button" onClick={onOpenLive} className="btn-primary text-xs">
                          <Swords className="w-3.5 h-3.5" />
                          <span>Go to Live Draft Workspace</span>
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmAction({
                            open: true,
                            title: 'Dodge this champion select?',
                            message: 'League will apply standard queue dodge penalties. This action cannot be undone.',
                            actionLabel: 'Dodge Game',
                            danger: true,
                            onConfirm: () => {
                              setConfirmAction(null);
                              void runAction('dodge', 'Dodge request sent to League.', () => post('/api/lcu/dodge'));
                            },
                          })
                        }
                        className="btn-danger text-xs"
                      >
                        <CircleStop className="w-3.5 h-3.5" />
                        <span>Dodge Game</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Custom Game Exit */}
                {customSession && customQuitAvailable && !inChampSelect && (
                  <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-3">
                    <div>
                      <strong className="text-xs font-black text-amber-200">Custom / Practice Tool Session</strong>
                      <p className="text-[11px] text-text-muted mt-0.5">Leaves the custom lobby without sending a dodge penalty.</p>
                    </div>
                    <button
                      type="button"
                      disabled={activeAction === 'quit-custom'}
                      onClick={() => void runAction('quit-custom', 'Custom session closed.', lcuQuitCustomSession)}
                      className="btn-danger text-xs whitespace-nowrap"
                    >
                      {activeAction === 'quit-custom' ? <Loader2 className="animate-spin" /> : <CircleStop className="w-3.5 h-3.5" />}
                      <span>Quit Custom</span>
                    </button>
                  </div>
                )}

                {/* Post Game Actions */}
                {postGame && (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <strong className="text-xs font-black text-white">Post-Game Actions</strong>
                      <span className="text-[10px] text-primary font-bold">Match Finished</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => void runAction('play-again', 'Returning to lobby.', () => post('/api/lcu/play-again'))}
                        className="btn-primary text-xs"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>Play Again</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void loadHonorBallot()}
                        className="btn-secondary text-xs"
                      >
                        <Heart className="w-3.5 h-3.5" />
                        <span>Load Ballot</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveAction('rewards');
                          void post('/api/lcu/claim-event-rewards')
                            .then((result: { claimed?: number }) => {
                              showToast(result?.claimed ? `Claimed ${result.claimed} event rewards.` : 'No event rewards are waiting.');
                              return refreshState();
                            })
                            .catch((err: any) => showToast(err.message || 'Could not claim rewards.', false))
                            .finally(() => setActiveAction(''));
                        }}
                        className="btn-secondary text-xs"
                      >
                        <Gift className="w-3.5 h-3.5" />
                        <span>Claim Rewards</span>
                      </button>
                    </div>

                    {honorBallot && (
                      <div className="mt-2.5 p-3 rounded-xl bg-black/40 border border-white/[0.08] space-y-2">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-bold text-white flex items-center gap-1.5">
                            <Heart className="w-3 h-3 text-rose-400" /> Honor Teammate
                          </span>
                          <span className="text-text-dim text-[10px]">{honorBallot.votePool?.votes ?? 0} vote(s) available</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {[...(honorBallot.eligibleAllies || []), ...(honorBallot.eligibleOpponents || [])].map((player) => (
                            <button
                              type="button"
                              key={player.puuid}
                              disabled={activeAction === `honor-${player.puuid}`}
                              onClick={() => void honorPlayer(player)}
                              className="p-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] text-left flex items-center justify-between"
                            >
                              <div className="min-w-0">
                                <span className="text-[9px] text-text-dim block truncate">{player.championName}</span>
                                <strong className="text-xs text-white block truncate">{player.summonerName}</strong>
                              </div>
                              <Heart className="w-3.5 h-3.5 text-rose-400 shrink-0 ml-1.5" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Idle / Lobby Standby Info */}
                {!inChampSelect && !customSession && !postGame && (
                  <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-between">
                    <div>
                      <strong className="text-xs font-black text-white">Client Standing By</strong>
                      <p className="text-[11px] text-text-muted mt-0.5">
                        {connected ? `Current gameflow status: ${phase}` : 'Launch League client to connect controls.'}
                      </p>
                    </div>
                    <span className="px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider bg-white/[0.04] text-text-muted border border-white/[0.06]">
                      {phase}
                    </span>
                  </div>
                )}
              </section>
            )}

            {/* CARD: SAFE TOOLS & SETTINGS SNAPSHOTS */}
            {(activeCategory === 'all' || activeCategory === 'safety') && (
              <SafeToolsPanel />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
