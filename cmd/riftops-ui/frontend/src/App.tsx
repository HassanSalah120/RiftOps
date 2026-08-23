import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, Play, Square, Shield, Server, Sparkles, Settings, Power, FolderOpen, Search, RotateCcw, Wrench } from 'lucide-react';
import type { Tab, Snapshot, LogLine } from './types';
import type { ConfirmAction, Notification, Release } from './types';
import GameSelector from './components/GameSelector';
import StatusSelector from './components/StatusSelector';
import LogViewer from './components/LogViewer';
import Toast from './components/Toast';
import Sidebar from './components/Sidebar';
import MatchHistory from './components/MatchHistory';
import PlayFlowPage from './components/PlayFlowPage';
import LiveSessionPage from './components/LiveSessionPage';
import CollectionWorkspace from './components/CollectionWorkspace';
import QoLPanel from './components/QoLPanel';
import LootDashboard from './components/LootDashboard';
import QuickActions from './components/QuickActions';
import CommandPalette from './components/CommandPalette';
import WorkspaceHeader from './components/WorkspaceHeader';
import * as api from './api';
import ConfirmModal from './components/ConfirmModal';
import UpdateDialog from './components/UpdateDialog';
import NotificationCenter from './components/NotificationCenter';
import type { NotificationEntry } from './components/NotificationCenter';
import { useLCUConnection } from './components/lcuConnectionContext';
import { PERFORMANCE_MODES } from './components/lcuConnectionContext';
import ClientControlRoom from './components/ClientControlRoom';
import RemoteAccessPage from './components/RemoteAccessPage';
import AccountSummary from './components/AccountSummary';
import { GAMES, gameLabel } from './types';
import { ActionFeedback, type FeedbackState } from './components/DesignPrimitives';
import { ALL_TABS, availableTabs, tabAvailable } from './clientCapabilities';
import PhoneCompanionPanel from './components/PhoneCompanionPanel';

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
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem('riftops.activeTab');
      return ALL_TABS.includes(saved as Tab) ? saved as Tab : 'dashboard';
    } catch {
      return 'dashboard';
    }
  });
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
  const [settingsFeedback, setSettingsFeedback] = useState<FeedbackState>(null);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [gameImgError, setGameImgError] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [clientMode, setClientMode] = useState<'loading' | 'desktop' | 'phone'>('loading');
  const remoteClient = clientMode === 'phone';
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [notificationHistory, setNotificationHistory] = useState<NotificationEntry[]>([]);
  const [launchStage, setLaunchStage] = useState<'idle' | 'checking' | 'starting' | 'waiting' | 'ready'>('idle');
  const [compactMode, setCompactMode] = useState(() => {
    try { return localStorage.getItem('riftops.compactMode') === 'true'; } catch { return false; }
  });
  const [reducedMotion, setReducedMotion] = useState(() => {
    try { return localStorage.getItem('riftops.reducedMotion') === 'true'; } catch { return false; }
  });
  const { connected: lcuConnected, performanceMode, setPerformanceMode, pageVisible } = useLCUConnection();
  const previousLcuConnection = useRef<boolean | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => {
    try { localStorage.setItem('riftops.activeTab', activeTab); } catch { /* Preferences are optional. */ }
  }, [activeTab]);

  useEffect(() => {
    try {
      localStorage.setItem('riftops.compactMode', String(compactMode));
      localStorage.setItem('riftops.reducedMotion', String(reducedMotion));
    } catch { /* Preferences are optional. */ }
    document.documentElement.classList.toggle('riftops-compact', compactMode);
    document.documentElement.classList.toggle('riftops-reduced-motion', reducedMotion);
  }, [compactMode, reducedMotion]);

  useEffect(() => {
    document.documentElement.dataset.performance = performanceMode;
    return () => { delete document.documentElement.dataset.performance; };
  }, [performanceMode]);

  const showToast = useCallback((title: string, message: string, type: 'info' | 'success' | 'error' = 'info') => {
    const next = { title, message, type };
    setNotification(next);
    setNotificationHistory((current) => [{ ...next, id: Date.now(), createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), read: false }, ...current].slice(0, 80));
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setNotification(null);
      toastTimer.current = null;
    }, 4000);
  }, []);

  const showPhoneToast = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
    showToast('Phone control', message, type);
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;
    void api.fetchRemoteAccessStatus().then((status) => {
      if (!cancelled) setClientMode(status.remote || status.client === 'phone' ? 'phone' : 'desktop');
    }).catch(() => {
      // The loopback desktop remains usable if phone access is disabled or
      // unavailable; an authenticated phone will always receive this status.
      if (!cancelled) setClientMode('desktop');
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!tabAvailable(activeTab, remoteClient)) setActiveTab('dashboard');
  }, [activeTab, remoteClient]);

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    if (previousLcuConnection.current === null) {
      previousLcuConnection.current = lcuConnected;
      return;
    }
    if (previousLcuConnection.current !== lcuConnected) {
      showToast(
        lcuConnected ? 'League Client connected' : 'League Client disconnected',
        lcuConnected ? 'Live LCU controls are available again.' : 'RiftOps will keep retrying in the background.',
        lcuConnected ? 'success' : 'error',
      );
      previousLcuConnection.current = lcuConnected;
    }
  }, [lcuConnected, showToast]);

  // Prefer the backend event stream and keep a slow polling fallback for
  // clients that temporarily lose the stream during a restart.
  useEffect(() => {
    let polling = false;
    let lastErrorLog = 0;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const snap = await api.fetchSnapshot();
        setSnapshot(snap);
      } catch (err: any) {
        if (Date.now() - lastErrorLog > 30000) {
          lastErrorLog = Date.now();
          setLogs((prev) => [
            ...prev.slice(-100),
            { timestamp: new Date().toLocaleTimeString(), level: 'error', message: `State refresh paused: ${err.message}` },
          ]);
        }
      } finally {
        polling = false;
      }
    };
    if (!pageVisible) return undefined;
    let timer: number | undefined;
    let cancelled = false;
    const interval = performanceMode === 'fast' ? 15000 : performanceMode === 'quiet' ? 60000 : 30000;
    const schedule = async () => {
      await poll();
      if (!cancelled) timer = window.setTimeout(() => void schedule(), interval);
    };
    void schedule();
    const source = new EventSource('/api/events');
    source.onmessage = (event) => {
      try {
        setSnapshot(JSON.parse(event.data) as Snapshot);
      } catch {
        // Ignore malformed event frames; the fallback poll will recover state.
      }
    };
    source.onerror = () => { void poll(); };
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      source.close();
    };
  }, [pageVisible, performanceMode]);

  // Load preferences & update check
  useEffect(() => {
    if (clientMode !== 'desktop') return;
    api.checkUpdate().then((res) => {
      if (res.available && res.release) setUpdateAvailable(res.release);
    }).catch(() => {});
  }, [clientMode]);

  // Keep navigation discoverable for keyboard users without hijacking text inputs.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT' || target?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
        return;
      }
      if (event.key === 'Escape') {
        setCommandPaletteOpen(false);
        return;
      }
      if (typing || !event.altKey) return;
      const tabs = availableTabs(remoteClient);
      const index = Number(event.key) - 1;
      if (index >= 0 && index < tabs.length) {
        event.preventDefault();
        setActiveTab(tabs[index]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [remoteClient]);

  useEffect(() => {
    if (clientMode !== 'desktop') return;
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
  }, [clientMode, showToast]);

  const persistPreferences = async (next: Partial<api.Preferences>) => {
    const preferences: api.Preferences = {
      game: next.game ?? prefGame,
      startupStatus: next.startupStatus ?? prefStartup,
      connectToMUC: next.connectToMUC ?? prefMUC,
      checkUpdates: next.checkUpdates ?? prefUpdates,
      riotClientPath: next.riotClientPath ?? riotClientPath,
    };
    setSettingsFeedback({ tone: 'working', message: 'Saving this preference…' });
    try {
      await api.savePreferences(preferences);
      setPrefGame(preferences.game);
      setPrefStartup(preferences.startupStatus);
      setPrefMUC(preferences.connectToMUC);
      setPrefUpdates(preferences.checkUpdates);
      setRiotClientPath(preferences.riotClientPath);
      setSettingsFeedback({ tone: 'success', message: 'Preference saved.' });
    } catch (error: any) {
      setSettingsFeedback({ tone: 'error', message: error?.message || 'The preference could not be saved.' });
      throw error;
    }
  };

  const updateRiotLocation = async (
    action: () => Promise<api.RiotClientLocation>,
    successMessage: string,
  ) => {
    setRiotLocationBusy(true);
    setSettingsFeedback({ tone: 'working', message: 'Validating the Riot Client location…' });
    try {
      const location = await action();
      setRiotClientPath(location.path);
      showToast('Riot Client location', successMessage, 'success');
      setSettingsFeedback({ tone: 'success', message: successMessage });
    } catch (err: any) {
      showToast('Location failed', err.message, 'error');
      setSettingsFeedback({ tone: 'error', message: err?.message || 'The Riot Client location could not be saved.' });
    } finally {
      setRiotLocationBusy(false);
    }
  };

  const handleLaunch = async (stopExisting = false) => {
    setLaunchStage('checking');
    setLogs((prev) => [
      ...prev.slice(-100),
      { timestamp: new Date().toLocaleTimeString(), level: 'info', message: `${stopExisting ? 'Restarting' : 'Launching'} ${selectedGame}...` },
    ]);
    try {
      showToast('Launch preflight', 'Checking the Riot Client and RiftOps engine.', 'info');
      await api.fetchSnapshot();
      setLaunchStage('starting');
      await api.launchGame(selectedGame, stopExisting);
      setLaunchStage('waiting');
      let res = await api.fetchSnapshot();
      for (let attempt = 0; attempt < 15 && (res.Phase === 'idle' || res.Phase === 'error'); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        res = await api.fetchSnapshot();
      }
      setSnapshot(res);
      setLaunchStage('ready');
      showToast('Engine Launched', `Presence set to ${res.Status}`, 'success');
    } catch (err: any) {
      const message = (err?.message || '').trim() || 'RiftOps could not start the selected game.';
      setLaunchStage('idle');
      if (/Riot Client is already running/i.test(message)) {
        showToast('Launch paused', 'Riot Client is already running. Choose Restart & launch to continue.', 'info');
        setConfirmModal({
          open: true,
          title: 'Restart Riot Client?',
          message: 'RiftOps must close the running Riot Client before it can apply the selected launch profile. Unsaved client screens will be closed.',
          actionLabel: 'Restart & launch',
          danger: false,
          onConfirm: () => {
            setConfirmModal(null);
            void handleLaunch(true);
          },
        });
      } else {
        showToast('Launch Error', message, 'error');
      }
      setLogs((prev) => [
        ...prev.slice(-100),
        { timestamp: new Date().toLocaleTimeString(), level: 'error', message: `Launch failed: ${message}` },
      ]);
    } finally {
      window.setTimeout(() => setLaunchStage('idle'), 1800);
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
    setSettingsFeedback({ tone: 'working', message: 'Updating Windows startup…' });
    try {
      await api.setAutostart(enabled);
      setAutostartEnabled(enabled);
      showToast('Windows startup updated', enabled ? 'RiftOps will start with Windows.' : 'RiftOps will not start with Windows.', 'success');
      setSettingsFeedback({ tone: 'success', message: enabled ? 'RiftOps will start with Windows.' : 'Windows startup is disabled.' });
    } catch (err: any) {
      showToast('Autostart failed', err.message, 'error');
      setSettingsFeedback({ tone: 'error', message: err?.message || 'Windows startup could not be changed.' });
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

  const handleCommand = (command: string) => {
    if (command === 'launch') void handleLaunch();
    if (command === 'stop') void handleStop();
    if (command === 'accept') void runClientCommand('Ready check accepted.', api.lcuAutoAccept);
    if (command === 'start-queue') void runClientCommand('Matchmaking started.', api.lcuAutoRequeue);
    if (command === 'stop-queue') void runClientCommand('Matchmaking stopped.', api.lcuStopQueue);
    if (command === 'play-again') void runClientCommand('Returning to the lobby.', api.lcuPlayAgain);
    if (command === 'refresh') {
      void api.fetchSnapshot().then(setSnapshot).catch((err: any) => showToast('Refresh failed', err.message, 'error'));
    }
    if (command === 'toggle-mask') void handleToggleMasking(!snapshot.Enabled);
    if (command === 'notifications') setNotificationCenterOpen(true);
  };

  const runClientCommand = async (successMessage: string, action: () => Promise<unknown>) => {
    try {
      await action();
      setSnapshot(await api.fetchSnapshot());
      showToast('League Client', successMessage, 'success');
    } catch (err: any) {
      showToast('League Client', err?.message || 'League rejected the action.', 'error');
    }
  };

  const resetWorkspacePreferences = () => {
    ['riftops.activeTab', 'riftops.compactMode', 'riftops.reducedMotion', 'riftops.performanceMode', 'riftops.friends.collapsed', 'riftops.friends.favorites', 'riftops.history.queue', 'riftops.history.period', 'riftops.history.count'].forEach((key) => {
      try { localStorage.removeItem(key); } catch { /* Optional preference. */ }
    });
    try {
      Object.keys(localStorage).filter((key) => key.startsWith('riftops-skin-')).forEach((key) => localStorage.removeItem(key));
    } catch { /* Optional preference. */ }
    setActiveTab('dashboard');
    setCompactMode(false);
    setReducedMotion(false);
    setPerformanceMode('balanced');
    showToast('Workspace reset', 'Layout and local view preferences were restored to defaults.', 'success');
  };

  const clearAssetCache = () => {
    api.clearCachedJSON();
    try {
      ['riftops-skin-cache', 'riftops-skin-cache-updated', 'riftops-skin-cache-v2', 'riftops-skin-cache-v2-updated'].forEach((key) => localStorage.removeItem(key));
    } catch { /* Optional local cache. */ }
    showToast('Asset cache cleared', 'RiftOps will reload catalogues only when you open them.', 'success');
  };

  const isIdle = snapshot.Phase === 'idle' || snapshot.Phase === 'error';
  const isLive = snapshot.Phase !== 'idle' && snapshot.Phase !== 'error';
  const gameInfo = GAMES.find((g) => g.value === selectedGame);
  const gameImg = GAME_IMGS[selectedGame];

  if (clientMode === 'loading') {
    return (
      <main className="riftops-bootstrap" aria-busy="true" aria-live="polite">
        <Shield />
        <strong>Securing RiftOps…</strong>
        <span>Loading the permissions for this device.</span>
      </main>
    );
  }

  return (
    <div className={`riftops-shell flex h-screen bg-base text-text overflow-hidden ${compactMode ? 'is-compact' : ''}`} data-live={isLive ? 'true' : 'false'} data-phase={snapshot.Phase || 'idle'} data-remote={remoteClient ? 'true' : 'false'}>
      <a className="ro-skip-link" href="#riftops-main">Skip to workspace</a>
      {/* Toast Notification */}
      <Toast notification={notification} onClose={() => setNotification(null)} />
      <NotificationCenter
        open={notificationCenterOpen}
        entries={notificationHistory}
        onClose={() => setNotificationCenterOpen(false)}
        onRead={(id) => setNotificationHistory((items) => items.map((item) => item.id === id ? { ...item, read: true } : item))}
        onClear={() => setNotificationHistory([])}
      />

      {/* Confirmation Modal */}
      {confirmModal && <ConfirmModal action={confirmModal} onClose={() => setConfirmModal(null)} />}

      {/* Update Dialog */}
      <UpdateDialog release={updateAvailable} onDismiss={() => setUpdateAvailable(null)} />

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onSelectTab={setActiveTab}
        onCommand={handleCommand}
        remoteClient={remoteClient}
      />

      {/* Left Sidebar */}
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} phase={snapshot.Phase} onOpenCommandPalette={() => setCommandPaletteOpen(true)} remoteClient={remoteClient} />

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 flex flex-col min-w-0 bg-base/50 relative">
        <WorkspaceHeader
          activeTab={activeTab}
          phase={phaseLabel(snapshot.Phase)}
          detail={snapshot.Detail === 'Choose a game and launch with presence masking.' ? '' : snapshot.Detail}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onOpenNotifications={() => setNotificationCenterOpen(true)}
          unreadNotifications={notificationHistory.filter((item) => !item.read).length}
        />
        <main id="riftops-main" className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col relative z-10" tabIndex={-1}>
          {/* QoL Panel */}
          {activeTab === 'qol' && (
            <div className="workspace-stage workspace-stage--qol flex-1 min-h-0 overflow-hidden animate-fadeIn">
              <QoLPanel />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             COMMAND CENTER (DASHBOARD)
             ═══════════════════════════════════════════════ */}
          {activeTab === 'dashboard' && (
            <div className="workspace-stage workspace-stage--dashboard dashboard-page flex-1 flex flex-col min-h-0 animate-fadeIn">
              {/* Hero Banner */}
              <div className="dashboard-page__hero relative h-44 shrink-0 overflow-hidden border-b border-[#c8aa6e]/15">
                {gameImgError ? (
                  <div className="absolute inset-0 bg-gradient-to-br from-base via-[#091428] to-base" />
                ) : (
                  <img src={gameImg} alt="" width="1600" height="900" fetchPriority="high" className="absolute inset-0 w-full h-full object-cover" onError={() => setGameImgError(true)} />
                )}
                {/* Gradient overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-base via-base/60 to-black/40" />
                <div className="absolute inset-0 bg-gradient-to-r from-base/60 to-transparent" />

                <div className="dashboard-page__hero-copy relative h-full flex flex-col justify-end p-5 pb-4">
                  {/* Phase badge */}
                  <div className="flex items-center justify-between mb-auto">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-base/90 border border-white/[0.08]">
                        <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-primary animate-pulse shadow-sm shadow-primary' : 'bg-text-dim'}`} />
                        <span className="text-xs font-bold text-text-muted">{phaseLabel(snapshot.Phase)}</span>
                      </div>
                      {snapshot.Detail && snapshot.Detail !== 'Choose a game and launch with presence masking.' && (
                        <div className="px-2.5 py-1 rounded-lg bg-base/90 border border-white/[0.08]">
                          <span className="text-xs text-text-muted">{snapshot.Detail}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Game name + launch */}
                  <div className="dashboard-page__launch-row flex items-end justify-between mt-1">
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

                    <AccountSummary />

                    {!remoteClient && <div className="dashboard-page__launch-actions flex gap-2">
                      <button
                        onClick={() => handleLaunch()}
                        disabled={!isIdle || launchStage !== 'idle'}
                        className="btn-primary flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm"
                      >
                        {launchStage !== 'idle' ? <RotateCcw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                        <span>{launchStage === 'checking' ? 'Checking…' : launchStage === 'starting' ? 'Starting…' : launchStage === 'waiting' ? 'Connecting…' : launchStage === 'ready' ? 'Ready' : 'Launch'}</span>
                      </button>
                      <button
                        onClick={handleStop}
                        disabled={isIdle}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-danger/20 text-danger font-bold text-xs border border-danger/30 hover:bg-danger hover:text-white transition duration-200 disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer"
                      >
                        <Square className="w-3.5 h-3.5 fill-current" />
                        <span>Stop</span>
                      </button>
                    </div>}
                  </div>
                  {launchStage !== 'idle' && (
                    <div className="launch-progress" role="status" aria-live="polite">
                      <div className="launch-progress__track"><span style={{ width: launchStage === 'checking' ? '25%' : launchStage === 'starting' ? '50%' : launchStage === 'waiting' ? '78%' : '100%' }} /></div>
                      <span>{launchStage === 'checking' ? 'Preflight checks in progress' : launchStage === 'starting' ? 'Starting the selected Riot game' : launchStage === 'waiting' ? 'Waiting for the local client to become ready' : 'RiftOps is connected'}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Dashboard body */}
              <div className="dashboard-page__body flex-1 overflow-y-auto px-4 py-3 space-y-4">
                {remoteClient && <div className="phone-session-banner"><Shield /><span><strong>Phone session connected</strong><small>Live League controls are routed through your paired RiftOps desktop.</small></span></div>}

                {!remoteClient && (
                  <section className="dashboard-section dashboard-section--preflight" aria-labelledby="dashboard-preflight-title">
                    <div id="dashboard-preflight-title" className="dashboard-section__kicker">BEFORE YOU LAUNCH</div>
                    <div className="dashboard-page__context-grid">
                      <section className="dashboard-section dashboard-section--target">
                        <div className="dashboard-section__heading">
                          <span className="dashboard-section__icon"><Server /></span>
                          <span><small>TARGET GAME</small><strong>Choose a launch target</strong></span>
                        </div>
                        <GameSelector value={selectedGame} onChange={handleSetGame} disabled={!isIdle} />
                      </section>

                      <section className="dashboard-section dashboard-section--presence glass-card p-3.5 space-y-3">
                        <div className="dashboard-section__heading">
                          <span className="dashboard-section__icon"><Shield /></span>
                          <span><small>PRESENCE SHIELD</small><strong>Control what friends see</strong></span>
                          <label className="toggle">
                            <input type="checkbox" checked={snapshot.Enabled} onChange={(e) => handleToggleMasking(e.target.checked)} />
                            <span className="slider" />
                          </label>
                        </div>
                        <StatusSelector current={snapshot.Status} onChange={handleSetStatus} />
                      </section>
                    </div>
                  </section>
                )}

                <section className="dashboard-section dashboard-section--control">
                  <div className="dashboard-section__kicker">LEAGUE NOW</div>
                  <ClientControlRoom remoteClient={remoteClient} onOpenQoL={() => setActiveTab(remoteClient ? 'live' : 'qol')} onOpenLive={() => setActiveTab('live')} onOpenHistory={() => setActiveTab('history')} showToast={(message, type = 'info') => showToast('League Client', message, type)} />
                </section>
                {remoteClient && <PhoneCompanionPanel showToast={(message, type = 'info') => showToast('League Client', message, type)} />}

                {snapshot.StartedAt && (
                  <div className="dashboard-launch-history">
                    <Play className="dashboard-launch-history__icon" />
                    <span>Last launch <strong>{timeAgo(snapshot.StartedAt)}</strong></span>
                    {snapshot.Game && <span className="dashboard-launch-history__game">{gameLabel(snapshot.Game)}</span>}
                  </div>
                )}

                {!remoteClient && <details className="dashboard-tools">
                  <summary><span><Wrench /><span><strong>Utilities & diagnostics</strong><small>Shortcuts and local logs</small></span></span><ChevronDown /></summary>
                  <div className="dashboard-tools__content">
                    <section className="dashboard-section dashboard-section--quick">
                      <div className="dashboard-section__kicker">SHORTCUTS</div>
                      <QuickActions onOpenQoL={() => setActiveTab('qol')} showToast={(message, type = 'info') => showToast('League Client', message, type)} />
                    </section>
                    <section className="dashboard-section dashboard-section--logs">
                      <div className="dashboard-section__kicker">DIAGNOSTICS</div>
                      <LogViewer logs={logs} onClear={() => setLogs([])} />
                    </section>
                  </div>
                </details>}
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             PLAY FLOW TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'play' && (
            <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden animate-fadeIn">
              <PlayFlowPage remoteClient={remoteClient} showToast={(message, type = 'info') => showToast('Play Flow', message, type)} onOpenLive={() => setActiveTab('live')} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             LIVE SESSION TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'live' && (
            <div className="workspace-stage workspace-stage--live flex-1 min-h-0 min-w-0 overflow-y-auto animate-fadeIn">
              <LiveSessionPage remoteClient={remoteClient} onOpenPlayFlow={() => setActiveTab('play')} onOpenCommandCenter={() => setActiveTab('dashboard')} showToast={(message, type = 'info') => showToast('Live Session', message, type)} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             MATCH HISTORY TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'history' && (
            <div className="workspace-stage workspace-stage--history flex-1 overflow-y-auto p-4 animate-fadeIn">
              <MatchHistory />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             SKIN SHOWCASE TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'skins' && (
            <div className="workspace-stage workspace-stage--skins flex-1 overflow-y-auto p-4 animate-fadeIn">
              <CollectionWorkspace remoteClient={remoteClient} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             LOOT DASHBOARD TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'loot' && (
            <div className="workspace-stage workspace-stage--loot flex-1 overflow-y-auto animate-fadeIn">
              <LootDashboard />
            </div>
          )}

          {activeTab === 'remote' && !remoteClient && (
            <div className="workspace-stage workspace-stage--remote flex-1 overflow-y-auto animate-fadeIn">
              <RemoteAccessPage showToast={showPhoneToast} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             SETTINGS TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'settings' && (
            <div className="workspace-stage workspace-stage--settings flex-1 overflow-y-auto p-4 space-y-4 animate-fadeIn">
              <div className="settings-page-heading">
                <div className="settings-page-heading__identity"><span className="settings-page-heading__icon"><Settings /></span><div><span className="page-header__eyebrow">WORKSPACE CONFIGURATION</span><h1>App settings</h1><p>Keep launch behavior, client performance, and desktop integration under control.</p></div></div>
                <span className="page-header__badge">Local preferences</span>
              </div>

              <nav className="settings-nav" aria-label="Settings sections">
                <a href="#settings-launch">Launch & presence</a>
                <a href="#settings-interface">Interface & performance</a>
                <a href="#settings-league">League installation</a>
                <a href="#settings-data">Data & app</a>
              </nav>
              <ActionFeedback state={settingsFeedback} className="settings-feedback" />

              {/* Preferences */}
              <div id="settings-launch" className="settings-card glass-card p-4 space-y-3">
                <div className="settings-card__heading"><span><Play /></span><div><small>LAUNCH & PRESENCE</small><h4>League startup</h4><p>Choose what RiftOps launches and how your presence starts.</p></div></div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-text-muted">Default Game</label>
                    <select
                      aria-label="Default game"
                      name="default-game"
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
                      aria-label="Startup status"
                      name="startup-status"
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

                <div className="settings-control-list space-y-2 pt-2 border-t border-white/[0.06]">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text">Keep lobby chat connected (MUC)</span>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        aria-label="Keep lobby chat connected"
                        checked={prefMUC}
                        onChange={(e) => {
                          setPrefMUC(e.target.checked);
                          void persistPreferences({ connectToMUC: e.target.checked }).catch((err: any) => showToast('Save failed', err.message, 'error'));
                        }}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                </div>
              </div>

              <div id="settings-interface" className="settings-card glass-card p-4 space-y-3">
                <div className="settings-card__heading"><span><Sparkles /></span><div><small>INTERFACE & PERFORMANCE</small><h4>Workspace behavior</h4><p>These controls are stored locally and apply immediately.</p></div></div>
                <div className="settings-control-list space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text">Auto check for updates</span>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        aria-label="Automatically check for updates"
                        checked={prefUpdates}
                        onChange={(e) => {
                          setPrefUpdates(e.target.checked);
                          void persistPreferences({ checkUpdates: e.target.checked }).catch((err: any) => showToast('Save failed', err.message, 'error'));
                        }}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text">Compact workspace density</span>
                    <label className="toggle">
                      <input type="checkbox" aria-label="Use compact workspace density" checked={compactMode} onChange={(e) => { setCompactMode(e.target.checked); setSettingsFeedback({ tone: 'success', message: e.target.checked ? 'Compact density enabled.' : 'Comfortable density enabled.' }); }} />
                      <span className="slider" />
                    </label>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text">Reduce interface motion</span>
                    <label className="toggle">
                      <input type="checkbox" aria-label="Reduce interface motion" checked={reducedMotion} onChange={(e) => { setReducedMotion(e.target.checked); setSettingsFeedback({ tone: 'success', message: e.target.checked ? 'Interface motion reduced.' : 'Standard interface motion restored.' }); }} />
                      <span className="slider" />
                    </label>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="text-xs text-text block">Client performance mode</span>
                      <span className="text-[10px] text-text-dim block mt-0.5">Controls background polling and refresh work.</span>
                    </div>
                    <select
                      value={performanceMode}
                      onChange={(event) => { setPerformanceMode(event.target.value as keyof typeof PERFORMANCE_MODES); setSettingsFeedback({ tone: 'success', message: `${PERFORMANCE_MODES[event.target.value as keyof typeof PERFORMANCE_MODES].label} performance mode applied.` }); }}
                      className="w-32 text-xs shrink-0"
                      aria-label="Client performance mode"
                    >
                      {Object.entries(PERFORMANCE_MODES).map(([key, mode]) => <option key={key} value={key}>{mode.label}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              <div id="settings-league" className="settings-card glass-card p-4 space-y-3">
                <div className="settings-card__heading"><span><FolderOpen /></span><div><small>LEAGUE INSTALLATION</small><h4>Client location & desktop</h4><p>Configure the executable RiftOps validates before launch.</p></div></div>
                <div className="space-y-2 pb-3 border-b border-white/[0.06]">
                  <div>
                    <p className="text-xs text-text">Riot Client location</p>
                    <p className="text-[11px] text-text-muted mt-0.5">
                      Select League of Legends.app, Riot Client.app, or the client executable.
                    </p>
                  </div>
                  <input
                    aria-label="Riot Client location"
                    name="riot-client-location"
                    autoComplete="off"
                    spellCheck={false}
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
                      <input type="checkbox" aria-label="Start RiftOps with Windows" checked={autostartEnabled} onChange={(e) => void handleAutostart(e.target.checked)} />
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
              <div id="settings-data" className="settings-card settings-card--data glass-card p-4 space-y-2">
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
                <button type="button" onClick={resetWorkspacePreferences} className="text-[10px] text-text-dim hover:text-primary transition cursor-pointer">
                  Reset workspace layout and local filters
                </button>
                <button type="button" onClick={clearAssetCache} className="text-[10px] text-text-dim hover:text-primary transition cursor-pointer">
                  Clear RiftOps asset cache
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
