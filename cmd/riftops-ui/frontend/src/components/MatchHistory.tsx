import { useState, useEffect, useCallback } from 'react';
import { fetchLCUMatchHistory, fetchLCUGameDetail, fetchLCURuneCatalog, fetchLCUProfile, fetchRiotMatchIDs, fetchRiotMatch, fetchLCUReplay, replayAction } from '../api';
import { History, Loader2, RefreshCw, Swords, Filter, ChevronDown, ChevronUp, Clock, Shield, Eye, Flame, Download, Coins, Crosshair, Target, Trophy, Users } from 'lucide-react';
import PageHeader from './PageHeader';
import { RiotAssetImage } from '../riotAssets';
import { normalizeArenaMatch } from '../arenaTelemetry';

type AssetEntry = { id: number; name: string; iconPath?: string; inStore?: boolean; displayInItemSets?: boolean; specialRecipe?: number; from?: number[] | string[]; to?: number[] | string[] };
type MatchAssets = { items: Map<number, AssetEntry>; spells: Map<number, AssetEntry>; perks: Map<number, AssetEntry>; styles: Map<number, AssetEntry> };

const EMPTY_ASSETS: MatchAssets = { items: new Map(), spells: new Map(), perks: new Map(), styles: new Map() };

function matchRows(data: any): any[] {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.games?.games) ? data.games.games : [];
}

function normalizeRiotMatch(match: any, puuid: string): any {
  const info = match?.info || {};
  const participants = Array.isArray(info.participants) ? info.participants : [];
  const local = participants.find((participant: any) => participant?.puuid === puuid) || participants[0] || {};
  return {
    gameId: match?.metadata?.matchId || match?.gameId,
    gameCreation: info.gameCreation,
    gameDuration: info.gameDuration,
    queueId: info.queueId,
    gameMode: info.gameMode,
    mapId: info.mapId,
    participants: [local, ...participants.filter((participant: any) => participant !== local)],
    _source: 'riot-api',
  };
}

function catalogueMap(raw: any): Map<number, AssetEntry> {
  const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  return new Map(values.map((entry: any) => [Number(entry.id), { ...entry, id: Number(entry.id), name: String(entry.name || `#${entry.id}`) }]).filter(([id]) => Number(id) > 0) as Array<[number, AssetEntry]>);
}

function runeSelection(participant: any): { perks: number[]; styles: number[]; shards: number[] } {
  const stats = participantStats(participant);
  const modernStyles = Array.isArray(participant?.perks?.styles) ? participant.perks.styles : [];
  const modernPerks: number[] = modernStyles.flatMap((style: any) => Array.isArray(style?.selections) ? style.selections.map((selection: any) => Number(selection?.perk)).filter(Boolean) : []);
  const legacyPerks: number[] = [stats.perk0, stats.perk1, stats.perk2, stats.perk3, stats.perk4, stats.perk5].map(Number).filter(Boolean);
  const styles: number[] = modernStyles.map((style: any) => Number(style?.style)).filter(Boolean);
  if (!styles.length) styles.push(...[stats.perkPrimaryStyle, stats.perkStyle, stats.perkSubStyle].map(Number).filter(Boolean));
  const statPerks = participant?.perks?.statPerks || stats?.statPerks || {};
  const shards: number[] = [statPerks.offense, statPerks.flex, statPerks.defense, stats.statPerk0, stats.statPerk1, stats.statPerk2].map(Number).filter(Boolean);
  return { perks: [...new Set(modernPerks.length ? modernPerks : legacyPerks)], styles: [...new Set(styles)], shards: [...new Set(shards)] };
}

