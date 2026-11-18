import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Edit2,
  Info,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserCheck,
  X,
  Zap,
} from 'lucide-react';
import {
  deleteLaunchProfile,
  exportLaunchProfiles,
  fetchConnectedLeagueAccount,
  fetchLaunchProfiles,
  fetchProfileSessionStatuses,
  importLaunchProfiles,
  saveLaunchProfile,
  switchLaunchProfile,
  type ConnectedLeagueAccount,
  type LaunchProfile,
  type ProfileSessionStatus,
  type QueueRank,
} from '../api';
import { useLCUConnection } from './lcuConnectionContext';
import { accountRankLabel, normalizeRegionLabel } from '../utils/accountRank';
import ConfirmModal from './ConfirmModal';
import type { ConfirmAction } from '../types';
import '../styles/accountsHub.css';

interface AccountsHubPageProps {
  activeProfileId?: string;
  showToast?: (title: string, message: string, type?: 'info' | 'success' | 'error') => void;
  onRefreshSnapshot?: () => Promise<void>;
  streamerMode?: boolean;
}

const TIER_ORDER = [
  'Challenger',
  'Grandmaster',
  'Master',
  'Diamond',
  'Emerald',
  'Platinum',
  'Gold',
  'Silver',
  'Bronze',
  'Iron',
  'Unranked',
] as const;

type TierName = (typeof TIER_ORDER)[number];

const APEX_TIERS = new Set(['Challenger', 'Grandmaster', 'Master']);

const TIER_PALETTES: Record<TierName, { base: string; light: string; dark: string }> = {
  Challenger: { base: '#f7d478', light: '#fff4cc', dark: '#2a6f9a' },
  Grandmaster: { base: '#f25d68', light: '#ffbcc1', dark: '#7d1720' },
  Master: { base: '#c27cf5', light: '#ebcbff', dark: '#5d2a8a' },
  Diamond: { base: '#7d98ff', light: '#cdd8ff', dark: '#2c3d9e' },
  Emerald: { base: '#34d27a', light: '#a6f7c6', dark: '#13643a' },
  Platinum: { base: '#45cbb9', light: '#a6f3e7', dark: '#17675e' },
  Gold: { base: '#e8bd52', light: '#ffe7a3', dark: '#8a6316' },
  Silver: { base: '#b4c3d0', light: '#eef4f9', dark: '#5e6b78' },
  Bronze: { base: '#c48357', light: '#efb489', dark: '#6a3f26' },
  Iron: { base: '#9a8f8a', light: '#c9bdb7', dark: '#4a403c' },
  Unranked: { base: '#6b7487', light: '#9aa3b5', dark: '#2b313d' },
};

const REGIONS = [
  { value: 'all', label: 'All regions' },
  { value: 'EUW1', label: 'Europe West (EUW)' },
  { value: 'EUN1', label: 'Europe Nordic & East (EUNE)' },
  { value: 'NA1', label: 'North America (NA)' },
  { value: 'KR', label: 'Korea (KR)' },
  { value: 'TR1', label: 'Türkiye (TR)' },
  { value: 'RU', label: 'Russia (RU)' },
  { value: 'BR1', label: 'Brazil (BR)' },
  { value: 'LA1', label: 'Latin America North (LAN)' },
  { value: 'LA2', label: 'Latin America South (LAS)' },
  { value: 'OC1', label: 'Oceania (OCE)' },
  { value: 'JP1', label: 'Japan (JP)' },
  { value: 'SG2', label: 'Singapore (SG)' },
  { value: 'PH2', label: 'Philippines (PH)' },
  { value: 'TW2', label: 'Taiwan (TW)' },
  { value: 'VN2', label: 'Vietnam (VN)' },
  { value: 'TH2', label: 'Thailand (TH)' },
  { value: 'ME1', label: 'Middle East (ME)' },
];

function normalizeTier(tier?: string): TierName {
  if (!tier) return 'Unranked';
  const match = TIER_ORDER.find((t) => t.toLowerCase() === tier.trim().toLowerCase());
  return match ?? 'Unranked';
}

function getRankData(profile: LaunchProfile, queue: 'solo' | 'flex'): QueueRank {
  if (queue === 'flex' && profile.rank?.flex) return profile.rank.flex;
  if (profile.rank?.solo) return profile.rank.solo;
  return { tier: 'UNRANKED', leaguePoints: 0 };
}

function calculateLpProgress(rank: QueueRank): number {
  const tier = normalizeTier(rank.tier);
  if (tier === 'Unranked') return 0;
  const lp = rank.leaguePoints || 0;
  if (APEX_TIERS.has(tier)) {
    return Math.max(0.04, Math.min(1, lp / 1000));
  }
  return Math.max(0.04, Math.min(1, lp / 100));
}

