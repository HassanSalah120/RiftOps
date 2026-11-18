import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  CircleUserRound,
  Layers,
  Loader2,
  RefreshCw,
  Zap,
} from 'lucide-react';
import {
  ddProfileIcon,
  fetchConnectedLeagueAccount,
  fetchDDragonVersion,
  fetchLaunchProfiles,
  fetchLCUProfile,
  fetchProfileSessionStatuses,
  switchLaunchProfile,
  type ConnectedLeagueAccount,
  type LaunchProfile,
  type LCUProfile,
  type ProfileSessionStatus,
} from '../api';
import { useLCUConnection } from './lcuConnectionContext';
import { accountRankLabel } from '../utils/accountRank';
import ConfirmModal from './ConfirmModal';
import type { ConfirmAction } from '../types';

interface AccountSummaryProps {
  activeProfileId?: string;
  onRefreshSnapshot?: () => Promise<void>;
  onOpenAccountsHub?: () => void;
  showToast?: (title: string, message: string, type?: 'info' | 'success' | 'error') => void;
}

function rankedEntry(profile: LCUProfile | null) {
  return (
    profile?.league?.find((item) => item.queueType === 'RANKED_SOLO_5x5') ||
    profile?.league?.find((item) => item.queueType === 'RANKED_FLEX_SR') ||
    profile?.league?.[0]
  );
}

function rankLabel(profile: LCUProfile | null): string {
  const entry = rankedEntry(profile);
  if (!entry?.tier) return 'Unranked';
  const tier = entry.tier.charAt(0) + entry.tier.slice(1).toLowerCase();
  return `${tier} ${entry.rank || entry.division || ''}`.trim();
}

