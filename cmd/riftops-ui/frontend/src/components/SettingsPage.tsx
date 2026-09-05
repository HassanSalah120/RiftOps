import { useMemo, useState } from 'react';
import {
  Check,
  FolderOpen,
  HardDrive,
  Monitor,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type * as api from '../api';
import { GAMES, type Release } from '../types';
import PageHeader from './PageHeader';
import { StatusBadge, ActionFeedback, type FeedbackState } from './DesignPrimitives';
import ConfirmModal from './ConfirmModal';
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
};

type SettingsTab = 'all' | 'launch' | 'interface' | 'league' | 'system';

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
}: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('all');
  const [confirmModal, setConfirmModal] = useState<ConfirmAction | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const { streamerMode, setStreamerMode } = useLCUConnection();

  const handleManualUpdateCheck = async () => {
    setCheckingUpdates(true);
    try {
      const res = await apiActions.checkUpdate(true);
      if (res.available && res.release) {
        onUpdateDetected?.(res.release);
      } else if (res.error) {
        showToast('Update check failed', res.error, 'error');
      } else {
        const ver = res.currentVersion || snapshot.Version || '2.8.1';
        showToast('Up to date', `You are using the latest version of RiftOps (v${ver}).`, 'success');
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
            <span className="qol-rules-pill">
              <Monitor className="w-3.5 h-3.5 text-cyan-400" />
              <span>{lcuConnected ? 'LCU Connected' : 'LCU Idle'}</span>
            </span>
          </div>
        }
      />

      {/* Category Sub-Navigation Bar */}
      <nav className="settings-filter-tabs" aria-label="Settings categories">
        <button
          type="button"
          className={`settings-filter-btn ${activeTab === 'all' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span>All Settings</span>
        </button>
        <button
          type="button"
          className={`settings-filter-btn ${activeTab === 'launch' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('launch')}
        >
          <Play className="w-3.5 h-3.5" />
          <span>Launch & Startup</span>
        </button>
        <button
          type="button"
          className={`settings-filter-btn ${activeTab === 'interface' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('interface')}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Interface & Performance</span>
        </button>
        <button
          type="button"
          className={`settings-filter-btn ${activeTab === 'league' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('league')}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span>League Installation</span>
        </button>
        <button
          type="button"
          className={`settings-filter-btn ${activeTab === 'system' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('system')}
        >
          <HardDrive className="w-3.5 h-3.5" />
          <span>System & Storage</span>
        </button>
      </nav>

      {/* Feedback Bar */}
      {settingsFeedback && (
        <ActionFeedback state={settingsFeedback} className="settings-feedback mb-4" />
      )}

      {/* Main Cockpit Grid */}
      <div className="settings-cockpit-grid">
        {/* LEFT COLUMN: Launch & Interface */}
        <div className="settings-cockpit-grid__col space-y-4">
          {/* Card 1: Launch & Presence */}
          {(activeTab === 'all' || activeTab === 'launch') && (
            <section className="settings-card glass-card" id="settings-launch">
              <div className="settings-card__heading">
                <span className="settings-card__icon settings-card__icon--gold">
                  <Play className="w-4 h-4" />
                </span>
                <div className="settings-card__copy">
                  <small>LAUNCH & STARTUP</small>
                  <h3>Startup Behavior</h3>
                  <p>Choose what RiftOps launches and how your presence starts.</p>
                </div>
              </div>

              <div className="settings-card__body space-y-4">
                {/* Default Game */}
                <div className="settings-field">
                  <div className="settings-field__info">
                    <label className="settings-field__label">Default Launch Game</label>
                    <span className="settings-field__desc">Select which title opens by default in Command Center.</span>
                  </div>
                  <div className="settings-segmented-grid">
                    {GAMES.map((game) => (
                      <button
                        key={game.value}
                        type="button"
                        className={`settings-segmented-item ${prefGame === game.value ? 'is-selected' : ''}`}
                        onClick={() => {
                          setPrefGame(game.value);
                          void persistPreferences({ game: game.value }).catch((err: any) =>
                            showToast('Save failed', err.message, 'error')
                          );
                        }}
                      >
                        <span className="settings-segmented-item__name">{game.label}</span>
                        {prefGame === game.value && <Check className="w-3.5 h-3.5 text-primary" />}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Startup Presence */}
                <div className="settings-field">
                  <div className="settings-field__info">
                    <label className="settings-field__label">Initial Chat Presence</label>
                    <span className="settings-field__desc">The availability status applied immediately upon starting Riot Client.</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {PRESENCE_MODES.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        className={`settings-presence-opt ${prefStartup === mode.id ? 'is-selected' : ''}`}
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
                <div className="settings-toggle-row">
                  <div className="settings-toggle-row__copy">
                    <span className="settings-toggle-row__title">Keep Lobby Chat Connected (MUC)</span>
                    <span className="settings-toggle-row__desc">
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
            <section className="settings-card glass-card" id="settings-interface">
              <div className="settings-card__heading">
                <span className="settings-card__icon settings-card__icon--cyan">
                  <Sparkles className="w-4 h-4" />
                </span>
                <div className="settings-card__copy">
                  <small>INTERFACE & ACCESSIBILITY</small>
                  <h3>Workspace Preferences</h3>
                  <p>Display language, client performance mode, and visual comfort.</p>
                </div>
              </div>

              <div className="settings-card__body space-y-4">
                {/* Language */}
                <div className="settings-field">
                  <div className="settings-field__info">
                    <label className="settings-field__label">{t('settings.language') || 'Interface Language'}</label>
                    <span className="settings-field__desc">{t('settings.languageHelp') || 'Choose between English and Arabic.'}</span>
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
                <div className="settings-field">
                  <div className="settings-field__info">
                    <label className="settings-field__label">Client Polling Profile</label>
                    <span className="settings-field__desc">Adjust background LCU refresh intervals to save CPU/battery.</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {Object.entries(PERFORMANCE_MODES).map(([key, mode]) => (
                      <button
                        key={key}
                        type="button"
                        className={`settings-perf-btn ${performanceMode === key ? 'is-selected' : ''}`}
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
                <div className="settings-toggle-row">
                  <div className="settings-toggle-row__copy">
                    <span className="settings-toggle-row__title">Compact Workspace Density</span>
                    <span className="settings-toggle-row__desc">Reduces padding and card heights for smaller screens or windowed mode.</span>
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
                <div className="settings-toggle-row">
                  <div className="settings-toggle-row__copy">
                    <span className="settings-toggle-row__title">Reduce Interface Motion</span>
                    <span className="settings-toggle-row__desc">Disables intense glowing pulses, radar sweeps, and transition animations.</span>
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
                <div className="settings-toggle-row">
                  <div className="settings-toggle-row__copy">
                    <span className="settings-toggle-row__title">Streamer & Privacy Mode</span>
                    <span className="settings-toggle-row__desc">Masks summoner names, Riot IDs, and friend identities across the entire interface for streaming and screenshots.</span>
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
                <div className="settings-toggle-row">
                  <div className="settings-toggle-row__copy">
                    <span className="settings-toggle-row__title">Automatic Update Checks</span>
                    <span className="settings-toggle-row__desc">Notifies you silently when a newer verified release of RiftOps is published.</span>
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
        <div className="settings-cockpit-grid__col space-y-4">
          {/* Card 3: League Installation */}
          {(activeTab === 'all' || activeTab === 'league') && (
            <section className="settings-card glass-card" id="settings-league">
              <div className="settings-card__heading">
                <span className="settings-card__icon settings-card__icon--emerald">
                  <FolderOpen className="w-4 h-4" />
                </span>
                <div className="settings-card__copy">
                  <small>LEAGUE INSTALLATION</small>
                  <h3>Client Location & Desktop</h3>
                  <p>Configure the Riot Client executable RiftOps binds to.</p>
                </div>
              </div>

              <div className="settings-card__body space-y-3">
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
                  <div className="settings-toggle-row mt-3 pt-3 border-t border-white/[0.06]">
                    <div className="settings-toggle-row__copy">
                      <span className="settings-toggle-row__title">Start RiftOps with Windows</span>
                      <span className="settings-toggle-row__desc">Automatically launch RiftOps in the system tray when you sign in to this PC.</span>
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
              </div>
            </section>
          )}

          {/* Card 4: System & Storage Maintenance */}
          {(activeTab === 'all' || activeTab === 'system') && (
            <section className="settings-card glass-card" id="settings-system">
              <div className="settings-card__heading">
                <span className="settings-card__icon settings-card__icon--gold">
                  <HardDrive className="w-4 h-4" />
                </span>
                <div className="settings-card__copy">
                  <small>SYSTEM & MAINTENANCE</small>
                  <h3>App Storage & Runtime</h3>
                  <p>Inspect active runtime specs and perform local maintenance.</p>
                </div>
              </div>

              <div className="settings-card__body space-y-3">
                {/* Runtime Specs */}
                <div className="settings-specs-box">
                  <div className="settings-specs-item">
                    <span className="settings-specs-item__label">VERSION</span>
                    <div className="flex items-center gap-2">
                      <strong className="settings-specs-item__val">{snapshot.Version ? `v${snapshot.Version}` : '2.8.1'}</strong>
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
                  <div className="settings-specs-item">
                    <span className="settings-specs-item__label">ARCHITECTURE</span>
                    <strong className="settings-specs-item__val">{platformLabel}</strong>
                  </div>
                  <div className="settings-specs-item">
                    <span className="settings-specs-item__label">CHAT PORT</span>
                    <strong className="settings-specs-item__val">{snapshot.ChatPort > 0 ? snapshot.ChatPort : 'Standby'}</strong>
                  </div>
                  <div className="settings-specs-item">
                    <span className="settings-specs-item__label">LCU STATUS</span>
                    <strong className="settings-specs-item__val">{lcuConnected ? 'Connected' : 'Offline'}</strong>
                  </div>
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
      </div>
    </div>
  );
}