function rankScore(rank: QueueRank): number {
  const tier = normalizeTier(rank.tier);
  const tierIdx = TIER_ORDER.indexOf(tier);
  const divMap: Record<string, number> = { I: 1, IV: 4, III: 3, II: 2, '1': 1, '2': 2, '3': 3, '4': 4 };
  const div = rank.division ? divMap[rank.division.toUpperCase()] || 5 : 5;
  const lp = rank.leaguePoints || 0;
  return tierIdx * 10000 + div * 1000 - lp;
}

function parseRiotId(riotId?: string, fallbackName?: string): { name: string; tag: string } {
  const source = (riotId && riotId.includes('#')) ? riotId : (fallbackName && fallbackName.includes('#')) ? fallbackName : '';
  if (source) {
    const parts = source.split('#');
    return { name: parts[0], tag: `#${parts.slice(1).join('#')}` };
  }
  return { name: riotId || fallbackName || 'Summoner', tag: '' };
}

function getSessionInfo(status?: ProfileSessionStatus) {
  if (!status) return { label: 'Checking save…', type: 'pending' as const, tip: 'Checking saved session' };
  if (status.incomplete) return { label: 'Incomplete', type: 'warn' as const, tip: 'Sign into Riot Client with "Stay signed in" checked' };
  if (status.needsRecapture) return { label: 'Re-save needed', type: 'warn' as const, tip: 'Verification updated in Riot Client; re-save needed' };
  if (status.expired) return { label: 'Save expired', type: 'danger' as const, tip: 'Session token expired in Riot Client' };
  if (!status.saved) return { label: 'No saved login', type: 'dim' as const, tip: 'Sign into Riot Client to save 1-click login' };
  if (!status.expiresAt) return { label: 'Ready to launch', type: 'success' as const, tip: 'Verified local save ready to launch' };
  const remaining = new Date(status.expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return { label: 'Expired', type: 'danger' as const, tip: 'Session token expired' };
  const days = Math.max(1, Math.ceil(remaining / 86_400_000));
  return { label: `Ready (${days}d)`, type: 'success' as const, tip: `Verified session token (${days} days remaining)` };
}

export default function AccountsHubPage({
  activeProfileId,
  showToast,
  onRefreshSnapshot,
  streamerMode = false,
}: AccountsHubPageProps) {
  const { connected: leagueConnected } = useLCUConnection();
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ProfileSessionStatus>>({});
  const [loading, setLoading] = useState(true);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [selectedTierFilter, setSelectedTierFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('all');
  const [sortBy, setSortBy] = useState<'rank-desc' | 'rank-asc' | 'lp' | 'name'>('rank-desc');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [queueMode, setQueueMode] = useState<'solo' | 'flex'>('solo');
  const [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<LaunchProfile | null>(null);
  const [connectedAccount, setConnectedAccount] = useState<ConnectedLeagueAccount | null>(null);
  const [modalForm, setModalForm] = useState({
    name: '',
    riotId: '',
    region: 'EUW1',
    accountLabel: '',
    loginUsername: '',
  });

  // Active Menu
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load data
  const loadProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const [profData, statusData, connData] = await Promise.all([
        fetchLaunchProfiles(),
        fetchProfileSessionStatuses().catch(() => ({})),
        fetchConnectedLeagueAccount().catch(() => null),
      ]);
      setProfiles(profData);
      setStatuses(statusData);
      setConnectedAccount(connData?.available ? connData : null);
    } catch (err: any) {
      showToast?.('Error', err?.message || 'Failed to load accounts', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  // Close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.account-card__menu-wrap')) {
        setOpenMenuId(null);
      }
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, []);

  // Rank distribution count
  const distribution = useMemo(() => {
    const counts: Record<TierName, number> = {
      Challenger: 0,
      Grandmaster: 0,
      Master: 0,
      Diamond: 0,
      Emerald: 0,
      Platinum: 0,
      Gold: 0,
      Silver: 0,
      Bronze: 0,
      Iron: 0,
      Unranked: 0,
    };
    for (const p of profiles) {
      const rank = getRankData(p, queueMode);
      const tier = normalizeTier(rank.tier);
      counts[tier] = (counts[tier] || 0) + 1;
    }
    return counts;
  }, [profiles, queueMode]);

  // Filtered and sorted profiles
  const displayedProfiles = useMemo(() => {
    let result = [...profiles];

    // Tier Filter from Sidebar
    if (selectedTierFilter) {
      result = result.filter((p) => {
        const rank = getRankData(p, queueMode);
        return normalizeTier(rank.tier) === selectedTierFilter;
      });
    }

    // Region Filter
    if (selectedRegion !== 'all') {
      result = result.filter((p) => p.region?.toUpperCase() === selectedRegion.toUpperCase());
    }

    // Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.riotId?.toLowerCase().includes(q) ||
          p.accountLabel?.toLowerCase().includes(q) ||
          p.loginUsername?.toLowerCase().includes(q)
      );
    }

    // Sorting
    result.sort((a, b) => {
      const rankA = getRankData(a, queueMode);
      const rankB = getRankData(b, queueMode);

      if (sortBy === 'rank-desc') {
        return rankScore(rankA) - rankScore(rankB);
      }
      if (sortBy === 'rank-asc') {
        return rankScore(rankB) - rankScore(rankA);
      }
      if (sortBy === 'lp') {
        return (rankB.leaguePoints || 0) - (rankA.leaguePoints || 0);
      }
      if (sortBy === 'name') {
        return a.name.localeCompare(b.name);
      }
      return 0;
    });

    return result;
  }, [profiles, selectedTierFilter, selectedRegion, searchQuery, sortBy, queueMode]);

  // Switch execution
  const executeSwitch = async (profile: LaunchProfile) => {
    if (switchingId) return;
    setSwitchingId(profile.id);
    try {
      const res = await switchLaunchProfile(profile.id);
      await loadProfiles();
      await onRefreshSnapshot?.();
      if (res.targetSessionAvailable) {
        showToast?.('Switched Account', `Logged into ${streamerMode ? 'Profile' : profile.name} via session vault.`, 'success');
      } else {
        showToast?.('Sign-in Required', `${streamerMode ? 'Profile' : profile.name} requires manual login. Check 'Stay signed in' in Riot Client.`, 'info');
      }
    } catch (err: any) {
      showToast?.('Switch Failed', err?.message || 'Could not switch accounts', 'error');
    } finally {
      setSwitchingId(null);
    }
  };

  const handleRequestSwitch = (profile: LaunchProfile) => {
    if (profile.id === activeProfileId) return;

    // UX Rule: Safe session interruption guard
    if (leagueConnected) {
      const targetName = streamerMode ? 'profile' : profile.name;
      setConfirmation({
        open: true,
        danger: true,
        title: 'Switch League Account?',
        message: `League of Legends is currently open.\n\nSwitching accounts will close your active Riot Client session to restore "${targetName}".\n\nDo you want to close the active session and switch?`,
        actionLabel: 'Close & Switch',
        onConfirm: () => {
          setConfirmation(null);
          void executeSwitch(profile);
        },
      });
      return;
    }

    void executeSwitch(profile);
  };

  // Copy Riot ID
  const handleCopyRiotId = (text?: string, id?: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    if (id) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    }
    showToast?.('Copied', `Copied ${text} to clipboard`, 'info');
  };

  // Modal open
  const openAddModal = async () => {
    setEditingProfile(null);
    setModalForm({
      name: '',
      riotId: '',
      region: 'EUW1',
      accountLabel: '',
      loginUsername: '',
    });
    try {
      const detected = await fetchConnectedLeagueAccount();
      setConnectedAccount(detected.available ? detected : null);
      if (detected.available && detected.riotId) {
        setModalForm((prev) => ({
          ...prev,
          name: detected.riotId || 'Main Account',
          riotId: detected.riotId || '',
          region: detected.region || prev.region,
        }));
      }
    } catch {
      setConnectedAccount(null);
    }
    setIsModalOpen(true);
  };

  const openEditModal = (profile: LaunchProfile) => {
    setEditingProfile(profile);
    setModalForm({
      name: profile.name,
      riotId: profile.riotId || '',
      region: profile.region || 'EUW1',
      accountLabel: profile.accountLabel || '',
      loginUsername: profile.loginUsername || '',
    });
    setIsModalOpen(true);
  };

  const handleSaveModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalForm.name.trim()) return;
    try {
      await saveLaunchProfile({
        id: editingProfile?.id || '',
        name: modalForm.name.trim(),
        riotId: modalForm.riotId.trim(),
        region: modalForm.region,
        accountLabel: modalForm.accountLabel.trim(),
        loginUsername: modalForm.loginUsername.trim(),
        enabled: true,
        status: editingProfile?.status || 'offline',
        defaultGame: 'lol',
      });
      setIsModalOpen(false);
      await loadProfiles();
      showToast?.('Saved', `Account ${modalForm.name} saved successfully`, 'success');
    } catch (err: any) {
      showToast?.('Save Failed', err?.message || 'Could not save profile', 'error');
    }
  };

  const handleDelete = (profile: LaunchProfile) => {
    if (profiles.length <= 1) {
      showToast?.('Cannot Delete', 'You must have at least one account profile.', 'error');
      return;
    }
    const name = streamerMode ? 'this account' : profile.name;
    setConfirmation({
      open: true,
      danger: true,
      title: 'Delete Account Profile?',
      message: `Delete ${name} and its saved session credentials?\nThis action cannot be undone.`,
      actionLabel: 'Delete Profile',
      onConfirm: async () => {
        setConfirmation(null);
        try {
          await deleteLaunchProfile(profile.id);
          await loadProfiles();
          await onRefreshSnapshot?.();
          showToast?.('Deleted', `Account ${name} removed.`, 'success');
        } catch (err: any) {
          showToast?.('Delete Failed', err?.message || 'Failed to delete profile', 'error');
        }
      },
    });
  };

  // Export JSON
  const handleExport = async () => {
    try {
      const data = await exportLaunchProfiles();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `riftops-accounts-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast?.('Exported', 'Account profiles backup saved.', 'success');
    } catch (err: any) {
      showToast?.('Export Failed', err?.message || 'Could not export profiles', 'error');
    }
  };

  // Import JSON
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('File does not contain a valid profile array');
      await importLaunchProfiles(parsed);
      await loadProfiles();
      await onRefreshSnapshot?.();
      showToast?.('Imported', `Successfully imported ${parsed.length} profiles.`, 'success');
    } catch (err: any) {
      showToast?.('Import Failed', err?.message || 'Invalid backup file', 'error');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <>
      {confirmation && <ConfirmModal action={confirmation} onClose={() => setConfirmation(null)} />}

      <div className="accounts-layout">
        {/* ═══════════════════════════════════════════════
           LEFT SIDEBAR: RANK DISTRIBUTION & BACKUPS
           ═══════════════════════════════════════════════ */}
        <aside className="accounts-sidebar" aria-label="Accounts and Rank Filters">
          <div className="accounts-sidebar__add-wrap">
            <button
              type="button"
              onClick={openAddModal}
              className="accounts-sidebar__add-btn"
              title="Add a new League account"
            >
              <Plus className="w-4 h-4 text-[#010a13]" />
              <span>Add Account</span>
            </button>
          </div>

          <div className="accounts-sidebar__dist-title">
            <span>Rank Distribution</span>
            <span className="accounts-sidebar__dist-count">{profiles.length} Total</span>
          </div>

          <div className="accounts-sidebar__ranks">
            <button
              type="button"
              onClick={() => setSelectedTierFilter(null)}
              className={`accounts-sidebar__rank-item ${selectedTierFilter === null ? 'is-selected' : ''}`}
            >
              <div className="accounts-sidebar__rank-left">
                <span className="w-3.5 h-3.5 rounded-full border border-white/20 bg-white/5 flex items-center justify-center text-[9px]">
                  *
                </span>
                <span className="accounts-sidebar__rank-name">All Tiers</span>
              </div>
              <span className="accounts-sidebar__rank-count">{profiles.length}</span>
            </button>

            {TIER_ORDER.map((tier) => {
              const count = distribution[tier];
              const isSelected = selectedTierFilter === tier;
              const palette = TIER_PALETTES[tier];

              return (
                <button
                  type="button"
                  key={tier}
                  onClick={() => setSelectedTierFilter(isSelected ? null : tier)}
                  className={`accounts-sidebar__rank-item ${isSelected ? 'is-selected' : ''} ${count === 0 ? 'is-zero' : ''}`}
                >
                  <div className="accounts-sidebar__rank-left">
                    <img
                      src={`/league/crests/${tier.toLowerCase()}.svg`}
                      alt=""
                      className="accounts-sidebar__rank-crest"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                    <span
                      className="accounts-sidebar__rank-name"
                      style={{ color: count > 0 ? palette.base : undefined }}
                    >
                      {tier}
                    </span>
                  </div>
                  <span className={`accounts-sidebar__rank-count ${count > 0 ? 'is-nonzero' : ''}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="accounts-sidebar__footer">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImportFile}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="accounts-sidebar__footer-btn"
              title="Import accounts from JSON backup"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Import</span>
            </button>
            <button
              type="button"
              onClick={handleExport}
              className="accounts-sidebar__footer-btn"
              title="Export accounts to JSON backup"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export</span>
            </button>
          </div>
        </aside>

        {/* ═══════════════════════════════════════════════
           MAIN HUB AREA: SEARCH, TOOLBAR, & ACCOUNT CARDS
           ═══════════════════════════════════════════════ */}
        <main className="accounts-main">
          {/* Header Title & Queue Mode Toggle */}
          <div className="accounts-header">
            <div>
              <div className="accounts-header__eyebrow">
                {selectedTierFilter ? `${selectedTierFilter.toUpperCase()} ACCOUNTS` : 'HEX-TECH ACCOUNT SWITCHER'}
              </div>
              <h1 className="accounts-header__title">Accounts Hub</h1>
            </div>

            <div className="accounts-header__meta">
              <div className="flex items-center gap-1.5 p-1 rounded-xl bg-white/[0.04] border border-white/[0.08]">
                <button
                  type="button"
                  onClick={() => setQueueMode('solo')}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                    queueMode === 'solo'
                      ? 'bg-[#c8aa6e] text-[#010a13] shadow-[0_0_10px_rgba(200,170,110,0.3)]'
                      : 'text-[#8f9ca3] hover:text-[#f0e6d2]'
                  }`}
                >
                  Ranked Solo/Duo
                </button>
                <button
                  type="button"
                  onClick={() => setQueueMode('flex')}
                  className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                    queueMode === 'flex'
                      ? 'bg-[#c8aa6e] text-[#010a13] shadow-[0_0_10px_rgba(200,170,110,0.3)]'
                      : 'text-[#8f9ca3] hover:text-[#f0e6d2]'
                  }`}
                >
                  Ranked Flex
                </button>
              </div>

              <div className="flex items-center gap-2">
                <span className="accounts-header__count">
                  {displayedProfiles.length} of {profiles.length} account{profiles.length === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  onClick={() => void loadProfiles()}
                  disabled={loading}
                  className="p-1 rounded-lg text-[#8f9ca3] hover:text-[#f0e6d2] hover:bg-white/[0.05] transition cursor-pointer"
                  title="Refresh profiles"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>
          </div>

          {/* Filtering and Search Toolbar */}
          <div className="accounts-toolbar">
            <div className="accounts-toolbar__search">
              <Search className="accounts-toolbar__search-icon" />
              <input
                type="text"
                placeholder="Search name, tag, or login username…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8f9ca3] hover:text-[#f0e6d2] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="accounts-toolbar__controls">
              {/* Region Filter */}
              <div className="accounts-toolbar__select-wrap">
                <select
                  value={selectedRegion}
                  onChange={(e) => setSelectedRegion(e.target.value)}
                  className="accounts-toolbar__select"
                >
                  {REGIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Sort Dropdown */}
              <div className="accounts-toolbar__select-wrap">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="accounts-toolbar__select"
                >
                  <option value="rank-desc">Sort: Highest Rank</option>
                  <option value="rank-asc">Sort: Lowest Rank</option>
                  <option value="lp">Sort: League Points (LP)</option>
                  <option value="name">Sort: Name (A-Z)</option>
                </select>
              </div>

              {/* View Mode Toggle */}
              <div className="accounts-toolbar__view-toggle">
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`accounts-toolbar__view-btn ${viewMode === 'grid' ? 'is-active' : ''}`}
                  title="Hextech Card Grid View"
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className={`accounts-toolbar__view-btn ${viewMode === 'list' ? 'is-active' : ''}`}
                  title="Compact Table View"
                >
                  <List className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Account Cards Container */}
          {displayedProfiles.length === 0 ? (
            <div className="accounts-empty-state">
              <Info className="w-10 h-10 text-[#c8aa6e]/60 mb-2" />
              <h3>No accounts match your criteria</h3>
              <p>Try clearing your search query or selecting "All Tiers" in the left sidebar.</p>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSelectedTierFilter(null);
                  setSelectedRegion('all');
                }}
                className="mt-3 px-4 py-1.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs font-bold text-[#f0e6d2] transition cursor-pointer"
              >
                Reset All Filters
              </button>
            </div>
          ) : viewMode === 'grid' ? (
            /* ═══════════════════════════════════════════════
               GRID VIEW: COMMANDING HEXTECH HERO CARDS
               ═══════════════════════════════════════════════ */
            <div className="accounts-grid">
              {displayedProfiles.map((profile) => {
                const rank = getRankData(profile, queueMode);
                const tier = normalizeTier(rank.tier);
                const progress = calculateLpProgress(rank);
                const isActive = profile.id === activeProfileId;
                const isSwitching = switchingId === profile.id;
                const status = statuses[profile.id];
                const sessionInfo = getSessionInfo(status);

                // Connected in live client check
                const isConnectedInClient = Boolean(
                  connectedAccount?.available &&
                  connectedAccount?.riotId &&
                  profile.riotId &&
                  connectedAccount.riotId.toLowerCase().trim() === profile.riotId.toLowerCase().trim()
                );

                const tierPalette = TIER_PALETTES[tier] || TIER_PALETTES.Unranked;
                const parsedRiotId = parseRiotId(
                  streamerMode ? 'Demo Player#EUW' : profile.riotId,
                  profile.name
                );
                const fullName = streamerMode ? 'Demo Player#EUW' : (profile.riotId || profile.name);

                // Secondary queue rank
                const secondaryRank = queueMode === 'solo' ? profile.rank?.flex : profile.rank?.solo;
                const secondaryLabel = secondaryRank ? accountRankLabel(secondaryRank) : null;

                return (
                  <article
                    key={profile.id}
                    className={`account-card ${isActive ? 'is-active' : ''}`}
                    style={{
                      '--tier-base': tierPalette.base,
                      '--tier-light': tierPalette.light,
                      '--tier-dark': tierPalette.dark,
                      '--tier-glow': `${tierPalette.base}33`,
                    } as React.CSSProperties}
                  >
                    {/* Corner Hextech Accent Notches */}
                    <span className="account-card__corner account-card__corner--tl" />
                    <span className="account-card__corner account-card__corner--tr" />
                    <span className="account-card__corner account-card__corner--bl" />
                    <span className="account-card__corner account-card__corner--br" />

                    {/* ═══════════════════════════════════════
                       TOP SECTION: IDENTITY & STATE BADGES
                       ═══════════════════════════════════════ */}
                    <div className="account-card__header">
                      <div className="account-card__identity">
                        {/* Name + Tag + Copy button */}
                        <div className="account-card__name-row">
                          <span className="account-card__summoner-name" title={fullName}>
                            {parsedRiotId.name}
                          </span>
                          {parsedRiotId.tag && (
                            <span className="account-card__tag">{parsedRiotId.tag}</span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleCopyRiotId(fullName, profile.id)}
                            className="account-card__copy-btn"
                            title="Copy Riot ID"
                          >
                            {copiedId === profile.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>

                        {/* Badges / Chips Row */}
                        <div className="account-card__meta-row">
                          <span className="account-card__chip account-card__chip-region">
                            {normalizeRegionLabel(profile.region)}
                          </span>

                          {/* Selected in RiftOps Badge */}
                          {isActive && (
                            <span
                              className="account-card__chip account-card__chip-selected"
                              title="Active selection in RiftOps profile store"
                            >
                              <Check className="w-3 h-3 text-[#0ac8b9]" />
                              <span>Selected</span>
                            </span>
                          )}

                          {/* Authenticated in League Client Badge */}
                          {isConnectedInClient && (
                            <span
                              className="account-card__chip account-card__chip-client"
                              title="Currently authenticated and running in League Client"
                            >
                              <span className="account-card__pulse-dot" />
                              <span>In Client</span>
                            </span>
                          )}

                          {/* Session Vault Status Badge */}
                          <span
                            className={`account-card__chip account-card__chip-${sessionInfo.type}`}
                            title={sessionInfo.tip}
                          >
                            {sessionInfo.type === 'success' && <ShieldCheck className="w-3 h-3 text-[#0ac8b9]" />}
                            {sessionInfo.type === 'warn' && <AlertTriangle className="w-3 h-3 text-amber-400" />}
                            {sessionInfo.type === 'dim' && <Lock className="w-3 h-3 text-[#8f9ca3]" />}
                            <span>{sessionInfo.label}</span>
                          </span>

                          {profile.accountLabel && (
                            <span className="account-card__chip account-card__chip-label truncate max-w-[110px]" title={profile.accountLabel}>
                              {profile.accountLabel}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Kebab / Actions Menu */}
                      <div className="relative account-card__menu-wrap">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuId(openMenuId === profile.id ? null : profile.id);
                          }}
                          className="account-card__menu-btn"
                          title="Account actions"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>

                        {openMenuId === profile.id && (
                          <div className="absolute right-0 mt-1 w-44 rounded-xl bg-[#071320]/95 border border-[#c8aa6e]/30 shadow-2xl backdrop-blur-xl z-30 p-1 flex flex-col gap-0.5 text-xs">
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuId(null);
                                openEditModal(profile);
                              }}
                              className="flex items-center gap-2 px-3 py-2 text-[#aebbc1] hover:text-white hover:bg-white/10 rounded cursor-pointer transition text-left"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                              <span>Edit Account</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuId(null);
                                handleRequestSwitch(profile);
                              }}
                              className="flex items-center gap-2 px-3 py-2 text-[#aebbc1] hover:text-white hover:bg-white/10 rounded cursor-pointer transition text-left"
                            >
                              <Zap className="w-3.5 h-3.5 text-[#c8aa6e]" />
                              <span>Switch Now</span>
                            </button>
                            <div className="h-px bg-white/10 my-0.5" />
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuId(null);
                                handleDelete(profile);
                              }}
                              className="flex items-center gap-2 px-3 py-2 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded cursor-pointer transition text-left"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Delete</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* ═══════════════════════════════════════
                       CENTER SECTION: HERO RANK EMBLEM & LP
                       ═══════════════════════════════════════ */}
                    <div className="account-card__hero">
                      {/* Large Ranked Wing (130px Focal Point) */}
                      <div className="account-card__wing-hero">
                        <img
                          src={`/league/ranks/${tier.toLowerCase()}.png`}
                          alt={tier}
                          className="account-card__wing-img"
                          onError={(e) => {
                            e.currentTarget.src = '/league/ranks/unranked.png';
                          }}
                        />
                      </div>

                      {/* Rank Title, LP, and Progress Bar */}
                      <div className="account-card__rank-details">
                        <div className="account-card__queue-pill">
                          {queueMode === 'solo' ? 'SOLO / DUO' : 'FLEX 5V5'}
                        </div>
                        <div className="account-card__tier-title" style={{ color: tierPalette.base }}>
                          {tier.toUpperCase()}
                          {!APEX_TIERS.has(tier) && rank.division ? ` ${rank.division}` : ''}
                        </div>
                        <div className="account-card__lp-readout">
                          {tier === 'Unranked' ? 'Unranked' : `${(rank.leaguePoints || 0).toLocaleString()} LP`}
                        </div>

                        {tier !== 'Unranked' && (
                          <div className="account-card__lp-track">
                            <div
                              className="account-card__lp-bar-fill"
                              style={{
                                width: `${Math.round(progress * 100)}%`,
                                background: `linear-gradient(90deg, ${tierPalette.dark}, ${tierPalette.base}, ${tierPalette.light})`,
                                boxShadow: `0 0 10px ${tierPalette.base}`,
                              }}
                            />
                          </div>
                        )}

                        {secondaryLabel && (
                          <div className="account-card__secondary-rank">
                            <span>{queueMode === 'solo' ? 'Flex' : 'Solo'}:</span>
                            <strong>{secondaryLabel}</strong>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* ═══════════════════════════════════════
                       BOTTOM SECTION: BALANCED ACTION ROW
                       ═══════════════════════════════════════ */}
                    <div className="account-card__footer">
                      {isActive ? (
                        <button
                          type="button"
                          disabled
                          className="account-card__btn-login is-active-btn"
                          title="Currently active in RiftOps"
                        >
                          <UserCheck className="w-4 h-4 text-[#0ac8b9]" />
                          <span>ACTIVE IN RIFTOPS</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleRequestSwitch(profile)}
                          disabled={switchingId !== null}
                          className="account-card__btn-login"
                          title={status?.saved ? '1-click session restore' : 'Switch & sign in'}
                        >
                          {isSwitching ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Zap className="w-4 h-4 text-[#c8aa6e]" />
                          )}
                          <span>{isSwitching ? 'SWITCHING…' : '> LOG IN'}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => openEditModal(profile)}
                        className="account-card__btn-edit"
                        title="Edit account details"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            /* ═══════════════════════════════════════════════
               LIST VIEW: HIGH-DENSITY COMPACT TABLE
               ═══════════════════════════════════════════════ */
            <div className="accounts-list">
              {displayedProfiles.map((profile) => {
                const rank = getRankData(profile, queueMode);
                const tier = normalizeTier(rank.tier);
                const isActive = profile.id === activeProfileId;
                const isSwitching = switchingId === profile.id;
                const status = statuses[profile.id];
                const sessionInfo = getSessionInfo(status);
                const tierPalette = TIER_PALETTES[tier] || TIER_PALETTES.Unranked;
                const fullName = streamerMode ? 'Demo Player#EUW' : (profile.riotId || profile.name);

                return (
                  <article
                    key={profile.id}
                    className={`account-card ${isActive ? 'is-active' : ''}`}
                    style={{
                      '--tier-base': tierPalette.base,
                    } as React.CSSProperties}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-12 h-12 flex items-center justify-center shrink-0">
                        <img
                          src={`/league/ranks/${tier.toLowerCase()}.png`}
                          alt={tier}
                          className="max-h-full max-w-full object-contain"
                          onError={(e) => {
                            e.currentTarget.src = '/league/ranks/unranked.png';
                          }}
                        />
                      </div>
                      <div className="min-w-0 flex flex-col">
                        <div className="flex items-center gap-2">
                          <strong className="text-sm font-bold text-[#f0e6d2] truncate">
                            {fullName}
                          </strong>
                          <span className="account-card__chip account-card__chip-region">
                            {normalizeRegionLabel(profile.region)}
                          </span>
                        </div>
                        <span className="text-[11px] text-[#8f9ca3] truncate">
                          {profile.accountLabel || profile.loginUsername || 'No note'}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col">
                      <span className="text-xs font-bold" style={{ color: tierPalette.base }}>
                        {tier.toUpperCase()} {!APEX_TIERS.has(tier) && rank.division ? rank.division : ''}
                      </span>
                      <span className="text-[11px] text-[#a09b8c]">
                        {tier === 'Unranked' ? 'Unranked' : `${rank.leaguePoints || 0} LP`}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className={`account-card__chip account-card__chip-${sessionInfo.type}`}>
                        {sessionInfo.label}
                      </span>
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      {isActive ? (
                        <button type="button" disabled className="account-card__btn-login is-active-btn px-4">
                          <UserCheck className="w-3.5 h-3.5 text-[#0ac8b9]" />
                          <span>Active</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleRequestSwitch(profile)}
                          disabled={switchingId !== null}
                          className="account-card__btn-login px-4"
                        >
                          {isSwitching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                          <span>{isSwitching ? '…' : 'Switch'}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openEditModal(profile)}
                        className="account-card__btn-edit"
                        title="Edit profile"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </main>
      </div>

      {/* ═══════════════════════════════════════════════
         ADD / EDIT ACCOUNT MODAL
         ═══════════════════════════════════════════════ */}
      {isModalOpen && (
        <div className="accounts-modal-backdrop" onClick={() => setIsModalOpen(false)}>
          <div className="accounts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="accounts-modal__header">
              <h3>{editingProfile ? 'Edit Account' : 'Add Account'}</h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="accounts-modal__close-btn"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {connectedAccount?.available && !editingProfile && (
              <div className="accounts-modal__detected">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#0ac8b9] animate-pulse" />
                  <strong>Connected League Account Detected</strong>
                </div>
                <p className="text-xs text-[#aebbc1] mt-1">
                  Found <strong>{connectedAccount.riotId}</strong> on <strong>{normalizeRegionLabel(connectedAccount.region)}</strong>.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setModalForm((prev) => ({
                      ...prev,
                      name: connectedAccount.riotId || prev.name,
                      riotId: connectedAccount.riotId || prev.riotId,
                      region: connectedAccount.region || prev.region,
                    }));
                  }}
                  className="mt-2 text-xs font-bold text-[#c8aa6e] hover:underline cursor-pointer"
                >
                  Use Connected Account Details
                </button>
              </div>
            )}

            <form onSubmit={handleSaveModal} className="accounts-modal__form">
              <div className="accounts-modal__field">
                <label>Profile Nickname *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Main, Smurf, Stream Acc"
                  value={modalForm.name}
                  onChange={(e) => setModalForm({ ...modalForm, name: e.target.value })}
                />
              </div>

              <div className="accounts-modal__field">
                <label>Riot ID (GameName#Tag) *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Faker#KR1"
                  value={modalForm.riotId}
                  onChange={(e) => setModalForm({ ...modalForm, riotId: e.target.value })}
                />
              </div>

              <div className="accounts-modal__field">
                <label>Region Server *</label>
                <select
                  value={modalForm.region}
                  onChange={(e) => setModalForm({ ...modalForm, region: e.target.value })}
                >
                  {REGIONS.filter((r) => r.value !== 'all').map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="accounts-modal__field">
                <label>Sign-in Username (Optional)</label>
                <input
                  type={streamerMode ? 'password' : 'text'}
                  placeholder="For reference only"
                  value={modalForm.loginUsername}
                  onChange={(e) => setModalForm({ ...modalForm, loginUsername: e.target.value })}
                />
              </div>

              <div className="accounts-modal__field">
                <label>Label / Note (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Ranked duo with Alex"
                  value={modalForm.accountLabel}
                  onChange={(e) => setModalForm({ ...modalForm, accountLabel: e.target.value })}
                />
              </div>

              <div className="accounts-modal__actions">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="accounts-modal__btn-secondary"
                >
                  Cancel
                </button>
                <button type="submit" className="accounts-modal__btn-primary">
                  {editingProfile ? 'Save Changes' : 'Add Profile'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
