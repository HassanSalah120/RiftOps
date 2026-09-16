import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Ban, BookOpen, CheckCircle2, ChevronDown, ChevronRight, CircleStop, Clock3, GitBranch, Loader2, Play,
  Pencil, RefreshCw, Rocket, Search, ShieldCheck, Sparkles, Square, Swords, WifiOff, X, Zap,
} from 'lucide-react';
import {
  ddChampionIcon, createLCULobby, createPracticeToolLobby,
  fetchDDragonVersion, fetchGameflowPhase, fetchLCUAvailableQueues,
  fetchLCULobby, fetchLCUChampSelect, fetchLCURunePages, launchGame, launchLCULeague,
  fetchQoLPreferences, lcuAutoAccept, lcuAutoRequeue, lcuAutoRoles, lcuCustomStart, lcuStopQueue,
  saveQoLPreferences, updateLCUChampSelectSelection, fetchLCUMatchmakingDiagnostics, fetchLCULeaverRestrictions,
  fetchLCUCustomGames, refreshLCUCustomGames, actOnLCULobbyInvitation, previewExpandedReviewedOperation, executeReviewedOperation, fetchReviewedOperation,
  fetchPlayFlowRuntime, startPlayFlowRuntime, stopPlayFlowRuntime,
} from '../api';
import type { ArenaPriorityItem, DDChampion, LCUAvailableQueue, LCULobby, LCURunePage, MatchmakingDiagnostics, LeaverRestrictionStatus, PlayFlowCycleMode, PlayFlowPreferences, PlayFlowRuntimeStatus, CustomGamesDirectory } from '../api';
import { loadChampionCatalog } from '../leagueCatalog';
import { localAssignedPosition, normalizeChampSelectSession, rolePickPlanFor } from '../champSelectFlow';
import type { DraftTimingMode, PickOrderSwapTarget, PickRole, RolePickPlan } from '../champSelectFlow';
import PageHeader from './PageHeader';
import RunePageEditor from './RunePageEditor';
import BuildPlanner from './BuildPlanner';
import PreparationPanel from './PreparationPanel';
import { ActionFeedback, type FeedbackState } from './DesignPrimitives';
import ReviewOperationModal, { type ReviewOperationData } from './ReviewOperationModal';
import { PRACTICE_TOOL_QUEUE_ID, queueStartMode } from '../playFlowQueue';
import { recommendedRoleQuestSpells, roleQuestPlan } from '../roleQuest';
import { shouldUseArenaBravery } from '../arenaBravery';
import { arenaEventKey, arenaEventLabel } from '../arenaTelemetry';
import type { BuildPlan } from '../buildPlanner';

type ToastFn = (message: string, type?: 'info' | 'success' | 'error') => void;

type TimingMode = DraftTimingMode;
type PrefsSaveState = 'saved' | 'saving' | 'local';

const ROLE_OPTIONS: Array<[string, string]> = [
  ['TOP', 'Top'], ['JUNGLE', 'Jungle'], ['MIDDLE', 'Mid'], ['BOTTOM', 'Bot'], ['UTILITY', 'Support'], ['FILL', 'Fill'],
];
const PICK_ROLES: PickRole[] = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const EMPTY_ROLE_PICK_PLAN: RolePickPlan = { pickChampionId: 0, fallbackPickChampionId: 0, pickRunePageId: 0, fallbackPickRunePageId: 0 };

const STORAGE_KEY = 'riftops.playFlow';
const MAX_AUTO_ACCEPT_DELAY_SECONDS = 8;
const PICK_ORDER_TARGETS: PickOrderSwapTarget[] = ['latest', 'pick-1', 'pick-2', 'pick-3', 'pick-4', 'pick-5'];

function normalizeRolePickPlans(value: unknown): Partial<Record<PickRole, RolePickPlan>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const plans: Partial<Record<PickRole, RolePickPlan>> = {};
  for (const role of PICK_ROLES) {
    const raw = (value as Record<string, unknown>)[role];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const numberValue = (key: keyof RolePickPlan) => {
      const number = Number(record[key]);
      return Number.isSafeInteger(number) && number >= 0 ? number : 0;
    };
    plans[role] = {
      pickChampionId: numberValue('pickChampionId'),
      fallbackPickChampionId: numberValue('fallbackPickChampionId'),
      pickRunePageId: numberValue('pickRunePageId'),
      fallbackPickRunePageId: numberValue('fallbackPickRunePageId'),
    };
  }
  return plans;
}

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
  autoAcceptDelaySeconds: number;
  autoAcceptRandomDelay: boolean;
  autoBan: boolean;
  autoPick: boolean;
  roleAwarePicks: boolean;
  rolePickPlans: Partial<Record<PickRole, RolePickPlan>>;
  autoPickOrderToLast: boolean;
  autoPickOrderTarget: PickOrderSwapTarget;
  instantLock: boolean;
  autoRoleQuestLoadout: boolean;
  arenaBraveryPick: boolean;
  arenaPickPriority: ArenaPriorityItem[];
  aramChampionPriority: number[];
};

function loadPrefs(): FlowPrefs {
  const defaults: FlowPrefs = {
    primaryRole: 'TOP', secondaryRole: 'FILL', pickChampionId: 0, fallbackPickChampionId: 0,
    banChampionId: 0, fallbackBanChampionId: 0, pickRunePageId: 0, fallbackPickRunePageId: 0,
    pickTimingMode: 'immediate', pickTimingSeconds: 2,
    banTimingMode: 'immediate', banTimingSeconds: 2,
    selectedQueue: 0,
    autoRoles: true, autoQueue: true, autoAccept: true, autoAcceptDelaySeconds: 0, autoAcceptRandomDelay: false, autoBan: true, autoPick: true, roleAwarePicks: false, rolePickPlans: {}, autoPickOrderToLast: false, autoPickOrderTarget: 'latest', instantLock: false,
    autoRoleQuestLoadout: false, arenaBraveryPick: false,
    arenaPickPriority: [{ type: 'firstAvailable' }], aramChampionPriority: [],
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Partial<FlowPrefs>;
      return {
        ...defaults,
        ...stored,
        roleAwarePicks: stored.roleAwarePicks === true,
        rolePickPlans: normalizeRolePickPlans(stored.rolePickPlans),
        autoPickOrderTarget: PICK_ORDER_TARGETS.includes(stored.autoPickOrderTarget as PickOrderSwapTarget) ? stored.autoPickOrderTarget as PickOrderSwapTarget : defaults.autoPickOrderTarget,
        autoAcceptDelaySeconds: Math.max(0, Math.min(MAX_AUTO_ACCEPT_DELAY_SECONDS, Number(stored.autoAcceptDelaySeconds) || 0)),
        pickTimingSeconds: (stored.pickTimingMode || defaults.pickTimingMode) === 'last-second' ? Math.max(1, Math.min(60, Number(stored.pickTimingSeconds ?? defaults.pickTimingSeconds) || 1)) : Math.max(0, Math.min(60, Number(stored.pickTimingSeconds ?? defaults.pickTimingSeconds) || 0)),
        banTimingSeconds: (stored.banTimingMode || defaults.banTimingMode) === 'last-second' ? Math.max(1, Math.min(60, Number(stored.banTimingSeconds ?? defaults.banTimingSeconds) || 1)) : Math.max(0, Math.min(60, Number(stored.banTimingSeconds ?? defaults.banTimingSeconds) || 0)),
        arenaPickPriority: Array.isArray(stored.arenaPickPriority) ? stored.arenaPickPriority.slice(0, 12) : defaults.arenaPickPriority,
        aramChampionPriority: Array.isArray(stored.aramChampionPriority) ? stored.aramChampionPriority.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 12) : [],
      };
    }
  } catch { /* Defaults are fine when storage is unavailable. */ }
  return defaults;
}

// Queues without lane preferences (Practice Tool is handled separately).
const ROLELESS_QUEUES = new Set([450, 1700, 1750, 2400, 2450, 3140]);
function isRolelessQueue(queueId: number): boolean {
  return ROLELESS_QUEUES.has(queueId);
}

function isPracticeQueue(queueId: number): boolean {
  return queueId === PRACTICE_TOOL_QUEUE_ID;
}

function isARAMQueue(queue: LCUAvailableQueue | number | null | undefined): boolean {
  const aramQueueIds = new Set([450, 2400, 3200, 3210, 3220, 3230, 3270]);
  if (typeof queue === 'number') return aramQueueIds.has(queue);
  if (!queue) return false;
  const mode = String(queue.gameMode || '').trim().toUpperCase();
  const name = String(queue.name || '').trim().toUpperCase();
  return aramQueueIds.has(Number(queue.id)) || Number(queue.mapId) === 12 || mode === 'ARAM' || mode === 'KIWI' || /\bARAM\b/.test(name);
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
  if (queue && String(queue.category || '').trim().toLowerCase() === 'custom') {
    return createLCULobby(queueID, { category: queue.category, gameMode: queue.gameMode, queueName: queue.name, mapId: queue.mapId });
  }
  return createLCULobby(queueID);
}

function queueLabel(queue: LCUAvailableQueue): string {
  const raw = String(queue.name || queue.gameMode || '').replace(/ games?$/i, '').replace(/\s+/g, ' ').trim();
  return raw || `Queue ${queue.id}`;
}

function roleLabel(role: string): string {
  return ROLE_OPTIONS.find(([value]) => value === role)?.[1] || role;
}

type QueueGroupKey = 'ranked' | 'standard' | 'special' | 'bots' | 'practice';

const QUEUE_GROUP_META: Record<QueueGroupKey, { label: string; detail: string }> = {
  ranked: { label: 'Ranked', detail: 'Competitive matchmaking' },
  standard: { label: 'Standard', detail: 'Classic lane-based queues' },
  special: { label: 'Special modes', detail: 'ARAM, Arena, and rotating modes' },
  bots: { label: 'Co-op vs AI', detail: 'Practice against bots' },
  practice: { label: 'Practice & custom', detail: 'Private lobbies and testing' },
};

