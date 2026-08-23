import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, BellRing, Check, CheckCircle2, ChevronRight, CircleStop,
  Clock3, Gift, Heart, Loader2, MessageSquareText, Play,
  RefreshCw, ShieldCheck, Swords, Users,
  Wifi, WifiOff, XCircle,
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
import ConfirmModal from './ConfirmModal';
import ChampSelectWorkspace from './ChampSelectWorkspace';
import FriendsPanel from './FriendsPanel';
import type { ConfirmAction } from '../types';
import { useLCUConnection } from './lcuConnectionContext';

const ROLE_OPTIONS = [
  ['TOP', 'Top'],
  ['JUNGLE', 'Jungle'],
  ['MIDDLE', 'Mid'],
  ['BOTTOM', 'Bottom'],
  ['UTILITY', 'Support'],
  ['FILL', 'Fill'],
] as const;

const AVAILABILITY_OPTIONS = [
  ['chat', 'Online'],
  ['away', 'Away'],
  ['mobile', 'Mobile'],
  ['offline', 'Offline'],
] as const;

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

function Panel({
  icon: Icon,
  eyebrow,
  title,
  description,
  children,
  accent = 'gold',
  className = '',
  id,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description?: string;
  children: React.ReactNode;
  accent?: 'gold' | 'cyan' | 'violet' | 'rose' | 'emerald';
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`qol-panel qol-panel--${accent} ${className}`}>
      <div className="qol-panel__header">
        <div className="qol-panel__icon"><Icon /></div>
        <div className="min-w-0">
          <p className="qol-eyebrow">{eyebrow}</p>
          <h3>{title}</h3>
          {description && <p className="qol-panel__description">{description}</p>}
        </div>
      </div>
      <div className="qol-panel__body">{children}</div>
    </section>
  );
}

