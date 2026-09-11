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
  { key: 'None', label: 'MENU' },
  { key: 'Lobby', label: 'LOBBY' },
  { key: 'Matchmaking', label: 'QUEUE' },
  { key: 'ReadyCheck', label: 'READY' },
  { key: 'ChampSelect', label: 'DRAFT' },
  { key: 'InProgress', label: 'IN GAME' },
  { key: 'EndOfGame', label: 'POST GAME' },
] as const;

function formatPhaseLabel(rawPhase?: string): string {
  if (!rawPhase || rawPhase === 'None' || rawPhase === 'Disconnected') return 'Client Menu';
  switch (rawPhase) {
    case 'Lobby': return 'Party Lobby';
    case 'Matchmaking': return 'In Queue';
    case 'ReadyCheck': return 'Ready Check';
    case 'ChampSelect': return 'Champion Select';
    case 'InProgress': return 'In Game';
    case 'EndOfGame':
    case 'PreEndOfGame':
    case 'WaitingForStats': return 'Post Game';
    default: return rawPhase.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
}

function formatDisplayStatus(rawPhase?: string, rawQueueState?: string, isConnected = false): string {
  if (!isConnected) return 'League client offline';
  const q = (rawQueueState || '').trim();
  if (q && !['invalid', 'none', 'default'].includes(q.toLowerCase())) {
    return q;
  }
  const p = (rawPhase || '').trim();
  switch (p) {
    case 'Lobby': return 'In Party Lobby';
    case 'Matchmaking': return 'Searching for match...';
    case 'ReadyCheck': return 'Match ready!';
    case 'ChampSelect': return 'In Champion Select';
    case 'InProgress': return 'Match in progress';
    case 'EndOfGame':
    case 'PreEndOfGame':
    case 'WaitingForStats': return 'Post-game results';
    case 'None':
    default: return 'Standing by in Menu';
  }
}

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
        detail: (state?.queueState && !['invalid', 'none'].includes(state.queueState.toLowerCase())) ? state.queueState : 'Searching for match...',
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
        detail: 'League connected & idle',
        tone: 'neutral' as const,
        action: () => void refreshState(true),
      };

  const isCurrentPhase = (key: string) => {
    if (!connected) return false;
    if (key === 'None') return !phase || phase === 'None';
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
    <div className="flex-1 overflow-y-auto p-4 md:p-6 flex flex-col gap-4 min-h-full">
      {/* Toast Feedback */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur-md text-xs font-bold transition-all animate-fadeIn ${
            toast.ok
              ? 'bg-emerald-950/90 border-emerald-500/30 text-emerald-200'
              : 'bg-rose-950/90 border-rose-500/30 text-rose-200'
          }`}
          role="status"
          aria-live="polite"
        >
          {toast.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-rose-400" />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmAction && <ConfirmModal action={confirmAction} onClose={() => setConfirmAction(null)} />}

      {/* Top Header */}
      <PageHeader
        icon={Sparkles}
        eyebrow="AUTOMATIONS & UTILITIES"
        title="Quality of Life"
        description="Automate repetitive League client tasks, save queue position presets, manage chat presence, and create safe settings snapshots."
        meta={
          <StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>
            {connected
              ? (phase && phase !== 'None' && phase !== 'Disconnected'
                  ? `Phase: ${formatPhaseLabel(phase)}`
                  : 'League Ready')
              : 'League offline'}
          </StatusBadge>
        }
        actions={
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-extrabold text-amber-200 bg-primary/10 border border-primary/30">
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
      <section className="flex items-center justify-between gap-4 px-3.5 py-2.5 rounded-xl border border-white/[0.08] bg-gradient-to-r from-[#081626]/90 to-[#050e19]/95 shadow-lg flex-wrap sm:flex-nowrap" aria-label="League Client live pipeline">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="text-[9px] font-black tracking-widest text-primary pr-2 border-r border-white/[0.08] shrink-0">PHASE</span>
          <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 scrollbar-none">
            {PHASES.map(({ key, label }) => {
              const active = isCurrentPhase(key);
              return (
                <div key={key} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[9px] font-extrabold tracking-wider transition shrink-0 ${active ? 'text-amber-200 bg-primary/15 border border-primary/35 shadow-sm' : 'text-slate-400 bg-white/[0.03] border border-transparent'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-amber-300 shadow-[0_0_8px_currentColor]' : 'bg-current opacity-40'}`} />
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-slate-300">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-slate-500'}`} />
            <span className="truncate max-w-[200px] text-xs font-semibold">
              {formatDisplayStatus(state?.phase, state?.queueState, connected)}
            </span>
          </div>
          <button
            type="button"
            onClick={primaryAction.action}
            disabled={activeAction !== ''}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-black transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              primaryAction.tone === 'success'
                ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/20 hover:bg-emerald-400'
                : primaryAction.tone === 'danger'
                ? 'bg-rose-600 text-white hover:bg-rose-500'
                : primaryAction.tone === 'gold'
                ? 'btn-primary'
                : primaryAction.tone === 'rose'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30 hover:bg-rose-500/30'
                : 'bg-white/[0.08] text-slate-200 hover:bg-white/[0.12] border border-white/10'
            }`}
          >
            {activeAction ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <span>{primaryAction.label}</span>
          </button>
        </div>
      </section>

      {/* Section Filter Tabs */}
      <nav className="flex items-center gap-1.5 overflow-x-auto p-1.5 rounded-xl bg-[#040c16]/60 border border-white/[0.06]" aria-label="QoL section filters">
        {CATEGORIES.map(({ id, label, icon: Icon }) => {
          const active = activeCategory === id;
          return (
            <button
              key={id}
              type="button"
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer whitespace-nowrap ${
                active
                  ? 'text-white bg-primary/20 border border-primary/35 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
              }`}
              onClick={() => setActiveCategory(id)}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Main 2-Column Cockpit Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-4 items-start">
        {/* ══════════════════════════════════════════════════════
            COLUMN 1: AUTOMATIONS & MATCHMAKING
            ══════════════════════════════════════════════════════ */}
        {(activeCategory === 'all' || activeCategory === 'automations' || activeCategory === 'queue') && (
          <div className="flex flex-col gap-4 min-w-0">
            {/* CARD: AUTOMATIONS ENGINE */}
            {(activeCategory === 'all' || activeCategory === 'automations') && (
              <section className="glass-card flex flex-col gap-3.5 p-4 md:p-5 rounded-2xl">
                <div className="flex items-center gap-3 border-b border-white/[0.06] pb-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-primary/10 border border-primary/25 text-primary">
                    <BellRing className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-[9px] font-black tracking-widest text-text-muted uppercase block">CONTINUOUS LOOP</span>
                    <h3 className="text-base font-bold text-white leading-tight">Automations Engine</h3>
                    <p className="text-[11px] text-text-muted mt-0.5">Opt-in automation rules that run smoothly in the background.</p>
                  </div>
                </div>

                {/* Master Grind Mode Banner */}
                <div className={`p-4 rounded-xl border flex items-center justify-between gap-4 transition ${
                  preferences.grindMode
                    ? 'bg-amber-500/10 border-amber-500/30 shadow-[0_0_20px_rgba(200,170,110,0.1)]'
                    : 'bg-white/[0.02] border-white/[0.06]'
                }`}>
                  <div className="min-w-0 flex-1">
                    <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/30 mb-1">
                      <Flame className="w-3 h-3 text-amber-300" />
                      <span>MASTER LOOP</span>
                    </div>
                    <h4 className="text-sm font-bold text-white">Grind Mode</h4>
                    <p className="text-[11px] text-text-muted mt-0.5 leading-relaxed">
                      Full automated loop: auto-accept queue pops, return to lobby, honor teammates, auto-requeue, and claim rewards.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={preferences.grindMode}
                    disabled={preferencesLoading}
                    onClick={() => void updatePreferences({ ...preferences, grindMode: !preferences.grindMode })}
                    className="flex items-center gap-2 cursor-pointer shrink-0 disabled:opacity-50"
                  >
                    <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${preferences.grindMode ? 'bg-primary' : 'bg-white/20'}`}>
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${preferences.grindMode ? 'translate-x-4' : 'translate-x-1'}`} />
                    </span>
                    <span className="text-[11px] font-black text-slate-300 w-12">{preferences.grindMode ? 'ACTIVE' : 'OFF'}</span>
                  </button>
                </div>

                {/* Granular Rules Stack */}
                <div className="flex flex-col gap-2">
                  {AUTOMATION_RULES.map(({ key, title, description, icon: Icon, accent }) => {
                    const isChecked = Boolean(preferences[key]);
                    return (
                      <div
                        key={key}
                        className={`flex items-center justify-between gap-3 p-3 rounded-xl border transition ${
                          isChecked ? 'bg-white/[0.04] border-primary/25' : 'bg-white/[0.015] border-white/[0.05] opacity-75 hover:opacity-100'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center border"
                            style={{ color: accent, borderColor: `${accent}40`, backgroundColor: `${accent}14` }}
                          >
                            <Icon className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <strong className="block text-xs font-bold text-white">{title}</strong>
                            <small className="block text-[11px] text-text-muted truncate">{description}</small>
                          </div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isChecked}
                          disabled={preferencesLoading}
                          onClick={() => void updatePreferences({ ...preferences, [key]: !isChecked })}
                          className="flex items-center gap-2 cursor-pointer shrink-0 disabled:opacity-50"
                        >
                          <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${isChecked ? 'bg-primary' : 'bg-white/20'}`}>
                            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${isChecked ? 'translate-x-4' : 'translate-x-1'}`} />
                          </span>
                          <span className="text-[10px] font-extrabold text-slate-400 w-6">{isChecked ? 'ON' : 'OFF'}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* CARD: QUEUE & POSITIONS */}
            {(activeCategory === 'all' || activeCategory === 'queue') && (
              <section className="glass-card flex flex-col gap-3.5 p-4 md:p-5 rounded-2xl">
                <div className="flex items-center gap-3 border-b border-white/[0.06] pb-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-cyan-500/10 border border-cyan-500/25 text-cyan-400">
                    <Activity className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-[9px] font-black tracking-widest text-text-muted uppercase block">MATCHMAKING</span>
                    <h3 className="text-base font-bold text-white leading-tight">Queue Command & Roles</h3>
                    <p className="text-[11px] text-text-muted mt-0.5">Live matchmaking controls, position assignment, and saved role presets.</p>
                  </div>
                </div>

                {/* Quick Matchmaking Actions */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <button
                    type="button"
                    disabled={!readyCheck}
                    onClick={() => void runAction('accept', 'Ready check accepted.', lcuAutoAccept)}
                    className="btn-primary flex items-center justify-center gap-2 text-xs py-2"
                  >
                    {activeAction === 'accept' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    <span>Accept Ready Check</span>
                  </button>
                  <button
                    type="button"
                    disabled={!inLobby}
                    onClick={() => void runAction('queue-start', 'Matchmaking started.', lcuAutoRequeue)}
                    className="btn-primary flex items-center justify-center gap-2 text-xs py-2"
                  >
                    {activeAction === 'queue-start' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    <span>Start Queue</span>
                  </button>
                  <button
                    type="button"
                    disabled={!inQueue}
                    onClick={() => void runAction('queue-stop', 'Matchmaking stopped.', lcuStopQueue)}
                    className="btn-secondary flex items-center justify-center gap-2 text-xs py-2"
                  >
                    {activeAction === 'queue-stop' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CircleStop className="w-3.5 h-3.5" />}
                    <span>Cancel Queue</span>
                  </button>
                </div>

                {/* Live Lobby Position Selector */}
                <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex flex-col gap-2.5">
                  <div className="flex items-center justify-between text-xs font-bold text-white">
                    <span className="flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-primary" /> Active Lobby Positions
                    </span>
                    <small className="text-[10px] text-text-dim font-normal">Syncs directly to your current League party</small>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                    <div>
                      <label className="text-[10px] uppercase font-bold text-text-muted block mb-1">Primary Role</label>
                      <select
                        value={firstRole}
                        disabled={!inLobby}
                        onChange={(e) => setFirstRole(e.target.value)}
                        className="w-full text-xs"
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
                        className="w-full text-xs"
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
                <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] flex flex-col gap-2.5 mt-3">
                  <div className="flex items-center justify-between text-xs font-bold text-white">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-300" /> Queue Role Presets
                    </span>
                    <small className="text-[10px] text-text-dim font-normal">Auto-applies when you enter a matching queue</small>
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
                        className="w-full text-xs"
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
                        className="w-full text-xs"
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
                        className="w-full text-xs"
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
                      {activeAction === `preset-${presetQueue}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
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
          <div className="flex flex-col gap-4 min-w-0">
            {/* CARD: SOCIAL PRESENCE */}
            {(activeCategory === 'all' || activeCategory === 'social') && (
              <section className="glass-card flex flex-col gap-3.5 p-4 md:p-5 rounded-2xl">
                <div className="flex items-center gap-3 border-b border-white/[0.06] pb-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-emerald-500/10 border border-emerald-500/25 text-emerald-400">
                    <MessageSquareText className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-[9px] font-black tracking-widest text-text-muted uppercase block">SOCIAL PRESENCE</span>
                    <h3 className="text-base font-bold text-white leading-tight">Chat Availability & Status</h3>
                    <p className="text-[11px] text-text-muted mt-0.5">Live visibility controls synchronized directly with the League chat service.</p>
                  </div>
                </div>

                {/* Availability Segmented Buttons */}
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase font-bold text-text-muted block">Availability</label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {AVAILABILITY_OPTIONS.map(({ value, label, color }) => {
                      const isSelected = state?.availability === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          disabled={!connected || activeAction === 'presence'}
                          className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold border transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                            isSelected
                              ? 'bg-white/[0.08] border-primary/50 text-white shadow-sm'
                              : 'bg-white/[0.02] border-white/[0.06] text-slate-400 hover:text-white hover:bg-white/[0.04]'
                          }`}
                          onClick={() =>
                            void runAction('presence', `Availability set to ${label}.`, () =>
                              post('/api/lcu/availability', { availability: value }),
                            )
                          }
                        >
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: color, boxShadow: isSelected ? `0 0 8px ${color}` : 'none' }}
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
                      className="flex-1 text-xs"
                    />
                    <button
                      type="button"
                      disabled={!connected || !statusMessage.trim() || activeAction === 'status'}
                      onClick={() =>
                        void runAction('status', 'Status message updated.', () =>
                          post('/api/lcu/status-message', { message: statusMessage.trim() }),
                        )
                      }
                      className="btn-primary text-xs flex items-center gap-1.5"
                    >
                      {activeAction === 'status' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      <span>Update</span>
                    </button>
                  </div>
                </div>
              </section>
            )}

            {/* CARD: SESSION MATCH CONTROLS */}
            {(activeCategory === 'all' || activeCategory === 'safety') && (
              <section className="glass-card flex flex-col gap-3.5 p-4 md:p-5 rounded-2xl">
                <div className="flex items-center gap-3 border-b border-white/[0.06] pb-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-rose-500/10 border border-rose-500/25 text-rose-400">
                    <Swords className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-[9px] font-black tracking-widest text-text-muted uppercase block">ACTIVE SESSION</span>
                    <h3 className="text-base font-bold text-white leading-tight">Game Phase & Match Controls</h3>
                    <p className="text-[11px] text-text-muted mt-0.5">Actions context-aware of the current gameflow phase.</p>
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
