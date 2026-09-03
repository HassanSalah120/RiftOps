import { Check, ExternalLink, Loader2, Mail, RefreshCw, Search, Send, Star, Trash2, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { actOnLCUFriendRequest, clearReviewedOperationReceipts, executeReviewedOperation, fetchLCUSocial, fetchReviewedOperation, fetchReviewedOperationReceipts, inviteLCUFriends, previewReviewedOperation, type ReviewedOperationReceipt, type SocialSnapshot } from '../api';
import { ActionFeedback, EmptyState, type FeedbackState, StatusBadge, WorkspaceSection } from './DesignPrimitives';
import PageHeader from './PageHeader';
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
};

type FriendRequest = { pid?: string; id?: string; gameName?: string; tagLine?: string; name?: string; direction?: string; state?: string };

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'));
  if (value && typeof value === 'object') return Object.values(value).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'));
  return [];
}

function normalizeFriend(value: Record<string, unknown>): Friend {
  const nested = value.summoner && typeof value.summoner === 'object' ? value.summoner as Record<string, unknown> : {};
  const get = (...keys: string[]) => keys.map((key) => value[key] ?? nested[key]).find((entry) => typeof entry === 'string' && entry.trim()) as string | undefined;
  return {
    id: get('id', 'jid'), summonerId: get('summonerId'), puuid: get('puuid', 'playerUuid'), gameName: get('gameName'), tagLine: get('tagLine', 'tagline'),
    name: get('name'), summonerName: get('summonerName'), displayName: get('displayName'), availability: get('availability', 'status', 'presence'), productName: get('productName', 'product'),
    groupId: Number(value.groupId ?? nested.groupId) || undefined, profileIconId: Number(value.profileIconId ?? nested.profileIconId) || undefined,
    region: get('region', 'platformId'),
  };
}

function friendName(friend: Friend): string {
  if (friend.gameName) return friend.tagLine ? `${friend.gameName}#${friend.tagLine}` : friend.gameName;
  return friend.name || friend.summonerName || friend.displayName || 'Unnamed friend';
}

function statusTone(value?: string): string {
  const availability = (value || '').toLowerCase();
  if (availability === 'chat' || availability === 'online') return 'is-online';
  if (availability === 'away' || availability === 'dnd') return 'is-away';
  if (availability === 'mobile') return 'is-mobile';
  return 'is-offline';
}

function externalProfileURL(provider: string, region: string, gameName: string, tagLine: string): string | null {
  const safeProviders: Record<string, string> = { opgg: 'https://op.gg/lol/summoners', 'u.gg': 'https://u.gg/lol/profile', poro: 'https://poro.gg/summoner', aramgg: 'https://www.aramgg.com/summoner' };
  const base = safeProviders[provider];
  if (!base || !region || !gameName || !tagLine) return null;
  return `${base}/${encodeURIComponent(region.toLowerCase())}/${encodeURIComponent(`${gameName}-${tagLine}`)}`;
}