function ItemStrip({ stats, assets, compact = false }: { stats: any; assets: MatchAssets; compact?: boolean }) {
  const ids = [stats.item0, stats.item1, stats.item2, stats.item3, stats.item4, stats.item5, stats.item6].map(Number);
  return <div className={compact ? 'history-match__items flex items-center gap-1' : 'match-score-row__items'}>{ids.map((id, index) => {
    const item = assets.items.get(id);
    const isTrinket = TRINKET_IDS.has(id);
    const isQuest = Boolean(item && /quest/i.test(item.name));
    const isUpgrade = Boolean(item && (Number(item.specialRecipe) > 0 || item.inStore === false && Array.isArray(item.from) && item.from.length > 0));
    return id > 0 ? <span key={`${id}-${index}`} className={`match-item ${isTrinket ? 'is-trinket' : ''}`} title={item?.name || `Unknown item ${id}`}><RiotAssetImage path={item?.iconPath} alt={item?.name || ''} loading="lazy" fallback={<i>{id}</i>} />{!compact && (isQuest || isUpgrade) && <b>{isQuest ? 'Quest' : 'Upgrade'}</b>}</span> : <i key={index} />;
  })}</div>;
}

const QUEUE_MAP: Record<number, string> = {
  420: 'Ranked Solo',
  440: 'Ranked Flex',
  400: 'Normal Draft',
  430: 'Normal Blind',
  450: 'ARAM',
  1300: 'Swiftplay',
  1700: 'Arena',
  1710: 'Arena',
};

const TRINKET_IDS = new Set([3340, 3363, 3364, 2055, 3013]);

const PERIODS: Record<string, { label: string; ms: number }> = {
  all: { label: 'All Time', ms: 0 },
  day: { label: '24 Hours', ms: 86_400_000 },
  week: { label: '7 Days', ms: 604_800_000 },
  month: { label: '30 Days', ms: 2_592_000_000 },
};

function matchDate(match: any): string {
  const raw = match.gameCreation || match.gameCreationDate || match.gameStartTimestamp;
  if (!raw) return 'Time unavailable';
  const date = new Date(typeof raw === 'number' && raw < 10_000_000_000 ? raw * 1000 : raw);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function durationLabel(seconds: number): string {
  const safe = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(safe / 60)}m ${safe % 60}s`;
}

function positionLabel(participant: any): string {
  const value = participant?.teamPosition || participant?.individualPosition || participant?.timeline?.lane || participant?.lane || participant?.role;
  if (!value || value === 'NONE') return 'Position unavailable';
  const labels: Record<string, string> = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', MID: 'Mid', BOTTOM: 'Bot', BOT: 'Bot', UTILITY: 'Support', SUPPORT: 'Support' };
  return labels[String(value).toUpperCase()] || String(value).replaceAll('_', ' ').toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

function participantStats(participant: any): any {
  return participant?.stats || participant || {};
}

function participantName(participant: any, names: Record<number, string>, fallback: string): string {
  return participant?.summonerName
    || participant?.gameName
    || participant?.riotIdGameName
    || names[participant?.participantId]
    || names[participant?.participantIdentityId]
    || fallback;
}

function isArenaMatch(match: any): boolean {
  return normalizeArenaMatch(match).isArena;
}

function ArenaMatchSummary({ match, detail }: { match: any; detail: any }) {
  const detailSource = detail && typeof detail === 'object' && Object.keys(detail).length ? detail : match;
  const telemetry = normalizeArenaMatch(detailSource);
  if (!telemetry.isArena) return null;
  const fields = [
    ['EVENT', telemetry.eventLabel],
    ['ROUND', telemetry.round === null ? 'Not exposed' : telemetry.round],
    ['PLACEMENT', telemetry.placement === null ? 'In progress' : `#${telemetry.placement}`],
    ['TEAMS LEFT', telemetry.teamsRemaining === null ? 'Not exposed' : telemetry.teamsRemaining],
    ['FAME', telemetry.fame === null ? 'Not exposed' : telemetry.fame.toLocaleString()],
  ];
  return <section className="arena-match-summary" aria-label="Arena progress">
    <header><div><small>ARENA PROGRESS</small><strong>Round and event context</strong></div><span>{telemetry.source}</span></header>
    <div className="arena-match-summary__grid">{fields.map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
    {telemetry.partnerName && <p>Partner · <strong>{telemetry.partnerName}</strong></p>}
    <div className="arena-match-summary__augments"><small>AUGMENTS</small>{telemetry.augments.length ? telemetry.augments.map((augment, index) => <span key={`${augment.id || augment.name}-${index}`} title={augment.description || augment.name}>{augment.name}</span>) : <em>League did not expose augment details for this match.</em>}</div>
  </section>;
}