function Toggle({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="qol-toggle-row"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className={`qol-switch ${checked ? 'is-on' : ''}`} aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

function ActionButton({
  icon: Icon,
  children,
  onClick,
  loading,
  disabled,
  tone = 'primary',
  wide,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  tone?: 'primary' | 'neutral' | 'danger' | 'success';
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      className={`qol-action qol-action--${tone} ${wide ? 'qol-action--wide' : ''}`}
      onClick={onClick}
      disabled={disabled || loading}
    >
      {loading ? <Loader2 className="animate-spin" /> : <Icon />}
      <span>{children}</span>
      {!loading && tone !== 'danger' && <ChevronRight className="qol-action__arrow" />}
    </button>
  );
}

function ToastBar({ toast }: { toast: ToastState }) {
  if (!toast) return null;
  return (
    <div className={`qol-toast ${toast.ok ? 'is-success' : 'is-error'}`} role="status" aria-live="polite">
      {toast.ok ? <CheckCircle2 /> : <XCircle />}
      <span>{toast.message}</span>
    </div>
  );
}

const QOL_SECTIONS = [
  { id: 'qol-automation', label: 'Automation', icon: BellRing },
  { id: 'qol-queue', label: 'Queue', icon: Activity },
  { id: 'qol-social', label: 'Social', icon: MessageSquareText },
  { id: 'qol-champ-select', label: 'Champion Select', icon: Swords },
  { id: 'qol-post-game', label: 'Post Game', icon: Clock3 },
] as const;

function SectionRail({ phase, connected, automationCount }: { phase: string; connected: boolean; automationCount: number }) {
  const statuses: Record<string, string> = {
    'qol-automation': automationCount ? `${automationCount} active` : 'Standby',
    'qol-queue': phase === 'Matchmaking' ? 'Searching' : phase === 'Lobby' ? 'Lobby' : 'Standby',
    'qol-social': connected ? 'Connected' : 'Offline',
    'qol-champ-select': phase === 'ChampSelect' ? 'Live now' : 'Standby',
    'qol-post-game': ['EndOfGame', 'PreEndOfGame', 'WaitingForStats'].includes(phase) ? 'Open' : 'Standby',
  };

  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav className="qol-section-rail" aria-label="Quality of life sections">
      <div className="qol-section-rail__label"><span>CONTROL DECK</span><small>Jump to a workspace</small></div>
      <div className="qol-section-rail__items">
        {QOL_SECTIONS.map(({ id, label, icon: Icon }) => {
          const live = statuses[id] === 'Live now' || statuses[id] === 'Open' || statuses[id] === 'Searching';
          return (
            <button key={id} type="button" className={`qol-section-rail__item ${live ? 'is-live' : ''}`} onClick={() => jumpTo(id)}>
              <Icon />
              <span><strong>{label}</strong><small>{statuses[id]}</small></span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default function QoLPanel() {
  const [state, setState] = useState<QoLState | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [preferences, setPreferences] = useState<QoLPreferences>({ autoAccept: false, autoPlayAgain: false, autoHonor: false, autoStartQueue: false, autoClaimRewards: false, grindMode: false });
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
  const { qol: sharedQolState, connected: sharedConnected, refresh: refreshConnection } = useLCUConnection();

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

  const runAction = useCallback(async (
    key: string,
    successMessage: string,
    action: () => Promise<unknown>,
  ) => {
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
  }, [refreshState, showToast]);

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

  const loadHonorBallot = () => runAction('honor-load', 'Honor ballot loaded.', async () => {
    const response = await fetch('/api/lcu/honor-ballot');
    if (!response.ok) throw new Error(await readError(response, 'Honor is not available right now.'));
    setHonorBallot(await response.json());
  });

  const honorPlayer = (player: HonorPlayer) => runAction(`honor-${player.puuid}`, `${player.summonerName} honored.`, () =>
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
  const customQuitAvailable = customSession && ['Lobby', 'Matchmaking', 'ChampSelect', 'GameStart', 'Loading', 'InProgress', 'Reconnect'].includes(phase);
  const automationCount = [preferences.autoAccept, preferences.autoPlayAgain, preferences.autoHonor, preferences.autoStartQueue, preferences.autoClaimRewards].filter(Boolean).length;
  const nextMove = !connected
    ? 'Launch League Client to reconnect the control deck.'
    : readyCheck
      ? 'A ready check is waiting for your response.'
      : inChampSelect
        ? 'Champion Select is live — review your pick, ban, and loadout.'
        : postGame
          ? 'The match is finished — honor a player or return to the lobby.'
          : inLobby
            ? 'Lobby ready — set roles or start matchmaking.'
            : inQueue
              ? 'Matchmaking is running — RiftOps is watching the queue.'
              : 'League Client is connected and standing by.';

  const primaryAction = !connected
    ? { label: 'Reconnect to League', detail: 'The control deck will unlock as soon as the local client is ready.', tone: 'neutral', action: () => void refreshState(true) }
    : readyCheck
      ? { label: 'Accept ready check', detail: 'A match is waiting for your response.', tone: 'success', action: () => void runAction('accept', 'Ready check accepted.', lcuAutoAccept) }
      : inLobby
        ? { label: 'Start matchmaking', detail: `${firstRole} primary · ${secondRole} secondary`, tone: 'gold', action: () => void runAction('queue-start', 'Matchmaking started.', lcuAutoRequeue) }
        : inQueue
          ? { label: 'Stop matchmaking', detail: 'Cancel the active search and return to the lobby.', tone: 'neutral', action: () => void runAction('queue-stop', 'Matchmaking stopped.', lcuStopQueue) }
          : inChampSelect
            ? { label: 'Open champion select', detail: 'Review picks, bans, loadout, and dodge controls.', tone: 'rose', action: () => document.getElementById('qol-champ-select')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
            : postGame
              ? { label: 'Return to lobby', detail: 'Play again, honor a teammate, or claim rewards.', tone: 'gold', action: () => void runAction('play-again', 'Returning to lobby.', () => post('/api/lcu/play-again')) }
              : { label: 'Refresh League state', detail: 'Read the latest client phase and queue status.', tone: 'neutral', action: () => void refreshState(true) };

  return (
    <div className="qol-page">
      <ToastBar toast={toast} />
      {confirmAction && <ConfirmModal action={confirmAction} onClose={() => setConfirmAction(null)} />}

      <header className="qol-hero">
        <div className="qol-hero__glow" />
        <div className="qol-hero__content">
          <div>
            <p className="qol-eyebrow">LEAGUE CLIENT CONTROL</p>
            <h1>Quality of life, without the clutter.</h1>
            <p>Reliable client actions, live state, and opt-in automations in one focused workspace.</p>
          </div>
          <div className="qol-hero__status">
            <div className={`qol-connection ${connected ? 'is-online' : ''}`}>
              {connected ? <Wifi /> : <WifiOff />}
              <span>
                <small>{connected ? 'League connected' : 'Client unavailable'}</small>
                <strong>{phase}</strong>
              </span>
            </div>
            <button type="button" onClick={() => void refreshState(true)} disabled={refreshing} className="qol-refresh">
              <RefreshCw className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
        <div className="qol-phase-strip">
          <span className={inLobby ? 'is-active' : ''}>Lobby</span>
          <span className={inQueue || readyCheck ? 'is-active' : ''}>Queue</span>
          <span className={inChampSelect ? 'is-active' : ''}>Champion Select</span>
          <span className={phase === 'InProgress' ? 'is-active' : ''}>In Game</span>
          <span className={postGame ? 'is-active' : ''}>Post Game</span>
        </div>
      </header>

      {!connected && (
        <div className="qol-offline-banner">
          <WifiOff />
          <div>
            <strong>Launch League of Legends to unlock client controls</strong>
            <span>RiftOps will reconnect automatically as soon as the League client API is ready.</span>
          </div>
        </div>
      )}

      <section className="qol-command-deck" aria-label="Live League client summary">
        <div className="qol-command-deck__lead">
          <span className={`qol-command-deck__signal ${connected ? 'is-live' : ''}`}><span />{connected ? 'LIVE CLIENT SNAPSHOT' : 'CLIENT OFFLINE'}</span>
          <strong>{nextMove}</strong>
          <small>Actions stay phase-aware and are sent directly to the local League Client.</small>
        </div>
        <div className="qol-command-deck__metrics">
          <div><span>PHASE</span><strong>{phase}</strong><small>{connected ? 'LCU detected' : 'Waiting for LCU'}</small></div>
          <div><span>QUEUE</span><strong>{state?.queueState || (connected ? 'Idle' : '—')}</strong><small>{inQueue ? 'Searching now' : 'Current search state'}</small></div>
          <div><span>AUTOMATION</span><strong>{automationCount}/5</strong><small>{automationCount ? 'Rules active' : 'No rules enabled'}</small></div>
        </div>
      </section>

      <section className={`qol-priority-bar qol-priority-bar--${primaryAction.tone}`} aria-label="Recommended next action">
        <div className="qol-priority-bar__signal"><span />NEXT ACTION</div>
        <div className="qol-priority-bar__copy"><strong>{primaryAction.label}</strong><small>{primaryAction.detail}</small></div>
        <button type="button" onClick={primaryAction.action} disabled={activeAction !== ''} className="qol-priority-bar__button">
          {activeAction === 'accept' || activeAction === 'queue-start' || activeAction === 'queue-stop' || activeAction === 'play-again' ? <Loader2 className="animate-spin" /> : <ChevronRight />}
          <span>{primaryAction.label}</span>
        </button>
      </section>

      <SectionRail phase={phase} connected={connected} automationCount={automationCount} />

      <div className="qol-grid">
        <Panel
          id="qol-automation"
          icon={BellRing}
          eyebrow="AUTOMATION"
          title="Set it once"
          description="These preferences stay active while RiftOps is running, even when this page is closed."
          accent="gold"
        >
          <div className="qol-stack">
            <Toggle
              title="Grind mode"
              description="Auto-accept, auto-honor, play again, start queue, and claim rewards — one toggle for the full loop."
              checked={preferences.grindMode}
              disabled={preferencesLoading}
              onChange={(grindMode) => void updatePreferences({ ...preferences, grindMode })}
            />
            <Toggle
              title="Auto-accept ready checks"
              description="Accept a queue pop as soon as League enters Ready Check."
              checked={preferences.autoAccept}
              disabled={preferencesLoading}
              onChange={(autoAccept) => void updatePreferences({ ...preferences, autoAccept })}
            />
            <Toggle
              title="Auto return to lobby"
              description="Use Play Again automatically when the post-game screen is ready."
              checked={preferences.autoPlayAgain}
              disabled={preferencesLoading}
              onChange={(autoPlayAgain) => void updatePreferences({ ...preferences, autoPlayAgain })}
            />
            <Toggle
              title="Auto-honor first teammate"
              description="Automatically honor the first eligible ally after each game."
              checked={preferences.autoHonor}
              disabled={preferencesLoading}
              onChange={(autoHonor) => void updatePreferences({ ...preferences, autoHonor })}
            />
            <Toggle
              title="Auto-start queue"
              description="Automatically start matchmaking when you return to a lobby."
              checked={preferences.autoStartQueue}
              disabled={preferencesLoading}
              onChange={(autoStartQueue) => void updatePreferences({ ...preferences, autoStartQueue })}
            />
            <Toggle
              title="Auto-claim event rewards"
              description="Claim available event-track rewards after each game cycle."
              checked={preferences.autoClaimRewards}
              disabled={preferencesLoading}
              onChange={(autoClaimRewards) => void updatePreferences({ ...preferences, autoClaimRewards })}
            />
          </div>
        </Panel>

        <Panel
          id="qol-queue"
          icon={Activity}
          eyebrow="LIVE ACTION"
          title="Queue command"
          description={`Current search state: ${state?.queueState || (connected ? 'Idle' : 'Unavailable')}`}
          accent="cyan"
        >
          <div className="qol-action-grid">
            <ActionButton
              icon={Check}
              tone="success"
              disabled={!readyCheck}
              loading={activeAction === 'accept'}
              onClick={() => void runAction('accept', 'Ready check accepted.', lcuAutoAccept)}
            >
              Accept ready check
            </ActionButton>
            <ActionButton
              icon={Play}
              disabled={!inLobby}
              loading={activeAction === 'queue-start'}
              onClick={() => void runAction('queue-start', 'Matchmaking started.', lcuAutoRequeue)}
            >
              Start queue
            </ActionButton>
            <ActionButton
              icon={CircleStop}
              tone="neutral"
              disabled={!inQueue}
              loading={activeAction === 'queue-stop'}
              onClick={() => void runAction('queue-stop', 'Matchmaking stopped.', lcuStopQueue)}
            >
              Stop queue
            </ActionButton>
          </div>
          <div className="qol-form-group">
            <div className="qol-form-heading">
              <span><Users /> Position preferences</span>
              <small>Available in a matchmade lobby</small>
            </div>
            <div className="qol-inline-form">
              <select value={firstRole} disabled={!inLobby} onChange={(event) => setFirstRole(event.target.value)}>
                {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label} (primary)</option>)}
              </select>
              <select value={secondRole} disabled={!inLobby} onChange={(event) => setSecondRole(event.target.value)}>
                {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label} (secondary)</option>)}
              </select>
              <ActionButton
                icon={ShieldCheck}
                disabled={!inLobby || firstRole === secondRole}
                loading={activeAction === 'roles'}
                onClick={() => void runAction('roles', 'Position preferences saved.', () => lcuAutoRoles(firstRole, secondRole))}
              >
                Save roles
              </ActionButton>
            </div>
            {firstRole === secondRole && <p className="qol-field-error">Primary and secondary roles must be different.</p>}
          </div>
          <div className="qol-form-group" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.055)' }}>
            <div className="qol-form-heading">
              <span><Users /> Queue role presets</span>
              <small>Saved roles apply automatically when entering a lobby</small>
            </div>
            <div className="qol-inline-form">
              <select value={presetQueue} onChange={(event) => {
                const q = event.target.value;
                setPresetQueue(q);
                const preset = queuePresets[q];
                if (preset) { setPresetFirst(preset.first); setPresetSecond(preset.second); }
              }}>
                {Object.entries(queueLabels).map(([key, label]) => (
                  <option key={key} value={key}>{label}{queuePresets[key] ? ' ✓' : ''}</option>
                ))}
              </select>
              <select value={presetFirst} onChange={(event) => setPresetFirst(event.target.value)}>
                {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label} (primary)</option>)}
              </select>
              <select value={presetSecond} onChange={(event) => setPresetSecond(event.target.value)}>
                {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label} (secondary)</option>)}
              </select>
              <ActionButton
                icon={ShieldCheck}
                disabled={presetFirst === presetSecond}
                loading={activeAction === `preset-${presetQueue}`}
                onClick={() => void runAction(`preset-${presetQueue}`, `Roles saved for ${queueLabels[presetQueue] || presetQueue}.`, async () => {
                  const result = await saveQueuePreset(presetQueue, presetFirst, presetSecond);
                  setQueuePresets(result);
                })}
              >
                Save preset
              </ActionButton>
            </div>
            {presetFirst === presetSecond && <p className="qol-field-error">Primary and secondary roles must be different.</p>}
          </div>
        </Panel>

        <FriendsPanel id="qol-social" connected={connected} />

        <Panel
          id="qol-social-presence"
          icon={MessageSquareText}
          eyebrow="SOCIAL"
          title="Presence and profile message"
          description="The controls reflect your live League chat state instead of assuming a default."
          accent="emerald"
        >
          <div className="qol-form-group">
            <label>Presence</label>
            <div className="qol-segmented">
              {AVAILABILITY_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  disabled={!connected || activeAction === 'presence'}
                  className={state?.availability === value ? 'is-selected' : ''}
                  onClick={() => void runAction('presence', `Presence set to ${label}.`, () =>
                    post('/api/lcu/availability', { availability: value }),
                  )}
                >
                  <span className={`qol-presence-dot qol-presence-dot--${value}`} />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="qol-form-group">
            <label htmlFor="qol-status-message">Status message</label>
            <div className="qol-input-action">
              <input
                id="qol-status-message"
                value={statusMessage}
                maxLength={128}
                disabled={!connected}
                placeholder="What should friends see?"
                onChange={(event) => setStatusMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void runAction('status', 'Status message updated.', () =>
                      post('/api/lcu/status-message', { message: statusMessage.trim() }),
                    );
                  }
                }}
              />
              <ActionButton
                icon={Check}
                disabled={!connected || !statusMessage.trim()}
                loading={activeAction === 'status'}
                onClick={() => void runAction('status', 'Status message updated.', () =>
                  post('/api/lcu/status-message', { message: statusMessage.trim() }),
                )}
              >
                Update
              </ActionButton>
            </div>
            <small className="qol-character-count">{statusMessage.length}/128</small>
          </div>
        </Panel>

        <Panel
          id="qol-champion-dodge"
          icon={Swords}
          eyebrow="CHAMPION SELECT"
          title={customSession ? 'Custom / Practice exit' : 'Dodge control'}
          description={customSession ? 'Leave a custom or Practice Tool session using its dedicated LCU action.' : 'This action is unlocked only while League reports an active champion select.'}
          accent="rose"
        >
          <div className="qol-danger-box">
            {customSession ? <>
              <div>
                <strong>Quit custom / Practice Tool</strong>
                <span>Leaves the custom session without sending a normal matchmade dodge.</span>
              </div>
              <ActionButton
                icon={CircleStop}
                tone="danger"
                disabled={!customQuitAvailable}
                loading={activeAction === 'quit-custom'}
                onClick={() => void runAction('quit-custom', 'Custom/practice session closed.', lcuQuitCustomSession)}
              >
                Quit custom game
              </ActionButton>
            </> : <>
              <div>
                <strong>Leave champion select</strong>
                <span>Riot applies the current queue and LP penalties. RiftOps never bypasses them.</span>
              </div>
              <ActionButton
                icon={CircleStop}
                tone="danger"
                disabled={!inChampSelect}
                loading={activeAction === 'dodge'}
                onClick={() => setConfirmAction({
                  open: true,
                  title: 'Dodge this champion select?',
                  message: 'League will apply its current dodge penalties. This cannot be undone.',
                  actionLabel: 'Dodge game',
                  danger: true,
                  onConfirm: () => {
                    setConfirmAction(null);
                    void runAction('dodge', 'Dodge request accepted by League.', () => post('/api/lcu/dodge'));
                  },
                })}
              >
                Dodge game
              </ActionButton>
            </>}
          </div>
        </Panel>

        <div id="qol-champ-select" className="qol-anchor-wrap"><ChampSelectWorkspace connected={connected} active={inChampSelect} onToast={(message, type) => showToast(message, type !== 'error')} /></div>

        <Panel
          id="qol-post-game"
          icon={Clock3}
          eyebrow="POST GAME"
          title="Finish the loop"
          description="Return to lobby, honor a player, and collect available event-track rewards."
          accent="gold"
        >
          <div className="qol-action-grid">
            <ActionButton
              icon={Play}
              disabled={phase !== 'EndOfGame'}
              loading={activeAction === 'play-again'}
              onClick={() => void runAction('play-again', 'Returning to lobby.', () => post('/api/lcu/play-again'))}
            >
              Play again
            </ActionButton>
            <ActionButton
              icon={Heart}
              tone="neutral"
              disabled={!postGame}
              loading={activeAction === 'honor-load'}
              onClick={() => void loadHonorBallot()}
            >
              Load honor ballot
            </ActionButton>
            <ActionButton
              icon={Gift}
              tone="success"
              disabled={!connected}
              loading={activeAction === 'rewards'}
              onClick={() => {
                setActiveAction('rewards');
                void post('/api/lcu/claim-event-rewards')
                  .then((result: { claimed?: number }) => {
                    showToast(result?.claimed ? `Claimed ${result.claimed} event rewards.` : 'No event rewards are waiting.');
                    return refreshState();
                  })
                  .catch((error: any) => showToast(error.message || 'Event rewards could not be claimed.', false))
                  .finally(() => setActiveAction(''));
              }}
            >
              Claim event rewards
            </ActionButton>
          </div>

          {honorBallot && (
            <div className="qol-honor">
              <div className="qol-form-heading">
                <span><Heart /> Honor a player</span>
                <small>{honorBallot.votePool?.votes ?? 0} vote(s) available</small>
              </div>
              <div className="qol-honor-grid">
                {[...(honorBallot.eligibleAllies || []), ...(honorBallot.eligibleOpponents || [])].map((player) => (
                  <button
                    type="button"
                    key={player.puuid}
                    disabled={activeAction === `honor-${player.puuid}`}
                    onClick={() => void honorPlayer(player)}
                  >
                    <span>{player.championName || `Champion ${player.championId}`}</span>
                    <strong>{player.summonerName}</strong>
                    {activeAction === `honor-${player.puuid}` ? <Loader2 className="animate-spin" /> : <Heart />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
