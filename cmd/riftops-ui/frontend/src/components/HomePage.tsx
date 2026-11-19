import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Award,
  Check,
  ChevronDown,
  CircleUserRound,
  Compass,
  ExternalLink,
  Flame,
  History,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Shield,
  Sparkles,
  Square,
  Swords,
  Target,
  Users,
  Zap,
} from 'lucide-react';
import type { ConfirmAction, Snapshot, Tab } from '../types';
import {
  ddProfileIcon,
  fetchConnectedLeagueAccount,
  fetchDDragonVersion,
  fetchLaunchProfiles,
  fetchLCUFriends,
  fetchLCUMatchHistory,
  fetchLCUProfile,
  fetchProfileSessionStatuses,
  fetchProgressMissions,
  fetchProgressRewards,
  fetchQoLPreferences,
  lcuAutoAccept,
  switchLaunchProfile,
  type ConnectedLeagueAccount,
  type LaunchProfile,
  type LCUProfile,
  type ProfileSessionStatus,
  type QoLPreferences,
} from '../api';
import { useLCUConnection } from './lcuConnectionContext';
import { accountRankLabel, normalizeRegionLabel } from '../utils/accountRank';
import { livePhaseLabel, normalizeLivePhase } from '../liveSession';
import ConfirmModal from './ConfirmModal';
import GameSelector from './GameSelector';
import PhoneCompanionPanel from './PhoneCompanionPanel';
import PageHeader from './PageHeader';
import { StatusBadge } from './DesignPrimitives';
import '../styles/homePage.css';

export interface HomePageProps {
  snapshot: Snapshot;
  lcuConnected: boolean;
  leaguePhase: string;
  leagueStatus: string;
  remoteClient: boolean;
  activeProfileId?: string;
  onRefreshSnapshot: () => Promise<void>;
  setActiveTab: (tab: Tab) => void;
  showToast: (title: string, message: string, type?: 'info' | 'success' | 'error') => void;
  handleLaunch: () => void;
  handleStop: () => void;
  handleSetGame: (game: string) => void;
  selectedGame: string;
  gameInfo: any;
  launchStage: 'idle' | 'checking' | 'starting' | 'waiting' | 'ready';
  homeAction: string;
  isIdle: boolean;
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

const STREAMER_ALIASES = [
  'Hextech Sentinel', 'Piltover Scout', 'Noxian Vanguard', 'Ionian Master',
  'Zaunite Chemist', 'Freljordian Nomad', 'Shuriman Ascendant', 'Bilgewater Corsair',
  'Targon Stargazer', 'Shadow Isles Wraith', 'Demacian Justiciar', 'Bandle Gunner',
];

function maskFriendName(rawName: string, streamerMode: boolean): string {
  if (!streamerMode) return rawName;
  const hash = rawName.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return `${STREAMER_ALIASES[hash % STREAMER_ALIASES.length]} #${(hash % 900) + 100}`;
}

function timeAgo(dateOrTimestamp: number | string): string {
  if (!dateOrTimestamp) return '';
  const ts = typeof dateOrTimestamp === 'number' && dateOrTimestamp < 10_000_000_000
    ? dateOrTimestamp * 1000
    : new Date(dateOrTimestamp).getTime();
  if (isNaN(ts) || ts <= 0) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function rankedEntry(profile: LCUProfile | null) {
  return (
    profile?.league?.find((item) => item.queueType === 'RANKED_SOLO_5x5') ||
    profile?.league?.find((item) => item.queueType === 'RANKED_FLEX_SR') ||
    profile?.league?.[0]
  );
}

function roleLabel(role?: string): string {
  switch ((role || '').toUpperCase()) {
    case 'TOP': return 'Top';
    case 'JUNGLE': return 'Jungle';
    case 'MIDDLE':
    case 'MID': return 'Mid';
    case 'BOTTOM':
    case 'BOT': return 'Bot';
    case 'UTILITY':
    case 'SUPPORT': return 'Support';
    default: return 'Fill';
  }
}

export default function HomePage({
  snapshot,
  lcuConnected,
  leaguePhase,
  leagueStatus,
  remoteClient,
  activeProfileId,
  onRefreshSnapshot,
  setActiveTab,
  showToast,
  handleLaunch,
  handleStop,
  handleSetGame,
  selectedGame,
  gameInfo,
  launchStage,
  homeAction,
  isIdle,
}: HomePageProps) {
  const { connected, pageVisible, performanceMode, streamerMode, qol } = useLCUConnection();

  // Summoner & Account Switcher State
  const [profile, setProfile] = useState<LCUProfile | null>(null);
  const [version, setVersion] = useState('');
  const [loadingSummoner, setLoadingSummoner] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ProfileSessionStatus>>({});
  const [connectedAccount, setConnectedAccount] = useState<ConnectedLeagueAccount | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);

  // Recent Matches State
  const [recentMatches, setRecentMatches] = useState<any[]>([]);
  const [championNames, setChampionNames] = useState<Record<number, string>>({});

  // Online Friends State
  const [onlineFriends, setOnlineFriends] = useState<any[]>([]);
  const [totalFriendsCount, setTotalFriendsCount] = useState(0);

  // Missions & Rewards State
  const [activeMissions, setActiveMissions] = useState<any[]>([]);
  const [pendingGrantsCount, setPendingGrantsCount] = useState(0);

  // QoL Preferences State
  const [qolPrefs, setQolPrefs] = useState<QoLPreferences | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const switchLock = useRef(false);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDropdownOpen(false);
    };
    window.addEventListener('mousedown', handleOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [dropdownOpen]);

