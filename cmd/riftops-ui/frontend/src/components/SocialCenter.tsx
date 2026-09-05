import { Check, ExternalLink, History, Loader2, Mail, RefreshCw, Search, Send, Star, Trash2, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  actOnLCUFriendRequest,
  clearReviewedOperationReceipts,
  executeReviewedOperation,
  fetchLCUSocial,
  fetchReviewedOperation,
  fetchReviewedOperationReceipts,
  inviteLCUFriends,
  previewReviewedOperation,
  type ReviewedOperationReceipt,
  type SocialSnapshot,
} from '../api';
import type { ConfirmAction } from '../types';
import ConfirmModal from './ConfirmModal';
import { ActionFeedback, EmptyState, type FeedbackState, StatusBadge, WorkspaceSection } from './DesignPrimitives';
import PageHeader from './PageHeader';
import ReviewOperationModal, { type ReviewOperationData } from './ReviewOperationModal';
import { useLCUConnection } from './lcuConnectionContext';
import { useLocale } from '../localeContext';

type Friend = {
  id?: string;
  summonerId?: string;
  puuid?: string;
  gameName?: string;
  tagLine?: string;
  name?: string;
  summonerName?: string;
  displayName?: string;
  availability?: string;
  productName?: string;
  groupId?: number;
  profileIconId?: number;
  region?: string;
  mode?: string;
  activityStartedAt?: number;
};

type FriendRequest = { pid?: string; id?: string; gameName?: string; tagLine?: string; name?: string; direction?: string; state?: string };

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'));
  if (value && typeof value === 'object') return Object.values(value).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'));
  return [];
}

function normalizeFriend(value: Record<string, unknown>): Friend {
  const nested = value.summoner && typeof value.summoner === 'object' ? value.summoner as Record<string, unknown> : {};
  let lol: Record<string, unknown> = {};
  if (value.lol && typeof value.lol === 'object') lol = value.lol as Record<string, unknown>;
  else if (typeof value.lol === 'string') { try { lol = JSON.parse(value.lol) as Record<string, unknown>; } catch { /* League may send an empty presence string. */ } }
  const get = (...keys: string[]) => keys.map((key) => value[key] ?? nested[key]).find((entry) => typeof entry === 'string' && entry.trim()) as string | undefined;
  const started = Number(lol.gameStartTime || lol.timeStamp || value.lastSeenOnlineTimestamp || 0);
  return {
    id: get('id', 'jid'), summonerId: get('summonerId'), puuid: get('puuid', 'playerUuid'), gameName: get('gameName'), tagLine: get('tagLine', 'tagline'),
    name: get('name'), summonerName: get('summonerName'), displayName: get('displayName'), availability: get('availability', 'status', 'presence'), productName: get('productName', 'product'),
    groupId: Number(value.groupId ?? nested.groupId) || undefined, profileIconId: Number(value.profileIconId ?? nested.profileIconId) || undefined,
    region: get('region', 'platformId'),
    mode: String(lol.gameStatus || lol.gameMode || lol.queueId || lol.gameQueueType || '').trim() || undefined,
    activityStartedAt: started > 0 ? (started < 10_000_000_000 ? started * 1000 : started) : undefined,
  };
}

const STREAMER_ALIASES = [
  'Hextech Sentinel', 'Piltover Scout', 'Noxian Vanguard', 'Ionian Master',
  'Zaunite Chemist', 'Freljordian Nomad', 'Shuriman Ascendant', 'Bilgewater Corsair',
  'Targon Stargazer', 'Shadow Isles Wraith', 'Demacian Justiciar', 'Bandle Gunner',
  'Void Stalker', 'Celestial Oracle', 'Ironclad Warden', 'Runeterra Wanderer',
];

function friendName(friend: Friend, streamerMode = false): string {
  if (streamerMode) {
    const raw = friend.puuid || friend.summonerId || friend.id || '';
    const hash = raw.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return `${STREAMER_ALIASES[hash % STREAMER_ALIASES.length]} #${(hash % 900) + 100}`;
  }
  if (friend.gameName) return friend.tagLine ? `${friend.gameName}#${friend.tagLine}` : friend.gameName;
  return friend.name || friend.summonerName || friend.displayName || 'Unnamed friend';
}