function ParticipantLoadout({ participant, assets }: { participant: any; assets: MatchAssets }) {
  const stats = participantStats(participant);
  const spellIds = [participant?.spell1Id, participant?.spell2Id].map(Number);
  const runes = runeSelection(participant);
  return (
    <div className="match-score-row__loadout">
      <div className="match-score-row__spells">
        {spellIds.map((id, index) => { const spell = assets.spells.get(id); return id ? <RiotAssetImage key={`${id}-${index}`} path={spell?.iconPath} alt={spell?.name || ''} title={spell?.name || `Unknown spell ${id}`} loading="lazy" fallback={<i />} /> : <i key={index} />; })}
      </div>
      <div className="match-score-row__runes">
        {runes.styles.map((id) => { const style = assets.styles.get(id); return <RiotAssetImage key={`style-${id}`} path={style?.iconPath} alt={style?.name || ''} title={style?.name || `Rune style ${id}`} loading="lazy" fallback={<i />} />; })}
        {runes.perks.map((id) => { const perk = assets.perks.get(id); return <RiotAssetImage key={`perk-${id}`} path={perk?.iconPath} alt={perk?.name || ''} title={perk?.name || `Rune ${id}`} loading="lazy" fallback={<i />} />; })}
        {runes.shards.map((id) => { const shard = assets.perks.get(id); return <RiotAssetImage key={`shard-${id}`} path={shard?.iconPath} alt={shard?.name || ''} title={shard?.name || `Stat shard ${id}`} loading="lazy" fallback={<i />} />; })}
      </div>
      <ItemStrip stats={stats} assets={assets} />
    </div>
  );
}