export default function SocialCenter({ remoteClient = false }: { remoteClient?: boolean }) {
  const { connected, pageVisible } = useLCUConnection();
  const { t } = useLocale();
  const [snapshot, setSnapshot] = useState<SocialSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'selected'>('all');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedRequests, setSelectedRequests] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [receipts, setReceipts] = useState<ReviewedOperationReceipt[]>([]);

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

  const friends = useMemo(() => records(snapshot?.friends).map(normalizeFriend), [snapshot?.friends]);
  const requests = useMemo(() => records(snapshot?.friendRequests) as FriendRequest[], [snapshot?.friendRequests]);
  const onlineCount = friends.filter((friend) => ['chat', 'online', 'away', 'mobile'].includes((friend.availability || '').toLowerCase())).length;
  const visibleFriends = useMemo(() => friends
    .filter((friend) => filter !== 'online' || ['chat', 'online', 'away', 'mobile'].includes((friend.availability || '').toLowerCase()))
    .filter((friend) => filter !== 'selected' || selected.has(friend.summonerId || friend.id || friend.puuid || friendName(friend)))
    .filter((friend) => !query.trim() || friendName(friend).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(statusTone(b.availability) === 'is-online') - Number(statusTone(a.availability) === 'is-online') || friendName(a).localeCompare(friendName(b))), [filter, friends, query, selected]);
  const groupNames = useMemo(() => new Map(records(snapshot?.friendGroups).map((group) => [Number(group.id || group.groupId), String(group.name || group.displayName || 'League folder')])), [snapshot?.friendGroups]);
  const groupedFriends = useMemo(() => visibleFriends.reduce<Record<string, Friend[]>>((groups, friend) => {
    const key = friend.groupId ? (groupNames.get(friend.groupId) || 'League folder') : (statusTone(friend.availability) === 'is-online' ? 'Online' : 'Other friends');
    (groups[key] ||= []).push(friend);
    return groups;
  }, {}), [groupNames, visibleFriends]);

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
    const id = friend.summonerId || friend.id || friend.puuid || friendName(friend);
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
      const confirmation = window.prompt(`Review ${ids.length} invitation${ids.length === 1 ? '' : 's'} and type ${preview.confirmation} to continue.`) || '';
      if (confirmation.trim() !== preview.confirmation) {
        setFeedback({ tone: 'error', message: 'Invitation cancelled; confirmation text did not match.' });
        return;
      }
      await executeReviewedOperation(preview.id, confirmation.trim());
      for (;;) {
        const status = await fetchReviewedOperation(preview.id);
        if (status.state === 'complete' || status.state === 'cancelled' || status.state === 'expired') {
          setFeedback({ tone: status.state === 'complete' ? 'success' : 'error', message: `${status.completed}/${status.total} invitations processed.` });
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 450));
      }
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
      const confirmation = window.prompt(`Review removal of ${ids.length} friend${ids.length === 1 ? '' : 's'} and type ${preview.confirmation} to continue.`) || '';
      if (confirmation.trim() !== preview.confirmation) {
        setFeedback({ tone: 'error', message: 'Removal cancelled; confirmation text did not match.' });
        return;
      }
      await executeReviewedOperation(preview.id, confirmation.trim());
      for (;;) {
        const status = await fetchReviewedOperation(preview.id);
        if (status.state === 'complete' || status.state === 'cancelled' || status.state === 'expired') {
          setSelected(new Set());
          setFeedback({ tone: status.state === 'complete' ? 'success' : 'error', message: `${status.completed}/${status.total} removals processed.` });
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 450));
      }
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
      const confirmation = window.prompt(`Review ${ids.length} request decisions and type ${preview.confirmation} to continue.`) || '';
      if (confirmation.trim() !== preview.confirmation) { setFeedback({ tone: 'info', message: 'Request operation cancelled.' }); return; }
      await executeReviewedOperation(preview.id, confirmation.trim());
      for (;;) {
        const status = await fetchReviewedOperation(preview.id);
        if (status.state === 'complete' || status.state === 'cancelled' || status.state === 'expired') { setSelectedRequests(new Set()); setFeedback({ tone: status.state === 'complete' ? 'success' : 'error', message: `${status.completed}/${status.total} requests processed.` }); break; }
        await new Promise((resolve) => window.setTimeout(resolve, 450));
      }
      await refresh();
    } catch (reason: any) { setFeedback({ tone: 'error', message: reason?.message || 'Request operation failed.' }); }
    finally { setBusy(''); }
  };

  return <div className="social-center-page">
    <PageHeader variant="workspace" icon={Users} eyebrow="SOCIAL WORKSPACE" title={t('social.title')} description={t('social.description')} meta={<StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>{connected ? `${onlineCount} online` : t('social.offline')}</StatusBadge>} />
    <ActionFeedback state={feedback} />
    {!connected && <EmptyState tone="neutral" icon={Users} title="Connect League Client" description="Open Riot Client and sign in to load your friends and invitations." />}
    {connected && <div className="social-center-page__layout">
      <main className="social-center-page__main">
        <WorkspaceSection eyebrow="FRIENDS" title={`${friends.length} friends`} description="Select people for a reviewed lobby invitation. Bulk friend removal remains intentionally desktop-only and confirmation-gated.">
          <div className="social-center-page__toolbar">
            <label className="social-center-page__search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('social.search')} aria-label={t('social.search')} /></label>
            <div className="social-center-page__filters"><button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>{t('social.all')} <span>{friends.length}</span></button><button type="button" className={filter === 'online' ? 'is-active' : ''} onClick={() => setFilter('online')}>{t('social.online')} <span>{onlineCount}</span></button><button type="button" className={filter === 'selected' ? 'is-active' : ''} onClick={() => setFilter('selected')}>Selected <span>{selected.size}</span></button></div>
            <button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh</button>
          </div>
          {loading && friends.length === 0 && <div className="social-center-page__loading"><Loader2 className="animate-spin" /> Loading social data…</div>}
          {!loading && visibleFriends.length === 0 && <EmptyState icon={Search} title="No matching friends" description="Clear the search or filter to see your friend list." />}
          <div className="social-center-page__groups">{Object.entries(groupedFriends).map(([group, groupFriends]) => <section className="social-center-page__group" key={group}><header><strong>{group}</strong><small>{groupFriends.length}</small></header><div className="social-center-page__friends">{groupFriends.map((friend, index) => { const id = friend.summonerId || friend.id || friend.puuid || `${friendName(friend)}-${index}`; const isSelected = selected.has(id); const profileURL = externalProfileURL('opgg', friend.region || '', friend.gameName || '', friend.tagLine || ''); return <div className={`social-center-page__friend ${isSelected ? 'is-selected' : ''}`} key={id}>
            <button type="button" className="social-center-page__select" onClick={() => toggleSelected(friend)} aria-label={`${isSelected ? 'Deselect' : 'Select'} ${friendName(friend)}`} aria-pressed={isSelected}>{isSelected ? <Check /> : <span />}</button>
            {friend.profileIconId ? <img src={`/lol-game-data/assets/v1/profile-icons/${friend.profileIconId}.jpg`} alt="" width="40" height="40" loading="lazy" /> : <span className={`social-center-page__presence ${statusTone(friend.availability)}`}><span /></span>}
            <span className="social-center-page__friend-copy"><strong>{friendName(friend)}</strong><small>{friend.productName || 'League of Legends'} · {(friend.availability || 'offline').toLowerCase()}</small></span>
            {profileURL && <a href={profileURL} target="_blank" rel="noreferrer" className="social-center-page__external" aria-label={`Open ${friendName(friend)} profile`}><ExternalLink /></a>}
            <Star className="social-center-page__star" />
          </div>; })}</div></section>)}</div>
          <div className="social-center-page__bulk"><span>{selected.size ? `${selected.size} selected` : 'Select friends to invite'}</span><div className="social-center-page__bulk-actions"><button type="button" className="btn-danger" disabled={remoteClient || selected.size === 0 || busy !== '' || selected.size > 20} onClick={() => void removeSelected()}><Trash2 /> {busy === 'remove' ? 'Removing…' : t('social.remove')}</button><button type="button" className="btn-primary" disabled={selected.size === 0 || busy !== '' || selected.size > (remoteClient ? 1 : 20)} onClick={() => void inviteSelected()}><Send /> {busy === 'invite' ? 'Inviting…' : t('social.invite')}</button></div></div>
        </WorkspaceSection>
      </main>
      <aside className="social-center-page__side"><WorkspaceSection eyebrow="INBOX" title={t('social.requests')} description="Choose each request explicitly; no automatic acceptance is performed.">
        {requests.length === 0 && <div className="social-center-page__empty"><Mail /><span>No pending friend requests.</span></div>}
        {requests.map((request, index) => { const id = String(request.pid || request.id || index); const label = request.gameName ? `${request.gameName}#${request.tagLine || ''}` : request.name || 'Riot ID unavailable'; const checked = selectedRequests.has(id); return <div className={`social-center-page__request ${checked ? 'is-selected' : ''}`} key={id}><button type="button" className="social-center-page__request-select" onClick={() => setSelectedRequests((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} aria-label={`${checked ? 'Deselect' : 'Select'} ${label}`} aria-pressed={checked}>{checked ? <Check /> : <span />}</button><span><strong>{label}</strong><small>{request.direction || request.state || 'Pending'}</small></span><div><button type="button" className="btn-secondary" disabled={busy !== ''} onClick={() => void run(`accept-${id}`, () => actOnLCUFriendRequest(id, 'accept'), 'Friend request accepted.')}><Check /></button><button type="button" className="btn-danger" disabled={busy !== ''} onClick={() => void run(`decline-${id}`, () => actOnLCUFriendRequest(id, 'decline'), 'Friend request declined.')}><X /></button></div></div>; })}
        {selectedRequests.size > 0 && <div className="social-center-page__request-bulk"><span>{selectedRequests.size} selected</span><button type="button" className="btn-secondary" disabled={busy !== '' || remoteClient} onClick={() => void batchRequests('request-accept')}><Check /> Accept all</button><button type="button" className="btn-danger" disabled={busy !== '' || remoteClient} onClick={() => void batchRequests('request-decline')}><X /> Decline all</button></div>}
      </WorkspaceSection>{!remoteClient && <WorkspaceSection eyebrow="REVIEW HISTORY" title="Recent operations" description="Receipts are retained locally for seven days and never include credentials."><div className="social-center-page__receipts">{receipts.length === 0 && <small>No reviewed operations yet.</small>}{receipts.slice().reverse().map((receipt) => <div key={receipt.id}><span><strong>{receipt.kind.replaceAll('-', ' ')}</strong><small>{receipt.succeeded}/{receipt.total} succeeded · {new Date(receipt.createdAt).toLocaleString()}</small></span><b className={receipt.failed > 0 || receipt.cancelled ? 'is-warning' : 'is-success'}>{receipt.cancelled ? 'Cancelled' : receipt.failed > 0 ? `${receipt.failed} failed` : 'Complete'}</b></div>)}</div>{receipts.length > 0 && <button type="button" className="btn-secondary" onClick={() => { if (window.confirm('Clear reviewed operation history?')) void clearReviewedOperationReceipts().then(() => setReceipts([])).catch((reason: any) => setFeedback({ tone: 'error', message: reason?.message || 'Could not clear operation history.' })); }}>Clear history</button>}</WorkspaceSection>}</aside>
    </div>}
  </div>;
}
