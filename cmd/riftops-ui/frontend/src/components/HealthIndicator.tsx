import { useCallback, useEffect, useState } from 'react';
import { Activity, Clock, Cpu, RefreshCw, Server, Wifi, WifiOff } from 'lucide-react';
import { fetchLCUHealth, fetchServerStatus, type LCUHealth, type ServerStatusItem } from '../api';

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

export default function HealthIndicator() {
  const [health, setHealth] = useState<LCUHealth | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatusItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [h, s] = await Promise.all([
        fetchLCUHealth().catch(() => ({ connected: false, latencyMs: 0, uptime: 0, memoryMB: 0 })),
        fetchServerStatus('NA').catch(() => []),
      ]);
      setHealth(h);
      setServerStatus(Array.isArray(s) ? s : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* LCU Health */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.035)' }}>
        {health?.connected ? <Wifi size={14} color="#10b981" /> : <WifiOff size={14} color="#6a6a88" />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#d4d4d0' }}>
            {health?.connected ? 'League connected' : 'Client unavailable'}
          </div>
          {health?.connected && (
            <div style={{ display: 'flex', gap: 12, marginTop: 2, fontSize: 9, color: '#6a6a88' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <Activity size={9} color={latencyColor(health.latencyMs)} />
                <span style={{ color: latencyColor(health.latencyMs) }}>{health.latencyMs}ms</span>
              </span>
              {health.uptime > 0 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Clock size={9} />
                  {formatUptime(health.uptime)}
                </span>
              )}
              {health.memoryMB > 0 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Cpu size={9} />
                  {health.memoryMB}MB
                </span>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6a6a88', padding: 4 }}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Server status */}
      {serverStatus.length > 0 && (
        <div style={{ padding: '6px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.025)' }}>
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
