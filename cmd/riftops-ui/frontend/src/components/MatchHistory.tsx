import { useState, useEffect, useCallback } from 'react';
import { fetchLCUMatchHistory, fetchDDragonVersion, fetchLCUGameDetail } from '../api';
import { History, Loader2, RefreshCw, Trophy, Skull, Swords, Filter, ChevronDown, ChevronUp, Clock, Shield, Eye, Flame, Download } from 'lucide-react';

const QUEUE_MAP: Record<number, string> = {
  420: 'Ranked Solo',
  440: 'Ranked Flex',
  400: 'Normal Draft',
  430: 'Normal Blind',
  450: 'ARAM',
  1300: 'Swiftplay',
  1700: 'Arena',
};

const SPELL_ICONS: Record<number, { name: string; icon: string }> = {
  1: { name: 'Cleanse', icon: 'SummonerBoost' },
  3: { name: 'Exhaust', icon: 'SummonerExhaust' },
  4: { name: 'Flash', icon: 'SummonerFlash' },
  6: { name: 'Ghost', icon: 'SummonerGhost' },
  7: { name: 'Heal', icon: 'SummonerHeal' },
  11: { name: 'Smite', icon: 'SummonerSmite' },
  12: { name: 'Teleport', icon: 'SummonerTeleport' },
  14: { name: 'Ignite', icon: 'SummonerDot' },
  21: { name: 'Barrier', icon: 'SummonerBarrier' },
  32: { name: 'Snowball', icon: 'SummonerSnowball' },
  39: { name: 'Mark', icon: 'SummonerPoroRecall' },
};

const RUNE_TREES: Record<number, { name: string; img: string }> = {
  8000: { name: 'Precision', img: '7000_Precision' },
  8100: { name: 'Domination', img: '7100_Domination' },
  8200: { name: 'Sorcery', img: '7200_Sorcery' },
  8300: { name: 'Inspiration', img: '7300_Inspiration' },
  8400: { name: 'Resolve', img: '7400_Resolve' },
};

const TRINKET_IDS = new Set([3340, 3363, 3364, 2055, 3013]);

const PERIODS: Record<string, { label: string; ms: number }> = {
  all: { label: 'All Time', ms: 0 },
  day: { label: '24 Hours', ms: 86_400_000 },
  week: { label: '7 Days', ms: 604_800_000 },
  month: { label: '30 Days', ms: 2_592_000_000 },
};

function getRuneTreeId(s: any): { primary: number; secondary: number } {
  let primary = s?.perkStyle || s?.perkPrimaryStyle || s?.perk0Style || s?.perks?.perkStyle || s?.perkStyleId || 0;
  let secondary = s?.perkSubStyle || s?.perkSubStyleId || s?.perks?.perkSubStyle || 0;

  const keystone = s?.perk0 || s?.perks?.perk0 || s?.perkPrimaryStyle || 0;
  if (!primary && keystone) {
    if (keystone >= 8000 && keystone < 8100) primary = 8000;
    else if (keystone >= 8100 && keystone < 8200) primary = 8100;
    else if (keystone >= 8200 && keystone < 8300) primary = 8200;
    else if (keystone >= 8300 && keystone < 8400) primary = 8300;
    else if (keystone >= 8400 && keystone < 8500) primary = 8400;
  }

  return { primary, secondary };
}

