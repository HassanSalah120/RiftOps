import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Circle, Loader2, RefreshCw, Search, Star, Users, WifiOff } from 'lucide-react';
import { fetchLCUFriends } from '../api';
import { useLCUConnection } from './lcuConnectionContext';

type Friend = {
  id?: string;
  name?: string;
  summonerName?: string;
  displayName?: string;
  gameName?: string;
  tagLine?: string;
  availability?: string;
  productName?: string;
  product?: string;
  puuid?: string;
  profileIconId?: number;
  iconId?: number;
};

function displayName(friend: Friend): string {
  if (friend.gameName) return friend.tagLine ? `${friend.gameName}#${friend.tagLine}` : friend.gameName;
  return friend.name || friend.summonerName || friend.displayName || 'Unnamed friend';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizeFriend(value: unknown): Friend | null {
  if (!isRecord(value)) return null;
  const nested = isRecord(value.summoner) ? value.summoner : isRecord(value.player) ? value.player : {};
  const getString = (...keys: string[]) => keys.map((key) => value[key] ?? nested[key]).find((item): item is string => typeof item === 'string' && item.trim() !== '')?.trim();
  const friend: Friend = {
    id: getString('id', 'summonerId', 'jid'),
    name: getString('name'),
    summonerName: getString('summonerName'),
    displayName: getString('displayName'),
    gameName: getString('gameName'),
    tagLine: getString('tagLine', 'tagline'),
    availability: getString('availability', 'status', 'presence'),
    productName: getString('productName'),
    product: getString('product'),
    puuid: getString('puuid', 'playerUuid'),
    profileIconId: numberValue(value.profileIconId ?? value.summonerIconId ?? nested.profileIconId),
    iconId: numberValue(value.iconId ?? nested.iconId),
  };
  return Object.values(friend).some((item) => item !== undefined && item !== '') ? friend : null;
}

function normalizeFriendsPayload(body: unknown): Friend[] {
  if (Array.isArray(body)) return body.flatMap((item) => normalizeFriendsPayload(item));
  if (!isRecord(body)) return [];

  for (const key of ['friends', 'items', 'entries', 'data']) {
    if (Array.isArray(body[key])) return normalizeFriendsPayload(body[key]);
  }

  const direct = normalizeFriend(body);
  if (direct) return [direct];
  return Object.values(body).flatMap((item) => normalizeFriendsPayload(item));
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

export default function FriendsPanel({ connected, id }: { connected: boolean; id?: string }) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'favorites'>('all');
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('riftops.friends.favorites') || '[]')); } catch { return new Set(); }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { pageVisible, pollInterval } = useLCUConnection();

  const refresh = useCallback(async () => {
    if (!connected || !pageVisible || collapsed) return;
    setLoading(true);
    try {
      const body = await fetchLCUFriends();
      setFriends(normalizeFriendsPayload(body));
      setError('');
    } catch (reason: any) {
      setError(reason?.message || 'Friends are unavailable.');
      setFriends([]);
    } finally {
      setLoading(false);
    }
  }, [collapsed, connected, pageVisible]);

  useEffect(() => {
    if (!connected || !pageVisible || collapsed) return undefined;
    void refresh();
    const timer = window.setInterval(() => void refresh(), Math.max(10000, pollInterval * 2));
    return () => window.clearInterval(timer);
  }, [collapsed, connected, pageVisible, pollInterval, refresh]);

  const onlineCount = useMemo(() => friends.filter((friend) => ['chat', 'online', 'away', 'mobile'].includes((friend.availability || '').toLowerCase())).length, [friends]);
  const visibleFriends = useMemo(() => friends
    .filter((friend) => filter === 'all' || filter === 'favorites' || ['chat', 'online', 'away', 'mobile'].includes((friend.availability || '').toLowerCase()))
    .filter((friend) => filter !== 'favorites' || favorites.has(friend.puuid || friend.id || displayName(friend)))
    .filter((friend) => !query.trim() || displayName(friend).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(statusTone(b.availability) === 'is-online') - Number(statusTone(a.availability) === 'is-online') || displayName(a).localeCompare(displayName(b))), [filter, friends, query, favorites]);

  const toggleFavorite = (friend: Friend) => {
    const id = friend.puuid || friend.id || displayName(friend);
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem('riftops.friends.favorites', JSON.stringify([...next])); } catch { /* Optional preference. */ }
      return next;
    });
  };

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try { window.localStorage.setItem('riftops.friends.collapsed', String(next)); } catch { /* Storage is optional. */ }
      return next;
    });
  };

  return (
    <section id={id} className={`friends-panel ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="friends-panel__header">
        <button type="button" className="friends-panel__toggle" onClick={toggleCollapsed} aria-expanded={!collapsed}>
          <span className="friends-panel__title-icon"><Users /></span>
          <span className="friends-panel__title-copy"><small>SOCIAL</small><strong>Friends</strong></span>
          <span className="friends-panel__summary">{connected ? `${onlineCount} online · ${friends.length} total` : 'League Client offline'}</span>
          {collapsed ? <ChevronDown className="friends-panel__chevron" /> : <ChevronUp className="friends-panel__chevron" />}
        </button>
        <button type="button" className="friends-panel__refresh" onClick={() => void refresh()} disabled={loading || !connected || collapsed} aria-label="Refresh friends">
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
            <button type="button" className={filter === 'favorites' ? 'is-selected' : ''} onClick={() => setFilter('favorites')}>Favorites <span>{favorites.size}</span></button>
          </div>
        </div>
        {loading && friends.length === 0 && <div className="friends-panel__empty"><Loader2 className="animate-spin" /><span>Loading friends…</span></div>}
        {!loading && visibleFriends.length === 0 && <div className="friends-panel__empty"><Users /><span>{error || (query ? 'No friends match your search.' : 'No friends are available.')}</span></div>}
        {visibleFriends.length > 0 && <div className="friends-panel__list">{visibleFriends.map((friend, index) => {
          const friendId = friend.puuid || friend.id || displayName(friend);
          const favorite = favorites.has(friendId);
          const iconId = friend.profileIconId || friend.iconId;
          return <div className="friends-panel__friend" key={friendId || `${displayName(friend)}-${index}`}>
            {iconId ? <img className="friends-panel__avatar" src={`/lol-game-data/assets/v1/profile-icons/${iconId}.jpg`} alt="" width="36" height="36" loading="lazy" /> : <span className={`friends-panel__status ${statusTone(friend.availability)}`}><Circle /></span>}
            <span className="friends-panel__copy"><strong>{displayName(friend)}</strong><small>{friend.productName || friend.product || statusLabel(friend.availability)}</small></span>
            <span className={`friends-panel__availability ${statusTone(friend.availability)}`}>{statusLabel(friend.availability)}</span>
            <button type="button" className={`friends-panel__favorite ${favorite ? 'is-favorite' : ''}`} onClick={() => toggleFavorite(friend)} aria-label={favorite ? `Remove ${displayName(friend)} from favorites` : `Favorite ${displayName(friend)}`}><Star /></button>
          </div>;
        })}</div>}
      </>}
    </section>
  );
}
