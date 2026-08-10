import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getLCUStatus, fetchLCUProfile, fetchDDragonVersion, ddProfileIcon, launchLCULeague,
  type LCUProfile, type LCULeagueEntry
} from '../api';
import { Medal, Loader2, AlertTriangle, Gamepad2, Rocket, RefreshCw } from 'lucide-react';
import { useLCUConnection } from './lcuConnectionContext';

export default function RiotPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lcuConnected, setLcuConnected] = useState<boolean>(false);
  const [leagueReady, setLeagueReady] = useState(false);
  const [profile, setProfile] = useState<LCUProfile | null>(null);
  const [ddVer, setDdVer] = useState<string>('');
  const [launching, setLaunching] = useState(false);
  const [launchStep, setLaunchStep] = useState('');
  const { pageVisible, performanceMode } = useLCUConnection();
  const initialized = useRef(false);

  const checkStatus = useCallback(async () => {
    if (!pageVisible) return;
    if (!initialized.current) setLoading(true);
    setError(null);
    try {
      const status = await getLCUStatus();
      setLcuConnected(status.connected);
      setLeagueReady(status.leagueReady || false);

      if (!status.connected) {
        setLoading(false);
        return;
      }

      fetchDDragonVersion().then(v => setDdVer(v.version)).catch(() => {});

      try {
        const prof = await fetchLCUProfile();
        if (prof && prof.summoner) {
          setProfile(prof);
          setLeagueReady(true);
          setLoading(false);
          return;
        }
      } catch {
        // League endpoints not ready yet
      }

      if (!status.leagueReady) {
        setLoading(false);
        return;
      }

    } catch (e: any) {
      setError(e.message || 'Failed to connect to local client');
    } finally {
      initialized.current = true;
      setLoading(false);
    }
  }, [pageVisible]);

  useEffect(() => {
    void checkStatus();
    if (!pageVisible) return undefined;
    const interval = performanceMode === 'fast' ? 10000 : performanceMode === 'quiet' ? 45000 : 15000;
    const timer = window.setInterval(() => void checkStatus(), interval);
    return () => window.clearInterval(timer);
  }, [checkStatus, pageVisible, performanceMode]);

  const handleLaunch = async () => {
    setLaunching(true);
    setError(null);
    try {
      setLaunchStep('Starting Riot Client');
      await launchLCULeague();
      for (let i = 0; i < 15; i++) {
        setLaunchStep(i < 5 ? 'Waiting for Riot Client' : i < 10 ? 'Waiting for League Client' : 'Checking League API');
        await new Promise(r => setTimeout(r, 1200));
        const status = await getLCUStatus();
        if (status.connected && status.leagueReady) {
          setLaunchStep('League is ready');
          await checkStatus();
          setLaunching(false);
          return;
        }
      }
      await checkStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to launch League of Legends');
    } finally {
      setLaunching(false);
      window.setTimeout(() => setLaunchStep(''), 1800);
    }
  };

  // ── Loading state ──
  if (loading) {
    return (
      <div className="glass-card p-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-xs text-text-muted">Connecting to local League client...</span>
        </div>
      </div>
    );
  }

  // ── Standby state: Neither Riot Client nor League is running ──
  if (!lcuConnected) {
    return (
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Medal className="w-4.5 h-4.5 text-primary" />
            <span className="text-sm font-black text-white">Riot Account & Summoner Data</span>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.04] text-text-dim font-bold">Offline</span>
        </div>

        <div className="space-y-1.5 border-l-2 border-primary/40 pl-3">
          <h4 className="text-xs font-bold text-white">Launch League of Legends to view your account</h4>
          <p className="text-xs text-text-dim leading-relaxed">
            Connect your Riot account automatically. Your rank, level, match statistics, and champion masteries will appear here live.
          </p>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleLaunch}
            disabled={launching}
            className="btn-primary flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs"
          >
            {launching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
            <span>{launching ? (launchStep || 'Launching League of Legends...') : 'Launch League of Legends'}</span>
          </button>
          <button
            onClick={() => void checkStatus()}
            title="Check connection again"
            className="px-3.5 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-text-muted hover:text-white text-xs font-bold border border-white/[0.06] transition cursor-pointer flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Check</span>
          </button>
        </div>

        <div className="space-y-2 pt-2 border-t border-white/[0.04]">
          <span className="text-[11px] text-text-dim/80 font-bold block">Quick Steps:</span>
          <div className="space-y-1.5 text-xs text-text-dim">
            <div className="flex items-start gap-2">
              <span className="w-4 h-4 rounded bg-primary/10 text-primary flex items-center justify-center font-bold text-[8px] shrink-0 mt-px">1</span>
              <span>Click <strong>Launch League of Legends</strong> above or open Riot Client.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-4 h-4 rounded bg-primary/10 text-primary flex items-center justify-center font-bold text-[8px] shrink-0 mt-px">2</span>
              <span>Sign in with your Riot Account.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-4 h-4 rounded bg-primary/10 text-primary flex items-center justify-center font-bold text-[8px] shrink-0 mt-px">3</span>
              <span>Your summoner level, rank, and top champions will display here live.</span>
            </div>
          </div>
        </div>

        {error && (
          <div className="text-xs text-danger flex items-center gap-1.5 pt-1">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
    );
  }

  // ── Riot Client connected, but League Client is not loaded yet ──
  if (lcuConnected && !leagueReady) {
    return (
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Medal className="w-4.5 h-4.5 text-primary" />
            <span className="text-sm font-black text-white">Riot Account</span>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/20 text-primary font-bold border border-primary/30">Riot Client Ready</span>
        </div>

        <div className="flex items-center gap-2">
          <Gamepad2 className="w-4 h-4 text-primary" />
          <p className="text-xs text-text-muted font-medium">
            Riot Client detected! Launch League of Legends to load your summoner profile and rank data.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleLaunch}
            disabled={launching}
            className="btn-primary flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs"
          >
            {launching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
            <span>{launching ? (launchStep || 'Launching League of Legends...') : 'Launch League of Legends'}</span>
          </button>
          <button
            onClick={() => void checkStatus()}
            className="px-3.5 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-text-muted hover:text-white text-xs font-bold border border-white/[0.06] transition cursor-pointer flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Check</span>
          </button>
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (error) {
    return (
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400" />
          <span className="text-xs text-text-muted font-bold">Connection Error</span>
        </div>
        <p className="text-xs text-text-dim">{error}</p>
        <button
          onClick={() => void checkStatus()}
          className="text-xs text-primary hover:underline font-bold cursor-pointer"
        >
          Retry Connection
        </button>
      </div>
    );
  }

  // ── LCU connected — show data ──
  const summoner = profile?.summoner;
  if (!summoner) {
    return (
      <div className="glass-card p-4 flex items-center justify-between">
        <p className="text-xs text-text-dim">No summoner data available yet.</p>
        <button onClick={() => void checkStatus()} className="text-xs text-primary font-bold hover:underline cursor-pointer">Refresh</button>
      </div>
    );
  }

  const rankSolo = profile?.league?.find(e => e.queueType === 'RANKED_SOLO_5x5' || e.queueType?.includes('SOLO'));
  const rankFlex = profile?.league?.find(e => e.queueType === 'RANKED_FLEX_SR' || e.queueType?.includes('FLEX'));

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Medal className="w-4 h-4 text-primary" />
          <span className="text-xs text-text-muted font-bold">Riot Account</span>
          <span className="text-[9px] px-2 py-0.5 rounded bg-primary/20 text-primary font-bold border border-primary/30">LCU LIVE</span>
        </div>
        <button onClick={() => void checkStatus()} title="Refresh profile" className="text-text-dim hover:text-white transition cursor-pointer">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-3">
        {ddVer && (
          <img
            src={ddProfileIcon(ddVer, summoner.profileIconId)}
            alt=""
            className="w-12 h-12 rounded-full border-2 border-primary/40 bg-surface shadow-[0_0_12px_rgba(200,170,110,0.25)]"
          />
        )}
        <div>
          <p className="text-sm font-black text-white">{summoner.gameName || summoner.displayName}{summoner.gameName && summoner.tagLine ? `#${summoner.tagLine}` : ''}</p>
          <p className="text-xs text-text-dim font-medium">
            Level {summoner.summonerLevel}
            {summoner.percentCompleteForNext > 0 && summoner.percentCompleteForNext < 100 && (
              <span className="ml-1 text-text-dim/80">· {summoner.percentCompleteForNext}% to Lvl {summoner.summonerLevel + 1}</span>
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {rankSolo && <RankCard entry={rankSolo} label="Solo/Duo" />}
        {rankFlex && <RankCard entry={rankFlex} label="Flex" />}
        {!rankSolo && !rankFlex && (
          <div className="col-span-2 text-xs text-text-dim text-center py-3 bg-white/[0.02] rounded-xl border border-white/[0.04] font-medium">
            Unranked / No ranked matches played this season
          </div>
        )}
      </div>

      {profile?.mastery && profile.mastery.length > 0 && (
        <div className="pt-2 border-t border-white/[0.04]">
          <p className="text-xs text-text-muted font-bold mb-2">Top Champions Mastery</p>
          <div className="grid grid-cols-3 gap-2">
            {profile.mastery.slice(0, 6).map((m) => (
              <div key={m.championId} className="bg-white/[0.03] rounded-xl p-2.5 text-center border border-white/[0.06] hover:border-primary/30 transition">
                <p className="text-xs text-white font-black">Level {m.championLevel}</p>
                <p className="text-[10px] text-text-muted font-bold mt-0.5">{m.championPoints.toLocaleString()} pts</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RankCard({ entry, label }: { entry: LCULeagueEntry; label: string }) {
  const winrate = entry.wins + entry.losses > 0
    ? Math.round((entry.wins / (entry.wins + entry.losses)) * 100)
    : 0;

  const tierName = entry.tier ? entry.tier.charAt(0) + entry.tier.slice(1).toLowerCase() : 'Unranked';
  const rankDivision = entry.rank || entry.division || '';

  return (
    <div className="bg-white/[0.03] rounded-xl p-3 border border-white/[0.06] hover:border-primary/30 transition space-y-1">
      <p className="text-[10px] text-primary font-bold uppercase tracking-wider">{label}</p>
      <p className="text-xs font-black text-white capitalize">{tierName} {rankDivision}</p>
      {entry.miniSeries ? (
        <p className="text-[10px] text-primary font-bold">
          Promos: {entry.miniSeries.progress.replaceAll('W', '✓').replaceAll('L', '✗').replaceAll('N', '—')}
        </p>
      ) : (
        <p className="text-[11px] text-text-muted font-semibold">{entry.leaguePoints} LP · {winrate}% WR</p>
      )}
      <p className="text-[10px] text-text-dim font-medium">{entry.wins}W {entry.losses}L</p>
    </div>
  );
}
