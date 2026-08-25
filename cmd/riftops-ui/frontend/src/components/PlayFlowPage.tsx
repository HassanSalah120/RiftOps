import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Ban, BookOpen, Check, CheckCircle2, CircleStop, Clock3, GitBranch, Loader2, Play,
  Pencil, RefreshCw, Rocket, Search, ShieldCheck, Sparkles, Square, Swords, Users, WifiOff, X, Zap,
} from 'lucide-react';
import {
  ddChampionIcon, createLCULobby, createPracticeToolLobby, fetchDDChampions,
  fetchDDragonVersion, fetchGameflowPhase, fetchLCUAvailableQueues,
  fetchLCULobby, fetchLCUChampSelect, fetchLCUChampSelectBannable,
  fetchLCUChampSelectPickable, fetchLCURunePages, launchGame, launchLCULeague,
  lcuAutoAccept, lcuAutoRequeue, lcuAutoRoles, lcuCustomStart, lcuStopQueue,
  selectLCURunePage, submitLCUChampSelectAction, updateLCUChampSelectSelection,
} from '../api';
import type { DDChampion, DDChampionList, LCUAvailableQueue, LCULobby, LCURunePage } from '../api';
import {
  champSelectSessionKey,
  chooseChampSelectChampion,
  draftTimingRemainingMs,
  firstLocalPendingPick,
  flattenChampSelectActions,
  hasChampSelectActionID,
  liveLocalChampSelectAction,
  localAssignedPosition,
  occupiedChampSelectChampionIDs,
  runePageForPick,
} from '../champSelectFlow';
import type { ChampSelectSession, DraftTimingMode } from '../champSelectFlow';
import PageHeader from './PageHeader';
import RunePageEditor from './RunePageEditor';
import BuildPlanner from './BuildPlanner';
import { ActionFeedback, type FeedbackState } from './DesignPrimitives';
import { PRACTICE_TOOL_QUEUE_ID, queueStartMode } from '../playFlowQueue';
import { recommendedRoleQuestSpells, roleQuestPlan } from '../roleQuest';
import { ARENA_BRAVERY_CHAMPION_ID, shouldUseArenaBravery } from '../arenaBravery';
import { arenaEventKey, arenaEventLabel } from '../arenaTelemetry';

type ToastFn = (message: string, type?: 'info' | 'success' | 'error') => void;

type DraftStage = 'idle' | 'hovering' | 'hovered' | 'locking';
type DraftAttempt = {
  key: string;
  actionId: number;
  actionType: 'pick' | 'ban';
  championId: number;
  stage: DraftStage;
  attempts: number;
  lastAttemptAt: number;
  firstSeenAt: number;
  confirmedAt: number;
  runePageId: number;
};
type DraftTone = 'idle' | 'working' | 'confirmed' | 'blocked';
type TimingMode = DraftTimingMode;

const ROLE_OPTIONS: Array<[string, string]> = [
  ['TOP', 'Top'], ['JUNGLE', 'Jungle'], ['MIDDLE', 'Mid'], ['BOTTOM', 'Bot'], ['UTILITY', 'Support'], ['FILL', 'Fill'],
];

const STEPS = [
  { key: 'client', label: 'League Client', hint: 'Launch or connect' },
  { key: 'roles', label: 'Roles & Queue', hint: 'Set lanes and search' },
  { key: 'ready', label: 'Ready Check', hint: 'Auto-accept' },
  { key: 'draft', label: 'Champ Select', hint: 'Auto pick / ban' },
  { key: 'game', label: 'In Game', hint: 'Good luck' },
] as const;

const STORAGE_KEY = 'riftops.playFlow';

type FlowPrefs = {
  primaryRole: string;
  secondaryRole: string;
  pickChampionId: number;
  fallbackPickChampionId: number;
  banChampionId: number;
  fallbackBanChampionId: number;
  pickRunePageId: number;
  fallbackPickRunePageId: number;
  pickTimingMode: TimingMode;
  pickTimingSeconds: number;
  banTimingMode: TimingMode;
  banTimingSeconds: number;
  selectedQueue: number;
  autoRoles: boolean;
  autoQueue: boolean;
  autoAccept: boolean;
  autoBan: boolean;
  autoPick: boolean;
  instantLock: boolean;
  autoRoleQuestLoadout: boolean;
  arenaBraveryPick: boolean;
};

function loadPrefs(): FlowPrefs {
  const defaults: FlowPrefs = {
    primaryRole: 'TOP', secondaryRole: 'FILL', pickChampionId: 0, fallbackPickChampionId: 0,
    banChampionId: 0, fallbackBanChampionId: 0, pickRunePageId: 0, fallbackPickRunePageId: 0,
    pickTimingMode: 'immediate', pickTimingSeconds: 2,
    banTimingMode: 'immediate', banTimingSeconds: 2,
    selectedQueue: 0,
    autoRoles: true, autoQueue: true, autoAccept: true, autoBan: true, autoPick: true, instantLock: false,
    autoRoleQuestLoadout: false, arenaBraveryPick: false,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<FlowPrefs>) };
  } catch { /* Defaults are fine when storage is unavailable. */ }
  return defaults;
}

function phaseStep(phase: string): (typeof STEPS)[number]['key'] {
  if (!phase || phase === 'None') return 'client';
  if (phase === 'Lobby' || phase === 'Matchmaking') return 'roles';
  if (phase === 'ReadyCheck') return 'ready';
  if (phase === 'ChampSelect') return 'draft';
  return 'game';
}

// Queues without lane preferences (Practice Tool is handled separately).
const ROLELESS_QUEUES = new Set([450, 1700, 1750, 2400, 2450, 3140]);
function isRolelessQueue(queueId: number): boolean {
  return ROLELESS_QUEUES.has(queueId);
}

function isPracticeQueue(queueId: number): boolean {
  return queueId === PRACTICE_TOOL_QUEUE_ID;
}

function findQueue(queueId: number, queues: LCUAvailableQueue[]): LCUAvailableQueue | undefined {
  return queues.find((queue) => queue.id === queueId);
}

function lobbyIsCustom(lobby: LCULobby | null): boolean {
  const queueID = Number(lobby?.gameConfig?.queueId || 0);
  return Boolean(lobby?.isCustom || lobby?.gameConfig?.isCustom || lobby?.customGameLobby || queueID === PRACTICE_TOOL_QUEUE_ID || String(lobby?.gameConfig?.gameMode || '').toUpperCase() === 'PRACTICETOOL');
}

function createConfiguredLobby(queueID: number, queues: LCUAvailableQueue[]): Promise<unknown> {
  if (isPracticeQueue(queueID)) return createPracticeToolLobby();
  const queue = findQueue(queueID, queues);
  if (queue && String(queue.category || '').toLowerCase() === 'custom') {
    return createLCULobby(queueID, { category: queue.category, gameMode: queue.gameMode, queueName: queue.name, mapId: queue.mapId });
  }
  return createLCULobby(queueID);
}