const QUEUE_GROUP_ORDER: QueueGroupKey[] = ['ranked', 'standard', 'special', 'bots', 'practice'];
const HIDDEN_QUEUE_TEXT = /\b(tutorial|sandbox|debug|placeholder|unknown|spectator|replay|deprecated)\b/i;

function normalizedQueueText(queue: LCUAvailableQueue): string {
  return `${queueLabel(queue)} ${String(queue.gameMode || '')} ${String(queue.category || '')}`.replace(/\s+/g, ' ').trim();
}

function isSelectableQueue(queue: LCUAvailableQueue): boolean {
  const id = Number(queue.id);
  const label = queueLabel(queue).trim();
  if (!Number.isSafeInteger(id) || id <= 0 || !label || /^queue\s+\d+$/i.test(label)) return false;
  return !HIDDEN_QUEUE_TEXT.test(normalizedQueueText(queue));
}

function queueGroupKey(queue: LCUAvailableQueue): QueueGroupKey {
  const text = normalizedQueueText(queue).toLowerCase();
  const category = String(queue.category || '').toLowerCase();
  if (queue.id === PRACTICE_TOOL_QUEUE_ID || category.includes('custom') || category.includes('training') || /\bpractice\b|\bcustom\b/.test(text)) return 'practice';
  if (/\brank|solo|flex|competitive/.test(text)) return 'ranked';
  if (/\baram|arena|cherry|howling abyss|swiftplay|urf|one for all|nexus blitz|special/.test(text)) return 'special';
  if (/\bbot|versus ai|vs ai|co-?op/.test(text)) return 'bots';
  return 'standard';
}

function queueMapLabel(queue: LCUAvailableQueue): string {
  if (Number(queue.mapId) === 11) return "Summoner's Rift";
  if (Number(queue.mapId) === 12) return 'Howling Abyss';
  if (Number(queue.mapId) === 30 || /arena|cherry/i.test(normalizedQueueText(queue))) return 'Arena';
  return '';
}

function queueDetail(queue: LCUAvailableQueue): string {
  if (queue.id === PRACTICE_TOOL_QUEUE_ID) return 'Private practice lobby · safe for testing';
  if (String(queue.category || '').toLowerCase().includes('custom')) return 'Custom lobby · start when ready';
  const map = queueMapLabel(queue);
  if (isRolelessQueue(queue.id)) return map ? `${map} · lane selection not used` : 'Lane selection not used';
  return map ? `${map} · choose your lanes` : 'Matchmaking · choose your lanes';
}

function sortQueues(queues: LCUAvailableQueue[]): LCUAvailableQueue[] {
  const unique = new Map<number, LCUAvailableQueue>();
  queues.filter(isSelectableQueue).forEach((queue) => {
    const id = Number(queue.id);
    if (!unique.has(id)) unique.set(id, { ...queue, id });
  });
  return Array.from(unique.values()).sort((a, b) => {
    const groupA = QUEUE_GROUP_ORDER.indexOf(queueGroupKey(a));
    const groupB = QUEUE_GROUP_ORDER.indexOf(queueGroupKey(b));
    if (groupA !== groupB) return groupA - groupB;
    return queueLabel(a).localeCompare(queueLabel(b));
  });
}

function groupedQueues(queues: LCUAvailableQueue[]): Array<{ key: QueueGroupKey; queues: LCUAvailableQueue[] }> {
  const groups = new Map<QueueGroupKey, LCUAvailableQueue[]>();
  sortQueues(queues).forEach((queue) => {
    const key = queueGroupKey(queue);
    const group = groups.get(key) || [];
    group.push(queue);
    groups.set(key, group);
  });
  return QUEUE_GROUP_ORDER
    .filter((key) => groups.has(key))
    .map((key) => ({ key, queues: groups.get(key) || [] }));
}

