import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CircleUserRound,
  Copy,
  Download,
  Edit2,
  Info,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  LogIn,
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
  // Lower score = higher rank
  return tierIdx * 10000 + div * 1000 - lp;
}

export default function AccountsHubPage({
  activeProfileId,
  showToast,
  onRefreshSnapshot,
  streamerMode = false,
}: AccountsHubPageProps) {
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
      const [profData, statusData] = await Promise.all([
        fetchLaunchProfiles(),
        fetchProfileSessionStatuses().catch(() => ({})),
      ]);
      setProfiles(profData);
      setStatuses(statusData);
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

  // Switch profile
  const handleSwitch = async (profile: LaunchProfile) => {
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
        ...(editingProfile || {}),
        name: modalForm.name.trim(),
        riotId: modalForm.riotId.trim(),
        region: modalForm.region,
        accountLabel: modalForm.accountLabel.trim(),
        loginUsername: modalForm.loginUsername.trim(),
      });
      setIsModalOpen(false);
      await loadProfiles();
      showToast?.('Account Saved', `Saved ${modalForm.name}`, 'success');
    } catch (err: any) {
      showToast?.('Save Failed', err?.message || 'Failed to save account', 'error');
    }
  };

  const handleDelete = async (profile: LaunchProfile) => {
    if (!confirm(`Delete profile "${profile.name}"? Saved session vault will also be removed.`)) return;
    try {
      await deleteLaunchProfile(profile.id);
      await loadProfiles();
      showToast?.('Account Deleted', `Deleted ${profile.name}`, 'info');
    } catch (err: any) {
      showToast?.('Delete Failed', err?.message || 'Could not delete profile', 'error');
    }
  };

  // Export Profiles
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
      showToast?.('Exported', 'Saved account backup to JSON file.', 'success');
    } catch (err: any) {
      showToast?.('Export Failed', err?.message || 'Could not export profiles', 'error');
    }
  };

  // Import Profiles
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('Invalid JSON format: expected an array of accounts');
      await importLaunchProfiles(parsed);
      await loadProfiles();
      showToast?.('Import Succeeded', `Imported ${parsed.length} accounts.`, 'success');
    } catch (err: any) {
      showToast?.('Import Failed', err?.message || 'Invalid backup file', 'error');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="accounts-hub">
      {/* ─────────────────────────────────────────────────────────────
         SIDEBAR: RANK DISTRIBUTION & UTILITIES
         ───────────────────────────────────────────────────────────── */}
      <aside className="accounts-sidebar">
        <button
          type="button"
          onClick={openAddModal}
          className="accounts-sidebar__add-btn"
          title="Add a new League account"
        >
          <Plus className="w-4 h-4 text-hextech-gold" />
          <span>Add Account</span>
        </button>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="accounts-sidebar__title mb-0">Rank Distribution</h4>
            {selectedTierFilter && (
              <button
                type="button"
                onClick={() => setSelectedTierFilter(null)}
                className="text-[10px] text-hextech-gold hover:underline cursor-pointer bg-transparent border-0 p-0"
              >
                Clear
              </button>
            )}
          </div>

          <div className="accounts-sidebar__dist-list">
            {TIER_ORDER.map((tier) => {
              const count = distribution[tier] || 0;
              const isActive = selectedTierFilter === tier;
              const isZero = count === 0;

              return (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setSelectedTierFilter(isActive ? null : tier)}
                  className={`accounts-sidebar__dist-row ${isActive ? 'is-active' : ''} ${isZero ? 'is-zero' : ''}`}
                  title={`Filter by ${tier} (${count} accounts)`}
                >
                  <img
                    src={`/league/crests/${tier.toLowerCase()}.svg`}
                    alt={tier}
                    className="accounts-sidebar__dist-icon"
                    onError={(e) => {
                      (e.currentTarget as HTMLElement).style.display = 'none';
                    }}
                  />
                  <span className="accounts-sidebar__dist-name">{tier}</span>
                  <span className="accounts-sidebar__dist-count">{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Sidebar Utilities */}
        <div className="accounts-sidebar__footer">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="accounts-sidebar__footer-link"
            title="Import accounts from JSON backup"
          >
            <Upload className="w-4 h-4 text-hextech-gold" />
            <span>Import Accounts</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImportFile}
            className="hidden"
          />

          <button
            type="button"
            onClick={handleExport}
            className="accounts-sidebar__footer-link"
            title="Export accounts to JSON backup"
          >
            <Download className="w-4 h-4 text-hextech-gold" />
            <span>Export Accounts</span>
          </button>

          <div className="text-[10px] text-text-dim px-2 pt-2 leading-tight">
            <span>RiftOps Session Vault v3.5 · Ban-Safe DPAPI</span>
          </div>
        </div>
      </aside>

      {/* ─────────────────────────────────────────────────────────────
         MAIN SECTION: TOOLBAR & ACCOUNT CARDS
         ───────────────────────────────────────────────────────────── */}
      <main className="accounts-main">
        {/* Top Header */}
        <header className="accounts-header">
          <div>
            <div className="accounts-header__eyebrow">
              {queueMode === 'solo' ? 'Ranked Solo / Duo' : 'Ranked Flex'}
            </div>
            <h1 className="accounts-header__title">Accounts</h1>
          </div>

          <div className="accounts-header__meta">
            <div className="flex items-center gap-3">
              {/* Queue Mode Selector */}
              <div className="flex items-center bg-black/40 border border-white/10 rounded p-0.5">
                <button
                  type="button"
                  onClick={() => setQueueMode('solo')}
                  className={`px-2.5 py-1 text-xs font-bold rounded transition cursor-pointer ${
                    queueMode === 'solo'
                      ? 'bg-hextech-gold/20 text-hextech-gold border border-hextech-gold/30'
                      : 'text-text-dim hover:text-white'
                  }`}
                >
                  Solo / Duo
                </button>
                <button
                  type="button"
                  onClick={() => setQueueMode('flex')}
                  className={`px-2.5 py-1 text-xs font-bold rounded transition cursor-pointer ${
                    queueMode === 'flex'
                      ? 'bg-hextech-gold/20 text-hextech-gold border border-hextech-gold/30'
                      : 'text-text-dim hover:text-white'
                  }`}
                >
                  Flex
                </button>
              </div>

              <button
                type="button"
                onClick={loadProfiles}
                disabled={loading}
                className="p-1.5 rounded text-text-dim hover:text-white hover:bg-white/10 transition cursor-pointer"
                title="Refresh accounts & ranks"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <span className="accounts-header__count">
              {displayedProfiles.length} of {profiles.length} accounts
            </span>
          </div>
        </header>

        {/* Toolbar */}
        <div className="accounts-toolbar">
          {/* Search Bar */}
          <div className="accounts-toolbar__search">
            <Search className="accounts-toolbar__search-icon" />
            <input
              type="text"
              placeholder="Search name, tag or account ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-dim hover:text-white cursor-pointer bg-transparent border-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Region Dropdown */}
          <select
            value={selectedRegion}
            onChange={(e) => setSelectedRegion(e.target.value)}
            className="accounts-toolbar__select"
            title="Filter by server region"
          >
            {REGIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>

          {/* Sort Dropdown */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="accounts-toolbar__select"
            title="Sort accounts"
          >
            <option value="rank-desc">Sort: Highest Rank</option>
            <option value="rank-asc">Sort: Lowest Rank</option>
            <option value="lp">Sort: Highest LP</option>
            <option value="name">Sort: Name (A-Z)</option>
          </select>

          {/* View Mode Toggle */}
          <div className="accounts-toolbar__view-toggle">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`accounts-toolbar__view-btn ${viewMode === 'grid' ? 'is-active' : ''}`}
              title="Grid view"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`accounts-toolbar__view-btn ${viewMode === 'list' ? 'is-active' : ''}`}
              title="List view"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Account Cards */}
        {displayedProfiles.length === 0 ? (
          <div className="p-16 text-center border border-white/5 bg-black/20 rounded-xl my-4">
            <CircleUserRound className="w-12 h-12 text-hextech-gold/40 mx-auto mb-3" />
            <h3 className="text-base font-bold text-white mb-1">No Accounts Found</h3>
            <p className="text-xs text-text-dim max-w-sm mx-auto mb-4">
              {searchQuery || selectedTierFilter || selectedRegion !== 'all'
                ? 'Try adjusting your search or tier filter.'
                : 'Click "Add Account" to add your first League of Legends account.'}
            </p>
            {(searchQuery || selectedTierFilter || selectedRegion !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSelectedTierFilter(null);
                  setSelectedRegion('all');
                }}
                className="px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white rounded text-xs font-bold transition cursor-pointer"
              >
                Reset All Filters
              </button>
            )}
          </div>
        ) : (
          <div className={viewMode === 'grid' ? 'accounts-grid' : 'accounts-list'}>
            {displayedProfiles.map((profile) => {
              const isActive = profile.id === activeProfileId;
              const status = statuses[profile.id];
              const rank = getRankData(profile, queueMode);
              const tier = normalizeTier(rank.tier);
              const palette = TIER_PALETTES[tier];
              const progress = calculateLpProgress(rank);
              const isSwitching = switchingId === profile.id;

              // Parse display name and tagline
              const riotId = profile.riotId || profile.name;
              const [rawName, rawTag] = riotId.includes('#') ? riotId.split('#') : [riotId, ''];
              const displayName = streamerMode ? 'Hidden Account' : rawName;
              const displayTag = streamerMode ? '#0000' : rawTag ? `#${rawTag}` : '';

              return (
                <article
                  key={profile.id}
                  className={`account-card ${isActive ? 'is-active' : ''}`}
                  style={
                    {
                      '--tier-color': palette.base,
                      '--tier-light': palette.light,
                      '--tier-dark': palette.dark,
                    } as React.CSSProperties
                  }
                >
                  {/* Card Header */}
                  <div className="account-card__header">
                    <div className="account-card__identity">
                      <div className="flex items-center gap-1.5">
                        <span className="account-card__name" title={riotId}>
                          {displayName}
                        </span>
                        {displayTag && <span className="account-card__tag">{displayTag}</span>}
                        {profile.riotId && (
                          <button
                            type="button"
                            onClick={() => handleCopyRiotId(profile.riotId, profile.id)}
                            className="p-1 text-text-dim hover:text-white transition cursor-pointer bg-transparent border-0"
                            title="Copy Riot ID"
                          >
                            {copiedId === profile.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                      </div>

                      <div className="account-card__meta-row">
                        {profile.region && (
                          <span className="account-card__chip account-card__chip-region">
                            {profile.region.replace(/\d+$/, '')}
                          </span>
                        )}
                        {profile.accountLabel && (
                          <span className="account-card__chip account-card__chip-label">
                            {profile.accountLabel}
                          </span>
                        )}
                        {status?.saved ? (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-bold"
                            title="Encrypted session vault is ready for 1-click launch"
                          >
                            <ShieldCheck className="w-3 h-3" />
                            <span>Ready</span>
                          </span>
                        ) : status?.expired ? (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] text-amber-400 font-bold"
                            title="Session expired, fresh sign-in required"
                          >
                            <AlertTriangle className="w-3 h-3" />
                            <span>Expired</span>
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] text-text-dim/70"
                            title="Sign in with 'Stay signed in' to enable 1-click swap"
                          >
                            <Lock className="w-3 h-3" />
                            <span>Not Saved</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Context Menu */}
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
                        <div className="absolute right-0 mt-1 w-44 rounded-xl bg-surface-elevated/95 border border-hextech-gold/30 shadow-2xl backdrop-blur-xl z-30 p-1 flex flex-col gap-0.5 text-xs">
                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenuId(null);
                              openEditModal(profile);
                            }}
                            className="flex items-center gap-2 px-3 py-2 text-text-dim hover:text-white hover:bg-white/10 rounded cursor-pointer transition text-left"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                            <span>Edit Account</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenuId(null);
                              void handleSwitch(profile);
                            }}
                            className="flex items-center gap-2 px-3 py-2 text-text-dim hover:text-white hover:bg-white/10 rounded cursor-pointer transition text-left"
                          >
                            <Zap className="w-3.5 h-3.5 text-hextech-gold" />
                            <span>Switch Now</span>
                          </button>
                          <div className="h-px bg-white/10 my-0.5" />
                          <button
                            type="button"
                            onClick={() => {
                              setOpenMenuId(null);
                              void handleDelete(profile);
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

                  {/* Card Rank Center */}
                  <div className="account-card__rank">
                    <div className="account-card__wing-wrap">
                      <img
                        src={`/league/ranks/${tier.toLowerCase()}.png`}
                        alt={tier}
                        className="account-card__wing-img"
                        onError={(e) => {
                          e.currentTarget.src = '/league/ranks/unranked.png';
                        }}
                      />
                    </div>

                    <div className="account-card__rank-info">
                      <span className="account-card__tier-name">
                        {tier.toUpperCase()}
                        {!APEX_TIERS.has(tier) && rank.division ? ` ${rank.division}` : ''}
                      </span>
                      <span className="account-card__lp-text">
                        {tier === 'Unranked' ? 'Placement' : `${rank.leaguePoints || 0} LP`}
                      </span>
                      {tier !== 'Unranked' && (
                        <div className="account-card__lp-bar">
                          <div
                            className="account-card__lp-bar-fill"
                            style={{ width: `${Math.round(progress * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Card Footer / Action Bar */}
                  <div className="account-card__footer">
                    {isActive ? (
                      <button
                        type="button"
                        disabled
                        className="account-card__btn-login is-active-btn"
                        title="Active profile"
                      >
                        <UserCheck className="w-3.5 h-3.5" />
                        <span>Active</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isSwitching || Boolean(switchingId)}
                        onClick={() => void handleSwitch(profile)}
                        className={`account-card__btn-login ${!status?.saved ? 'is-signin' : ''}`}
                        title={
                          status?.saved
                            ? '1-click switch account with saved session'
                            : 'Sign into Riot Client with this profile'
                        }
                      >
                        {isSwitching ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : status?.saved ? (
                          <Zap className="w-3.5 h-3.5 text-hextech-gold" />
                        ) : (
                          <LogIn className="w-3.5 h-3.5" />
                        )}
                        <span>{status?.saved ? '> Switch' : '> Log In'}</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => openEditModal(profile)}
                      className="account-card__icon-action"
                      title="Edit Account"
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

      {/* ─────────────────────────────────────────────────────────────
         ADD / EDIT ACCOUNT MODAL
         ───────────────────────────────────────────────────────────── */}
      {isModalOpen && (
        <div className="accounts-modal-backdrop" onClick={() => setIsModalOpen(false)}>
          <div className="accounts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <h3 className="accounts-modal__title">
                  {editingProfile ? 'Edit Account' : 'Add League Account'}
                </h3>
                <p className="accounts-modal__subtitle">
                  Configure Riot ID and server details for 1-click profile switching.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1 rounded text-text-dim hover:text-white bg-transparent border-0 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {connectedAccount?.available && !editingProfile && (
              <div className="p-3 rounded-lg bg-hextech-gold/10 border border-hextech-gold/30 flex items-center justify-between gap-3 text-xs">
                <div>
                  <span className="text-hextech-gold font-bold block">Detected Connected League Client</span>
                  <span className="text-text-dim">{connectedAccount.riotId} · {connectedAccount.region}</span>
                </div>
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
                  className="px-2.5 py-1 rounded bg-hextech-gold/20 hover:bg-hextech-gold/30 text-hextech-gold font-bold text-xs border border-hextech-gold/40 cursor-pointer"
                >
                  Use Detected
                </button>
              </div>
            )}

            <form onSubmit={handleSaveModal} className="accounts-modal__form">
              <div className="accounts-modal__field">
                <label>Profile Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Main EUW, Smurf NA"
                  value={modalForm.name}
                  onChange={(e) => setModalForm({ ...modalForm, name: e.target.value })}
                />
              </div>

              <div className="accounts-modal__field">
                <label>Riot ID (GameName#Tag)</label>
                <input
                  type="text"
                  placeholder="e.g. Piltover Queen#NA1"
                  value={modalForm.riotId}
                  onChange={(e) => setModalForm({ ...modalForm, riotId: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="accounts-modal__field">
                  <label>Region / Server</label>
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
                  <label>Custom Tag / Role</label>
                  <input
                    type="text"
                    placeholder="e.g. main, smurf, duo"
                    value={modalForm.accountLabel}
                    onChange={(e) => setModalForm({ ...modalForm, accountLabel: e.target.value })}
                  />
                </div>
              </div>

              <div className="accounts-modal__field">
                <label>Login Username (Optional note)</label>
                <input
                  type="text"
                  placeholder="Username used to sign in"
                  value={modalForm.loginUsername}
                  onChange={(e) => setModalForm({ ...modalForm, loginUsername: e.target.value })}
                />
              </div>

              <div className="p-2.5 rounded bg-white/[0.04] border border-white/5 text-[11px] text-text-dim flex items-center gap-2">
                <Info className="w-4 h-4 text-hextech-gold shrink-0" />
                <span>
                  <strong>Tip:</strong> When logging into Riot Client, make sure to check <strong>"Stay signed in"</strong> below your password so your session can be saved for 1-click swapping.
                </span>
              </div>

              <div className="accounts-modal__actions">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded text-xs font-bold text-text-dim hover:text-white bg-transparent border border-white/10 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded text-xs font-bold text-white bg-hextech-gold/30 hover:bg-hextech-gold/40 border border-hextech-gold/50 cursor-pointer"
                >
                  Save Account
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
