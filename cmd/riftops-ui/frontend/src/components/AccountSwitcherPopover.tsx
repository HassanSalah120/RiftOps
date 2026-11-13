import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  CircleUserRound,
  Info,
  Loader2,
  LogIn,
  RefreshCw,
  Save,
  Shield,
  UserCheck,
  Zap,
} from 'lucide-react';
import {
  captureSavedLogin,
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

interface AccountSwitcherPopoverProps {
  activeProfileId?: string;
  onRefreshSnapshot?: () => Promise<void>;
  showToast?: (title: string, message: string, type?: 'info' | 'success' | 'error') => void;
  className?: string;
}

export default function AccountSwitcherPopover({
  activeProfileId,
  onRefreshSnapshot,
  showToast,
  className = '',
}: AccountSwitcherPopoverProps) {
  const { connected: lcuConnected, pageVisible, streamerMode } = useLCUConnection();
  const [isOpen, setIsOpen] = useState(false);
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ProfileSessionStatus>>({});
  const [connectedAccount, setConnectedAccount] = useState<ConnectedLeagueAccount | null>(null);
  const [lcuProfile, setLcuProfile] = useState<LCUProfile | null>(null);
  const [ddVersion, setDdVersion] = useState('');
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [savingSession, setSavingSession] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const switchLock = useRef(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [nextProfiles, nextStatuses, nextConnected, ddragon] = await Promise.all([
        fetchLaunchProfiles().catch(() => []),
        fetchProfileSessionStatuses().catch(() => ({})),
        fetchConnectedLeagueAccount().catch(() => null),
        ddVersion ? Promise.resolve({ version: ddVersion }) : fetchDDragonVersion().catch(() => ({ version: '' })),
      ]);

      setProfiles(nextProfiles);
      setStatuses(nextStatuses);
      setConnectedAccount(nextConnected);
      if (ddragon?.version) setDdVersion(ddragon.version);

      if (lcuConnected && pageVisible) {
        try {
          const live = await fetchLCUProfile();
          setLcuProfile(live);
        } catch {
          setLcuProfile(null);
        }
      }
    } catch {
      // Non-fatal background fetch
    } finally {
      setLoading(false);
    }
  }, [ddVersion, lcuConnected, pageVisible]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Click outside listener
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const activeProfile = profiles.find((p) => p.id === activeProfileId) || profiles[0];

  const handleSwitch = async (profile: LaunchProfile, forceLogin = false) => {
    if (switchLock.current) return;
    switchLock.current = true;
    setSwitchingId(profile.id);
    const profileLabel = streamerMode ? 'profile' : profile.name;
    try {
      const result = await switchLaunchProfile(profile.id, forceLogin);
      await onRefreshSnapshot?.();
      await loadData();
      if (result.verification === 'verified') {
        showToast?.('Switched Account', `Now active on ${profileLabel}.`, 'success');
        setIsOpen(false);
      } else if (result.verification === 'wrong-account') {
        showToast?.('Wrong Account Opened', `Riot opened a different account than ${profileLabel}. Try re-saving.`, 'error');
      } else if (forceLogin) {
        showToast?.('Sign-in Needed', `Please sign into Riot Client with 'Stay signed in' checked for ${profileLabel}.`, 'info');
      } else {
        showToast?.('Account Swapped', `Switched to ${profileLabel}. Verify login in Riot Client.`, 'info');
        setIsOpen(false);
      }
    } catch (err: any) {
      showToast?.('Switch Failed', err?.message || 'Could not switch Riot profiles.', 'error');
    } finally {
      switchLock.current = false;
      setSwitchingId(null);
    }
  };

  const handleSaveCurrent = async () => {
    if (switchLock.current || !activeProfile) return;
    switchLock.current = true;
    setSavingSession(true);
    try {
      await captureSavedLogin(false);
      await loadData();
      showToast?.('Session Saved', `Current Riot login bound to ${streamerMode ? 'profile' : activeProfile.name}.`, 'success');
    } catch (err: any) {
      if (err?.code === 'login-not-persisted') {
        showToast?.('Save Failed', "Cannot save: 'Stay signed in' was not checked in Riot Client. Sign in with 'Stay signed in' checked, then click Save.", 'error');
      } else {
        showToast?.('Save Failed', err?.message || 'Could not capture current Riot login.', 'error');
      }
    } finally {
      switchLock.current = false;
      setSavingSession(false);
    }
  };

  // Label helpers
  const summoner = lcuProfile?.summoner;
  const currentDisplayName = streamerMode
    ? 'Demo Player#EUW'
    : summoner
      ? (summoner.tagLine ? `${summoner.gameName}#${summoner.tagLine}` : summoner.displayName || summoner.gameName)
      : connectedAccount?.riotId || activeProfile?.name || 'Switch Account';

  const avatarUrl = summoner && ddVersion
    ? ddProfileIcon(ddVersion, summoner.profileIconId)
    : undefined;

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => {
          setIsOpen((prev) => !prev);
          if (!isOpen) void loadData();
        }}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-surface/90 hover:bg-surface-hover border border-white/10 hover:border-hextech-gold/40 transition cursor-pointer text-left select-none group shadow-sm"
        title="Quick Account Switcher"
      >
        <div className="w-7 h-7 rounded-lg overflow-hidden bg-black/40 border border-white/10 flex items-center justify-center shrink-0">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <Shield className="w-4 h-4 text-hextech-gold" />
          )}
        </div>
        <div className="flex flex-col min-w-0 pr-1">
          <span className="text-[11px] font-bold text-white group-hover:text-hextech-gold transition truncate max-w-[130px]">
            {currentDisplayName}
          </span>
          <span className="text-[10px] text-text-dim flex items-center gap-1.5 leading-none">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${lcuConnected ? 'bg-emerald-400' : 'bg-slate-500'}`} />
            {lcuConnected ? (activeProfile?.region || 'Connected') : 'League Offline'}
          </span>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-text-dim group-hover:text-white transition duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Floating Popover Menu */}
      {isOpen && (
        <div className="absolute left-0 mt-2 w-80 rounded-2xl bg-surface-elevated/95 border border-hextech-gold/30 shadow-[0_12px_40px_rgba(0,0,0,0.8)] backdrop-blur-xl z-50 overflow-hidden animate-fadeIn">
          {/* Popover Header */}
          <div className="p-3.5 border-b border-white/[0.08] flex items-center justify-between">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-hextech-gold font-bold">Launch Profiles</span>
              <h3 className="text-xs font-black text-white">Switch Riot Account</h3>
            </div>
            <button
              type="button"
              onClick={() => void loadData()}
              disabled={loading}
              className="p-1.5 rounded-lg text-text-dim hover:text-white hover:bg-white/[0.06] transition"
              title="Refresh profiles"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Account List */}
          <div className="max-h-64 overflow-y-auto p-2 space-y-1.5">
            {profiles.length === 0 ? (
              <div className="p-4 text-center text-xs text-text-muted">
                No saved accounts yet. Add profiles in Home &rarr; Accounts.
              </div>
            ) : (
              profiles.map((profile) => {
                const isActive = profile.id === activeProfileId;
                const status = statuses[profile.id];
                const isSwitching = switchingId === profile.id;
                const rankText = profile.rank?.solo ? accountRankLabel(profile.rank.solo) : 'Unranked';

                return (
                  <div
                    key={profile.id}
                    className={`p-2.5 rounded-xl border transition flex items-center justify-between gap-2.5 ${
                      isActive
                        ? 'bg-hextech-gold/10 border-hextech-gold/40'
                        : 'bg-black/30 border-white/[0.06] hover:border-white/20 hover:bg-black/50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-surface border border-white/10 flex items-center justify-center shrink-0">
                        <CircleUserRound className={`w-4 h-4 ${isActive ? 'text-hextech-gold' : 'text-text-muted'}`} />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-bold text-white truncate max-w-[120px]">
                            {streamerMode ? 'Profile' : profile.name}
                          </span>
                          {profile.region && (
                            <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-white/[0.08] text-text-muted">
                              {profile.region}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px] text-text-dim truncate">
                          <span>{rankText !== 'Unranked' ? rankText : (profile.riotId || 'No Riot ID set')}</span>
                          {status?.saved ? (
                            <span className="text-emerald-400 font-bold" title="Saved Riot session is ready">· Ready</span>
                          ) : status?.expired ? (
                            <span className="text-amber-400 font-bold" title="Saved login expired">· Needs Login</span>
                          ) : (
                            <span className="text-text-dim/60 font-medium" title="Login not saved. Selecting will open Riot sign-in.">· Not Saved</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {isActive ? (
                        <span className="px-2 py-1 rounded-lg bg-emerald-500/20 text-emerald-400 font-bold text-[10px] border border-emerald-500/30 flex items-center gap-1">
                          <UserCheck className="w-3 h-3" /> Active
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={isSwitching || Boolean(switchingId)}
                          onClick={() => void handleSwitch(profile)}
                          className={`px-2.5 py-1 rounded-lg border font-bold text-[11px] transition cursor-pointer disabled:opacity-40 flex items-center gap-1 ${
                            status?.saved
                              ? 'bg-hextech-gold/20 hover:bg-hextech-gold/30 text-hextech-gold border-hextech-gold/40'
                              : 'bg-white/[0.06] hover:bg-white/[0.12] text-text-muted hover:text-white border-white/10'
                          }`}
                          title={status?.saved ? '1-click switch account' : 'Switch & open Riot Client sign-in'}
                        >
                          {isSwitching ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : status?.saved ? (
                            <Zap className="w-3 h-3" />
                          ) : (
                            <LogIn className="w-3 h-3" />
                          )}
                          {status?.saved ? 'Switch' : 'Sign In'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Quick Action Footer */}
          <div className="p-2.5 border-t border-white/[0.08] bg-black/40 flex flex-col gap-2">
            {lcuConnected && activeProfile && (
              <button
                type="button"
                disabled={savingSession}
                onClick={() => void handleSaveCurrent()}
                className="w-full px-3 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] text-text-muted hover:text-white border border-white/[0.08] text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40"
              >
                {savingSession ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5 text-hextech-gold" />}
                Save Current Riot Login
              </button>
            )}
            <div className="text-[10px] text-text-dim px-1 flex items-center gap-1.5 leading-tight">
              <Info className="w-3 h-3 text-hextech-gold shrink-0" />
              <span>Check <strong>"Stay signed in"</strong> in Riot Client for 1-click switching.</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
