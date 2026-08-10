import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, BellRing, Check, CheckCircle2, ChevronRight, CircleStop,
  ChevronDown, Clock3, Gift, Heart, Image, Loader2, MessageSquareText, Play,
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
  fetchLCUProfileIconMetadata,
  fetchQueuePresets,
  fetchQoLPreferences,
  lcuAutoAccept,
  lcuAutoRequeue,
  lcuAutoRoles,
  lcuStopQueue,
  saveQueuePreset,
  saveQoLPreferences,
  type DDProfileIcon,
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

  const [champions, setChampions] = useState<BackgroundChampion[]>([]);
  const [skins, setSkins] = useState<BackgroundSkin[]>([]);
  const [selectedChampion, setSelectedChampion] = useState<number | null>(null);
  const [selectedSkin, setSelectedSkin] = useState<number | null>(null);
  const [catalogueLoading, setCatalogueLoading] = useState(false);
  const [catalogueError, setCatalogueError] = useState('');

  const [profileIcons, setProfileIcons] = useState<DDProfileIcon[]>([]);
  const [ddVersion, setDDVersion] = useState('');
  const [iconSearch, setIconSearch] = useState('');
  const [iconsLoading, setIconsLoading] = useState(true);
  const [iconsError, setIconsError] = useState('');
  const [iconReloadKey, setIconReloadKey] = useState(0);
  const [iconLimit, setIconLimit] = useState(72);
  const [failedIconImages, setFailedIconImages] = useState<Set<number>>(() => new Set());
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
    let cancelled = false;
    setIconsLoading(true);
    setIconsError('');
    Promise.allSettled([fetchDDragonVersion(), fetchDDProfileIcons()])
      .then(([versionResult, iconsResult]) => {
        if (cancelled) return;
        if (versionResult.status === 'fulfilled') setDDVersion(versionResult.value.version);
        if (iconsResult.status === 'fulfilled') {
          const icons = Object.values(iconsResult.value.data || {})
            .filter((icon) => Number.isFinite(icon.id) && icon.id >= 0)
            .map((icon) => ({ ...icon, name: icon.name || `Profile icon ${icon.id}` }))
            .sort((a, b) => b.id - a.id);
          setProfileIcons(icons);
          setIconLimit(72);
          setFailedIconImages(new Set());
          if (icons.length === 0) setIconsError('No profile icons were returned by Data Dragon.');
        } else {
          setProfileIcons([]);
          setIconsError('The profile icon catalogue could not be loaded.');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfileIcons([]);
          setIconsError('The profile icon catalogue could not be loaded.');
        }
      })
      .finally(() => {
        if (!cancelled) setIconsLoading(false);
      });
    return () => { cancelled = true; };
  }, [iconReloadKey]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    fetchLCUProfileIconMetadata()
      .then((metadata) => {
        if (cancelled) return;
        setProfileIcons((current) => {
          const byID = new Map(current.map((icon) => [icon.id, icon]));
          metadata.forEach((metadataIcon) => {
            const id = Number(metadataIcon.id);
            if (!Number.isFinite(id) || id < 0) return;
            const title = String(metadataIcon.title || '').trim();
            const existing = byID.get(id);
            byID.set(id, {
              ...(existing || {
                id,
                image: { full: '', sprite: '', group: 'profileicon' },
              }),
              name: title || existing?.name || `Profile icon ${id}`,
              lcuImagePath: metadataIcon.imagePath || existing?.lcuImagePath,
            });
          });
          return Array.from(byID.values()).sort((a, b) => b.id - a.id);
        });
      })
      .catch(() => {
        // Data Dragon remains the catalogue fallback when the LCU metadata is unavailable.
      });
    return () => { cancelled = true; };
  }, [connected, iconReloadKey]);

  useEffect(() => {
    fetchQueuePresets()
      .then((data) => {
        setQueuePresets(data.presets || {});
        setQueueLabels(data.queues || {});
      })
      .catch(() => {});
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
      .slice(0, iconLimit);
  }, [iconLimit, iconSearch, profileIcons]);

  const iconImageURL = (icon: DDProfileIcon) => {
    if (failedIconImages.has(icon.id)) {
      return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${icon.id}.jpg`;
    }
    if (icon.lcuImagePath && icon.lcuImagePath.startsWith('/lol-game-data/')) {
      return icon.lcuImagePath;
    }
    return ddVersion
      ? ddProfileIcon(ddVersion, icon.id)
      : `https://ddragon.leagueoflegends.com/cdn/img/profileicon/${icon.id}.png`;
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

        <FriendsPanel connected={connected} />

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
              aria-label="Search profile icons"
            />
            <span>{profileIcons.length ? `${visibleIcons.length} of ${profileIcons.length}` : '—'}</span>
          </div>
          {iconsLoading && <div className="qol-library-state"><Loader2 className="animate-spin" /><span>Loading the icon library…</span></div>}
          {!iconsLoading && iconsError && (
            <div className="qol-library-state qol-library-state--error">
              <XCircle />
              <span>{iconsError}</span>
              <button type="button" onClick={() => setIconReloadKey((key) => key + 1)}>Retry</button>
            </div>
          )}
          {!iconsLoading && !iconsError && (
            <>
              <div className="qol-icon-grid">
                {visibleIcons.map((icon) => (
                  <button
                    type="button"
                    key={icon.id}
                    title={`${icon.name || `Profile icon ${icon.id}`} (#${icon.id})`}
                    aria-label={`Apply ${icon.name || `profile icon ${icon.id}`}`}
                    className={state?.profileIconId === icon.id ? 'is-current' : ''}
                    disabled={!connected || activeAction === `icon-${icon.id}`}
                    onClick={() => void runAction(`icon-${icon.id}`, 'Profile icon applied.', () =>
                      post('/api/lcu/profile-icon', { iconId: icon.id }),
                    )}
                  >
                    <img
                      src={iconImageURL(icon)}
                      alt={icon.name || `Profile icon ${icon.id}`}
                      loading="lazy"
                      onError={(event) => {
                        if (!failedIconImages.has(icon.id)) {
                          setFailedIconImages((current) => new Set(current).add(icon.id));
                          return;
                        }
                        event.currentTarget.style.opacity = '0';
                      }}
                    />
                    {activeAction === `icon-${icon.id}` && <Loader2 className="animate-spin" />}
                    <span>{icon.name || `Profile icon ${icon.id}`} · #{icon.id}</span>
                  </button>
                ))}
              </div>
              {visibleIcons.length < profileIcons.length && (
                <button type="button" className="qol-library-more" onClick={() => setIconLimit((limit) => limit + 72)}>
                  Load more icons <ChevronDown />
                </button>
              )}
            </>
          )}
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

        <ChampSelectWorkspace connected={connected} active={inChampSelect} />

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