export default function MatchHistory() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<any[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [gameDetails, setGameDetails] = useState<Record<number, any>>({});
  const [loadingDetail, setLoadingDetail] = useState<number | null>(null);
  const [queueFilter, setQueueFilter] = useState<number | 'all'>(() => {
    try { return JSON.parse(localStorage.getItem('riftops.history.queue') || '"all"'); } catch { return 'all'; }
  });
  const [periodFilter, setPeriodFilter] = useState<string>(() => localStorage.getItem('riftops.history.period') || 'all');
  const [gameCount, setGameCount] = useState<number>(() => Number(localStorage.getItem('riftops.history.count') || 50));
  const [ddVer, setDdVer] = useState('15.1.1');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch version first so all images use the correct patch
      const vData = await fetchDDragonVersion().catch(() => null);
      if (vData?.version) setDdVer(vData.version);

      const data = await fetchLCUMatchHistory();
      if (data && data.games && data.games.games) {
        setMatches(data.games.games);
      } else if (Array.isArray(data)) {
        setMatches(data);
      } else {
        setMatches([]);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch match history — launch League first.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    try {
      localStorage.setItem('riftops.history.queue', JSON.stringify(queueFilter));
      localStorage.setItem('riftops.history.period', periodFilter);
      localStorage.setItem('riftops.history.count', String(gameCount));
    } catch { /* Optional preference. */ }
  }, [queueFilter, periodFilter, gameCount]);

  const handleExpand = useCallback(async (gameId: number) => {
    if (expandedId === gameId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(gameId);
    if (gameDetails[gameId]) return; // already fetched
    setLoadingDetail(gameId);
    try {
      let detail = await fetchLCUGameDetail(gameId);
      // Normalize: some LCU versions wrap response in a root key
      if (detail && !detail.participants && detail.gameId) {
        // already flat
      } else if (detail && !detail.participants) {
        // try common wrapper keys
        detail = detail.games?.games?.[0] ?? detail.game ?? detail.games ?? detail;
      }
      // Log first participant keys for debugging name resolution
      if (detail?.participants?.[0]) {
        console.debug('[RiftOps] gameDetail participant keys:', Object.keys(detail.participants[0]));
        console.debug('[RiftOps] gameDetail identities:', detail.participantIdentities?.slice(0, 2));
      }
      setGameDetails((prev) => ({ ...prev, [gameId]: detail }));
    } catch {
      // detail fetch failed, scoreboard will show summary data only
    } finally {
      setLoadingDetail(null);
    }
  }, [expandedId, gameDetails]);

  // Robust timestamp parser for LCU games
  const getMatchTimestamp = (g: any): number => {
    const raw = g?.gameCreation ?? g?.gameCreationDate ?? g?.gameBeginDate ?? g?.gameStartTime ?? g?.gameStartTimestamp;
    if (raw == null || raw === '') return 0;
    if (typeof raw === 'number') {
      return raw > 0 && raw < 1_000_000_000_000 ? raw * 1000 : raw;
    }
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  // Filter matches by queue and period FIRST, then limit by gameCount
  const now = Date.now();
  const filteredMatches = matches
    .filter((g) => {
      if (queueFilter !== 'all' && g.queueId !== queueFilter) return false;
      if (periodFilter !== 'all') {
        const period = PERIODS[periodFilter];
        const matchTime = getMatchTimestamp(g);
        if (period.ms && matchTime && matchTime < now - period.ms) return false;
      }
      return true;
    })
    .slice(0, gameCount);

  // Calculate summary stats & streak
  let wins = 0;
  let totalKills = 0;
  let totalDeaths = 0;
  let totalAssists = 0;
  let totalDmg = 0;
  let totalCs = 0;
  let totalGold = 0;
  let totalVis = 0;
  let streak = 0;
  let streakDirection = 0;

  filteredMatches.forEach((m) => {
    const p = m.participants?.[0] || m.participantIdentities?.[0] || {};
    const s = p.stats || m.stats || {};
    const isWin = !!(s.win || s.winner);
    if (isWin) wins++;

    totalKills += s.kills || 0;
    totalDeaths += s.deaths || 0;
    totalAssists += s.assists || 0;
    totalDmg += s.totalDamageDealtToChampions || 0;
    totalGold += s.goldEarned || 0;
    totalVis += s.visionScore || 0;
    totalCs += (s.totalMinionsKilled || 0) + (s.neutralMinionsKilled || 0);

    // Calculate streak
    if (streakDirection === 0) {
      streakDirection = isWin ? 1 : -1;
      streak = 1;
    } else if ((isWin && streakDirection > 0) || (!isWin && streakDirection < 0)) {
      streak++;
    }
  });

  const totalGames = filteredMatches.length;
  const wrPct = totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0;
  const avgKda = totalDeaths > 0 ? ((totalKills + totalAssists) / totalDeaths).toFixed(2) : 'Perfect';
  const avgDmg = totalGames > 0 ? Math.round(totalDmg / totalGames) : 0;
  const avgGold = totalGames > 0 ? Math.round(totalGold / totalGames) : 0;
  const avgVis = totalGames > 0 ? (totalVis / totalGames).toFixed(1) : '0';
  const streakText = streakDirection > 0 ? `W${streak}` : streakDirection < 0 ? `L${streak}` : '-';
  const trend = filteredMatches.slice(0, 12).reverse().map((match) => {
    const participant = match.participants?.[0] || match.participantIdentities?.[0] || {};
    const stats = participant.stats || match.stats || {};
    return Boolean(stats.win || stats.winner);
  });
  const exportMatches = () => {
    const rows = filteredMatches.map((match) => {
      const participant = match.participants?.[0] || match.participantIdentities?.[0] || {};
      const stats = participant.stats || match.stats || {};
      return [match.gameId || '', QUEUE_MAP[match.queueId] || match.gameMode || '', stats.win || stats.winner ? 'Victory' : 'Defeat', stats.kills || 0, stats.deaths || 0, stats.assists || 0, match.gameDuration || 0].join(',');
    });
    const csv = ['game_id,queue,result,kills,deaths,assists,duration_seconds', ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `riftops-match-history-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-primary" />
          <h2 className="text-base font-black text-white">Match History</h2>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
            {filteredMatches.length} Matches
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportMatches}
            disabled={loading || filteredMatches.length === 0}
            className="p-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-text-muted hover:text-white transition cursor-pointer border border-white/[0.06] disabled:opacity-30"
            title="Export filtered matches"
          >
            <Download className="w-4 h-4" />
          </button>
          {/* Game count dropdown */}
          <select
            value={gameCount}
            onChange={(e) => setGameCount(Number(e.target.value))}
            className="text-xs bg-surface/80 border border-white/10 text-white font-bold rounded-xl px-2 py-1 cursor-pointer"
          >
            <option value={20}>20 Games</option>
            <option value={50}>50 Games</option>
            <option value={100}>100 Games</option>
          </select>

          <button
            onClick={() => void loadData()}
            disabled={loading}
            className="p-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-text-muted hover:text-white transition cursor-pointer border border-white/[0.06]"
            title="Refresh Match History"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Summary Statistics Bar */}
      {!loading && !error && filteredMatches.length > 0 && (
        <div className="glass-card p-4 space-y-2">
          <div className="grid grid-cols-6 gap-2 text-center">
            <div>
              <p className="text-[10px] text-text-dim font-bold uppercase">Winrate</p>
              <p className="text-base font-black text-white">{wrPct}% <span className="text-xs text-text-muted font-bold">({wins}W {totalGames - wins}L)</span></p>
            </div>
            <div>
              <p className="text-[10px] text-text-dim font-bold uppercase">Avg KDA</p>
              <p className="text-base font-black text-primary">{avgKda}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-dim font-bold uppercase">Streak</p>
              <p className={`text-base font-black ${streakDirection > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{streakText}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-dim font-bold uppercase">Avg Damage</p>
              <p className="text-base font-black text-amber-400">{avgDmg.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-dim font-bold uppercase">Avg Gold</p>
              <p className="text-base font-black text-yellow-400">{avgGold.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-dim font-bold uppercase">Avg Vision</p>
              <p className="text-base font-black text-cyan-400">{avgVis}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 pt-2 border-t border-white/[0.05]">
            <span className="text-[10px] text-text-dim font-bold uppercase shrink-0">Recent trend</span>
            <div className="flex items-end gap-1 h-5 flex-1">
              {trend.map((win, index) => <span key={index} title={win ? 'Victory' : 'Defeat'} className={`flex-1 max-w-5 rounded-sm ${win ? 'bg-emerald-400' : 'bg-rose-400'}`} style={{ height: win ? '100%' : '58%' }} />)}
            </div>
            <span className="text-[9px] text-text-dim">oldest → newest</span>
          </div>
        </div>
      )}

      {/* Filter Toolbar */}
      <div className="flex items-center justify-between gap-2 overflow-x-auto pb-1">
        {/* Queue Filters */}
        <div className="flex items-center gap-1 shrink-0">
          <Filter className="w-3.5 h-3.5 text-primary mr-1" />
          {[
            { id: 'all', label: 'All Modes' },
            { id: 420, label: 'Ranked Solo' },
            { id: 440, label: 'Ranked Flex' },
            { id: 450, label: 'ARAM' },
            { id: 400, label: 'Draft' },
          ].map((q) => (
            <button
              key={q.id.toString()}
              onClick={() => setQueueFilter(q.id as any)}
              className={`px-2.5 py-1 rounded-xl text-xs font-bold transition shrink-0 border cursor-pointer ${
                queueFilter === q.id
                  ? 'bg-primary/20 text-primary border-primary/40 shadow-[0_0_12px_rgba(200,170,110,0.25)]'
                  : 'text-text-dim border-white/[0.06] hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              {q.label}
            </button>
          ))}
        </div>

        {/* Period Filters */}
        <div className="flex items-center gap-1 shrink-0">
          <Clock className="w-3.5 h-3.5 text-text-dim mr-1" />
          {Object.entries(PERIODS).map(([k, p]) => (
            <button
              key={k}
              onClick={() => setPeriodFilter(k)}
              className={`px-2 py-1 rounded-xl text-[11px] font-bold transition shrink-0 border cursor-pointer ${
                periodFilter === k
                  ? 'bg-white/10 text-white border-white/20'
                  : 'text-text-dim border-transparent hover:text-white'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="glass-card p-8 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <span className="text-xs text-text-muted font-semibold">Loading match history from local LCU...</span>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="glass-card p-6 flex flex-col items-center justify-center gap-2 text-center">
          <Swords className="w-8 h-8 text-text-dim/40" />
          <p className="text-xs text-text-muted font-bold">{error}</p>
          <button
            onClick={() => void loadData()}
            className="text-xs text-primary font-bold hover:underline mt-1 cursor-pointer"
          >
            Retry Connection
          </button>
        </div>
      )}

      {/* Match Cards List */}
      {!loading && !error && (
        <div className="space-y-2.5">
          {filteredMatches.length === 0 ? (
            <div className="glass-card p-8 text-center text-text-dim space-y-1">
              <History className="w-8 h-8 opacity-20 mx-auto" />
              <p className="text-xs font-bold text-text-muted">No matches found for this filter</p>
            </div>
          ) : (
            filteredMatches.map((m: any, idx: number) => {
              const gameId = m.gameId || idx;
              const isExpanded = expandedId === gameId;
              const participant = m.participants?.[0] || m.participantIdentities?.[0] || {};
              const stats = participant.stats || m.stats || {};
              const isWin = !!(stats.win || stats.winner);
              const kills = stats.kills || 0;
              const deaths = stats.deaths || 0;
              const assists = stats.assists || 0;
              const kdaRatio = deaths === 0 ? 'Perfect' : ((kills + assists) / deaths).toFixed(2);
              const durationMins = Math.floor((m.gameDuration || 0) / 60);
              const durationSecs = (m.gameDuration || 0) % 60;
              const queueName = QUEUE_MAP[m.queueId] || m.gameMode || 'Normal';
              const champId = participant.championId || m.championId || 0;

              const spell1 = SPELL_ICONS[participant.spell1Id];
              const spell2 = SPELL_ICONS[participant.spell2Id];
              const { primary: primaryStyle, secondary: subStyle } = getRuneTreeId(stats);

              // Items build array
              const items = [
                stats.item0, stats.item1, stats.item2,
                stats.item3, stats.item4, stats.item5, stats.item6,
              ];

              // Damage Types Breakdown
              const dmgMagic = stats.magicDamageDealtToChampions || 0;
              const dmgPhys = stats.physicalDamageDealtToChampions || 0;
              const dmgTrue = stats.trueDamageDealtToChampions || 0;
              const dmgTotal = dmgMagic + dmgPhys + dmgTrue || 1;

              return (
                <div
                  key={gameId}
                  className={`glass-card rounded-2xl border transition-all duration-200 overflow-hidden ${
                    isWin
                      ? 'bg-emerald-950/20 border-emerald-500/30 hover:border-emerald-500/50'
                      : 'bg-rose-950/20 border-rose-500/30 hover:border-rose-500/50'
                  }`}
                >
                  {/* Summary Card Header */}
                  <div
                    onClick={() => void handleExpand(gameId)}
                    className="p-3.5 flex items-center justify-between gap-3 cursor-pointer select-none"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-xs shrink-0 border ${
                        isWin ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : 'bg-rose-500/20 text-rose-400 border-rose-500/40'
                      }`}>
                        {isWin ? <Trophy className="w-5 h-5" /> : <Skull className="w-5 h-5" />}
                      </div>

                      {champId > 0 && (
                        <img
                          src={`/lol-game-data/assets/v1/champion-icons/${champId}.png`}
                          alt=""
                          loading="lazy"
                          className="w-10 h-10 rounded-xl border border-white/10 bg-surface shrink-0 object-cover"
                          onError={(e: any) => { e.target.style.display = 'none'; }}
                        />
                      )}

                      {/* Spells & Runes Icons */}
                      <div className="flex flex-col gap-1 shrink-0">
                        <div className="flex items-center gap-0.5">
                          {spell1 && (
                            <img
                              src={`https://ddragon.leagueoflegends.com/cdn/${ddVer}/img/spell/${spell1.icon}.png`}
                              alt={spell1.name}
                              title={spell1.name}
                              loading="lazy"
                              className="w-4 h-4 rounded-md border border-white/10"
                            />
                          )}
                          {spell2 && (
                            <img
                              src={`https://ddragon.leagueoflegends.com/cdn/${ddVer}/img/spell/${spell2.icon}.png`}
                              alt={spell2.name}
                              title={spell2.name}
                              loading="lazy"
                              className="w-4 h-4 rounded-md border border-white/10"
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-0.5">
                          {RUNE_TREES[primaryStyle] && (
                            <img
                              src={`https://ddragon.leagueoflegends.com/cdn/${ddVer}/img/perk-images/Styles/${RUNE_TREES[primaryStyle].img}.png`}
                              alt={RUNE_TREES[primaryStyle].name}
                              title={`Primary: ${RUNE_TREES[primaryStyle].name}`}
                              loading="lazy"
                              className="w-4 h-4 rounded-md bg-black/40"
                              onError={(e: any) => { e.target.style.display = 'none'; }}
                            />
                          )}
                          {RUNE_TREES[subStyle] && (
                            <img
                              src={`https://ddragon.leagueoflegends.com/cdn/${ddVer}/img/perk-images/Styles/${RUNE_TREES[subStyle].img}.png`}
                              alt={RUNE_TREES[subStyle].name}
                              title={`Secondary: ${RUNE_TREES[subStyle].name}`}
                              loading="lazy"
                              className="w-3.5 h-3.5 rounded-md bg-black/40 opacity-75"
                              onError={(e: any) => { e.target.style.display = 'none'; }}
                            />
                          )}
                        </div>
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-black uppercase ${isWin ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {isWin ? 'VICTORY' : 'DEFEAT'}
                          </span>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/[0.04] text-text-muted border border-white/[0.06]">
                            {queueName}
                          </span>
                        </div>
                        <p className="text-[11px] text-text-dim font-medium mt-0.5">
                          Duration: {durationMins}m {durationSecs}s
                        </p>
                      </div>
                    </div>

                    {/* Middle: KDA Stats */}
                    <div className="text-center">
                      <p className="text-sm font-black text-white">
                        {kills} / <span className="text-rose-400">{deaths}</span> / {assists}
                      </p>
                      <p className="text-[10px] text-text-muted font-bold mt-0.5">
                        {kdaRatio === 'Perfect' ? 'Perfect KDA' : `${kdaRatio}:1 KDA`}
                      </p>
                    </div>

                    {/* Right: Items Build Slots & Drawer Toggle */}
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="flex items-center gap-1">
                        {items.map((itemId: number | undefined, i: number) => {
                          if (!itemId) {
                            return <div key={i} className="w-6 h-6 rounded-lg border border-white/5 bg-black/30" />;
                          }
                          const isTrinket = TRINKET_IDS.has(itemId);
                          return (
                            <img
                              key={i}
                              src={`https://ddragon.leagueoflegends.com/cdn/${ddVer}/img/item/${itemId}.png`}
                              alt=""
                              className={`w-6 h-6 rounded-lg bg-surface object-cover border ${
                                isTrinket ? 'border-amber-400/60 shadow-[0_0_8px_rgba(200,170,110,0.3)]' : 'border-white/10'
                              }`}
                              onError={(e: any) => { e.target.style.display = 'none'; }}
                            />
                          );
                        })}
                      </div>

                      <button className="text-text-dim hover:text-white transition">
                        {isExpanded ? <ChevronUp className="w-4 h-4 text-primary" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Advanced Match Metrics & Scoreboard */}
                  {isExpanded && (
                    <div className="p-4 bg-black/50 border-t border-white/[0.06] space-y-4 animate-fadeIn">
                      {/* Advanced Metrics Grid */}
                      <div className="grid grid-cols-3 gap-3">
                        {/* Damage Share & Types */}
                        <div className="glass-card p-3 rounded-xl border border-white/5 space-y-2">
                          <div className="flex items-center gap-1.5 text-xs font-bold text-amber-300">
                            <Flame className="w-3.5 h-3.5" />
                            <span>Damage Breakdown ({stats.totalDamageDealtToChampions?.toLocaleString()})</span>
                          </div>
                          <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden flex">
                            <div className="h-full bg-purple-500" style={{ width: `${(dmgMagic / dmgTotal) * 100}%` }} title="Magic Damage" />
                            <div className="h-full bg-rose-500" style={{ width: `${(dmgPhys / dmgTotal) * 100}%` }} title="Physical Damage" />
                            <div className="h-full bg-amber-400" style={{ width: `${(dmgTrue / dmgTotal) * 100}%` }} title="True Damage" />
                          </div>
                          <div className="flex items-center justify-between text-[10px] font-bold">
                            <span className="text-purple-400">Magic {dmgMagic.toLocaleString()}</span>
                            <span className="text-rose-400">Phys {dmgPhys.toLocaleString()}</span>
                            <span className="text-amber-400">True {dmgTrue.toLocaleString()}</span>
                          </div>
                        </div>

                        {/* Vision & Support */}
                        <div className="glass-card p-3 rounded-xl border border-white/5 space-y-1.5 text-xs">
                          <div className="flex items-center gap-1.5 font-bold text-cyan-300">
                            <Eye className="w-3.5 h-3.5" />
                            <span>Vision & Utility</span>
                          </div>
                          <div className="space-y-1 text-[11px] text-text-muted font-medium">
                            <p>Vision Score: <b className="text-white">{stats.visionScore || 0}</b> ({stats.visionWardsBoughtInGame || 0} Pink Wards)</p>
                            <p>Wards Placed: <b className="text-white">{stats.wardsPlaced || 0}</b> · Killed: <b className="text-white">{stats.wardsKilled || 0}</b></p>
                            <p>Time CCing Others: <b className="text-white">{stats.timeCCingOthers || 0}s</b></p>
                          </div>
                        </div>

                        {/* Combat & Defense */}
                        <div className="glass-card p-3 rounded-xl border border-white/5 space-y-1.5 text-xs">
                          <div className="flex items-center gap-1.5 font-bold text-emerald-300">
                            <Shield className="w-3.5 h-3.5" />
                            <span>Combat & Defense</span>
                          </div>
                          <div className="space-y-1 text-[11px] text-text-muted font-medium">
                            <p>Damage Taken: <b className="text-white">{(stats.totalDamageTaken || 0).toLocaleString()}</b></p>
                            <p>Self Mitigated: <b className="text-white">{(stats.damageSelfMitigated || 0).toLocaleString()}</b></p>
                            <p>Turret Damage: <b className="text-white">{(stats.damageDealtToTurrets || 0).toLocaleString()}</b></p>
                          </div>
                        </div>
                      </div>

                      {/* Full 10-Player Scoreboard Table */}
                      <div className="space-y-2">
                        <p className="text-[10px] text-text-dim font-bold uppercase tracking-wider">Full Match Scoreboard</p>
                        {loadingDetail === gameId ? (
                          <div className="flex items-center justify-center gap-2 py-3 text-text-muted text-xs">
                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                            <span>Loading scoreboard...</span>
                          </div>
                        ) : (() => {
                          const detail = gameDetails[gameId];
                          const allParticipants: any[] = detail?.participants || m.participants || [participant];

                          // Build participantId → summonerName lookup map
                          const nameMap: Record<number, string> = {};
                          if (detail?.participantIdentities) {
                            for (const identity of detail.participantIdentities) {
                              const pid = identity.participantId;
                              const name = identity.player?.summonerName || identity.player?.gameName || identity.player?.riotIdGameName || '';
                              if (pid && name) nameMap[pid] = name;
                            }
                          }

                          // Helper: resolve name from participant
                          const resolveName = (p: any, fallback: string): string =>
                            p.summonerName
                            || p.gameName
                            || p.riotIdGameName
                            || nameMap[p.participantId]
                            || nameMap[p.participantIdentityId]
                            || fallback;

                          // Max damage in game for scaling the damage bar
                          const maxDmg = Math.max(...allParticipants.map((p: any) => p.stats?.totalDamageDealtToChampions || 0), 1);

                          return (
                            <div className="space-y-3">
                              {[100, 200].map((teamId) => {
                                const teamPlayers = allParticipants.filter((p: any) => (p.teamId ?? 100) === teamId);
                                if (teamPlayers.length === 0) return null;
                                const teamWon = detail?.teams?.find((t: any) => t.teamId === teamId)?.win === 'Win';
                                const isBlue = teamId === 100;

                                return (
                                  <div key={teamId} className="space-y-1">
                                    {/* Team header */}
                                    <div className={`flex items-center gap-2 pb-1 border-b ${isBlue ? 'border-blue-500/30' : 'border-red-500/30'}`}>
                                      <span className={`text-[9px] font-black uppercase tracking-widest ${isBlue ? 'text-blue-400' : 'text-red-400'}`}>
                                        {isBlue ? '🔵 Blue Team' : '🔴 Red Team'}
                                      </span>
                                      <span className={`text-[9px] font-bold ml-auto ${teamWon ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        {teamWon ? 'VICTORY' : 'DEFEAT'}
                                      </span>
                                    </div>

                                    {teamPlayers.map((p: any, pIdx: number) => {
                                      const pStats = p.stats || {};
                                      const pChampId = p.championId || 0;
                                      const pName = resolveName(p, `Player ${pIdx + 1}`);
                                      const pKills = pStats.kills || 0;
                                      const pDeaths = pStats.deaths || 0;
                                      const pAssists = pStats.assists || 0;
                                      const pKdaRatio = pDeaths === 0 ? '∞' : ((pKills + pAssists) / pDeaths).toFixed(1);
                                      const pCs = (pStats.totalMinionsKilled || 0) + (pStats.neutralMinionsKilled || 0);
                                      const pDmg = pStats.totalDamageDealtToChampions || 0;
                                      const pGold = pStats.goldEarned || 0;
                                      const pVis = pStats.visionScore || 0;
                                      const pItems = [pStats.item0, pStats.item1, pStats.item2, pStats.item3, pStats.item4, pStats.item5, pStats.item6];
                                      const isMe = p.participantId === m.participants?.[0]?.participantId;

                                      return (
                                        <div
                                          key={pIdx}
                                          className={`rounded-xl border p-2 space-y-1.5 transition-all ${
                                            isMe
                                              ? 'bg-primary/10 border-primary/40 shadow-[0_0_12px_rgba(200,170,110,0.15)]'
                                              : teamWon
                                                ? 'bg-emerald-500/5 border-emerald-500/15'
                                                : 'bg-rose-500/5 border-rose-500/15'
                                          }`}
                                        >
                                          {/* Row 1: Icon + Name + KDA + CS + Gold + Vision */}
                                          <div className="flex items-center gap-2">
                                            <img
                                              src={`/lol-game-data/assets/v1/champion-icons/${pChampId}.png`}
                                              alt=""
                                              loading="lazy"
                                              className="w-8 h-8 rounded-lg border border-white/10 object-cover shrink-0"
                                              onError={(e: any) => { e.target.style.display = 'none'; }}
                                            />
                                            <div className="flex-1 min-w-0">
                                              <div className="flex items-center gap-2 flex-wrap">
                                                <span className={`font-bold text-xs truncate ${isMe ? 'text-primary' : 'text-white'}`}>
                                                  {isMe ? '★ ' : ''}{pName}
                                                </span>
                                                <span className="text-white font-bold text-[11px] shrink-0">
                                                  {pKills}/<span className="text-rose-400">{pDeaths}</span>/{pAssists}
                                                </span>
                                                <span className="text-[10px] text-text-muted font-medium shrink-0">{pKdaRatio} KDA</span>
                                              </div>
                                              <div className="flex items-center gap-3 mt-0.5">
                                                <span className="text-[10px] text-text-muted">{pCs} CS</span>
                                                <span className="text-[10px] text-yellow-400 font-bold">{(pGold / 1000).toFixed(1)}k Gold</span>
                                                <span className="text-[10px] text-cyan-400">👁 {pVis}</span>
                                              </div>
                                            </div>
                                          </div>

                                          {/* Row 2: Damage bar + Items */}
                                          <div className="flex items-center gap-2">
                                            {/* Damage bar */}
                                            <div className="flex-1 space-y-0.5">
                                              <div className="flex items-center justify-between text-[9px] text-text-dim">
                                                <span>DMG</span>
                                                <span className="text-amber-300 font-bold">{pDmg.toLocaleString()}</span>
                                              </div>
                                              <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                                                <div
                                                  className="h-full bg-gradient-to-r from-amber-600 to-amber-400 rounded-full"
                                                  style={{ width: `${Math.min(100, (pDmg / maxDmg) * 100)}%` }}
                                                />
                                              </div>
                                            </div>

                                            {/* Items strip */}
                                            <div className="flex items-center gap-0.5 shrink-0">
                                              {pItems.map((itemId: number | undefined, i: number) =>
                                                itemId ? (
                                                  <img
                                                    key={i}
                                                    src={`https://ddragon.leagueoflegends.com/cdn/${ddVer}/img/item/${itemId}.png`}
                                                    alt=""
                                                    loading="lazy"
                                                    className={`w-5 h-5 rounded object-cover border ${TRINKET_IDS.has(itemId) ? 'border-amber-400/60' : 'border-white/10'}`}
                                                    onError={(e: any) => { e.target.style.display = 'none'; }}
                                                  />
                                                ) : (
                                                  <div key={i} className="w-5 h-5 rounded border border-white/5 bg-black/20" />
                                                )
                                              )}
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
