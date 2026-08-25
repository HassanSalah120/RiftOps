import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowRight, Check, CircleStop, Clipboard, Clock3, Gamepad2, Loader2,
  Play, RefreshCw, RotateCcw, ShieldAlert, Sparkles, Swords, Trophy, Users, Wifi, WifiOff, X,
} from 'lucide-react';
import {
  launchLCULeague, lcuAutoAccept, lcuDeclineReady, lcuPlayAgain, lcuQuitCustomSession, lcuStopQueue,
  type LCUGameflowSession,
  type GameClientData,
} from '../api';
import { isArenaQueue } from '../arenaBravery';
import { normalizeArenaTelemetry } from '../arenaTelemetry';
import { formatElapsed, isActiveLivePhase, livePhaseDescription, livePhaseLabel, normalizeLivePhase, type LiveSessionPhase } from '../liveSession';
import { useLCUConnection } from './lcuConnectionContext';
import ChampSelectWorkspace from './ChampSelectWorkspace';
import { ActionFeedback, type FeedbackState } from './DesignPrimitives';

type Toast = (message: string, type?: 'info' | 'success' | 'error') => void;

const STAGES: LiveSessionPhase[] = ['QUEUE', 'READY_CHECK', 'CHAMP_SELECT', 'LOADING', 'IN_GAME', 'POST_GAME'];

