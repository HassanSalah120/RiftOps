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

  const setPerformanceMode = useCallback((mode: PerformanceMode) => {
    setPerformanceModeState(mode);
    try { localStorage.setItem('riftops.performanceMode', mode); } catch { /* Optional preference. */ }
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const pollInterval = useMemo(() => {
    const activePhase = ['Matchmaking', 'ReadyCheck', 'ChampSelect', 'InProgress', 'EndOfGame'].includes(qol?.phase || '');
    const base = performanceMode === 'fast' && !activePhase
      ? 10000
      : PERFORMANCE_MODES[performanceMode].pollMs;
    return status?.connected ? base : Math.min(base * 2, 30000);
  }, [performanceMode, qol?.phase, status?.connected]);
  const realtimeInterval = performanceMode === 'fast' ? 900 : performanceMode === 'quiet' ? 3000 : 1500;

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
    connected: Boolean(status?.leagueReady),
    leagueReady: Boolean(status?.leagueReady),
    loading,
    stale,
    error,
    lastUpdated,
    performanceMode,
    setPerformanceMode,
    pageVisible,
    pollInterval,
    realtimeInterval,
    refresh,
  }), [status, health, qol, loading, stale, error, lastUpdated, performanceMode, setPerformanceMode, pageVisible, pollInterval, realtimeInterval, refresh]);

  return <LCUConnectionContext.Provider value={value}>{children}</LCUConnectionContext.Provider>;
}
