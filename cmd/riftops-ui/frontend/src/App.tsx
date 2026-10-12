import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Play, Square, Shield, RotateCcw, Zap, Swords, ArrowRight, Users, ChevronDown } from 'lucide-react';
import type { Tab, Snapshot, LogLine } from './types';
import type { ConfirmAction, Notification, Release } from './types';
import GameSelector from './components/GameSelector';
import StatusSelector from './components/StatusSelector';
import Toast from './components/Toast';
import Sidebar from './components/Sidebar';
import QuickActions from './components/QuickActions';
import CommandPalette from './components/CommandPalette';
import WorkspaceHeader from './components/WorkspaceHeader';
import TitleBar from './components/TitleBar';
import * as api from './api';
import ConfirmModal from './components/ConfirmModal';
import UpdateDialog from './components/UpdateDialog';
import NotificationCenter from './components/NotificationCenter';
import type { NotificationEntry } from './components/NotificationCenter';
import { useLCUConnection } from './components/lcuConnectionContext';
import ClientControlRoom from './components/ClientControlRoom';
import AccountSummary from './components/AccountSummary';
import { GAMES, gameLabel } from './types';
import { StatusBadge, type FeedbackState } from './components/DesignPrimitives';
import PageHeader from './components/PageHeader';
import { ALL_TABS, availableTabs, tabAvailable } from './clientCapabilities';
import PhoneCompanionPanel from './components/PhoneCompanionPanel';
import FriendsPanel from './components/FriendsPanel';
import LaunchProfilesPanel from './components/LaunchProfilesPanel';
import { useLocale } from './localeContext';
import { normalizeLivePhase, livePhaseLabel } from './liveSession';
import FirstRunSetup from './components/FirstRunSetup';

