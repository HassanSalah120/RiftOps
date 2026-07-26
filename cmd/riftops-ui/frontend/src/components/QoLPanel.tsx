import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, BellRing, Check, CheckCircle2, ChevronRight, CircleStop,
  Clock3, Gift, Heart, Image, Loader2, MessageSquareText, Play,
  RefreshCw, Search, ShieldCheck, Sparkles, Swords, UserRound, Users,
  Wifi, WifiOff, XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  ddProfileIcon,
  fetchDDProfileIcons,
  fetchDDragonVersion,
  fetchLCUBackgroundChampions,
  fetchLCUBackgroundSkins,
  fetchQoLPreferences,
  fetchQoLState,
  lcuAutoAccept,
  lcuAutoRequeue,
  lcuAutoRoles,
  lcuStopQueue,
  saveQoLPreferences,
  type DDProfileIcon,
  type QoLPreferences,
  type QoLState,
} from '../api';
import ConfirmModal from './ConfirmModal';
import type { ConfirmAction } from '../types';

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

type BackgroundChampion = { id: number; name: string };
type BackgroundSkin = { id: number; name: string };
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
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description?: string;
  children: React.ReactNode;
  accent?: 'gold' | 'cyan' | 'violet' | 'rose' | 'emerald';
  className?: string;
}) {
  return (
    <section className={`qol-panel qol-panel--${accent} ${className}`}>
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
    <div className={`qol-toast ${toast.ok ? 'is-success' : 'is-error'}`}>
      {toast.ok ? <CheckCircle2 /> : <XCircle />}
      <span>{toast.message}</span>
    </div>
  );
}

