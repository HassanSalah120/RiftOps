import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight, Ban, Check, CheckCircle2, ChevronDown, Clock3, Eye, Flame, LockKeyhole, Loader2,
  Map, Pencil, RefreshCw, RotateCcw, Search, Shield, Sparkles, Swords, Users, Volume2, VolumeX, WifiOff,
} from 'lucide-react';
import {
  DDBASE, ddChampionIcon, fetchDDChampions, fetchDDragonVersion,
  fetchLCUChampSelect, fetchLCUChampSelectBannable, fetchLCUChampSelectPickable,
  fetchLCUChampSelectPickOrderSwaps, fetchLCUChampSelectPositionSwaps,
  fetchLCUChampSelectSkins, fetchLCURunePages, mutateLCUChampSelectSwap, rerollLCUChampSelect,
  selectLCURunePage, submitLCUChampSelectAction, swapLCUChampSelectBench,
  updateLCUChampSelectSelection, muteLCUChampSelectPlayer,
} from '../api';
import type { DDChampion, DDChampionList, LCURunePage } from '../api';
import {
  currentChampSelectTurn,
  firstLocalPendingPick,
  flattenChampSelectActions,
  hasChampSelectActionID,
  liveLocalChampSelectAction,
} from '../champSelectFlow';
import type { ChampSelectAction as SelectAction, ChampSelectSession as BaseChampSelectSession, ChampSelectSwap } from '../champSelectFlow';
import { ARENA_BRAVERY_CHAMPION_ID, isArenaBraveryPick, isArenaChampSelect } from '../arenaBravery';
import { arenaEventKey, arenaEventLabel } from '../arenaTelemetry';
import { useLCUConnection } from './lcuConnectionContext';
import RunePageEditor from './RunePageEditor';

type TeamMember = {
  cellId?: number;
  championId?: number;
  championPickIntent?: number;
  championName?: string;
  summonerId?: string | number;
  summonerName?: string;
  displayName?: string;
  selectedSkinId?: number;
  selectedSkinIndex?: number;
  spell1Id?: number;
  spell2Id?: number;
  assignedPosition?: string;
  assignedRole?: string;
  position?: string;
  puuid?: string;
  muted?: boolean;
  isMuted?: boolean;
  team?: number;
  teamId?: number;
};

type Session = Omit<BaseChampSelectSession, 'timer'> & {
  timer?: { phase?: string; timeLeft?: number; adjustedTimeLeftInPhase?: number; isInfinite?: boolean };
  myTeam?: TeamMember[];
  theirTeam?: TeamMember[];
  benchEnabled?: boolean;
  benchChampionIds?: number[];
};

type Skin = {
  id: number;
  championId?: number;
  name?: string;
  isBase?: boolean;
  owned?: boolean;
  ownership?: { owned?: boolean };
};

type Spell = { id: number; name: string; image?: string };
type ToastType = 'info' | 'success' | 'error';

const FALLBACK_SPELLS: Spell[] = [
  { id: 1, name: 'Cleanse' }, { id: 3, name: 'Exhaust' }, { id: 4, name: 'Flash' },
  { id: 6, name: 'Ghost' }, { id: 7, name: 'Heal' }, { id: 11, name: 'Smite' },
  { id: 12, name: 'Teleport' }, { id: 13, name: 'Clarity' }, { id: 14, name: 'Ignite' },
  { id: 21, name: 'Barrier' }, { id: 30, name: 'To the King' }, { id: 32, name: 'Mark' },
];

function championID(member: TeamMember): number {
  return Number(member.championId || member.championPickIntent || 0);
}

function memberName(member: TeamMember, index: number, enemy = false): string {
  return member.displayName || member.summonerName || (enemy ? `Opponent ${index + 1}` : `Player ${index + 1}`);
}

function championLabel(member: TeamMember, champions: Record<number, DDChampion>): string {
  const id = championID(member);
  if (isArenaBraveryPick(id)) return 'Bravery (Arena)';
  if (member.championName) return member.championName;
  if (id && champions[id]) return champions[id].name;
  if (id) return `Champion ${id}`;
  return 'Unassigned';
}

