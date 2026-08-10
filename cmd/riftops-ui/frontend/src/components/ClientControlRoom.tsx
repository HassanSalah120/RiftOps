import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleStop,
  Clock3,
  Compass,
  Gift,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Swords,
  TimerReset,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import {
  fetchQueuePresets,
  lcuAutoAccept,
  lcuAutoRequeue,
  lcuAutoRoles,
  lcuClaimEventRewards,
  lcuPlayAgain,
  lcuStopQueue,
  saveQueuePreset,
  type QueuePresetsResponse,
  type RolePreset,
} from '../api';
import { useLCUConnection } from './lcuConnectionContext';

type Toast = (message: string, type?: 'info' | 'success' | 'error') => void;
type EventTone = 'neutral' | 'success' | 'danger';
type ControlEvent = { id: number; time: string; title: string; detail: string; tone: EventTone };

const ROLE_OPTIONS = [
  ['TOP', 'Top'],
  ['JUNGLE', 'Jungle'],
  ['MIDDLE', 'Mid'],
  ['BOTTOM', 'Bot'],
  ['UTILITY', 'Support'],
  ['FILL', 'Fill'],
] as const;

const PHASES = [
  { key: 'Lobby', label: 'Lobby' },
  { key: 'Matchmaking', label: 'Queue' },
  { key: 'ReadyCheck', label: 'Ready check' },
  { key: 'ChampSelect', label: 'Champion select' },
  { key: 'InProgress', label: 'In game' },
  { key: 'EndOfGame', label: 'Post-game' },
];

const QUEUE_FALLBACKS: Record<string, string> = {
  ranked_solo: 'Ranked Solo',
  ranked_flex: 'Ranked Flex',
  normal_draft: 'Normal Draft',
  normal_blind: 'Normal Blind',
  aram: 'ARAM',
  arena: 'Arena',
  swiftplay: 'Swiftplay',
};

