import { useState, useEffect } from 'react';
import {
  CheckCircle2, Clock3, AlertTriangle, XCircle, Swords,
  RefreshCw, History, Shield, Eye, Lock, Zap, Info
} from 'lucide-react';
import type { DraftEventsSnapshot } from '../types';
import { fetchPlayFlowDraftEvents, ddChampionIcon } from '../api';
import type { DDChampion } from '../api';

interface DraftExecutionMonitorProps {
  champions?: Record<number, DDChampion>;
  version?: string;
  className?: string;
}

export function DraftExecutionMonitor({
  champions = {},
  version = '',
  className = '',
}: DraftExecutionMonitorProps) {
  const [snapshot, setSnapshot] = useState<DraftEventsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'live' | 'history'>('live');

  const loadEvents = async () => {
    try {
      setLoading(true);
      const data = await fetchPlayFlowDraftEvents();
      setSnapshot(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load draft events');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEvents();
    const interval = setInterval(loadEvents, 1000);
    return () => clearInterval(interval);
  }, []);

  const liveEvents = snapshot?.events || [];
  const archivedEvents = snapshot?.archivedEvents || [];
  const displayedEvents = activeTab === 'live' ? liveEvents : archivedEvents;

  // Find latest active event
  const latestEvent = liveEvents.length > 0 ? liveEvents[liveEvents.length - 1] : null;

  const getChampion = (id?: number) => {
    if (!id || id <= 0) return null;
    return champions[id] || null;
  };

  const formatEventType = (type: string) => {
    switch (type) {
      case 'action-detected': return { label: 'Action Detected', icon: Eye, color: 'text-purple-400', badge: 'bg-purple-950/60 border-purple-500/30 text-purple-300' };
      case 'candidate-selected': return { label: 'Candidate Chosen', icon: Zap, color: 'text-blue-400', badge: 'bg-blue-950/60 border-blue-500/30 text-blue-300' };
      case 'hover-attempt': return { label: 'Hovering…', icon: Eye, color: 'text-cyan-400', badge: 'bg-cyan-950/60 border-cyan-500/30 text-cyan-300' };
      case 'hover-confirmed': return { label: 'Hover Confirmed', icon: CheckCircle2, color: 'text-teal-400', badge: 'bg-teal-950/60 border-teal-500/30 text-teal-300' };
      case 'lock-attempt': return { label: 'Submitting Lock…', icon: Lock, color: 'text-amber-400', badge: 'bg-amber-950/60 border-amber-500/30 text-amber-300' };
      case 'lock-confirmed': return { label: 'Lock Confirmed', icon: CheckCircle2, color: 'text-emerald-400', badge: 'bg-emerald-950/60 border-emerald-500/30 text-emerald-300' };
      case 'manual-intervention': return { label: 'Manual Override', icon: AlertTriangle, color: 'text-amber-500', badge: 'bg-amber-950/60 border-amber-500/30 text-amber-300' };
      case 'confirmation-timeout': return { label: 'Lock Timeout', icon: Clock3, color: 'text-red-400', badge: 'bg-red-950/60 border-red-500/30 text-red-300' };
      case 'failed-or-blocked': return { label: 'Mutation Blocked', icon: XCircle, color: 'text-rose-400', badge: 'bg-rose-950/60 border-rose-500/30 text-rose-300' };
      default: return { label: type, icon: Info, color: 'text-zinc-400', badge: 'bg-zinc-800 border-zinc-700 text-zinc-300' };
    }
  };

  const formatTimestamp = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
        '.' + String(d.getMilliseconds()).padStart(3, '0');
    } catch {
      return iso;
    }
  };

  return (
    <div className={`p-5 rounded-2xl border border-white/10 bg-gradient-to-b from-dark-card/90 to-dark-bg/95 backdrop-blur-md shadow-2xl space-y-4 ${className}`}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-hextech-gold/10 border border-hextech-gold/30 flex items-center justify-center text-hextech-gold">
            <Swords size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white tracking-wide">Draft Execution Monitor</h3>
              <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-emerald-950/80 border border-emerald-500/30 text-emerald-300 uppercase tracking-wider">
                Confirmed Invariants
              </span>
            </div>
            <p className="text-[11px] text-text-dim mt-0.5">
              Live pick &amp; ban diagnostic pipeline and verified LCU state transitions
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-black/40 border border-white/10 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab('live')}
              className={`px-3 py-1 rounded-md font-medium transition cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'live' ? 'bg-primary/20 text-primary border border-primary/30' : 'text-text-muted hover:text-white'
              }`}
            >
              <Zap size={13} />
              <span>Live Run</span>
              {liveEvents.length > 0 && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`px-3 py-1 rounded-md font-medium transition cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'history' ? 'bg-primary/20 text-primary border border-primary/30' : 'text-text-muted hover:text-white'
              }`}
            >
              <History size={13} />
              <span>History</span>
              {archivedEvents.length > 0 && (
                <span className="text-[10px] px-1 rounded bg-white/10 text-text-dim">
                  {archivedEvents.length}
                </span>
              )}
            </button>
          </div>

          <button
            type="button"
            onClick={loadEvents}
            disabled={loading}
            className="p-1.5 rounded-lg border border-white/10 bg-white/5 text-text-muted hover:text-white hover:border-white/20 transition cursor-pointer"
            title="Refresh events"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-950/30 border border-red-500/20 text-xs text-red-300 flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0 text-red-400" />
          <span>{error}</span>
        </div>
      )}

      {/* Latest Execution Card */}
      {latestEvent && activeTab === 'live' && (
        <div className="p-4 rounded-xl bg-white/[0.03] border border-white/10 relative overflow-hidden">
          <div className="absolute top-0 left-0 bottom-0 w-1 bg-gradient-to-b from-primary to-emerald-400" />
          
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              {(() => {
                const champ = getChampion(latestEvent.championId);
                return (
                  <div className="relative w-11 h-11 rounded-xl bg-black/60 border border-white/20 overflow-hidden flex items-center justify-center shrink-0">
                    {champ && version ? (
                      <img
                        src={ddChampionIcon(version, champ.id)}
                        alt={champ.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Shield size={20} className="text-text-dim" />
                    )}
                    <span className="absolute bottom-0 right-0 px-1 py-0.2 bg-black/80 text-[8px] font-black uppercase text-amber-300 rounded-tl">
                      {latestEvent.actionType || 'PICK'}
                    </span>
                  </div>
                );
              })()}

              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white">
                    {getChampion(latestEvent.championId)?.name || (latestEvent.championId ? `Champion ${latestEvent.championId}` : 'No Champion')}
                  </span>
                  {(() => {
                    const meta = formatEventType(latestEvent.type);
                    const Icon = meta.icon;
                    return (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${meta.badge}`}>
                        <Icon size={11} />
                        {meta.label}
                      </span>
                    );
                  })()}
                </div>
                <p className="text-[11px] text-text-muted mt-0.5 flex items-center gap-2">
                  <span>Phase: <strong className="text-white/80">{latestEvent.phase || 'BAN_PICK'}</strong></span>
                  {latestEvent.timerRemainingMs !== undefined && latestEvent.timerRemainingMs > 0 && (
                    <span>· Timer: <strong className="text-cyan-300">{Math.round(latestEvent.timerRemainingMs / 1000)}s</strong></span>
                  )}
                  {latestEvent.durationMs !== undefined && latestEvent.durationMs > 0 && (
                    <span>· Roundtrip: <strong className="text-text">{latestEvent.durationMs}ms</strong></span>
                  )}
                </p>
              </div>
            </div>

            <div className="text-right">
              <span className="text-[10px] text-text-dim uppercase font-semibold tracking-wider block">Last Status</span>
              <span className={`text-xs font-bold ${latestEvent.outcome === 'confirmed' ? 'text-emerald-400' : latestEvent.outcome === 'error' || latestEvent.outcome === 'failed' ? 'text-rose-400' : 'text-cyan-400'}`}>
                {latestEvent.reason || latestEvent.outcome}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Events Table / List */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-text-dim px-2 py-1">
          <span>{activeTab === 'live' ? 'Live Session Audit Log' : 'Archived Draft Log'}</span>
          <span>{displayedEvents.length} Recorded Events</span>
        </div>

        {displayedEvents.length === 0 ? (
          <div className="p-8 rounded-xl border border-dashed border-white/10 bg-black/20 text-center space-y-2">
            <Swords size={28} className="mx-auto text-text-dim/60" />
            <h4 className="text-xs font-bold text-white">No draft diagnostics recorded yet</h4>
            <p className="text-[11px] text-text-dim max-w-sm mx-auto">
              Draft events stream here automatically during Champion Select. Candidate selection, hover submissions, locks, timing countdowns, and manual overrides are tracked live.
            </p>
          </div>
        ) : (
          <div className="max-h-[320px] overflow-y-auto space-y-1.5 pr-1 focus:outline-none" tabIndex={0} role="region" aria-label="Draft Events Log">
            {displayedEvents.slice().reverse().map((event, idx) => {
              const meta = formatEventType(event.type);
              const Icon = meta.icon;
              const champ = getChampion(event.championId);

              return (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="font-mono text-[10px] text-text-dim shrink-0">
                      {formatTimestamp(event.timestamp)}
                    </span>

                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border shrink-0 ${meta.badge}`}>
                      <Icon size={11} />
                      {meta.label}
                    </span>

                    <div className="truncate flex items-center gap-1.5">
                      {champ ? (
                        <span className="text-white font-medium truncate">{champ.name}</span>
                      ) : event.championId ? (
                        <span className="text-white/80 font-mono text-[11px]">#{event.championId}</span>
                      ) : null}

                      {event.reason && (
                        <span className="text-text-dim text-[11px] truncate">
                          — {event.reason}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 text-right">
                    {event.durationMs !== undefined && event.durationMs > 0 && (
                      <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/40 px-1.5 py-0.5 rounded border border-cyan-500/20">
                        {event.durationMs}ms
                      </span>
                    )}

                    <span className={`text-[10px] font-bold uppercase tracking-wider ${
                      event.outcome === 'confirmed' ? 'text-emerald-400' :
                      event.outcome === 'failed' || event.outcome === 'error' || event.outcome === 'timeout' ? 'text-rose-400' :
                      event.outcome === 'manual_override' ? 'text-amber-400' : 'text-cyan-400'
                    }`}>
                      {event.outcome}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {snapshot?.lastConfirmedAt && (
        <div className="pt-2 border-t border-white/5 flex items-center justify-between text-[11px] text-text-dim">
          <span>Last verified client lock:</span>
          <span className="font-mono text-white/80">
            {formatTimestamp(snapshot.lastConfirmedAt)}
          </span>
        </div>
      )}
    </div>
  );
}
