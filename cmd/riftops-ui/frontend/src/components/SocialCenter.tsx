import { Award, Check, ExternalLink, Eye, History, Loader2, Mail, RefreshCw, Search, Send, Star, Trash2, Users, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  actOnLCUFriendRequest,
  clearReviewedOperationReceipts,
  executeReviewedOperation,
  fetchLCUSocial,
  fetchLCUChatPrivacy,
  launchLCUSpectator,
  scoutProgressMastery,
  updateLCUChatMutes,
  fetchReviewedOperation,
  fetchReviewedOperationReceipts,
  inviteLCUFriends,
  previewReviewedOperation,
  type ReviewedOperationReceipt,
  type SocialSnapshot,
} from '../api';
import type { ConfirmAction } from '../types';
import ConfirmModal from './ConfirmModal';
import { ActionFeedback, EmptyState, type FeedbackState, StatusBadge } from './DesignPrimitives';
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
  partySize?: number;
  isPremade?: boolean;
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
  else if (typeof value.lol === 'string') { try { lol = JSON.parse(value.lol) as Record<string, unknown>; } catch { /* League can send an empty presence string. */ } }
  const get = (...keys: string[]) => keys.map((key) => value[key] ?? nested[key]).find((entry) => typeof entry === 'string' && entry.trim()) as string | undefined;
  const started = Number(lol.gameStartTime || lol.timeStamp || value.lastSeenOnlineTimestamp || 0);
  const party = [value.party, value.premadeParty, lol.party, lol.premadeParty].find((entry) => entry && typeof entry === 'object') as Record<string, unknown> | undefined;
  const partySize = Number(value.partySize ?? value.premadeSize ?? lol.partySize ?? lol.premadeSize ?? party?.size ?? party?.memberCount ?? 0) || undefined;
  const explicitPremade = value.isPremade ?? value.premade ?? lol.isPremade ?? lol.premade;
  return {
    id: get('id', 'jid'), summonerId: get('summonerId'), puuid: get('puuid', 'playerUuid'), gameName: get('gameName'), tagLine: get('tagLine', 'tagline'),
    name: get('name'), summonerName: get('summonerName'), displayName: get('displayName'), availability: get('availability', 'status', 'presence'), productName: get('productName', 'product'),
    groupId: Number(value.groupId ?? nested.groupId) || undefined, profileIconId: Number(value.profileIconId ?? nested.profileIconId) || undefined,
    region: get('region', 'platformId'), mode: String(lol.gameStatus || lol.gameMode || lol.queueId || lol.gameQueueType || '').trim() || undefined,
    activityStartedAt: started > 0 ? (started < 10_000_000_000 ? started * 1000 : started) : undefined,
    partySize, isPremade: typeof explicitPremade === 'boolean' ? explicitPremade : Boolean(partySize && partySize > 1),
  };
}

const STREAMER_ALIASES = ['Hextech Sentinel', 'Piltover Scout', 'Noxian Vanguard', 'Ionian Master', 'Zaunite Chemist', 'Freljordian Nomad', 'Shuriman Ascendant', 'Bilgewater Corsair', 'Targon Stargazer', 'Shadow Isles Wraith', 'Demacian Justiciar', 'Bandle Gunner', 'Void Stalker', 'Celestial Oracle', 'Ironclad Warden', 'Runeterra Wanderer'];

function friendName(friend: Friend, streamerMode = false): string {
  if (streamerMode) {
    const raw = friend.puuid || friend.summonerId || friend.id || '';
    const hash = raw.split('').reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${STREAMER_ALIASES[hash % STREAMER_ALIASES.length]} #${(hash % 900) + 100}`;
  }
  if (friend.gameName) return friend.tagLine ? `${friend.gameName}#${friend.tagLine}` : friend.gameName;
  return friend.name || friend.summonerName || friend.displayName || 'Unnamed friend';
}

function friendKey(friend: Friend): string { return friend.summonerId || friend.id || friend.puuid || friend.name || 'friend'; }