function MatchDetails({ match, detail, loading, player, queueName, championName, championNames, assets }: { match: any; detail: any; loading: boolean; player: any; queueName: string; championName: string; championNames: Record<number, string>; assets: MatchAssets }) {
  const allParticipants: any[] = detail?.participants || match?.participants || [player];
  const identities = detail?.participantIdentities || match?.participantIdentities || [];
  const nameMap: Record<number, string> = {};
  identities.forEach((identity: any) => {
    const name = identity?.player?.summonerName || identity?.player?.gameName || identity?.player?.riotIdGameName;
    if (identity?.participantId && name) nameMap[identity.participantId] = name;
  });
  const localID = player?.participantId || identities[0]?.participantId;
  const localParticipant = allParticipants.find((entry) => entry?.participantId === localID) || player;
  const stats = participantStats(localParticipant);
  const teamID = localParticipant?.teamId || player?.teamId || 100;
  const teamPlayers = allParticipants.filter((entry) => (entry?.teamId || 100) === teamID);
  const teamKills = teamPlayers.reduce((sum, entry) => sum + (participantStats(entry).kills || 0), 0);
  const kills = stats.kills || 0;
  const deaths = stats.deaths || 0;
  const assists = stats.assists || 0;
  const cs = (stats.totalMinionsKilled || 0) + (stats.neutralMinionsKilled || 0);
  const kp = teamKills > 0 ? Math.round(((kills + assists) / teamKills) * 100) : null;
  const isWin = Boolean(stats.win || stats.winner);
  const teams: any[] = detail?.teams || [];
  const teamOrder = [teamID, ...[100, 200].filter((id) => id !== teamID)];

  return (
    <div className="match-analysis">
      <header className="match-analysis__overview">
        <div className={`match-analysis__result ${isWin ? 'is-victory' : 'is-defeat'}`}><Trophy /><span>{isWin ? 'Victory' : 'Defeat'}</span></div>
        <div><small>QUEUE</small><strong>{queueName}</strong><span>{matchDate(match)}</span></div>
        <div><small>DURATION</small><strong>{durationLabel(match?.gameDuration || detail?.gameDuration)}</strong><span>Game {match?.gameId || detail?.gameId || '—'}</span></div>
        <div className="match-analysis__champion"><img src={`/lol-game-data/assets/v1/champion-icons/${localParticipant?.championId || player?.championId || 0}.png`} alt="" width="72" height="72" /><span><small>YOUR PICK</small><strong>{championName}</strong><em>{positionLabel(localParticipant)}</em></span></div>
      </header>

      <ArenaMatchSummary match={match} detail={detail} />

      <section className="match-performance" aria-label="Your performance">
        <div className="match-analysis__section-title"><Crosshair /><span><small>PLAYER PERFORMANCE</small><strong>Your match at a glance</strong></span></div>
        <div className="match-performance__primary">
          <div><small>KDA</small><strong>{kills} / <em>{deaths}</em> / {assists}</strong><span>{deaths === 0 ? 'Perfect KDA' : `${((kills + assists) / deaths).toFixed(2)} ratio`}</span></div>
          <div><small>KILL PARTICIPATION</small><strong>{kp == null ? '—' : `${kp}%`}</strong><span>{teamKills ? `${teamKills} team kills` : 'Team data unavailable'}</span></div>
          <div><small>FARM</small><strong>{cs} CS</strong><span>{match?.gameDuration ? `${(cs / (match.gameDuration / 60)).toFixed(1)} per min` : 'Rate unavailable'}</span></div>
          <div><small>GOLD</small><strong>{(stats.goldEarned || 0).toLocaleString()}</strong><span>Level {stats.champLevel || localParticipant?.champLevel || '—'}</span></div>
        </div>
        <div className="match-performance__secondary">
          <span><Flame /><small>Champion damage</small><strong>{(stats.totalDamageDealtToChampions || 0).toLocaleString()}</strong></span>
          <span><Shield /><small>Damage taken</small><strong>{(stats.totalDamageTaken || 0).toLocaleString()}</strong></span>
          <span><Eye /><small>Vision score</small><strong>{stats.visionScore ?? '—'}</strong></span>
          <span><Target /><small>Wards</small><strong>{stats.wardsPlaced || 0} placed · {stats.wardsKilled || 0} cleared</strong></span>
          <span><Crosshair /><small>Best spree</small><strong>{stats.largestKillingSpree || 0}</strong></span>
          <span><Users /><small>Multi-kills</small><strong>{(stats.doubleKills || 0) + (stats.tripleKills || 0) + (stats.quadraKills || 0) + (stats.pentaKills || 0)}</strong></span>
        </div>
      </section>

      <section className="match-scoreboard" aria-label="Match scoreboard">
        <div className="match-analysis__section-title"><Users /><span><small>FULL SCOREBOARD</small><strong>Your team and opponents</strong></span></div>
        {loading && <div className="match-analysis__loading"><Loader2 className="animate-spin" />Loading participant details…</div>}
        {!loading && teamOrder.map((id) => {
          const participants = allParticipants.filter((entry) => (entry?.teamId || 100) === id);
          if (!participants.length) return null;
          const team = teams.find((entry) => entry?.teamId === id) || {};
          const won = String(team.win || '').toLowerCase() === 'win' || participants.some((entry) => participantStats(entry).win === true);
          const totalTeamKills = participants.reduce((sum, entry) => sum + (participantStats(entry).kills || 0), 0);
          return <div className={`match-team ${id === teamID ? 'is-yours' : 'is-enemy'}`} key={id}>
            <header><span><strong>{id === teamID ? 'Your team' : 'Enemy team'}</strong><small>{won ? 'Victory' : 'Defeat'} · {totalTeamKills} kills</small></span><div><b><Target />{team.towerKills ?? '—'} towers</b><b><span>◆</span>{team.dragonKills ?? '—'} dragons</b><b><span>◈</span>{team.baronKills ?? '—'} barons</b><b><span>◇</span>{team.riftHeraldKills ?? '—'} heralds</b></div></header>
            <div className="match-team__players">{participants.map((entry, index) => {
              const entryStats = participantStats(entry);
              const entryID = entry?.participantId;
              const isMe = Boolean(localID && entryID === localID);
              const championID = entry?.championId || 0;
              const entryCS = (entryStats.totalMinionsKilled || 0) + (entryStats.neutralMinionsKilled || 0);
              return <article className={`match-score-row ${isMe ? 'is-me' : ''}`} key={entryID || index}>
                <div className="match-score-row__identity"><img src={`/lol-game-data/assets/v1/champion-icons/${championID}.png`} alt="" width="40" height="40" loading="lazy" /><span><strong>{participantName(entry, nameMap, `Player ${index + 1}`)}{isMe ? ' · You' : ''}</strong><small>{championNames[championID] || `Champion ${championID}`} · Level {entryStats.champLevel || entry?.champLevel || '—'}</small></span></div>
                <div className="match-score-row__kda"><strong>{entryStats.kills || 0} / <em>{entryStats.deaths || 0}</em> / {entryStats.assists || 0}</strong><small>{entryStats.deaths ? (((entryStats.kills || 0) + (entryStats.assists || 0)) / entryStats.deaths).toFixed(1) : 'Perfect'} KDA</small></div>
                <div className="match-score-row__economy"><span><Crosshair />{entryCS} CS</span><span><Coins />{((entryStats.goldEarned || 0) / 1000).toFixed(1)}k</span><span><Flame />{(entryStats.totalDamageDealtToChampions || 0).toLocaleString()}</span><span><Eye />{entryStats.visionScore ?? '—'}</span></div>
                <ParticipantLoadout participant={entry} assets={assets} />
              </article>;
            })}</div>
          </div>;
        })}
      </section>
    </div>
  );
}