function normaliseSkin(raw: Skin): Skin {
  const ownership = raw.ownership?.owned;
  return { ...raw, owned: typeof raw.owned === 'boolean' ? raw.owned : ownership !== false };
}

function readTimeLeft(timer?: Session['timer']): number {
  return Number(timer?.adjustedTimeLeftInPhase ?? timer?.timeLeft ?? 0);
}

function swapNumber(swap: ChampSelectSwap, fields: string[]): number {
  for (const field of fields) {
    const value = Number(swap[field]);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return -1;
}

function swapState(swap: ChampSelectSwap): string {
  return String(swap.state || swap.status || '').trim().toUpperCase();
}

function swapTargetCell(swap: ChampSelectSwap, localCellID: number | undefined): number {
  const target = swapNumber(swap, ['targetCellId', 'otherCellId', 'cellId']);
  if (target >= 0 && target !== localCellID) return target;
  return swapNumber(swap, ['requesterCellId', 'requestingCellId']);
}

function swapTargetName(swap: ChampSelectSwap, team: TeamMember[], localCellID: number | undefined): string {
  const cellID = swapTargetCell(swap, localCellID);
  const member = team.find((entry) => entry.cellId === cellID);
  return member ? memberName(member, team.indexOf(member)) : 'teammate';
}

function swapIsPending(swap: ChampSelectSwap): boolean {
  const state = swapState(swap);
  return state.includes('PENDING') || state.includes('REQUEST') || state.includes('OFFER');
}

function swapIsFinished(swap: ChampSelectSwap): boolean {
  const state = swapState(swap);
  return state.includes('ACCEPT') || state.includes('DECLIN') || state.includes('CANCEL') || state.includes('COMPLETE') || state.includes('REJECT');
}

function ChampionIcon({ id, champions, version, enemy = false }: { id: number; champions: Record<number, DDChampion>; version: string; enemy?: boolean }) {
  if (isArenaBraveryPick(id)) return <span className={`champ-select-workspace__champion-icon is-bravery ${enemy ? 'is-enemy' : ''}`}>✦</span>;
  const champ = champions[id];
  if (!champ) return <span className={`champ-select-workspace__champion-icon ${enemy ? 'is-enemy' : ''}`}>{id ? '◆' : '·'}</span>;
  return <img className={`champ-select-workspace__champion-icon ${enemy ? 'is-enemy' : ''}`} src={ddChampionIcon(version, champ.id)} alt={champ.name} width="48" height="48" loading="lazy" />;
}

export default function ChampSelectWorkspace({
  connected,
  active,
  onToast,
  remoteClient = false,
  arenaMode = false,
}: {
  connected: boolean;
  active: boolean;
  onToast?: (message: string, type?: ToastType) => void;
  remoteClient?: boolean;
  arenaMode?: boolean;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [version, setVersion] = useState('15.1.1');
  const [champions, setChampions] = useState<Record<number, DDChampion>>({});
  const [pickable, setPickable] = useState<number[]>([]);
  const [bannable, setBannable] = useState<number[]>([]);
  const [skins, setSkins] = useState<Skin[]>([]);
  const [runePages, setRunePages] = useState<LCURunePage[]>([]);
  const [runeEditorOpen, setRuneEditorOpen] = useState(false);
  const [spells, setSpells] = useState<Spell[]>(FALLBACK_SPELLS);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [query, setQuery] = useState('');
  const [selectedChampion, setSelectedChampion] = useState(0);
  const [timerDeadline, setTimerDeadline] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const loadedOnce = useRef(false);
  const catalogueLoaded = useRef(false);
  const braverySelected = useRef(false);
  const braverySessionKey = useRef('');
  const { pageVisible, realtimeInterval } = useLCUConnection();

  const notify = useCallback((message: string, type: ToastType = 'info') => {
    setFeedback(message);
    onToast?.(message, type);
  }, [onToast]);

  const refresh = useCallback(async () => {
    if (!connected || !active || !pageVisible) return;
    if (!loadedOnce.current) setLoading(true);
    try {
      const [rawSession, pickOrderSwaps, positionSwaps] = await Promise.all([
        fetchLCUChampSelect(),
        fetchLCUChampSelectPickOrderSwaps().catch(() => []),
        fetchLCUChampSelectPositionSwaps().catch(() => []),
      ]);
      const next = rawSession as Session;
      // Some client builds embed pickOrderSwaps in the session while others
      // only expose the dedicated endpoints. Prefer the live endpoint when it
      // has entries, while preserving an embedded pending request.
      setSession({
        ...next,
        pickOrderSwaps: pickOrderSwaps.length ? pickOrderSwaps : next.pickOrderSwaps || [],
        positionSwaps: positionSwaps.length ? positionSwaps : next.positionSwaps || [],
      });
      // Anchor the countdown to wall-clock time so browser tab throttling or
      // slow polls cannot make the displayed timer drift from League's clock.
      setTimerDeadline(Date.now() + readTimeLeft(next.timer));
      setError('');
    } catch (reason: any) {
      setSession(null);
      setError(reason?.message || 'Champion Select session is unavailable.');
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, [active, connected, pageVisible]);

  const loadCatalogue = useCallback(async () => {
    if (catalogueLoaded.current || !connected || !active || !pageVisible) return;
    catalogueLoaded.current = true;
    const [ddVersion, ddChampions, availablePick, availableBan, availableSkins, pages] = await Promise.all([
      fetchDDragonVersion().catch(() => ({ version: version })),
      fetchDDChampions().catch(() => ({ data: {} } as DDChampionList)),
      fetchLCUChampSelectPickable().catch(() => []),
      fetchLCUChampSelectBannable().catch(() => []),
      fetchLCUChampSelectSkins().catch(() => []),
      fetchLCURunePages().catch(() => []),
    ]);
    setVersion(ddVersion.version || version);
    const mapped: Record<number, DDChampion> = {};
    Object.values(ddChampions.data || {}).forEach((champ) => { mapped[Number(champ.key)] = champ; });
    setChampions(mapped);
    setPickable(availablePick.map(Number).filter(Boolean));
    setBannable(availableBan.map(Number).filter(Boolean));
    setSkins((availableSkins as Skin[]).map(normaliseSkin));
    setRunePages(pages);
    try {
      const response = await fetch(`${DDBASE}/cdn/${ddVersion.version || version}/data/en_US/summoner.json`);
      if (response.ok) {
        const payload = await response.json() as { data?: Record<string, { key: string; name: string; image?: { full?: string } }> };
        const loaded = Object.values(payload.data || {}).map((spell) => ({ id: Number(spell.key), name: spell.name, image: spell.image?.full })).filter((spell) => spell.id > 0);
        if (loaded.length) setSpells(loaded);
      }
    } catch { /* Fallback spell catalogue is enough to keep selection usable. */ }
  }, [active, connected, pageVisible, version]);

  useEffect(() => {
    if (!active) {
      loadedOnce.current = false;
      catalogueLoaded.current = false;
      setSession(null);
      return undefined;
    }
    void refresh();
    if (!pageVisible) return undefined;
    const timer = window.setInterval(() => void refresh(), realtimeInterval);
    return () => window.clearInterval(timer);
  }, [active, pageVisible, realtimeInterval, refresh]);

  useEffect(() => { void loadCatalogue(); }, [loadCatalogue]);

  const hasSession = !!session;
  const timerIsInfinite = session?.timer?.isInfinite;
  useEffect(() => {
    if (!active || !hasSession || timerIsInfinite) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, hasSession, timerIsInfinite]);

  const actions = useMemo(() => flattenChampSelectActions(session), [session]);
  const sessionTimerPhase = String(session?.timer?.phase || '');
  const currentTurn = useMemo(() => (!session?.timer?.phase || session.timer.phase === 'BAN_PICK') ? currentChampSelectTurn(session) : [], [session]);
  const currentAction = liveLocalChampSelectAction(session);
  const planningPick = sessionTimerPhase === 'PLANNING' ? firstLocalPendingPick(session) : undefined;
  const fallbackLocalAction = actions.find((action) => action.actorCellId === session?.localPlayerCellId && !action.completed);
  const pending = currentAction || planningPick || fallbackLocalAction;
  const localMember = session?.myTeam?.find((member) => member.cellId === session.localPlayerCellId);
  const resolvedChampionID = championID(localMember || {});
  const pendingChampionID = Number(pending?.championId || 0);
  const activeChampionID = selectedChampion > 0 ? selectedChampion : pendingChampionID > 0 ? pendingChampionID : resolvedChampionID;
  const arenaLive = arenaMode || isArenaChampSelect(session);
  const braveryResolved = arenaLive && braverySelected.current && resolvedChampionID > 0;
  const phase = sessionTimerPhase || (active ? 'Champion Select' : 'Waiting');
  const seconds = session?.timer?.isInfinite ? 0 : Math.max(0, Math.ceil((timerDeadline - now) / 1000));
  const isLocalTurn = !!currentAction && pending?.actorCellId === session?.localPlayerCellId;
  const ActionIcon = pending?.type === 'ban' ? Ban : Flame;
  const bannedChampionIDs = useMemo(() => new Set(actions.filter((action) => action.type === 'ban' && action.completed).map((action) => Number(action.championId))), [actions]);
  const championIDs = useMemo(() => {
    const source = pending?.type === 'ban' ? bannable : pickable;
    const fallback = Object.keys(champions).map(Number);
    const ids = (source.length ? source : fallback).filter((id) => id > 0 && !bannedChampionIDs.has(id));
    return ids.filter((id) => !query || champions[id]?.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => (champions[a]?.name || '').localeCompare(champions[b]?.name || '')).slice(0, 72);
  }, [bannable, bannedChampionIDs, champions, pending?.type, pickable, query]);
  const localSkins = useMemo(() => skins.filter((skin) => Number(skin.championId) === activeChampionID && skin.owned !== false), [activeChampionID, skins]);
  const currentRune = runePages.find((page) => page.current || page.isActive) || runePages[0];
  const myCells = useMemo(() => new Set((session?.myTeam || []).map((member) => member.cellId)), [session?.myTeam]);
  const swapEntries = useMemo(() => [
    ...(session?.pickOrderSwaps || []).map((swap) => ({ kind: 'pick-order' as const, swap })),
    ...(session?.positionSwaps || []).map((swap) => ({ kind: 'position' as const, swap })),
  ].filter(({ swap }) => !swapIsFinished(swap)), [session?.pickOrderSwaps, session?.positionSwaps]);
  const isAllyAction = useCallback((action: SelectAction) => action.isAllyAction !== undefined ? action.isAllyAction : myCells.has(action.actorCellId), [myCells]);
  const isPlanningDeclaration = !!planningPick && pending === planningPick && !isLocalTurn;
  const canChooseChampion = hasChampSelectActionID(pending) && (isLocalTurn || isPlanningDeclaration) && (pending.type === 'pick' || pending.type === 'ban');
  const canControlAction = canChooseChampion && isLocalTurn;
  const arenaEvent = arenaLive ? arenaEventKey({ queueId: session?.queueId, gameMode: session?.gameMode, gameType: session?.gameType, mapId: session?.mapId }) : 'unknown';
  const braveryAvailable = arenaLive && pending?.type === 'pick' && canChooseChampion;

  useEffect(() => {
    const actionKey = (session?.actions || []).flatMap((turn) => turn || []).map((action) => action.id).filter((id) => id !== undefined).join(',');
    const nextKey = String(session?.gameId || `${session?.localPlayerCellId || ''}:${actionKey}`);
    if (braverySessionKey.current && nextKey !== braverySessionKey.current) braverySelected.current = false;
    braverySessionKey.current = nextKey;
    if (isArenaBraveryPick(pending?.championId) || isArenaBraveryPick(localMember?.championPickIntent)) braverySelected.current = true;
    setSelectedChampion(Number(pending?.championId || 0));
  }, [localMember?.championPickIntent, pending?.id, pending?.championId, session]);

  const runAction = useCallback(async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setFeedback('');
    try {
      await action();
      notify(success, 'success');
      await refresh();
    } catch (reason: any) {
      notify(reason?.message || 'League rejected the request.', 'error');
    } finally {
      setBusy('');
    }
  }, [notify, refresh]);

  const chooseChampion = (id: number) => {
    setSelectedChampion(id);
    if (!hasChampSelectActionID(pending) || !canChooseChampion) return;
    void runAction(`champion-${id}`, () => submitLCUChampSelectAction(Number(pending.id), id), `${pending.type === 'ban' ? 'Ban' : 'Champion'} selected.`);
  };

  const chooseBravery = () => {
    if (!braveryAvailable || !hasChampSelectActionID(pending)) return;
    braverySelected.current = true;
    setSelectedChampion(ARENA_BRAVERY_CHAMPION_ID);
    void runAction('bravery', () => submitLCUChampSelectAction(Number(pending.id), ARENA_BRAVERY_CHAMPION_ID), 'Arena Bravery selected.');
  };

  const lockChampion = () => {
    if (!hasChampSelectActionID(pending) || !selectedChampion || !canControlAction) return;
    void runAction('lock-champion', () => submitLCUChampSelectAction(Number(pending.id), selectedChampion, true), pending.type === 'ban' ? 'Ban locked.' : 'Champion locked in.');
  };

  const updateSpell = (slot: 1 | 2, value: string) => {
    const id = Number(value);
    void runAction(`spell-${slot}`, () => updateLCUChampSelectSelection(slot === 1 ? { spell1Id: id } : { spell2Id: id }), 'Summoner spell updated.');
  };

  const updateSkin = (value: string) => {
    const id = Number(value);
    void runAction('skin', () => updateLCUChampSelectSelection({ selectedSkinId: id }), 'Skin selected for this game.');
  };

  const updateRune = (value: string) => {
    const id = Number(value);
    void runAction('rune', () => selectLCURunePage(id), 'Rune page selected.');
    setRunePages((pages) => pages.map((page) => ({ ...page, current: page.id === id, isActive: page.id === id })));
  };

  const runSwap = (kind: 'pick-order' | 'position', swap: ChampSelectSwap, action: 'request' | 'accept' | 'cancel' | 'decline') => {
    const id = swapNumber(swap, ['id', 'swapId', 'cellId', 'targetCellId', 'otherCellId']);
    if (id < 0) {
      notify('League did not provide a valid swap target yet.', 'error');
      return;
    }
    const label = kind === 'pick-order' ? 'pick-order' : 'role';
    const actionLabel = action === 'request' ? 'requested' : action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled';
    void runAction(`swap-${kind}-${id}-${action}`, () => mutateLCUChampSelectSwap(kind, id, action), `${label} swap ${actionLabel}.`);
  };

  const mutePlayer = (member: TeamMember, muted: boolean) => {
    if (!member.puuid) return;
    void runAction(`mute-${member.cellId}`, () => muteLCUChampSelectPlayer(member.puuid!, muted), muted ? 'Player muted.' : 'Player unmuted.');
  };

  const muteUnmutedPlayers = async () => {
    const targets = (session?.myTeam || []).filter((member) => member.cellId !== session?.localPlayerCellId && member.puuid && !(member.muted || member.isMuted));
    if (!targets.length) return;
    setBusy('mute-all');
    try {
      for (const member of targets) await muteLCUChampSelectPlayer(member.puuid!, true);
      notify(`${targets.length} teammate${targets.length === 1 ? '' : 's'} muted.`, 'success');
      await refresh();
    } catch (reason: any) { notify(reason?.message || 'League rejected a mute action.', 'error'); }
    finally { setBusy(''); }
  };

  const localTeamID = Number(localMember?.teamId || localMember?.team || 0);
  const sideLabel = localTeamID === 100 ? 'Blue side' : localTeamID === 200 ? 'Red side' : 'Side assigned by League';
  const mapLabel = Number(session?.mapId) === 11 ? "Summoner's Rift" : Number(session?.mapId) === 12 ? 'Howling Abyss' : Number(session?.mapId) === 30 ? 'Arena' : session?.mapId ? `Map ${session.mapId}` : 'Map unavailable';

  return (
    <section className="champ-select-workspace">
      <div className="champ-select-workspace__header">
        <div className="champ-select-workspace__title"><span className="champ-select-workspace__icon"><Swords /></span><span><small>LIVE CLIENT CONTROL</small><strong>Champion Select</strong></span></div>
        <div className="champ-select-workspace__status"><span className={`champ-select-workspace__dot ${active && session ? 'is-online' : ''}`} />{active && session ? phase.replaceAll('_', ' ') : 'Waiting for champion select'}<button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh champion select"><RefreshCw className={loading ? 'animate-spin' : ''} /></button></div>
      </div>

      {!connected && <div className="champ-select-workspace__empty"><WifiOff /><span>Connect to League Client to see and control picks, bans, and timers.</span></div>}
      {connected && !active && <div className="champ-select-workspace__empty"><Eye /><span>This workspace becomes live when League enters Champion Select.</span></div>}
      {connected && active && !session && <div className="champ-select-workspace__empty"><Clock3 /><span>{error || 'Waiting for the Champion Select session…'}</span></div>}

      {session && (
        <>
          {arenaLive && <div className="champ-select-workspace__arena-banner"><span className="champ-select-workspace__arena-mark">✦</span><span><small>ARENA EVENT</small><strong>{arenaEventLabel(arenaEvent)}</strong><em>{braveryAvailable ? 'Bravery and League-provided Crowd Favorites are available for this pick.' : 'League is still publishing the current Arena choices.'}</em></span></div>}
          <div className="champ-select-workspace__map-context"><Map /><span><small>MAP & SIDE</small><strong>{mapLabel}</strong><em>{sideLabel}</em></span><button type="button" className="btn-secondary" disabled={busy !== '' || !(session.myTeam || []).some((member) => member.cellId !== session.localPlayerCellId && member.puuid && !(member.muted || member.isMuted))} onClick={() => void muteUnmutedPlayers()}><VolumeX />Mute unmuted</button></div>
          <div className="champ-select-workspace__timer">
            <div><span>{currentAction ? 'Your action' : currentTurn.length ? 'Waiting for turn' : phase.replaceAll('_', ' ')}</span><small>{currentTurn.filter((action) => !action.completed).length ? `${currentTurn.filter((action) => !action.completed).length} action${currentTurn.filter((action) => !action.completed).length === 1 ? '' : 's'} in turn` : 'Live session'}</small></div>
            <strong>{session.timer?.isInfinite ? '∞' : `${seconds}s`}</strong>
            {pending?.type && <span className={`champ-select-workspace__action-tag is-${pending.type}`}><ActionIcon />{pending.type === 'ban' ? 'Ban' : 'Pick'}</span>}
          </div>

          <div className="champ-select-workspace__bans">
            <span><Ban /> OUR BANS</span>
            <div>{actions.filter((action) => action.type === 'ban' && isAllyAction(action)).map((action, index) => <ChampionIcon key={action.id ?? index} id={Number(action.championId)} champions={champions} version={version} />)}</div>
            <span><Shield /> ENEMY BANS</span>
            <div>{actions.filter((action) => action.type === 'ban' && !isAllyAction(action)).map((action, index) => <ChampionIcon key={action.id ?? index} id={Number(action.championId)} champions={champions} version={version} enemy />)}</div>
          </div>

          <div className="champ-select-workspace__body">
            <div className="champ-select-workspace__teams">
              <div><h4><Users /> Your team</h4>{(session.myTeam || []).map((member, index) => <div className={`champ-select-workspace__member ${member.cellId === session.localPlayerCellId ? 'is-local' : ''}`} key={member.cellId || member.summonerId || index}><ChampionIcon id={championID(member)} champions={champions} version={version} /><span>{memberName(member, index)}</span><small>{championLabel(member, champions)}</small>{member.cellId === session.localPlayerCellId ? <em>YOU</em> : member.puuid && <button type="button" className="champ-select-workspace__mute" aria-label={`${member.muted || member.isMuted ? 'Unmute' : 'Mute'} ${memberName(member, index)}`} onClick={() => mutePlayer(member, !(member.muted || member.isMuted))} disabled={busy !== ''}>{member.muted || member.isMuted ? <Volume2 /> : <VolumeX />}</button>}</div>)}</div>
              <div><h4><Shield /> Opponents</h4>{(session.theirTeam || []).map((member, index) => <div className="champ-select-workspace__member" key={member.cellId || member.summonerId || index}><ChampionIcon id={championID(member)} champions={champions} version={version} enemy /><span>{memberName(member, index, true)}</span><small>{championLabel(member, champions)}</small></div>)}</div>
              <div className="champ-select-workspace__swaps">
                <div className="champ-select-workspace__swaps-heading"><span><ArrowLeftRight /> TEAM SWAPS</span><small>Swap pick order or lane with a teammate</small></div>
                {swapEntries.length === 0 && <div className="champ-select-workspace__swaps-empty">League will show available requests here when this queue and phase support swaps.</div>}
                {swapEntries.map(({ kind, swap }, index) => {
                  const id = swapNumber(swap, ['id', 'swapId', 'cellId', 'targetCellId', 'otherCellId']);
                  const requester = swapNumber(swap, ['requesterCellId', 'requestingCellId']);
                  const pendingSwap = swapIsPending(swap);
                  const localRequester = requester >= 0 && requester === session.localPlayerCellId;
                  const title = kind === 'pick-order' ? 'Pick-order swap' : 'Role swap';
                  const target = swapTargetName(swap, session.myTeam || [], session.localPlayerCellId);
                  const disabled = busy !== '' || id < 0;
                  return <div className="champ-select-workspace__swap" key={`${kind}-${id}-${index}`}>
                    <div><strong>{title}</strong><small>{pendingSwap ? (localRequester ? `Waiting for ${target}` : `${target} wants to swap`) : `Available with ${target}`}</small></div>
                    <div className="champ-select-workspace__swap-actions">
                      {!pendingSwap && <button type="button" onClick={() => runSwap(kind, swap, 'request')} disabled={disabled}>{id < 0 ? 'Waiting…' : 'Request'}</button>}
                      {pendingSwap && localRequester && <button type="button" onClick={() => runSwap(kind, swap, 'cancel')} disabled={disabled}>Cancel</button>}
                      {pendingSwap && !localRequester && <><button type="button" onClick={() => runSwap(kind, swap, 'accept')} disabled={disabled}>Accept</button><button type="button" onClick={() => runSwap(kind, swap, 'decline')} disabled={disabled}>Decline</button></>}
                    </div>
                  </div>;
                })}
              </div>
            </div>

            <aside className="champ-select-workspace__controls">
              <div className="champ-select-workspace__control-heading"><div><small>{isPlanningDeclaration ? 'PICK INTENT' : pending?.type === 'ban' ? 'BAN PHASE' : 'PICK PHASE'}</small><strong>{pending ? (isLocalTurn ? `Choose a champion to ${pending.type === 'ban' ? 'ban' : 'pick'}` : isPlanningDeclaration ? 'Declare your champion before your turn' : 'Waiting for the next action') : 'Loadout & session tools'}</strong></div><Sparkles /></div>
              {canChooseChampion && <>
                <div className="champ-select-workspace__search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${pending.type === 'ban' ? 'a champion to ban' : 'a champion'}`} aria-label="Search champions" /></div>
                {braveryAvailable && <button type="button" className={`champ-select-workspace__bravery ${selectedChampion === ARENA_BRAVERY_CHAMPION_ID ? 'is-selected' : ''}`} onClick={chooseBravery} disabled={busy !== ''}>
                  <span className="champ-select-workspace__bravery-icon">✦</span><span><strong>Bravery</strong><small>Let Arena assign a random champion</small></span>{selectedChampion === ARENA_BRAVERY_CHAMPION_ID && <Check />}
                </button>}
                {arenaLive && pending?.type === 'pick' && <div className="champ-select-workspace__arena-pool"><span>LEAGUE CHOICE POOL</span><small>{pickable.length ? `${pickable.length} choices currently exposed` : 'Waiting for League choices…'}</small></div>}
                <div className="champ-select-workspace__champion-grid">{championIDs.map((id) => <button type="button" key={id} className={selectedChampion === id ? 'is-selected' : ''} onClick={() => chooseChampion(id)} disabled={busy.startsWith('champion-')} title={champions[id]?.name || `Champion ${id}`}><ChampionIcon id={id} champions={champions} version={version} /><span>{champions[id]?.name || id}</span>{selectedChampion === id && <Check />}</button>)}</div>
                {canControlAction
                  ? <div className="champ-select-workspace__control-actions"><button type="button" className="champ-select-workspace__lock" disabled={!selectedChampion || busy !== ''} onClick={lockChampion}>{busy === 'lock-champion' ? <Loader2 className="animate-spin" /> : <LockKeyhole />}{pending.type === 'ban' ? 'Lock ban' : 'Lock in'}</button></div>
                  : <div className="champ-select-workspace__feedback"><Eye />Choose a champion to update your visible pick intent.</div>}
              </>}
              {!canChooseChampion && <div className="champ-select-workspace__waiting"><Clock3 /><span>{pending ? 'League is waiting on another player.' : 'No active pick or ban right now.'}</span></div>}

              <div className="champ-select-workspace__loadout">
                <div><label htmlFor="champ-select-spell-1">Summoner spell 1</label><select id="champ-select-spell-1" value={localMember?.spell1Id || ''} onChange={(event) => updateSpell(1, event.target.value)} disabled={busy !== ''}><option value="">Not selected</option>{spells.map((spell) => <option key={spell.id} value={spell.id}>{spell.name}</option>)}</select><ChevronDown /></div>
                <div><label htmlFor="champ-select-spell-2">Summoner spell 2</label><select id="champ-select-spell-2" value={localMember?.spell2Id || ''} onChange={(event) => updateSpell(2, event.target.value)} disabled={busy !== ''}><option value="">Not selected</option>{spells.map((spell) => <option key={spell.id} value={spell.id}>{spell.name}</option>)}</select><ChevronDown /></div>
                <div><label htmlFor="champ-select-skin">{braveryResolved ? `Skin · ${champions[activeChampionID]?.name || 'Bravery champion'}` : 'Skin'}</label><select id="champ-select-skin" value={localMember?.selectedSkinId || localMember?.selectedSkinIndex || ''} onChange={(event) => updateSkin(event.target.value)} disabled={!localSkins.length || busy !== ''}><option value="">Default skin</option>{localSkins.map((skin) => <option key={skin.id} value={skin.id}>{skin.name || `Skin ${skin.id}`}</option>)}</select><ChevronDown /></div>
                <div><label htmlFor="champ-select-rune">Rune page</label><select id="champ-select-rune" value={currentRune?.id || ''} onChange={(event) => updateRune(event.target.value)} disabled={!runePages.length || busy !== ''}><option value="">Use current page</option>{runePages.filter((page) => page.isEditable !== false).map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}</select><ChevronDown /></div>
              </div>
              {braveryResolved && <div className="champ-select-workspace__bravery-skin-note"><Sparkles /> League resolved your Bravery champion. Choose an owned skin before the final lock if the timer allows it.</div>}
              {!remoteClient && <button type="button" className="champ-select-workspace__rune-edit" onClick={() => setRuneEditorOpen(true)} disabled={!currentRune || currentRune.isEditable === false || busy !== ''}><Pencil /> Edit {currentRune?.name || 'current rune page'}</button>}

              {(session.benchEnabled || (session.benchChampionIds || []).length > 0) && <div className="champ-select-workspace__aram"><div><small>ARAM BENCH</small><strong>Swap or reroll your champion</strong></div><div className="champ-select-workspace__aram-actions">{(session.benchChampionIds || []).slice(0, 5).map((id) => <button type="button" key={id} onClick={() => void runAction(`bench-${id}`, () => swapLCUChampSelectBench(id), 'Champion swapped from the bench.')} disabled={busy !== ''}><ChampionIcon id={id} champions={champions} version={version} /></button>)}<button type="button" className="is-reroll" onClick={() => void runAction('reroll', rerollLCUChampSelect, 'Champion rerolled.')} disabled={busy !== ''}><RotateCcw /> Reroll</button></div></div>}
              {feedback && <div className="champ-select-workspace__feedback"><CheckCircle2 />{feedback}</div>}
            </aside>
          </div>
        </>
      )}
      {!remoteClient && <RunePageEditor
        open={runeEditorOpen}
        page={currentRune || null}
        onClose={() => setRuneEditorOpen(false)}
        onSaved={async (updated) => {
          setRunePages((pages) => pages.map((page) => page.id === updated.id ? updated : page));
          notify(`${updated.name} saved to League.`, 'success');
        }}
      />}
    </section>
  );
}
