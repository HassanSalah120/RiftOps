import { useState, useEffect, useCallback } from 'react';
import { Play, Square, Shield, Server, Sparkles, Settings, Power, FolderOpen, Search, RotateCcw } from 'lucide-react';
import type { Tab, Snapshot, LogLine } from './types';
import type { ConfirmAction, Notification, Release } from './types';
import GameSelector from './components/GameSelector';
import StatusSelector from './components/StatusSelector';
import LogViewer from './components/LogViewer';
import Toast from './components/Toast';
import Sidebar from './components/Sidebar';
import RiotPanel from './components/RiotPanel';
import MatchHistory from './components/MatchHistory';
import SkinShowcase from './components/SkinShowcase';
import QoLPanel from './components/QoLPanel';
import * as api from './api';
import ConfirmModal from './components/ConfirmModal';
import UpdateDialog from './components/UpdateDialog';
import { GAMES, gameLabel } from './types';

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'idle': return 'Idle';
    case 'running': return 'Running';
    case 'error': return 'Error';
    case 'connecting': return 'Connecting';
    default: return phase.charAt(0).toUpperCase() + phase.slice(1);
  }
}

function timeAgo(startedAt: string): string {
  if (!startedAt) return '';
  const then = new Date(startedAt).getTime();
  if (isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const GAME_IMGS: Record<string, string> = {
  'lol': '/games/lol.jpg',
  'valorant': '/games/valorant.jpg',
  'lor': '/games/lor.jpg',
  'lion': '/games/lion.jpg',
  'riot-client': '/games/riot-client.jpg',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [snapshot, setSnapshot] = useState<Snapshot>({
    Version: '', Platform: '', Phase: 'idle', Detail: 'Choose a game and launch with presence masking.',
    Game: '', Status: 'offline', Enabled: false, ChatPort: 0, StartedAt: '',
    ActiveProfileID: '',
  });

  const [updateAvailable, setUpdateAvailable] = useState<Release | null>(null);
  const [notification, setNotification] = useState<Notification | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmAction | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([
    { timestamp: new Date().toLocaleTimeString(), level: 'info', message: 'RiftOps initialized.' },
  ]);
  const [prefGame, setPrefGame] = useState('lol');
  const [selectedGame, setSelectedGame] = useState('lol');
  const [prefStartup, setPrefStartup] = useState('last');
  const [prefMUC, setPrefMUC] = useState(true);
  const [prefUpdates, setPrefUpdates] = useState(true);
  const [riotClientPath, setRiotClientPath] = useState('');
  const [riotLocationBusy, setRiotLocationBusy] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [gameImgError, setGameImgError] = useState(false);

  const showToast = useCallback((title: string, message: string, type: 'info' | 'success' | 'error' = 'info') => {
    setNotification({ title, message, type });
    setTimeout(() => setNotification(null), 4000);
  }, []);

  // Poll snapshot
  useEffect(() => {
    const poll = async () => {
      try {
        const snap = await api.fetchSnapshot();
        setSnapshot(snap);
      } catch (err: any) {
        setLogs((prev) => [
          ...prev.slice(-100),
          { timestamp: new Date().toLocaleTimeString(), level: 'error', message: `Poll error: ${err.message}` },
        ]);
      }
    };
    void poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, []);

  // Load preferences & update check
  useEffect(() => {
    api.checkUpdate().then((res) => {
      if (res.available && res.release) setUpdateAvailable(res.release);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const [preferences, autostart, location] = await Promise.all([
          api.fetchPreferences(),
          api.getAutostart(),
          api.fetchRiotClientLocation(),
        ]);
        const game = GAMES.some((candidate) => candidate.value === preferences.game)
          ? preferences.game
          : 'lol';
        setPrefGame(game);
        setSelectedGame(game);
        setPrefStartup(preferences.startupStatus || 'last');
        setPrefMUC(preferences.connectToMUC);
        setPrefUpdates(preferences.checkUpdates);
        setRiotClientPath(preferences.riotClientPath || location.path || '');
        setAutostartEnabled(autostart.enabled);
      } catch (err: any) {
        showToast('Preferences unavailable', err.message || 'Using safe defaults until settings can be loaded.', 'error');
      }
    };
    void loadPreferences();
  }, [showToast]);

  const persistPreferences = async (next: Partial<api.Preferences>) => {
    const preferences: api.Preferences = {
      game: next.game ?? prefGame,
      startupStatus: next.startupStatus ?? prefStartup,
      connectToMUC: next.connectToMUC ?? prefMUC,
      checkUpdates: next.checkUpdates ?? prefUpdates,
      riotClientPath: next.riotClientPath ?? riotClientPath,
    };
    await api.savePreferences(preferences);
    setPrefGame(preferences.game);
    setPrefStartup(preferences.startupStatus);
    setPrefMUC(preferences.connectToMUC);
    setPrefUpdates(preferences.checkUpdates);
    setRiotClientPath(preferences.riotClientPath);
  };

  const updateRiotLocation = async (
    action: () => Promise<api.RiotClientLocation>,
    successMessage: string,
  ) => {
    setRiotLocationBusy(true);
    try {
      const location = await action();
      setRiotClientPath(location.path);
      showToast('Riot Client location', successMessage, 'success');
    } catch (err: any) {
      showToast('Location failed', err.message, 'error');
    } finally {
      setRiotLocationBusy(false);
    }
  };

  const handleLaunch = async () => {
    setLogs((prev) => [
      ...prev.slice(-100),
      { timestamp: new Date().toLocaleTimeString(), level: 'info', message: `Launching ${selectedGame}...` },
    ]);
    try {
      await api.launchGame(selectedGame);
      const res = await api.fetchSnapshot();
      setSnapshot(res);
      showToast('Engine Launched', `Presence set to ${res.Status}`, 'success');
    } catch (err: any) {
      showToast('Launch Error', err.message, 'error');
      setLogs((prev) => [
        ...prev.slice(-100),
        { timestamp: new Date().toLocaleTimeString(), level: 'error', message: `Launch failed: ${err.message}` },
      ]);
    }
  };

  const handleStop = async () => {
    try {
      await api.stopEngine();
      const res = await api.fetchSnapshot();
      setSnapshot(res);
      showToast('Engine Stopped', 'RiftOps is idle.', 'info');
    } catch (err: any) {
      showToast('Stop Error', err.message, 'error');
    }
  };

  const handleSetGame = async (game: string) => {
    setSelectedGame(game);
    setGameImgError(false);
    try {
      await persistPreferences({ game });
    } catch (err: any) {
      showToast('Game preference not saved', err.message, 'error');
    }
  };

  const handleAutostart = async (enabled: boolean) => {
    try {
      await api.setAutostart(enabled);
      setAutostartEnabled(enabled);
      showToast('Windows startup updated', enabled ? 'RiftOps will start with Windows.' : 'RiftOps will not start with Windows.', 'success');
    } catch (err: any) {
      showToast('Autostart failed', err.message, 'error');
    }
  };

  const handleQuit = () => {
    setConfirmModal({
      open: true,
      title: 'Quit RiftOps?',
      message: 'This stops RiftOps and closes the desktop app.',
      actionLabel: 'Quit',
      danger: true,
      onConfirm: () => { void api.quitApp(); },
    });
  };

  const handleSetStatus = async (status: string) => {
    try {
      await api.setStatus(status);
      const snap = await api.fetchSnapshot();
      setSnapshot(snap);
      showToast('Presence Updated', `Status set to ${status}`, 'success');
    } catch (err: any) {
      showToast('Set Status Error', err.message, 'error');
    }
  };

  const handleToggleMasking = async (enabled: boolean) => {
    try {
      await api.toggleMasking(enabled);
      const snap = await api.fetchSnapshot();
      setSnapshot(snap);
      showToast('Masking Toggled', enabled ? 'Presence shield enabled' : 'Presence shield disabled', 'info');
    } catch (err: any) {
      showToast('Toggle Masking Error', err.message, 'error');
    }
  };

  const isIdle = snapshot.Phase === 'idle' || snapshot.Phase === 'error';
  const isLive = snapshot.Phase !== 'idle' && snapshot.Phase !== 'error';
  const gameInfo = GAMES.find((g) => g.value === selectedGame);
  const gameImg = GAME_IMGS[selectedGame];

  return (
    <div className="flex h-screen bg-base text-text overflow-hidden">
      {/* Toast Notification */}
      <Toast notification={notification} onClose={() => setNotification(null)} />

      {/* Confirmation Modal */}
      {confirmModal && <ConfirmModal action={confirmModal} onClose={() => setConfirmModal(null)} />}

      {/* Update Dialog */}
      <UpdateDialog release={updateAvailable} onDismiss={() => setUpdateAvailable(null)} />

      {/* Left Sidebar */}
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} phase={snapshot.Phase} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-base/50 relative">
        <main className="flex-1 overflow-hidden flex flex-col relative z-10">
          {/* QoL Panel */}
          {activeTab === 'qol' && (
            <div className="flex-1 min-h-0 overflow-hidden animate-fadeIn">
              <QoLPanel />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             COMMAND CENTER (DASHBOARD)
             ═══════════════════════════════════════════════ */}
          {activeTab === 'dashboard' && (
            <div className="flex-1 flex flex-col min-h-0 animate-fadeIn">
              {/* Hero Banner */}
              <div className="relative h-44 shrink-0 overflow-hidden border-b border-[#c8aa6e]/15">
                {gameImgError ? (
                  <div className="absolute inset-0 bg-gradient-to-br from-base via-[#091428] to-base" />
                ) : (
                  <img src={gameImg} alt="" className="absolute inset-0 w-full h-full object-cover" onError={() => setGameImgError(true)} />
                )}
                {/* Gradient overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-base via-base/60 to-black/40" />
                <div className="absolute inset-0 bg-gradient-to-r from-base/60 to-transparent" />

                <div className="relative h-full flex flex-col justify-end p-5 pb-4">
                  {/* Phase badge */}
                  <div className="flex items-center justify-between mb-auto">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-base/80 backdrop-blur-md border border-white/[0.08]">
                        <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-primary animate-pulse shadow-sm shadow-primary' : 'bg-text-dim'}`} />
                        <span className="text-xs font-bold text-text-muted">{phaseLabel(snapshot.Phase)}</span>
                      </div>
                      {snapshot.Detail && snapshot.Detail !== 'Choose a game and launch with presence masking.' && (
                        <div className="px-2.5 py-1 rounded-lg bg-base/80 backdrop-blur-md border border-white/[0.08]">
                          <span className="text-xs text-text-muted">{snapshot.Detail}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Game name + launch */}
                  <div className="flex items-end justify-between mt-1">
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: gameInfo?.color || '#c8aa6e' }} />
                        <h1 className="text-2xl font-black text-white tracking-tight drop-shadow-lg">
                          {gameInfo?.label || 'Not selected'}
                        </h1>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-text-muted">
                          Status: <span className="font-bold" style={{ color: snapshot.Status === 'online' ? '#0ac8b9' : snapshot.Status === 'mobile' ? '#03b6c1' : '#a09b8c' }}>{snapshot.Status || 'Offline'}</span>
                        </span>
                        {snapshot.Enabled ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/20 text-primary font-bold border border-primary/30">Shield On</span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.04] text-text-dim font-bold">Shield Off</span>
                        )}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleLaunch()}
                        disabled={!isIdle}
                        className="btn-primary flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm"
                      >
                        <Play className="w-4 h-4 fill-current" />
                        <span>Launch</span>
                      </button>
                      <button
                        onClick={handleStop}
                        disabled={isIdle}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-danger/20 text-danger font-bold text-xs border border-danger/30 hover:bg-danger hover:text-white transition-all duration-200 disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <Square className="w-3.5 h-3.5 fill-current" />
                        <span>Stop</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Dashboard body */}
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
                {/* Game Selector */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Server className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs text-text-muted font-bold">TARGET GAME</span>
                  </div>
                  <GameSelector value={selectedGame} onChange={handleSetGame} disabled={!isIdle} />
                </div>

                {/* Launch history */}
                {snapshot.StartedAt && (
                  <div className="flex items-center gap-2 text-[11px] text-text-dim/70">
                    <Play className="w-3 h-3 text-primary" />
                    <span>Launched {timeAgo(snapshot.StartedAt)}</span>
                    {snapshot.Game && <span className="text-text-dim/40">· {gameLabel(snapshot.Game)}</span>}
                  </div>
                )}

                {/* Presence Shield */}
                <div className="glass-card p-3.5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Shield className="w-4 h-4 text-primary" />
                      <span className="text-xs text-text-muted font-bold">Presence Shield</span>
                    </div>
                    <label className="toggle">
                      <input type="checkbox" checked={snapshot.Enabled} onChange={(e) => handleToggleMasking(e.target.checked)} />
                      <span className="slider" />
                    </label>
                  </div>
                  <StatusSelector current={snapshot.Status} onChange={handleSetStatus} />
                </div>

                {/* Engine Logs */}
                <LogViewer logs={logs} onClear={() => setLogs([])} />
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             MATCH HISTORY TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'history' && (
            <div className="flex-1 overflow-y-auto p-4 animate-fadeIn">
              <MatchHistory />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             SKIN SHOWCASE TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'skins' && (
            <div className="flex-1 overflow-y-auto p-4 animate-fadeIn">
              <SkinShowcase />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             NAVIGATION
             ═══════════════════════════════════════════════ */}
          {/* ═══════════════════════════════════════════════
             RIOT ACCOUNT TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'riot' && (
            <div className="flex-1 overflow-y-auto p-4 animate-fadeIn">
              <RiotPanel />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             SETTINGS TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'settings' && (
            <div className="flex-1 overflow-y-auto p-4 space-y-4 animate-fadeIn">
              <div className="flex items-center gap-2 mb-1">
                <Settings className="w-4 h-4 text-primary" />
                <span className="text-sm text-text-muted font-bold">App Settings</span>
              </div>

              {/* Preferences */}
              <div className="glass-card p-4 space-y-3">
                <h4 className="text-xs font-bold text-white">Default Launch Preferences</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-text-muted">Default Game</label>
                    <select
                      value={prefGame}
                      onChange={(e) => {
                        setPrefGame(e.target.value);
                        void persistPreferences({ game: e.target.value }).catch((err: any) => showToast('Save failed', err.message, 'error'));
                      }}
                      className="w-full text-xs"
                    >
                      {GAMES.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-text-muted">Startup Status</label>
                    <select
                      value={prefStartup}
                      onChange={(e) => {
                        setPrefStartup(e.target.value);
                        void persistPreferences({ startupStatus: e.target.value }).catch((err: any) => showToast('Save failed', err.message, 'error'));
                      }}
                      className="w-full text-xs"
                    >
                      <option value="last">Remember last</option>
                      <option value="chat">Online</option>
                      <option value="offline">Offline</option>
                      <option value="mobile">Mobile</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-2 pt-2 border-t border-white/[0.06]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text">Keep lobby chat connected (MUC)</span>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={prefMUC}
                        onChange={(e) => {
                          setPrefMUC(e.target.checked);
                          void persistPreferences({ connectToMUC: e.target.checked }).catch((err: any) => showToast('Save failed', err.message, 'error'));
                        }}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text">Auto check for updates</span>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={prefUpdates}
                        onChange={(e) => {
                          setPrefUpdates(e.target.checked);
                          void persistPreferences({ checkUpdates: e.target.checked }).catch((err: any) => showToast('Save failed', err.message, 'error'));
                        }}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                </div>
              </div>

              <div className="glass-card p-4 space-y-3">
                <h4 className="text-xs font-bold text-white">Desktop App</h4>
                <div className="space-y-2 pb-3 border-b border-white/[0.06]">
                  <div>
                    <p className="text-xs text-text">Riot Client location</p>
                    <p className="text-[11px] text-text-muted mt-0.5">
                      Select League of Legends.app, Riot Client.app, or the client executable.
                    </p>
                  </div>
                  <input
                    value={riotClientPath}
                    disabled={riotLocationBusy}
                    onChange={(event) => setRiotClientPath(event.target.value)}
                    placeholder={snapshot.Platform === 'darwin'
                      ? '/Applications/League of Legends.app'
                      : 'RiotClientServices executable or application folder'}
                    className="w-full text-xs"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={riotLocationBusy || !riotClientPath.trim()}
                      onClick={() => void updateRiotLocation(
                        () => api.saveRiotClientLocation(riotClientPath),
                        'Saved and validated.',
                      )}
                      className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-[11px]"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      Save Path
                    </button>
                    <button
                      type="button"
                      disabled={riotLocationBusy}
                      onClick={() => void updateRiotLocation(
                        api.detectRiotClientLocation,
                        'Installation detected and saved.',
                      )}
                      className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-[11px]"
                    >
                      <Search className="w-3.5 h-3.5" />
                      Auto-detect
                    </button>
                    {snapshot.Platform === 'darwin' && (
                      <button
                        type="button"
                        disabled={riotLocationBusy}
                        onClick={() => void updateRiotLocation(
                          api.browseRiotClientLocation,
                          'Application selected and saved.',
                        )}
                        className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-[11px]"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        Browse…
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={riotLocationBusy || !riotClientPath}
                      onClick={() => void updateRiotLocation(
                        api.clearRiotClientLocation,
                        'Saved override cleared; automatic discovery restored.',
                      )}
                      className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-[11px]"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Clear
                    </button>
                  </div>
                </div>
                {snapshot.Platform === 'windows' && (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-text">Start RiftOps with Windows</p>
                      <p className="text-[11px] text-text-muted mt-0.5">Run RiftOps after you sign in to this PC.</p>
                    </div>
                    <label className="toggle">
                      <input type="checkbox" checked={autostartEnabled} onChange={(e) => void handleAutostart(e.target.checked)} />
                      <span className="slider" />
                    </label>
                  </div>
                )}
                <div className="pt-2 border-t border-white/[0.06]">
                  <button onClick={handleQuit} className="flex items-center gap-2 px-3 py-2 rounded-xl bg-danger/15 text-danger border border-danger/30 hover:bg-danger hover:text-white transition text-xs font-bold">
                    <Power className="w-3.5 h-3.5" />
                    Quit RiftOps
                  </button>
                </div>
              </div>

              {/* About RiftOps */}
              <div className="glass-card p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <span className="text-xs font-bold text-white">About RiftOps</span>
                </div>
                <p className="text-xs text-text-muted leading-relaxed">
                  Private Riot Client launcher with real-time presence masking, automation, and LCU integration.
                </p>
                <div className="flex items-center justify-between text-[11px] text-text-dim pt-2 border-t border-white/[0.04]">
                  <span>Version: {snapshot.Version ? `v${snapshot.Version}` : 'loading...'}</span>
                  <span>Build: {snapshot.Platform === 'darwin' ? 'macOS' : snapshot.Platform === 'windows' ? 'Windows x64' : snapshot.Platform || 'detecting...'}</span>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
