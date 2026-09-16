import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  FolderOpen,
  HardDrive,
  Monitor,
  MessageCircle,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
} from 'lucide-react';
import type * as api from '../api';
import { GAMES, type LogLine, type Release } from '../types';
import PageHeader from './PageHeader';
import { StatusBadge, ActionFeedback, type FeedbackState } from './DesignPrimitives';
import ConfirmModal from './ConfirmModal';
import LogViewer from './LogViewer';
import { PERFORMANCE_MODES, useLCUConnection } from './lcuConnectionContext';
import type { ConfirmAction } from '../types';

export type SettingsPageProps = {
  snapshot: {
    Version: string;
    Platform: string;
    Phase: string;
    Detail: string;
    Game: string;
    Status: string;
    Enabled: boolean;
    ChatPort: number;
    StartedAt: string;
    ActiveProfileID: string;
  };
  prefGame: string;
  setPrefGame: (game: string) => void;
  prefStartup: string;
  setPrefStartup: (status: string) => void;
  prefMUC: boolean;
  setPrefMUC: (enabled: boolean) => void;
  prefUpdates: boolean;
  setPrefUpdates: (enabled: boolean) => void;
  riotClientPath: string;
  setRiotClientPath: (path: string) => void;
  riotLocationBusy: boolean;
  settingsFeedback: FeedbackState;
  setSettingsFeedback: (feedback: FeedbackState) => void;
  autostartEnabled: boolean;
  handleAutostart: (enabled: boolean) => Promise<void>;
  compactMode: boolean;
  setCompactMode: (enabled: boolean) => void;
  reducedMotion: boolean;
  setReducedMotion: (enabled: boolean) => void;
  performanceMode: keyof typeof PERFORMANCE_MODES;
  setPerformanceMode: (mode: keyof typeof PERFORMANCE_MODES) => void;
  locale: 'en' | 'ar';
  setLocale: (locale: 'en' | 'ar') => void;
  t: (key: string) => string;
  persistPreferences: (prefs: Partial<api.Preferences>) => Promise<void>;
  updateRiotLocation: (action: () => Promise<api.RiotClientLocation>, successMessage: string) => Promise<void>;
  api: typeof api;
  handleQuit: () => void;
  resetWorkspacePreferences: () => void;
  clearAssetCache: () => void;
  showToast: (title: string, message: string, type?: 'info' | 'success' | 'error') => void;
  lcuConnected: boolean;
  onUpdateDetected?: (release: Release) => void;
  logs?: LogLine[];
  onClearLogs?: () => void;
};

type SettingsTab = 'all' | 'launch' | 'interface' | 'league' | 'system' | 'diagnostics';

const PRESENCE_MODES = [
  { id: 'last', label: 'Remember Last', color: 'bg-amber-400' },
  { id: 'chat', label: 'Online', color: 'bg-emerald-400' },
  { id: 'offline', label: 'Offline (Masked)', color: 'bg-slate-400' },
  { id: 'mobile', label: 'Mobile', color: 'bg-sky-400' },
] as const;