function collectLobbyIDs(value: unknown, target = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => collectLobbyIDs(entry, target));
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['summonerId', 'puuid']) { const id = String(record[key] || '').trim(); if (id) target.add(id); }
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

const PROFILE_REGION_SLUGS: Record<string, string> = { BR1: 'br', EUN1: 'eune', EUW1: 'euw', JP1: 'jp', KR: 'kr', NA1: 'na', OC1: 'oce', LA1: 'lan', LA2: 'las', PH2: 'ph', SG2: 'sg', TH2: 'th', TR1: 'tr', TW2: 'tw', VN2: 'vn', RU: 'ru' };

function externalProfileURL(provider: string, region: string, gameName: string, tagLine: string): string | null {
  const providers: Record<string, string> = { opgg: 'https://op.gg/lol/summoners', 'u.gg': 'https://u.gg/lol/profile', poro: 'https://poro.gg/summoner', aramgg: 'https://www.aramgg.com/summoner' };
  const base = providers[provider];
  if (!base || !region || !gameName || !tagLine) return null;
  const normalizedRegion = PROFILE_REGION_SLUGS[region.trim().toUpperCase()] || region.trim().toLowerCase();
  return `${base}/${encodeURIComponent(normalizedRegion)}/${encodeURIComponent(`${gameName}-${tagLine}`)}`;
}

