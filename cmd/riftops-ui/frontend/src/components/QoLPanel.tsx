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
  ShieldCheck,
  Sparkles,
  Swords,
  XCircle,
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
  ['TOP', 'Top lane', '🛡️'],
  ['JUNGLE', 'Jungle', '🌲'],
  ['MIDDLE', 'Mid lane', '⚡'],
  ['BOTTOM', 'Bottom lane', '🏹'],
  ['UTILITY', 'Support', '✨'],
  ['FILL', 'Fill any role', '🎲'],
] as const;

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
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : null;
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
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={onChange} className="qol-switch">
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
  const [toast, setToast] = useState<ToastState>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const statusHydrated = useRef(false);
  const rolesHydrated = useRef(false);
  const [firstRole, setFirstRole] = useState('MIDDLE');
  const [secondRole, setSecondRole] = useState('TOP');
  const [honorBallot, setHonorBallot] = useState<HonorBallot | null>(null);
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
      setConnected(sharedConnected);
      setState(sharedQolState);
      if (sharedQolState && !statusHydrated.current) {
        setStatusMessage(sharedQolState.statusMessage || '');
        statusHydrated.current = true;
      }
      if (sharedQolState?.firstRole && !rolesHydrated.current) {
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

  const runAction = useCallback(async (key: string, successMessage: string, action: () => Promise<unknown>) => {
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

  const honorPlayer = (player: HonorPlayer) => runAction(`honor-${player.puuid}`, `${player.summonerName} honored.`, () => post('/api/lcu/honor-player', {
    summonerId: player.summonerId,
    puuid: player.puuid,
    gameId: honorBallot?.gameId,
    honorType: 'HEART',
  }));

  const phase = state?.phase || 'Disconnected';
  const inLobby = phase === 'Lobby';
  const inQueue = phase === 'Matchmaking';
  const readyCheck = phase === 'ReadyCheck';
  const inChampSelect = phase === 'ChampSelect';
  const postGame = ['EndOfGame', 'PreEndOfGame', 'WaitingForStats'].includes(phase);
  const customSession = Boolean(state?.isCustom || state?.queueId === 3140);
  const customQuitAvailable = customSession && ['Lobby', 'Matchmaking', 'ChampSelect', 'GameStart', 'Loading', 'InProgress', 'Reconnect'].includes(phase);
  const automationCount = [preferences.autoPlayAgain, preferences.autoHonor, preferences.autoClaimRewards, preferences.grindMode].filter(Boolean).length;

  const primaryAction = !connected
    ? { label: 'Reconnect to League', tone: 'neutral' as const, action: () => void refreshState(true) }
    : readyCheck
      ? { label: 'Accept ready check', tone: 'success' as const, action: () => void runAction('accept', 'Ready check accepted.', lcuAutoAccept) }
      : inLobby
        ? { label: 'Start matchmaking', tone: 'gold' as const, action: () => void runAction('queue-start', 'Matchmaking started.', lcuAutoRequeue) }
        : inQueue
          ? { label: 'Cancel queue', tone: 'danger' as const, action: () => void runAction('queue-stop', 'Matchmaking stopped.', lcuStopQueue) }
          : inChampSelect
            ? { label: 'Open live draft', tone: 'rose' as const, action: () => onOpenLive?.() }
            : postGame
              ? { label: 'Return to lobby', tone: 'gold' as const, action: () => void runAction('play-again', 'Returning to lobby.', () => post('/api/lcu/play-again')) }
              : { label: 'Refresh status', tone: 'neutral' as const, action: () => void refreshState(true) };

  const primaryClass = `qol-primary-action tone-${primaryAction.tone}`;
  const updateStatus = () => {
    const next = statusMessage.trim();
    if (!next) return;
    void runAction('status', 'Status message updated.', () => post('/api/lcu/status-message', { message: next }));
  };

  return (
    <div className="qol-page">
      {confirmAction && <ConfirmModal action={confirmAction} onClose={() => setConfirmAction(null)} />}

      <PageHeader
        icon={Sparkles}
        eyebrow="AUTOMATIONS & UTILITIES"
        title="Quality of Life"
        description="Keep the routine parts of a League session quiet, visible, and under your control."
        meta={<StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>{connected ? formatPhaseLabel(phase) : 'League offline'}</StatusBadge>}
        actions={<button type="button" className="page-header__button" onClick={() => void refreshState(true)} disabled={refreshing}><RefreshCw className={refreshing ? 'animate-spin' : ''} /> Refresh</button>}
      />

      {toast && (
        <div className={`qol-inline-feedback ${toast.ok ? 'is-success' : 'is-error'}`} role="status" aria-live="polite">
          {toast.ok ? <CheckCircle2 /> : <XCircle />}
          <span>{toast.message}</span>
        </div>
      )}

      <section className="qol-status-strip" aria-label="League client status">
        <div className="qol-status-strip__phase">
          <span className={`qol-status-dot ${connected ? 'is-live' : ''}`} />
          <div><small>{connected ? 'League client' : 'Connection'}</small><strong>{formatDisplayStatus(state?.phase, state?.queueState, connected)}</strong></div>
        </div>
        <div className="qol-status-strip__metrics">
          <span><b>{automationCount}/4</b> routine automations</span>
          <span><b>{state?.firstRole || '—'}</b> / {state?.secondRole || '—'}</span>
        </div>
        <button type="button" className={primaryClass} onClick={primaryAction.action} disabled={activeAction !== ''}>
          {activeAction ? <Loader2 className="animate-spin" /> : <ChevronRight />}
          {primaryAction.label}
        </button>
      </section>

      <div className="qol-task-list">
        <section className="qol-task-group qol-task-group--match" aria-labelledby="qol-match-heading">
          <header className="qol-task-group__header">
            <div className="qol-task-group__icon"><BellRing /></div>
            <div><h2 id="qol-match-heading">Match flow</h2><p>Return, honor, and reward actions that happen after a match.</p></div>
            <span className="qol-task-group__summary"><Flame /> {preferences.grindMode ? 'Grind mode on' : 'Manual session'}</span>
          </header>

          <div className="qol-task-group__body">
            <SwitchRow title="Grind mode" description="Run the full post-game loop: return, honor, requeue, and claim rewards." checked={preferences.grindMode} disabled={preferencesLoading} accent="gold" onChange={() => void updatePreferences({ ...preferences, grindMode: !preferences.grindMode })} />

            <div className="qol-owner-link">
              <div><strong>Queue automation lives in Play & Queue</strong><span>Auto-accept, roles, picks, bans, and full auto stay beside your queue choices.</span></div>
              {onOpenPlayFlow && <button type="button" className="btn-secondary" onClick={onOpenPlayFlow}><Swords /> Open Play & Queue</button>}
            </div>

            <div className="qol-rule-list" aria-label="Post-game automation rules">
              <SwitchRow title="Return to lobby" description="Use Play Again when the post-game summary is ready." checked={preferences.autoPlayAgain} disabled={preferencesLoading} accent="teal" onChange={() => void updatePreferences({ ...preferences, autoPlayAgain: !preferences.autoPlayAgain })} />
              <SwitchRow title="Honor first teammate" description="Honor the first eligible ally after each completed match." checked={preferences.autoHonor} disabled={preferencesLoading} accent="rose" onChange={() => void updatePreferences({ ...preferences, autoHonor: !preferences.autoHonor })} />
              <SwitchRow title="Claim event rewards" description="Claim unlocked battle-pass and event-track rewards after a game." checked={preferences.autoClaimRewards} disabled={preferencesLoading} accent="violet" onChange={() => void updatePreferences({ ...preferences, autoClaimRewards: !preferences.autoClaimRewards })} />
            </div>

            <details className="qol-disclosure">
              <summary><span><Activity /> Queue & roles</span><small>Live actions, party roles, and saved presets</small></summary>
              <div className="qol-disclosure__body">
                <div className="qol-action-grid">
                  <button type="button" className="btn-primary" disabled={!readyCheck} onClick={() => void runAction('accept', 'Ready check accepted.', lcuAutoAccept)}><Check /> Accept ready check</button>
                  <button type="button" className="btn-primary" disabled={!inLobby} onClick={() => void runAction('queue-start', 'Matchmaking started.', lcuAutoRequeue)}><Play /> Start queue</button>
                  <button type="button" className="btn-secondary" disabled={!inQueue} onClick={() => void runAction('queue-stop', 'Matchmaking stopped.', lcuStopQueue)}><CircleStop /> Cancel queue</button>
                </div>

                <div className="qol-subsection">
                  <div className="qol-subsection__heading"><strong>Active lobby roles</strong><span>Sync directly to your current League party.</span></div>
                  <div className="qol-field-grid">
                    <label>Primary role<select value={firstRole} disabled={!inLobby} onChange={(event) => setFirstRole(event.target.value)}>{ROLE_OPTIONS.map(([value, label, icon]) => <option key={value} value={value}>{icon} {label}</option>)}</select></label>
                    <label>Secondary role<select value={secondRole} disabled={!inLobby} onChange={(event) => setSecondRole(event.target.value)}>{ROLE_OPTIONS.map(([value, label, icon]) => <option key={value} value={value}>{icon} {label}</option>)}</select></label>
                  </div>
                  {firstRole === secondRole && <p className="qol-field-error">Primary and secondary roles must be different.</p>}
                  <div className="qol-subsection__actions"><button type="button" className="btn-secondary" disabled={!inLobby || firstRole === secondRole} onClick={() => void runAction('roles', 'Lobby roles synced.', () => lcuAutoRoles(firstRole, secondRole))}><Check /> Sync roles to lobby</button></div>
                </div>

                <div className="qol-subsection">
                  <div className="qol-subsection__heading"><strong>Queue role preset</strong><span>Auto-applies when you enter a matching queue.</span></div>
                  <div className="qol-field-grid qol-field-grid--three">
                    <label>Target queue<select value={presetQueue} onChange={(event) => { const queue = event.target.value; setPresetQueue(queue); const preset = queuePresets[queue]; if (preset) { setPresetFirst(preset.first); setPresetSecond(preset.second); } }}>{Object.entries(queueLabels).map(([key, label]) => <option key={key} value={key}>{label}{queuePresets[key] ? ' ✓' : ''}</option>)}</select></label>
                    <label>Primary<select value={presetFirst} onChange={(event) => setPresetFirst(event.target.value)}>{ROLE_OPTIONS.map(([value, label, icon]) => <option key={value} value={value}>{icon} {label}</option>)}</select></label>
                    <label>Secondary<select value={presetSecond} onChange={(event) => setPresetSecond(event.target.value)}>{ROLE_OPTIONS.map(([value, label, icon]) => <option key={value} value={value}>{icon} {label}</option>)}</select></label>
                  </div>
                  {presetFirst === presetSecond && <p className="qol-field-error">Preset roles must be different.</p>}
                  <div className="qol-subsection__actions"><button type="button" className="btn-secondary" disabled={presetFirst === presetSecond || activeAction !== ''} onClick={() => void runAction(`preset-${presetQueue}`, `Preset saved for ${queueLabels[presetQueue] || presetQueue}.`, async () => setQueuePresets(await saveQueuePreset(presetQueue, presetFirst, presetSecond)))}><Check /> Save preset</button></div>
                </div>
              </div>
            </details>
          </div>
        </section>

        <section className="qol-task-group" aria-labelledby="qol-presence-heading">
          <header className="qol-task-group__header">
            <div className="qol-task-group__icon is-teal"><MessageSquareText /></div>
            <div><h2 id="qol-presence-heading">Social presence</h2><p>Control how your connected League client appears to friends.</p></div>
            <span className="qol-task-group__summary">{state?.availability || 'Unavailable'}</span>
          </header>
          <div className="qol-task-group__body">
            <div className="qol-availability" role="group" aria-label="Availability">
              {AVAILABILITY_OPTIONS.map(({ value, label, color }) => <button key={value} type="button" disabled={!connected || activeAction !== ''} className={state?.availability === value ? 'is-selected' : ''} onClick={() => void runAction('presence', `Availability set to ${label}.`, () => post('/api/lcu/availability', { availability: value }))}><span style={{ backgroundColor: color }} />{label}</button>)}
            </div>
            <div className="qol-status-editor">
              <label htmlFor="qol-status-input">Custom status <small>{statusMessage.length}/255</small></label>
              <div><input id="qol-status-input" value={statusMessage} maxLength={255} disabled={!connected} placeholder="What should friends see?" onChange={(event) => setStatusMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') updateStatus(); }} /><button type="button" className="btn-primary" disabled={!connected || !statusMessage.trim() || activeAction === 'status'} onClick={updateStatus}>{activeAction === 'status' ? <Loader2 className="animate-spin" /> : <Check />} Update</button></div>
            </div>
          </div>
        </section>

        <section className="qol-task-group" aria-labelledby="qol-safety-heading">
          <header className="qol-task-group__header">
            <div className="qol-task-group__icon is-rose"><ShieldCheck /></div>
            <div><h2 id="qol-safety-heading">Safety & session</h2><p>Phase-aware actions and reviewed client utilities, shown when you need them.</p></div>
            <span className="qol-task-group__summary">{formatPhaseLabel(phase)}</span>
          </header>
          <div className="qol-task-group__body">
            {inChampSelect && <div className="qol-context-callout is-rose"><div><strong>Champion select is live</strong><span>Open the live draft workspace or apply a standard queue dodge.</span></div><div className="qol-context-callout__actions">{onOpenLive && <button type="button" className="btn-primary" onClick={onOpenLive}><Swords /> Open live draft</button>}<button type="button" className="btn-danger" onClick={() => setConfirmAction({ open: true, title: 'Dodge this champion select?', message: 'League will apply standard queue dodge penalties. This action cannot be undone.', actionLabel: 'Dodge game', danger: true, onConfirm: () => { setConfirmAction(null); void runAction('dodge', 'Dodge request sent to League.', () => post('/api/lcu/dodge')); } })}><CircleStop /> Dodge game</button></div></div>}
            {customSession && customQuitAvailable && !inChampSelect && <div className="qol-context-callout is-gold"><div><strong>Custom or practice session</strong><span>Leave the custom lobby without sending a dodge penalty.</span></div><button type="button" className="btn-danger" disabled={activeAction === 'quit-custom'} onClick={() => void runAction('quit-custom', 'Custom session closed.', lcuQuitCustomSession)}><CircleStop /> Quit custom</button></div>}
            {postGame && <div className="qol-postgame"><div className="qol-subsection__heading"><strong>Post-game actions</strong><span>Match finished</span></div><div className="qol-action-grid"><button type="button" className="btn-primary" onClick={() => void runAction('play-again', 'Returning to lobby.', () => post('/api/lcu/play-again'))}><Play /> Play again</button><button type="button" className="btn-secondary" onClick={() => void loadHonorBallot()}><Heart /> Load honor ballot</button><button type="button" className="btn-secondary" onClick={() => void runAction('rewards', 'Event rewards checked.', () => post('/api/lcu/claim-event-rewards'))}><Gift /> Claim rewards</button></div>{honorBallot && <div className="qol-honor-grid">{[...(honorBallot.eligibleAllies || []), ...(honorBallot.eligibleOpponents || [])].map((player) => <button type="button" key={player.puuid} disabled={activeAction === `honor-${player.puuid}`} onClick={() => void honorPlayer(player)}><span><small>{player.championName}</small><strong>{player.summonerName}</strong></span><Heart /></button>)}</div>}</div>}
            {!inChampSelect && !customSession && !postGame && <div className="qol-standby"><span className="qol-status-dot is-live" /><div><strong>{connected ? 'Client standing by' : 'Connect League to unlock actions'}</strong><small>{connected ? `Current phase: ${formatPhaseLabel(phase)}` : 'Open Riot Client and sign in.'}</small></div></div>}
            <details className="qol-disclosure">
              <summary><span><ShieldCheck /> Reviewed client utilities</span><small>Snapshots, rewards, capabilities, and identifiers</small></summary>
              <div className="qol-disclosure__body"><SafeToolsPanel /></div>
            </details>
          </div>
        </section>
      </div>
    </div>
  );
}