  // Load Champion Names Summary
  useEffect(() => {
    fetch('/lol-game-data/assets/v1/champion-summary.json')
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          const map: Record<number, string> = {};
          for (const c of data) {
            map[Number(c.id)] = String(c.name || c.alias || `Champion ${c.id}`);
          }
          setChampionNames(map);
        }
      })
      .catch(() => {});
  }, []);

  // Primary Data Fetch
  const loadHomeData = useCallback(async () => {
    if (!pageVisible) return;
    setLoadingSummoner(true);

    try {
      const [nextProfiles, nextStatuses, nextConnected, ddragon, prefs] = await Promise.all([
        fetchLaunchProfiles().catch(() => []),
        fetchProfileSessionStatuses().catch(() => ({})),
        fetchConnectedLeagueAccount().catch(() => null),
        version ? Promise.resolve({ version }) : fetchDDragonVersion().catch(() => ({ version: '' })),
        fetchQoLPreferences().catch(() => null),
      ]);

      setProfiles(nextProfiles);
      setStatuses(nextStatuses);
      setConnectedAccount(nextConnected);
      if (ddragon?.version) setVersion(ddragon.version);
      if (prefs) setQolPrefs(prefs);

      if (connected) {
        // Connected LCU endpoints
        const [lcuProf, matchHistoryData, friendsData, missionsData, rewardsData] = await Promise.all([
          fetchLCUProfile().catch(() => null),
          fetchLCUMatchHistory(0, 3).catch(() => null),
          fetchLCUFriends().catch(() => null),
          fetchProgressMissions().catch(() => null),
          fetchProgressRewards().catch(() => null),
        ]);

        setProfile(lcuProf);

        // Normalize Matches
        if (matchHistoryData) {
          const rows = Array.isArray(matchHistoryData)
            ? matchHistoryData
            : Array.isArray(matchHistoryData?.games?.games)
              ? matchHistoryData.games.games
              : [];
          setRecentMatches(rows.slice(0, 3));
        } else {
          setRecentMatches([]);
        }

        // Normalize Friends
        if (friendsData) {
          const rawList: any[] = Array.isArray(friendsData)
            ? friendsData
            : Array.isArray((friendsData as any)?.friends)
              ? (friendsData as any).friends
              : [];

          setTotalFriendsCount(rawList.length);

          const onlineOnly = rawList.filter((f) => {
            const avail = String(f?.availability || f?.status || '').toLowerCase();
            return (
              avail === 'chat' ||
              avail === 'online' ||
              avail === 'dnd' ||
              avail === 'away' ||
              avail === 'mobile' ||
              f?.productName === 'league_of_legends'
            );
          });
          setOnlineFriends(onlineOnly.slice(0, 3));
        } else {
          setOnlineFriends([]);
          setTotalFriendsCount(0);
        }

        // Normalize Missions & Rewards
        if (missionsData?.missions && Array.isArray(missionsData.missions)) {
          const incomplete = missionsData.missions
            .filter((m: any) => !String(m.status || '').toLowerCase().includes('complete'))
            .slice(0, 2);
          setActiveMissions(incomplete);
        } else {
          setActiveMissions([]);
        }

        if (rewardsData?.grants && Array.isArray(rewardsData.grants)) {
          setPendingGrantsCount(rewardsData.grants.length);
        } else {
          setPendingGrantsCount(0);
        }
      } else {
        setProfile(null);
        setRecentMatches([]);
        setOnlineFriends([]);
        setTotalFriendsCount(0);
        setActiveMissions([]);
        setPendingGrantsCount(0);
      }
    } catch {
      // Non-fatal background fetch
    } finally {
      setLoadingSummoner(false);
    }
  }, [connected, pageVisible, version]);

  useEffect(() => {
    void loadHomeData();
    if (!pageVisible) return undefined;
    const interval = performanceMode === 'fast' ? 12_000 : performanceMode === 'quiet' ? 60_000 : 25_000;
    const timer = window.setInterval(() => void loadHomeData(), interval);
    return () => window.clearInterval(timer);
  }, [loadHomeData, pageVisible, performanceMode]);

  // Active Profile Identification
  const activeProfile = useMemo(() => {
    if (activeProfileId) {
      const match = profiles.find((p) => p.id === activeProfileId);
      if (match) return match;
    }
    return profiles[0] || null;
  }, [activeProfileId, profiles]);

  // Ranked Identification
  const liveRank = rankedEntry(profile);
  const activeSoloTier = useMemo(() => {
    if (liveRank?.tier) return liveRank.tier.toLowerCase();
    if (activeProfile?.rank?.solo?.tier) return activeProfile.rank.solo.tier.toLowerCase();
    return 'unranked';
  }, [liveRank, activeProfile]);

  const activeRegion = useMemo(() => {
    return normalizeRegionLabel(connectedAccount?.region || activeProfile?.region);
  }, [connectedAccount, activeProfile]);

  const summoner = profile?.summoner;
  const riotID = useMemo(() => {
    if (summoner) {
      if (streamerMode) return 'Demo Player#EUW';
      const name = summoner.gameName || summoner.displayName || 'League account';
      return summoner.tagLine ? `${name}#${summoner.tagLine}` : name;
    }
    if (activeProfile?.riotId) {
      return streamerMode ? 'Hidden Account#EUW' : activeProfile.riotId;
    }
    if (activeProfile?.name) {
      return activeProfile.name;
    }
    return 'League Account';
  }, [summoner, streamerMode, activeProfile]);

  const rankDisplay = useMemo(() => {
    if (liveRank?.tier) {
      const tier = liveRank.tier.toUpperCase();
      const name = tier.charAt(0) + tier.slice(1).toLowerCase();
      const isApex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier);
      const div = isApex ? '' : liveRank.rank || liveRank.division || '';
      return {
        tierName: `${name}${div ? ` ${div}` : ''}`,
        lp: `${liveRank.leaguePoints ?? 0} LP`,
        queue: liveRank.queueType === 'RANKED_FLEX_SR' ? 'FLEX' : 'SOLO / DUO',
      };
    }
    if (activeProfile?.rank?.solo) {
      const label = accountRankLabel(activeProfile.rank.solo);
      const parts = label.split('·');
      return {
        tierName: parts[0]?.trim() || 'Unranked',
        lp: parts[1]?.trim() || '',
        queue: 'SOLO / DUO',
      };
    }
    return {
      tierName: 'Unranked',
      lp: '',
      queue: 'SOLO / DUO',
    };
  }, [liveRank, activeProfile]);

  // Switch Execution
  const executeSwitch = async (profileId: string) => {
    if (switchLock.current) return;
    switchLock.current = true;
    setSwitchingId(profileId);
    try {
      const res = await switchLaunchProfile(profileId);
      await loadHomeData();
      if (onRefreshSnapshot) await onRefreshSnapshot().catch(() => undefined);
      setDropdownOpen(false);
      showToast(
        'Account Switched',
        `Active session restored for ${res.profile.name}. Ready to launch.`,
        'success'
      );
    } catch (err: any) {
      showToast('Switch Failed', err?.message || 'Could not restore account session', 'error');
    } finally {
      switchLock.current = false;
      setSwitchingId(null);
    }
  };

  const handleRequestSwitch = (target: LaunchProfile) => {
    if (target.id === activeProfile?.id) {
      setDropdownOpen(false);
      return;
    }

    if (connected) {
      setConfirmation({
        open: true,
        danger: true,
        title: 'Switch League Account?',
        message: `League of Legends is currently running.\n\nSwitching accounts will close your active Riot Client session to restore "${target.name}".\n\nDo you want to close the active session and switch?`,
        actionLabel: 'Close & Switch',
        onConfirm: () => {
          setConfirmation(null);
          void executeSwitch(target.id);
        },
      });
      return;
    }

    void executeSwitch(target.id);
  };

  // Other accounts for quick switcher
  const otherAccounts = useMemo(() => {
    return profiles.filter((p) => p.id !== activeProfile?.id).slice(0, 4);
  }, [profiles, activeProfile]);

  // Phase information
  const isOnline = connected || lcuConnected;
  const phase = qol?.phase || leaguePhase || 'Disconnected';
  const phaseLower = phase.toLowerCase();
  const isLobby = phaseLower === 'lobby';
  const isMatchmaking = phaseLower === 'matchmaking';
  const isReadyCheck = phaseLower === 'readycheck';
  const isChampSelect = phaseLower === 'champselect';
  const isInGame = phaseLower === 'inprogress';
  const isEndOfGame = phaseLower === 'endofgame';

  const phaseBadgeClass = !isOnline
    ? 'is-disconnected'
    : isReadyCheck
      ? 'is-ready'
      : isMatchmaking
        ? 'is-queue'
        : isChampSelect
          ? 'is-champselect'
          : isInGame
            ? 'is-ingame'
            : isEndOfGame
              ? 'is-postgame'
              : 'is-lobby';

  const phaseTitle = !isOnline
    ? 'Riot Client Disconnected'
    : isReadyCheck
      ? 'Ready Check Active'
      : isMatchmaking
        ? 'Matchmaking In Queue'
        : isChampSelect
          ? 'Champion Select Active'
          : isInGame
            ? 'Match In Progress'
            : isEndOfGame
              ? 'Post-Game Review'
              : isLobby
                ? 'Party Lobby Connected'
                : 'Client Menu Ready';

  const phaseDesc = !isOnline
    ? snapshot.Detail || 'Launch League to connect live queue automations, stats, and profile.'
    : isReadyCheck
      ? 'Match found! Click Accept to lock in your spot.'
      : isMatchmaking
        ? 'Searching for opponents. Auto-accept is standing by.'
        : isChampSelect
          ? 'Draft in progress. Auto-hover and rune sync active.'
          : isInGame
            ? 'Live game session active. Tracking performance in real time.'
            : isEndOfGame
              ? 'Match finished. Return to lobby or review match summary.'
              : isLobby
                ? 'Lobby ready. Select roles and open play preparation.'
                : 'Ready for your next game. Select roles and open play preparation.';

  return (
    <>
      {confirmation && <ConfirmModal action={confirmation} onClose={() => setConfirmation(null)} />}

      <div className="home-command-center animate-fadeIn">
        <PageHeader
          icon={Play}
          eyebrow="COMMAND CENTER"
          title="Home"
          description="Your personalized League command center. Prepare your queue, monitor live match status, and inspect recent performance."
          meta={<StatusBadge tone={isOnline ? 'live' : 'neutral'}>{leagueStatus}</StatusBadge>}
        />

        {remoteClient && (
          <div className="phone-session-banner">
            <Shield />
            <span>
              <strong>Phone session connected</strong>
              <small>Live League controls are routed through your paired RiftOps desktop.</small>
            </span>
          </div>
        )}

        {/* ═══════════════════════════════════════════════
           PHASE-AWARE STATUS & ACTION STRIP
           ═══════════════════════════════════════════════ */}
        <section className="home-phase-strip" aria-label="League Client Phase and Quick Command">
          <div className="home-phase-strip__left">
            <div className={`home-phase-strip__badge ${phaseBadgeClass}`}>
              <span className={`home-phase-strip__dot ${isReadyCheck || isMatchmaking ? 'is-pulsing' : ''}`} />
              <span>{isOnline ? livePhaseLabel(normalizeLivePhase(phase, qol?.queueState)) : 'OFFLINE'}</span>
            </div>

            <div className="home-phase-strip__details">
              <span className="home-phase-strip__title">{phaseTitle}</span>
              <span className="home-phase-strip__desc">{phaseDesc}</span>
            </div>
          </div>

          <div className="home-phase-strip__right">
            {!isOnline ? (
              <>
                <GameSelector value={selectedGame} onChange={handleSetGame} disabled={!isIdle} />
                <button
                  type="button"
                  onClick={() => handleLaunch()}
                  disabled={!isIdle || launchStage !== 'idle' || homeAction !== ''}
                  className="home-phase-strip__action-btn home-phase-strip__action-btn--primary"
                >
                  {launchStage !== 'idle' ? (
                    <RotateCcw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 fill-current" />
                  )}
                  <span>
                    {launchStage === 'checking'
                      ? 'Checking…'
                      : launchStage === 'starting'
                        ? 'Starting…'
                        : launchStage === 'waiting'
                          ? 'Connecting…'
                          : launchStage === 'ready'
                            ? 'Ready'
                            : `Launch ${gameInfo?.label || 'League'}`}
                  </span>
                </button>
                {!isIdle && (
                  <button
                    type="button"
                    onClick={handleStop}
                    disabled={homeAction !== ''}
                    className="home-phase-strip__action-btn home-phase-strip__action-btn--secondary"
                    title="Stop proxy"
                  >
                    <Square className="w-3.5 h-3.5" />
                    <span>Stop</span>
                  </button>
                )}
              </>
            ) : isReadyCheck ? (
              <button
                type="button"
                onClick={() => {
                  void lcuAutoAccept().catch(() => {});
                  showToast('Ready Check', 'Match accepted!', 'success');
                }}
                className="home-phase-strip__action-btn home-phase-strip__action-btn--amber"
              >
                <Check className="w-4 h-4" />
                <span>Accept Match</span>
              </button>
            ) : isInGame ? (
              <button
                type="button"
                onClick={() => setActiveTab('live')}
                className="home-phase-strip__action-btn home-phase-strip__action-btn--teal"
              >
                <span>Open Live Game</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : isChampSelect ? (
              <button
                type="button"
                onClick={() => setActiveTab('play')}
                className="home-phase-strip__action-btn home-phase-strip__action-btn--primary"
              >
                <span>Open Champ Select</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : isEndOfGame ? (
              <button
                type="button"
                onClick={() => setActiveTab('history')}
                className="home-phase-strip__action-btn home-phase-strip__action-btn--secondary"
              >
                <span>Review Match</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setActiveTab('play')}
                className="home-phase-strip__action-btn home-phase-strip__action-btn--primary"
              >
                <span>Open Play & Queue</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </section>

        {/* ═══════════════════════════════════════════════
           MAIN 2-COLUMN BALANCED COMMAND CENTER GRID
           ═══════════════════════════════════════════════ */}
        <div className="home-dashboard-grid">
          {/* ──────────────────────────────────────────────
             PRIMARY COLUMN: Summoner Card & Play Prep
             ────────────────────────────────────────────── */}
          <div className="home-col-primary">
            {/* CARD 1: SUMMONER OVERVIEW & QUICK SWITCHER */}
            <section
              ref={dropdownRef}
              className="home-card home-summoner-card"
              aria-label="Current League Summoner & Quick Switcher"
            >
              <div className="home-card__header">
                <div className="home-card__header-left">
                  <span className="home-card__title">CURRENT SUMMONER</span>
                  <span className="home-summoner-region-tag">{activeRegion}</span>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      connected ? 'bg-[#0ac8b9] shadow-[0_0_8px_#0ac8b9]' : 'bg-[#69777f]'
                    }`}
                  />
                  <span className="text-[11px] font-medium text-[#8f9ca3]">
                    {connected ? 'Live Session' : 'Saved Account'}
                  </span>
                  <button
                    type="button"
                    onClick={() => void loadHomeData()}
                    disabled={loadingSummoner}
                    className="p-1 rounded-lg text-[#8f9ca3] hover:text-[#f0e6d2] hover:bg-white/[0.05] transition cursor-pointer"
                    aria-label="Refresh summoner info"
                    title="Refresh summoner info"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingSummoner ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              {/* Summoner Identity & Dominant Rank Wings */}
              <div className="home-summoner-body">
                <div className="home-summoner-identity">
                  <div className="home-summoner-avatar-wrapper">
                    {summoner && version ? (
                      <img
                        src={ddProfileIcon(version, summoner.profileIconId)}
                        alt=""
                        className="home-summoner-avatar"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#c8aa6e]">
                        <CircleUserRound className="w-7 h-7" />
                      </div>
                    )}
                    <span className="home-summoner-level-badge">
                      {summoner?.summonerLevel ? `Lv ${summoner.summonerLevel}` : 'Offline'}
                    </span>
                  </div>

                  <div className="home-summoner-meta">
                    <strong className="home-summoner-name">{riotID}</strong>
                    <div className="home-summoner-status-row">
                      <span className="home-summoner-state-pill">
                        {connected ? 'League Connected' : 'Selected Account'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Dominant Ranked Presentation */}
                <div className="home-summoner-rank">
                  <div className="home-summoner-wing-wrap">
                    <img
                      src={`/league/ranks/${activeSoloTier}.png`}
                      alt={rankDisplay.tierName}
                      className="home-summoner-wing-img"
                      onError={(e) => {
                        e.currentTarget.src = '/league/ranks/unranked.png';
                      }}
                    />
                  </div>
                  <div className="home-summoner-rank-info">
                    <span className="home-summoner-queue-label">{rankDisplay.queue}</span>
                    <strong className="home-summoner-tier-label">{rankDisplay.tierName}</strong>
                    {rankDisplay.lp && <span className="home-summoner-lp-label">{rankDisplay.lp}</span>}
                  </div>
                </div>
              </div>

              {/* Quick Switcher Bar */}
              <div className="home-switcher-bar">
                <button
                  type="button"
                  onClick={() => setDropdownOpen((prev) => !prev)}
                  className="home-switcher-btn"
                  aria-expanded={dropdownOpen}
                  aria-haspopup="true"
                >
                  <Zap className="w-3.5 h-3.5 text-[#c8aa6e]" />
                  <span>Switch account</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-[#8f9ca3] transition-transform duration-200 ${
                      dropdownOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('accounts')}
                  className="home-manage-accounts-btn"
                >
                  <span>Manage accounts</span>
                  <span className="text-sm leading-none">&rarr;</span>
                </button>
              </div>

              {/* Quick Switch Popover */}
              {dropdownOpen && (
                <div className="home-switcher-popover">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/[0.08]">
                    <span className="text-[10px] font-black text-[#c8aa6e] tracking-widest uppercase">
                      QUICK ACCOUNT SWITCH
                    </span>
                    <span className="text-[10px] text-[#8f9ca3]">
                      {profiles.length} total account{profiles.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  {otherAccounts.length === 0 ? (
                    <div className="py-4 text-center">
                      <p className="text-xs text-[#8f9ca3]">No other saved accounts found.</p>
                      <button
                        type="button"
                        onClick={() => {
                          setDropdownOpen(false);
                          setActiveTab('accounts');
                        }}
                        className="mt-2 text-xs font-bold text-[#c8aa6e] hover:underline cursor-pointer"
                      >
                        + Add an account in Accounts Hub
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5 max-h-60 overflow-y-auto pr-1">
                      {otherAccounts.map((p) => {
                        const tier = (p.rank?.solo?.tier || 'unranked').toLowerCase();
                        const isSwitching = switchingId === p.id;
                        const status = statuses[p.id];
                        const rankText = p.rank?.solo ? accountRankLabel(p.rank.solo) : 'Unranked';

                        return (
                          <div key={p.id} className="home-popover-item">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-8 h-8 flex items-center justify-center shrink-0">
                                <img
                                  src={`/league/ranks/${tier}.png`}
                                  alt=""
                                  className="max-h-full max-w-full object-contain"
                                  onError={(e) => {
                                    e.currentTarget.src = '/league/ranks/unranked.png';
                                  }}
                                />
                              </div>
                              <div className="min-w-0 flex flex-col">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-bold text-[#f0e6d2] truncate">
                                    {streamerMode ? 'Saved Account' : p.name}
                                  </span>
                                  <span className="px-1.5 py-0.2 rounded bg-white/[0.06] text-[9px] font-bold text-[#8f9ca3]">
                                    {normalizeRegionLabel(p.region)}
                                  </span>
                                </div>
                                <span className="text-[10px] text-[#dfc477] font-medium truncate">
                                  {rankText}
                                </span>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => handleRequestSwitch(p)}
                              disabled={switchingId !== null}
                              className="home-popover-switch-btn"
                              title={status?.saved ? 'Restore saved session' : 'Sign into Riot Client'}
                            >
                              {isSwitching ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Zap className="w-3.5 h-3.5" />
                              )}
                              <span>{isSwitching ? 'Switching…' : 'Switch'}</span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="pt-2.5 mt-2 border-t border-white/[0.08] flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => {
                        setDropdownOpen(false);
                        setActiveTab('accounts');
                      }}
                      className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] text-xs font-bold text-[#c8aa6e] transition cursor-pointer"
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span>All Accounts & Management Hub &rarr;</span>
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* CARD 2: NEXT MATCH PREPARATION */}
            <section className="home-card home-prep-card" aria-label="Next Match Preparation">
              <div className="home-card__header">
                <div className="home-card__header-left">
                  <Swords className="w-3.5 h-3.5 text-[#c8aa6e]" />
                  <span className="home-card__title">NEXT MATCH PREPARATION</span>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('play')}
                  className="home-card__link"
                >
                  <span>Configure</span>
                  <span className="text-xs">&rarr;</span>
                </button>
              </div>

              <div className="home-prep-grid">
                <div className="home-prep-block">
                  <span className="home-prep-label">Target Queue</span>
                  <span className="home-prep-value">
                    <Target className="w-4 h-4 text-[#0ac8b9]" />
                    <span>
                      {qol?.queueId && QUEUE_MAP[qol.queueId]
                        ? QUEUE_MAP[qol.queueId]
                        : 'Ranked Solo / Duo'}
                    </span>
                  </span>
                </div>

                <div className="home-prep-block">
                  <span className="home-prep-label">Preferred Roles</span>
                  <div className="home-role-tags">
                    <span className="home-role-tag">
                      <Flame className="w-3 h-3 text-[#c8aa6e]" />
                      <span>{roleLabel(qolPrefs?.playFlow?.primaryRole || qol?.firstRole || 'MID')}</span>
                    </span>
                    <span className="home-role-tag">
                      <Compass className="w-3 h-3 text-[#aebbc1]" />
                      <span>{roleLabel(qolPrefs?.playFlow?.secondaryRole || qol?.secondRole || 'TOP')}</span>
                    </span>
                  </div>
                </div>
              </div>

              {/* Automations Strip */}
              <div className="home-automations-strip">
                <span
                  className={`home-auto-pill ${qolPrefs?.autoAccept ? 'is-active' : ''}`}
                  title="Auto-Accept Ready Check"
                >
                  <Check className="w-3 h-3" />
                  <span>Auto-Accept: {qolPrefs?.autoAccept ? 'Active' : 'Off'}</span>
                </span>
                <span
                  className={`home-auto-pill ${
                    qolPrefs?.autoPlayAgain || qolPrefs?.autoStartQueue ? 'is-active' : ''
                  }`}
                  title="Auto-Requeue after game"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Auto-Requeue: {qolPrefs?.autoPlayAgain || qolPrefs?.autoStartQueue ? 'Active' : 'Off'}</span>
                </span>
                <span
                  className={`home-auto-pill ${
                    qolPrefs?.playFlow?.pickChampionId ? 'is-active' : ''
                  }`}
                  title="Automated Runes & Pick Assist"
                >
                  <Sparkles className="w-3 h-3" />
                  <span>Auto-Runes: {qolPrefs?.playFlow?.pickChampionId ? 'Ready' : 'Off'}</span>
                </span>
              </div>

              {/* CTA Button */}
              <button
                type="button"
                onClick={() => setActiveTab('play')}
                className="home-prep-cta-btn"
              >
                <span>Open Play Flow & Queue</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </section>
          </div>

          {/* ──────────────────────────────────────────────
             SECONDARY COLUMN: Matches, Social, Missions
             ────────────────────────────────────────────── */}
          <div className="home-col-secondary">
            {/* CARD 3: RECENT PERFORMANCE */}
            <section className="home-card" aria-label="Recent Match Performance">
              <div className="home-card__header">
                <div className="home-card__header-left">
                  <Flame className="w-3.5 h-3.5 text-[#c8aa6e]" />
                  <span className="home-card__title">RECENT PERFORMANCE</span>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('history')}
                  className="home-card__link"
                >
                  <span>Full History</span>
                  <span className="text-xs">&rarr;</span>
                </button>
              </div>

              {recentMatches.length > 0 ? (
                <div className="home-matches-list">
                  {recentMatches.map((m, idx) => {
                    const localParticipant =
                      m.participants?.find((p: any) => p?.puuid && p.puuid === summoner?.puuid) ||
                      m.participants?.[0] ||
                      {};
                    const stats = localParticipant.stats || localParticipant;
                    const isWin =
                      Boolean(stats.win) ||
                      String(stats.win || '').toLowerCase() === 'win' ||
                      String(m.teams?.[0]?.win || '').toLowerCase() === 'win';
                    const champId = localParticipant.championId || 0;
                    const champName = championNames[champId] || `Champion ${champId}`;
                    const queueName = QUEUE_MAP[m.queueId] || 'Match';
                    const kills = stats.kills ?? 0;
                    const deaths = stats.deaths ?? 0;
                    const assists = stats.assists ?? 0;
                    const kdaRatio =
                      deaths === 0
                        ? 'Perfect'
                        : `${((kills + assists) / deaths).toFixed(1)} KDA`;
                    const matchTime = timeAgo(m.gameCreation || m.gameStartTimestamp);

                    return (
                      <div
                        key={m.gameId || idx}
                        className={`home-match-item ${isWin ? 'is-victory' : 'is-defeat'}`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="home-match-champ-wrap">
                            <img
                              src={`/lol-game-data/assets/v1/champion-icons/${champId}.png`}
                              alt=""
                              className="home-match-champ-img"
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                              }}
                            />
                          </div>

                          <div className="home-match-info">
                            <div className="home-match-headline">
                              <span className="home-match-outcome">
                                {isWin ? 'Victory' : 'Defeat'}
                              </span>
                              <span className="w-1 h-1 rounded-full bg-white/20" />
                              <span className="home-match-queue">{queueName}</span>
                            </div>
                            <span className="home-match-champ-name">{champName}</span>
                          </div>
                        </div>

                        <div className="home-match-kda-col">
                          <span className="home-match-kda-score">
                            {kills} / <span className="home-match-kda-deaths">{deaths}</span> / {assists}
                          </span>
                          <span className="home-match-kda-ratio">{kdaRatio}</span>
                          {matchTime && <span className="home-match-time">{matchTime}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="home-empty-state">
                  <History className="w-7 h-7 home-empty-state__icon" />
                  <p className="home-empty-state__text">
                    {connected
                      ? 'No recent matches found for this account.'
                      : 'Connect League Client to view your recent match performance.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('history')}
                    className="home-card__link mt-1"
                  >
                    <span>View Match History Tab &rarr;</span>
                  </button>
                </div>
              )}
            </section>

            {/* CARD 4: COMPACT ONLINE FRIENDS OR PHONE COMPANION */}
            {remoteClient ? (
              <PhoneCompanionPanel showToast={(message, type = 'info') => showToast('League Client', message, type)} />
            ) : (
              <section className="home-card" aria-label="Online Friends Summary">
                <div className="home-card__header">
                  <div className="home-card__header-left">
                    <Users className="w-3.5 h-3.5 text-[#0ac8b9]" />
                    <span className="home-card__title">
                      ONLINE FRIENDS {onlineFriends.length > 0 ? `(${onlineFriends.length})` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('social')}
                    className="home-card__link"
                  >
                    <span>All Friends ({totalFriendsCount})</span>
                    <span className="text-xs">&rarr;</span>
                  </button>
                </div>

                {onlineFriends.length > 0 ? (
                  <div className="home-friends-list">
                    {onlineFriends.map((f) => {
                      const rawName =
                        f.gameName || f.displayName || f.name || f.summonerName || 'Friend';
                      const name = maskFriendName(rawName, streamerMode);
                      const avail = String(f.availability || f.status || '').toLowerCase();
                      const isInGameFriend =
                        avail === 'dnd' || f.productName === 'league_of_legends';
                      const isAway = avail === 'away';
                      const statusText = isInGameFriend
                        ? 'In Game'
                        : isAway
                          ? 'Away'
                          : 'Online';

                      const dotTone = isInGameFriend
                        ? 'is-ingame'
                        : isAway
                          ? 'is-away'
                          : 'is-online';

                      return (
                        <div key={f.id || f.puuid || rawName} className="home-friend-item">
                          <div className="home-friend-left">
                            <div className="home-friend-avatar-wrap">
                              {f.profileIconId && version ? (
                                <img
                                  src={ddProfileIcon(version, f.profileIconId)}
                                  alt=""
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-[#8f9ca3]">
                                  <CircleUserRound className="w-4 h-4" />
                                </div>
                              )}
                              <span className={`home-friend-dot ${dotTone}`} />
                            </div>

                            <div className="flex flex-col min-w-0">
                              <span className="home-friend-name">{name}</span>
                              <span className="home-friend-activity">{statusText}</span>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => setActiveTab('social')}
                            className="p-1 rounded text-[#8f9ca3] hover:text-[#f0e6d2] transition cursor-pointer"
                            title="Invite or chat in Friends hub"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="home-empty-state">
                    <Users className="w-7 h-7 home-empty-state__icon" />
                    <p className="home-empty-state__text">
                      {connected
                        ? 'No friends are currently online.'
                        : 'League Client offline. Connect to view online friends.'}
                    </p>
                  </div>
                )}
              </section>
            )}

            {/* CARD 5: MISSIONS & REWARDS */}
            <section className="home-card" aria-label="Missions & Rewards">
              <div className="home-card__header">
                <div className="home-card__header-left">
                  <Award className="w-3.5 h-3.5 text-[#c8aa6e]" />
                  <span className="home-card__title">MISSIONS & REWARDS</span>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('progress')}
                  className="home-card__link"
                >
                  <span>View All</span>
                  <span className="text-xs">&rarr;</span>
                </button>
              </div>

              <div className="home-missions-body">
                {pendingGrantsCount > 0 && (
                  <div className="home-rewards-alert">
                    <span className="home-rewards-alert-text">
                      🎁 {pendingGrantsCount} Unclaimed Reward{pendingGrantsCount === 1 ? '' : 's'} Ready
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveTab('progress')}
                      className="home-rewards-alert-btn"
                    >
                      Claim Now
                    </button>
                  </div>
                )}

                {activeMissions.length > 0 ? (
                  activeMissions.map((m, idx) => {
                    const obj = m.objectives?.[0];
                    const current = Number(
                      obj?.current ?? obj?.progress ?? obj?.currentProgress ?? 0
                    );
                    const goal = Number(
                      obj?.goal ?? obj?.target ?? obj?.total ?? 1
                    );
                    const ratio = goal > 0 ? Math.min(100, Math.round((current / goal) * 100)) : 0;

                    return (
                      <div key={m.id || idx} className="home-mission-item">
                        <div className="home-mission-top">
                          <span className="home-mission-title">{m.title || 'League Mission'}</span>
                          <span className="home-mission-expiry">
                            {m.endAt
                              ? `Ends ${new Date(m.endAt).toLocaleDateString([], {
                                  month: 'short',
                                  day: 'numeric',
                                })}`
                              : 'Active'}
                          </span>
                        </div>
                        <div className="home-mission-track">
                          <div
                            className="home-mission-fill"
                            style={{ width: `${ratio}%` }}
                          />
                        </div>
                        <span className="home-mission-numbers">
                          {current} / {goal} ({ratio}%)
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div className="home-empty-state">
                    <Award className="w-7 h-7 home-empty-state__icon" />
                    <p className="home-empty-state__text">
                      {connected
                        ? 'All active missions completed or none assigned.'
                        : 'Missions sync with your active League Client session.'}
                    </p>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