export default function SettingsPage({
  snapshot,
  prefGame,
  setPrefGame,
  prefStartup,
  setPrefStartup,
  prefMUC,
  setPrefMUC,
  prefUpdates,
  setPrefUpdates,
  riotClientPath,
  setRiotClientPath,
  riotLocationBusy,
  settingsFeedback,
  setSettingsFeedback,
  autostartEnabled,
  handleAutostart,
  compactMode,
  setCompactMode,
  reducedMotion,
  setReducedMotion,
  performanceMode,
  setPerformanceMode,
  locale,
  setLocale,
  t,
  persistPreferences,
  updateRiotLocation,
  api: apiActions,
  handleQuit,
  resetWorkspacePreferences,
  clearAssetCache,
  showToast,
  lcuConnected,
  onUpdateDetected,
  logs = [],
  onClearLogs,
}: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('all');
  const [confirmModal, setConfirmModal] = useState<ConfirmAction | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [chatPrivacy, setChatPrivacy] = useState<api.ChatPrivacy | null>(null);
  const [chatPrivacyBusy, setChatPrivacyBusy] = useState('');
  const [proxySetup, setProxySetup] = useState<api.ProxySetupStatus | null>(null);
  const [proxyHostname, setProxyHostname] = useState('');
  const [proxyToken, setProxyToken] = useState('');
  const [proxyEmail, setProxyEmail] = useState('');
  const [proxyBusy, setProxyBusy] = useState(false);
  const { streamerMode, setStreamerMode } = useLCUConnection();

  useEffect(() => {
    let cancelled = false;
    void apiActions.fetchProxySetupStatus().then((status) => {
      if (cancelled) return;
      setProxySetup(status);
      setProxyHostname(status.hostname || '');
    }).catch(() => {
      // The normal loopback proxy remains available if setup status cannot be read.
    });
    return () => { cancelled = true; };
  }, [apiActions]);

  const handleProxySetup = async () => {
    if (!proxyHostname.trim() || !proxyToken.trim()) {
      setSettingsFeedback({ tone: 'error', message: 'Enter your DuckDNS hostname and token.' });
      return;
    }
    setProxyBusy(true);
    setSettingsFeedback({ tone: 'working', message: 'Requesting a trusted certificate. This can take a minute…' });
    try {
      const status = await apiActions.setupProxyCertificate(proxyHostname.trim(), proxyToken, proxyEmail.trim());
      setProxySetup(status);
      setProxyToken('');
      setSettingsFeedback({ tone: 'success', message: 'Trusted chat proxy is ready. Close and restart Riot Client from RiftOps.' });
    } catch (error: any) {
      setSettingsFeedback({ tone: 'error', message: error?.message || 'Trusted chat setup failed.' });
    } finally {
      setProxyBusy(false);
    }
  };

  const handleProxyClear = async () => {
    setProxyBusy(true);
    try {
      const status = await apiActions.clearProxySetup();
      setProxySetup(status);
      setProxyHostname('');
      setSettingsFeedback({ tone: 'success', message: 'Trusted hostname removed. RiftOps will use its normal local fallback.' });
    } catch (error: any) {
      setSettingsFeedback({ tone: 'error', message: error?.message || 'Could not clear trusted chat setup.' });
    } finally {
      setProxyBusy(false);
    }
  };

  useEffect(() => {
    if (!lcuConnected || (activeTab !== 'all' && activeTab !== 'league')) {
      if (!lcuConnected) setChatPrivacy(null);
      return undefined;
    }
    let cancelled = false;
    void apiActions.fetchLCUChatPrivacy().then((value) => {
      if (!cancelled) setChatPrivacy(value);
    }).catch(() => {
      if (!cancelled) setChatPrivacy(null);
    });
    return () => { cancelled = true; };
  }, [activeTab, apiActions, lcuConnected]);

  const updateChatPrivacy = async (key: string, value: boolean) => {
    setChatPrivacyBusy(key);
    try {
      const settings = await apiActions.updateLCUChatSettings({ [key]: value });
      setChatPrivacy((current) => current ? { ...current, settings: { ...current.settings, ...settings } } : current);
      setSettingsFeedback({ tone: 'success', message: 'League chat privacy updated.' });
    } catch (reason: any) {
      setSettingsFeedback({ tone: 'error', message: reason?.message || 'League chat privacy could not be updated.' });
    } finally {
      setChatPrivacyBusy('');
    }
  };

  const handleManualUpdateCheck = async () => {
    setCheckingUpdates(true);
    try {
      const res = await apiActions.checkUpdate(true);
      if (res.available && res.release) {
        onUpdateDetected?.(res.release);
      } else if (res.error) {
        showToast('Update check failed', res.error, 'error');
      } else {
        const ver = res.currentVersion || snapshot.Version;
        showToast('Up to date', ver ? `You are using the latest version of RiftOps (v${ver}).` : 'You are using the latest development build of RiftOps.', 'success');
      }
    } catch (err: any) {
      showToast('Update check failed', err?.message || 'Could not reach update service', 'error');
    } finally {
      setCheckingUpdates(false);
    }
  };

  const platformLabel = useMemo(() => {
    if (snapshot.Platform === 'darwin') return 'macOS';
    if (snapshot.Platform === 'windows') return 'Windows x64';
    return snapshot.Platform || 'Desktop';
  }, [snapshot.Platform]);

  const pathStatus = useMemo(() => {
    if (riotClientPath && riotClientPath.trim()) {
      return { tone: 'live' as const, label: 'Custom Override Active' };
    }
    return { tone: 'neutral' as const, label: 'Auto-discovery Engine' };
  }, [riotClientPath]);

  const handleResetConfirm = () => {
    setConfirmModal({
      open: true,
      title: 'Reset Workspace Preferences?',
      message: 'This will restore layout density, motion settings, skin filters, and tab selections back to their factory defaults.',
      actionLabel: 'Reset Defaults',
      danger: true,
      onConfirm: () => {
        setConfirmModal(null);
        resetWorkspacePreferences();
      },
    });
  };

  const handleClearCacheConfirm = () => {
    setConfirmModal({
      open: true,
      title: 'Clear Asset Cache?',
      message: 'This removes cached skin portraits, splash metadata, and offline game catalogs. Catalogs will re-sync cleanly on next open.',
      actionLabel: 'Clear Cache',
      danger: false,
      onConfirm: () => {
        setConfirmModal(null);
        clearAssetCache();
      },
    });
  };

  return (
    <div className="settings-page animate-fadeIn">
      {confirmModal && <ConfirmModal action={confirmModal} onClose={() => setConfirmModal(null)} />}

      {/* Header */}
      <PageHeader
        icon={SlidersHorizontal}
        eyebrow="WORKSPACE & SYSTEM PREFERENCES"
        title="Application Settings"
        description="Configure launch targets, client performance mode, League installation paths, and desktop integration."
        meta={
          <StatusBadge tone="neutral" icon={ShieldCheck}>
            {snapshot.Version ? `RiftOps v${snapshot.Version}` : 'RiftOps Desktop'} · {platformLabel}
          </StatusBadge>
        }
        actions={
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-extrabold text-cyan-300 bg-cyan-500/10 border border-cyan-500/30">
              <Monitor className="w-3.5 h-3.5 text-cyan-400" />
              <span>{lcuConnected ? 'LCU Connected' : 'LCU Idle'}</span>
            </span>
          </div>
        }
      />

      {/* Category Sub-Navigation Bar */}
      <nav className="flex items-center gap-1.5 p-1.5 bg-dark-card/60 backdrop-blur-md rounded-2xl border border-white/5 overflow-x-auto mb-6" aria-label="Settings categories">
        <button
          type="button"
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition whitespace-nowrap ${activeTab === 'all' ? 'bg-primary/15 text-primary border border-primary/30 font-bold' : 'text-text-muted hover:text-white hover:bg-white/5'}`}
          onClick={() => setActiveTab('all')}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span>All Settings</span>
        </button>
        <button
          type="button"
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition whitespace-nowrap ${activeTab === 'launch' ? 'bg-primary/15 text-primary border border-primary/30 font-bold' : 'text-text-muted hover:text-white hover:bg-white/5'}`}
          onClick={() => setActiveTab('launch')}
        >
          <Play className="w-3.5 h-3.5" />
          <span>Launch & Startup</span>
        </button>
        <button
          type="button"
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition whitespace-nowrap ${activeTab === 'interface' ? 'bg-primary/15 text-primary border border-primary/30 font-bold' : 'text-text-muted hover:text-white hover:bg-white/5'}`}
          onClick={() => setActiveTab('interface')}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Interface & Performance</span>
        </button>
        <button
          type="button"
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition whitespace-nowrap ${activeTab === 'league' ? 'bg-primary/15 text-primary border border-primary/30 font-bold' : 'text-text-muted hover:text-white hover:bg-white/5'}`}
          onClick={() => setActiveTab('league')}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span>League Installation</span>
        </button>
        <button
          type="button"
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition whitespace-nowrap ${activeTab === 'system' ? 'bg-primary/15 text-primary border border-primary/30 font-bold' : 'text-text-muted hover:text-white hover:bg-white/5'}`}
          onClick={() => setActiveTab('system')}
        >
          <HardDrive className="w-3.5 h-3.5" />
          <span>System & Storage</span>
        </button>
        <button
          type="button"
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition whitespace-nowrap ${activeTab === 'diagnostics' ? 'bg-primary/15 text-primary border border-primary/30 font-bold' : 'text-text-muted hover:text-white hover:bg-white/5'}`}
          onClick={() => setActiveTab('diagnostics')}
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>Developer Tools & Logs</span>
        </button>
      </nav>

      {/* Feedback Bar */}
      {settingsFeedback && (
        <ActionFeedback state={settingsFeedback} className="settings-feedback mb-4" />
      )}

      {/* Main Cockpit Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* LEFT COLUMN: Launch & Interface */}
        <div className="space-y-5">
          {/* Card 1: Launch & Presence */}
          {(activeTab === 'all' || activeTab === 'launch') && (
            <section className="glass-card p-5 rounded-2xl space-y-4" id="settings-launch">
              <div className="flex items-center gap-3 pb-3 border-b border-white/5">
                <span className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-400">
                  <Play className="w-4 h-4" />
                </span>
                <div>
                  <small>LAUNCH & STARTUP</small>
                  <h3>Startup Behavior</h3>
                  <p>Choose what RiftOps launches and how your presence starts.</p>
                </div>
              </div>

              <div className="space-y-4">
                {/* Default Game */}
                <div className="p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <label className="text-xs font-bold text-white">Default Launch Game</label>
                    <span className="text-[11px] text-text-dim">Select which title opens by default in Command Center.</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 p-1 rounded-xl bg-black/40 border border-white/10">
                    {GAMES.map((game) => (
                      <button
                        key={game.value}
                        type="button"
                        className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${prefGame === game.value ? 'bg-primary/20 text-primary border border-primary/40 font-bold' : 'text-text-muted hover:text-white hover:bg-white/5'}`}
                        onClick={() => {
                          setPrefGame(game.value);
                          void persistPreferences({ game: game.value }).catch((err: any) =>
                            showToast('Save failed', err.message, 'error')
                          );
                        }}
                      >
                        <span>{game.label}</span>
                        {prefGame === game.value && <Check className="w-3.5 h-3.5 text-primary" />}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Startup Presence */}
                <div className="p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <label className="text-xs font-bold text-white">Initial Chat Presence</label>
                    <span className="text-[11px] text-text-dim">The availability status applied immediately upon starting Riot Client.</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {PRESENCE_MODES.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        className={`flex items-center gap-2 p-2 rounded-xl bg-dark-bg/60 border text-xs transition ${prefStartup === mode.id ? 'border-primary/40 text-white bg-primary/10 font-bold' : 'border-white/5 text-text-muted hover:text-white hover:border-white/15'}`}
                        onClick={() => {
                          setPrefStartup(mode.id);
                          void persistPreferences({ startupStatus: mode.id }).catch((err: any) =>
                            showToast('Save failed', err.message, 'error')
                          );
                        }}
                      >
                        <span className={`w-2 h-2 rounded-full ${mode.color}`} />
                        <span>{mode.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Keep Lobby Chat Connected (MUC) */}
                <div className="flex items-center justify-between gap-4 p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 hover:border-white/10 transition">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold text-white">Keep Lobby Chat Connected (MUC)</span>
                    <span className="text-[11px] text-text-dim">
                      Maintains multi-user chat connection in game lobbies even while presence is masked.
                    </span>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      aria-label="Keep lobby chat connected"
                      checked={prefMUC}
                      onChange={(e) => {
                        setPrefMUC(e.target.checked);
                        void persistPreferences({ connectToMUC: e.target.checked }).catch((err: any) =>
                          showToast('Save failed', err.message, 'error')
                        );
                      }}
                    />
                    <span className="slider" />
                  </label>
                </div>
              </div>
            </section>
          )}

          {/* Card 2: Interface & Performance */}
          {(activeTab === 'all' || activeTab === 'interface') && (
            <section className="glass-card p-5 rounded-2xl space-y-4" id="settings-interface">
              <div className="flex items-center gap-3 pb-3 border-b border-white/5">
                <span className="w-9 h-9 rounded-xl bg-cyan-500/10 flex items-center justify-center text-cyan-400">
                  <Sparkles className="w-4 h-4" />
                </span>
                <div>
                  <small>INTERFACE & ACCESSIBILITY</small>
                  <h3>Workspace Preferences</h3>
                  <p>Display language, client performance mode, and visual comfort.</p>
                </div>
              </div>

              <div className="space-y-4">
                {/* Language */}
                <div className="p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <label className="text-xs font-bold text-white">{t('settings.language') || 'Interface Language'}</label>
                    <span className="text-[11px] text-text-dim">{t('settings.languageHelp') || 'Choose between English and Arabic.'}</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={`btn-secondary flex-1 py-1.5 text-xs ${locale === 'en' ? 'border-primary/60 text-primary bg-primary/10' : ''}`}
                      onClick={() => {
                        setLocale('en');
                        setSettingsFeedback({ tone: 'success', message: 'English interface enabled.' });
                      }}
                    >
                      English
                    </button>
                    <button
                      type="button"
                      className={`btn-secondary flex-1 py-1.5 text-xs ${locale === 'ar' ? 'border-primary/60 text-primary bg-primary/10' : ''}`}
                      onClick={() => {
                        setLocale('ar');
                        setSettingsFeedback({ tone: 'success', message: 'Arabic interface enabled.' });
                      }}
                    >
                      العربية
                    </button>
                  </div>
                </div>

                {/* Performance Mode */}
                <div className="p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <label className="text-xs font-bold text-white">Client Polling Profile</label>
                    <span className="text-[11px] text-text-dim">Adjust background LCU refresh intervals to save CPU/battery.</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {Object.entries(PERFORMANCE_MODES).map(([key, mode]) => (
                      <button
                        key={key}
                        type="button"
                        className={`flex flex-col items-center justify-center p-2.5 rounded-xl bg-dark-bg/60 border text-xs text-center transition ${performanceMode === key ? 'border-primary/40 text-white bg-primary/10 font-bold' : 'border-white/5 text-text-muted hover:text-white hover:border-white/15'}`}
                        onClick={() => {
                          setPerformanceMode(key as keyof typeof PERFORMANCE_MODES);
                          setSettingsFeedback({ tone: 'success', message: `${mode.label} profile activated.` });
                        }}
                      >
                        <strong>{mode.label}</strong>
                        <small>{key === 'fast' ? '15s poll' : key === 'quiet' ? '60s poll' : '30s poll'}</small>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Compact Mode */}
                <div className="flex items-center justify-between gap-4 p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 hover:border-white/10 transition">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold text-white">Compact Workspace Density</span>
                    <span className="text-[11px] text-text-dim">Reduces padding and card heights for smaller screens or windowed mode.</span>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      aria-label="Use compact workspace density"
                      checked={compactMode}
                      onChange={(e) => {
                        setCompactMode(e.target.checked);
                        setSettingsFeedback({ tone: 'success', message: e.target.checked ? 'Compact density enabled.' : 'Comfortable density enabled.' });
                      }}
                    />
                    <span className="slider" />
                  </label>
                </div>

                {/* Reduced Motion */}
                <div className="flex items-center justify-between gap-4 p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 hover:border-white/10 transition">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold text-white">Reduce Interface Motion</span>
                    <span className="text-[11px] text-text-dim">Disables intense glowing pulses, radar sweeps, and transition animations.</span>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      aria-label="Reduce interface motion"
                      checked={reducedMotion}
                      onChange={(e) => {
                        setReducedMotion(e.target.checked);
                        setSettingsFeedback({ tone: 'success', message: e.target.checked ? 'Interface motion reduced.' : 'Standard interface motion restored.' });
                      }}
                    />
                    <span className="slider" />
                  </label>
                </div>

                {/* Streamer & Privacy Mode */}
                <div className="flex items-center justify-between gap-4 p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 hover:border-white/10 transition">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold text-white">Streamer & Privacy Mode</span>
                    <span className="text-[11px] text-text-dim">Masks summoner names, Riot IDs, and friend identities across the entire interface for streaming and screenshots.</span>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      aria-label="Streamer and privacy mode"
                      checked={streamerMode}
                      onChange={(e) => {
                        setStreamerMode(e.target.checked);
                        setSettingsFeedback({ tone: 'success', message: e.target.checked ? 'Streamer & privacy mode enabled.' : 'Streamer & privacy mode disabled.' });
                      }}
                    />
                    <span className="slider" />
                  </label>
                </div>

                {/* Automatic Updates */}
                <div className="flex items-center justify-between gap-4 p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 hover:border-white/10 transition">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold text-white">Automatic Update Checks</span>
                    <span className="text-[11px] text-text-dim">Notifies you silently when a newer verified release of RiftOps is published.</span>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      aria-label="Automatically check for updates"
                      checked={prefUpdates}
                      onChange={(e) => {
                        setPrefUpdates(e.target.checked);
                        void persistPreferences({ checkUpdates: e.target.checked }).catch((err: any) =>
                          showToast('Save failed', err.message, 'error')
                        );
                      }}
                    />
                    <span className="slider" />
                  </label>
                </div>
              </div>
            </section>
          )}
        </div>

        {/* RIGHT COLUMN: League Installation, Specs & Maintenance */}
        <div className="space-y-5">
          {/* Card 3: League Installation */}
          {(activeTab === 'all' || activeTab === 'league') && (
            <section className="glass-card p-5 rounded-2xl space-y-4" id="settings-league">
              <div className="flex items-center gap-3 pb-3 border-b border-white/5">
                <span className="w-9 h-9 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                  <FolderOpen className="w-4 h-4" />
                </span>
                <div>
                  <small>LEAGUE INSTALLATION</small>
                  <h3>Client Location & Desktop</h3>
                  <p>Configure the Riot Client executable RiftOps binds to.</p>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-muted">Installation Engine Status</span>
                  <StatusBadge tone={pathStatus.tone}>{pathStatus.label}</StatusBadge>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-text">Riot Client Executable Path</label>
                  <input
                    aria-label="Riot Client location"
                    name="riot-client-location"
                    autoComplete="off"
                    spellCheck={false}
                    value={riotClientPath}
                    disabled={riotLocationBusy}
                    onChange={(event) => setRiotClientPath(event.target.value)}
                    placeholder={
                      snapshot.Platform === 'darwin'
                        ? '/Applications/League of Legends.app'
                        : 'Auto-detected path or path to RiotClientServices.exe'
                    }
                    className="w-full text-xs font-mono bg-bg-card border border-white/10 rounded-lg px-3 py-2 text-text focus:border-primary focus:outline-none"
                  />
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    disabled={riotLocationBusy}
                    onClick={() => void updateRiotLocation(apiActions.detectRiotClientLocation, 'Installation detected and saved.')}
                    className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs"
                  >
                    <Search className={`w-3.5 h-3.5 ${riotLocationBusy ? 'animate-spin' : ''}`} />
                    <span>Auto-detect</span>
                  </button>

                  <button
                    type="button"
                    disabled={riotLocationBusy || !riotClientPath.trim()}
                    onClick={() => void updateRiotLocation(() => apiActions.saveRiotClientLocation(riotClientPath), 'Saved and validated.')}
                    className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>Save Path</span>
                  </button>

                  {snapshot.Platform === 'darwin' && (
                    <button
                      type="button"
                      disabled={riotLocationBusy}
                      onClick={() => void updateRiotLocation(apiActions.browseRiotClientLocation, 'Application selected and saved.')}
                      className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      <span>Browse…</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={riotLocationBusy || !riotClientPath}
                    onClick={() => void updateRiotLocation(apiActions.clearRiotClientLocation, 'Saved override cleared; automatic discovery restored.')}
                    className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Clear</span>
                  </button>
                </div>

                {/* Windows Autostart */}
                {snapshot.Platform === 'windows' && (
                  <div className="flex items-center justify-between gap-4 p-3.5 rounded-xl bg-dark-bg/40 border border-white/5 hover:border-white/10 transition mt-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-bold text-white">Start RiftOps with Windows</span>
                      <span className="text-[11px] text-text-dim">Automatically launch RiftOps in the system tray when you sign in to this PC.</span>
                    </div>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        aria-label="Start RiftOps with Windows"
                        checked={autostartEnabled}
                        onChange={(e) => void handleAutostart(e.target.checked)}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                )}

                <div className="mt-4 pt-4 border-t border-white/5 space-y-3" aria-labelledby="chat-privacy-title">
                  <div className="flex items-center gap-3">
                    <span className="w-9 h-9 rounded-xl bg-cyan-500/10 flex items-center justify-center text-cyan-300"><MessageCircle className="w-4 h-4" /></span>
                    <div><small>CHAT PRIVACY</small><h3 id="chat-privacy-title">League chat settings</h3><p>Control client notifications and typing visibility. RiftOps changes only the supported League fields.</p></div>
                  </div>
                  {!lcuConnected && <p className="text-xs text-text-dim">Connect League to read your current chat privacy settings.</p>}
                  {lcuConnected && !chatPrivacy && <p className="text-xs text-text-dim">Chat privacy is unavailable for this League patch.</p>}
                  {chatPrivacy && <div className="space-y-2">
                    {[
                      ['friendRequestToastsDisabled', 'Friend request toasts', 'Hide League toast notifications for new friend requests.'],
                      ['linkClickWarningEnabled', 'Link click warning', 'Warn before opening links sent through League chat.'],
                      ['messageNotificationsEnabled', 'Message notifications', 'Show notifications for incoming chat messages.'],
                      ['showWhenTypingEnabled', 'Show when typing', 'Let friends see when you are typing.'],
                      ['chatFilterDisabled', 'Chat filter', 'Keep League’s chat filter enabled for incoming messages.'],
                    ].map(([key, label, description]) => {
                      const raw = chatPrivacy.settings[key];
                      const checked = key === 'chatFilterDisabled' ? !raw : raw;
                      return <div key={key} className="flex items-center justify-between gap-4 p-3 rounded-xl bg-dark-bg/40 border border-white/5">
                        <div className="flex flex-col gap-0.5"><span className="text-xs font-bold text-white">{label}</span><span className="text-[11px] text-text-dim">{description}</span></div>
                        <label className="toggle"><input type="checkbox" aria-label={label} checked={Boolean(checked)} disabled={chatPrivacyBusy === key} onChange={(event) => { const next = key === 'chatFilterDisabled' ? !event.target.checked : event.target.checked; void updateChatPrivacy(key, next); }} /><span className="slider" /></label>
                      </div>;
                    })}
                  </div>}
                </div>
              </div>
            </section>
          )}

          {/* Card 4: System & Storage Maintenance */}
          {(activeTab === 'all' || activeTab === 'system') && (
            <section className="glass-card p-5 rounded-2xl space-y-4" id="settings-system">
              <div className="flex items-center gap-3 pb-3 border-b border-white/5">
                <span className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-400">
                  <HardDrive className="w-4 h-4" />
                </span>
                <div>
                  <small>SYSTEM & MAINTENANCE</small>
                  <h3>App Storage & Runtime</h3>
                  <p>Inspect active runtime specs and perform local maintenance.</p>
                </div>
              </div>

              <div className="space-y-3">
                {/* Runtime Specs */}
                <div className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-dark-bg/50 border border-white/5">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-bold tracking-wider text-text-dim uppercase">VERSION</span>
                    <div className="flex items-center gap-2">
                      <strong className="text-xs font-mono font-medium text-white">{snapshot.Version ? `v${snapshot.Version}` : 'Development build'}</strong>
                      <button
                        type="button"
                        disabled={checkingUpdates}
                        onClick={handleManualUpdateCheck}
                        className="text-[10px] px-2 py-0.5 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-text-muted hover:text-white border border-white/[0.08] transition inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                        title="Check GitHub for new updates"
                      >
                        <RefreshCw className={`w-3 h-3 ${checkingUpdates ? 'animate-spin' : ''}`} />
                        <span>{checkingUpdates ? 'Checking…' : 'Check'}</span>
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-bold tracking-wider text-text-dim uppercase">ARCHITECTURE</span>
                    <strong className="text-xs font-mono font-medium text-white">{platformLabel}</strong>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-bold tracking-wider text-text-dim uppercase">CHAT PORT</span>
                    <strong className="text-xs font-mono font-medium text-white">{snapshot.ChatPort > 0 ? snapshot.ChatPort : 'Standby'}</strong>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-bold tracking-wider text-text-dim uppercase">LCU STATUS</span>
                    <strong className="text-xs font-mono font-medium text-white">{lcuConnected ? 'Connected' : 'Offline'}</strong>
                  </div>
                </div>

                {/* Trusted local chat proxy */}
                <div className="p-3.5 rounded-xl bg-dark-bg/40 border border-amber-400/20 space-y-3">
                  <div className="flex items-start gap-3">
                    <span className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-300">
                      <ShieldCheck className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-xs font-bold text-white">Trusted local chat proxy</strong>
                        <StatusBadge tone={proxySetup?.certificateReady && proxySetup.loopbackReady ? 'live' : 'neutral'}>
                          {proxySetup?.bundled
                            ? (proxySetup.certificateReady && proxySetup.loopbackReady ? 'Built in' : 'Needs loopback DNS')
                            : (proxySetup?.certificateReady && proxySetup.loopbackReady ? 'Ready' : 'Not configured')}
                        </StatusBadge>
                      </div>
                      <p className="text-[11px] text-text-dim mt-1">
                        {proxySetup?.bundled
                          ? `This release includes a trusted certificate for ${proxySetup.hostname || 'the RiftOps local hostname'}. End users do not need a DuckDNS token.`
                          : 'Optional personal-PC setup using your free DuckDNS hostname and a Let’s Encrypt certificate. The token is used once in memory and is never saved or logged.'}
                      </p>
                    </div>
                  </div>

                  {!proxySetup?.bundled && <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-text-dim">DuckDNS hostname</span>
                      <input
                        value={proxyHostname}
                        onChange={(event) => setProxyHostname(event.target.value)}
                        placeholder="riftops-hassan.duckdns.org"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={proxyBusy}
                        className="w-full text-xs font-mono bg-bg-card border border-white/10 rounded-lg px-3 py-2 text-text focus:border-primary focus:outline-none"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-text-dim">DuckDNS token</span>
                      <input
                        type="password"
                        value={proxyToken}
                        onChange={(event) => setProxyToken(event.target.value)}
                        placeholder="Paste locally; never send it in chat"
                        autoComplete="new-password"
                        disabled={proxyBusy}
                        className="w-full text-xs font-mono bg-bg-card border border-white/10 rounded-lg px-3 py-2 text-text focus:border-primary focus:outline-none"
                      />
                    </label>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-text-dim">Optional ACME email</span>
                    <input
                      type="email"
                      value={proxyEmail}
                      onChange={(event) => setProxyEmail(event.target.value)}
                      placeholder="Used only for certificate notices"
                      autoComplete="email"
                      disabled={proxyBusy}
                      className="w-full text-xs bg-bg-card border border-white/10 rounded-lg px-3 py-2 text-text focus:border-primary focus:outline-none"
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" disabled={proxyBusy} onClick={() => void handleProxySetup()} className="btn-primary inline-flex items-center gap-2 px-3 py-2 text-xs">
                      <ShieldCheck className={`w-3.5 h-3.5 ${proxyBusy ? 'animate-pulse' : ''}`} />
                      {proxyBusy ? 'Setting up…' : 'Set up trusted chat'}
                    </button>
                    {proxySetup?.configured && !proxySetup?.bundled && (
                      <button type="button" disabled={proxyBusy} onClick={() => void handleProxyClear()} className="btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs">
                        <Trash2 className="w-3.5 h-3.5" />
                        Remove setup
                      </button>
                    )}
                    {proxySetup?.expiresAt && <span className="text-[10px] text-text-dim">Certificate expires {new Date(proxySetup.expiresAt).toLocaleDateString()}</span>}
                  </div>
                  </>}
                  {proxySetup?.bundled && !proxySetup.loopbackReady && (
                    <p className="text-[10px] text-amber-200/80">
                      The bundled hostname must resolve to 127.0.0.1. The installer or your local DNS/hosts policy must provide that loopback mapping.
                    </p>
                  )}
                  <p className="text-[10px] text-text-dim">
                    Riot Client must be fully closed before launching through RiftOps. RiftOps will never restart your PC or silently kill Riot.
                  </p>
                </div>

                {/* Maintenance Actions */}
                <div className="space-y-2 pt-1">
                  <button
                    type="button"
                    onClick={handleClearCacheConfirm}
                    className="btn-secondary w-full justify-between py-2 text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <Trash2 className="w-3.5 h-3.5 text-amber-300" />
                      <span>Clear RiftOps Asset & Catalog Cache</span>
                    </span>
                    <span className="text-[10px] text-text-dim">Re-downloads fresh</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleResetConfirm}
                    className="btn-secondary w-full justify-between py-2 text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <RotateCcw className="w-3.5 h-3.5 text-cyan-300" />
                      <span>Reset Layout Density & Tab Filters</span>
                    </span>
                    <span className="text-[10px] text-text-dim">Defaults</span>
                  </button>
                </div>

                {/* Application Quit */}
                <div className="pt-3 border-t border-white/[0.06]">
                  <button
                    type="button"
                    onClick={handleQuit}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-danger/15 text-danger border border-danger/30 hover:bg-danger hover:text-white transition text-xs font-bold"
                  >
                    <Power className="w-3.5 h-3.5" />
                    <span>Quit RiftOps Application</span>
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>

        {/* FULL WIDTH SECTION: Developer Tools & Diagnostics */}
        {(activeTab === 'diagnostics' || activeTab === 'all') && (
          <div className="col-span-full space-y-4">
            <section className="glass-card p-5 rounded-2xl space-y-4" aria-labelledby="settings-diagnostics-title">
              <div className="flex items-center justify-between pb-3 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
                    <Terminal className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 id="settings-diagnostics-title" className="font-bold text-sm text-white">Developer Diagnostics & Logs</h3>
                    <p className="text-xs text-text-muted">Live console logs and internal client event stream for troubleshooting</p>
                  </div>
                </div>
              </div>
              <LogViewer logs={logs} onClear={onClearLogs || (() => {})} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
