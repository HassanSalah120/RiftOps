import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Shield } from 'lucide-react';
import { ddProfileIcon, fetchDDragonVersion, fetchLCUProfile, type LCUProfile } from '../api';
import { useLCUConnection } from './lcuConnectionContext';

function rankedEntry(profile: LCUProfile | null) {
  return profile?.league?.find((item) => item.queueType === 'RANKED_SOLO_5x5')
    || profile?.league?.find((item) => item.queueType === 'RANKED_FLEX_SR')
    || profile?.league?.[0];
}

function rankLabel(profile: LCUProfile | null): string {
  const entry = rankedEntry(profile);
  if (!entry?.tier) return 'Unranked';
  const tier = entry.tier.charAt(0) + entry.tier.slice(1).toLowerCase();
  return `${tier} ${entry.rank || entry.division || ''}`.trim();
}

export default function AccountSummary() {
  const { connected, pageVisible, performanceMode } = useLCUConnection();
  const [profile, setProfile] = useState<LCUProfile | null>(null);
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!connected || !pageVisible) {
      setProfile(null);
      return;
    }
    setLoading(true);
    try {
      const [nextProfile, nextVersion] = await Promise.all([
        fetchLCUProfile(),
        version ? Promise.resolve({ version }) : fetchDDragonVersion(),
      ]);
      setProfile(nextProfile);
      if (nextVersion.version) setVersion(nextVersion.version);
    } catch {
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [connected, pageVisible, version]);

  useEffect(() => {
    void refresh();
    if (!connected || !pageVisible) return undefined;
    const interval = performanceMode === 'fast' ? 20_000 : performanceMode === 'quiet' ? 90_000 : 45_000;
    const timer = window.setInterval(() => void refresh(), interval);
    return () => window.clearInterval(timer);
  }, [connected, pageVisible, performanceMode, refresh]);

  const summoner = profile?.summoner;
  const riotID = useMemo(() => {
    if (!summoner) return 'Summoner unavailable';
    const name = summoner.gameName || summoner.displayName || 'League account';
    return summoner.tagLine ? `${name}#${summoner.tagLine}` : name;
  }, [summoner]);
  const rank = rankedEntry(profile);

  return (
    <section className={`summoner-plate ${connected ? 'is-connected' : ''}`} aria-label="League account summary">
      <div className="summoner-plate__avatar">
        {summoner && version ? (
          <img src={ddProfileIcon(version, summoner.profileIconId)} alt="" width="48" height="48" />
        ) : (
          <Shield />
        )}
        <span />
      </div>
      <div className="summoner-plate__identity">
        <small>{connected ? 'CURRENT SUMMONER' : 'LEAGUE ACCOUNT'}</small>
        <strong>{riotID}</strong>
        <span>{summoner ? `Level ${summoner.summonerLevel}` : 'Launch League to load your profile'}</span>
      </div>
      <div className="summoner-plate__rank">
        <small>SOLO / FLEX</small>
        <strong>{rankLabel(profile)}</strong>
        <span>{rank?.leaguePoints != null ? `${rank.leaguePoints} LP` : 'No ranked data'}</span>
      </div>
      <button type="button" onClick={() => void refresh()} disabled={!connected || loading} aria-label="Refresh account summary" title="Refresh account summary">
        <RefreshCw className={loading ? 'animate-spin' : ''} />
      </button>
    </section>
  );
}