function QueuePicker({ value, queues, onChange, disabled = false }: {
  value: number;
  queues: LCUAvailableQueue[];
  onChange: (queueId: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState('current');
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const options = sortQueues(queues);
  const selectedQueue = options.find((queue) => queue.id === value);
  const selectedLabel = selectedQueue ? queueLabel(selectedQueue) : value > 0 ? 'Saved queue unavailable' : 'Use current lobby';
  const selectedDetail = selectedQueue ? queueDetail(selectedQueue) : value > 0 ? 'Reconnect to refresh available modes' : 'Keep League’s active lobby';
  const optionIds = ['current', ...options.map((queue) => `queue-${queue.id}`)];
  const grouped = groupedQueues(options);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    requestAnimationFrame(() => listRef.current?.focus());
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveId(value > 0 && selectedQueue ? `queue-${value}` : 'current');
  }, [open, selectedQueue, value]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (queueId: number) => {
    onChange(queueId);
    close();
  };

  const moveActive = (direction: 1 | -1) => {
    const currentIndex = Math.max(0, optionIds.indexOf(activeId));
    const nextIndex = (currentIndex + direction + optionIds.length) % optionIds.length;
    setActiveId(optionIds[nextIndex]);
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === 'Escape') event.preventDefault();
  };

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveId(optionIds[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveId(optionIds[optionIds.length - 1]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(activeId === 'current' ? 0 : Number(activeId.replace('queue-', '')));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  return (
    <div ref={pickerRef} className="play-flow__queue-picker">
      <button
        ref={triggerRef}
        type="button"
        className={`play-flow__queue-trigger ${open ? 'is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="play-flow-queue-options"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="play-flow__queue-trigger-copy">
          <strong>{selectedLabel}</strong>
          <small>{selectedDetail}</small>
        </span>
        <ChevronDown className="play-flow__queue-trigger-icon" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={listRef}
          id="play-flow-queue-options"
          className="play-flow__queue-menu"
          role="listbox"
          tabIndex={0}
          aria-label="Available queues"
          aria-activedescendant={`play-flow-queue-option-${activeId}`}
          onKeyDown={handleListKeyDown}
        >
          <div className="play-flow__queue-menu-heading">Choose where to play</div>
          <button
            type="button"
            role="option"
            id="play-flow-queue-option-current"
            aria-selected={value === 0}
            className={`play-flow__queue-option ${activeId === 'current' ? 'is-active' : ''} ${value === 0 ? 'is-selected' : ''}`}
            onMouseEnter={() => setActiveId('current')}
            onClick={() => choose(0)}
          >
            <span className="play-flow__queue-option-mark" aria-hidden="true"><CheckCircle2 /></span>
            <span className="play-flow__queue-option-copy"><strong>Use current lobby</strong><small>Keep League’s active lobby</small></span>
          </button>
          {grouped.map(({ key, queues: groupQueues }) => (
            <section key={key} className="play-flow__queue-group" aria-labelledby={`play-flow-queue-group-${key}`}>
              <div className="play-flow__queue-group-heading" id={`play-flow-queue-group-${key}`}>
                <strong>{QUEUE_GROUP_META[key].label}</strong>
                <small>{QUEUE_GROUP_META[key].detail}</small>
              </div>
              {groupQueues.map((queue) => {
                const optionId = `queue-${queue.id}`;
                const selected = queue.id === value;
                return (
                  <button
                    type="button"
                    role="option"
                    id={`play-flow-queue-option-${optionId}`}
                    key={queue.id}
                    aria-selected={selected}
                    className={`play-flow__queue-option ${activeId === optionId ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`}
                    onMouseEnter={() => setActiveId(optionId)}
                    onClick={() => choose(queue.id)}
                  >
                    <span className="play-flow__queue-option-mark" aria-hidden="true"><CheckCircle2 /></span>
                    <span className="play-flow__queue-option-copy"><strong>{queueLabel(queue)}</strong><small>{queueDetail(queue)}</small></span>
                  </button>
                );
              })}
            </section>
          ))}
          {!grouped.length && <p className="play-flow__queue-empty">Connect League to load available queues.</p>}
        </div>
      )}
    </div>
  );
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
    <div className="play-flow__champion-picker flex flex-col gap-2 p-3 rounded-xl bg-dark-bg/60 border border-white/5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 text-text-dim font-bold uppercase tracking-wider text-[10px]">
          <Ban className="h-3 w-3 opacity-60" /> {label}
        </span>
        {value ? (
          <span className="flex items-center gap-2 px-2 py-0.5 rounded-lg bg-dark-card border border-white/10 text-xs">
            <img src={ddChampionIcon(version, champions[value]?.id || String(value))} alt="" className="w-4 h-4 rounded-full object-cover" />
            <span className="text-white font-semibold text-xs truncate max-w-[90px]">{champions[value]?.name || `Champion ${value}`}</span>
            <button type="button" onClick={() => onSelect(0)} aria-label={`Clear ${label}`} className="text-text-dim hover:text-white p-0.5"><X className="h-3 w-3" /></button>
          </span>
        ) : (
          <span className="text-text-dim text-xs">Not set</span>
        )}
      </div>
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-dark-card border border-white/10 text-xs">
        <Search className="w-3.5 h-3.5 text-text-dim shrink-0" />
        <input className="w-full bg-transparent text-white text-xs placeholder:text-text-dim focus:outline-none" value={query} onChange={(event) => onQuery(event.target.value)} placeholder={`Search ${label.toLowerCase()}…`} aria-label={label} />
      </div>
      {term ? (
        <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto p-1 rounded-lg bg-black/40 border border-white/10">
          {matches.map((champ) => (
            <button type="button" key={champ.key} onClick={() => { onSelect(Number(champ.key)); onQuery(''); }} className="flex items-center gap-2 p-1.5 rounded hover:bg-white/10 transition text-left">
              <img src={ddChampionIcon(version, champ.id)} alt="" className="w-5 h-5 rounded-full object-cover" loading="lazy" />
              <span className="text-xs text-white truncate">{champ.name}</span>
            </button>
          ))}
          {!matches.length && <span className="text-xs text-text-dim italic col-span-2 text-center py-2">No matches</span>}
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
    <div className="play-flow__timing-control flex items-center justify-between gap-3 p-2.5 rounded-xl bg-dark-bg/40 border border-white/5 text-xs">
      <div className="flex items-center gap-1.5 text-text-muted">
        <Clock3 className="w-3.5 h-3.5 text-text-dim" />
        <span>{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <select value={mode} onChange={(event) => onMode(event.target.value as TimingMode)} aria-label={`${label} timing`} className="px-2 py-1 rounded-lg bg-dark-card border border-white/10 text-white text-xs focus:border-primary/50 focus:outline-none">
          <option value="immediate">Immediately</option>
          <option value="last-second">With time remaining</option>
          <option value="after">After delay</option>
        </select>
        {mode !== 'immediate' && (
          <label className="play-flow__timing-seconds flex items-center gap-1 text-xs text-text-dim">
            <input type="number" min={mode === 'last-second' ? 1 : 0} max="60" value={seconds} onChange={(event) => onSeconds(Math.max(mode === 'last-second' ? 1 : 0, Math.min(60, Number(event.target.value) || (mode === 'last-second' ? 1 : 0))))} aria-label={`${label} seconds`} className="play-flow__timing-input rounded-lg bg-dark-card border border-white/10 text-white text-center focus:border-primary/50 focus:outline-none" />
            <span>s</span>
          </label>
        )}
      </div>
    </div>
  );
}

function ChampionPrioritySearch({ champions, version, excluded, onAdd }: {
  champions: Record<number, DDChampion>;
  version: string;
  excluded: Set<number>;
  onAdd: (championId: number) => void;
}) {
  const [query, setQuery] = useState('');
  const term = query.trim().toLowerCase();
  const matches = term ? Object.values(champions)
    .filter((champion) => !excluded.has(Number(champion.key)) && champion.name.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 6) : [];
  return (
    <div className="play-flow__priority-search">
      <label><Search className="h-3.5 w-3.5" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Add a champion…" aria-label="Add champion to priority" /></label>
      {term && <div className="play-flow__priority-search-results">
        {matches.map((champion) => <button type="button" key={champion.key} onClick={() => { onAdd(Number(champion.key)); setQuery(''); }}><img src={ddChampionIcon(version, champion.id)} alt="" /><span>{champion.name}</span></button>)}
        {!matches.length && <small>No available champions match.</small>}
      </div>}
    </div>
  );
}

function ArenaPriorityEditor({ items, champions, version, onChange }: {
  items: ArenaPriorityItem[];
  champions: Record<number, DDChampion>;
  version: string;
  onChange: (items: ArenaPriorityItem[]) => void;
}) {
  const championIDs = new Set(items.filter((item): item is Extract<ArenaPriorityItem, { type: 'champion' }> => item.type === 'champion').map((item) => item.championId));
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const add = (item: ArenaPriorityItem) => {
    if (items.length >= 12) return;
    onChange([...items, item]);
  };
  return (
    <section className="play-flow__priority-editor" aria-labelledby="arena-priority-title">
      <div><strong id="arena-priority-title">Arena pick priority</strong><p>RiftOps tries each choice in order. Bravery falls through if League rejects it.</p></div>
      <ol>
        {items.map((item, index) => {
          const champion = item.type === 'champion' ? champions[item.championId] : null;
          const label = item.type === 'bravery' ? 'Bravery' : item.type === 'firstAvailable' ? 'First available champion' : champion?.name || `Champion ${item.championId}`;
          return <li key={item.type === 'champion' ? `champion-${item.championId}` : item.type}>
            <span className="play-flow__priority-rank">{index + 1}</span>
            {item.type === 'champion' ? <img src={ddChampionIcon(version, champion?.id || String(item.championId))} alt="" /> : <Sparkles className="h-4 w-4" />}
            <span><strong>{label}</strong><small>{item.type === 'bravery' ? 'League random choice (-3)' : item.type === 'firstAvailable' ? 'Prevents a missed Arena selection' : 'Specific champion when available'}</small></span>
            <span className="play-flow__priority-actions"><button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${label} up`}>↑</button><button type="button" onClick={() => move(index, 1)} disabled={index === items.length - 1} aria-label={`Move ${label} down`}>↓</button><button type="button" onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${label}`}>×</button></span>
          </li>;
        })}
      </ol>
      <div className="play-flow__priority-add">
        {!items.some((item) => item.type === 'bravery') && <button type="button" className="btn-secondary" onClick={() => add({ type: 'bravery' })}>+ Bravery</button>}
        {!items.some((item) => item.type === 'firstAvailable') && <button type="button" className="btn-secondary" onClick={() => add({ type: 'firstAvailable' })}>+ First available</button>}
      </div>
      <ChampionPrioritySearch champions={champions} version={version} excluded={championIDs} onAdd={(championId) => add({ type: 'champion', championId })} />
      <small>{items.length}/12 priorities</small>
    </section>
  );
}

function ARAMPriorityEditor({ championIDs, champions, version, onChange }: {
  championIDs: number[];
  champions: Record<number, DDChampion>;
  version: string;
  onChange: (championIDs: number[]) => void;
}) {
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= championIDs.length) return;
    const next = [...championIDs];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <section className="play-flow__priority-editor" aria-labelledby="aram-priority-title">
      <div><strong id="aram-priority-title">ARAM favorites</strong><p>RiftOps uses a higher favorite from cards or the bench. Rerolls always stay manual.</p></div>
      <ol>
        {championIDs.map((championID, index) => {
          const champion = champions[championID];
          const label = champion?.name || `Champion ${championID}`;
          return <li key={championID}><span className="play-flow__priority-rank">{index + 1}</span><img src={ddChampionIcon(version, champion?.id || String(championID))} alt="" /><span><strong>{label}</strong><small>Use when available</small></span><span className="play-flow__priority-actions"><button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${label} up`}>↑</button><button type="button" onClick={() => move(index, 1)} disabled={index === championIDs.length - 1} aria-label={`Move ${label} down`}>↓</button><button type="button" onClick={() => onChange(championIDs.filter((id) => id !== championID))} aria-label={`Remove ${label}`}>×</button></span></li>;
        })}
      </ol>
      <ChampionPrioritySearch champions={champions} version={version} excluded={new Set(championIDs)} onAdd={(championID) => { if (championIDs.length < 12) onChange([...championIDs, championID]); }} />
      <small>{championIDs.length}/12 favorites · no automatic rerolls</small>
    </section>
  );
}