export default function MatchHistory({ remoteClient = false }: { remoteClient?: boolean }) {
  const showLegacyMatchDetails = false;
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
  const [championNames, setChampionNames] = useState<Record<number, string>>({});
  const [assets, setAssets] = useState<MatchAssets>(EMPTY_ASSETS);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState('');
  const [dataSource, setDataSource] = useState<'LCU' | 'Riot API'>('LCU');
  const [replayStatus, setReplayStatus] = useState<Record<number, any>>({});
  const [replayBusy, setReplayBusy] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPaginationError('');
    try {
      let data: any;
      try {
        data = await fetchLCUMatchHistory(0, 50);
        setDataSource('LCU');
      } catch (lcuError) {
        // Public Match-V5 is an explicit fallback for users who configured a
        // Riot API key. We reuse the currently connected PUUID when possible
        // and preserve the original LCU error if public auth is unavailable.
        try {
          const profile = await fetchLCUProfile();
          const region = localStorage.getItem('riftops.riot.region') || 'EUW';
          const ids = await fetchRiotMatchIDs(region, profile.summoner.puuid, 0, 20);
          const rawMatches = await Promise.all(ids.matchIds.map((id) => fetchRiotMatch(region, id).catch(() => null)));
          const normalized = rawMatches.filter(Boolean).map((match) => normalizeRiotMatch(match, profile.summoner.puuid));
          if (!normalized.length) throw lcuError;
          data = { games: { games: normalized } };
          setDataSource('Riot API');
        } catch {
          throw lcuError;
        }
      }
      const [champions, items, spells, runeCatalog] = await Promise.all([
        fetch('/lol-game-data/assets/v1/champion-summary.json').then((response) => response.ok ? response.json() : []).catch(() => []),
        fetch('/lol-game-data/assets/v1/items.json').then((response) => response.ok ? response.json() : []).catch(() => []),
        fetch('/lol-game-data/assets/v1/summoner-spells.json').then((response) => response.ok ? response.json() : []).catch(() => []),
        fetchLCURuneCatalog().catch(() => ({ perks: [], styles: { styles: [] } })),
      ]);
      if (Array.isArray(champions)) setChampionNames(Object.fromEntries(champions.map((champion: any) => [Number(champion.id), String(champion.name || champion.alias || `Champion ${champion.id}`)])));
      setAssets({ items: catalogueMap(items), spells: catalogueMap(spells), perks: catalogueMap(runeCatalog.perks), styles: catalogueMap(runeCatalog.styles.styles) });
      const rows = matchRows(data);
      setMatches(rows);
      setHasMore(rows.length === 50);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch match history — launch League first.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const appendPage = useCallback(async (loadAll = false) => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setPaginationError('');
    try {
      let begin = matches.length;
      let combined = [...matches];
      while (begin < 500) {
        const rows = matchRows(await fetchLCUMatchHistory(begin, begin + 50));
        const known = new Set(combined.map((match) => String(match.gameId ?? `${match.gameCreation}-${match.queueId}`)));
        for (const row of rows) {
          const key = String(row.gameId ?? `${row.gameCreation}-${row.queueId}`);
          if (!known.has(key)) { known.add(key); combined.push(row); }
        }
        begin += rows.length;
        if (rows.length < 50 || !loadAll) { setHasMore(rows.length === 50 && begin < 500); break; }
      }
      if (begin >= 500) setHasMore(false);
      setMatches(combined);
    } catch (reason: any) {
      setPaginationError(reason?.message || 'Could not load more matches. Your existing history is still available.');
    } finally { setLoadingMore(false); }
  }, [hasMore, loadingMore, matches]);

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
      setGameDetails((prev) => ({ ...prev, [gameId]: detail }));
    } catch {
      // detail fetch failed, scoreboard will show summary data only
    } finally {
      setLoadingDetail(null);
    }
  }, [expandedId, gameDetails]);

  const handleReplay = async (gameId: number, action?: 'download' | 'watch') => {
    if (!gameId) return;
    setReplayBusy(gameId);
    try {
      if (!action) {
        const status = await fetchLCUReplay(gameId);
        setReplayStatus((current) => ({ ...current, [gameId]: status }));
        return;
      }
      if (action === 'watch' && remoteClient && !window.confirm(`Watch replay for Game ID ${gameId}?`)) return;
      await replayAction(gameId, action);
      const status = await fetchLCUReplay(gameId).catch(() => null);
      if (status) setReplayStatus((current) => ({ ...current, [gameId]: status }));
    } catch (reason: any) {
      setReplayStatus((current) => ({ ...current, [gameId]: { status: 'failed', error: reason?.message || 'Replay action failed.' } }));
    } finally { setReplayBusy(null); }
  };

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
  const arenaMatches = filteredMatches.filter(isArenaMatch);
  const arenaTelemetry = arenaMatches.map((match) => normalizeArenaMatch(match));
  const arenaPlacements = arenaTelemetry.map((telemetry) => telemetry.placement).filter((placement): placement is number => placement !== null);
  const arenaFame = arenaTelemetry.map((telemetry) => telemetry.fame).filter((fame): fame is number => fame !== null);
  const arenaAveragePlacement = arenaPlacements.length ? (arenaPlacements.reduce((sum, placement) => sum + placement, 0) / arenaPlacements.length).toFixed(1) : '—';
  const arenaAverageFame = arenaFame.length ? Math.round(arenaFame.reduce((sum, fame) => sum + fame, 0) / arenaFame.length).toLocaleString() : '—';
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

  const headerActions = (
    <>
      <button type="button" onClick={exportMatches} disabled={loading || filteredMatches.length === 0} className="page-header__icon-action" title="Export filtered matches" aria-label="Export filtered matches">
        <Download />
      </button>
      <select value={gameCount} onChange={(e) => setGameCount(Number(e.target.value))} className="page-header__select" aria-label="Number of games">
        <option value={20}>20 games</option>
        <option value={50}>50 games</option>
        <option value={100}>100 games</option>
      </select>
      <button type="button" onClick={() => void loadData()} disabled={loading} className="page-header__icon-action" title="Refresh match history" aria-label="Refresh match history">
        <RefreshCw className={loading ? 'animate-spin' : ''} />
      </button>
    </>
  );

  return (
    <div className="page-content page-content--history space-y-4">
      <PageHeader
        variant="data"
        icon={History}
        eyebrow="MATCH INTELLIGENCE"
        title="Match history"
        description="Review the last games, spot trends, and open a match for the full scoreboard."
        meta={<span className="page-header__badge">{filteredMatches.length} matches · {dataSource}</span>}
        actions={headerActions}
      />

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
      {!loading && !error && arenaMatches.length > 0 && (
        <section className="arena-history-summary" aria-label="Arena history summary">
          <div><small>ARENA HISTORY</small><strong>{arenaMatches.length} games</strong><span>Filtered selection</span></div>
          <div><small>AVG PLACEMENT</small><strong>{arenaAveragePlacement === '—' ? arenaAveragePlacement : `#${arenaAveragePlacement}`}</strong><span>Only exposed placements</span></div>
          <div><small>AVG FAME</small><strong>{arenaAverageFame}</strong><span>League data when available</span></div>
          <div><small>DETAILS</small><strong>Open a game</strong><span>Round, partner, and augments</span></div>
        </section>
      )}

      {/* Filter Toolbar */}
      <div className="page-toolbar page-toolbar--history flex items-center justify-between gap-2 overflow-x-auto pb-1">
        {/* Queue Filters */}
        <div className="flex items-center gap-1 shrink-0">
          <Filter className="w-3.5 h-3.5 text-primary mr-1" />
          {[
            { id: 'all', label: 'All Modes' },
            { id: 420, label: 'Ranked Solo' },
            { id: 440, label: 'Ranked Flex' },
            { id: 450, label: 'ARAM' },
            { id: 400, label: 'Draft' },
            { id: 1700, label: 'Arena' },
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
              const championName = participant.championName || m.championName || championNames[champId] || (champId ? `Champion ${champId}` : 'Unknown champion');

              const spell1 = assets.spells.get(Number(participant.spell1Id));
              const spell2 = assets.spells.get(Number(participant.spell2Id));
              const selectedRunes = runeSelection(participant);

              // Damage Types Breakdown
              const dmgMagic = stats.magicDamageDealtToChampions || 0;
              const dmgPhys = stats.physicalDamageDealtToChampions || 0;
              const dmgTrue = stats.trueDamageDealtToChampions || 0;
              const dmgTotal = dmgMagic + dmgPhys + dmgTrue || 1;

              return (
                <div
                  key={gameId}
                  className={`history-match ${isWin ? 'is-victory' : 'is-defeat'} glass-card rounded-2xl border transition duration-200 overflow-hidden ${
                    isWin
                      ? 'bg-emerald-950/20 border-emerald-500/30 hover:border-emerald-500/50'
                      : 'bg-rose-950/20 border-rose-500/30 hover:border-rose-500/50'
                  }`}
                >
                  {/* Summary Card Header */}
                  <div
                    onClick={() => void handleExpand(gameId)}
                    className="history-match__summary p-3.5 flex items-center justify-between gap-3 cursor-pointer select-none"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void handleExpand(gameId); } }}
                  >
                    <div className="history-match__identity flex items-center gap-3 min-w-0">
                      <div className="history-result-crest" aria-hidden="true"><span>{isWin ? 'W' : 'L'}</span></div>

                      {champId > 0 && (
                        <img
                          src={`/lol-game-data/assets/v1/champion-icons/${champId}.png`}
                          alt=""
                          width="40"
                          height="40"
                          loading="lazy"
                          className="w-10 h-10 rounded-xl border border-white/10 bg-surface shrink-0 object-cover"
                          onError={(e: any) => { e.target.style.display = 'none'; }}
                        />
                      )}

                      {/* Spells & Runes Icons */}
                      <div className="flex flex-col gap-1 shrink-0">
                        <div className="flex items-center gap-0.5">
                          {spell1 && (
                            <RiotAssetImage
                              path={spell1.iconPath}
                              alt={spell1.name}
                              title={spell1.name}
                              loading="lazy"
                              className="w-4 h-4 rounded-md border border-white/10"
                            />
                          )}
                          {spell2 && (
                            <RiotAssetImage
                              path={spell2.iconPath}
                              alt={spell2.name}
                              title={spell2.name}
                              loading="lazy"
                              className="w-4 h-4 rounded-md border border-white/10"
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-0.5">
                          {selectedRunes.styles.slice(0, 2).map((id, index) => { const style = assets.styles.get(id); return <RiotAssetImage key={id} path={style?.iconPath} alt={style?.name || ''} title={`${index ? 'Secondary' : 'Primary'}: ${style?.name || id}`} loading="lazy" className="w-4 h-4 rounded-md bg-black/40" fallback={<i className="w-4 h-4 rounded-md bg-black/30" />} />; })}
                          {selectedRunes.perks.slice(0, 1).map((id) => { const perk = assets.perks.get(id); return <RiotAssetImage key={id} path={perk?.iconPath} alt={perk?.name || ''} title={`Keystone: ${perk?.name || id}`} loading="lazy" className="w-4 h-4 rounded-md bg-black/40" fallback={<i className="w-4 h-4 rounded-md bg-black/30" />} />; })}
                        </div>
                      </div>

                      <div className="history-match__meta min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-black uppercase ${isWin ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {isWin ? 'VICTORY' : 'DEFEAT'}
                          </span>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/[0.04] text-text-muted border border-white/[0.06]">
                            {queueName}
                          </span>
                        </div>
                        <strong className="history-match__champion">{championName}</strong>
                        <p className="text-[11px] text-text-dim font-medium mt-0.5">{matchDate(m)} · {durationMins}m {durationSecs}s</p>
                      </div>
                    </div>

                    {/* Middle: KDA Stats */}
                    <div className="history-match__kda text-center">
                      <p className="text-sm font-black text-white">
                        {kills} / <span className="text-rose-400">{deaths}</span> / {assists}
                      </p>
                      <p className="text-[10px] text-text-muted font-bold mt-0.5">
                        {kdaRatio === 'Perfect' ? 'Perfect KDA' : `${kdaRatio}:1 KDA`}
                      </p>
                    </div>

                    {/* Right: Items Build Slots & Drawer Toggle */}
                    <div className="history-match__loadout flex items-center gap-3 shrink-0">
                      <ItemStrip stats={stats} assets={assets} compact />

                      <div className="history-match__replay" onClick={(event) => event.stopPropagation()}>
                        {replayStatus[Number(gameId)]?.status === 'ready' ? <button type="button" className="btn-secondary" onClick={() => void handleReplay(Number(gameId), 'watch')} disabled={replayBusy === Number(gameId)}>Watch</button> : <button type="button" className="btn-secondary" onClick={() => void handleReplay(Number(gameId), 'download')} disabled={replayBusy === Number(gameId)}>{replayBusy === Number(gameId) ? <Loader2 className="animate-spin" /> : <Download />} {replayStatus[Number(gameId)]?.status === 'downloading' ? 'Downloading…' : 'Replay'}</button>}
                      </div>

                      <button className="text-text-dim hover:text-white transition">
                        {isExpanded ? <ChevronUp className="w-4 h-4 text-primary" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {isExpanded && <MatchDetails match={m} detail={gameDetails[gameId]} loading={loadingDetail === gameId} player={participant} queueName={queueName} championName={championName} championNames={championNames} assets={assets} />}

                  {/* Previous detail renderer retained unreachable for one migration release. */}
                  {showLegacyMatchDetails && isExpanded && (
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
                                      const isMe = p.participantId === m.participants?.[0]?.participantId;

                                      return (
                                        <div
                                          key={pIdx}
                                          className={`rounded-xl border p-2 space-y-1.5 transition ${
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
                                              width="32"
                                              height="32"
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
                                            <ItemStrip stats={pStats} assets={assets} compact />
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
          {paginationError && <div className="loot-workshop__state is-error"><span>{paginationError}</span></div>}
          {hasMore && <div className="incremental-actions match-history__load-actions"><button type="button" className="skin-vault-results__more" disabled={loadingMore} onClick={() => void appendPage(false)}>{loadingMore ? <Loader2 className="animate-spin" /> : <ChevronDown />}Load 50 more matches</button><button type="button" className="skin-vault-results__more" disabled={loadingMore} onClick={() => void appendPage(true)}>{loadingMore ? <Loader2 className="animate-spin" /> : <History />}Load all available <span>up to 500 safely</span></button></div>}
        </div>
      )}
    </div>
  );
}