function friendKey(friend: Friend): string {
  return friend.summonerId || friend.id || friend.puuid || friend.name || 'friend';
}

function collectLobbyIDs(value: unknown, target = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => collectLobbyIDs(entry, target));
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['summonerId', 'puuid']) {
      const id = String(record[key] || '').trim();
      if (id) target.add(id);
    }
    Object.values(record).forEach((entry) => collectLobbyIDs(entry, target));
  }
  return target;
}

function statusTone(value?: string): string {
  const availability = (value || '').toLowerCase();
  if (availability === 'chat' || availability === 'online') return 'is-online';
  if (availability === 'away' || availability === 'dnd') return 'is-away';
  if (availability === 'mobile') return 'is-mobile';
  return 'is-offline';
}

function statusLabel(value?: string): string {
  const availability = (value || '').toLowerCase();
  if (availability === 'chat' || availability === 'online') return 'Online';
  if (availability === 'away' || availability === 'dnd') return 'Away';
  if (availability === 'mobile') return 'Mobile';
  return 'Offline';
}

const PROFILE_REGION_SLUGS: Record<string, string> = {
  BR1: 'br', EUN1: 'eune', EUW1: 'euw', JP1: 'jp', KR: 'kr', NA1: 'na', OC1: 'oce',
  LA1: 'lan', LA2: 'las', PH2: 'ph', SG2: 'sg', TH2: 'th', TR1: 'tr', TW2: 'tw', VN2: 'vn', RU: 'ru',
};

function externalProfileURL(provider: string, region: string, gameName: string, tagLine: string): string | null {
  const safeProviders: Record<string, string> = { opgg: 'https://op.gg/lol/summoners', 'u.gg': 'https://u.gg/lol/profile', poro: 'https://poro.gg/summoner', aramgg: 'https://www.aramgg.com/summoner' };
  const base = safeProviders[provider];
  if (!base || !region || !gameName || !tagLine) return null;
  const normalizedRegion = PROFILE_REGION_SLUGS[region.trim().toUpperCase()] || region.trim().toLowerCase();
  return `${base}/${encodeURIComponent(normalizedRegion)}/${encodeURIComponent(`${gameName}-${tagLine}`)}`;
}