export default function AccountSummary({
  activeProfileId,
  onRefreshSnapshot,
  onOpenAccountsHub,
  showToast,
}: AccountSummaryProps) {
  const { connected, pageVisible, performanceMode, streamerMode } = useLCUConnection();
  const [profile, setProfile] = useState<LCUProfile | null>(null);
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ProfileSessionStatus>>({});
  const [connectedAccount, setConnectedAccount] = useState<ConnectedLeagueAccount | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);

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

  const loadData = useCallback(async () => {
    if (!pageVisible) return;
    setLoading(true);
    try {
      const [nextProfiles, nextStatuses, nextConnected, ddragon] = await Promise.all([
        fetchLaunchProfiles().catch(() => []),
        fetchProfileSessionStatuses().catch(() => ({})),
        fetchConnectedLeagueAccount().catch(() => null),
        version ? Promise.resolve({ version }) : fetchDDragonVersion().catch(() => ({ version: '' })),
      ]);

      setProfiles(nextProfiles);
      setStatuses(nextStatuses);
      setConnectedAccount(nextConnected);
      if (ddragon?.version) setVersion(ddragon.version);

      if (connected) {
        try {
          const lcu = await fetchLCUProfile();
          setProfile(lcu);
        } catch {
          setProfile(null);
        }
      } else {
        setProfile(null);
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }
  }, [connected, pageVisible, version]);

  useEffect(() => {
    void loadData();
    if (!pageVisible) return undefined;
    const interval = performanceMode === 'fast' ? 15_000 : performanceMode === 'quiet' ? 60_000 : 30_000;
    const timer = window.setInterval(() => void loadData(), interval);
    return () => window.clearInterval(timer);
  }, [loadData, pageVisible, performanceMode]);

  // Find active profile record
  const activeProfile = useMemo(() => {
    if (activeProfileId) {
      const match = profiles.find((p) => p.id === activeProfileId);
      if (match) return match;
    }
    return profiles[0] || null;
  }, [activeProfileId, profiles]);

  // Ranked info
  const rank = rankedEntry(profile);
  const activeSoloTier = useMemo(() => {
    if (rank?.tier) return rank.tier.toLowerCase();
    if (activeProfile?.rank?.solo?.tier) return activeProfile.rank.solo.tier.toLowerCase();
    return 'unranked';
  }, [rank, activeProfile]);

  const activeRegion = useMemo(() => {
    return connectedAccount?.region || activeProfile?.region || 'EUW1';
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

  const level = useMemo(() => {
    if (summoner?.summonerLevel) return `Level ${summoner.summonerLevel}`;
    return 'Ready to launch';
  }, [summoner]);

  // Switch execution
  const executeSwitch = async (profileId: string) => {
    if (switchLock.current) return;
    switchLock.current = true;
    setSwitchingId(profileId);
    try {
      const res = await switchLaunchProfile(profileId);
      await loadData();
      if (onRefreshSnapshot) await onRefreshSnapshot().catch(() => undefined);
      setDropdownOpen(false);
      showToast?.(
        'Account Switched',
        `Active session restored for ${res.profile.name}. Ready to launch.`,
        'success'
      );
    } catch (err: any) {
      showToast?.('Switch Failed', err?.message || 'Could not restore account session', 'error');
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

    // UX Rule: Safe session interruption guard
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

  // Other accounts for quick switcher (limit to 4)
  const otherAccounts = useMemo(() => {
    return profiles.filter((p) => p.id !== activeProfile?.id).slice(0, 4);
  }, [profiles, activeProfile]);

  return (
    <>
      {confirmation && <ConfirmModal action={confirmation} onClose={() => setConfirmation(null)} />}

      <section
        ref={dropdownRef}
        className="summoner-card-home relative bg-gradient-to-br from-[#030c18]/95 via-[#081b28]/90 to-[#040e1b]/95 border border-[#c8aa6e]/30 hover:border-[#c8aa6e]/50 rounded-2xl p-4 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-md transition-all duration-200"
        aria-label="Current League Summoner & Quick Switcher"
      >
        {/* Top Eyebrow / Status Row */}
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.08] text-xs">
          <div className="flex items-center gap-2">
            <span className="font-black text-[#c8aa6e] tracking-widest uppercase text-[10px]">CURRENT SUMMONER</span>
            <span className="px-2 py-0.5 rounded-md bg-white/[0.06] border border-white/[0.1] text-[10px] font-bold text-[#aebbc1] uppercase tracking-wider">
              {activeRegion}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                connected ? 'bg-[#0ac8b9] shadow-[0_0_8px_#0ac8b9]' : 'bg-[#69777f]'
              }`}
              title={connected ? 'League Client connected' : 'Local account save'}
            />
            <span className="text-[11px] font-medium text-[#8f9ca3]">
              {connected ? 'Connected' : 'Selected'}
            </span>
            <button
              type="button"
              onClick={() => void loadData()}
              disabled={loading}
              className="p-1 rounded-lg text-[#8f9ca3] hover:text-[#f0e6d2] hover:bg-white/[0.05] transition cursor-pointer"
              aria-label="Refresh summoner info"
              title="Refresh summoner info"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Summoner & Rank Content */}
        <div className="flex items-center justify-between gap-4 py-3.5">
          {/* Avatar & Identity */}
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="relative w-12 h-12 rounded-xl bg-[#0b1928] border border-[#c8aa6e]/40 p-0.5 shrink-0 overflow-hidden shadow-[0_4px_12px_rgba(0,0,0,0.5)]">
              {summoner && version ? (
                <img
                  src={ddProfileIcon(version, summoner.profileIconId)}
                  alt=""
                  className="w-full h-full object-cover rounded-[10px]"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[#c8aa6e]">
                  <CircleUserRound className="w-6 h-6" />
                </div>
              )}
            </div>

            <div className="min-w-0 flex flex-col">
              <strong className="text-sm font-bold text-[#f0e6d2] truncate tracking-wide">
                {riotID}
              </strong>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-[#8f9ca3] truncate">{level}</span>
                <span className="w-1 h-1 rounded-full bg-white/20" />
                <span className="text-[10px] font-semibold text-[#0ac8b9] uppercase tracking-wider">
                  Selected account
                </span>
              </div>
            </div>
          </div>

          {/* Rank Wing & LP */}
          <div className="flex items-center gap-2.5 shrink-0 pl-3 border-l border-white/[0.08]">
            <div className="w-10 h-10 flex items-center justify-center shrink-0">
              <img
                src={`/league/ranks/${activeSoloTier}.png`}
                alt=""
                className="max-h-full max-w-full object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.7)]"
                onError={(e) => {
                  e.currentTarget.src = '/league/ranks/unranked.png';
                }}
              />
            </div>
            <div className="flex flex-col text-right">
              <span className="text-[10px] font-bold text-[#8f7b52] tracking-wider uppercase">SOLO / FLEX</span>
              <strong className="text-xs font-bold text-[#dfc477] whitespace-nowrap">
                {profile ? rankLabel(profile) : activeProfile?.rank?.solo ? accountRankLabel(activeProfile.rank.solo) : 'Unranked'}
              </strong>
            </div>
          </div>
        </div>

        {/* Quick Actions Bar */}
        <div className="flex items-center justify-between gap-2 pt-3 border-t border-white/[0.08]">
          <button
            type="button"
            onClick={() => setDropdownOpen((prev) => !prev)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.05] hover:bg-[#c8aa6e]/15 border border-white/[0.1] hover:border-[#c8aa6e]/50 text-xs font-bold text-[#f0e6d2] transition cursor-pointer"
            aria-expanded={dropdownOpen}
            aria-haspopup="true"
          >
            <Zap className="w-3.5 h-3.5 text-[#c8aa6e]" />
            <span>Switch account</span>
            <ChevronDown className={`w-3.5 h-3.5 text-[#8f9ca3] transition-transform duration-200 ${dropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {onOpenAccountsHub && (
            <button
              type="button"
              onClick={onOpenAccountsHub}
              className="flex items-center gap-1 text-xs font-bold text-[#c8aa6e] hover:text-[#f0e6d2] px-2 py-1 rounded-lg hover:bg-white/[0.05] transition cursor-pointer"
            >
              <span>Manage accounts</span>
              <span className="text-sm leading-none">&rarr;</span>
            </button>
          )}
        </div>

        {/* ═══════════════════════════════════════════════
           QUICK SWITCH DROPDOWN POPOVER
           ═══════════════════════════════════════════════ */}
        {dropdownOpen && (
          <div className="absolute top-[calc(100%+8px)] left-0 right-0 z-50 bg-[#061321]/95 border border-[#c8aa6e]/40 rounded-2xl p-3 shadow-[0_16px_40px_rgba(0,0,0,0.85)] backdrop-blur-xl animate-fadeIn">
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
                {onOpenAccountsHub && (
                  <button
                    type="button"
                    onClick={() => {
                      setDropdownOpen(false);
                      onOpenAccountsHub();
                    }}
                    className="mt-2 text-xs font-bold text-[#c8aa6e] hover:underline cursor-pointer"
                  >
                    + Add an account in Accounts Hub
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 max-h-60 overflow-y-auto pr-1">
                {otherAccounts.map((p) => {
                  const tier = (p.rank?.solo?.tier || 'unranked').toLowerCase();
                  const isSwitching = switchingId === p.id;
                  const status = statuses[p.id];
                  const rankText = p.rank?.solo ? accountRankLabel(p.rank.solo) : 'Unranked';

                  return (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-3 p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.05] hover:border-[#c8aa6e]/30 transition group"
                    >
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
                              {p.region || 'EUW1'}
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
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#c8aa6e]/20 hover:bg-[#c8aa6e] text-[#c8aa6e] hover:text-[#010a13] border border-[#c8aa6e]/40 hover:border-[#c8aa6e] text-xs font-bold transition cursor-pointer shrink-0 disabled:opacity-50"
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

            {/* Dropdown Footer */}
            {onOpenAccountsHub && (
              <div className="pt-2.5 mt-2 border-t border-white/[0.08] flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => {
                    setDropdownOpen(false);
                    onOpenAccountsHub();
                  }}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] text-xs font-bold text-[#c8aa6e] transition cursor-pointer"
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>All Accounts & Management Hub &rarr;</span>
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
