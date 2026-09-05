import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  ChevronRight,
  CircleStop,
  Clipboard,
  Clock3,
  Compass,
  Flame,
  Gamepad2,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Swords,
  Trophy,
  Users,
  Wifi,
  WifiOff,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  launchLCULeague,
  lcuAutoAccept,
  lcuDeclineReady,
  lcuPlayAgain,
  lcuQuitCustomSession,
  lcuStopQueue,
  type LCUGameflowSession,
  type GameClientData,
} from '../api';
import { isArenaQueue } from '../arenaBravery';
import { normalizeArenaTelemetry } from '../arenaTelemetry';
import {
  formatElapsed,
  isActiveLivePhase,
  livePhaseDescription,
  livePhaseLabel,
  normalizeLivePhase,
  type LiveSessionPhase,
} from '../liveSession';
import { useLCUConnection } from './lcuConnectionContext';
import ChampSelectWorkspace from './ChampSelectWorkspace';
import { ActionFeedback, StatusBadge, type FeedbackState } from './DesignPrimitives';
import PageHeader from './PageHeader';
import { resolveChampionAlias } from '../skinAssets';

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

function readyCheckNumber(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function PhaseIcon({ phase }: { phase: LiveSessionPhase }) {
  if (phase === 'READY_CHECK') return Check;
  if (phase === 'CHAMP_SELECT') return Swords;
  if (phase === 'IN_GAME') return Gamepad2;
  if (phase === 'RECONNECTING') return WifiOff;
  if (phase === 'POST_GAME') return RotateCcw;
  if (phase === 'QUEUE') return Clock3;
  return Activity;
}

function ActionButton({
  busy,
  icon: Icon,
  children,
  onClick,
  tone = 'gold',
  disabled = false,
}: {
  busy: boolean;
  icon: LucideIcon;
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'gold' | 'quiet' | 'danger';
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`live-session__action is-${tone}`}
      onClick={onClick}
      disabled={disabled || busy}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      <span>{children}</span>
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────
   Arena Telemetry Sub-Card
   ───────────────────────────────────────────────────────────── */
function ArenaLiveCard({ data }: { data: GameClientData }) {
  const telemetry = normalizeArenaTelemetry({
    gameData: data.gameData,
    arena: data.arena,
    activePlayer: data.activePlayer,
    events: data.events,
  });
  if (!telemetry.isArena) return null;

  const fields = [
    ['EVENT', telemetry.eventLabel],
    ['ROUND', telemetry.round === null ? 'League has not exposed it' : String(telemetry.round)],
    ['TEAMS LEFT', telemetry.teamsRemaining === null ? 'League has not exposed it' : String(telemetry.teamsRemaining)],
    ['PLACEMENT', telemetry.placement === null ? 'In progress' : `#${telemetry.placement}`],
    ['FAME', telemetry.fame === null ? 'League has not exposed it' : telemetry.fame.toLocaleString()],
    ['PARTNER', telemetry.partnerName || 'League has not exposed it'],
  ];

  return (
    <section className="active-game-dashboard__arena" aria-label="Arena match status">
      <div className="active-game-dashboard__arena-heading">
        <div>
          <span className="live-session__eyebrow">ARENA TELEMETRY</span>
          <h3>Round-by-round status</h3>
          <p>Read-only values directly exposed by League client. Augments and placements stay honest.</p>
        </div>
        <span className="active-game-dashboard__arena-pill">
          <Sparkles className="w-3 h-3 text-amber-300" /> ARENA
        </span>
      </div>
      <div className="active-game-dashboard__arena-grid">
        {fields.map(([label, value]) => (
          <div key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="active-game-dashboard__arena-augments">
        <div className="active-game-dashboard__team-head">
          <span className="flex items-center gap-1.5">
            <Trophy className="w-3.5 h-3.5 text-amber-300" /> AUGMENTS
          </span>
          <small>{telemetry.augments.length ? `${telemetry.augments.length} exposed` : 'Waiting for League data'}</small>
        </div>
        {telemetry.augments.length ? (
          <div className="active-game-dashboard__augment-list">
            {telemetry.augments.map((augment, index) => (
              <span key={`${augment.id || augment.name}-${index}`} title={augment.description || augment.name}>
                {augment.name}
                {augment.tier ? ` · ${augment.tier}` : ''}
              </span>
            ))}
          </div>
        ) : (
          <p className="active-game-dashboard__empty">
            Arena augments are not present in the current local game payload. Match history may expose them after the game.
          </p>
        )}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────
   In-Game Real-Time Scoreboard & Telemetry
   ───────────────────────────────────────────────────────────── */
function ActiveGameDashboard({ data }: { data: GameClientData }) {
  const players = data.players || [];
  const active = data.activePlayer;
  const allies = players.filter((player) => String(player.team || '').toUpperCase() === 'ORDER');
  const opponents = players.filter((player) => String(player.team || '').toUpperCase() === 'CHAOS');
  const recentEvents = (data.events || []).slice(-5).reverse();
  const championStats = active?.championStats || {};

  return (
    <div className="active-game-dashboard space-y-4">
      {/* Top Banner & Active Stats */}
      <div className="active-game-dashboard__head">
        <div>
          <span className="live-session__eyebrow">GAME CLIENT TELEMETRY</span>
          <h3>Live match dashboard</h3>
          <p>Read-only data from League’s local game client. RiftOps never sends gameplay input.</p>
        </div>
        <div className="active-game-dashboard__status">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" /> LIVE
        </div>
      </div>

      <ArenaLiveCard data={data} />

      {/* Summary KPI Cards */}
      <div className="active-game-dashboard__summary">
        <div>
          <small>PLAYER</small>
          <strong>{active?.summonerName || 'You'}</strong>
          <span>{active?.championName || 'Champion'} · Lv {formatScore(active?.level)}</span>
        </div>
        <div>
          <small>GAME TIME</small>
          <strong>{formatElapsed(Number(data.gameData?.gameTime) || 0)}</strong>
          <span>{data.gameData?.gameMode || 'League match'}</span>
        </div>
        <div>
          <small>CURRENT GOLD</small>
          <strong>{formatScore(active?.currentGold)}</strong>
          <span>In bag</span>
        </div>
        <div>
          <small>COMBAT STATS</small>
          <strong>{formatScore(championStats.attackDamage)} AD · {formatScore(championStats.abilityPower)} AP</strong>
          <span>{formatScore(championStats.armor)} Armor · {formatScore(championStats.magicResist)} MR</span>
        </div>
      </div>

      {/* 2-Column Team Scoreboard */}
      <div className="active-game-dashboard__columns">
        {[
          { label: 'YOUR TEAM (ORDER)', team: allies, side: 'order' as const },
          { label: 'OPPONENTS (CHAOS)', team: opponents, side: 'chaos' as const },
        ].map(({ label, team, side }) => (
          <div className={`active-game-dashboard__team is-${side}`} key={side}>
            <div className="active-game-dashboard__team-head">
              <span>{label}</span>
              <small>{team.length} players</small>
            </div>

            {team.length === 0 ? (
              <p className="active-game-dashboard__empty">Team data is still synchronizing with the game client.</p>
            ) : (
              team.map((player, index) => {
                const champAlias = resolveChampionAlias(player.championName || '');
                const avatarSrc = champAlias
                  ? `https://ddragon.leagueoflegends.com/cdn/14.24.1/img/champion/${champAlias}.png`
                  : null;

                return (
                  <div
                    className={`active-game-dashboard__player ${player.isDead ? 'is-dead' : ''}`}
                    key={`${player.summonerName || player.championName || 'player'}-${index}`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {/* Champion Avatar */}
                      <div className="active-game-dashboard__avatar-wrap">
                        {avatarSrc ? (
                          <img
                            src={avatarSrc}
                            alt={player.championName || 'Champion'}
                            className="active-game-dashboard__avatar-img"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <span className="active-game-dashboard__avatar-fallback">
                            {(player.championName || '?').charAt(0)}
                          </span>
                        )}
                        {player.level && (
                          <span className="active-game-dashboard__level-badge">{player.level}</span>
                        )}
                      </div>

                      <div className="min-w-0">
                        <strong className="block text-xs text-white truncate">
                          {player.championName || 'Champion unavailable'}
                        </strong>
                        <span className="block text-[11px] text-text-muted truncate">
                          {player.summonerName || 'Summoner unavailable'}
                          {player.position ? ` · ${player.position}` : ''}
                        </span>

                        {/* Items row */}
                        <div className="active-game-dashboard__items-row mt-1">
                          {(player.items || [])
                            .filter((item) => item.displayName || item.itemID || item.id)
                            .slice(0, 6)
                            .map((item, itemIdx) => {
                              const itemId = item.itemID || item.id;
                              const itemImg = itemId
                                ? `https://ddragon.leagueoflegends.com/cdn/14.24.1/img/item/${itemId}.png`
                                : null;
                              return (
                                <span
                                  key={itemIdx}
                                  className="active-game-dashboard__item-slot"
                                  title={item.displayName || `Item ${itemId}`}
                                >
                                  {itemImg ? (
                                    <img
                                      src={itemImg}
                                      alt={item.displayName || ''}
                                      className="w-full h-full object-cover rounded"
                                      onError={(e) => {
                                        (e.target as HTMLElement).style.display = 'none';
                                      }}
                                    />
                                  ) : (
                                    <span className="text-[8px] text-text-dim">●</span>
                                  )}
                                </span>
                              );
                            })}
                        </div>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <b className="block text-xs text-primary font-mono">{formatKDA(player)}</b>
                      <small className="block text-[10px] text-text-muted">
                        CS {formatScore(player.scores?.creepScore)}
                        {player.isDead ? ' · DEAD' : ''}
                      </small>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ))}
      </div>

      {/* Objective and Combat Events Stream */}
      <div className="active-game-dashboard__events">
        <div className="active-game-dashboard__team-head">
          <span className="flex items-center gap-1.5">
            <Flame className="w-3.5 h-3.5 text-amber-400" /> RECENT MATCH EVENTS
          </span>
          <small>{recentEvents.length ? 'Game client live feed' : 'Waiting for objective events'}</small>
        </div>
        {recentEvents.length === 0 ? (
          <p className="active-game-dashboard__empty">Objective, dragon, baron, and combat events will appear here.</p>
        ) : (
          <div className="space-y-1.5 pt-1">
            {recentEvents.map((event, index) => (
              <div
                className="active-game-dashboard__event"
                key={`${event.eventId || event.eventName || 'event'}-${index}`}
              >
                <span className="active-game-dashboard__event-dot" />
                <strong>{event.eventName || 'Game event'}</strong>
                <time>{formatElapsed(Number(event.eventTime) || 0)}</time>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Main LiveSessionPage Component
   ───────────────────────────────────────────────────────────── */
export default function LiveSessionPage({
  onOpenPlayFlow,
  onOpenCommandCenter,
  showToast: publishToast,
  remoteClient = false,
}: {
  onOpenPlayFlow: () => void;
  onOpenCommandCenter: () => void;
  showToast: Toast;
  remoteClient?: boolean;
}) {
  const {
    qol,
    status,
    health,
    connected,
    loading,
    stale,
    error,
    lastUpdated,
    gameflowSession,
    gameflowSessionAvailable,
    activeGame,
    activeGameAvailable,
    refresh,
  } = useLCUConnection();

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
  const customSession = Boolean(
    qol?.isCustom ||
    qol?.queueId === 3140 ||
    data.isCustom === true ||
    readNumber(data.queueId) === 3140 ||
    readString(data.gameMode).toUpperCase() === 'PRACTICETOOL'
  );

  const readyPayload = qol?.readyCheck;
  const readyRaw = readyPayload ? readyCheckNumber(readyPayload.timeLeft ?? readyPayload.remainingTime ?? readyPayload.timer) : null;
  const readySeconds = readyRaw === null ? null : readyRaw > 120 ? readyRaw / 1000 : readyRaw;

  useEffect(() => {
    if (readySeconds !== readyAnchor.current.seconds) {
      readyAnchor.current = { seconds: readySeconds, at: Date.now() };
    }
  }, [readySeconds]);

  const readyTimeLeft = useMemo(() => {
    return readySeconds === null ? null : Math.max(0, Math.ceil(readySeconds - (now - readyAnchor.current.at) / 1000));
  }, [now, readySeconds]);

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
  const stageIndex = STAGES.indexOf(phase);

  return (
    <div className="live-session-page animate-fadeIn">
      {/* Top Header */}
      <PageHeader
        icon={PhaseIcon({ phase })}
        eyebrow="LIVE SESSION MONITOR"
        title={livePhaseLabel(phase)}
        description={`${livePhaseDescription(phase)}${qol?.statusMessage ? ` · ${qol.statusMessage}` : ''}`}
        meta={
          <div className="flex items-center gap-2">
            <StatusBadge
              tone={unavailable ? 'neutral' : stale ? 'warning' : 'live'}
              pulse={!unavailable && !stale}
            >
              {unavailable ? 'League offline' : stale ? 'Recovering...' : 'LCU Live'}
            </StatusBadge>
            {isActiveLivePhase(phase) && (
              <span className="qol-rules-pill">
                <Clock3 className="w-3.5 h-3.5 text-amber-300" />
                <span>{formatElapsed(elapsed)} in phase</span>
              </span>
            )}
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void refresh()}
              disabled={loading}
              title="Refresh League state"
            >
              <RefreshCw className={loading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={onOpenCommandCenter}
            >
              <Compass className="w-3.5 h-3.5" />
              <span>Command Center</span>
            </button>
          </div>
        }
      />

      {/* Local Feedback */}
      <ActionFeedback state={feedback} className="live-session__local-feedback" />

      {/* Main Container */}
      <div className="live-session__body">
        {/* Matchflow Pipeline Stepper */}
        <nav className="live-pipeline-bar" aria-label="League matchflow pipeline">
          <div className="live-pipeline-bar__header">
            <span className="live-pipeline-bar__tag">
              <Sparkles className="w-3 h-3 text-amber-300" />
              <span>MATCHFLOW</span>
            </span>
          </div>

          <div className="live-pipeline-bar__steps">
            {STAGES.map((stage, index) => {
              const isCurrent = stage === phase;
              const isPassed = stageIndex >= 0 && index < stageIndex;

              return (
                <div key={stage} className="live-pipeline-bar__step-group">
                  <div
                    className={`live-pipeline-step ${isCurrent ? 'is-active' : ''} ${isPassed ? 'is-complete' : ''}`}
                  >
                    <span className="live-pipeline-step__num">
                      {isPassed ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : isCurrent ? (
                        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                      ) : (
                        <span>{index + 1}</span>
                      )}
                    </span>
                    <span className="live-pipeline-step__title">{livePhaseLabel(stage)}</span>
                  </div>

                  {index < STAGES.length - 1 && (
                    <ChevronRight className={`live-pipeline-step__arrow ${isPassed ? 'text-emerald-400/50' : 'text-white/15'}`} />
                  )}
                </div>
              );
            })}
          </div>

          <div className="live-pipeline-bar__current-status">
            <span className={`live-pipeline-dot ${isActiveLivePhase(phase) ? 'is-live' : ''}`} />
            <span className="live-pipeline-status-text">
              {livePhaseLabel(phase)} {isActiveLivePhase(phase) ? `(${formatElapsed(elapsed)})` : ''}
            </span>
          </div>
        </nav>

        {/* Stale or Reconnecting Banner */}
        {(stale || error || livePayloadLost) && (
          <div className="live-session__notice is-warn">
            <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0" />
            <div className="flex-1 min-w-0">
              <strong>
                {livePayloadLost
                  ? 'Live game data is temporarily unavailable'
                  : stale
                  ? 'Live data is temporarily stale'
                  : 'Live session data needs attention'}
              </strong>
              <span>
                {livePayloadLost
                  ? 'The LCU gameflow is still active, but its session payload did not respond. RiftOps will keep retrying without resetting the page.'
                  : error || 'RiftOps is preserving the last known phase while it retries the League client.'}
              </span>
            </div>
            <button type="button" className="btn-secondary text-xs" onClick={() => void refresh()}>
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────
           1. IDLE STATE: Pre-Flight Mission Control
           ───────────────────────────────────────────────────────────── */}
        {phase === 'IDLE' && (
          <section className="live-idle-cockpit grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Launchpad Card */}
            <div className="qol-card glass-card">
              <div className="qol-card__heading">
                <div className="qol-card__icon qol-card__icon--gold">
                  <Gamepad2 className="w-4 h-4" />
                </div>
                <div>
                  <small>PRE-FLIGHT LAUNCHPAD</small>
                  <h3>{unavailable ? 'Connect League to follow match' : 'Standby for Match'}</h3>
                  <p>
                    {unavailable
                      ? 'Launch the League Client and sign in. RiftOps will bind to the session automatically.'
                      : customSession
                      ? 'A custom lobby is currently open in League. Start it or close it here.'
                      : 'Choose your desired queue from Play Flow or launch League directly.'}
                  </p>
                </div>
              </div>

              <div className="qol-card__body space-y-3 pt-2">
                <div className="flex flex-wrap gap-2.5">
                  <ActionButton
                    busy={busy === 'launch'}
                    icon={Play}
                    onClick={() => void run('launch', 'League Client launch requested.', launchLCULeague)}
                  >
                    Open League Client
                  </ActionButton>

                  {customSession && (
                    <ActionButton
                      busy={busy === 'quit-custom'}
                      icon={CircleStop}
                      onClick={leaveCustomSession}
                      tone="danger"
                    >
                      Quit custom lobby
                    </ActionButton>
                  )}

                  <ActionButton
                    busy={false}
                    icon={Swords}
                    onClick={onOpenPlayFlow}
                    tone="quiet"
                  >
                    Go to Play Flow
                  </ActionButton>

                  <ActionButton
                    busy={false}
                    icon={ArrowRight}
                    onClick={onOpenCommandCenter}
                    tone="quiet"
                  >
                    Command Center
                  </ActionButton>
                </div>
              </div>
            </div>

            {/* Connection Diagnostics Card */}
            <div className="qol-card glass-card">
              <div className="qol-card__heading">
                <div className="qol-card__icon qol-card__icon--cyan">
                  <ShieldCheck className="w-4 h-4" />
                </div>
                <div>
                  <small>LCU TELEMETRY STATUS</small>
                  <h3>Connection Health</h3>
                  <p>Read-only listener status and response latency.</p>
                </div>
              </div>

              <div className="qol-card__body pt-2">
                <div className="settings-specs-box">
                  <div className="settings-specs-item">
                    <span className="settings-specs-item__label">SOCKET</span>
                    <strong className="settings-specs-item__val">
                      {connected ? 'Active WebSocket' : 'Disconnected'}
                    </strong>
                  </div>
                  <div className="settings-specs-item">
                    <span className="settings-specs-item__label">LATENCY</span>
                    <strong className="settings-specs-item__val">
                      {health?.latencyMs ? `${health.latencyMs}ms` : '—'}
                    </strong>
                  </div>
                  <div className="settings-specs-item">
                    <span className="settings-specs-item__label">GAMEFLOW</span>
                    <strong className="settings-specs-item__val">
                      {qol?.phase || 'Idle'}
                    </strong>
                  </div>
                  <div className="settings-specs-item">
                    <span className="settings-specs-item__label">PRESENCE</span>
                    <strong className="settings-specs-item__val">
                      {qol?.availability || 'Online'}
                    </strong>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ─────────────────────────────────────────────────────────────
           2. QUEUE STATE: Matchmaking Deck
           ───────────────────────────────────────────────────────────── */}
        {phase === 'QUEUE' && (
          <section className="live-session__panel is-queue glass-card p-5 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-4 border-b border-white/[0.06] pb-4">
              <div className="space-y-1">
                <span className="live-session__eyebrow">
                  <Zap className="w-3.5 h-3.5 text-amber-300" /> ACTIVE MATCHMAKING
                </span>
                <h2 className="text-xl font-black text-white">Searching for opponents</h2>
                <p className="text-xs text-text-muted">
                  {qol?.queueState || 'League client is currently matching your party.'}
                </p>
              </div>

              {/* Big Timer Dial */}
              <div className="live-queue-timer flex items-center gap-3 px-4 py-2.5 rounded-xl bg-primary/10 border border-primary/20">
                <Clock3 className="w-5 h-5 text-primary animate-pulse" />
                <div>
                  <strong className="block text-xl font-black font-mono text-white">
                    {formatElapsed(elapsed)}
                  </strong>
                  <small className="block text-[10px] text-text-muted">ELAPSED TIME</small>
                </div>
              </div>
            </div>

            {/* Queue Facts Grid */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                <small className="block text-[10px] font-bold text-text-muted">QUEUE</small>
                <strong className="block text-xs font-semibold text-white mt-0.5">{formatQueue(data)}</strong>
              </div>
              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                <small className="block text-[10px] font-bold text-text-muted">GAME MODE</small>
                <strong className="block text-xs font-semibold text-white mt-0.5">{formatGameMode(data)}</strong>
              </div>
              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                <small className="block text-[10px] font-bold text-text-muted">PRIMARY ROLE</small>
                <strong className="block text-xs font-semibold text-primary mt-0.5">
                  {qol?.firstRole || 'Unassigned'}
                </strong>
              </div>
              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                <small className="block text-[10px] font-bold text-text-muted">PARTY SIZE</small>
                <strong className="block text-xs font-semibold text-white mt-0.5">
                  {partySize === null ? 'Solo (1)' : `${partySize} Players`}
                </strong>
              </div>
              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                <small className="block text-[10px] font-bold text-text-muted">ESTIMATED WAIT</small>
                <strong className="block text-xs font-semibold text-white mt-0.5">
                  {estimatedWait === null ? 'Unavailable' : formatElapsed(estimatedWait)}
                </strong>
              </div>
            </div>

            {/* Queue Controls */}
            <div className="flex items-center justify-between pt-2">
              <ActionButton
                busy={busy === 'stop'}
                icon={CircleStop}
                tone="danger"
                onClick={() => void run('stop', 'Matchmaking stopped.', lcuStopQueue)}
              >
                Cancel Queue
              </ActionButton>
              <ActionButton busy={false} icon={ArrowRight} tone="quiet" onClick={onOpenCommandCenter}>
                Command Center
              </ActionButton>
            </div>
          </section>
        )}

        {/* ─────────────────────────────────────────────────────────────
           3. READY CHECK STATE: High Urgency Prompt
           ───────────────────────────────────────────────────────────── */}
        {phase === 'READY_CHECK' && (
          <section className="live-ready-card glass-card p-6 text-center space-y-4 max-w-xl mx-auto border-amber-400/40">
            <div className="w-12 h-12 rounded-2xl bg-amber-400/10 border border-amber-400/30 grid place-items-center mx-auto text-amber-300">
              <Check className="w-6 h-6 animate-pulse" />
            </div>

            <div className="space-y-1">
              <span className="live-session__eyebrow text-amber-400">TIME-SENSITIVE ACTION</span>
              <h2 className="text-2xl font-black text-white">Match Found!</h2>
              <p className="text-xs text-text-muted">
                Confirm your participation before the timer expires.
              </p>
            </div>

            {/* Countdown and Acceptance Pill */}
            <div className="flex items-center justify-center gap-4 py-2">
              <div className="px-4 py-2 rounded-xl bg-amber-400/15 border border-amber-400/30">
                <span className="text-[10px] text-text-muted uppercase block">COUNTDOWN</span>
                <strong className="text-2xl font-black font-mono text-amber-300">
                  {readyTimeLeft === null ? '—' : `${readyTimeLeft}s`}
                </strong>
              </div>
              <div className="px-4 py-2 rounded-xl bg-white/[0.04] border border-white/10">
                <span className="text-[10px] text-text-muted uppercase block">ACCEPTED</span>
                <strong className="text-2xl font-black font-mono text-white">
                  {acceptedPlayers === null ? '—' : `${acceptedPlayers}/10`}
                </strong>
              </div>
            </div>

            <div className="text-[11px] text-text-muted">
              Response: <span className="text-white font-semibold">{readyResponse}</span>
            </div>

            {/* Primary Action Buttons */}
            <div className="flex items-center justify-center gap-3 pt-2">
              <ActionButton
                busy={busy === 'accept'}
                icon={Check}
                onClick={() => void run('accept', 'Ready check accepted.', lcuAutoAccept)}
              >
                ACCEPT MATCH
              </ActionButton>
              <ActionButton
                busy={busy === 'decline'}
                icon={X}
                tone="quiet"
                onClick={() => void run('decline', 'Ready check declined.', lcuDeclineReady)}
              >
                Decline
              </ActionButton>
            </div>
          </section>
        )}

        {/* ─────────────────────────────────────────────────────────────
           4. CHAMP SELECT STATE: Full Drafting Workspace
           ───────────────────────────────────────────────────────────── */}
        {phase === 'CHAMP_SELECT' && (
          <section className="live-session__panel live-session__champ-select-panel space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
              <div>
                <span className="live-session__eyebrow">
                  <Swords className="w-3.5 h-3.5 text-primary" /> DRAFT COCKPIT
                </span>
                <h2 className="text-lg font-black text-white">
                  {arenaMode ? 'Arena Champion Select' : 'Champion Select'}
                </h2>
              </div>
              {customSession && (
                <ActionButton
                  busy={busy === 'quit-custom'}
                  icon={CircleStop}
                  tone="danger"
                  onClick={leaveCustomSession}
                >
                  Quit custom game
                </ActionButton>
              )}
            </div>

            <ChampSelectWorkspace
              connected={connected}
              active
              arenaMode={arenaMode}
              remoteClient={remoteClient}
              onToast={showToast}
            />
          </section>
        )}

        {/* ─────────────────────────────────────────────────────────────
           5. LOADING, IN_GAME, POST_GAME, RECONNECTING STATES
           ───────────────────────────────────────────────────────────── */}
        {(phase === 'LOADING' || phase === 'IN_GAME' || phase === 'POST_GAME' || phase === 'RECONNECTING') && (
          <section className="live-session__panel is-game glass-card p-5 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-white/[0.06]">
              <div>
                <span className="live-session__eyebrow">
                  {phase === 'IN_GAME' ? 'ACTIVE MATCH' : livePhaseLabel(phase).toUpperCase()}
                </span>
                <h2 className="text-xl font-black text-white">
                  {phase === 'IN_GAME' ? 'Match In Progress' : livePhaseLabel(phase)}
                </h2>
                <p className="text-xs text-text-muted">
                  {sessionPhase(gameflowSession) || livePhaseDescription(phase)}
                </p>
              </div>

              {gameId && (
                <button
                  type="button"
                  className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono"
                  onClick={() => void copyGameId()}
                >
                  <Clipboard className="w-3.5 h-3.5 text-primary" />
                  <span>Game ID: {gameId}</span>
                </button>
              )}
            </div>

            {/* Quick Facts */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                <small className="block text-[10px] text-text-muted font-bold">GAME MODE</small>
                <strong className="block text-xs text-white">{formatGameMode(data)}</strong>
              </div>
              <div className="p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                <small className="block text-[10px] text-text-muted font-bold">QUEUE</small>
                <strong className="block text-xs text-white">{formatQueue(data)}</strong>
              </div>
              <div className="p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                <small className="block text-[10px] text-text-muted font-bold">MAP</small>
                <strong className="block text-xs text-white">{formatMap(data)}</strong>
              </div>
              <div className="p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.05]">
                <small className="block text-[10px] text-text-muted font-bold">MATCH TIME</small>
                <strong className="block text-xs text-primary font-mono">
                  {gameLength !== null ? formatElapsed(gameLength) : formatElapsed(elapsed)}
                </strong>
              </div>
            </div>

            {/* Detailed Scoreboard or Roster */}
            {phase === 'IN_GAME' && activeGame?.available ? (
              <ActiveGameDashboard data={activeGame} />
            ) : roster.length > 0 ? (
              <div className="live-session__roster space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-white">
                  <Users className="w-4 h-4 text-primary" />
                  <span>Participants from LCU Session</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  {roster.slice(0, 10).map((player, index) => (
                    <div
                      className="p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs"
                      key={`${readString(player.summonerId || player.playerId)}-${index}`}
                    >
                      <strong className="block text-white truncate">
                        {readString(player.championId || player.championName) || 'Champion'}
                      </strong>
                      <small className="block text-text-muted truncate">
                        {readString(player.summonerName || player.displayName) || 'Summoner'}
                      </small>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="live-session__unavailable py-8 text-center space-y-2">
                <WifiOff className="w-6 h-6 text-text-dim mx-auto" />
                <span className="block text-xs text-text-muted max-w-md mx-auto">
                  {phase === 'IN_GAME' && activeGameAvailable === false
                    ? 'League client local telemetry endpoint is still preparing. Scoreboard will populate automatically once the game client exposes its read-only data feed.'
                    : 'Scoreboard is synchronizing with League client.'}
                </span>
              </div>
            )}

            {/* Post-Game and Quit Controls */}
            <div className="flex items-center justify-between pt-3 border-t border-white/[0.06]">
              <div className="flex items-center gap-2">
                {(phase === 'LOADING' || phase === 'IN_GAME' || phase === 'RECONNECTING') && customSession && (
                  <ActionButton
                    busy={busy === 'quit-custom'}
                    icon={CircleStop}
                    tone="danger"
                    onClick={leaveCustomSession}
                  >
                    Quit custom game
                  </ActionButton>
                )}
                {phase === 'POST_GAME' && (
                  <ActionButton
                    busy={busy === 'again'}
                    icon={RotateCcw}
                    onClick={() => void run('again', 'Returning to the lobby.', lcuPlayAgain)}
                  >
                    Play Again
                  </ActionButton>
                )}
                {phase === 'RECONNECTING' && (
                  <ActionButton
                    busy={busy === 'refresh'}
                    icon={RefreshCw}
                    onClick={() => void run('refresh', 'League state refreshed.', refresh)}
                  >
                    Reconnect
                  </ActionButton>
                )}
              </div>

              {phase !== 'POST_GAME' && (
                <ActionButton busy={false} icon={ArrowRight} tone="quiet" onClick={onOpenCommandCenter}>
                  Command Center
                </ActionButton>
              )}
            </div>
          </section>
        )}

        {/* Footer info */}
        <footer className="live-session__footer flex items-center justify-between text-[11px] text-text-dim pt-2 border-t border-white/[0.04]">
          <span className="flex items-center gap-1.5">
            <Wifi className="w-3.5 h-3.5 text-emerald-400" />
            <span>LCU Gameflow source of truth</span>
          </span>
          <span>
            {lastUpdated
              ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : 'Waiting for update'}
          </span>
          <span>{health?.latencyMs ? `${health.latencyMs}ms latency` : 'Latency normal'}</span>
        </footer>
      </div>
    </div>
  );
}
