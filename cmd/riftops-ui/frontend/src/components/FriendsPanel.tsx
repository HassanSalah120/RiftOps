import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Circle, Loader2, RefreshCw, Search, Users, WifiOff } from 'lucide-react';
import { fetchLCUFriends } from '../api';

type Friend = {
  id?: string;
  name?: string;
  gameName?: string;
  tagLine?: string;
  availability?: string;
  productName?: string;
  product?: string;
  puuid?: string;
};

function displayName(friend: Friend): string {
  if (friend.gameName) return friend.tagLine ? `${friend.gameName}#${friend.tagLine}` : friend.gameName;
  return friend.name || 'Unnamed friend';
}

function statusLabel(availability: string | undefined): string {
  const value = (availability || '').toLowerCase();
  if (value === 'chat' || value === 'online') return 'Online';
  if (value === 'dnd') return 'Do not disturb';
  if (value === 'away') return 'Away';
  if (value === 'mobile') return 'Mobile';
  return 'Offline';
}

function statusTone(availability: string | undefined): string {
  const value = (availability || '').toLowerCase();
  if (value === 'chat' || value === 'online') return 'is-online';
  if (value === 'away' || value === 'dnd') return 'is-away';
  if (value === 'mobile') return 'is-mobile';
  return 'is-offline';
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem('riftops.friends.collapsed') === 'true';
  } catch {
    return false;
  }
}

export default function FriendsPanel({ connected }: { connected: boolean }) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const refresh = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    try {
      const body = await fetchLCUFriends();
      const values = Array.isArray(body) ? body : Object.values((body || {}) as Record<string, unknown>);
      setFriends(values.filter((friend): friend is Friend => Boolean(friend && typeof friend === 'object')));
      setError('');
    } catch (reason: any) {
      setError(reason?.message || 'Friends are unavailable.');
      setFriends([]);
    } finally {
      setLoading(false);
    }
  }, [connected]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const onlineCount = useMemo(() => friends.filter((friend) => ['chat', 'online', 'away', 'mobile'].includes((friend.availability || '').toLowerCase())).length, [friends]);
  const visibleFriends = useMemo(() => friends
    .filter((friend) => filter === 'all' || ['chat', 'online', 'away', 'mobile'].includes((friend.availability || '').toLowerCase()))
    .filter((friend) => !query.trim() || displayName(friend).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(statusTone(b.availability) === 'is-online') - Number(statusTone(a.availability) === 'is-online') || displayName(a).localeCompare(displayName(b))), [filter, friends, query]);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try { window.localStorage.setItem('riftops.friends.collapsed', String(next)); } catch { /* Storage is optional. */ }
      return next;
    });
  };

  return (
    <section className={`friends-panel ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="friends-panel__header">
        <button type="button" className="friends-panel__toggle" onClick={toggleCollapsed} aria-expanded={!collapsed}>
          <span className="friends-panel__title-icon"><Users /></span>
          <span className="friends-panel__title-copy"><small>SOCIAL</small><strong>Friends</strong></span>
          <span className="friends-panel__summary">{connected ? `${onlineCount} online · ${friends.length} total` : 'League Client offline'}</span>
          {collapsed ? <ChevronDown className="friends-panel__chevron" /> : <ChevronUp className="friends-panel__chevron" />}
        </button>
        <button type="button" className="friends-panel__refresh" onClick={() => void refresh()} disabled={loading || !connected} aria-label="Refresh friends">
          <RefreshCw className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {!collapsed && !connected && <div className="friends-panel__empty"><WifiOff /><span>Connect to League Client to load your friend list.</span></div>}
      {!collapsed && connected && <>
        <div className="friends-panel__tools">
          <div className="friends-panel__search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search friends" aria-label="Search friends" /></div>
          <div className="friends-panel__filters">
            <button type="button" className={filter === 'all' ? 'is-selected' : ''} onClick={() => setFilter('all')}>All <span>{friends.length}</span></button>
            <button type="button" className={filter === 'online' ? 'is-selected' : ''} onClick={() => setFilter('online')}>Online <span>{onlineCount}</span></button>
          </div>
        </div>
        {loading && friends.length === 0 && <div className="friends-panel__empty"><Loader2 className="animate-spin" /><span>Loading friends…</span></div>}
        {!loading && visibleFriends.length === 0 && <div className="friends-panel__empty"><Users /><span>{error || (query ? 'No friends match your search.' : 'No friends are available.')}</span></div>}
        {visibleFriends.length > 0 && <div className="friends-panel__list">{visibleFriends.map((friend, index) => <div className="friends-panel__friend" key={friend.puuid || friend.id || `${displayName(friend)}-${index}`}><span className={`friends-panel__status ${statusTone(friend.availability)}`}><Circle /></span><span className="friends-panel__copy"><strong>{displayName(friend)}</strong><small>{friend.productName || friend.product || statusLabel(friend.availability)}</small></span><span className={`friends-panel__availability ${statusTone(friend.availability)}`}>{statusLabel(friend.availability)}</span></div>)}</div>}
      </>}
    </section>
  );
}