function readString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function readNumber(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function gameData(session: LCUGameflowSession | null): Record<string, unknown> {
  return session?.gameData && typeof session.gameData === 'object' ? session.gameData : {};
}

function formatGameMode(data: Record<string, unknown>): string {
  const mode = readString(data.gameMode || data.gameModeName || data.queueName);
  return mode || 'League match';
}

function formatQueue(data: Record<string, unknown>): string {
  const queue = readString(data.queueId || data.queueName || data.queueType);
  return queue ? (/^\d+$/.test(queue) ? `Queue ${queue}` : queue) : 'Current queue';
}

function formatMap(data: Record<string, unknown>): string {
  const map = readString(data.mapId || data.mapName);
  if (map === '11') return 'Summoner’s Rift';
  if (map === '12') return 'Howling Abyss';
  return map || 'Map unavailable';
}

function participants(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const values = data.playerChampionSelections || data.participants || data.players;
  return Array.isArray(values) ? values.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object')) : [];
}

function sessionPhase(session: LCUGameflowSession | null): string {
  const value = session?.gameData && typeof session.gameData === 'object'
    ? (session.gameData as Record<string, unknown>).gameState
    : undefined;
  return readString(value);
}

function formatScore(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '—';
}

function formatKDA(player: NonNullable<GameClientData['players']>[number]): string {
  const scores = player.scores || {};
  return `${formatScore(scores.kills)} / ${formatScore(scores.deaths)} / ${formatScore(scores.assists)}`;
}

function ArenaLiveCard({ data }: { data: GameClientData }) {
  const telemetry = normalizeArenaTelemetry({ gameData: data.gameData, arena: data.arena, activePlayer: data.activePlayer, events: data.events });
  if (!telemetry.isArena) return null;
  const fields = [
    ['EVENT', telemetry.eventLabel],
    ['ROUND', telemetry.round === null ? 'League has not exposed it' : String(telemetry.round)],
    ['TEAMS LEFT', telemetry.teamsRemaining === null ? 'League has not exposed it' : String(telemetry.teamsRemaining)],
    ['PLACEMENT', telemetry.placement === null ? 'In progress' : `#${telemetry.placement}`],
    ['FAME', telemetry.fame === null ? 'League has not exposed it' : telemetry.fame.toLocaleString()],
    ['PARTNER', telemetry.partnerName || 'League has not exposed it'],
  ];
  return <section className="active-game-dashboard__arena" aria-label="Arena match status">
    <div className="active-game-dashboard__arena-heading"><div><span className="live-session__eyebrow">ARENA TELEMETRY</span><h3>Round-by-round status</h3><p>Only values exposed by League are shown. RiftOps does not infer placements or augment choices.</p></div><span className="active-game-dashboard__arena-pill"><Sparkles /> ARENA</span></div>
    <div className="active-game-dashboard__arena-grid">{fields.map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
    <div className="active-game-dashboard__arena-augments"><div className="active-game-dashboard__team-head"><span><Trophy /> AUGMENTS</span><small>{telemetry.augments.length ? `${telemetry.augments.length} exposed` : 'Waiting for League data'}</small></div>{telemetry.augments.length ? <div className="active-game-dashboard__augment-list">{telemetry.augments.map((augment, index) => <span key={`${augment.id || augment.name}-${index}`} title={augment.description || augment.name}>{augment.name}{augment.tier ? ` · ${augment.tier}` : ''}</span>)}</div> : <p className="active-game-dashboard__empty">Arena augments are not present in the current local game payload. Match history may expose them after the game.</p>}</div>
  </section>;
}

function ActiveGameDashboard({ data }: { data: GameClientData }) {
  const players = data.players || [];
  const active = data.activePlayer;
  const allies = players.filter((player) => String(player.team || '').toUpperCase() === 'ORDER');
  const opponents = players.filter((player) => String(player.team || '').toUpperCase() === 'CHAOS');
  const recentEvents = (data.events || []).slice(-4).reverse();
  const championStats = active?.championStats || {};
  return <div className="active-game-dashboard">
    <div className="active-game-dashboard__head">
      <div><span className="live-session__eyebrow">GAME CLIENT TELEMETRY</span><h3>Live match dashboard</h3><p>Read-only data from League’s local game client. RiftOps never sends gameplay input.</p></div>
      <div className="active-game-dashboard__status"><span />LIVE</div>
    </div>
    <ArenaLiveCard data={data} />
    <div className="active-game-dashboard__summary">
      <div><small>PLAYER</small><strong>{active?.summonerName || 'You'}</strong><span>{active?.championName || 'Champion unavailable'} · Level {formatScore(active?.level)}</span></div>
      <div><small>GAME TIME</small><strong>{formatElapsed(Number(data.gameData?.gameTime) || 0)}</strong><span>{data.gameData?.gameMode || 'League match'}</span></div>
      <div><small>GOLD</small><strong>{formatScore(active?.currentGold)}</strong><span>Current gold</span></div>
      <div><small>STATS</small><strong>{formatScore(championStats.attackDamage)} AD</strong><span>{formatScore(championStats.abilityPower)} AP · {formatScore(championStats.moveSpeed)} MS</span></div>
    </div>
    <div className="active-game-dashboard__columns">
      {[['YOUR TEAM', allies], ['OPPONENTS', opponents]].map(([label, team]) => <div className="active-game-dashboard__team" key={String(label)}><div className="active-game-dashboard__team-head"><span>{label as string}</span><small>{(team as typeof players).length} players</small></div>{(team as typeof players).length === 0 ? <p className="active-game-dashboard__empty">Team data is still loading.</p> : (team as typeof players).map((player, index) => <div className={`active-game-dashboard__player ${player.isDead ? 'is-dead' : ''}`} key={`${player.summonerName || player.championName || 'player'}-${index}`}><div><strong>{player.championName || 'Champion unavailable'}</strong><span>{player.summonerName || 'Summoner unavailable'}{player.position ? ` · ${player.position}` : ''}</span><em>{(player.items || []).filter((item) => item.displayName || item.itemID || item.id).slice(0, 4).map((item) => item.displayName || `Item ${item.itemID || item.id}`).join(' · ') || 'Items unavailable'}</em></div><b>{formatKDA(player)}</b><small>CS {formatScore(player.scores?.creepScore)}{player.isDead ? ' · DEAD' : ''}</small></div>)}</div>)}
    </div>
    <div className="active-game-dashboard__events"><div className="active-game-dashboard__team-head"><span>RECENT EVENTS</span><small>{recentEvents.length ? 'Game client feed' : 'Waiting for events'}</small></div>{recentEvents.length === 0 ? <p className="active-game-dashboard__empty">Objective and combat events will appear here.</p> : recentEvents.map((event, index) => <div className="active-game-dashboard__event" key={`${event.eventId || event.eventName || 'event'}-${index}`}><span /> <strong>{event.eventName || 'Game event'}</strong><time>{formatElapsed(Number(event.eventTime) || 0)}</time></div>)}</div>
  </div>;
}

function readyCheckNumber(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function PhaseIcon({ phase }: { phase: LiveSessionPhase }) {
  if (phase === 'READY_CHECK') return <Check />;
  if (phase === 'CHAMP_SELECT') return <Swords />;
  if (phase === 'IN_GAME') return <Gamepad2 />;
  if (phase === 'RECONNECTING') return <WifiOff />;
  if (phase === 'POST_GAME') return <RotateCcw />;
  return <Activity />;
}

function ActionButton({ busy, icon: Icon, children, onClick, tone = 'gold', disabled = false }: {
  busy: boolean;
  icon: typeof Play;
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'gold' | 'quiet' | 'danger';
  disabled?: boolean;
}) {
  return <button type="button" className={`live-session__action is-${tone}`} onClick={onClick} disabled={disabled || busy}>
    {busy ? <Loader2 className="animate-spin" /> : <Icon />}<span>{children}</span>
  </button>;
}

export default function LiveSessionPage({ onOpenPlayFlow, onOpenCommandCenter, showToast: publishToast, remoteClient = false }: {
  onOpenPlayFlow: () => void;
  onOpenCommandCenter: () => void;
  showToast: Toast;
  remoteClient?: boolean;
}) {
  const { qol, status, health, connected, loading, stale, error, lastUpdated, gameflowSession, gameflowSessionAvailable, activeGame, activeGameAvailable, refresh } = useLCUConnection();
  const [busy, setBusy] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const phaseStarted = useRef(Date.now());
  const previousPhase = useRef<LiveSessionPhase>('IDLE');
  const latestGameEvent = useRef('');
  const readyAnchor = useRef<{ seconds: number | null; at: number }>({ seconds: null, at: Date.now() });
  const [lastActivePhase, setLastActivePhase] = useState<LiveSessionPhase>('IDLE');
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const showToast = useCallback<Toast>((message, type = 'info') => {
    setFeedback({ tone: type === 'success' ? 'success' : type === 'error' ? 'error' : 'info', message });
    publishToast(message, type);
  }, [publishToast]);

  const normalized = normalizeLivePhase(qol?.phase, qol?.queueState);
  const livePayloadLost = (normalized === 'LOADING' || normalized === 'IN_GAME') && gameflowSessionAvailable === false;
  const phase = (stale && isActiveLivePhase(lastActivePhase)) || livePayloadLost ? 'RECONNECTING' : normalized;
  const data = useMemo(() => gameData(gameflowSession), [gameflowSession]);
  const arenaMode = isArenaQueue(qol?.queueId) || normalizeArenaTelemetry({ gameData: data, arena: activeGame?.arena }).isArena;
  const roster = useMemo(() => participants(data), [data]);
  const elapsed = Math.floor((now - phaseStarted.current) / 1000);
  const gameId = readString(data.gameId || data.gameID || data.id);
  const gameLength = readNumber(data.gameLength);
  const estimatedWait = readNumber(data.estimatedWaitTime || data.estimatedWaitSeconds);
  const partySize = readNumber(data.partySize || data.partyCount);
  const customSession = Boolean(qol?.isCustom || qol?.queueId === 3140 || data.isCustom === true || readNumber(data.queueId) === 3140 || readString(data.gameMode).toUpperCase() === 'PRACTICETOOL');
  const readyPayload = qol?.readyCheck;
  const readyRaw = readyPayload ? readyCheckNumber(readyPayload.timeLeft ?? readyPayload.remainingTime ?? readyPayload.timer) : null;
  const readySeconds = readyRaw === null ? null : readyRaw > 120 ? readyRaw / 1000 : readyRaw;
  useEffect(() => {
    if (readySeconds !== readyAnchor.current.seconds) readyAnchor.current = { seconds: readySeconds, at: Date.now() };
  }, [readySeconds]);
  const readyTimeLeft = useMemo(() => readySeconds === null ? null : Math.max(0, Math.ceil(readySeconds - (now - readyAnchor.current.at) / 1000)), [now, readySeconds]);
  const readyResponse = readString(readyPayload?.playerResponse || readyPayload?.response) || 'Not answered';
  const acceptedPlayers = Array.isArray(readyPayload?.playerResponses)
    ? readyPayload.playerResponses.filter((entry: any) => String(entry?.response || entry?.status || '').toLowerCase() === 'accepted').length
    : null;

  useEffect(() => {
    if (phase !== previousPhase.current) {
      previousPhase.current = phase;
      phaseStarted.current = Date.now();
      if (isActiveLivePhase(phase)) setLastActivePhase(phase);
    }
  }, [phase]);

  useEffect(() => {
    if (!isActiveLivePhase(phase)) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'IN_GAME' || !activeGame?.available || !activeGame.events?.length) return;
    const event = activeGame.events[activeGame.events.length - 1];
    const key = `${event.eventId || ''}:${event.eventName || ''}:${event.eventTime || ''}`;
    if (!latestGameEvent.current) {
      latestGameEvent.current = key;
      return;
    }
    if (latestGameEvent.current === key) return;
    latestGameEvent.current = key;
    const name = String(event.eventName || '');
    if (/dragon|baron|rift herald|turret|inhibitor|ace|game end/i.test(name)) {
      publishToast(`Game event: ${name}`, 'info');
    }
  }, [activeGame, phase, publishToast]);

  const run = useCallback(async (key: string, success: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      showToast(success, 'success');
      await refresh();
    } catch (reason: any) {
      showToast(reason?.message || 'League rejected the action.', 'error');
    } finally {
      setBusy('');
    }
  }, [refresh, showToast]);

  const copyGameId = async () => {
    if (!gameId) return;
    try {
      await navigator.clipboard.writeText(gameId);
      showToast('Game ID copied.', 'success');
    } catch {
      showToast('Game ID could not be copied on this device.', 'error');
    }
  };

  const leaveCustomSession = () => {
    if (!customSession) return;
    void run('quit-custom', 'Custom/practice session closed.', lcuQuitCustomSession);
  };

  const unavailable = !connected || !status?.leagueReady;
  const connectionLabel = unavailable ? 'League client unavailable' : stale ? 'Connection is recovering' : 'LCU connected';
  const stageIndex = STAGES.indexOf(phase);

  return <div className="live-session-page">
    <header className={`live-session__hero is-${phase.toLowerCase()}`}>
      <div className="live-session__hero-copy">
        <div className="live-session__eyebrow"><span className="live-session__hero-icon"><PhaseIcon phase={phase} /></span><span>LIVE SESSION</span><span className={`live-session__connection ${unavailable ? 'is-offline' : stale ? 'is-warn' : 'is-online'}`}><span />{connectionLabel}</span></div>
        <h1>{livePhaseLabel(phase)}</h1>
        <p>{livePhaseDescription(phase)}{qol?.statusMessage ? ` · ${qol.statusMessage}` : ''}</p>
      </div>
      <div className="live-session__hero-meta">
        {isActiveLivePhase(phase) && <div className="live-session__timer"><Clock3 /><strong>{formatElapsed(elapsed)}</strong><small>this phase</small></div>}
        <button type="button" className="live-session__refresh" onClick={() => void refresh()} disabled={loading} title="Refresh League state"><RefreshCw className={loading ? 'animate-spin' : ''} /></button>
      </div>
    </header>

    <ActionFeedback state={feedback} className="live-session__local-feedback" />

    <div className="live-session__body">
      <div className="live-session__rail" aria-label="Live session phases">
        {STAGES.map((stage, index) => <div key={stage} className={`live-session__stage ${stage === phase ? 'is-active' : ''} ${stageIndex >= 0 && index < stageIndex ? 'is-complete' : ''}`}><span>{stageIndex >= 0 && index < stageIndex ? <Check /> : index + 1}</span><small>{livePhaseLabel(stage)}</small></div>)}
      </div>

      {(stale || error || livePayloadLost) && <div className="live-session__notice is-warn"><ShieldAlert /><div><strong>{livePayloadLost ? 'Live game data is temporarily unavailable' : stale ? 'Live data is temporarily stale' : 'Live session data needs attention'}</strong><span>{livePayloadLost ? 'The LCU gameflow is still active, but its session payload did not respond. RiftOps will keep retrying without resetting the page.' : error || 'RiftOps is preserving the last known phase while it retries the League client.'}</span></div><button type="button" onClick={() => void refresh()}><RefreshCw /> Retry</button></div>}

      {phase === 'IDLE' && <section className="live-session__empty">
        <div className="live-session__empty-icon"><Gamepad2 /></div>
        <span className="live-session__eyebrow">NO ACTIVE SESSION</span>
        <h2>{unavailable ? 'Connect League to follow a session' : 'No active queue or game'}</h2>
        <p>{unavailable ? 'Open League Client and sign in. RiftOps will pick up the session automatically.' : customSession ? 'A custom or Practice Tool lobby is ready. Start it in League, or close it here.' : 'Start from Play Flow when you are ready. This page will follow the match from queue to post-game.'}</p>
        <div className="live-session__empty-actions">
          <ActionButton busy={busy === 'launch'} icon={Play} onClick={() => void run('launch', 'League Client launch requested.', launchLCULeague)}>Open League Client</ActionButton>
          {customSession && <ActionButton busy={busy === 'quit-custom'} icon={CircleStop} onClick={leaveCustomSession} tone="danger">Quit custom lobby</ActionButton>}
          <ActionButton busy={false} icon={Swords} onClick={onOpenPlayFlow} tone="quiet">Go to Play Flow</ActionButton>
          <ActionButton busy={false} icon={ArrowRight} onClick={onOpenCommandCenter} tone="quiet">Command Center</ActionButton>
        </div>
      </section>}

      {phase === 'QUEUE' && <section className="live-session__panel is-queue">
        <div className="live-session__panel-heading"><div><span className="live-session__eyebrow">MATCHMAKING</span><h2>Searching for a match</h2><p>{qol?.queueState || 'League is searching for available players.'}</p></div><div className="live-session__big-timer"><Clock3 /><strong>{formatElapsed(elapsed)}</strong><small>phase time</small></div></div>
        <div className="live-session__facts"><div><small>QUEUE</small><strong>{formatQueue(data)}</strong></div><div><small>GAME MODE</small><strong>{formatGameMode(data)}</strong></div><div><small>PRIMARY ROLE</small><strong>{qol?.firstRole || 'Not set'}</strong></div><div><small>SECONDARY ROLE</small><strong>{qol?.secondRole || 'Not set'}</strong></div><div><small>ESTIMATED WAIT</small><strong>{estimatedWait === null ? 'Unavailable' : formatElapsed(estimatedWait)}</strong></div><div><small>PARTY</small><strong>{partySize === null ? 'Unavailable' : `${partySize} player${partySize === 1 ? '' : 's'}`}</strong></div></div>
        <div className="live-session__panel-actions"><ActionButton busy={busy === 'stop'} icon={CircleStop} tone="danger" onClick={() => void run('stop', 'Matchmaking stopped.', lcuStopQueue)}>Stop Queue</ActionButton><ActionButton busy={false} icon={ArrowRight} tone="quiet" onClick={onOpenCommandCenter}>Command Center</ActionButton></div>
      </section>}

      {phase === 'READY_CHECK' && <section className="live-session__panel is-ready">
        <div className="live-session__ready-icon"><Check /></div><span className="live-session__eyebrow">TIME-SENSITIVE</span><h2>Ready check is waiting</h2><p>Confirm in RiftOps and League will continue the session. The local client remains the source of truth for the countdown and player responses.</p>
        <div className="live-session__ready-facts"><div><small>COUNTDOWN</small><strong>{readyTimeLeft === null ? 'Unavailable' : `${readyTimeLeft}s`}</strong></div><div><small>YOUR RESPONSE</small><strong>{readyResponse}</strong></div><div><small>ACCEPTED</small><strong>{acceptedPlayers === null ? 'Unavailable' : acceptedPlayers}</strong></div></div>
        <div className="live-session__ready-actions"><ActionButton busy={busy === 'accept'} icon={Check} onClick={() => void run('accept', 'Ready check accepted.', lcuAutoAccept)}>Accept ready check</ActionButton><ActionButton busy={busy === 'decline'} icon={X} tone="quiet" onClick={() => void run('decline', 'Ready check declined.', lcuDeclineReady)}>Decline</ActionButton></div>
      </section>}

      {phase === 'CHAMP_SELECT' && <section className="live-session__panel live-session__champ-select-panel"><div className="live-session__panel-heading"><div><span className="live-session__eyebrow">DRAFT</span><h2>{arenaMode ? 'Arena Champion Select' : 'Champion Select'}</h2><p>{arenaMode ? 'League controls the Arena event pool. Pick Bravery or one of the Crowd Favorites currently exposed by the client.' : 'Pick, ban, load out, and rune controls stay synchronized with the LCU session.'}</p></div></div><ChampSelectWorkspace connected={connected} active arenaMode={arenaMode} remoteClient={remoteClient} onToast={showToast} />{customSession && <div className="live-session__panel-actions"><ActionButton busy={busy === 'quit-custom'} icon={CircleStop} tone="danger" onClick={leaveCustomSession}>Quit custom game</ActionButton></div>}</section>}

      {(phase === 'LOADING' || phase === 'IN_GAME' || phase === 'POST_GAME' || phase === 'RECONNECTING') && <section className="live-session__panel is-game">
        <div className="live-session__panel-heading"><div><span className="live-session__eyebrow">{phase === 'IN_GAME' ? 'ACTIVE MATCH' : livePhaseLabel(phase).toUpperCase()}</span><h2>{phase === 'IN_GAME' ? 'Your game is live' : livePhaseLabel(phase)}</h2><p>{sessionPhase(gameflowSession) || livePhaseDescription(phase)}</p></div>{gameId && <button type="button" className="live-session__game-id" onClick={() => void copyGameId()}><Clipboard /> <span>Game {gameId}</span></button>}</div>
        <div className="live-session__facts"><div><small>GAME MODE</small><strong>{formatGameMode(data)}</strong></div><div><small>QUEUE</small><strong>{formatQueue(data)}</strong></div><div><small>MAP</small><strong>{formatMap(data)}</strong></div><div><small>ELAPSED</small><strong>{gameLength !== null ? formatElapsed(gameLength) : formatElapsed(elapsed)}</strong></div></div>
        {phase === 'IN_GAME' && activeGame?.available ? <ActiveGameDashboard data={activeGame} /> : roster.length > 0 ? <div className="live-session__roster"><div className="live-session__roster-heading"><Users /><span>Participants available from LCU</span></div><div className="live-session__roster-grid">{roster.slice(0, 10).map((player, index) => <div className="live-session__player" key={`${readString(player.summonerId || player.playerId)}-${index}`}><span>{readString(player.championId || player.championName) || 'Champion unavailable'}</span><small>{readString(player.summonerName || player.displayName) || 'Summoner unavailable'}</small></div>)}</div></div> : <div className="live-session__unavailable"><WifiOff /><span>{phase === 'IN_GAME' && activeGameAvailable === false ? 'League has not exposed the live game data feed yet. RiftOps is retrying without fabricating KDA, CS, items, or objective data.' : 'Detailed live scoreboard is unavailable until the game client exposes its read-only data feed.'}</span></div>}
        <div className="live-session__panel-actions">{(phase === 'LOADING' || phase === 'IN_GAME' || phase === 'RECONNECTING') && customSession && <ActionButton busy={busy === 'quit-custom'} icon={CircleStop} tone="danger" onClick={leaveCustomSession}>Quit custom game</ActionButton>}{phase === 'POST_GAME' && <ActionButton busy={busy === 'again'} icon={RotateCcw} onClick={() => void run('again', 'Returning to the lobby.', lcuPlayAgain)}>Play Again</ActionButton>}{phase === 'RECONNECTING' && <ActionButton busy={busy === 'refresh'} icon={RefreshCw} onClick={() => void run('refresh', 'League state refreshed.', refresh)}>Reconnect</ActionButton>}{phase !== 'POST_GAME' && <ActionButton busy={false} icon={ArrowRight} tone="quiet" onClick={onOpenCommandCenter}>Command Center</ActionButton>}</div>
      </section>}

      <footer className="live-session__footer"><span><Wifi /> LCU gameflow is the source of truth</span><span>{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Waiting for first update'}</span><span>{health?.latencyMs ? `${health.latencyMs}ms latency` : 'Latency unavailable'}</span></footer>
    </div>
  </div>;
}
