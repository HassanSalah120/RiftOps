import { isArenaQueue, type ArenaQueueLike } from './arenaBravery.ts';

export type ArenaEventKey = 'standard' | 'bravery' | 'crowd-favorites' | 'three-by-six' | 'swift' | 'unknown';

export type ArenaAugment = {
  id?: number;
  name: string;
  description?: string;
  tier?: string;
};

export type ArenaTelemetry = {
  isArena: boolean;
  event: ArenaEventKey;
  eventLabel: string;
  round: number | null;
  placement: number | null;
  teamsRemaining: number | null;
  fame: number | null;
  fameDelta: number | null;
  partnerName: string;
  augments: ArenaAugment[];
  source: string;
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = numberValue(value);
  return number !== null && number > 0 ? number : null;
}

function textValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function firstValue(sources: RecordValue[], keys: string[]): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
  }
  return undefined;
}

function eventSources(source: RecordValue): RecordValue[] {
  const raw = source.events;
  if (Array.isArray(raw)) return raw.map(record).filter((entry) => Object.keys(entry).length > 0).reverse();
  const container = record(raw);
  const values = Array.isArray(container.Events) ? container.Events : Array.isArray(container.events) ? container.events : [];
  return values.map(record).filter((entry) => Object.keys(entry).length > 0).reverse();
}

function queueFrom(source: RecordValue): ArenaQueueLike {
  const gameData = record(source.gameData);
  const queue = record(source.queue);
  return {
    id: numberValue(firstValue([source, gameData, queue], ['queueId', 'gameQueueConfigId', 'queueID'])) ?? undefined,
    gameMode: textValue(firstValue([source, gameData, queue], ['gameMode', 'mode', 'gameType'])),
    name: textValue(firstValue([source, gameData, queue], ['queueName', 'name'])),
    description: textValue(firstValue([source, gameData, queue], ['queueDescription', 'description'])),
  };
}

export function arenaEventKey(source: ArenaQueueLike | unknown): ArenaEventKey {
  const value = record(source);
  const queue = typeof source === 'number' ? source : (Object.keys(value).length ? queueFrom(value) : source as ArenaQueueLike);
  if (!isArenaQueue(queue)) return 'unknown';
  const text = [
    textValue(value.event), textValue(value.eventName), textValue(value.eventKey),
    textValue(value.queueName), textValue(value.name), textValue(value.description),
  ].join(' ').toUpperCase();
  if (/BRAVERY|BRAVE/.test(text)) return 'bravery';
  if (/CROWD.?FAVORITE|FAVORITE/.test(text)) return 'crowd-favorites';
  if (/3X6|THREE.?BY.?SIX|3.?BY.?6/.test(text)) return 'three-by-six';
  if (/SWIFT/.test(text)) return 'swift';
  return 'standard';
}

export function arenaEventLabel(event: ArenaEventKey): string {
  switch (event) {
    case 'bravery': return 'Bravery event';
    case 'crowd-favorites': return 'Crowd Favorites';
    case 'three-by-six': return '3 × 6 Arena';
    case 'swift': return 'Swift Arena';
    case 'standard': return 'Standard Arena';
    default: return 'Arena event unavailable';
  }
}

function augmentValues(sources: RecordValue[]): unknown[] {
  const values: unknown[] = [];
  for (const source of sources) {
    for (const key of ['augments', 'arenaAugments', 'activeAugments', 'selectedAugments', 'augmentChoices']) {
      if (Array.isArray(source[key])) values.push(...source[key] as unknown[]);
    }
  }
  return values;
}

export function normalizeArenaAugments(source: unknown): ArenaAugment[] {
  const root = record(source);
  const sources = [root, record(root.arena), record(root.arenaData), record(root.gameData), record(root.activePlayer), record(root.participant), record(root.challenges), ...eventSources(root)];
  const seen = new Set<string>();
  const result: ArenaAugment[] = [];
  for (const value of augmentValues(sources)) {
    const entry = record(value);
    const id = positiveNumber(entry.id ?? entry.augmentId ?? entry.cardId);
    const name = textValue(entry.name ?? entry.displayName ?? entry.title ?? entry.rawName) || (id ? `Augment ${id}` : textValue(value));
    if (!name) continue;
    const key = `${id || ''}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...(id ? { id } : {}),
      name,
      ...(textValue(entry.description ?? entry.shortDescription) ? { description: textValue(entry.description ?? entry.shortDescription) } : {}),
      ...(textValue(entry.tier ?? entry.rarity) ? { tier: textValue(entry.tier ?? entry.rarity) } : {}),
    });
  }
  return result.slice(0, 8);
}

export function normalizeArenaTelemetry(source: unknown): ArenaTelemetry {
  const root = record(source);
  const gameData = record(root.gameData);
  const arena = record(root.arena ?? gameData.arena ?? root.arenaData);
  const participant = record(root.participant ?? root.activePlayer);
  const challenges = record(root.challenges ?? participant.challenges);
  const recentEvents = eventSources(root);
  const queue = queueFrom({ ...root, ...gameData, ...arena });
  const sources = [arena, challenges, participant, gameData, ...recentEvents, root];
  const isArena = isArenaQueue(queue) || Number(firstValue(sources, ['mapId', 'mapNumber'])) === 30;
  const event = arenaEventKey({ ...(recentEvents[0] || {}), ...root, ...gameData, ...arena });
  const round = positiveNumber(firstValue(sources, ['round', 'roundNumber', 'currentRound', 'arenaRound', 'roundIndex']))
    || positiveNumber(firstValue(sources, ['stage', 'stageNumber']));
  const placement = positiveNumber(firstValue(sources, ['placement', 'finalPlacement', 'arenaPlacement', 'rank', 'position']));
  const teamsRemaining = positiveNumber(firstValue(sources, ['teamsRemaining', 'remainingTeams', 'teamCount']));
  const fame = numberValue(firstValue(sources, ['fame', 'arenaFame', 'totalFame', 'fameTotal']));
  const fameDelta = numberValue(firstValue(sources, ['fameDelta', 'fameEarned', 'fameGain']));
  const partnerName = textValue(firstValue(sources, ['partnerName', 'partner', 'allyName', 'duoName']));
  return {
    isArena,
    event: isArena ? event : 'unknown',
    eventLabel: isArena ? arenaEventLabel(event) : 'Not an Arena match',
    round,
    placement,
    teamsRemaining,
    fame,
    fameDelta,
    partnerName,
    augments: normalizeArenaAugments({ ...root, ...arena, ...participant, challenges, events: recentEvents }),
    source: textValue(firstValue(sources, ['source', 'dataSource'])) || 'League data',
  };
}

export function normalizeArenaMatch(match: unknown, puuid = ''): ArenaTelemetry {
  const root = record(match);
  const info = record(root.info);
  const source = Object.keys(info).length ? info : root;
  const participants = Array.isArray(source.participants) ? source.participants as unknown[] : [];
  const local = participants.find((entry) => textValue(record(entry).puuid) === puuid) || participants[0] || {};
  const participant = record(local);
  return normalizeArenaTelemetry({
    gameData: source,
    participant,
    challenges: participant.challenges,
    arena: record(source.arena ?? participant.arena ?? root.arena),
    source: textValue(root._source) || (Object.keys(info).length ? 'Riot Match-V5' : 'League match history'),
  });
}