const MatchHistory = lazy(() => import('./components/MatchHistory'));
const PlayFlowPage = lazy(() => import('./components/PlayFlowPage'));
const LiveSessionPage = lazy(() => import('./components/LiveSessionPage'));
const CollectionWorkspace = lazy(() => import('./components/CollectionWorkspace'));
const ProgressPage = lazy(() => import('./components/ProgressPage'));
const QoLPanel = lazy(() => import('./components/QoLPanel'));
const LootDashboard = lazy(() => import('./components/LootDashboard'));
const RemoteAccessPage = lazy(() => import('./components/RemoteAccessPage'));
const SocialCenter = lazy(() => import('./components/SocialCenter'));
const SettingsPage = lazy(() => import('./components/SettingsPage'));

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
  if (isNaN(then) || then <= 0 || startedAt.startsWith('0001-')) return '';
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
  const { locale, setLocale, t } = useLocale();
  const [showFirstRun, setShowFirstRun] = useState(() => {
    try {
      return !localStorage.getItem('riftops.setupComplete') && !localStorage.getItem('riftops.activeTab');
    } catch { return false; }
  });
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem('riftops.activeTab');
      return ALL_TABS.includes(saved as Tab) ? saved as Tab : 'dashboard';
    } catch {
      return 'dashboard';
    }
  });
  useEffect(() => {
    const navigate = (event: Event) => {
      const tab = (event as CustomEvent<Tab>).detail;
      if (ALL_TABS.includes(tab)) setActiveTab(tab);
    };
    window.addEventListener('riftops:navigate', navigate);
    return () => window.removeEventListener('riftops:navigate', navigate);
  }, []);
  const [homeAction, setHomeAction] = useState('');
  const homeActionLock = useRef(false);
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
  const { connected: lcuConnected, qol: lcuQol, performanceMode, setPerformanceMode, pageVisible } = useLCUConnection();
  const previousLcuConnection = useRef<boolean | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => {
    if (showFirstRun && !remoteClient) return;
    try { localStorage.setItem('riftops.activeTab', activeTab); } catch { /* Preferences are optional. */ }
  }, [activeTab, showFirstRun, remoteClient]);

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
    }, type === 'error' ? 7000 : 4000);
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
    if (showFirstRun && !remoteClient) return;
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
  }, [remoteClient, showFirstRun]);

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
        setPreferencesReady(true);
      } catch (err: any) {
        showToast('Preferences unavailable', err.message || 'Using safe defaults until settings can be loaded.', 'error');
      } finally {
        setPreferencesLoading(false);
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
      showToast(
        res.Enabled ? 'Presence shield active' : 'Riot chat connected',
        res.Enabled ? `Presence set to ${res.Status}` : res.Detail,
        res.Enabled ? 'success' : 'info',
      );
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
    if (homeActionLock.current) return;
    homeActionLock.current = true;
    setHomeAction('stop');
    try {
      await api.stopEngine();
      const res = await api.fetchSnapshot();
      setSnapshot(res);
      showToast('Engine Stopped', 'RiftOps is idle.', 'info');
    } catch (err: any) {
      showToast('Stop Error', err.message, 'error');
    } finally { homeActionLock.current = false; setHomeAction(''); }
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
    if (!presenceStatusAvailable) {
      showToast('League unavailable', 'League availability cannot be changed until the client is connected.', 'info');
      return;
    }
    if (homeActionLock.current) return;
    homeActionLock.current = true;
    setHomeAction('presence');
    try {
      await api.setStatus(status);
      const snap = await api.fetchSnapshot();
      setSnapshot(snap);
      showToast('Presence Updated', `Status set to ${status}`, 'success');
    } catch (err: any) {
      showToast('Set Status Error', err.message, 'error');
    } finally { homeActionLock.current = false; setHomeAction(''); }
  };

  const handleToggleMasking = async (enabled: boolean) => {
    if (enabled && !presenceControlsAvailable) {
      showToast('Native Riot chat active', 'Presence masking is unavailable for this run so friends and chat can stay connected.', 'info');
      return;
    }
    if (homeActionLock.current) return;
    homeActionLock.current = true;
    setHomeAction('masking');
    try {
      await api.toggleMasking(enabled);
      const snap = await api.fetchSnapshot();
      setSnapshot(snap);
      showToast('Masking Toggled', enabled ? 'Presence shield enabled' : 'Presence shield disabled', 'info');
    } catch (err: any) {
      showToast('Toggle Masking Error', err.message, 'error');
    } finally { homeActionLock.current = false; setHomeAction(''); }
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
  const leaguePhase = normalizeLivePhase(lcuQol?.phase, lcuQol?.queueState);
  const isLive = lcuConnected && ['IN_GAME', 'LOADING', 'RECONNECTING'].includes(leaguePhase);
  const leagueStatus = !lcuConnected ? 'League offline' : livePhaseLabel(leaguePhase);
  const presenceControlsAvailable = isIdle || snapshot.ChatPort > 0;
  const presenceStatusAvailable = presenceControlsAvailable || lcuConnected;
  const leagueAvailability = lcuQol?.availability || snapshot.Status;
  const gameInfo = GAMES.find((g) => g.value === selectedGame);
  const gameImg = GAME_IMGS[selectedGame];

  if (clientMode === 'loading') {
    return (
      <main className="riftops-bootstrap" aria-busy="true" aria-live="polite">
        <img className="riftops-bootstrap__logo" src="/branding/riftops-full-logo.png" alt="RiftOps" width="240" height="240" />
        <strong>Securing RiftOps…</strong>
        <span>Loading the permissions for this device.</span>
      </main>
    );
  }

  if (showFirstRun && !remoteClient) {
    const finishSetup = () => {
      try { localStorage.setItem('riftops.setupComplete', 'true'); } catch { /* Session remains usable without storage. */ }
      setActiveTab('dashboard');
      setShowFirstRun(false);
      window.requestAnimationFrame(() => document.getElementById('riftops-main')?.focus());
    };
    return (
      <div className="riftops-window flex flex-col h-screen bg-base text-text overflow-hidden">
        <TitleBar />
        <FirstRunSetup
          key={preferencesReady ? 'loaded' : 'loading'}
          game={prefGame} startupStatus={prefStartup} performance={performanceMode}
          preferencesReady={preferencesReady} preferencesLoading={preferencesLoading}
          onSkip={finishSetup}
          onApply={async (choices) => {
            await persistPreferences({ game: choices.game, startupStatus: choices.startupStatus });
            setSelectedGame(choices.game);
            setPerformanceMode(choices.performance);
            finishSetup();
          }}
        />
      </div>
    );
  }

  return (
    <div className={`riftops-window flex flex-col h-screen bg-base text-text overflow-hidden ${compactMode ? 'is-compact' : ''}`} data-live={isLive ? 'true' : 'false'} data-phase={snapshot.Phase || 'idle'} data-remote={remoteClient ? 'true' : 'false'}>
      <TitleBar remoteClient={remoteClient} phase={leagueStatus} isLive={isLive} />
      <div className="riftops-shell flex flex-1 min-h-0 overflow-hidden">
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[999] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-xs focus:font-bold focus:text-black focus:shadow-2xl focus:outline-none"
          href="#riftops-main"
        >
          Skip to workspace
        </a>
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
          notificationCenterOpen={notificationCenterOpen}
          detail={snapshot.Detail === 'Choose a game and launch with presence masking.' ? '' : snapshot.Detail}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onOpenNotifications={() => setNotificationCenterOpen(true)}
          unreadNotifications={notificationHistory.filter((item) => !item.read).length}
        />
        <main id="riftops-main" className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col relative z-10" tabIndex={-1}>
          <Suspense fallback={<div className="workspace-loading" role="status">Loading workspace…</div>}>
          {/* Toast renders above the workspace without changing its layout. */}
          <Toast notification={notification} onClose={() => setNotification(null)} />
          {/* QoL Panel */}
          {activeTab === 'qol' && (
            <div className="workspace-stage workspace-stage--qol flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden animate-fadeIn">
              <QoLPanel onOpenLive={() => setActiveTab('live')} onOpenPlayFlow={() => setActiveTab('play')} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             COMMAND CENTER (DASHBOARD)
             ═══════════════════════════════════════════════ */}
          {activeTab === 'dashboard' && (
            <div className="home-workspace workspace-stage flex-1 min-h-0 overflow-y-auto">
              <PageHeader icon={Play} eyebrow="HOME" title="Home" description="Launch your game, manage your presence, and get ready for the next match." meta={<StatusBadge tone={lcuConnected ? 'live' : 'neutral'}>{leagueStatus}</StatusBadge>} />
              {remoteClient && <div className="phone-session-banner"><Shield /><span><strong>Phone session connected</strong><small>Live League controls are routed through your paired RiftOps desktop.</small></span></div>}
              <div className="home-overview">
                {!remoteClient && <section className="home-launch" aria-labelledby="home-launch-title">
                  <div className="home-launch__art">
                    {!gameImgError && <img src={gameImg} alt="" width="1600" height="900" fetchPriority="high" onError={() => setGameImgError(true)} />}
                    <div className="home-launch__identity"><h2 id="home-launch-title">{gameInfo?.label || 'Choose your game'}</h2><span>Proxy {phaseLabel(snapshot.Phase).toLowerCase()}</span></div>
                  </div>
                  <div className="home-launch__body">
                    <GameSelector value={selectedGame} onChange={handleSetGame} disabled={!isIdle} />
                    <div className="home-launch__actions">
                      <button type="button" onClick={() => handleLaunch()} disabled={!isIdle || launchStage !== 'idle' || homeAction !== ''} className="btn-primary">
                        {launchStage !== 'idle' ? <RotateCcw className="animate-spin" /> : <Play className="fill-current" />}
                        {launchStage === 'checking' ? 'Checking…' : launchStage === 'starting' ? 'Starting…' : launchStage === 'waiting' ? 'Connecting…' : launchStage === 'ready' ? 'Ready' : `Launch ${gameInfo?.label || 'game'}`}
                      </button>
                      <button type="button" onClick={handleStop} disabled={isIdle || homeAction !== ''} className="btn-secondary" title="Stop the RiftOps chat proxy">{homeAction === 'stop' ? <RotateCcw className="animate-spin" /> : <Square />}{homeAction === 'stop' ? 'Stopping…' : 'Stop proxy'}</button>
                    </div>
                    {launchStage !== 'idle' && <div className="launch-progress" role="status" aria-live="polite"><div className="launch-progress__track"><span style={{ width: launchStage === 'checking' ? '25%' : launchStage === 'starting' ? '50%' : launchStage === 'waiting' ? '78%' : '100%' }} /></div><span>{launchStage === 'checking' ? 'Preflight checks in progress' : launchStage === 'starting' ? 'Starting the selected Riot game' : launchStage === 'waiting' ? 'Waiting for the local client to become ready' : 'RiftOps is connected'}</span></div>}
                    {snapshot.Detail && <p className="home-launch__detail" role="status">{snapshot.Detail}</p>}
                    {timeAgo(snapshot.StartedAt) && <p className="home-launch__last">Last launch {timeAgo(snapshot.StartedAt)}{snapshot.Game ? ` · ${gameLabel(snapshot.Game)}` : ''}</p>}
                  </div>
                </section>}
                <div className="home-account">
                  <AccountSummary />
                  {!remoteClient && <section className="home-presence" aria-labelledby="home-presence-title">
                    <header><div><h2 id="home-presence-title">Chat presence</h2><p>Choose how friends see you.</p></div><Shield aria-hidden="true" /></header>
                    <StatusSelector current={leagueAvailability} onChange={handleSetStatus} disabled={!presenceStatusAvailable || homeAction !== ''} />
                    <div className="home-presence__mask"><span><strong>Presence masking</strong><small>{snapshot.Enabled ? 'Masking is enabled' : 'Masking is disabled'}</small></span><label className="toggle"><input type="checkbox" role="switch" aria-label="Presence masking" checked={snapshot.Enabled} disabled={!presenceControlsAvailable || homeAction !== ''} onChange={(e) => handleToggleMasking(e.target.checked)} /><span className="slider" /></label></div>
                    {!presenceControlsAvailable && lcuConnected && <p>Native Riot friends and chat are active. Availability is applied directly through League; secure masking is unavailable for this run.</p>}
                    {!presenceStatusAvailable && <p>Launch League and sign in to change availability.</p>}
                  </section>}
                  {remoteClient && <PhoneCompanionPanel showToast={(message, type = 'info') => showToast('League Client', message, type)} />}
                </div>
              </div>
              <section className="home-next" aria-labelledby="home-next-title"><span className="home-next__icon"><Swords /></span><div><h2 id="home-next-title">{isLive ? 'Your match is live' : 'Ready for your next match?'}</h2><p>{isLive ? 'Follow champion select, match status, and your build in Live Game.' : 'Choose a queue and lanes, then play manually or use your automation rules.'}</p></div><button type="button" className="btn-primary" onClick={() => setActiveTab(isLive ? 'live' : 'play')}>{isLive ? 'Open Live Game' : 'Open Play & Queue'}<ArrowRight /></button></section>
              <div className="home-session-grid">
                <section className="home-session"><h2>League session</h2><ClientControlRoom remoteClient={remoteClient} onOpenQoL={() => setActiveTab(remoteClient ? 'live' : 'qol')} onOpenLive={() => setActiveTab('live')} onOpenHistory={() => setActiveTab('history')} showToast={(message, type = 'info') => showToast('League Client', message, type)} /></section>
                {!remoteClient && <section className="home-friends" aria-label="League friends"><FriendsPanel id="dashboard-friends" connected={lcuConnected} /></section>}
              </div>
              {!remoteClient && <div className="home-secondary">
                <details className="workflow-disclosure"><summary><span><Users /><strong>Riot accounts & launch profiles</strong><small>Choose, add, or manage saved accounts</small></span><ChevronDown /></summary><div><LaunchProfilesPanel activeProfileId={snapshot.ActiveProfileID} showToast={showToast} onRefreshSnapshot={async () => { setSnapshot(await api.fetchSnapshot()); }} /></div></details>
                <details className="workflow-disclosure"><summary><span><Zap /><strong>Quick automations</strong><small>Ready checks, requeue, and client shortcuts</small></span><ChevronDown /></summary><div><QuickActions onOpenQoL={() => setActiveTab('qol')} showToast={(message, type = 'info') => showToast('League Client', message, type)} /></div></details>
              </div>}
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             PLAY FLOW TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'play' && (
            <div className="workspace-stage workspace-stage--play flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden animate-fadeIn">
              <PlayFlowPage remoteClient={remoteClient} showToast={(message, type = 'info') => showToast('Play & Queue', message, type)} onOpenLive={() => setActiveTab('live')} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             LIVE SESSION TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'live' && (
            <div className="workspace-stage workspace-stage--live flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto animate-fadeIn">
              <LiveSessionPage remoteClient={remoteClient} onOpenPlayFlow={() => setActiveTab('play')} onOpenCommandCenter={() => setActiveTab('dashboard')} showToast={(message, type = 'info') => showToast('Live Session', message, type)} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             SOCIAL TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'social' && (
            <div className="workspace-stage workspace-stage--social flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden animate-fadeIn">
              <SocialCenter remoteClient={remoteClient} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             MATCH HISTORY TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'history' && (
            <div className="workspace-stage workspace-stage--history flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto animate-fadeIn">
              <MatchHistory remoteClient={remoteClient} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             SKIN SHOWCASE TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'skins' && (
            <div className="workspace-stage workspace-stage--skins flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto animate-fadeIn">
              <CollectionWorkspace remoteClient={remoteClient} />
            </div>
          )}

          {activeTab === 'progress' && (
            <div className="workspace-stage workspace-stage--progress flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto animate-fadeIn">
              <ProgressPage remoteClient={remoteClient} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             LOOT DASHBOARD TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'loot' && (
            <div className="workspace-stage workspace-stage--loot flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto animate-fadeIn">
              <LootDashboard />
            </div>
          )}

          {activeTab === 'remote' && !remoteClient && (
            <div className="workspace-stage workspace-stage--remote flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto animate-fadeIn">
              <RemoteAccessPage showToast={showPhoneToast} />
            </div>
          )}

          {/* ═══════════════════════════════════════════════
             SETTINGS TAB
             ═══════════════════════════════════════════════ */}
          {activeTab === 'settings' && (
            <div className="workspace-stage workspace-stage--settings flex flex-1 min-h-0 min-w-0 flex-col overflow-y-auto animate-fadeIn">
              <SettingsPage
                snapshot={snapshot}
                prefGame={prefGame}
                setPrefGame={setPrefGame}
                prefStartup={prefStartup}
                setPrefStartup={setPrefStartup}
                prefMUC={prefMUC}
                setPrefMUC={setPrefMUC}
                prefUpdates={prefUpdates}
                setPrefUpdates={setPrefUpdates}
                riotClientPath={riotClientPath}
                setRiotClientPath={setRiotClientPath}
                riotLocationBusy={riotLocationBusy}
                settingsFeedback={settingsFeedback}
                setSettingsFeedback={setSettingsFeedback}
                autostartEnabled={autostartEnabled}
                handleAutostart={handleAutostart}
                compactMode={compactMode}
                setCompactMode={setCompactMode}
                reducedMotion={reducedMotion}
                setReducedMotion={setReducedMotion}
                performanceMode={performanceMode}
                setPerformanceMode={setPerformanceMode}
                locale={locale}
                setLocale={setLocale}
                t={t}
                persistPreferences={persistPreferences}
                updateRiotLocation={updateRiotLocation}
                api={api}
                handleQuit={handleQuit}
                resetWorkspacePreferences={resetWorkspacePreferences}
                clearAssetCache={clearAssetCache}
                showToast={showToast}
                lcuConnected={lcuConnected}
                onUpdateDetected={setUpdateAvailable}
                logs={logs}
                onClearLogs={() => setLogs([])}
              />
            </div>
          )}
        </Suspense>
        </main>
      </div>
    </div>
  </div>
);
}