function SwitchRow({ label, description, checked, onChange, disabled = false }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`play-flow__switch-row ${checked ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}>
      <span className="play-flow__switch-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className="play-flow__switch-control">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={disabled} />
        <span className="play-flow__switch-visual" aria-hidden="true"><span /></span>
        <span className="play-flow__switch-state" aria-hidden="true">{checked ? 'On' : 'Off'}</span>
      </span>
    </label>
  );
}

export default function PlayFlowPage({ showToast: publishToast, onOpenLive, remoteClient = false }: { showToast: ToastFn; onOpenLive?: () => void; remoteClient?: boolean }) {
  const [prefs, setPrefs] = useState<FlowPrefs>(loadPrefs);
  const [phase, setPhase] = useState('');
  const [connected, setConnected] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [flowMode, setFlowMode] = useState<'manual' | 'full-auto'>('manual');
  const [cycleMode, setCycleMode] = useState<PlayFlowCycleMode>('single');
  const [runtimeStatus, setRuntimeStatus] = useState<PlayFlowRuntimeStatus>({
    active: false,
    cycleMode: 'single',
    stage: 'idle',
    message: 'Choose how you want to start.',
    updatedAt: new Date(0).toISOString(),
  });
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
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [rolePlanEditorRole, setRolePlanEditorRole] = useState<PickRole>('TOP');
  const [prefsSaveState, setPrefsSaveState] = useState<PrefsSaveState>('saved');
  const [detectedRole, setDetectedRole] = useState<string | null>(null);
  const [savedBuildPlan, setSavedBuildPlan] = useState<BuildPlan | null>(null);
  const [matchmaking, setMatchmaking] = useState<MatchmakingDiagnostics | null>(null);
  const [restrictions, setRestrictions] = useState<LeaverRestrictionStatus | null>(null);
  const [customDirectory, setCustomDirectory] = useState<CustomGamesDirectory | null>(null);
  const [customReview, setCustomReview] = useState<ReviewOperationData | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const prefsTouchedRef = useRef(false);

  const showToast = useCallback<ToastFn>((message, type = 'info') => {
    setFeedback({ tone: type === 'success' ? 'success' : type === 'error' ? 'error' : 'info', message });
    publishToast(message, type);
  }, [publishToast]);

  // Practice Tool is a custom lobby on a dedicated queue; creating it goes
  // through the dedicated payload path on the backend.
  const isPracticeSelection = prefs.selectedQueue === PRACTICE_TOOL_QUEUE_ID;

  // General phase guards are separate from the server-confirmed draft state.
  const roleLoadoutRef = useRef('');
  const detectedRoleRef = useRef<string | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const queuesRef = useRef(queues);
  queuesRef.current = queues;

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* Optional preference. */ }
  }, [prefs]);

  useEffect(() => {
    let cancelled = false;
    const refreshRuntime = () => {
      void fetchPlayFlowRuntime().then((status) => {
        if (cancelled) return;
        setRuntimeStatus(status);
        setAutoMode(status.active);
        if (status.active) {
          setFlowMode('full-auto');
          setCycleMode(status.cycleMode);
        }
      }).catch(() => {
        if (!cancelled) setAutoMode(false);
      });
    };
    refreshRuntime();
    const interval = window.setInterval(refreshRuntime, 750);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // Match-flow switches are shared with the background QoL manager. Hydrate
  // only those shared fields from its durable store; the rest of the drawer
  // remains local to the Play & Queue workflow.
  useEffect(() => {
    let cancelled = false;
    void fetchQoLPreferences().then((stored) => {
      if (cancelled || prefsTouchedRef.current) return;
      if (stored.playFlow) {
        setPrefs((current) => ({ ...current, ...stored.playFlow }));
        setPrefsSaveState('saved');
        return;
      }
      // Existing installs only have the legacy localStorage policy. Send it
      // through the backend once so future edits and other tools use the same
      // validated copy without breaking that compatibility path.
      setPrefsSaveState('saving');
      void saveQoLPreferences({ playFlow: prefsRef.current }).then((saved) => {
        if (!cancelled && saved.playFlow) setPrefs((current) => ({ ...current, ...saved.playFlow }));
        if (!cancelled) setPrefsSaveState('saved');
      }).catch(() => {
        if (!cancelled) setPrefsSaveState('local');
      });
    }).catch(() => {
      // The local Play & Queue preferences remain usable while the backend is unavailable.
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!configureOpen) return undefined;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerCloseRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setConfigureOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [configureOpen]);

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
    if (!connected || remoteClient) {
      setMatchmaking(null);
      setRestrictions(null);
      return;
    }
    let cancelled = false;
    const refreshSafety = () => {
      void Promise.all([
        fetchLCUMatchmakingDiagnostics().catch(() => null),
        fetchLCULeaverRestrictions().catch(() => null),
      ]).then(([queue, leaver]) => {
        if (cancelled) return;
        setMatchmaking(queue);
        setRestrictions(leaver);
      });
    };
    refreshSafety();
    const interval = window.setInterval(refreshSafety, phase === 'Matchmaking' || phase === 'ReadyCheck' ? 2000 : 8000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [connected, phase, remoteClient]);

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
        loadChampionCatalog(),
      ]);
      setVersion(ddVersion.version || '15.1.1');
      const mapped: Record<number, DDChampion> = {};
      Object.values(ddChampions).forEach((champ) => { mapped[Number(champ.key)] = champ; });
      setChampions(mapped);
    })();
  }, []);

  const update = <K extends keyof FlowPrefs>(key: K, value: FlowPrefs[K]) => {
    prefsTouchedRef.current = true;
    setPrefsSaveState('saving');
    setPrefs((current) => ({ ...current, [key]: value }));
    const sharedPatch = key === 'autoAccept'
      ? { autoAccept: value as boolean }
      : key === 'autoQueue'
        ? { autoStartQueue: value as boolean }
        : key === 'autoAcceptDelaySeconds'
          ? { autoAcceptDelaySeconds: Math.max(0, Math.min(MAX_AUTO_ACCEPT_DELAY_SECONDS, Math.trunc(Number(value) || 0))) }
          : key === 'autoAcceptRandomDelay'
            ? { autoAcceptRandomDelay: value as boolean }
            : {};
    const playFlowPatch = { [key]: value } as Partial<PlayFlowPreferences>;
    void saveQoLPreferences({ ...sharedPatch, playFlow: playFlowPatch })
      .then((saved) => {
        if (saved.playFlow) setPrefs((current) => ({ ...current, ...saved.playFlow }));
        setPrefsSaveState('saved');
      })
      .catch(() => {
        setPrefsSaveState('local');
        showToast('Play & Queue was saved locally, but backend sync is unavailable.', 'error');
      });
  };

  const updateRolePickPlan = <K extends keyof RolePickPlan>(key: K, value: RolePickPlan[K]) => {
    const plans = prefsRef.current.rolePickPlans || {};
    const current = plans[rolePlanEditorRole] || EMPTY_ROLE_PICK_PLAN;
    update('rolePickPlans', {
      ...plans,
      [rolePlanEditorRole]: { ...current, [key]: value },
    });
  };

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

  useEffect(() => {
    let cancelled = false;
    const refreshPhase = async () => {
      try {
        const current = await fetchGameflowPhase();
        if (cancelled) return;
        setConnected(true);
        setPhase(current);
        if (current !== 'ChampSelect') {
          detectedRoleRef.current = null;
          setDetectedRole(null);
          return;
        }
        const session = normalizeChampSelectSession(await fetchLCUChampSelect());
        if (cancelled) return;
        const assignedRole = localAssignedPosition(session);
        detectedRoleRef.current = assignedRole;
        setDetectedRole(assignedRole);
      } catch {
        if (cancelled) return;
        setConnected(false);
        setPhase('');
        detectedRoleRef.current = null;
        setDetectedRole(null);
      }
    };
    void refreshPhase();
    const interval = window.setInterval(() => void refreshPhase(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);
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

  const selectedQueue = findQueue(prefs.selectedQueue, queues);
  const selectedQueueID = prefs.selectedQueue || Number(lobby?.gameConfig?.queueId || 0);
  const effectiveQueue = selectedQueue || (selectedQueueID > 0 ? {
    id: selectedQueueID,
    name: '',
    gameMode: lobby?.gameConfig?.gameMode,
    mapId: lobby?.gameConfig?.mapId,
  } : undefined);
  const selectedStartMode = queueStartMode(prefs.selectedQueue, queues);
  const isCustomSelection = selectedStartMode === 'custom';

  useEffect(() => {
    if (!connected || remoteClient || !isCustomSelection) {
      setCustomDirectory(null);
      return undefined;
    }
    let cancelled = false;
    const load = () => {
      void fetchLCUCustomGames()
        .then((value) => { if (!cancelled) setCustomDirectory(value); })
        .catch(() => { if (!cancelled) setCustomDirectory(null); });
    };
    load();
    const interval = window.setInterval(load, 10000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [connected, isCustomSelection, remoteClient]);

  const isArenaSelection = shouldUseArenaBravery(true, effectiveQueue || selectedQueueID);
  const isARAMSelection = isARAMQueue(effectiveQueue || selectedQueueID);
  const selectedArenaEvent = isArenaSelection ? arenaEventLabel(arenaEventKey(effectiveQueue || selectedQueueID)) : '';
  const champSelectLive = connected && phase === 'ChampSelect';
  const roleQuestUnavailable = champSelectLive && (isCustomSelection || isPracticeSelection || isRolelessQueue(selectedQueueID) || isArenaSelection || isARAMSelection);
  const roleQuestWaitingForAssignment = champSelectLive && !roleQuestUnavailable && !detectedRole;
  const selectedRoleQuest = roleQuestWaitingForAssignment || roleQuestUnavailable ? null : roleQuestPlan(detectedRole || prefs.primaryRole);
  const selectedRoleQuestSpells = roleQuestWaitingForAssignment || roleQuestUnavailable ? null : recommendedRoleQuestSpells(detectedRole || prefs.primaryRole);
  const editorRolePlan = rolePickPlanFor(rolePlanEditorRole, prefs.rolePickPlans) || EMPTY_ROLE_PICK_PLAN;
  const editorPickChampionId = prefs.roleAwarePicks ? editorRolePlan.pickChampionId : prefs.pickChampionId;
  const editorFallbackPickChampionId = prefs.roleAwarePicks ? editorRolePlan.fallbackPickChampionId : prefs.fallbackPickChampionId;
  const editorPickRunePageId = prefs.roleAwarePicks ? editorRolePlan.pickRunePageId : prefs.pickRunePageId;
  const editorFallbackPickRunePageId = prefs.roleAwarePicks ? editorRolePlan.fallbackPickRunePageId : prefs.fallbackPickRunePageId;
  const availableRunePages = Array.from(new Map(
    runePages
      .filter((page) => Number.isSafeInteger(page.id) && page.id > 0 && page.id !== 0xffffffff)
      .map((page) => [page.id, page]),
  ).values());
  const editableRunePages = availableRunePages.filter((page) => page.isEditable !== false);
  const currentRunePage = availableRunePages.find((page) => page.current || page.isActive)
    || availableRunePages.find((page) => page.id === editorPickRunePageId)
    || editableRunePages[0]
    || null;
  const configuredRolePlans = PICK_ROLES.filter((role) => {
    const plan = rolePickPlanFor(role, prefs.rolePickPlans);
    return Boolean(plan?.pickChampionId || plan?.fallbackPickChampionId);
  }).length;
  const hasPickPlan = prefs.roleAwarePicks
    ? configuredRolePlans > 0
    : Boolean(prefs.pickChampionId || prefs.fallbackPickChampionId);
  const hasBanPlan = Boolean(prefs.banChampionId || prefs.fallbackBanChampionId);
  const queueRuleSummary = prefs.autoAccept
    ? `Ready checks · ${prefs.autoAcceptDelaySeconds > 0 ? `${prefs.autoAcceptDelaySeconds}s delay` : 'immediate'}`
    : 'Ready checks stay manual';
  const draftRuleSummary = [
    isArenaSelection ? `${prefs.arenaPickPriority.length} Arena priorities` : isARAMSelection ? `${prefs.aramChampionPriority.length} ARAM favorites` : prefs.autoPick && prefs.autoBan ? 'Pick + ban enabled' : prefs.autoPick ? 'Pick enabled' : prefs.autoBan ? 'Ban enabled' : prefs.instantLock ? 'Lock timing enabled' : 'Manual draft',
    prefs.autoPickOrderToLast ? `swap to ${prefs.autoPickOrderTarget === 'latest' ? 'latest pick' : prefs.autoPickOrderTarget.replace('pick-', 'pick ')}` : '',
  ].filter(Boolean).join(' · ');
  const activeLockout = Boolean(restrictions?.notifications.some((item) => item.lockoutRemainingMs > 0 || /lockout/i.test(item.type)));
  const activePenalty = Boolean(matchmaking?.lowPriority && matchmaking.lowPriority.penaltySeconds > 0);
  const rankedRestriction = Boolean(restrictions?.ranked && restrictions.ranked.punishedGamesRemaining > 0 && /ranked/i.test(selectedQueue ? queueLabel(selectedQueue) : ''));
  const matchmakingFailure = Boolean(matchmaking && (/^(error|serviceerror|serviceshutdown)$/i.test(matchmaking.state) || matchmaking.errors.length > 0));
  const queueStartBlocked = activeLockout || activePenalty || rankedRestriction;
  const selectedNeedsRoles = selectedQueueID <= 0 || (!isRolelessQueue(selectedQueueID) && !isPracticeQueue(selectedQueueID) && !isCustomSelection);

  const flushPlayFlowPreferences = async () => {
    const saved = await saveQoLPreferences({ playFlow: prefsRef.current });
    if (saved.playFlow) {
      setPrefs((current) => ({ ...current, ...saved.playFlow }));
      prefsRef.current = { ...prefsRef.current, ...saved.playFlow };
    }
    setPrefsSaveState('saved');
  };

  const waitForSelectedLobby = async (queueID: number) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await fetchLCULobby().catch(() => null);
      if (current && Number(current.gameConfig?.queueId || 0) === queueID) return current;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    throw new Error('League did not confirm the selected lobby. Queue start was not sent.');
  };

  const startManualFlow = async () => {
    await flushPlayFlowPreferences();
    let currentLobby = await fetchLCULobby().catch(() => null);
    if (prefsRef.current.selectedQueue > 0 && Number(currentLobby?.gameConfig?.queueId || 0) !== prefsRef.current.selectedQueue) {
      await createConfiguredLobby(prefsRef.current.selectedQueue, queuesRef.current);
      currentLobby = await waitForSelectedLobby(prefsRef.current.selectedQueue);
    }
    if (!currentLobby) throw new Error('Create or select a League lobby before starting.');
    const queueID = Number(currentLobby.gameConfig?.queueId || prefsRef.current.selectedQueue || 0);
    if (queueID <= 0) throw new Error('League did not report a valid lobby queue.');
    const custom = lobbyIsCustom(currentLobby) || queueStartMode(queueID, queuesRef.current) === 'custom';
    const roleBased = !custom && !isPracticeQueue(queueID) && !isRolelessQueue(queueID);
    if (roleBased) await lcuAutoRoles(prefsRef.current.primaryRole, prefsRef.current.secondaryRole);
    if (custom) await lcuCustomStart();
    else await lcuAutoRequeue();
  };

  const handlePrimaryAction = async () => {
    if (autoMode) {
      setActing('runtime-stop');
      try {
        const status = await stopPlayFlowRuntime();
        setRuntimeStatus(status);
        setAutoMode(false);
      } catch (reason: any) {
        showToast(reason?.message || 'Full Auto could not stop.', 'error');
      } finally {
        setActing('');
      }
      return;
    }
    if (!connected) {
      showToast('Connect League before starting.', 'error');
      return;
    }
    if (queueStartBlocked) {
      showToast(activeLockout ? 'Queue start is blocked by an active League lockout.' : activePenalty ? 'Queue start is blocked by a low-priority penalty.' : 'Ranked is currently restricted for this account.', 'error');
      return;
    }
    setActing('primary-start');
    setFeedback(null);
    try {
      if (flowMode === 'full-auto') {
        await flushPlayFlowPreferences();
        const status = await startPlayFlowRuntime(cycleMode);
        setRuntimeStatus(status);
        setAutoMode(true);
      } else {
        await startManualFlow();
        setRuntimeStatus((status) => ({ ...status, active: false, stage: 'matchmaking', message: 'Queue started manually. Draft automation is off.', updatedAt: new Date().toISOString() }));
        onOpenLive?.();
      }
    } catch (reason: any) {
      const message = reason?.message || 'League rejected the start request.';
      setRuntimeStatus((status) => ({ ...status, active: false, stage: 'blocked', message, updatedAt: new Date().toISOString() }));
      showToast(message, 'error');
    } finally {
      setActing('');
    }
  };

  const reviewCustomJoin = async (game: CustomGamesDirectory['games'][number], asSpectator: boolean) => {
    const password = game.passwordRequired ? window.prompt('Enter the custom-game password. It will not be saved.') || undefined : undefined;
    if (game.passwordRequired && !password) return;
    try {
      const preview = await previewExpandedReviewedOperation({ kind: 'custom-game-join', customJoin: { gameId: game.id, asSpectator, password } });
      setCustomReview({ previewId: preview.id, kind: preview.kind, title: asSpectator ? 'Join custom game as spectator' : 'Join custom game', description: 'Joining may replace your current lobby. Confirm the current game before continuing.', confirmation: preview.confirmation, targetCount: 1, targetLabels: [game.name] });
    } catch (reason: any) { showToast(reason?.message || 'Could not prepare the custom-game join.', 'error'); }
  };

  const confirmCustomReview = async (previewID: string, confirmation: string) => {
    await executeReviewedOperation(previewID, confirmation);
    let status = await fetchReviewedOperation(previewID);
    for (let attempt = 0; attempt < 8 && (status.state === 'running' || status.state === 'preview'); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      status = await fetchReviewedOperation(previewID);
    }
    if (status.state !== 'complete') throw new Error(`Operation ${status.state}`);
    setCustomReview(null);
    showToast('Custom game joined.', 'success');
  };

  return (
    <div className="play-flow-page flex-1 min-h-0 min-w-0 overflow-y-auto animate-fadeIn space-y-6" role="region" aria-label="Play and Queue workspace" tabIndex={0}>
      <PageHeader
        variant="status"
        icon={Swords}
        eyebrow="ONE-CLICK PLAY"
        title="Play & Queue"
        description="Choose a queue, set your lanes, and let RiftOps handle the repetitive parts."
        meta={<span className={`page-header__badge ${connected ? 'page-header__badge--success' : ''}`}>{connected ? `Client live · ${phase.replaceAll('_', ' ')}` : 'Waiting for League client'}</span>}
        actions={!remoteClient ? (
          <button type="button" onClick={() => setConfigureOpen(true)} className="btn-secondary flex items-center gap-2 px-4 py-2 text-xs">
            <Zap className="h-3.5 w-3.5" /> Configure
          </button>
        ) : <span className="page-header__badge">Phone live controls</span>}
      />

      <ActionFeedback state={feedback} />

      {(matchmaking?.errors?.length || matchmakingFailure || activePenalty || activeLockout || rankedRestriction || restrictions?.ranked?.needsAck) ? (
        <section className="play-flow__safety-strip" aria-live="polite">
          {activeLockout && <div className="play-flow__safety-warning"><ShieldCheck className="h-4 w-4" /><span>League reports an active queue lockout. Queue start and Full auto are paused until it clears.</span></div>}
          {activePenalty && <div className="play-flow__safety-warning"><ShieldCheck className="h-4 w-4" /><span>League reports a low-priority penalty with {Math.ceil(matchmaking?.lowPriority?.penaltySeconds || 0)} seconds remaining. Full auto is paused.</span></div>}
          {rankedRestriction && <div className="play-flow__safety-warning"><ShieldCheck className="h-4 w-4" /><span>Ranked is restricted for {restrictions?.ranked?.punishedGamesRemaining || 0} game(s). Choose another queue or wait for the restriction to clear.</span></div>}
          {matchmakingFailure && !matchmaking?.errors?.length && <div className="play-flow__safety-warning"><WifiOff className="h-4 w-4" /><span>League matchmaking reported {matchmaking?.state || 'an error'}; Full auto has been paused.</span></div>}
          {restrictions?.ranked?.needsAck && <div className="play-flow__safety-warning"><ShieldCheck className="h-4 w-4" /><span>Ranked restrictions are active: {restrictions.ranked.punishedGamesRemaining} game(s) remaining.</span></div>}
          {matchmaking?.errors?.map((item) => <div className="play-flow__safety-warning" key={item.id}><WifiOff className="h-4 w-4" /><span>{item.message || item.type}</span></div>)}
        </section>
      ) : null}

      {matchmaking && (matchmaking.inQueue || matchmaking.state) && <div className="play-flow__matchmaking-status"><span className="play-flow__matchmaking-dot" /><strong>{matchmaking.state || 'Idle'}</strong><span>{matchmaking.inQueue ? `${Math.floor(matchmaking.elapsedSeconds)}s in queue` : 'Not searching'}</span>{matchmaking.estimatedSeconds > 0 && <span>Estimate {Math.round(matchmaking.estimatedSeconds)}s</span>}</div>}

      {!connected && (
        <div className="flex items-center gap-3 p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
          <WifiOff className="h-4 w-4 shrink-0 text-amber-400" />
          <span>League client is not detected yet. Launch it below or open Riot Client to start.</span>
        </div>
      )}

      <section className="glass-card p-5 rounded-2xl space-y-4 play-flow__setup" aria-labelledby="queue-setup-title">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
              <Rocket className="w-4 h-4" />
            </div>
            <div>
              <h2 id="queue-setup-title" className="text-base font-bold text-white">Start your next game</h2>
              <p className="text-xs text-text-muted">Choose a queue, confirm your lanes, then start.</p>
            </div>
          </div>
          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${connected ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-500/10 text-text-dim border border-white/5'}`}>
            {connected ? 'Client ready' : 'Client offline'}
          </span>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-xl bg-dark-bg/50 border border-white/5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${connected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span className="text-xs text-text-muted">{connected ? `League is ${phase ? phase.replaceAll('_', ' ').toLowerCase() : 'connected'}.` : 'League client is not connected yet.'}</span>
          </div>
          <button type="button" disabled={launching || connected} onClick={() => void launchLeague()} className="btn-secondary flex items-center justify-center gap-2 px-3 py-2 text-xs disabled:opacity-40">
            {launching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
            {connected ? 'Client running' : 'Launch League'}
          </button>
        </div>

        <div className="space-y-4">
          <div className="space-y-3">
            <div className="flex flex-col gap-1.5 text-xs text-text-muted">
              <span className="font-semibold text-white">Queue</span>
              <QueuePicker
                value={prefs.selectedQueue}
                queues={queues}
                disabled={autoMode}
                onChange={(queueId) => update('selectedQueue', queueId)}
              />
            </div>

            {selectedNeedsRoles && <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-end">
              <label className="flex flex-col gap-1.5 text-xs text-text-muted">
                <span className="font-semibold text-white">Primary lane</span>
                <select value={prefs.primaryRole} onChange={(event) => update('primaryRole', event.target.value)} className="w-full px-3 py-2 rounded-xl bg-dark-card border border-white/10 text-white text-xs focus:outline-none" aria-label="Primary role" disabled={autoMode}>
                  {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value} className="bg-dark-card">{label}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-text-muted">
                <span className="font-semibold text-white">Secondary lane</span>
                <select value={prefs.secondaryRole} onChange={(event) => update('secondaryRole', event.target.value)} className="w-full px-3 py-2 rounded-xl bg-dark-card border border-white/10 text-white text-xs focus:outline-none" aria-label="Secondary role" disabled={autoMode}>
                  {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value} className="bg-dark-card">{label}</option>)}
                </select>
              </label>
            </div>}
            {!selectedNeedsRoles && <p className="text-[11px] text-text-dim">This mode does not use lane preferences.</p>}
          </div>
        </div>

        {!remoteClient && <div className="play-flow__launch-options" aria-label="Play mode">
          <div className="play-flow__segmented" role="group" aria-label="Queue control mode">
            <button type="button" className={flowMode === 'manual' && !autoMode ? 'is-selected' : ''} aria-pressed={flowMode === 'manual' && !autoMode} disabled={autoMode} onClick={() => setFlowMode('manual')}>
              <strong>Manual</strong><small>Start once; handle the draft yourself</small>
            </button>
            <button type="button" className={flowMode === 'full-auto' || autoMode ? 'is-selected' : ''} aria-pressed={flowMode === 'full-auto' || autoMode} disabled={autoMode} onClick={() => setFlowMode('full-auto')}>
              <strong>Full Auto</strong><small>Queue, ready check, pick, and ban</small>
            </button>
          </div>
          {(flowMode === 'full-auto' || autoMode) && <div className="play-flow__segmented play-flow__segmented--cycle" role="group" aria-label="Full Auto run length">
            <button type="button" className={cycleMode === 'single' ? 'is-selected' : ''} aria-pressed={cycleMode === 'single'} disabled={autoMode} onClick={() => setCycleMode('single')}><strong>One match</strong><small>Stop when the game launches</small></button>
            <button type="button" className={cycleMode === 'repeat' ? 'is-selected' : ''} aria-pressed={cycleMode === 'repeat'} disabled={autoMode} onClick={() => setCycleMode('repeat')}><strong>Repeat</strong><small>Continue until you stop it</small></button>
          </div>}
        </div>}

        <div className="play-flow__primary-row">
          <button
            type="button"
            disabled={acting !== '' || (!connected && !autoMode) || (!autoMode && queueStartBlocked)}
            onClick={() => void handlePrimaryAction()}
            className={`${autoMode ? 'btn-danger' : 'btn-primary'} play-flow__primary-action flex items-center justify-center gap-2 px-4 py-3 text-sm disabled:opacity-40`}
          >
            {acting === 'primary-start' || acting === 'runtime-stop' ? <Loader2 className="h-4 w-4 animate-spin" /> : autoMode ? <Square className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
            {autoMode ? 'Stop Full Auto' : isCustomSelection ? 'Start game' : 'Start queue'}
          </button>
          <div className={`play-flow__runtime-status is-${runtimeStatus.stage}`} role="status" aria-live="polite">
            <span className="play-flow__runtime-dot" aria-hidden="true" />
            <span><strong>{autoMode ? `${runtimeStatus.stage.replaceAll('-', ' ')} · ` : ''}</strong>{runtimeStatus.message}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1 play-flow__context-actions">
          {!autoMode && prefs.selectedQueue > 0 && phase !== 'Matchmaking' && phase !== 'ReadyCheck' && <button type="button" disabled={!connected || acting === 'lobby'} onClick={() => {
            const q = queues.find((queue) => queue.id === prefs.selectedQueue);
            const isCustom = isPracticeSelection || (!!q && String(q.category || '').trim().toLowerCase() === 'custom');
            const label = q?.name || `queue ${prefs.selectedQueue}`;
            const msg = isPracticeSelection ? 'Practice Tool lobby created. Use Start game when the lobby is ready.' : isCustom ? `Custom lobby created for ${label}.` : `Lobby created for ${label}.`;
            void runStep('lobby', () => createConfiguredLobby(prefs.selectedQueue, queues), msg);
          }} className="btn-secondary flex items-center gap-1.5 px-3 py-2.5 text-xs disabled:opacity-40">
            <Rocket className={`h-3.5 w-3.5 ${acting === 'lobby' ? 'animate-spin' : ''}`} /> Create lobby
          </button>}
          {!autoMode && phase === 'ReadyCheck' && <button type="button" disabled={!connected || acting === 'accept'} onClick={() => void runStep('accept', () => lcuAutoAccept(), 'Ready check accepted.')} className="btn-secondary flex items-center gap-1.5 px-3 py-2.5 text-xs disabled:opacity-40">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> Accept now
          </button>}
          {!autoMode && phase === 'Matchmaking' && <button type="button" disabled={!connected || acting === 'stop'} onClick={() => void runStep('stop', () => lcuStopQueue(), 'Queue stopped.')} className="btn-danger flex items-center gap-1.5 px-3 py-2.5 text-xs disabled:opacity-40" aria-label="Stop matchmaking queue">
            <CircleStop className={`h-3.5 w-3.5 ${acting === 'stop' ? 'animate-pulse' : ''}`} /> Stop queue
          </button>}
        </div>

        <p className="text-[11px] text-text-dim">{autoMode ? 'Queue and lane settings are frozen for this run. Stopping Full Auto will not cancel League matchmaking or dodge Champion Select.' : 'Queue, lane, and automation choices save automatically.'}</p>
      </section>

      {isCustomSelection && customDirectory && <section className="glass-card p-4 rounded-2xl play-flow__custom-directory" aria-labelledby="custom-directory-title"><div className="flex items-start justify-between gap-3"><div><span className="text-[10px] tracking-[0.14em] text-primary font-black">CUSTOM SESSIONS</span><h2 id="custom-directory-title" className="text-sm font-bold text-white mt-1">Browse custom games</h2><p className="text-xs text-text-muted mt-1">Join only after reviewing the lobby and slot count.</p></div><button type="button" className="btn-secondary text-xs" onClick={() => void refreshLCUCustomGames().then(setCustomDirectory).catch((reason: any) => showToast(reason?.message || 'Could not refresh custom games.', 'error'))}><RefreshCw className="w-3.5" /> Refresh</button></div><div className="space-y-2 mt-3">{customDirectory.invitations.map((invitation) => <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs"><span><strong className="text-white">Invitation from {invitation.senderName}</strong><small className="block text-text-muted">{invitation.restrictions.length ? invitation.restrictions.join(', ') : 'Ready to review'}</small></span><span className="flex gap-2"><button type="button" className="btn-secondary text-xs" disabled={!invitation.canAccept || acting !== ''} onClick={() => void (async () => { const preview = await previewExpandedReviewedOperation({ kind: 'lobby-invitation-accept', invitation: { invitationId: invitation.id } }); setCustomReview({ previewId: preview.id, kind: preview.kind, title: 'Accept lobby invitation', description: 'Accepting may replace your current lobby.', confirmation: preview.confirmation, targetCount: 1, targetLabels: [invitation.senderName] }); })()}>Accept</button><button type="button" className="btn-danger text-xs" disabled={acting !== ''} onClick={() => void actOnLCULobbyInvitation(invitation.id, 'decline').then(() => showToast('Invitation declined.', 'success')).catch((reason: any) => showToast(reason?.message || 'Could not decline invitation.', 'error'))}>Decline</button></span></div>)}{customDirectory.games.slice(0, 8).map((game) => <div key={game.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-black/20 p-3 text-xs"><span><strong className="text-white">{game.name || 'Custom game'}</strong><small className="block text-text-muted">{game.owner} · {game.players.filled}/{game.players.maximum} players · {game.passwordRequired ? 'Password required' : 'Open'}</small></span><span className="flex gap-2"><button type="button" className="btn-secondary text-xs" onClick={() => void reviewCustomJoin(game, true)}>Spectate</button><button type="button" className="btn-primary text-xs" onClick={() => void reviewCustomJoin(game, false)}>Join</button></span></div>)}{customDirectory.games.length === 0 && customDirectory.invitations.length === 0 && <p className="text-xs text-text-muted">No custom games or invitations are available.</p>}</div></section>}

      {configureOpen && !remoteClient && (
        <div className="play-flow__drawer-layer">
          <button type="button" className="play-flow__drawer-backdrop" aria-label="Close Configure dialog" onClick={() => setConfigureOpen(false)} />
          <aside ref={drawerRef} className="play-flow__drawer" role="dialog" aria-modal="true" aria-labelledby="configure-title">
            <header className="play-flow__drawer-header">
              <div>
                <span className="play-flow__drawer-eyebrow">AUTOMATION SETUP</span>
                <h2 id="configure-title" className="text-xl font-bold text-white">Configure</h2>
                <p className="mt-1 text-xs text-text-muted">Choose what RiftOps should do after you start.</p>
              </div>
              <button ref={drawerCloseRef} type="button" className="btn-icon" aria-label="Close Configure" onClick={() => setConfigureOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="play-flow__drawer-body">
              <details className="play-flow__drawer-section" open>
                <summary className="play-flow__drawer-section-summary">
                  <span className="play-flow__drawer-section-index">01</span>
                  <span className="play-flow__drawer-section-copy"><strong>Queue behavior</strong><small>What happens before the match starts.</small></span>
                  <span className="play-flow__drawer-section-state">{queueRuleSummary}</span>
                  <ChevronRight className="play-flow__drawer-chevron" aria-hidden="true" />
                </summary>
                <div className="play-flow__drawer-section-body">
                  <div className={`play-flow__automation-hint ${autoMode ? 'is-active' : ''}`} role="status" aria-live="polite">
                    <span className="play-flow__automation-hint-dot" aria-hidden="true" />
                    <span>{autoMode ? 'Full auto is running queue and draft actions. Ready checks follow the background rule.' : 'Full auto is paused. Ready checks still follow their saved background rule.'}</span>
                  </div>
                  <div className="play-flow__switch-list">
                    <div className={`play-flow__dependent-setting ${prefs.autoAccept ? 'is-enabled' : ''}`}>
                      <SwitchRow label="Auto-accept ready checks" description={prefs.autoAccept ? 'Background automation applies the saved delay.' : 'Accept ready checks manually.'} checked={prefs.autoAccept} onChange={(checked) => update('autoAccept', checked)} />
                      <div className="play-flow__dependent-controls" aria-label="Auto-accept timing">
                        <label className="play-flow__number-field"><span>Delay</span><span className="play-flow__number-input"><input type="number" min="0" max={MAX_AUTO_ACCEPT_DELAY_SECONDS} step="1" value={prefs.autoAcceptDelaySeconds} onChange={(event) => update('autoAcceptDelaySeconds', Math.max(0, Math.min(MAX_AUTO_ACCEPT_DELAY_SECONDS, Math.trunc(Number(event.target.value) || 0))))} aria-label="Auto-accept delay in seconds" disabled={!prefs.autoAccept} /><small>sec</small></span></label>
                        <SwitchRow label="Random delay" description="Vary the delay by up to the selected time." checked={prefs.autoAcceptRandomDelay} onChange={(checked) => update('autoAcceptRandomDelay', checked)} disabled={!prefs.autoAccept} />
                      </div>
                    </div>
                  </div>
                </div>
              </details>

              <details className="play-flow__drawer-section">
                <summary className="play-flow__drawer-section-summary">
                  <span className="play-flow__drawer-section-index">02</span>
                  <span className="play-flow__drawer-section-copy"><strong>Champion select</strong><small>Pick, ban, and lock choices during draft.</small></span>
                  <span className="play-flow__drawer-section-state">{draftRuleSummary}</span>
                  <ChevronRight className="play-flow__drawer-chevron" aria-hidden="true" />
                </summary>
                <div className="play-flow__drawer-section-body">
                  <div className="play-flow__switch-list">
                    <SwitchRow label="Auto-pick" description={hasPickPlan ? 'Choose your configured champion.' : 'Choose a champion after you set a pick plan.'} checked={prefs.autoPick} onChange={(checked) => update('autoPick', checked)} />
                    {!isArenaSelection && !isARAMSelection && <SwitchRow label="Auto-ban" description={hasBanPlan ? 'Ban your configured target.' : 'Ban a target after you set a ban plan.'} checked={prefs.autoBan} onChange={(checked) => update('autoBan', checked)} />}
                    {!isArenaSelection && !isARAMSelection && selectedNeedsRoles && <SwitchRow label="Role-aware picks" description={prefs.roleAwarePicks ? `${configuredRolePlans}/5 lane plans configured. Fill waits for League to assign a lane.` : 'Use a lane-specific pick and fallback instead of one global pick plan.'} checked={prefs.roleAwarePicks} onChange={(checked) => update('roleAwarePicks', checked)} />}
                    {!isArenaSelection && !isARAMSelection && <SwitchRow label="Auto-swap pick order" description="During Full Auto, request a teammate's pick turn. They must accept." checked={prefs.autoPickOrderToLast} onChange={(checked) => update('autoPickOrderToLast', checked)} />}
                    {!isArenaSelection && !isARAMSelection && prefs.autoPickOrderToLast && (
                      <label className="play-flow__pick-order-target">
                        <span><strong>Target pick</strong><small>Choose the teammate turn RiftOps should request.</small></span>
                        <select value={prefs.autoPickOrderTarget} onChange={(event) => update('autoPickOrderTarget', event.target.value as PickOrderSwapTarget)} aria-label="Pick-order swap target">
                          <option value="latest">Latest teammate pick</option>
                          <option value="pick-1">Pick 1</option>
                          <option value="pick-2">Pick 2</option>
                          <option value="pick-3">Pick 3</option>
                          <option value="pick-4">Pick 4</option>
                          <option value="pick-5">Pick 5</option>
                        </select>
                      </label>
                    )}
                    {!isArenaSelection && !isARAMSelection && <SwitchRow label="Instant lock" description="Lock the selected champion without the hover delay." checked={prefs.instantLock} onChange={(checked) => update('instantLock', checked)} />}
                    {!isArenaSelection && !isARAMSelection && <SwitchRow label="Role Quest loadout" description={!selectedRoleQuestSpells ? 'No recommended loadout is available for this lane.' : champSelectLive && detectedRole !== 'TOP' ? 'Waiting for League to assign the Top lane.' : 'Apply the recommended spells for your assigned role.'} checked={prefs.autoRoleQuestLoadout} onChange={(checked) => update('autoRoleQuestLoadout', checked)} disabled={!selectedRoleQuestSpells || (champSelectLive && detectedRole !== 'TOP')} />}
                  </div>
                  {isArenaSelection && <ArenaPriorityEditor items={prefs.arenaPickPriority} champions={champions} version={version} onChange={(items) => update('arenaPickPriority', items)} />}
                  {isARAMSelection && <ARAMPriorityEditor championIDs={prefs.aramChampionPriority} champions={champions} version={version} onChange={(ids) => update('aramChampionPriority', ids)} />}
                  {isArenaSelection && <p className="play-flow__mode-note"><Sparkles className="h-4 w-4" />{selectedArenaEvent}. Arena priorities execute immediately after League validates the live choice pool.</p>}
                  {isARAMSelection && <p className="play-flow__mode-note"><ShieldCheck className="h-4 w-4" />Traditional ARAM keeps League's assigned champion. RiftOps only improves from cards or the bench and never spends rerolls.</p>}
                {!isArenaSelection && !isARAMSelection && <details className="play-flow__drawer-subsection">
                  <summary>
                    <GitBranch className="w-4 h-4" />
                    <span><strong>Pick &amp; ban plan</strong><small>Primary and fallback champions, timing, runes, build plan, and retry status.</small></span>
                    <ChevronRight className="play-flow__drawer-chevron w-4 h-4" aria-hidden="true" />
                  </summary>
                  <div className="play-flow__drawer-subsection-body space-y-4">


          {/* Pick & Ban Preferences */}
          <div className="space-y-4 pt-3 border-t border-white/5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-bold text-white">
                <GitBranch className="w-3.5 h-3.5 text-primary" />
                <span>Pick & Ban Preferences</span>
              </div>
              <small className="text-[11px] text-text-dim">RiftOps checks live bans and teammate hovers before acting.</small>
            </div>

            <div className="play-flow__pick-ban-grid grid grid-cols-1 gap-5">
              {/* Left: Pick path */}
              <section className="play-flow__pick-ban-path space-y-3 p-4 rounded-xl bg-dark-bg/40 border border-white/5">
                <div className="flex items-center justify-between">
                  <strong className="text-xs font-bold text-white">{prefs.roleAwarePicks ? `${roleLabel(rolePlanEditorRole)} pick path` : 'Pick Path'}</strong>
                  <small className="text-[10px] text-text-dim">Primary champion + fallback</small>
                </div>

                {prefs.roleAwarePicks && (
                  <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <strong className="text-xs text-white">Lane profiles</strong>
                        <p className="mt-1 text-[11px] text-text-muted">League resolves Fill to a real lane before RiftOps picks. Unknown lanes stay manual.</p>
                      </div>
                      <span className="text-[10px] text-primary">{configuredRolePlans}/5 ready</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Role pick profiles">
                      {PICK_ROLES.map((role) => {
                        const configured = Boolean(rolePickPlanFor(role, prefs.rolePickPlans)?.pickChampionId || rolePickPlanFor(role, prefs.rolePickPlans)?.fallbackPickChampionId);
                        return <button key={role} type="button" role="tab" aria-selected={rolePlanEditorRole === role} onClick={() => setRolePlanEditorRole(role)} className={`rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors ${rolePlanEditorRole === role ? 'border-primary/60 bg-primary/15 text-white' : 'border-white/10 text-text-muted hover:border-primary/30'} ${configured ? '' : 'opacity-70'}`}>{roleLabel(role)}{configured ? ' · ready' : ''}</button>;
                      })}
                    </div>
                  </div>
                )}

                {isArenaSelection && (
                  <div className="flex items-center gap-2 p-2.5 rounded-xl bg-primary/10 border border-primary/20 text-xs text-primary">
                    <Sparkles className="w-3.5 h-3.5 shrink-0" />
                    <span>{selectedArenaEvent}. Champion grid uses League’s live Arena choice pool.</span>
                  </div>
                )}

                <div className="play-flow__champion-picker-grid grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <ChampionPicker value={editorPickChampionId} query={pickQuery} onQuery={setPickQuery} onSelect={(id) => prefs.roleAwarePicks ? updateRolePickPlan('pickChampionId', id) : update('pickChampionId', id)} label="Primary pick" version={version} champions={champions} />
                  <ChampionPicker value={editorFallbackPickChampionId} query={fallbackPickQuery} onQuery={setFallbackPickQuery} onSelect={(id) => prefs.roleAwarePicks ? updateRolePickPlan('fallbackPickChampionId', id) : update('fallbackPickChampionId', id)} label="Fallback pick" version={version} champions={champions} />
                </div>

                <TimingControl label="Pick timing" mode={prefs.pickTimingMode} seconds={prefs.pickTimingSeconds} onMode={(value) => update('pickTimingMode', value)} onSeconds={(value) => update('pickTimingSeconds', value)} />

                <div className="space-y-2 p-3 rounded-xl bg-dark-bg/50 border border-white/5">
                  <label className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 text-text-muted">
                      <BookOpen className="w-3.5 h-3.5 text-primary" /> Primary runes
                    </span>
                    <select value={editorPickRunePageId} onChange={(event) => prefs.roleAwarePicks ? updateRolePickPlan('pickRunePageId', Number(event.target.value)) : update('pickRunePageId', Number(event.target.value))} disabled={!editableRunePages.length} aria-label="Rune page for the primary pick" className="px-2 py-1 rounded-lg bg-dark-card border border-white/10 text-white text-xs focus:outline-none">
                      <option value="0">Keep current page</option>
                      {editableRunePages.map((page) => <option key={page.id} value={page.id}>{page.name || `Rune page ${page.id}`}</option>)}
                    </select>
                  </label>

                  <label className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 text-text-muted">
                      <GitBranch className="w-3.5 h-3.5 text-text-dim" /> Fallback runes
                    </span>
                    <select value={editorFallbackPickRunePageId} onChange={(event) => prefs.roleAwarePicks ? updateRolePickPlan('fallbackPickRunePageId', Number(event.target.value)) : update('fallbackPickRunePageId', Number(event.target.value))} disabled={!editableRunePages.length} aria-label="Rune page for the fallback pick" className="px-2 py-1 rounded-lg bg-dark-card border border-white/10 text-white text-xs focus:outline-none">
                      <option value="0">Use primary runes</option>
                      {editableRunePages.map((page) => <option key={page.id} value={page.id}>{page.name || `Rune page ${page.id}`}</option>)}
                    </select>
                  </label>

                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/5 text-xs">
                    <span className="text-text-muted truncate">
                      Active: <strong className="text-white">{currentRunePage?.name || 'None'}</strong>
                    </span>
                    <button type="button" onClick={() => setRuneEditorOpen(true)} disabled={!currentRunePage || currentRunePage.isEditable === false} className="btn-secondary px-2.5 py-1 text-xs flex items-center gap-1">
                      <Pencil className="w-3 h-3" /> Edit runes
                    </button>
                  </div>
                </div>

                <BuildPlanner
                  championId={editorPickChampionId}
                  championName={champions[editorPickChampionId]?.name || ''}
                  fallbackChampionId={editorFallbackPickChampionId}
                  fallbackChampionName={champions[editorFallbackPickChampionId]?.name || ''}
                  role={prefs.roleAwarePicks ? rolePlanEditorRole : detectedRole || prefs.primaryRole}
                  onNotice={showToast}
                  onPlanSaved={setSavedBuildPlan}
                />
              </section>

              {/* Right: Ban path */}
              <section className="play-flow__pick-ban-path space-y-3 p-4 rounded-xl bg-dark-bg/40 border border-white/5 flex flex-col">
                <div className="flex items-center justify-between">
                  <strong className="text-xs font-bold text-white">Ban Path</strong>
                  <small className="text-[10px] text-text-dim">Primary ban + fallback</small>
                </div>

                <div className="play-flow__champion-picker-grid grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <ChampionPicker value={prefs.banChampionId} query={banQuery} onQuery={setBanQuery} onSelect={(id) => update('banChampionId', id)} label="Primary ban" version={version} champions={champions} />
                  <ChampionPicker value={prefs.fallbackBanChampionId} query={fallbackBanQuery} onQuery={setFallbackBanQuery} onSelect={(id) => update('fallbackBanChampionId', id)} label="Fallback ban" version={version} champions={champions} />
                </div>

                <TimingControl label="Ban timing" mode={prefs.banTimingMode} seconds={prefs.banTimingSeconds} onMode={(value) => update('banTimingMode', value)} onSeconds={(value) => update('banTimingSeconds', value)} />
              </section>
            </div>
          </div>

          <div className="play-flow__mode-note" role="status" aria-live="polite">
            <ShieldCheck className="h-4 w-4" />
            <span>{runtimeStatus.message}</span>
          </div>
          </div>
        </details>}
                </div>
              </details>

              <details className="play-flow__drawer-section">
                <summary className="play-flow__drawer-section-summary">
                  <span className="play-flow__drawer-section-index">03</span>
                  <span className="play-flow__drawer-section-copy"><strong>Preparation</strong><small>Presets, runes, build plans, and helpers.</small></span>
                  <span className="play-flow__drawer-section-state">Ready when you are</span>
                  <ChevronRight className="play-flow__drawer-chevron" aria-hidden="true" />
                </summary>
                <div className="play-flow__drawer-section-body">

      <details className="play-flow__drawer-subsection">
        <summary><BookOpen className="w-4 h-4" /><span><strong>Presets</strong><small>Save or apply a lobby, rune, spell, and item setup.</small></span><ChevronRight className="play-flow__drawer-chevron w-4 h-4" aria-hidden="true" /></summary>
        <div className="play-flow__drawer-subsection-body">
          <PreparationPanel
            connected={connected}
            remoteClient={remoteClient}
            queueId={prefs.selectedQueue}
            queue={selectedQueue}
            firstRole={prefs.primaryRole}
            secondRole={prefs.secondaryRole}
            championId={prefs.pickChampionId}
            runePageId={prefs.pickRunePageId}
            fallbackRunePageId={prefs.fallbackPickRunePageId}
            runePages={availableRunePages}
            itemIds={savedBuildPlan?.championId === prefs.pickChampionId ? savedBuildPlan.itemIds : []}
            onPreparationApplied={(preset) => {
              setPrefs((current) => ({
                ...current,
                pickChampionId: preset.championId || current.pickChampionId,
                pickRunePageId: preset.runePageId || current.pickRunePageId,
                fallbackPickRunePageId: preset.fallbackRunePageId || current.fallbackPickRunePageId,
              }));
              if (preset.championId && preset.itemIds?.length) setSavedBuildPlan({ championId: preset.championId, role: preset.role || '', itemIds: preset.itemIds, updatedAt: new Date().toISOString() });
            }}
            onToast={showToast}
          />
        </div>
      </details>

      <details className="play-flow__drawer-subsection">
        <summary>
          <ShieldCheck className="w-4 h-4" />
          <span><strong>Role Quest helper</strong><small>{roleQuestWaitingForAssignment ? 'Waiting for League to assign a lane.' : selectedRoleQuest ? `${selectedRoleQuest.label} lane · ${selectedRoleQuest.progress} to unlock reward.` : 'Preview the League-owned role quest for your lane.'}</small></span>
          <ChevronRight className="play-flow__drawer-chevron w-4 h-4" aria-hidden="true" />
        </summary>
        <div className="play-flow__drawer-subsection-body space-y-4" aria-labelledby="role-quest-title">
          <div>
            <h3 id="role-quest-title" className="text-base font-bold text-white">Role Quest Assistant</h3>
            <p className="text-xs text-text-muted mt-1">League owns the quest assignment; RiftOps only applies the recommended loadout when available.</p>
          </div>

        {selectedRoleQuest ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-3.5 rounded-xl bg-dark-bg/50 border border-white/5">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase text-text-dim tracking-wider">Reward</span>
              <strong className="text-xs font-bold text-white">{selectedRoleQuest.reward}</strong>
              <small className="text-[11px] text-text-muted">{selectedRoleQuest.details}</small>
            </div>
            <div className="flex flex-col justify-between gap-2">
              <p className="text-xs text-text-muted">{selectedRoleQuest.assistant}</p>
              {selectedRoleQuestSpells ? (
                <button
                  type="button"
                  disabled={!champSelectLive || acting === 'role-quest' || detectedRole !== 'TOP'}
                  onClick={() => void (async () => {
                    const applied = await applyRoleQuestLoadout(true);
                    if (applied) roleLoadoutRef.current = 'manual';
                  })()}
                  className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-xs w-fit disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${acting === 'role-quest' ? 'animate-spin' : ''}`} />
                  {champSelectLive && detectedRole === 'TOP' ? 'Apply Flash + Teleport' : champSelectLive ? 'Waiting for Top assignment' : 'Available in Champ Select'}
                </button>
              ) : (
                <span className="text-xs text-text-dim italic">No RiftOps loadout change is needed for this role.</span>
              )}
            </div>
          </div>
        ) : roleQuestWaitingForAssignment ? (
          <p className="text-xs text-text-dim italic p-3 rounded-xl bg-dark-bg/40 border border-white/5">
            Waiting for League to assign a concrete lane before showing a role quest recommendation.
          </p>
        ) : (
          <p className="text-xs text-text-dim italic p-3 rounded-xl bg-dark-bg/40 border border-white/5">
            Role quests are assigned by League from your queued position. Fill and custom modes may not receive the lane quest.
          </p>
        )}
        </div>
      </details>

                </div>
              </details>
            </div>
            <footer className="play-flow__drawer-footer">
              <span className={`play-flow__save-state is-${prefsSaveState}`} role="status" aria-live="polite">
                <span className="play-flow__saved-dot" aria-hidden="true" />
                {prefsSaveState === 'saving' ? 'Saving queue automation…' : prefsSaveState === 'local' ? 'Saved locally · League sync unavailable' : 'Changes saved automatically'}
              </span>
              <button type="button" className="btn-primary px-4 py-2 text-xs" onClick={() => setConfigureOpen(false)}>Done</button>
            </footer>
          </aside>
        </div>
      )}
      <ReviewOperationModal operation={customReview} onClose={() => setCustomReview(null)} onConfirm={confirmCustomReview} />

      {!remoteClient && (
        <RunePageEditor
          open={runeEditorOpen}
          page={currentRunePage}
          onClose={() => setRuneEditorOpen(false)}
          onSaved={async (updated) => {
            setRunePages((pages) => pages.map((page) => page.id === updated.id ? updated : page));
            showToast(`${updated.name} saved to League.`, 'success');
          }}
        />
      )}
    </div>
  );
}