function phaseLabel(phase: string): string {
  if (!phase) return 'Waiting for League';
  return phase.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function phaseTone(phase: string): EventTone {
  if (phase === 'ReadyCheck' || phase === 'ChampSelect') return 'danger';
  if (phase === 'InProgress') return 'success';
  return 'neutral';
}

function loadEvents(): ControlEvent[] {
  try {
    const stored = JSON.parse(localStorage.getItem('riftops.controlRoom.events') || '[]');
    return Array.isArray(stored) ? stored.slice(0, 10) : [];
  } catch {
    return [];
  }
}

function storeEvents(events: ControlEvent[]) {
  try { localStorage.setItem('riftops.controlRoom.events', JSON.stringify(events.slice(0, 10))); } catch { /* local storage is optional */ }
}

export default function ClientControlRoom({ onOpenQoL, onOpenHistory, showToast }: { onOpenQoL: () => void; onOpenHistory: () => void; showToast: Toast }) {
  const { qol: state, health, connected, stale, lastUpdated, performanceMode, refresh } = useLCUConnection();
  const [busy, setBusy] = useState('');
  const [events, setEvents] = useState<ControlEvent[]>(loadEvents);
  const [presets, setPresets] = useState<QueuePresetsResponse | null>(null);
  const [queue, setQueue] = useState('ranked_solo');
  const [firstRole, setFirstRole] = useState('MIDDLE');
  const [secondRole, setSecondRole] = useState('UTILITY');
  const [rolesDirty, setRolesDirty] = useState(false);

  const phase = state?.phase || '';
  const currentPhaseIndex = Math.max(0, PHASES.findIndex((item) => item.key === phase));
  const queueLabel = presets?.queues?.[queue] || QUEUE_FALLBACKS[queue] || queue;
  const availableQueues = useMemo(() => {
    const values = Object.entries(presets?.queues || QUEUE_FALLBACKS);
    return values.length ? values : Object.entries(QUEUE_FALLBACKS);
  }, [presets]);

  const recordEvent = useCallback((title: string, detail: string, tone: EventTone = 'neutral') => {
    setEvents((current) => {
      const next = [{
        id: Date.now(),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        title,
        detail,
        tone,
      }, ...current].slice(0, 10);
      storeEvents(next);
      return next;
    });
  }, []);

  useEffect(() => {
    void fetchQueuePresets().then((response) => {
      setPresets(response);
      const firstKey = Object.keys(response.presets || {})[0];
      const preferred = response.presets?.ranked_solo || (firstKey ? response.presets[firstKey] : undefined);
      if (preferred) {
        setFirstRole(preferred.first);
        setSecondRole(preferred.second);
      }
    }).catch(() => {
      setPresets({ presets: {}, queues: QUEUE_FALLBACKS });
    });
  }, []);

  useEffect(() => {
    if (!state?.firstRole || rolesDirty) return;
    setFirstRole(state.firstRole);
    setSecondRole(state.secondRole || 'FILL');
  }, [rolesDirty, state?.firstRole, state?.secondRole]);

  useEffect(() => {
    if (!phase) return;
    setEvents((current) => {
      if (current[0]?.title === phaseLabel(phase)) return current;
      const next = [{
        id: Date.now(),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        title: phaseLabel(phase),
        detail: state?.queueState || 'League client phase changed',
        tone: phaseTone(phase),
      }, ...current].slice(0, 10);
      storeEvents(next);
      return next;
    });
  }, [phase, state?.queueState]);

  const run = useCallback(async (key: string, success: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      recordEvent(success, phaseLabel(phase), 'success');
      showToast(success, 'success');
      await refresh();
    } catch (reason: any) {
      const message = reason?.message || 'League rejected the action.';
      recordEvent('Action unavailable', message, 'danger');
      showToast(message, 'error');
    } finally {
      setBusy('');
    }
  }, [phase, recordEvent, refresh, showToast]);

  const applyQueueProfile = async () => {
    const preset: RolePreset = { first: firstRole, second: secondRole };
    setBusy('profile');
    try {
      await saveQueuePreset(queue, firstRole, secondRole);
      if (phase === 'Lobby') await lcuAutoRoles(firstRole, secondRole);
      setPresets((current) => current ? { ...current, presets: { ...current.presets, [queue]: preset } } : current);
      setRolesDirty(false);
      recordEvent(`${queueLabel} profile saved`, `${firstRole} / ${secondRole}${phase === 'Lobby' ? ' · applied to lobby' : ''}`, 'success');
      showToast(`${queueLabel} profile saved${phase === 'Lobby' ? ' and applied' : ''}.`, 'success');
    } catch (reason: any) {
      const message = reason?.message || 'Queue profile could not be saved.';
      recordEvent('Queue profile unavailable', message, 'danger');
      showToast(message, 'error');
    } finally {
      setBusy('');
    }
  };

  const primaryAction = useMemo(() => {
    if (!connected) return { key: 'refresh', label: 'Reconnect to League', detail: 'RiftOps will retry automatically. Refresh when the client is open.', icon: RefreshCw };
    switch (phase) {
      case 'Lobby': return { key: 'start', label: 'Start matchmaking', detail: `${queueLabel} · ${firstRole} / ${secondRole}`, icon: Play };
      case 'Matchmaking': return { key: 'stop', label: 'Stop matchmaking', detail: state?.queueState || 'Searching for an opponent', icon: CircleStop };
      case 'ReadyCheck': return { key: 'accept', label: 'Accept ready check', detail: 'The match is waiting for your confirmation.', icon: Check };
      case 'ChampSelect': return { key: 'champ-select', label: 'Open champion select', detail: 'Review timers, picks, bans, and dodge controls.', icon: Swords };
      case 'EndOfGame': return { key: 'again', label: 'Play again', detail: 'Return to the lobby and keep the session moving.', icon: RotateCcw };
      case 'InProgress': return { key: 'history', label: 'Open match center', detail: 'Review your latest games and performance context.', icon: Activity };
      default: return { key: 'refresh', label: 'Refresh League state', detail: 'Read the latest client phase.', icon: RefreshCw };
    }
  }, [connected, firstRole, phase, queueLabel, secondRole, state?.queueState]);

  const runPrimary = () => {
    switch (primaryAction.key) {
      case 'start': return void run('start', 'Matchmaking started.', async () => { await lcuAutoRoles(firstRole, secondRole); await lcuAutoRequeue(); });
      case 'stop': return void run('stop', 'Matchmaking stopped.', lcuStopQueue);
      case 'accept': return void run('accept', 'Ready check accepted.', lcuAutoAccept);
      case 'again': return void run('again', 'Returning to the lobby.', lcuPlayAgain);
      case 'champ-select': return onOpenQoL();
      case 'history': return onOpenHistory();
      default: return void run('refresh', 'League state refreshed.', refresh);
    }
  };

  const PrimaryIcon = primaryAction.icon;
  return (
    <section className="control-room" aria-label="League client control room">
      <div className="control-room__glow" />
      <header className="control-room__header">
        <div className="control-room__title">
          <span className="control-room__mark"><Compass /></span>
          <span><small>LEAGUE CONTROL ROOM</small><strong>Play loop, in one view</strong></span>
        </div>
        <div className="control-room__connection">
          {connected ? <Wifi /> : <WifiOff />}
          <span>{connected ? (stale ? 'Stale connection' : 'Live client link') : 'League offline'} · {performanceMode}</span>
          <button type="button" onClick={() => void refresh()} disabled={busy !== ''} aria-label="Refresh League client state"><RefreshCw className={busy === 'refresh' ? 'animate-spin' : ''} /></button>
        </div>
      </header>

      <div className="control-room__rail" aria-label="League client phase">
        {PHASES.map((item, index) => {
          const active = item.key === phase;
          const complete = connected && currentPhaseIndex > index;
          return <div key={item.key} className={`control-room__phase ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}><span>{complete ? <CheckCircle2 /> : <span>{String(index + 1).padStart(2, '0')}</span>}</span><small>{item.label}</small></div>;
        })}
      </div>

      <div className="control-room__metrics" aria-label="League client performance">
        <div><span>LCU latency</span><strong className={(health?.latencyMs ?? 0) > 150 ? 'is-bad' : (health?.latencyMs ?? 0) > 50 ? 'is-warn' : 'is-good'}>{health?.connected && (health.latencyMs ?? 0) > 0 ? `${health.latencyMs}ms` : '—'}</strong></div>
        <div><span>League CPU</span><strong>{health?.connected && health.cpuPercent > 0 ? `${health.cpuPercent.toFixed(1)}%` : '—'}</strong></div>
        <div><span>League RAM</span><strong>{health?.connected && health.memoryMB > 0 ? `${health.memoryMB}MB` : '—'}</strong></div>
        <div><span>Client uptime</span><strong>{health?.connected && health.uptime > 0 ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m` : '—'}</strong></div>
      </div>

      <div className="control-room__main">
        <div className="control-room__next">
          <div className="control-room__eyebrow"><TimerReset /> NEXT BEST ACTION</div>
          <div className="control-room__next-copy"><h3>{primaryAction.label}</h3><p>{primaryAction.detail}</p></div>
          <button type="button" className="control-room__primary" onClick={runPrimary} disabled={busy !== ''}>
            {busy === primaryAction.key ? <Loader2 className="animate-spin" /> : <PrimaryIcon />}<span>{primaryAction.label}</span><ArrowRight />
          </button>
        </div>

        <div className="control-room__profile">
          <div className="control-room__eyebrow"><Swords /> QUEUE PROFILE</div>
          <div className="control-room__profile-row">
            <select value={queue} onChange={(event) => { setQueue(event.target.value); setRolesDirty(false); const next = presets?.presets?.[event.target.value]; if (next) { setFirstRole(next.first); setSecondRole(next.second); } }} aria-label="Queue profile">
              {availableQueues.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <select value={firstRole} onChange={(event) => { setFirstRole(event.target.value); setRolesDirty(true); }} aria-label="Primary role">
              {ROLE_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <select value={secondRole} onChange={(event) => { setSecondRole(event.target.value); setRolesDirty(true); }} aria-label="Secondary role">
              {ROLE_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <button type="button" className="control-room__save" onClick={() => void applyQueueProfile()} disabled={busy !== '' || !connected}><Save />{busy === 'profile' ? 'Saving' : 'Save'}</button>
          </div>
          <small>{connected ? `${queueLabel} · ${state?.firstRole || firstRole} / ${state?.secondRole || secondRole}` : 'Open League Client to apply queue preferences.'}</small>
        </div>
      </div>

      {phase === 'EndOfGame' && <div className="control-room__postgame">
        <div><span className="control-room__eyebrow"><Gift /> POST-GAME WRAP-UP</span><strong>Close the loop before the next queue.</strong><small>Claim rewards and open the honor workspace while the result is still available.</small></div>
        <div className="control-room__postgame-actions">
          <button type="button" onClick={() => void run('rewards', 'Event rewards checked.', lcuClaimEventRewards)} disabled={busy !== ''}><Gift />{busy === 'rewards' ? 'Checking' : 'Claim rewards'}</button>
          <button type="button" onClick={onOpenQoL}><Swords /> Honor & details <ArrowRight /></button>
        </div>
      </div>}

      <div className="control-room__footer">
        <div className="control-room__events">
          <div className="control-room__eyebrow"><Clock3 /> SESSION TIMELINE</div>
          {events.length === 0 ? <p className="control-room__empty">Your League activity will appear here.</p> : <div className="control-room__event-list">{events.slice(0, 4).map((event) => <div className="control-room__event" key={event.id}><span className={`control-room__event-dot is-${event.tone}`} /><span><strong>{event.title}</strong><small>{event.detail}</small></span><time>{event.time}</time></div>)}</div>}
        </div>
        <div className="control-room__shortcuts">
          <div className="control-room__eyebrow"><Activity /> CLIENT SHORTCUTS</div>
          <button type="button" onClick={onOpenQoL}><Swords /> Champion select & QoL <ArrowRight /></button>
          <button type="button" onClick={onOpenHistory}><Activity /> Match center & trends <ArrowRight /></button>
          <button type="button" onClick={() => showToast(lastUpdated ? `Client state refreshed at ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : 'Client state is being refreshed.', 'info')}><XCircle /> View safe actions <ArrowRight /></button>
        </div>
      </div>
    </section>
  );
}
