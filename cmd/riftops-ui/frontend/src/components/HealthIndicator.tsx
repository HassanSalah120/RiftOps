import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Server, Wifi, WifiOff } from 'lucide-react';
import { fetchServerStatus, type ServerStatusItem } from '../api';
import { useLCUConnection } from './lcuConnectionContext';

function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function latencyColor(ms: number): string {
  if (ms <= 0) return '#6a6a88';
  if (ms < 50) return '#10b981';
  if (ms < 150) return '#e8956a';
  return '#ef4444';
}

function statusColor(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'online' || s === 'up' || s === 'normal') return '#10b981';
  if (s === 'degraded' || s === 'partial') return '#e8956a';
  if (s === 'outage' || s === 'down' || s === 'major') return '#ef4444';
  return '#6a6a88';
}

function performanceLabel(health: { connected: boolean; latencyMs: number; memoryMB: number; cpuPercent: number } | null): { label: string; color: string } {
  if (!health?.connected) return { label: 'Unavailable', color: '#6a6a88' };
  const underPressure = health.latencyMs > 150 || health.cpuPercent > 85 || health.memoryMB > 1800;
  const watch = health.latencyMs > 50 || health.cpuPercent > 55 || health.memoryMB > 1200;
  if (underPressure) return { label: 'Needs attention', color: '#ef4444' };
  if (watch) return { label: 'Watch', color: '#e8956a' };
  return { label: 'Healthy', color: '#10b981' };
}

export default function HealthIndicator() {
  const [serverStatus, setServerStatus] = useState<ServerStatusItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [latencyHistory, setLatencyHistory] = useState<number[]>([]);
  const { health, refresh: refreshConnection, pageVisible, performanceMode } = useLCUConnection();
  const performance = performanceLabel(health);

  useEffect(() => {
    if (!health?.connected || health.latencyMs <= 0) return;
    setLatencyHistory((current) => [...current, health.latencyMs].slice(-18));
  }, [health?.connected, health?.latencyMs]);

  const refresh = useCallback(async (includeClient = false) => {
    if (!pageVisible) return;
    setLoading(true);
    try {
      const [, s] = await Promise.all([
        includeClient ? refreshConnection() : Promise.resolve(),
        fetchServerStatus('NA').catch(() => []),
      ]);
      setServerStatus(Array.isArray(s) ? s : []);
    } finally {
      setLoading(false);
    }
  }, [pageVisible, refreshConnection]);

  useEffect(() => { void refresh(false); }, [refresh]);
  useEffect(() => {
    if (!pageVisible) return undefined;
    const interval = performanceMode === 'fast' ? 45000 : performanceMode === 'quiet' ? 120000 : 90000;
    const timer = window.setInterval(() => void refresh(false), interval);
    return () => window.clearInterval(timer);
  }, [pageVisible, performanceMode, refresh]);

  return (
    <div className="app-sidebar__health-stack">
      {/* LCU Health */}
      <div className="app-sidebar__health-card">
        <div className="app-sidebar__health-head">
          <span className={`app-sidebar__health-icon ${health?.connected ? 'is-live' : ''}`}>
            {health?.connected ? <Wifi /> : <WifiOff />}
          </span>
          <div className="app-sidebar__health-copy">
            <strong>{health?.connected ? 'League connected' : 'Client unavailable'}</strong>
            <small>{health?.connected ? 'Local client link' : 'Launch League to reconnect'}</small>
          </div>
          {health?.connected && <span className="app-sidebar__health-state" style={{ color: performance.color }}>{performance.label}</span>}
          <button type="button" onClick={() => void refresh(true)} disabled={loading} className="app-sidebar__health-refresh" aria-label="Refresh League connection" title="Refresh League connection">
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        {health?.connected && (
          <div className="app-sidebar__health-metrics">
            <span><small>Latency</small><strong style={{ color: latencyColor(health.latencyMs) }}>{health.latencyMs > 0 ? `${health.latencyMs}ms` : '—'}</strong></span>
            <span><small>Uptime</small><strong>{health.uptime > 0 ? formatUptime(health.uptime) : '—'}</strong></span>
            <span><small>CPU</small><strong>{health.cpuPercent > 0 ? `${health.cpuPercent.toFixed(1)}%` : '—'}</strong></span>
            <span><small>Memory</small><strong>{health.memoryMB > 0 ? `${health.memoryMB}MB` : '—'}</strong></span>
          </div>
        )}
      </div>

      {latencyHistory.length > 1 && (
        <div className="app-sidebar__latency-card">
          <div className="app-sidebar__latency-head">
            <span>LCU latency history</span>
            <strong style={{ color: latencyColor(latencyHistory[latencyHistory.length - 1]) }}>{latencyHistory[latencyHistory.length - 1]}ms</strong>
          </div>
          <div className="app-sidebar__latency-bars" aria-label="LCU latency history">
            {latencyHistory.map((value, index) => <span key={`${value}-${index}`} style={{ height: `${Math.max(15, Math.min(100, value / 2))}%`, background: latencyColor(value), opacity: index === latencyHistory.length - 1 ? 1 : .55 }} />)}
          </div>
        </div>
      )}

      {/* Server status */}
      {serverStatus.length > 0 && (
        <div className="app-sidebar__server-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
            <Server size={11} color="#6a6a88" />
            <span style={{ fontSize: 10, fontWeight: 600, color: '#a0a0b8' }}>Server status</span>
          </div>
          {serverStatus.slice(0, 4).map((s, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 10 }}>
              <span style={{ color: '#a0a0b8' }}>{s.server_name || `Server ${i + 1}`}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor(s.status), display: 'inline-block' }} />
                <span style={{ color: statusColor(s.status), fontSize: 9 }}>{s.status}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