export default function SocialCenter({ remoteClient = false }: { remoteClient?: boolean }) {
  const { connected, pageVisible, streamerMode } = useLCUConnection();
  const { t } = useLocale();
  const getFriendName = useCallback((friend: Friend) => friendName(friend, streamerMode), [streamerMode]);
  const [snapshot, setSnapshot] = useState<SocialSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'favorites' | 'selected'>('all');
  const [groupBy, setGroupBy] = useState<'folder' | 'availability' | 'mode'>('folder');
  const [provider, setProvider] = useState<'opgg' | 'u.gg' | 'poro' | 'aramgg'>('opgg');
  const [favorites, setFavorites] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('riftops.social.favorites') || '[]')); } catch { return new Set(); } });
  const [friendLimit, setFriendLimit] = useState(100);
  const [now, setNow] = useState(Date.now());
  const [lastRefreshAt, setLastRefreshAt] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedRequests, setSelectedRequests] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [receipts, setReceipts] = useState<ReviewedOperationReceipt[]>([]);
  const [pendingReview, setPendingReview] = useState<(ReviewOperationData & { clear?: 'friends' | 'requests' }) | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmAction | null>(null);
  const [mutedPuuids, setMutedPuuids] = useState<Set<string>>(() => new Set());
  const [masteryScores, setMasteryScores] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    if (!connected || !pageVisible) return;
    setLoading(true);
    try { setSnapshot(await fetchLCUSocial()); setLastRefreshAt(Date.now()); setFeedback(null); }
    catch (reason: any) { setFeedback({ tone: 'error', message: reason?.message || 'Social data is unavailable.' }); }
    finally { setLoading(false); }
  }, [connected, pageVisible]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!connected || !pageVisible) return undefined;
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [connected, pageVisible, refresh]);
  useEffect(() => {
    if (remoteClient || !connected || !pageVisible) { setReceipts([]); return undefined; }
    let active = true;
    void fetchReviewedOperationReceipts().then((next) => { if (active) setReceipts(next); }).catch(() => { if (active) setReceipts([]); });
    return () => { active = false; };
  }, [connected, pageVisible, remoteClient, busy]);
  useEffect(() => {
    if (remoteClient || !connected || !pageVisible) { setMutedPuuids(new Set()); return undefined; }
    let active = true;
    void fetchLCUChatPrivacy().then((privacy) => { if (active) setMutedPuuids(new Set(privacy.mutes.filter((mute) => mute.playerMuted).map((mute) => mute.puuid))); }).catch(() => { if (active) setMutedPuuids(new Set()); });
    return () => { active = false; };
  }, [connected, pageVisible, remoteClient, busy]);
  useEffect(() => { try { localStorage.setItem('riftops.social.favorites', JSON.stringify([...favorites])); } catch { /* Optional preference. */ } }, [favorites]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer); }, []);

  const friends = useMemo(() => records(snapshot?.friends).map(normalizeFriend), [snapshot?.friends]);
  const requests = useMemo(() => records(snapshot?.friendRequests) as FriendRequest[], [snapshot?.friendRequests]);
  const onlineCount = friends.filter((friend) => ['chat', 'online', 'away', 'mobile'].includes((friend.availability || '').toLowerCase())).length;
  const groupNames = useMemo(() => new Map(records(snapshot?.friendGroups).map((group) => [Number(group.id || group.groupId), String(group.name || group.displayName || 'League folder')])), [snapshot?.friendGroups]);
  const visibleFriends = useMemo(() => friends
    .filter((friend) => filter !== 'online' || ['chat', 'online', 'away', 'mobile'].includes((friend.availability || '').toLowerCase()))
    .filter((friend) => filter !== 'favorites' || favorites.has(friendKey(friend)))
    .filter((friend) => filter !== 'selected' || selected.has(friendKey(friend)))
    .filter((friend) => !query.trim() || getFriendName(friend).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(favorites.has(friendKey(b))) - Number(favorites.has(friendKey(a))) || Number(statusTone(b.availability) === 'is-online') - Number(statusTone(a.availability) === 'is-online') || getFriendName(a).localeCompare(getFriendName(b))), [favorites, filter, friends, getFriendName, query, selected]);
  const pagedFriends = useMemo(() => visibleFriends.slice(0, friendLimit), [friendLimit, visibleFriends]);
  const groupedFriends = useMemo(() => pagedFriends.reduce<Record<string, Friend[]>>((groups, friend) => {
    const key = groupBy === 'mode' ? (friend.mode || 'Not in game') : groupBy === 'availability' ? ((friend.availability || 'offline').toLowerCase()) : friend.groupId ? (groupNames.get(friend.groupId) || 'League folder') : (statusTone(friend.availability) === 'is-online' ? 'Online' : 'Other friends');
    (groups[key] ||= []).push(friend);
    return groups;
  }, {}), [groupBy, groupNames, pagedFriends]);
  const lobbyIDs = useMemo(() => collectLobbyIDs(snapshot?.lobby), [snapshot?.lobby]);
  const activityLabel = (friend: Friend) => friend.activityStartedAt ? `${Math.max(0, Math.floor((now - friend.activityStartedAt) / 60000))}m` : '';
  useEffect(() => { setFriendLimit(100); }, [filter, groupBy, query]);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key); setFeedback({ tone: 'working', message: 'Applying this change in League…' });
    try { await action(); await refresh(); setFeedback({ tone: 'success', message: success }); }
    catch (reason: any) { setFeedback({ tone: 'error', message: reason?.message || 'League rejected the action.' }); }
    finally { setBusy(''); }
  };

  const toggleSelected = (friend: Friend) => setSelected((current) => { const next = new Set(current); const id = friendKey(friend); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const startReview = async (kind: string, ids: string[], danger: boolean, title: string, description: string, targetLabels: string[], clear: 'friends' | 'requests') => {
    try {
      const preview = await previewReviewedOperation(kind, ids);
      setPendingReview({ previewId: preview.id, kind, title, description, confirmation: preview.confirmation, targetCount: ids.length, targetLabels, danger, clear });
    } catch (reason: any) { setFeedback({ tone: 'error', message: reason?.message || 'Could not prepare the reviewed operation.' }); }
  };

  const inviteSelected = async () => {
    const ids = [...selected];
    if (!ids.length || ids.length > (remoteClient ? 1 : 20)) return;
    setBusy('invite');
    try {
      if (remoteClient) { await inviteLCUFriends(ids); setFeedback({ tone: 'success', message: 'Invitation sent.' }); return; }
      await startReview('friend-invite', ids, false, `Review ${ids.length} lobby invitation${ids.length === 1 ? '' : 's'}`, 'RiftOps will dispatch reviewed lobby invitations through your League client.', ids.map((id) => getFriendName(friends.find((friend) => friendKey(friend) === id) || { id })), 'friends');
    } catch (reason: any) { setFeedback({ tone: 'error', message: reason?.message || 'Invitation failed.' }); }
    finally { setBusy(''); }
  };

  const removeSelected = async () => {
    const ids = [...selected];
    if (remoteClient || !ids.length || ids.length > 20) return;
    setBusy('remove');
    await startReview('friend-remove', ids, true, `Review removal of ${ids.length} friend${ids.length === 1 ? '' : 's'}`, 'Permanently remove the selected players from your League friends list. This action cannot be undone.', ids.map((id) => getFriendName(friends.find((friend) => friendKey(friend) === id) || { id })), 'friends');
    setBusy('');
  };

  const batchRequests = async (action: 'request-accept' | 'request-decline') => {
    if (remoteClient || selectedRequests.size === 0) return;
    const ids = [...selectedRequests]; setBusy(action);
    await startReview(action, ids, action === 'request-decline', action === 'request-accept' ? `Accept ${ids.length} friend request${ids.length === 1 ? '' : 's'}` : `Decline ${ids.length} friend request${ids.length === 1 ? '' : 's'}`, action === 'request-accept' ? 'Add all selected pending requests into your friend list.' : 'Decline all selected pending friend requests.', ids.map((id) => { const request = requests.find((entry) => String(entry.pid || entry.id) === id); return request?.gameName ? `${request.gameName}#${request.tagLine || ''}` : request?.name || id; }), 'requests');
    setBusy('');
  };

  const executePendingReview = async (previewId: string, confirmationText: string) => {
    await executeReviewedOperation(previewId, confirmationText);
    for (;;) {
      const status = await fetchReviewedOperation(previewId);
      if (status.state === 'complete' || status.state === 'cancelled' || status.state === 'expired') {
        if (status.state === 'complete') {
          if (pendingReview?.clear === 'friends') setSelected(new Set());
          if (pendingReview?.clear === 'requests') setSelectedRequests(new Set());
          setFeedback({ tone: 'success', message: `${status.completed}/${status.total} operations processed successfully.` });
        } else setFeedback({ tone: 'error', message: `Operation ${status.state}: ${status.completed}/${status.total} processed.` });
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    }
    setPendingReview(null); await refresh();
  };

  const clearHistorySafely = () => setConfirmModal({ open: true, title: 'Clear operation history', message: 'Local receipts from the last seven days will be deleted.', actionLabel: 'Clear history', danger: true, onConfirm: () => { setConfirmModal(null); void clearReviewedOperationReceipts().then(() => setReceipts([])).catch((reason: any) => setFeedback({ tone: 'error', message: reason?.message || 'Could not clear operation history.' })); } });

  const toggleMute = async (friend: Friend) => {
    if (!friend.puuid || remoteClient) return;
    const muted = !mutedPuuids.has(friend.puuid);
    await run(`mute-${friendKey(friend)}`, async () => { await updateLCUChatMutes([friend.puuid!], muted); setMutedPuuids((current) => { const next = new Set(current); if (muted) next.add(friend.puuid!); else next.delete(friend.puuid!); return next; }); }, muted ? 'Player muted.' : 'Player unmuted.');
  };

  const spectate = async (friend: Friend) => {
    if (!friend.puuid || remoteClient) return;
    await run(`spectate-${friendKey(friend)}`, async () => { const result = await launchLCUSpectator(friend.puuid!); if (!result.launched) throw new Error(result.reason || 'Friend is not currently spectatable.'); }, 'Spectator launched in League.');
  };

  const scoutMastery = async (friend: Friend) => {
    if (!friend.puuid || remoteClient) return;
    await run(`mastery-${friendKey(friend)}`, async () => {
      const result = await scoutProgressMastery([friend.puuid!]);
      const score = Number(result.find((entry: any) => String(entry?.puuid) === friend.puuid)?.totalMasteryScore);
      if (Number.isFinite(score)) setMasteryScores((current) => ({ ...current, [friend.puuid!]: score }));
    }, 'Mastery profile loaded.');
  };

  const filterButtons = [
    { id: 'all' as const, label: t('social.all'), count: friends.length },
    { id: 'online' as const, label: t('social.online'), count: onlineCount },
    { id: 'favorites' as const, label: t('social.favorites'), count: favorites.size },
    { id: 'selected' as const, label: 'Selected', count: selected.size },
  ];

  return (
    <div className="social-command-page">
      <PageHeader variant="workspace" icon={Users} eyebrow="SOCIAL WORKSPACE" title={t('social.title')} description="Friends, requests, and lobby invitations from the local League client." meta={<StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>{connected ? `${onlineCount} online` : t('social.offline')}</StatusBadge>} />

      <div className="social-command-summary" aria-label="Friends summary">
        <span><b>{friends.length}</b> friends</span><span><b>{onlineCount}</b> online</span><span><b>{requests.length}</b> requests</span><span><b>{selected.size}</b> selected</span>
      </div>

      <ActionFeedback state={feedback} />
      {snapshot?.warnings?.map((warning) => <ActionFeedback key={warning} state={{ tone: 'info', message: warning }} />)}
      {!connected && <EmptyState tone="neutral" icon={Users} title="Connect League Client" description="Open Riot Client and sign in to load your friends and invitations." />}

      {connected && <div className="social-command-layout">
        <main className="social-command-directory">
          <section className="social-directory-surface" aria-labelledby="friends-directory-heading">
            <header className="social-directory-heading"><div><span className="social-command-kicker">FRIENDS DIRECTORY</span><h2 id="friends-directory-heading">Your League friends</h2><p>Select people for a reviewed lobby invitation or keep the list tidy.</p></div><button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh</button></header>
            <div className="social-filter-bar" role="tablist" aria-label="Friend filters">{filterButtons.map((button) => <button key={button.id} type="button" role="tab" aria-selected={filter === button.id} className={filter === button.id ? 'is-active' : ''} onClick={() => setFilter(button.id)}><span>{button.label}</span><b>{button.count}</b></button>)}</div>
            <div className="social-directory-toolbar">
              <label className="social-directory-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('social.search')} aria-label={t('social.search')} /></label>
              <label>Group<select value={groupBy} onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}><option value="folder">League folder</option><option value="availability">Availability</option><option value="mode">Current mode</option></select></label>
              <label>Profile link<select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}><option value="opgg">OP.GG</option><option value="u.gg">U.GG</option><option value="poro">Poro</option><option value="aramgg">ARAM.GG</option></select></label>
              <small>{lastRefreshAt ? `Updated ${Math.max(0, Math.floor((now - lastRefreshAt) / 60000))}m ago` : 'Waiting for live update'}</small>
            </div>

            {loading && friends.length === 0 && <div className="social-command-empty"><Loader2 className="animate-spin" /> Loading social data…</div>}
            {!loading && visibleFriends.length === 0 && <EmptyState icon={Search} title="No matching friends" description="Clear the search or filter to see your friend list." />}
            <div className="social-friend-groups">
              {Object.entries(groupedFriends).map(([group, groupFriends]) => <section className="social-friend-group" key={group}>
                <header><button type="button" onClick={() => setSelected((current) => { const next = new Set(current); const ids = groupFriends.map(friendKey); const allSelected = ids.every((id) => next.has(id)); ids.forEach((id) => allSelected ? next.delete(id) : next.add(id)); return next; })}><strong>{group}</strong><small>{groupFriends.length}</small></button></header>
                <div className="social-friend-list">{groupFriends.map((friend, index) => {
                  const name = getFriendName(friend); const id = friendKey(friend) || `${name}-${index}`; const isSelected = selected.has(id); const favorite = favorites.has(id); const tone = statusTone(friend.availability); const profileURL = streamerMode ? null : externalProfileURL(provider, friend.region || '', friend.gameName || '', friend.tagLine || ''); const inLobby = lobbyIDs.has(String(friend.summonerId || '')) || lobbyIDs.has(String(friend.puuid || ''));
                  const inGame = Boolean(friend.mode || friend.activityStartedAt);
                  const isMuted = Boolean(friend.puuid && mutedPuuids.has(friend.puuid));
                  return <article className={`social-friend-row ${isSelected ? 'is-selected' : ''}`} key={id}>
                    <button type="button" className="social-select-button" onClick={() => toggleSelected(friend)} aria-label={`${isSelected ? 'Deselect' : 'Select'} ${name}`} aria-pressed={isSelected}>{isSelected ? <Check /> : <span />}</button>
                    <div className="social-friend-avatar">{friend.profileIconId ? <img src={`/lol-game-data/assets/v1/profile-icons/${friend.profileIconId}.jpg`} alt="" width="40" height="40" loading="lazy" /> : <span className={tone}><i /></span>}<em className={tone} title={statusLabel(friend.availability)} /></div>
                    <div className="social-friend-copy"><strong>{name}{inLobby && <em>IN LOBBY</em>}{friend.isPremade && <em className="is-premade">PARTY{friend.partySize && friend.partySize > 1 ? ` · ${friend.partySize}` : ''}</em>}</strong><small>{friend.mode || friend.productName || 'League of Legends'} · {(friend.availability || 'offline').toLowerCase()}{activityLabel(friend) ? ` · ${activityLabel(friend)}` : ''}{friend.puuid && masteryScores[friend.puuid] !== undefined ? ` · mastery ${masteryScores[friend.puuid].toLocaleString()}` : ''}</small></div>
                    <div className="social-friend-actions">{profileURL && <a href={profileURL} target="_blank" rel="noreferrer" aria-label={`Open ${name} profile`}><ExternalLink /></a>}{!remoteClient && friend.puuid && <button type="button" disabled={busy !== ''} onClick={() => void scoutMastery(friend)} aria-label={`Inspect mastery for ${name}`}><Award /></button>}{inGame && !remoteClient && friend.puuid && <button type="button" disabled={busy !== ''} onClick={() => void spectate(friend)} aria-label={`Spectate ${name}`}><Eye /></button>}{!remoteClient && friend.puuid && <button type="button" className={isMuted ? 'is-muted' : ''} disabled={busy !== ''} onClick={() => void toggleMute(friend)} aria-label={`${isMuted ? 'Unmute' : 'Mute'} ${name}`}><VolumeX /></button>}{remoteClient && friend.summonerId && <button type="button" disabled={busy !== ''} onClick={() => void run(`invite-${id}`, () => inviteLCUFriends([friend.summonerId!]), 'Invitation sent.')} aria-label={`Invite ${name}`}><Send /></button>}<button type="button" className={favorite ? 'is-favorite' : ''} onClick={() => setFavorites((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} aria-label={`${favorite ? 'Remove' : 'Add'} ${name} ${favorite ? 'from' : 'to'} favorites`}><Star /></button></div>
                  </article>;
                })}</div>
              </section>)}
            </div>
            {pagedFriends.length < visibleFriends.length && <button type="button" className="social-load-more" onClick={() => setFriendLimit((value) => value + 100)}><Users /> Load 100 more friends</button>}
            <footer className="social-bulk-bar"><span>{selected.size ? `${selected.size} selected` : 'Select friends to invite'}</span><div>{selected.size > 0 && <button type="button" className="btn-secondary" onClick={() => setSelected(new Set())}>Clear</button>}<button type="button" className="btn-danger" disabled={remoteClient || selected.size === 0 || busy !== '' || selected.size > 20} onClick={() => void removeSelected()}><Trash2 /> {busy === 'remove' ? 'Removing…' : t('social.remove')}</button><button type="button" className="btn-primary" disabled={selected.size === 0 || busy !== '' || selected.size > (remoteClient ? 1 : 20)} onClick={() => void inviteSelected()}><Send /> {busy === 'invite' ? 'Inviting…' : t('social.invite')}</button></div></footer>
          </section>
        </main>

        <aside className="social-command-rail">
          <section className="social-rail-section" aria-labelledby="requests-heading"><header><div><span className="social-command-kicker">INBOX</span><h2 id="requests-heading">Friend requests</h2><p>Choose each request explicitly; nothing is accepted automatically.</p></div><span className="social-rail-count">{requests.length}</span></header>{requests.length === 0 && <div className="social-command-empty"><Mail /> No pending requests.</div>}{requests.map((request, index) => { const id = String(request.pid || request.id || index); const label = request.gameName ? `${request.gameName}#${request.tagLine || ''}` : request.name || 'Riot ID unavailable'; const checked = selectedRequests.has(id); return <div className={`social-request-row ${checked ? 'is-selected' : ''}`} key={id}><button type="button" className="social-select-button" onClick={() => setSelectedRequests((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} aria-label={`${checked ? 'Deselect' : 'Select'} ${label}`} aria-pressed={checked}>{checked ? <Check /> : <span />}</button><div><strong>{label}</strong><small>{request.direction || request.state || 'Pending'}</small></div><span><button type="button" className="btn-secondary" disabled={busy !== ''} onClick={() => void run(`accept-${id}`, () => actOnLCUFriendRequest(id, 'accept'), 'Friend request accepted.')} aria-label={`Accept request from ${label}`}><Check /></button><button type="button" className="btn-danger" disabled={busy !== ''} onClick={() => void run(`decline-${id}`, () => actOnLCUFriendRequest(id, 'decline'), 'Friend request declined.')} aria-label={`Decline request from ${label}`}><X /></button></span></div>; })}{selectedRequests.size > 0 && <div className="social-request-bulk"><strong>{selectedRequests.size} selected</strong><button type="button" className="btn-secondary" disabled={busy !== '' || remoteClient} onClick={() => void batchRequests('request-accept')}><Check /> Accept all</button><button type="button" className="btn-danger" disabled={busy !== '' || remoteClient} onClick={() => void batchRequests('request-decline')}><X /> Decline all</button></div>}</section>
          {!remoteClient && <details className="social-rail-section social-history-section"><summary><span><History /> Review history</span><small>{receipts.length ? `${receipts.length} recent operation${receipts.length === 1 ? '' : 's'}` : 'No recent operations'}</small></summary><div className="social-history-list">{receipts.length === 0 && <small>No reviewed operations yet.</small>}{receipts.slice().reverse().map((receipt) => <div key={receipt.id}><span><strong>{receipt.kind.replaceAll('-', ' ')}</strong><small>{receipt.succeeded}/{receipt.total} succeeded · {new Date(receipt.createdAt).toLocaleString()}</small></span><b className={receipt.failed > 0 || receipt.cancelled ? 'is-warning' : ''}>{receipt.cancelled ? 'Cancelled' : receipt.failed > 0 ? `${receipt.failed} failed` : 'Complete'}</b></div>)}</div>{receipts.length > 0 && <button type="button" className="btn-secondary" onClick={clearHistorySafely}><History /> Clear history</button>}</details>}
        </aside>
      </div>}

      <ReviewOperationModal operation={pendingReview} onClose={() => setPendingReview(null)} onConfirm={executePendingReview} />
      {confirmModal && <ConfirmModal action={confirmModal} onClose={() => setConfirmModal(null)} />}
    </div>
  );
}
