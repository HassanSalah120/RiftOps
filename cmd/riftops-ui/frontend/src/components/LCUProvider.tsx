import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchLCUOverview,
  type LCUHealth,
  type LCUStatus,
  type QoLState,
} from '../api';
import { LCUConnectionContext, PERFORMANCE_MODES, type LCUConnectionSnapshot, type PerformanceMode } from './lcuConnectionContext';

export function LCUConnectionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<LCUStatus | null>(null);
  const [health, setHealth] = useState<LCUHealth | null>(null);
  const [qol, setQol] = useState<QoLState | null>(null);
  const [gameflowSession, setGameflowSession] = useState<import('../api').LCUGameflowSession | null>(null);
  const [gameflowSessionAvailable, setGameflowSessionAvailable] = useState<boolean | null>(null);
  const [activeGame, setActiveGame] = useState<import('../api').GameClientData | null>(null);
  const [activeGameAvailable, setActiveGameAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [performanceMode, setPerformanceModeState] = useState<PerformanceMode>(() => {
    try {
      const saved = localStorage.getItem('riftops.performanceMode') as PerformanceMode | null;
      return saved && Object.prototype.hasOwnProperty.call(PERFORMANCE_MODES, saved) ? saved : 'balanced';
    } catch {
      return 'balanced';
    }
  });
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const inFlight = useRef(false);
  const requestController = useRef<AbortController | null>(null);
  const overviewSignature = useRef('');
  const lastPublishedAt = useRef(0);

  const [streamerMode, setStreamerModeState] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('riftops.streamerMode');
      if (saved !== null) return saved === 'true';
      return true; // Safe streamer & privacy mode enabled by default
    } catch {
      return true;
    }
  });

  const setPerformanceMode = useCallback((mode: PerformanceMode) => {
    setPerformanceModeState(mode);
    try { localStorage.setItem('riftops.performanceMode', mode); } catch { /* Optional preference. */ }
  }, []);

  const setStreamerMode = useCallback((enabled: boolean) => {
    setStreamerModeState(enabled);
    try { localStorage.setItem('riftops.streamerMode', String(enabled)); } catch { /* Optional preference. */ }
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const realtimeInterval = performanceMode === 'fast' ? 900 : performanceMode === 'quiet' ? 3000 : 1500;
  const pollInterval = useMemo(() => {
    const activePhase = ['Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect', 'GameStart', 'Loading', 'InProgress', 'Reconnect', 'EndOfGame'].includes(qol?.phase || '');
    let base = PERFORMANCE_MODES[performanceMode].pollMs;
    if (activePhase) base = realtimeInterval;
    else if (status?.connected) base = Math.min(base, 2000);
    else if (performanceMode === 'fast') base = 10000;
    return status?.connected ? base : Math.min(base * 2, 30000);
  }, [performanceMode, qol?.phase, realtimeInterval, status?.connected]);

  const refresh = useCallback(async () => {
    if (!pageVisible || inFlight.current) return;
    inFlight.current = true;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const overview = await fetchLCUOverview(controller.signal);
      const signature = JSON.stringify(overview);
      const now = Date.now();
      if (signature !== overviewSignature.current) {
        overviewSignature.current = signature;
        setStatus(overview.status);
        setHealth(overview.health);
        setQol(overview.qol || null);
        setGameflowSession(overview.gameflowSession || null);
        setGameflowSessionAvailable(typeof overview.gameflowSessionAvailable === 'boolean' ? overview.gameflowSessionAvailable : null);
        setActiveGame(overview.activeGame || null);
        setActiveGameAvailable(typeof overview.activeGameAvailable === 'boolean' ? overview.activeGameAvailable : null);
        setLastUpdated(new Date(now));
        lastPublishedAt.current = now;
      } else if (now - lastPublishedAt.current >= 30000) {
        setLastUpdated(new Date(now));
        lastPublishedAt.current = now;
      }
      setError(null);
      setStale(!overview.status.connected && overview.health?.connected !== true);
    } catch (reason: any) {
      if (reason?.name === 'AbortError') return;
      setStale(true);
      setError(reason?.message || 'League Client state is temporarily unavailable.');
    } finally {
      if (requestController.current === controller) requestController.current = null;
      inFlight.current = false;
      setLoading(false);
    }
  }, [pageVisible]);

  // A League launch or a newly entered custom/practice lobby often happens
  // while RiftOps is already visible, so visibility changes alone are not
  // enough to trigger an immediate state transition. Refresh on focus/pageshow
  // as well, while the normal timer remains the fallback.
  useEffect(() => {
    const refreshWhenActive = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', refreshWhenActive);
    window.addEventListener('pageshow', refreshWhenActive);
    return () => {
      window.removeEventListener('focus', refreshWhenActive);
      window.removeEventListener('pageshow', refreshWhenActive);
    };
  }, [refresh]);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    if (!pageVisible) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(() => void tick(), pollInterval);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [pageVisible, pollInterval, refresh]);

  const value = useMemo<LCUConnectionSnapshot>(() => ({
    status,
    health,
    qol,
    gameflowSession,
    gameflowSessionAvailable,
    activeGame,
    activeGameAvailable,
    connected: Boolean(status?.leagueReady),
    leagueReady: Boolean(status?.leagueReady),
    loading,
    stale,
    error,
    lastUpdated,
    performanceMode,
    setPerformanceMode,
    streamerMode,
    setStreamerMode,
    pageVisible,
    pollInterval,
    realtimeInterval,
    refresh,
  }), [status, health, qol, gameflowSession, gameflowSessionAvailable, activeGame, activeGameAvailable, loading, stale, error, lastUpdated, performanceMode, setPerformanceMode, streamerMode, setStreamerMode, pageVisible, pollInterval, realtimeInterval, refresh]);

  return <LCUConnectionContext.Provider value={value}>{children}</LCUConnectionContext.Provider>;
}