export default function SocialCenter({ remoteClient = false }: { remoteClient?: boolean }) {
  const { connected, pageVisible, streamerMode } = useLCUConnection();
  const getFriendName = useCallback((f: Friend) => friendName(f, streamerMode), [streamerMode]);
  const { t } = useLocale();
  const [snapshot, setSnapshot] = useState<SocialSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'favorites' | 'selected'>('all');
  const [groupBy, setGroupBy] = useState<'folder' | 'availability' | 'mode'>('folder');
  const [provider, setProvider] = useState<'opgg' | 'u.gg' | 'poro' | 'aramgg'>('opgg');
  const [favorites, setFavorites] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('riftops.social.favorites') || '[]')); } catch { return new Set(); } });
  const [friendLimit, setFriendLimit] = useState(100);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedRequests, setSelectedRequests] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [receipts, setReceipts] = useState<ReviewedOperationReceipt[]>([]);
  const [pendingReview, setPendingReview] = useState<ReviewOperationData | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmAction | null>(null);

  const refresh = useCallback(async () => {
    if (!connected || !pageVisible) return;
    setLoading(true);
    try {
      setSnapshot(await fetchLCUSocial());
      setFeedback(null);
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'Social data is unavailable.' });
    } finally {
      setLoading(false);
    }
  }, [connected, pageVisible]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!connected || !pageVisible) return undefined;
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [connected, pageVisible, refresh]);
  useEffect(() => {
    if (remoteClient || !connected || !pageVisible) {
      setReceipts([]);
      return undefined;
    }
    let active = true;
    void fetchReviewedOperationReceipts().then((next) => { if (active) setReceipts(next); }).catch(() => { if (active) setReceipts([]); });
    return () => { active = false; };
  }, [connected, pageVisible, remoteClient, busy]);
  useEffect(() => { try { localStorage.setItem('riftops.social.favorites', JSON.stringify([...favorites])); } catch { /* Optional local preference. */ } }, [favorites]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);

  const friends = useMemo(() => records(snapshot?.friends).map(normalizeFriend), [snapshot?.friends]);
  const requests = useMemo(() => records(snapshot?.friendRequests) as FriendRequest[], [snapshot?.friendRequests]);
  const onlineCount = friends.filter((friend) => ['chat', 'online', 'away', 'mobile'].includes((friend.availability || '').toLowerCase())).length;
  const visibleFriends = useMemo(() => friends
    .filter((friend) => filter !== 'online' || ['chat', 'online', 'away', 'mobile'].includes((friend.availability || '').toLowerCase()))
    .filter((friend) => filter !== 'favorites' || favorites.has(friendKey(friend)))
    .filter((friend) => filter !== 'selected' || selected.has(friendKey(friend)))
    .filter((friend) => !query.trim() || getFriendName(friend).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(favorites.has(friendKey(b))) - Number(favorites.has(friendKey(a))) || Number(statusTone(b.availability) === 'is-online') - Number(statusTone(a.availability) === 'is-online') || getFriendName(a).localeCompare(getFriendName(b))), [favorites, filter, friends, query, selected, getFriendName]);
  const groupNames = useMemo(() => new Map(records(snapshot?.friendGroups).map((group) => [Number(group.id || group.groupId), String(group.name || group.displayName || 'League folder')])), [snapshot?.friendGroups]);
  const pagedFriends = useMemo(() => visibleFriends.slice(0, friendLimit), [friendLimit, visibleFriends]);
  const groupedFriends = useMemo(() => pagedFriends.reduce<Record<string, Friend[]>>((groups, friend) => {
    const key = groupBy === 'mode' ? (friend.mode || 'Not in game') : groupBy === 'availability' ? ((friend.availability || 'offline').toLowerCase()) : friend.groupId ? (groupNames.get(friend.groupId) || 'League folder') : (statusTone(friend.availability) === 'is-online' ? 'Online' : 'Other friends');
    (groups[key] ||= []).push(friend);
    return groups;
  }, {}), [groupBy, groupNames, pagedFriends]);
  const lobbyIDs = useMemo(() => collectLobbyIDs(snapshot?.lobby), [snapshot?.lobby]);
  const activityLabel = (friend: Friend) => friend.activityStartedAt ? `${Math.max(0, Math.floor((now - friend.activityStartedAt) / 60_000))}m` : '';
  useEffect(() => { setFriendLimit(100); }, [filter, groupBy, query]);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setFeedback({ tone: 'working', message: 'Applying this change in League…' });
    try {
      await action();
      await refresh();
      setFeedback({ tone: 'success', message: success });
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'League rejected the action.' });
    } finally {
      setBusy('');
    }
  };

  const toggleSelected = (friend: Friend) => {
    const id = friendKey(friend);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const inviteSelected = async () => {
    const ids = [...selected];
    if (!ids.length || ids.length > (remoteClient ? 1 : 20)) return;
    setBusy('invite');
    try {
      if (remoteClient) {
        await inviteLCUFriends(ids);
        setFeedback({ tone: 'success', message: 'Invitation sent.' });
        return;
      }
      const preview = await previewReviewedOperation('friend-invite', ids);
      const targetLabels = ids.map((id) => {
        const friend = friends.find((f) => friendKey(f) === id);
        return friend ? getFriendName(friend) : id;
      });
      setPendingReview({
        previewId: preview.id,
        kind: 'friend-invite',
        title: `Review ${ids.length} Lobby Invitation${ids.length === 1 ? '' : 's'}`,
        description: 'RiftOps will dispatch reviewed lobby invitations through your League client.',
        confirmation: preview.confirmation,
        targetCount: ids.length,
        targetLabels,
        danger: false,
      });
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'Invitation failed.' });
    } finally {
      setBusy('');
    }
  };

  const removeSelected = async () => {
    const ids = [...selected];
    if (remoteClient || !ids.length || ids.length > 20) return;
    setBusy('remove');
    try {
      const preview = await previewReviewedOperation('friend-remove', ids);
      const targetLabels = ids.map((id) => {
        const friend = friends.find((f) => friendKey(f) === id);
        return friend ? getFriendName(friend) : id;
      });
      setPendingReview({
        previewId: preview.id,
        kind: 'friend-remove',
        title: `Review Removal of ${ids.length} Friend${ids.length === 1 ? '' : 's'}`,
        description: 'Permanently remove the selected players from your League friends list. This action cannot be undone.',
        confirmation: preview.confirmation,
        targetCount: ids.length,
        targetLabels,
        danger: true,
      });
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'Friend removal failed.' });
    } finally {
      setBusy('');
    }
  };

  const batchRequests = async (action: 'request-accept' | 'request-decline') => {
    if (remoteClient || selectedRequests.size === 0) return;
    const ids = [...selectedRequests];
    setBusy(action);
    try {
      const preview = await previewReviewedOperation(action, ids);
      const targetLabels = ids.map((id) => {
        const req = requests.find((r) => String(r.pid || r.id) === id);
        return req ? (req.gameName ? `${req.gameName}#${req.tagLine || ''}` : req.name || id) : id;
      });
      setPendingReview({
        previewId: preview.id,
        kind: action,
        title: action === 'request-accept' ? `Accept ${ids.length} Friend Requests` : `Decline ${ids.length} Friend Requests`,
        description: action === 'request-accept' ? 'Add all selected pending requests into your friend list.' : 'Decline all selected pending friend requests.',
        confirmation: preview.confirmation,
        targetCount: ids.length,
        targetLabels,
        danger: action === 'request-decline',
      });
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'Request operation failed.' });
    } finally {
      setBusy('');
    }
  };

  const executePendingReview = async (previewId: string, confirmationText: string) => {
    await executeReviewedOperation(previewId, confirmationText);
    for (;;) {
      const status = await fetchReviewedOperation(previewId);
      if (status.state === 'complete' || status.state === 'cancelled' || status.state === 'expired') {
        if (status.state === 'complete') {
          if (pendingReview?.kind === 'friend-remove') {
            setSelected(new Set());
          } else if (pendingReview?.kind.startsWith('request-')) {
            setSelectedRequests(new Set());
          }
          setFeedback({ tone: 'success', message: `${status.completed}/${status.total} operations processed successfully.` });
        } else {
          setFeedback({ tone: 'error', message: `Operation ${status.state}: ${status.completed}/${status.total} processed.` });
        }
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    }
    await refresh();
  };

  const clearHistorySafely = () => {
    setConfirmModal({
      open: true,
      title: 'Clear Operation History',
      message: 'Are you sure you want to clear all reviewed operation receipts? Local receipts from the last 7 days will be deleted.',
      actionLabel: 'Clear History',
      danger: true,
      onConfirm: () => {
        setConfirmModal(null);
        void clearReviewedOperationReceipts()
          .then(() => setReceipts([]))
          .catch((reason: any) => setFeedback({ tone: 'error', message: reason?.message || 'Could not clear operation history.' }));
      },
    });
  };

  return (
    <div className="social-center-page">
      <PageHeader
        variant="workspace"
        icon={Users}
        eyebrow="SOCIAL WORKSPACE"
        title={t('social.title')}
        description={t('social.description')}
        meta={<StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>{connected ? `${onlineCount} online` : t('social.offline')}</StatusBadge>}
      />

      <ActionFeedback state={feedback} />
      {snapshot?.warnings?.map((warning) => <ActionFeedback key={warning} state={{ tone: 'info', message: warning }} />)}
      {!connected && <EmptyState tone="neutral" icon={Users} title="Connect League Client" description="Open Riot Client and sign in to load your friends and invitations." />}

      {connected && (
        <div className="social-center-page__layout">
          <main className="social-center-page__main">
            <WorkspaceSection eyebrow="FRIENDS DIRECTORY" title={`${friends.length} friends`} description="Select people for a reviewed lobby invitation. Bulk friend removal remains desktop-only with typed verification.">
              {/* Category Filter Tabs */}
              <div className="social-filter-tabs flex items-center gap-1.5 p-1 rounded-xl bg-black/40 border border-white/[0.08] mb-3 overflow-x-auto">
                <button
                  type="button"
                  className={`social-filter-tab px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-2 shrink-0 cursor-pointer ${filter === 'all' ? 'bg-primary/20 text-primary border border-primary/40 shadow-[0_0_12px_rgba(200,170,110,0.2)]' : 'text-text-muted hover:text-white border border-transparent'}`}
                  onClick={() => setFilter('all')}
                >
                  <Users className="w-3.5 h-3.5" />
                  <span>{t('social.all')}</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white/[0.08]">{friends.length}</span>
                </button>
                <button
                  type="button"
                  className={`social-filter-tab px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-2 shrink-0 cursor-pointer ${filter === 'online' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.2)]' : 'text-text-muted hover:text-white border border-transparent'}`}
                  onClick={() => setFilter('online')}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#10b981]" />
                  <span>{t('social.online')}</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white/[0.08]">{onlineCount}</span>
                </button>
                <button
                  type="button"
                  className={`social-filter-tab px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-2 shrink-0 cursor-pointer ${filter === 'favorites' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.2)]' : 'text-text-muted hover:text-white border border-transparent'}`}
                  onClick={() => setFilter('favorites')}
                >
                  <Star className="w-3.5 h-3.5 fill-current" />
                  <span>{t('social.favorites')}</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white/[0.08]">{favorites.size}</span>
                </button>
                <button
                  type="button"
                  className={`social-filter-tab px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-2 shrink-0 cursor-pointer ${filter === 'selected' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-[0_0_12px_rgba(6,182,212,0.2)]' : 'text-text-muted hover:text-white border border-transparent'}`}
                  onClick={() => setFilter('selected')}
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Selected</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white/[0.08]">{selected.size}</span>
                </button>
              </div>

              {/* Toolbar */}
              <div className="social-center-page__toolbar">
                <label className="social-center-page__search">
                  <Search />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('social.search')} aria-label={t('social.search')} />
                </label>
                <label className="social-center-page__toolbar-select">
                  Group
                  <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}>
                    <option value="folder">League folder</option>
                    <option value="availability">Availability</option>
                    <option value="mode">Current mode</option>
                  </select>
                </label>
                <label className="social-center-page__toolbar-select">
                  Profile link
                  <select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}>
                    <option value="opgg">OP.GG</option>
                    <option value="u.gg">U.GG</option>
                    <option value="poro">Poro</option>
                    <option value="aramgg">ARAM.GG</option>
                  </select>
                </label>
                <button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={loading}>
                  <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
                </button>
              </div>

              {loading && friends.length === 0 && (
                <div className="social-center-page__loading">
                  <Loader2 className="animate-spin" /> Loading social data…
                </div>
              )}

              {!loading && visibleFriends.length === 0 && (
                <EmptyState icon={Search} title="No matching friends" description="Clear the search or filter to see your friend list." />
              )}

              <div className="social-center-page__groups">
                {Object.entries(groupedFriends).map(([group, groupFriends]) => (
                  <section className="social-center-page__group" key={group}>
                    <header>
                      <button
                        type="button"
                        onClick={() => setSelected((current) => {
                          const next = new Set(current);
                          const ids = groupFriends.map(friendKey);
                          const allSelected = ids.every((id) => next.has(id));
                          ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
                          return next;
                        })}
                      >
                        <strong>{group}</strong>
                        <small>{groupFriends.length}</small>
                      </button>
                    </header>
                    <div className="social-center-page__friends">
                      {groupFriends.map((friend, index) => {
                        const name = getFriendName(friend);
                        const id = friendKey(friend) || `${name}-${index}`;
                        const isSelected = selected.has(id);
                        const favorite = favorites.has(friendKey(friend));
                        const inLobby = lobbyIDs.has(String(friend.summonerId || '')) || lobbyIDs.has(String(friend.puuid || ''));
                        const profileURL = streamerMode ? null : externalProfileURL(provider, friend.region || '', friend.gameName || '', friend.tagLine || '');
                        const tone = statusTone(friend.availability);

                        return (
                          <div className={`social-center-page__friend ${isSelected ? 'is-selected' : ''}`} key={id}>
                            <button
                              type="button"
                              className="social-center-page__select"
                              onClick={() => toggleSelected(friend)}
                              aria-label={`${isSelected ? 'Deselect' : 'Select'} ${name}`}
                              aria-pressed={isSelected}
                            >
                              {isSelected ? <Check /> : <span />}
                            </button>

                            <div className="relative shrink-0">
                              {friend.profileIconId ? (
                                <img
                                  src={`/lol-game-data/assets/v1/profile-icons/${friend.profileIconId}.jpg`}
                                  alt=""
                                  width="40"
                                  height="40"
                                  loading="lazy"
                                  className="w-10 h-10 rounded-xl border border-white/10 bg-black/40 object-cover"
                                />
                              ) : (
                                <span className={`social-center-page__presence ${tone}`}>
                                  <span />
                                </span>
                              )}
                              <span
                                className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#091422] ${
                                  tone === 'is-online'
                                    ? 'bg-emerald-400 shadow-[0_0_8px_#10b981]'
                                    : tone === 'is-away'
                                      ? 'bg-amber-400'
                                      : tone === 'is-mobile'
                                        ? 'bg-sky-400'
                                        : 'bg-slate-600'
                                }`}
                                title={statusLabel(friend.availability)}
                              />
                            </div>

                            <span className="social-center-page__friend-copy">
                              <strong>
                                {name}
                                {inLobby && <em>IN LOBBY</em>}
                              </strong>
                              <small>
                                {friend.mode || friend.productName || 'League of Legends'} · {(friend.availability || 'offline').toLowerCase()}
                                {activityLabel(friend) ? ` · ${activityLabel(friend)}` : ''}
                              </small>
                            </span>

                            {profileURL && (
                              <a href={profileURL} target="_blank" rel="noreferrer" className="social-center-page__external" aria-label={`Open ${name} profile`}>
                                <ExternalLink />
                              </a>
                            )}

                            {remoteClient && friend.summonerId && (
                              <button
                                type="button"
                                className="social-center-page__external"
                                disabled={busy !== ''}
                                onClick={() => void run(`invite-${id}`, () => inviteLCUFriends([friend.summonerId!]), 'Invitation sent.')}
                                aria-label={`Invite ${name}`}
                              >
                                <Send />
                              </button>
                            )}

                            <button
                              type="button"
                              className={`social-center-page__favorite ${favorite ? 'is-active' : ''}`}
                              onClick={() => setFavorites((current) => {
                                const next = new Set(current);
                                if (next.has(friendKey(friend))) next.delete(friendKey(friend));
                                else next.add(friendKey(friend));
                                return next;
                              })}
                              aria-label={`${favorite ? 'Remove' : 'Add'} ${name} ${favorite ? 'from' : 'to'} favorites`}
                            >
                              <Star />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>

              {pagedFriends.length < visibleFriends.length && (
                <button type="button" className="profile-studio-page__more" onClick={() => setFriendLimit((value) => value + 100)}>
                  <Users /> Load 100 more friends
                </button>
              )}

              {/* Bulk Action Sticky Deck */}
              <div className="social-center-page__bulk">
                <span>{selected.size ? `${selected.size} selected` : 'Select friends to invite'}</span>
                <div className="social-center-page__bulk-actions">
                  {selected.size > 0 && (
                    <button type="button" className="btn-secondary" onClick={() => setSelected(new Set())}>
                      Clear
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={remoteClient || selected.size === 0 || busy !== '' || selected.size > 20}
                    onClick={() => void removeSelected()}
                  >
                    <Trash2 /> {busy === 'remove' ? 'Removing…' : t('social.remove')}
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={selected.size === 0 || busy !== '' || selected.size > (remoteClient ? 1 : 20)}
                    onClick={() => void inviteSelected()}
                  >
                    <Send /> {busy === 'invite' ? 'Inviting…' : t('social.invite')}
                  </button>
                </div>
              </div>
            </WorkspaceSection>
          </main>

          <aside className="social-center-page__side">
            <WorkspaceSection eyebrow="INBOX" title={t('social.requests')} description="Choose each request explicitly; no automatic acceptance is performed.">
              {requests.length === 0 && (
                <div className="social-center-page__empty">
                  <Mail />
                  <span>No pending friend requests.</span>
                </div>
              )}
              {requests.map((request, index) => {
                const id = String(request.pid || request.id || index);
                const label = request.gameName ? `${request.gameName}#${request.tagLine || ''}` : request.name || 'Riot ID unavailable';
                const checked = selectedRequests.has(id);
                return (
                  <div className={`social-center-page__request ${checked ? 'is-selected' : ''}`} key={id}>
                    <button
                      type="button"
                      className="social-center-page__request-select"
                      onClick={() => setSelectedRequests((current) => {
                        const next = new Set(current);
                        if (next.has(id)) next.delete(id); else next.add(id);
                        return next;
                      })}
                      aria-label={`${checked ? 'Deselect' : 'Select'} ${label}`}
                      aria-pressed={checked}
                    >
                      {checked ? <Check /> : <span />}
                    </button>
                    <span>
                      <strong>{label}</strong>
                      <small>{request.direction || request.state || 'Pending'}</small>
                    </span>
                    <div>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={busy !== ''}
                        onClick={() => void run(`accept-${id}`, () => actOnLCUFriendRequest(id, 'accept'), 'Friend request accepted.')}
                        aria-label={`Accept request from ${label}`}
                      >
                        <Check />
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={busy !== ''}
                        onClick={() => void run(`decline-${id}`, () => actOnLCUFriendRequest(id, 'decline'), 'Friend request declined.')}
                        aria-label={`Decline request from ${label}`}
                      >
                        <X />
                      </button>
                    </div>
                  </div>
                );
              })}
              {selectedRequests.size > 0 && (
                <div className="social-center-page__request-bulk">
                  <span>{selectedRequests.size} selected</span>
                  <button type="button" className="btn-secondary" disabled={busy !== '' || remoteClient} onClick={() => void batchRequests('request-accept')}>
                    <Check /> Accept all
                  </button>
                  <button type="button" className="btn-danger" disabled={busy !== '' || remoteClient} onClick={() => void batchRequests('request-decline')}>
                    <X /> Decline all
                  </button>
                </div>
              )}
            </WorkspaceSection>

            {!remoteClient && (
              <WorkspaceSection eyebrow="REVIEW HISTORY" title="Recent operations" description="Receipts are retained locally for seven days and never include credentials.">
                <div className="social-center-page__receipts">
                  {receipts.length === 0 && <small>No reviewed operations yet.</small>}
                  {receipts.slice().reverse().map((receipt) => (
                    <div key={receipt.id}>
                      <span>
                        <strong>{receipt.kind.replaceAll('-', ' ')}</strong>
                        <small>{receipt.succeeded}/{receipt.total} succeeded · {new Date(receipt.createdAt).toLocaleString()}</small>
                      </span>
                      <b className={receipt.failed > 0 || receipt.cancelled ? 'is-warning' : 'is-success'}>
                        {receipt.cancelled ? 'Cancelled' : receipt.failed > 0 ? `${receipt.failed} failed` : 'Complete'}
                      </b>
                    </div>
                  ))}
                </div>
                {receipts.length > 0 && (
                  <button type="button" className="btn-secondary" onClick={clearHistorySafely}>
                    <History className="w-3.5 h-3.5" /> Clear history
                  </button>
                )}
              </WorkspaceSection>
            )}
          </aside>
        </div>
      )}

      {/* Review Operation In-App Modal */}
      <ReviewOperationModal
        operation={pendingReview}
        onClose={() => setPendingReview(null)}
        onConfirm={executePendingReview}
      />

      {/* Confirm In-App Modal */}
      {confirmModal && (
        <ConfirmModal action={confirmModal} onClose={() => setConfirmModal(null)} />
      )}
    </div>
  );
}