export default function QoLPanel() {
  const [state, setState] = useState<QoLState | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [preferences, setPreferences] = useState<QoLPreferences>({ autoAccept: false, autoPlayAgain: false });
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [activeAction, setActiveAction] = useState('');
  const [toast, setToast] = useState<ToastState>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const [statusMessage, setStatusMessage] = useState('');
  const statusHydrated = useRef(false);
  const rolesHydrated = useRef(false);
  const [firstRole, setFirstRole] = useState('MIDDLE');
  const [secondRole, setSecondRole] = useState('TOP');

  const [champions, setChampions] = useState<BackgroundChampion[]>([]);
  const [skins, setSkins] = useState<BackgroundSkin[]>([]);
  const [selectedChampion, setSelectedChampion] = useState<number | null>(null);
  const [selectedSkin, setSelectedSkin] = useState<number | null>(null);
  const [catalogueLoading, setCatalogueLoading] = useState(false);
  const [catalogueError, setCatalogueError] = useState('');

  const [profileIcons, setProfileIcons] = useState<DDProfileIcon[]>([]);
  const [ddVersion, setDDVersion] = useState('');
  const [iconSearch, setIconSearch] = useState('');
  const [honorBallot, setHonorBallot] = useState<HonorBallot | null>(null);
  const [honorType, setHonorType] = useState('HEART');

  const showToast = useCallback((message: string, ok = true) => {
    setToast({ message, ok });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  const refreshState = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const next = await fetchQoLState();
      setState(next);
      setConnected(true);
      if (!statusHydrated.current) {
        setStatusMessage(next.statusMessage || '');
        statusHydrated.current = true;
      }
      if (!rolesHydrated.current && next.firstRole) {
        setFirstRole(next.firstRole);
        setSecondRole(next.secondRole || 'FILL');
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
  }, []);

  useEffect(() => {
    void refreshState();
    const timer = window.setInterval(() => void refreshState(), 3000);
    return () => window.clearInterval(timer);
  }, [refreshState]);

  useEffect(() => {
    fetchQoLPreferences()
      .then(setPreferences)
      .catch((error) => showToast(error.message || 'Could not load automation preferences.', false))
      .finally(() => setPreferencesLoading(false));
  }, [showToast]);

  useEffect(() => {
    Promise.all([fetchDDragonVersion(), fetchDDProfileIcons()])
      .then(([version, icons]) => {
        setDDVersion(version.version);
        setProfileIcons(Object.values(icons.data || {}).sort((a, b) => b.id - a.id));
      })
      .catch(() => {
        setProfileIcons([]);
      });
  }, []);

  const loadChampions = useCallback(async () => {
    if (!connected || catalogueLoading) return;
    setCatalogueLoading(true);
    setCatalogueError('');
    try {
      const data = await fetchLCUBackgroundChampions();
      const values = (Array.isArray(data) ? data : Object.values(data || {}))
        .map((champion: any) => ({ id: Number(champion.id), name: String(champion.name || `Champion ${champion.id}`) }))
        .filter((champion: BackgroundChampion) => champion.id > 0)
        .sort((a: BackgroundChampion, b: BackgroundChampion) => a.name.localeCompare(b.name));
      setChampions(values);
    } catch (error: any) {
      setCatalogueError(error.message || 'Champion catalogue is not available yet.');
    } finally {
      setCatalogueLoading(false);
    }
  }, [catalogueLoading, connected]);

  useEffect(() => {
    if (connected && champions.length === 0 && !catalogueError) void loadChampions();
  }, [connected, champions.length, catalogueError, loadChampions]);

  useEffect(() => {
    if (!selectedChampion) {
      setSkins([]);
      return;
    }
    let cancelled = false;
    setCatalogueLoading(true);
    fetchLCUBackgroundSkins(selectedChampion)
      .then((data) => {
        if (cancelled) return;
        const values = (Array.isArray(data) ? data : Object.values(data || {}))
          .map((skin: any) => ({ id: Number(skin.id), name: String(skin.name || `Skin ${skin.id}`) }))
          .filter((skin: BackgroundSkin) => skin.id > 0)
          .sort((a: BackgroundSkin, b: BackgroundSkin) => a.name.localeCompare(b.name));
        setSkins(values);
      })
      .catch((error) => !cancelled && setCatalogueError(error.message || 'Could not load skins.'))
      .finally(() => !cancelled && setCatalogueLoading(false));
    return () => { cancelled = true; };
  }, [selectedChampion]);

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

  const visibleIcons = useMemo(() => {
    const query = iconSearch.trim().toLowerCase();
    return profileIcons
      .filter((icon) => !query || String(icon.id).includes(query) || icon.name?.toLowerCase().includes(query))
      .slice(0, 72);
  }, [iconSearch, profileIcons]);

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

      <div className="qol-grid">
        <Panel
          icon={BellRing}
          eyebrow="AUTOMATION"
          title="Set it once"
          description="These preferences stay active while RiftOps is running, even when this page is closed."
          accent="gold"
        >
          <div className="qol-stack">
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
          </div>
        </Panel>

        <Panel
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
        </Panel>

        <Panel
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
          icon={Image}
          eyebrow="PROFILE STUDIO"
          title="Background skin"
          description="Choose any champion skin exposed by your local League client."
          accent="violet"
        >
          <div className="qol-inline-form qol-inline-form--profile">
            <select
              value={selectedChampion ?? ''}
              disabled={!connected || catalogueLoading}
              onChange={(event) => {
                setSelectedChampion(Number(event.target.value) || null);
                setSelectedSkin(null);
                setCatalogueError('');
              }}
            >
              <option value="">{catalogueLoading && champions.length === 0 ? 'Loading champions...' : 'Choose champion'}</option>
              {champions.map((champion) => <option key={champion.id} value={champion.id}>{champion.name}</option>)}
            </select>
            <select
              value={selectedSkin ?? ''}
              disabled={!selectedChampion || catalogueLoading}
              onChange={(event) => setSelectedSkin(Number(event.target.value) || null)}
            >
              <option value="">{catalogueLoading && selectedChampion ? 'Loading skins...' : 'Choose skin'}</option>
              {skins.map((skin) => <option key={skin.id} value={skin.id}>{skin.name}</option>)}
            </select>
            <ActionButton
              icon={Sparkles}
              disabled={!selectedSkin}
              loading={activeAction === 'background'}
              onClick={() => void runAction('background', 'Profile background updated.', () =>
                post('/api/lcu/profile-background', { skinId: selectedSkin }),
              )}
            >
              Apply
            </ActionButton>
          </div>
          {catalogueError && (
            <button type="button" className="qol-retry" onClick={() => void loadChampions()}>
              {catalogueError} Retry
            </button>
          )}
          {state?.backgroundSkinId ? <p className="qol-current-value">Current background skin ID: {state.backgroundSkinId}</p> : null}
        </Panel>

        <Panel
          icon={UserRound}
          eyebrow="PROFILE STUDIO"
          title="Profile icon library"
          description="Search and apply an icon visually—no more guessing numeric IDs."
          accent="violet"
          className="qol-panel--wide"
        >
          <div className="qol-search">
            <Search />
            <input
              value={iconSearch}
              onChange={(event) => setIconSearch(event.target.value)}
              placeholder="Search by icon name or ID"
            />
            <span>{visibleIcons.length} shown</span>
          </div>
          <div className="qol-icon-grid">
            {visibleIcons.map((icon) => (
              <button
                type="button"
                key={icon.id}
                title={`${icon.name || 'Profile icon'} #${icon.id}`}
                className={state?.profileIconId === icon.id ? 'is-current' : ''}
                disabled={!connected || activeAction === `icon-${icon.id}`}
                onClick={() => void runAction(`icon-${icon.id}`, `Profile icon ${icon.id} applied.`, () =>
                  post('/api/lcu/profile-icon', { iconId: icon.id }),
                )}
              >
                {ddVersion && <img src={ddProfileIcon(ddVersion, icon.id)} alt="" loading="lazy" />}
                {activeAction === `icon-${icon.id}` && <Loader2 className="animate-spin" />}
                <span>#{icon.id}</span>
              </button>
            ))}
          </div>
          {profileIcons.length === 0 && <p className="qol-empty">Profile icon catalogue is unavailable. Check your internet connection and retry.</p>}
        </Panel>

        <Panel
          icon={Swords}
          eyebrow="CHAMPION SELECT"
          title="Dodge control"
          description="This action is unlocked only while League reports an active champion select."
          accent="rose"
        >
          <div className="qol-danger-box">
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
          </div>
        </Panel>

        <Panel
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
              <div className="qol-segmented qol-segmented--compact">
                {[
                  ['HEART', 'Great teammate'],
                  ['SHOTCALLER', 'Shotcaller'],
                  ['COOL', 'Stayed cool'],
                ].map(([value, label]) => (
                  <button key={value} type="button" className={honorType === value ? 'is-selected' : ''} onClick={() => setHonorType(value)}>
                    {label}
                  </button>
                ))}
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