function queueLabel(queue: LCUAvailableQueue): string {
  const raw = String(queue.name || '').replace(/ games?$/i, '');
  return raw || `Queue ${queue.id}`;
}

// Sensible ordering: core PvP first, bots next, customs/practice last.
const CATEGORY_ORDER: Record<string, number> = { pvp: 0, versusai: 1, custom: 2, training: 2 };

function sortQueues(queues: LCUAvailableQueue[]): LCUAvailableQueue[] {
  return [...queues].sort((a, b) => {
    const catA = CATEGORY_ORDER[(a.category || '').toLowerCase()] ?? 1;
    const catB = CATEGORY_ORDER[(b.category || '').toLowerCase()] ?? 1;
    if (catA !== catB) return catA - catB;
    return queueLabel(a).localeCompare(queueLabel(b));
  }).filter((queue) => !/tutorial/i.test(queueLabel(queue)));
}

function timingLabel(mode: TimingMode, seconds: number): string {
  if (mode === 'last-second') return `in the last ${Math.max(0, seconds)}s`;
  if (mode === 'after') return `${Math.max(0, seconds)}s after your turn opens`;
  return 'as soon as your turn opens';
}

function ChampionPicker({ value, query, onQuery, onSelect, label, version, champions }: {
  value: number;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (id: number) => void;
  label: string;
  version: string;
  champions: Record<number, DDChampion>;
}) {
  const term = query.trim().toLowerCase();
  const matches = Object.values(champions)
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((champ) => Number(champ.key) !== value)
    .filter((champ) => !term || champ.name.toLowerCase().includes(term))
    .slice(0, 8);

  return (
    <div className="play-flow__picker">
      <div className="play-flow__picker-head">
        <span><Ban className="h-3 w-3 opacity-60" /> {label}</span>
        {value ? (
          <span className="play-flow__picker-chosen">
            <img src={ddChampionIcon(version, champions[value]?.id || String(value))} alt="" width="32" height="32" />
            <span className="play-flow__picker-chosen-name">{champions[value]?.name || `Champion ${value}`}</span>
            <button type="button" onClick={() => onSelect(0)} aria-label={`Clear ${label}`}><X className="h-3 w-3" /></button>
          </span>
        ) : (
          <span className="text-text-dim">Not set</span>
        )}
      </div>
      <div className="play-flow__picker-search">
        <Search />
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={`Search ${label.toLowerCase()}…`} aria-label={label} />
      </div>
      {term ? (
        <div className="play-flow__picker-list">
          {matches.map((champ) => (
            <button type="button" key={champ.key} onClick={() => { onSelect(Number(champ.key)); onQuery(''); }}>
              <img src={ddChampionIcon(version, champ.id)} alt="" width="32" height="32" loading="lazy" />
              <span>{champ.name}</span>
            </button>
          ))}
          {!matches.length && <span className="play-flow__picker-empty">No champions match.</span>}
        </div>
      ) : null}
    </div>
  );
}

function TimingControl({ label, mode, seconds, onMode, onSeconds }: {
  label: string;
  mode: TimingMode;
  seconds: number;
  onMode: (value: TimingMode) => void;
  onSeconds: (value: number) => void;
}) {
  return (
    <div className="play-flow__timing">
      <div className="play-flow__timing-label"><Clock3 /><span>{label}</span></div>
      <select value={mode} onChange={(event) => onMode(event.target.value as TimingMode)} aria-label={`${label} timing`}>
        <option value="immediate">As soon as turn opens</option>
        <option value="last-second">In the last…</option>
        <option value="after">After a delay…</option>
      </select>
      {mode !== 'immediate' && <label className="play-flow__timing-number"><input type="number" min="0" max="60" value={seconds} onChange={(event) => onSeconds(Math.max(0, Math.min(60, Number(event.target.value) || 0)))} aria-label={`${label} seconds`} /><span>s</span></label>}
    </div>
  );
}

export default function PlayFlowPage({ showToast: publishToast, onOpenLive, remoteClient = false }: { showToast: ToastFn; onOpenLive?: () => void; remoteClient?: boolean }) {
  const [prefs, setPrefs] = useState<FlowPrefs>(loadPrefs);
  const [phase, setPhase] = useState('');
  const [connected, setConnected] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [acting, setActing] = useState('');
  const [version, setVersion] = useState('15.1.1');
  const [champions, setChampions] = useState<Record<number, DDChampion>>({});
  const [pickQuery, setPickQuery] = useState('');
  const [fallbackPickQuery, setFallbackPickQuery] = useState('');
  const [banQuery, setBanQuery] = useState('');
  const [fallbackBanQuery, setFallbackBanQuery] = useState('');
  const [queues, setQueues] = useState<LCUAvailableQueue[]>([]);
  const [lobby, setLobby] = useState<LCULobby | null>(null);
  const [runePages, setRunePages] = useState<LCURunePage[]>([]);
  const [runeEditorOpen, setRuneEditorOpen] = useState(false);
  const [draftStatus, setDraftStatus] = useState('Waiting for Champion Select.');
  const [draftTone, setDraftTone] = useState<DraftTone>('idle');
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [detectedRole, setDetectedRole] = useState<string | null>(null);

  const showToast = useCallback<ToastFn>((message, type = 'info') => {
    setFeedback({ tone: type === 'success' ? 'success' : type === 'error' ? 'error' : 'info', message });
    publishToast(message, type);
  }, [publishToast]);

  // Practice Tool is a custom lobby on a dedicated queue; creating it goes
  // through the dedicated payload path on the backend.
  const isPracticeSelection = prefs.selectedQueue === PRACTICE_TOOL_QUEUE_ID;

  // General phase guards are separate from the server-confirmed draft state.
  const cycleRef = useRef('');
  const doneRef = useRef<Record<string, boolean>>({});
  const actionSeenRef = useRef<Record<string, number>>({});
  const draftRef = useRef<DraftAttempt | null>(null);
  const availabilityRef = useRef<Record<'pick' | 'ban', { ids: number[]; at: number } | undefined>>({ pick: undefined, ban: undefined });
  const draftNoticeRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  const roleLoadoutRef = useRef('');
  const detectedRoleRef = useRef<string | null>(null);
  const tickingRef = useRef(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const autoRef = useRef(autoMode);
  autoRef.current = autoMode;
  const queuesRef = useRef(queues);
  queuesRef.current = queues;

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* Optional preference. */ }
  }, [prefs]);

  // Load the client's game-mode list whenever a League connection appears.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void fetchLCUAvailableQueues().then((available) => {
      if (!cancelled) setQueues(sortQueues(available.filter((queue) => Number(queue.id) > 0)));
    }).catch(() => { /* The dropdown falls back to manual entry. */ });
    return () => { cancelled = true; };
  }, [connected]);

  // The selected dropdown is only intent. League's current lobby remains the
  // authority for whether a custom game can actually be started.
  useEffect(() => {
    if (!connected || phase !== 'Lobby') {
      setLobby(null);
      return;
    }
    let cancelled = false;
    const refreshLobby = () => {
      void fetchLCULobby().then((value) => {
        if (!cancelled) setLobby(value);
      }).catch(() => {
        if (!cancelled) setLobby(null);
      });
    };
    refreshLobby();
    const interval = window.setInterval(refreshLobby, 1250);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [connected, phase]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const refreshRunes = () => {
      void fetchLCURunePages().then((pages) => {
        if (!cancelled) setRunePages(pages);
      }).catch(() => {
        // Keep the last known pages. The LCU briefly returns 404 while
        // switching phases and clearing the dropdown makes fallback picks
        // look unconfigured even though the pages still exist.
      });
    };
    refreshRunes();
    const interval = window.setInterval(refreshRunes, phase === 'ChampSelect' ? 5000 : 30000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [connected, phase]);

  useEffect(() => {
    void (async () => {
      const [ddVersion, ddChampions] = await Promise.all([
        fetchDDragonVersion().catch(() => ({ version: '15.1.1' })),
        fetchDDChampions().catch(() => ({ data: {} }) as DDChampionList),
      ]);
      setVersion(ddVersion.version || '15.1.1');
      const mapped: Record<number, DDChampion> = {};
      Object.values(ddChampions.data || {}).forEach((champ) => { mapped[Number(champ.key)] = champ; });
      setChampions(mapped);
    })();
  }, []);

  const update = <K extends keyof FlowPrefs>(key: K, value: FlowPrefs[K]) => {
    setPrefs((current) => ({ ...current, [key]: value }));
    doneRef.current = {};
    actionSeenRef.current = {};
    draftRef.current = null;
  };

  const resetCycle = useCallback((key: string) => {
    if (cycleRef.current !== key) {
      cycleRef.current = key;
      doneRef.current = {};
      actionSeenRef.current = {};
      draftRef.current = null;
      availabilityRef.current = { pick: undefined, ban: undefined };
      roleLoadoutRef.current = '';
    }
  }, []);

  const runStep = useCallback(async (key: string, action: () => Promise<unknown>, success: string) => {
    setActing(key);
    try {
      await action();
      showToast(success, 'success');
      return true;
    } catch (reason: any) {
      showToast(reason?.message || 'The League client rejected that step.', 'error');
      return false;
    } finally {
      setActing('');
    }
  }, [showToast]);

  const fetchAvailableChampions = useCallback(async (kind: 'pick' | 'ban'): Promise<number[] | null> => {
    const cached = availabilityRef.current[kind];
    if (cached && Date.now() - cached.at < 4000) return cached.ids;
    try {
      const ids = (kind === 'pick' ? await fetchLCUChampSelectPickable() : await fetchLCUChampSelectBannable()).map(Number).filter((id) => id > 0);
      availabilityRef.current[kind] = { ids, at: Date.now() };
      // An empty catalogue can be a transient LCU state. Let the mutation give
      // the authoritative answer instead of incorrectly blocking the action.
      return ids;
    } catch {
      return null;
    }
  }, []);

  const runDraftMutation = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setActing(key);
    try {
      await action();
      return true;
    } catch (reason: any) {
      const message = reason?.message || 'League rejected the champion-select action.';
      setDraftTone('blocked');
      setDraftStatus(message);
      const now = Date.now();
      if (draftNoticeRef.current.key !== key || now - draftNoticeRef.current.at > 10000) {
        draftNoticeRef.current = { key, at: now };
        showToast(message, 'error');
      }
      return false;
    } finally {
      setActing('');
    }
  }, [showToast]);

  const applyRoleQuestLoadout = useCallback(async (notify = true, roleOverride?: string | null): Promise<boolean> => {
    const role = roleOverride || detectedRoleRef.current || prefsRef.current.primaryRole;
    const spells = recommendedRoleQuestSpells(role);
    if (!spells) {
      if (notify) showToast('RiftOps needs a confirmed Top lane assignment before applying Flash + Teleport.', 'info');
      return false;
    }
    if (notify) setActing('role-quest');
    try {
      await updateLCUChampSelectSelection({ spell1Id: spells.spell1Id, spell2Id: spells.spell2Id });
      if (notify) showToast(`Role quest loadout ready: ${spells.spell1Name} + ${spells.spell2Name}.`, 'success');
      return true;
    } catch (reason: any) {
      if (notify) showToast(reason?.message || 'League rejected the role quest spell loadout.', 'error');
      return false;
    } finally {
      if (notify) setActing('');
    }
  }, [showToast]);

  const handleChampSelectTick = useCallback(async () => {
    const config = prefsRef.current;
    let session: ChampSelectSession;
    try {
      session = await fetchLCUChampSelect() as ChampSelectSession;
    } catch (e) {
      console.debug('[PlayFlow] champ-select fetch failed', e);
      setDraftTone('blocked');
      setDraftStatus('Waiting for League to publish the Champion Select session.');
      return;
    }

    const sessionKey = champSelectSessionKey(session);
    resetCycle(sessionKey);
    const now = Date.now();
    const assignedRole = localAssignedPosition(session);
    detectedRoleRef.current = assignedRole;
    setDetectedRole((previous) => previous === assignedRole ? previous : assignedRole);
    const questSpells = recommendedRoleQuestSpells(assignedRole);
    const questLoadoutKey = `${sessionKey}:${String(assignedRole || '').toUpperCase()}`;
    if (config.autoRoleQuestLoadout && assignedRole === 'TOP' && questSpells && roleLoadoutRef.current !== questLoadoutKey && roleLoadoutRef.current !== `${questLoadoutKey}:failed`) {
      setDraftTone('working');
      setDraftStatus(`Preparing ${questSpells.spell1Name} + ${questSpells.spell2Name} for the Top role quest…`);
      const applied = await applyRoleQuestLoadout(false, assignedRole);
      roleLoadoutRef.current = applied ? questLoadoutKey : `${questLoadoutKey}:failed`;
      if (applied) showToast('Top role quest loadout applied. League will grant the Teleport reward after quest completion.', 'success');
      else setDraftStatus('Could not prepare the Top role quest loadout. Use the manual button below and continue drafting.');
    }
    const allActions = flattenChampSelectActions(session);

    // A mutation is successful only after the next LCU session confirms it.
    // Missing actions are also confirmation: League removes completed turns in
    // some queue types instead of retaining them with completed=true.
    const previous = draftRef.current;
    if (previous?.stage === 'locking') {
      const observed = allActions.find((action) => hasChampSelectActionID(action) && Number(action.id) === previous.actionId);
      if (!observed || observed.completed) {
        const name = champions[previous.championId]?.name || `Champion ${previous.championId}`;
        const message = previous.actionType === 'ban' ? `${name} ban confirmed.` : `${name} locked in.`;
        draftRef.current = null;
        setDraftTone('confirmed');
        setDraftStatus(message);
        showToast(message, 'success');
        return;
      }
    }

    const timerPhase = String(session.timer?.phase || '');
    const liveAction = liveLocalChampSelectAction(session);
    const declaration = timerPhase === 'PLANNING' ? firstLocalPendingPick(session) : undefined;
    const action = liveAction || declaration;
    const isLiveTurn = action === liveAction && !!liveAction;

    console.debug('[PlayFlow] champ-select state', {
      timerPhase,
      localCell: session.localPlayerCellId,
      currentAction: liveAction,
      declaration,
      draft: draftRef.current,
    });

    if (!action || !hasChampSelectActionID(action) || (action.type !== 'pick' && action.type !== 'ban')) {
      setDraftTone('idle');
      setDraftStatus(timerPhase === 'FINALIZATION' ? 'Draft complete — loadout can still be adjusted.' : 'Waiting for your next pick or ban turn.');
      return;
    }

    const actionType = action.type;
    const primaryChampionId = actionType === 'ban' ? config.banChampionId : config.pickChampionId;
    const fallbackChampionId = actionType === 'ban' ? config.fallbackBanChampionId : config.fallbackPickChampionId;
    const enabled = actionType === 'ban' ? config.autoBan : config.autoPick;
    const arenaBravery = actionType === 'pick'
      && shouldUseArenaBravery(config.arenaBraveryPick, findQueue(config.selectedQueue, queuesRef.current), session);
    if (!enabled) {
      setDraftTone('idle');
      setDraftStatus(`Auto-${actionType} is off. Use League or Live Client Control for this turn.`);
      return;
    }
    if (!arenaBravery && !primaryChampionId && !fallbackChampionId) {
      setDraftTone('blocked');
      setDraftStatus(`Choose a champion to ${actionType} in Auto mode setup.`);
      return;
    }

    const actionID = Number(action.id);
    const timingMode = actionType === 'ban' ? config.banTimingMode : config.pickTimingMode;
    const timingSeconds = actionType === 'ban' ? config.banTimingSeconds : config.pickTimingSeconds;
    const timingKey = `${actionType}:${actionID}`;
    const firstSeenAt = actionSeenRef.current[timingKey] || now;
    actionSeenRef.current[timingKey] = firstSeenAt;

    const conflicts = occupiedChampSelectChampionIDs(session, actionID);
    const candidates = [primaryChampionId, fallbackChampionId];
    const available = arenaBravery ? null : await fetchAvailableChampions(actionType);
    const selectedChampionId = arenaBravery
      ? ARENA_BRAVERY_CHAMPION_ID
      : chooseChampSelectChampion(candidates, conflicts, available);
    if (!selectedChampionId && !arenaBravery) {
      const primaryBlocked = primaryChampionId > 0 && conflicts.has(primaryChampionId);
      setDraftTone('blocked');
      setDraftStatus(primaryBlocked
        ? `${champions[primaryChampionId]?.name || `Champion ${primaryChampionId}`} is already banned, picked, or hovered. Set a fallback ${actionType}.`
        : `Neither the selected ${actionType} nor its fallback is available in this draft.`);
      return;
    }

    const fallbackUsed = !arenaBravery && selectedChampionId !== primaryChampionId;
    const championName = arenaBravery ? 'Bravery (Arena)' : champions[selectedChampionId]?.name || `Champion ${selectedChampionId}`;
    const fallbackPrefix = fallbackUsed ? `Primary unavailable — using fallback ${championName}. ` : '';
    const attemptKey = `${actionType}:${actionID}:${selectedChampionId}`;
    let attempt = draftRef.current;
    if (!attempt || attempt.key !== attemptKey) {
      attempt = {
        key: attemptKey,
        actionId: actionID,
        actionType,
        championId: selectedChampionId,
        stage: 'idle',
        attempts: 0,
        lastAttemptAt: 0,
        firstSeenAt,
        confirmedAt: 0,
        runePageId: 0,
      };
      draftRef.current = attempt;
    }

    const selectedRunePageID = actionType === 'pick'
      ? runePageForPick(config.pickRunePageId, config.fallbackPickRunePageId, fallbackUsed)
      : 0;
    if (actionType === 'pick' && selectedRunePageID > 0 && attempt.runePageId !== selectedRunePageID) {
      const rune = runePages.find((page) => page.id === selectedRunePageID);
      setDraftTone('working');
      setDraftStatus(`${fallbackPrefix}Applying ${rune?.name || 'selected rune page'} before the pick…`);
      const runeApplied = await runDraftMutation(`draft-rune:${attemptKey}:${selectedRunePageID}`, () => selectLCURunePage(selectedRunePageID));
      if (runeApplied) {
        attempt.runePageId = selectedRunePageID;
        setDraftTone('confirmed');
        setDraftStatus(`${fallbackPrefix}${rune?.name || 'Rune page'} selected. Preparing ${championName}…`);
      }
      return;
    }

    // Loadouts are safe to apply before the configured pick delay. Doing this
    // early leaves the final seconds exclusively for League's hover/lock calls.
    const timingWait = draftTimingRemainingMs(timingMode, timingSeconds, session.timer, firstSeenAt, now);
    if (timingWait > 0) {
      setDraftTone('idle');
      const waitSeconds = Math.max(1, Math.ceil(timingWait / 1000));
      setDraftStatus(`${fallbackPrefix}${championName} is ready. Waiting to ${actionType} ${timingLabel(timingMode, timingSeconds)} · ${waitSeconds}s remaining.`);
      return;
    }

    if (actionType === 'ban') {
      if (attempt.stage === 'locking' && now - attempt.lastAttemptAt < 2200) {
        setDraftTone('working');
        setDraftStatus(`${fallbackPrefix}Ban sent for ${championName}. Waiting for League to confirm…`);
        return;
      }
      if (now - attempt.lastAttemptAt < 1200) return;
      attempt.stage = 'locking';
      attempt.lastAttemptAt = now;
      attempt.attempts += 1;
      setDraftTone('working');
      setDraftStatus(`${fallbackPrefix}Submitting ${championName} as your ban…`);
      await runDraftMutation(`draft-ban:${attemptKey}`, () => submitLCUChampSelectAction(actionID, selectedChampionId, true));
      return;
    }

    const hoverConfirmed = Number(action.championId || 0) === selectedChampionId;
    if (hoverConfirmed) {
      const firstConfirmation = attempt.confirmedAt === 0;
      if (firstConfirmation) attempt.confirmedAt = now;
      if (attempt.stage !== 'locking') attempt.stage = 'hovered';
      if (firstConfirmation && attempt.attempts > 0) showToast(`${fallbackPrefix}${championName} hover confirmed.`, 'success');

      if (!isLiveTurn) {
        setDraftTone('confirmed');
        setDraftStatus(`${fallbackPrefix}${championName} is declared. RiftOps will lock it when your turn starts.`);
        return;
      }

      const lockDelay = config.instantLock ? 0 : 2500;
      const remaining = Math.max(0, lockDelay - (now - attempt.confirmedAt));
      if (remaining > 0) {
        setDraftTone('confirmed');
        setDraftStatus(`${fallbackPrefix}${championName} hover confirmed. Locking in ${(remaining / 1000).toFixed(1)}s…`);
        return;
      }
      if (attempt.stage === 'locking' && now - attempt.lastAttemptAt < 2200) {
        setDraftTone('working');
        setDraftStatus(`${fallbackPrefix}Lock sent for ${championName}. Waiting for League to confirm…`);
        return;
      }
      attempt.stage = 'locking';
      attempt.lastAttemptAt = now;
      attempt.attempts += 1;
      setDraftTone('working');
      setDraftStatus(`${fallbackPrefix}Locking in ${championName}…`);
      await runDraftMutation(`draft-lock:${attemptKey}`, () => submitLCUChampSelectAction(actionID, selectedChampionId, true));
      return;
    }

    // PATCH acceptance is not confirmation. Re-send a missing hover with a
    // bounded interval until the session echoes the configured champion.
    if (now - attempt.lastAttemptAt < 1200) {
      setDraftTone('working');
      setDraftStatus(`${fallbackPrefix}Hover sent for ${championName}. Waiting for League to confirm…`);
      return;
    }
    attempt.stage = 'hovering';
    attempt.confirmedAt = 0;
    attempt.lastAttemptAt = now;
    attempt.attempts += 1;
    setDraftTone('working');
    setDraftStatus(`${fallbackPrefix}Sending ${championName} hover to League…`);
    await runDraftMutation(`draft-hover:${attemptKey}`, () => submitLCUChampSelectAction(actionID, selectedChampionId, false));
  }, [applyRoleQuestLoadout, fetchAvailableChampions, champions, resetCycle, runePages, runDraftMutation, showToast]);

  const tick = useCallback(async () => {
    if (tickingRef.current) return;
    tickingRef.current = true;
    try {
      let current: string;
      try {
        current = await fetchGameflowPhase();
        setConnected(true);
      } catch (e) {
        console.debug('[PlayFlow] gameflow fetch failed', e);
        setConnected(false);
        setPhase('');
        return;
      }
      setPhase(current);
      if (current === 'ChampSelect') console.debug('[PlayFlow] phase ChampSelect', { autoMode: autoRef.current, prefs: prefsRef.current });

      if (current === 'None' || current === 'Lobby') resetCycle('lobby');
      else if (current === 'Matchmaking' || current === 'ReadyCheck') resetCycle('queue');
      else if (current === 'EndOfGame' || current === 'WaitingForStats') resetCycle('endgame');

      if (!autoRef.current) {
        if (current === 'ChampSelect') {
          setDraftTone('idle');
          setDraftStatus('Auto mode is paused. Live Client Control remains available for manual picks and bans.');
        }
        return;
      }
      const config = prefsRef.current;
      try {
        if (current === 'None') {
          // Nothing is open yet — create the configured lobby automatically
          // so the rest of the flow can proceed hands-free.
          if (!doneRef.current.created && config.selectedQueue > 0) {
            await createConfiguredLobby(config.selectedQueue, queuesRef.current);
            doneRef.current.created = true;
            return;
          }
        } else if (current === 'Lobby') {
          // Custom and Practice Tool lobbies skip lane preferences and use
          // League's dedicated start-game route instead of matchmaking.
          const custom = queueStartMode(config.selectedQueue, queuesRef.current) === 'custom';
          if (!doneRef.current.created && config.selectedQueue > 0) {
            const currentLobby = await fetchLCULobby().catch(() => null);
            const currentQueue = Number(currentLobby?.gameConfig?.queueId || 0);
            const currentIsCustom = lobbyIsCustom(currentLobby);
            const wrongKind = custom !== currentIsCustom;
            const wrongQueue = currentQueue > 0 && currentQueue !== config.selectedQueue;
            if (wrongKind || wrongQueue) {
              await createConfiguredLobby(config.selectedQueue, queuesRef.current);
              doneRef.current.created = true;
              return; // Let the fresh lobby settle before applying roles.
            }
            doneRef.current.created = true;
          }
          const isRoleless = isRolelessQueue(config.selectedQueue) || custom;
          if (config.autoRoles && !doneRef.current.roles && !isRoleless) {
            try {
              await lcuAutoRoles(config.primaryRole, config.secondaryRole);
              doneRef.current.roles = true;
            } catch (e: any) {
              showToast(e?.message || 'Failed to set roles — continuing to queue.', 'error');
              doneRef.current.roles = true; // don't retry every tick and block queue
            }
          }
          if (config.autoQueue && !doneRef.current.queued) {
            if (custom) await lcuCustomStart();
            else await lcuAutoRequeue();
            doneRef.current.queued = true;
          }
        } else if (current === 'ReadyCheck') {
          if (config.autoAccept && !doneRef.current.accepted) {
            await lcuAutoAccept();
            doneRef.current.accepted = true;
          }
        } else if (current === 'ChampSelect') {
          await handleChampSelectTick();
        }
      } catch (reason: any) {
        showToast(reason?.message || 'Automation step failed.', 'error');
      }
    } finally {
      tickingRef.current = false;
    }
  }, [handleChampSelectTick, resetCycle, showToast]);

  useEffect(() => {
    void tick();
    // A sub-second poll keeps last-second policies reliable while every
    // mutation remains guarded by its own backoff and server confirmation.
    const interval = window.setInterval(() => void tick(), 750);
    return () => window.clearInterval(interval);
  }, [tick]);

  const launchLeague = async () => {
    setLaunching(true);
    try {
      if (remoteClient) await launchLCULeague();
      else await launchLCULeague().catch(() => launchGame('league'));
      showToast('League is launching.', 'success');
    } catch (reason: any) {
      showToast(reason?.message || 'Could not start League of Legends.', 'error');
    } finally {
      setLaunching(false);
    }
  };

  const activeStep = phaseStep(phase);
  const selectedQueue = findQueue(prefs.selectedQueue, queues);
  const selectedStartMode = queueStartMode(prefs.selectedQueue, queues);
  const isCustomSelection = selectedStartMode === 'custom';
  const isCustomLobby = lobbyIsCustom(lobby);
  const mayStartCustom = phase === 'Lobby' && isCustomLobby
    && lobby?.localMember?.isLeader !== false
    && lobby?.localMember?.allowedStartActivity !== false
    && lobby?.canStartActivity !== false;
  const customStartHint = phase !== 'Lobby'
    ? 'Wait until League is in a custom lobby.'
    : !isCustomLobby
      ? 'Create the selected custom lobby first.'
      : lobby?.localMember?.isLeader === false || lobby?.localMember?.allowedStartActivity === false
        ? 'Only the custom lobby leader can start.'
        : lobby?.canStartActivity === false
          ? 'League says this lobby is not ready yet.'
          : 'Custom lobby ready.';
  const isArenaSelection = shouldUseArenaBravery(true, selectedQueue);
  const selectedArenaEvent = isArenaSelection ? arenaEventLabel(arenaEventKey(selectedQueue || prefs.selectedQueue)) : '';
  const enabledRuleCount = [prefs.autoRoles, prefs.autoQueue, prefs.autoAccept, prefs.autoPick, prefs.autoBan, prefs.instantLock, prefs.autoRoleQuestLoadout, prefs.arenaBraveryPick].filter(Boolean).length;
  const selectedRoleQuest = roleQuestPlan(detectedRole || prefs.primaryRole);
  const selectedRoleQuestSpells = recommendedRoleQuestSpells(detectedRole || prefs.primaryRole);
  const champSelectLive = connected && phase === 'ChampSelect';
  const editableRunePages = runePages.filter((page) => page.isEditable !== false);
  const currentRunePage = runePages.find((page) => page.current || page.isActive)
    || runePages.find((page) => page.id === prefs.pickRunePageId)
    || editableRunePages[0]
    || null;

  return (
    <div className="workspace-stage workspace-stage--play play-flow-page flex-1 min-h-0 min-w-0 animate-fadeIn" role="region" aria-label="Play Flow workspace" tabIndex={0}>
      <PageHeader
        variant="status"
        icon={Swords}
        eyebrow="ONE-CLICK PLAY"
        title="Play flow"
        description="Launch League, claim your roles, queue up, auto-accept, and let RiftOps handle your pick and ban."
        meta={<span className={`page-header__badge ${connected ? 'page-header__badge--success' : ''}`}>{connected ? `Client live · ${phase.replaceAll('_', ' ')}` : 'Waiting for League client'}</span>}
        actions={!remoteClient ? (
          <button type="button" onClick={() => setAutoMode((value) => !value)} className={`${autoMode ? 'btn-primary' : 'btn-secondary'} flex items-center gap-2 px-4 py-2 text-xs`} aria-pressed={autoMode}>
            {autoMode ? <Square className="h-3.5 w-3.5 fill-current" /> : <Zap className="h-3.5 w-3.5" />}
            {autoMode ? 'Stop auto mode' : 'Full auto mode'}
          </button>
        ) : <span className="page-header__badge">Phone live controls</span>}
      />

      <ActionFeedback state={feedback} className="play-flow__local-feedback" />

      {!connected && (
        <div className="play-flow__connection-alert">
          <WifiOff className="h-4 w-4 text-danger" />
          <span>RiftOps cannot see the League client yet. Launch it below, sign in, and this flow comes alive automatically.</span>
        </div>
      )}

      <section className="glass-card play-flow__progress" aria-label="Current play progress">
        <ol className="play-flow__steps">
          {STEPS.map((step, index) => {
            const stepIndex = STEPS.findIndex((item) => item.key === activeStep);
            const state = index < stepIndex ? 'done' : index === stepIndex ? 'active' : 'pending';
            return (
              <li key={step.key} className={`play-flow__step is-${state}`}>
                <span className="play-flow__step-dot">{state === 'done' ? <Check className="h-3 w-3" /> : index + 1}</span>
                <span><strong>{step.label}</strong><small>{step.hint}</small></span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="glass-card play-flow__runbook">
        <div className="play-flow__section-heading">
          <span className="play-flow__section-icon"><Rocket /></span>
          <div><small>MANUAL RUNBOOK</small><h3>Launch and queue</h3><p>Move through the same sequence as League, with the next useful control always in reach.</p></div>
          <span className={`play-flow__section-badge ${connected ? 'is-live' : ''}`}>{connected ? 'Client ready' : 'Client offline'}</span>
        </div>

        <div className="play-flow__runbook-grid">
          <div className="play-flow__row">
            <div>
              <strong>1 · League client</strong>
              <small>Start League of Legends through the Riot Client.</small>
            </div>
            <button type="button" disabled={launching || connected} onClick={() => void launchLeague()} className="btn-primary flex items-center gap-2 px-4 py-2 text-xs disabled:opacity-40">
              {launching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
              {connected ? 'Client running' : 'Launch League'}
            </button>
          </div>

          <div className="play-flow__row">
            <div>
              <strong>2 · Roles</strong>
              <small>{isCustomSelection ? 'Custom games do not use lane preferences.' : 'Save your lane preferences in the lobby.'}</small>
            </div>
            <div className="flex items-center gap-2">
              <select value={prefs.primaryRole} onChange={(event) => update('primaryRole', event.target.value)} className="play-flow__select" aria-label="Primary role" disabled={isCustomSelection}>
                {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select value={prefs.secondaryRole} onChange={(event) => update('secondaryRole', event.target.value)} className="play-flow__select" aria-label="Secondary role" disabled={isCustomSelection}>
                {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" disabled={!connected || isCustomSelection || acting === 'roles'} onClick={() => void runStep('roles', () => lcuAutoRoles(prefs.primaryRole, prefs.secondaryRole), 'Position preferences saved.')} className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-40">
                <RefreshCw className={`h-3.5 w-3.5 ${acting === 'roles' ? 'animate-spin' : ''}`} /> Apply
              </button>
            </div>
          </div>

          <div className="play-flow__row play-flow__row--queue">
            <div>
              <strong>3 · Game mode & queue</strong>
              <small>Pick any mode the client offers, or Practice Tool for safe testing.</small>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className={`play-flow__queue-kind ${isCustomSelection ? 'is-custom' : ''}`}>
                {isCustomSelection ? <Swords /> : <Users />}
                {isCustomSelection ? 'Custom lobby' : 'Matchmade queue'}
              </span>
              <select
                value={String(prefs.selectedQueue)}
                onChange={(event) => {
                  setPrefs((current) => ({ ...current, selectedQueue: Number(event.target.value) }));
                  doneRef.current = {};
                  actionSeenRef.current = {};
                  draftRef.current = null;
                }}
                className="play-flow__select"
                aria-label="Game mode"
              >
                <option value="0">Current lobby</option>
                {sortQueues(queues).map((queue) => (
                  <option key={queue.id} value={String(queue.id)}>{queueLabel(queue)}</option>
                ))}
              </select>
              <button type="button" disabled={!connected || acting === 'lobby' || prefs.selectedQueue === 0} onClick={() => {
                const q = queues.find((queue) => queue.id === prefs.selectedQueue);
                const isCustom = isPracticeSelection || (!!q && String(q.category || '').toLowerCase() === 'custom');
                const label = q?.name || `queue ${prefs.selectedQueue}`;
                const msg = isPracticeSelection ? 'Practice Tool lobby created. Use Start game when the lobby is ready.' : isCustom ? `Custom lobby created for ${label}.` : `Lobby created for ${label}.`;
                void runStep('lobby', () => createConfiguredLobby(prefs.selectedQueue, queues), msg);
              }} className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-40">
                <Rocket className={`h-3.5 w-3.5 ${acting === 'lobby' ? 'animate-spin' : ''}`} /> Create lobby
              </button>
              {isCustomSelection ? (
                <button type="button" disabled={!connected || !mayStartCustom || acting === 'custom-start'} onClick={() => void (async () => { if (await runStep('custom-start', lcuCustomStart, `${selectedQueue?.name || 'Custom game'} is starting. Opening Live Session…`)) onOpenLive?.(); })()} className="btn-primary play-flow__custom-start flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-40" title={customStartHint} aria-describedby="custom-start-status">
                  {acting === 'custom-start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />} Start game
                </button>
              ) : (
                <>
                  <button type="button" disabled={!connected || acting === 'queue'} onClick={() => void (async () => { if (await runStep('queue', () => lcuAutoRequeue(), 'Matchmaking started. Opening Live Session…')) onOpenLive?.(); })()} className="btn-primary flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-40">
                    <Users className="h-3.5 w-3.5" /> Start queue
                  </button>
                  <button type="button" disabled={!connected || acting === 'stop'} onClick={() => void runStep('stop', () => lcuStopQueue(), 'Queue stopped.')} className="play-flow__queue-stop flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-40" aria-label="Stop matchmaking queue">
                    <CircleStop className={`h-3.5 w-3.5 ${acting === 'stop' ? 'animate-pulse' : ''}`} /> Stop queue
                  </button>
                </>
              )}
              {isCustomSelection && <span id="custom-start-status" className={`play-flow__custom-status ${mayStartCustom ? 'is-ready' : ''}`}>{customStartHint}</span>}
            </div>
          </div>

          <div className="play-flow__row">
            <div>
              <strong>4 · Ready check</strong>
              <small>Confirm the match found pop-up.</small>
            </div>
            <button type="button" disabled={!connected || acting === 'accept'} onClick={() => void runStep('accept', () => lcuAutoAccept(), 'Ready check accepted.')} className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-40">
              <CheckCircle2 className="h-3.5 w-3.5" /> Accept
            </button>
          </div>

          <aside className="play-flow__runbook-tip">
            <ShieldCheck />
            <span><strong>Safe rehearsal</strong><small>Practice Tool runs the draft workflow without lane preferences. Use it before enabling full auto in a live queue.</small></span>
          </aside>
        </div>
      </section>

      <section className="glass-card play-flow__role-quest" aria-labelledby="role-quest-title">
        <div className="play-flow__role-quest-header">
          <div className="play-flow__role-quest-mark"><ShieldCheck /></div>
          <div>
            <small>SEASON SYSTEM</small>
            <h3 id="role-quest-title">Role Quest assistant</h3>
            <p>{selectedRoleQuest ? `${selectedRoleQuest.label} lane · ${selectedRoleQuest.progress} to unlock the reward.${detectedRole ? ' Live assignment confirmed.' : ' Waiting for live lane assignment.'}` : 'Choose a queued role to preview its League Role Quest.'}</p>
          </div>
          <span className="play-flow__section-badge">League-owned progress</span>
        </div>
        {selectedRoleQuest ? (
          <div className="play-flow__role-quest-body">
            <div className="play-flow__role-quest-reward">
              <span>Reward</span>
              <strong>{selectedRoleQuest.reward}</strong>
              <small>{selectedRoleQuest.details}</small>
            </div>
            <div className="play-flow__role-quest-action">
              <p>{selectedRoleQuest.assistant}</p>
              {selectedRoleQuestSpells ? (
                <button
                  type="button"
                  disabled={!champSelectLive || acting === 'role-quest' || detectedRole !== 'TOP'}
                  onClick={() => void (async () => {
                    const applied = await applyRoleQuestLoadout(true);
                    if (applied) roleLoadoutRef.current = 'manual';
                  })()}
                  className="btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-40"
                  title={champSelectLive ? (detectedRole === 'TOP' ? 'Set Flash + Teleport in the live Champion Select session' : 'RiftOps will only apply this when League confirms Top') : 'Open Champion Select to change summoner spells'}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${acting === 'role-quest' ? 'animate-spin' : ''}`} />
                  {champSelectLive && detectedRole === 'TOP' ? 'Apply Flash + Teleport' : champSelectLive ? 'Waiting for Top assignment' : 'Available in Champ Select'}
                </button>
              ) : (
                <span className="play-flow__role-quest-note">No RiftOps loadout change is needed for this role.</span>
              )}
            </div>
          </div>
        ) : (
          <div className="play-flow__role-quest-empty">Role quests are assigned by League from your queued position. Fill and custom modes may not receive the lane quest.</div>
        )}
      </section>

      {!remoteClient && <section className="glass-card play-flow__automation">
        <div className="play-flow__section-heading">
          <span className="play-flow__section-icon is-automation"><Zap /></span>
          <div><small>AUTOMATION DECK</small><h3>Queue-to-draft rules</h3><p>Choose what RiftOps may do, then define a safe pick and ban route.</p></div>
          <span className="play-flow__section-badge">{enabledRuleCount} of 8 on</span>
        </div>

        <div className="play-flow__toggle-grid">
          <label className="play-flow__toggle">
            <input type="checkbox" checked={prefs.autoRoles} onChange={(event) => update('autoRoles', event.target.checked)} />
            <span><strong>Lobby roles</strong><small>Apply saved lane preferences</small></span>
          </label>
          <label className="play-flow__toggle">
            <input type="checkbox" checked={prefs.autoQueue} onChange={(event) => update('autoQueue', event.target.checked)} />
            <span><strong>{isCustomSelection ? 'Start game' : 'Start queue'}</strong><small>{isCustomSelection ? 'Launch the custom lobby automatically' : 'Begin matchmaking automatically'}</small></span>
          </label>
          <label className="play-flow__toggle">
            <input type="checkbox" checked={prefs.autoAccept} onChange={(event) => update('autoAccept', event.target.checked)} />
            <span><strong>Ready check</strong><small>Accept when a match is found</small></span>
          </label>
          <label className="play-flow__toggle">
            <input type="checkbox" checked={prefs.autoPick} onChange={(event) => update('autoPick', event.target.checked)} />
            <span><strong>Champion pick</strong><small>Hover and lock the selected pick</small></span>
          </label>
          <label className="play-flow__toggle">
            <input type="checkbox" checked={prefs.autoBan} onChange={(event) => update('autoBan', event.target.checked)} />
            <span><strong>Champion ban</strong><small>Ban the first available target</small></span>
          </label>
          <label className="play-flow__toggle">
            <input type="checkbox" checked={prefs.instantLock} onChange={(event) => update('instantLock', event.target.checked)} />
            <span><strong>Instant lock</strong><small>Skip the 2.5 second hover delay</small></span>
          </label>
          <label className="play-flow__toggle">
            <input type="checkbox" checked={prefs.autoRoleQuestLoadout} onChange={(event) => update('autoRoleQuestLoadout', event.target.checked)} disabled={!selectedRoleQuestSpells || (champSelectLive && detectedRole !== 'TOP')} />
            <span><strong>Top quest loadout</strong><small>{detectedRole === 'TOP' ? 'League confirmed Top · apply Flash + Teleport' : selectedRoleQuestSpells ? 'Waiting for League to confirm Top before applying' : 'Select Top to enable this helper'}</small></span>
          </label>
          <label className="play-flow__toggle">
            <input type="checkbox" checked={prefs.arenaBraveryPick} onChange={(event) => update('arenaBraveryPick', event.target.checked)} disabled={!isArenaSelection} />
            <span><strong>Arena Bravery pick</strong><small>{isArenaSelection ? 'Choose League’s random Bravery pick instead of a champion' : 'Select the Arena queue to enable this helper'}</small></span>
          </label>
        </div>

        <div className="play-flow__policy">
          <div className="play-flow__policy-heading"><span><GitBranch /> Draft policy</span><small>RiftOps checks live bans, picks, and teammate hovers before it sends an action.</small></div>
          <div className="play-flow__policy-columns">
            <section className="play-flow__policy-lane">
              <div className="play-flow__policy-lane-heading"><span>Pick path</span><small>Choose the first available champion, then the fallback.</small></div>
              {isArenaSelection && prefs.arenaBraveryPick && <div className="play-flow__policy-note"><Zap /> Arena Bravery is armed. RiftOps will send League’s special Bravery pick (-3) and will not invent a champion or ban it.</div>}
              {isArenaSelection && <div className="play-flow__policy-note"><Sparkles /> {selectedArenaEvent}. The champion grid will use League’s live Arena choice pool; RiftOps never invents Crowd Favorites or sends a normal champion outside that pool.</div>}
              <div className="play-flow__policy-pair">
                <ChampionPicker value={prefs.pickChampionId} query={pickQuery} onQuery={setPickQuery} onSelect={(id) => update('pickChampionId', id)} label="Primary pick" version={version} champions={champions} />
                <ChampionPicker value={prefs.fallbackPickChampionId} query={fallbackPickQuery} onQuery={setFallbackPickQuery} onSelect={(id) => update('fallbackPickChampionId', id)} label="Fallback pick" version={version} champions={champions} />
              </div>
              <TimingControl label="Pick timing" mode={prefs.pickTimingMode} seconds={prefs.pickTimingSeconds} onMode={(value) => update('pickTimingMode', value)} onSeconds={(value) => update('pickTimingSeconds', value)} />
              <div className="play-flow__rune-plan">
                <label className="play-flow__rune-select">
                  <span><BookOpen /> Primary pick runes</span>
                  <select value={prefs.pickRunePageId} onChange={(event) => update('pickRunePageId', Number(event.target.value))} disabled={!editableRunePages.length} aria-label="Rune page for the primary pick">
                    <option value="0">Keep the current page</option>
                    {editableRunePages.map((page) => <option key={page.id} value={page.id}>{page.name || `Rune page ${page.id}`}</option>)}
                  </select>
                </label>
                <label className="play-flow__rune-select is-fallback">
                  <span><GitBranch /> Fallback pick runes</span>
                  <select value={prefs.fallbackPickRunePageId} onChange={(event) => update('fallbackPickRunePageId', Number(event.target.value))} disabled={!editableRunePages.length} aria-label="Rune page for the fallback pick">
                    <option value="0">Use primary pick runes</option>
                    {editableRunePages.map((page) => <option key={page.id} value={page.id}>{page.name || `Rune page ${page.id}`}</option>)}
                  </select>
                </label>
                <div className="play-flow__rune-editor-link">
                  <span><strong>{currentRunePage?.name || 'No rune page loaded'}</strong><small>{currentRunePage?.isEditable === false ? 'This League page is read-only; select a custom page first.' : 'Edit League’s currently active custom rune page.'}</small></span>
                  <button type="button" onClick={() => setRuneEditorOpen(true)} disabled={!currentRunePage || currentRunePage.isEditable === false}><Pencil /> Edit current</button>
                </div>
              </div>
              {!editableRunePages.length && <small className="play-flow__policy-note">Connect to League Client and create a custom rune page to enable this loadout.</small>}
              <BuildPlanner
                championId={prefs.pickChampionId}
                championName={champions[prefs.pickChampionId]?.name || ''}
                fallbackChampionId={prefs.fallbackPickChampionId}
                fallbackChampionName={champions[prefs.fallbackPickChampionId]?.name || ''}
                role={detectedRole || prefs.primaryRole}
                onNotice={showToast}
              />
            </section>
            <section className="play-flow__policy-lane">
              <div className="play-flow__policy-lane-heading"><span>Ban path</span><small>Keep a backup ban ready if the first target is unavailable.</small></div>
              <div className="play-flow__policy-pair">
                <ChampionPicker value={prefs.banChampionId} query={banQuery} onQuery={setBanQuery} onSelect={(id) => update('banChampionId', id)} label="Primary ban" version={version} champions={champions} />
                <ChampionPicker value={prefs.fallbackBanChampionId} query={fallbackBanQuery} onQuery={setFallbackBanQuery} onSelect={(id) => update('fallbackBanChampionId', id)} label="Fallback ban" version={version} champions={champions} />
              </div>
              <TimingControl label="Ban timing" mode={prefs.banTimingMode} seconds={prefs.banTimingSeconds} onMode={(value) => update('banTimingMode', value)} onSeconds={(value) => update('banTimingSeconds', value)} />
            </section>
          </div>
        </div>

        <div className="play-flow__automation-footer">
          <div className="play-flow__policy-note"><ShieldCheck /> Unavailable primary choices are skipped automatically and the fallback is tried next. Auto mode runs only while this page is open.</div>
          <div className={`play-flow__draft-status is-${draftTone}`} role="status" aria-live="polite">
            <span className="play-flow__draft-status-dot" />
            <span><strong>Draft automation</strong><small>{draftStatus}</small></span>
          </div>
        </div>
      </section>}
      {!remoteClient && <RunePageEditor
        open={runeEditorOpen}
        page={currentRunePage}
        onClose={() => setRuneEditorOpen(false)}
        onSaved={async (updated) => {
          setRunePages((pages) => pages.map((page) => page.id === updated.id ? updated : page));
          showToast(`${updated.name} saved to League.`, 'success');
        }}
      />}
    </div>
  );
}
