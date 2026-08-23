import type { Release, Snapshot } from './types';

type JsonCacheEntry = { expiresAt: number; value: unknown };
const jsonCache = new Map<string, JsonCacheEntry>();
const jsonInflight = new Map<string, Promise<unknown>>();
const JSON_CACHE_PREFIX = 'riftops.apiCache.';

export function clearCachedJSON() {
  jsonCache.clear();
  try {
    Object.keys(localStorage).filter((key) => key.startsWith(JSON_CACHE_PREFIX)).forEach((key) => localStorage.removeItem(key));
  } catch { /* Optional persistent cache. */ }
}

async function fetchCachedJSON<T>(path: string, ttlMs: number): Promise<T> {
  const cached = jsonCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  try {
    const persisted = localStorage.getItem(`${JSON_CACHE_PREFIX}${path}`);
    if (persisted) {
      const entry = JSON.parse(persisted) as JsonCacheEntry;
      if (entry.expiresAt > Date.now()) {
        jsonCache.set(path, entry);
        return entry.value as T;
      }
      localStorage.removeItem(`${JSON_CACHE_PREFIX}${path}`);
    }
  } catch { /* Corrupt or unavailable storage should not block a network read. */ }
  const pending = jsonInflight.get(path);
  if (pending) return pending as Promise<T>;
  const request = (async () => {
    const res = await fetch(path);
    if (!res.ok) throw new Error((await res.text()) || `Request failed: ${path}`);
    const value = await res.json() as T;
    const entry = { value, expiresAt: Date.now() + ttlMs };
    jsonCache.set(path, entry);
    try { localStorage.setItem(`${JSON_CACHE_PREFIX}${path}`, JSON.stringify(entry)); } catch { /* Cache is best-effort. */ }
    return value;
  })();
  jsonInflight.set(path, request);
  try {
    return await request;
  } finally {
    jsonInflight.delete(path);
  }
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch('/api/snapshot');
  if (!res.ok) throw new Error('Failed to fetch current state');
  return res.json();
}

export async function toggleMasking(enabled: boolean): Promise<void> {
  const res = await fetch('/api/set-enabled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function setStatus(status: string): Promise<void> {
  const res = await fetch('/api/set-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function launchGame(game: string, stopExisting = false): Promise<void> {
  const res = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game, stopExisting }),
  });
  if (!res.ok) throw new Error((await res.text()).trim() || `Launch request failed (${res.status})`);
}

export async function stopEngine(): Promise<void> {
  const res = await fetch('/api/stop', { method: 'POST' });
  if (!res.ok) throw new Error(await res.text());
}

export async function checkUpdate(): Promise<{ available: boolean; release?: Release }> {
  const res = await fetch('/api/check-update');
  if (!res.ok) return { available: false };
  return res.json();
}

export interface Preferences {
  game: string;
  startupStatus: string;
  connectToMUC: boolean;
  checkUpdates: boolean;
  riotClientPath: string;
}

export async function fetchPreferences(): Promise<Preferences> {
  const res = await fetch('/api/preferences');
  if (!res.ok) throw new Error('Failed to load preferences');
  return res.json();
}

export async function savePreferences(prefs: Preferences): Promise<void> {
  const res = await fetch('/api/save-preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prefs),
  });
  if (!res.ok) throw new Error(await res.text());
}

export interface RiotClientLocation {
  path: string;
  source: 'configured' | 'detected' | 'browse' | 'automatic' | 'not-found';
}

async function locationResponse(res: Response): Promise<RiotClientLocation> {
  if (!res.ok) throw new Error((await res.text()).trim() || 'Riot Client location request failed');
  return res.json();
}

export function fetchRiotClientLocation(): Promise<RiotClientLocation> {
  return fetch('/api/riot-client-location').then(locationResponse);
}

export function saveRiotClientLocation(path: string): Promise<RiotClientLocation> {
  return fetch('/api/riot-client-location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }).then(locationResponse);
}

export function detectRiotClientLocation(): Promise<RiotClientLocation> {
  return fetch('/api/riot-client-location/detect', { method: 'POST' }).then(locationResponse);
}

export function browseRiotClientLocation(): Promise<RiotClientLocation> {
  return fetch('/api/riot-client-location/browse', { method: 'POST' }).then(locationResponse);
}

export function clearRiotClientLocation(): Promise<RiotClientLocation> {
  return fetch('/api/riot-client-location', { method: 'DELETE' }).then(locationResponse);
}

export async function quitApp(): Promise<void> {
  await fetch('/api/quit', { method: 'POST' });
}

export interface RemoteAccessStatus {
  enabled: boolean;
  remote?: boolean;
  client?: 'desktop' | 'phone';
  capabilities?: string[];
  pairingAvailable?: boolean;
  url?: string;
  displayUrl?: string;
  port?: number;
  expiresAt?: string;
  sessionExpiresInSeconds?: number;
  sessions?: Array<{ id: string; device: string; createdAt: string; lastSeen: string; expiresAt: string }>;
}

export async function fetchRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  const response = await fetch('/api/remote/status', { cache: 'no-store' });
  if (!response.ok) throw new Error((await response.text()).trim() || 'Phone control is unavailable');
  return response.json();
}

export async function rotateRemoteAccess(): Promise<RemoteAccessStatus> {
  const response = await fetch('/api/remote/rotate', { method: 'POST', cache: 'no-store' });
  if (!response.ok) throw new Error((await response.text()).trim() || 'Could not regenerate pairing access');
  return response.json();
}

export async function setRemoteAccessEnabled(enabled: boolean): Promise<RemoteAccessStatus> {
  const response = await fetch('/api/remote/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error((await response.text()).trim() || 'Could not change phone access');
  return response.json();
}

export async function revokeRemoteSession(id: string): Promise<RemoteAccessStatus> {
  const response = await fetch('/api/remote/sessions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), cache: 'no-store' });
  if (!response.ok) throw new Error((await response.text()).trim() || 'Could not revoke phone session');
  return response.json();
}

export async function revokeAllRemoteSessions(): Promise<RemoteAccessStatus> {
  const response = await fetch('/api/remote/sessions/revoke-all', { method: 'POST', cache: 'no-store' });
  if (!response.ok) throw new Error((await response.text()).trim() || 'Could not revoke phone sessions');
  return response.json();
}

export async function getAutostart(): Promise<{ enabled: boolean }> {
  const res = await fetch('/api/autostart');
  if (!res.ok) throw new Error('Failed to get autostart status');
  return res.json();
}

export async function setAutostart(enabled: boolean): Promise<void> {
  const res = await fetch('/api/set-autostart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(await res.text());
}

// ---------------------------------------------------------------------------
// Riot Dev API
// ---------------------------------------------------------------------------

export interface RiotAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface RiotSummoner {
  id: string;
  accountId: string;
  puuid: string;
  profileIconId: number;
  revisionDate: number;
  summonerLevel: number;
}

export interface RiotChampionMastery {
  championId: number;
  championLevel: number;
  championPoints: number;
  lastPlayTime: number;
  chestGranted: boolean;
  tokensEarned: number;
}

export interface RiotLeagueEntry {
  leagueId: string;
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  miniSeries?: { target: number; wins: number; losses: number; progress: string };
}

export interface RiotCurrentGame {
  gameId: number;
  gameType: string;
  gameStartTime: number;
  gameLength: number;
  gameMode: string;
  mapId: number;
  participants: Array<{
    puuid: string;
    summonerId: string;
    championId: number;
    teamId: number;
    profileIcon: number;
    summonerName: string;
  }>;
}

export function isRiotConfigured(): Promise<{ configured: boolean }> {
  return fetch('/api/riot/configured').then((r) => r.json());
}

export function fetchRiotAccount(region: string, gameName: string, tagLine: string): Promise<RiotAccount> {
  return fetch(`/api/riot/account?region=${encodeURIComponent(region)}&gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine)}`).then((r) => {
    if (!r.ok) throw new Error('Account not found');
    return r.json();
  });
}

export function fetchRiotSummoner(region: string, puuid: string): Promise<RiotSummoner> {
  return fetch(`/api/riot/summoner?region=${encodeURIComponent(region)}&puuid=${encodeURIComponent(puuid)}`).then((r) => {
    if (!r.ok) throw new Error('Summoner not found');
    return r.json();
  });
}

export function fetchRiotMastery(region: string, puuid: string, count = 6): Promise<RiotChampionMastery[]> {
  return fetch(`/api/riot/mastery?region=${encodeURIComponent(region)}&puuid=${encodeURIComponent(puuid)}&count=${count}`).then((r) => {
    if (!r.ok) throw new Error('Mastery not found');
    return r.json();
  });
}

export function fetchRiotLeague(region: string, summonerId: string): Promise<RiotLeagueEntry[]> {
  return fetch(`/api/riot/league?region=${encodeURIComponent(region)}&summonerId=${encodeURIComponent(summonerId)}`).then((r) => {
    if (!r.ok) throw new Error('League data not found');
    return r.json();
  });
}

export function fetchRiotCurrentGame(region: string, puuid: string): Promise<RiotCurrentGame> {
  return fetch(`/api/riot/current-game?region=${encodeURIComponent(region)}&puuid=${encodeURIComponent(puuid)}`).then((r) => {
    if (!r.ok) throw new Error('Not in game');
    return r.json();
  });
}

// ---------------------------------------------------------------------------
// Data Dragon
// ---------------------------------------------------------------------------

export function fetchDDragonVersion(): Promise<{ version: string }> {
  return fetchCachedJSON('/api/ddragon/version', 6 * 60 * 60 * 1000);
}

export interface DDChampion {
  id: string;
  key: string;
  name: string;
  title: string;
  blurb: string;
  tags: string[];
  image: { full: string; sprite: string; group: string };
}

export interface DDChampionList {
  data: Record<string, DDChampion>;
}

export function fetchDDChampions(): Promise<DDChampionList> {
  return fetchCachedJSON('/api/ddragon/champions', 24 * 60 * 60 * 1000);
}

export interface DDProfileIcon {
  id: number;
  image: { full: string; sprite: string; group: string };
  name: string;
  lcuImagePath?: string;
}

export interface DDProfileIconList {
  data: Record<string, DDProfileIcon>;
}

export function fetchDDProfileIcons(): Promise<DDProfileIconList> {
  return fetchCachedJSON('/api/ddragon/profile-icons', 24 * 60 * 60 * 1000);
}

export interface LCUProfileIconMetadata {
  id: number;
  title?: string;
  yearReleased?: number;
  isLegacy?: boolean;
  imagePath?: string;
}

export function fetchLCUProfileIconMetadata(): Promise<LCUProfileIconMetadata[]> {
  return fetchCachedJSON<unknown>('/api/lcu/profile-icons', 6 * 60 * 60 * 1000).then((data) => Array.isArray(data) ? data as LCUProfileIconMetadata[] : []);
}

export interface LCUProfileIconInventory {
  iconIds: number[];
  complete: boolean;
  source: string;
}

export function fetchLCUOwnedProfileIcons(): Promise<LCUProfileIconInventory> {
  return fetch('/api/lcu/profile-icons/owned', { cache: 'no-store' }).then(async (response) => {
    if (!response.ok) throw new Error((await response.text()).trim() || 'Profile icon ownership is unavailable');
    const body = await response.json() as Partial<LCUProfileIconInventory>;
    return {
      iconIds: Array.isArray(body.iconIds) ? body.iconIds.filter((id) => Number.isInteger(id) && id > 0) : [],
      complete: body.complete === true,
      source: String(body.source || ''),
    };
  });
}

export const DDBASE = 'https://ddragon.leagueoflegends.com';
export function ddChampionIcon(version: string, champId: string) { return `${DDBASE}/cdn/${version}/img/champion/${champId}.png`; }
export function ddChampionSplash(champId: string) { return `${DDBASE}/cdn/img/champion/splash/${champId}_0.jpg`; }
export function ddProfileIcon(version: string, id: number) { return `${DDBASE}/cdn/${version}/img/profileicon/${id}.png`; }

// ---------------------------------------------------------------------------
// LCU (local client)
// ---------------------------------------------------------------------------

export interface LCUSummoner {
  summonerId: number;
  accountId: number;
  puuid: string;
  displayName: string;
  gameName: string;
  tagLine: string;
  profileIconId: number;
  summonerLevel: number;
  xpUntilNextLevel: number;
  percentCompleteForNext: number;
}

export interface LCULeagueEntry {
  queueType: string;
  tier: string;
  rank: string;
  division?: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  miniSeries?: { target: number; progress: string; wins: number; losses: number };
}

export interface LCUChampionMastery {
  championId: number;
  championLevel: number;
  championPoints: number;
  lastPlayTime: number;
  championPointsSinceLastLevel: number;
  championPointsUntilNextLevel: number;
  chestGranted: boolean;
}

export interface LCUProfile {
  summoner: LCUSummoner;
  league: LCULeagueEntry[];
  mastery: LCUChampionMastery[];
}

export interface LCUStatus {
  connected: boolean;
  leagueReady: boolean;
  authSource: string;
  detail?: string;
}

export function getLCUStatus(): Promise<LCUStatus> {
  return fetch('/api/lcu/status').then((r) => r.json());
}

export function fetchLCUProfile(): Promise<LCUProfile> {
  return fetch('/api/lcu/profile').then((r) => {
    if (!r.ok) throw new Error('LCU not connected');
    return r.json();
  });
}

export function launchLCULeague(): Promise<{ launched: boolean }> {
  return fetch('/api/lcu/launch-league', { method: 'POST' }).then((r) => {
    if (!r.ok) throw new Error('Failed to launch League');
    return r.json();
  });
}

export function fetchLCUMatchHistory(begin = 0, end = begin + 50): Promise<any> {
  return fetch(`/api/lcu/match-history?begin=${encodeURIComponent(begin)}&end=${encodeURIComponent(end)}`).then((r) => {
    if (!r.ok) throw new Error('Failed to fetch match history');
    return r.json();
  });
}

export function fetchLCUSkins(): Promise<any> {
  return fetch('/api/lcu/skins').then((r) => {
    if (!r.ok) throw new Error('Failed to fetch skin collection');
    return r.json();
  });
}

export function fetchLCUBackgroundChampions(): Promise<any> {
  return fetchCachedJSON('/api/lcu/background-champions', 24 * 60 * 60 * 1000);
}

export function fetchLCUBackgroundSkins(championId: number): Promise<any> {
  return fetchCachedJSON(`/api/lcu/background-skins?championId=${encodeURIComponent(championId)}`, 24 * 60 * 60 * 1000);
}

export function lcuAutoAccept(): Promise<{ accepted: boolean }> {
  return fetch('/api/lcu/auto-accept', { method: 'POST' }).then((r) => {
    if (!r.ok) throw new Error('Ready check not active');
    return r.json();
  });
}

export function lcuDeclineReady(): Promise<{ declined: boolean }> {
  return fetch('/api/lcu/decline-ready', { method: 'POST' }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Ready check decline failed');
    return r.json();
  });
}

export function lcuAutoRequeue(): Promise<{ requeued: boolean }> {
  return fetch('/api/lcu/auto-requeue', { method: 'POST' }).then((r) => {
    if (!r.ok) throw new Error('Failed to requeue');
    return r.json();
  });
}

export function lcuStopQueue(): Promise<{ stopped: boolean }> {
  return fetch('/api/lcu/stop-queue', { method: 'POST' }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Failed to stop matchmaking');
    return r.json();
  });
}

export function lcuQuitCustomSession(): Promise<{ quit: boolean }> {
  return fetch('/api/lcu/quit-custom', { method: 'POST' }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Could not leave the custom or practice game');
    return r.json();
  });
}

export function lcuCustomStart(): Promise<{ ok: boolean }> {
  return fetch('/api/lcu/custom-start', { method: 'POST' }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Failed to start custom game');
    return r.json();
  });
}

export function lcuPlayAgain(): Promise<{ ok: boolean }> {
  return fetch('/api/lcu/play-again', { method: 'POST' }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Play Again is not available yet');
    return r.json();
  });
}

export function lcuClaimEventRewards(): Promise<{ claimed: number }> {
  return fetch('/api/lcu/claim-event-rewards', { method: 'POST' }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Event rewards are not available yet');
    return r.json();
  });
}

export function lcuAutoRoles(first: string, second: string): Promise<{ ok: boolean }> {
  return fetch('/api/lcu/auto-roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first, second }),
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()).trim() || 'Failed to set role preferences');
    return r.json();
  });
}

export function fetchLCULoot(): Promise<any> {
  return fetch('/api/lcu/loot').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()).trim() || 'League loot inventory is unavailable');
    return r.json();
  });
}

export function fetchLCUWallet(): Promise<Record<string, number>> {
  return fetch('/api/lcu/wallet').then(async (response) => {
    if (!response.ok) throw new Error((await response.text()).trim() || 'League wallet is unavailable');
    return response.json();
  });
}

export function fetchLCULootRecipes(lootId: string): Promise<any[]> {
  return fetch(`/api/lcu/loot/recipes?lootId=${encodeURIComponent(lootId)}`).then(async (response) => {
    if (!response.ok) throw new Error((await response.text()).trim() || 'Crafting recipes are unavailable');
    const body = await response.json();
    return Array.isArray(body) ? body : [];
  });
}

export function craftLCULootRecipe(recipeName: string, lootIds: string[], repeat = 1): Promise<any> {
  return fetch('/api/lcu/loot/craft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipeName, lootIds, repeat }),
  }).then(async (response) => {
    if (!response.ok) throw new Error((await response.text()).trim() || 'League rejected the crafting action');
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('application/json') ? response.json() : null;
  });
}

export interface QoLPreferences {
  autoAccept: boolean;
  autoPlayAgain: boolean;
  autoHonor: boolean;
  autoStartQueue: boolean;
  autoClaimRewards: boolean;
  grindMode: boolean;
  rolePresets?: Record<string, RolePreset>;
}

export interface RolePreset {
  first: string;
  second: string;
}

export interface QueuePresetsResponse {
  presets: Record<string, RolePreset>;
  queues: Record<string, string>;
}

export function fetchQueuePresets(): Promise<QueuePresetsResponse> {
  return fetch('/api/qol/queue-presets').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Failed to load queue presets');
    return r.json();
  });
}

export function saveQueuePreset(queue: string, first: string, second: string): Promise<Record<string, RolePreset>> {
  return fetch('/api/qol/queue-presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queue, preset: { first, second } }),
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Failed to save queue preset');
    return r.json();
  });
}

export interface LCUHealth {
  connected: boolean;
  latencyMs: number;
  uptime: number;
  memoryMB: number;
  cpuPercent: number;
}

export function fetchLCUHealth(): Promise<LCUHealth> {
  return fetch('/api/lcu/health').then((r) => r.json());
}

export interface ServerStatusItem {
  server_name: string;
  status: string;
  message?: string;
}

export function fetchServerStatus(region?: string): Promise<ServerStatusItem[]> {
  const q = region ? `?region=${encodeURIComponent(region)}` : '';
  return fetch(`/api/lcu/server-status${q}`).then((r) => r.json());
}

export interface QoLState {
  phase: string;
  availability: string;
  statusMessage: string;
  profileIconId: number;
  queueState: string;
  firstRole: string;
  secondRole: string;
  backgroundSkinId: number;
  readyCheck?: Record<string, unknown>;
  queueId?: number;
  isCustom?: boolean;
}

/** Optional payload returned by the LCU gameflow session endpoint. Riot does
 * not keep this shape stable across client versions, so fields are treated as
 * best-effort and the UI only renders values that are present. */
export interface LCUGameflowSession {
  gameData?: Record<string, unknown>;
  gameClient?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LCUOverview {
  status: LCUStatus;
  health: LCUHealth;
  qol?: QoLState | null;
  gameflowSession?: LCUGameflowSession;
  gameflowSessionAvailable?: boolean;
}

export function fetchLCUOverview(signal?: AbortSignal): Promise<LCUOverview> {
  return fetch('/api/lcu/overview', {
    signal,
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  }).then(async (response) => {
    if (!response.ok) throw new Error((await response.text()) || 'League Client overview is unavailable');
    return response.json();
  });
}

export function fetchQoLPreferences(): Promise<QoLPreferences> {
  return fetch('/api/qol/preferences').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Failed to load QoL preferences');
    return r.json();
  });
}

export function saveQoLPreferences(preferences: QoLPreferences): Promise<QoLPreferences> {
  return fetch('/api/qol/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences),
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Failed to save QoL preferences');
    return r.json();
  });
}

export function fetchQoLState(): Promise<QoLState> {
  return fetch('/api/qol/state').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'League client is not connected');
    return r.json();
  });
}

export function setLCUAvailability(availability: string): Promise<{ ok: boolean }> {
  return fetch('/api/lcu/availability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ availability }),
  }).then(async (response) => {
    if (!response.ok) throw new Error((await response.text()).trim() || 'League presence is unavailable');
    return response.json();
  });
}

export function setLCUStatusMessage(message: string): Promise<{ ok: boolean }> {
  return fetch('/api/lcu/status-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).then(async (response) => {
    if (!response.ok) throw new Error((await response.text()).trim() || 'League status message is unavailable');
    return response.json();
  });
}

export function fetchGameflowPhase(): Promise<string> {
  return fetch('/api/lcu/gameflow-phase').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()).trim() || 'Gameflow phase is unavailable');
    const value = await r.json();
    return String((value as { phase?: string }).phase || '');
  });
}

export interface LCUAvailableQueue {
  id: number;
  name: string;
  gameMode?: string;
  category?: string;
  mapId?: number;
}

export function fetchLCUAvailableQueues(): Promise<LCUAvailableQueue[]> {
  return fetch('/api/lcu/available-queues').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()).trim() || 'Game modes are unavailable');
    const value = await r.json();
    return Array.isArray(value) ? value : [];
  });
}

export interface LCULobby {
  canStartActivity?: boolean;
  gameConfig?: { queueId?: number; mapId?: number; gameMode?: string; isCustom?: boolean };
  localMember?: { isLeader?: boolean; allowedStartActivity?: boolean };
  phase?: string;
}

export function fetchLCULobby(): Promise<LCULobby | null> {
  return fetch('/api/lcu/lobby').then(async (r) => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('Lobby is unavailable');
    return r.json() as Promise<LCULobby>;
  });
}

export function createLCULobby(queueId: number, meta?: { category?: string; gameMode?: string; queueName?: string; mapId?: number }): Promise<{ ok: boolean }> {
  return fetch('/api/lcu/create-lobby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queueId, category: meta?.category, gameMode: meta?.gameMode, queueName: meta?.queueName, mapId: meta?.mapId }),
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()).trim() || 'League rejected the new lobby');
    return r.json();
  });
}

export function createCustomLobby(queue: { id: number; category?: string; gameMode?: string; name?: string; mapId?: number }): Promise<{ ok: boolean }> {
  return createLCULobby(queue.id, { category: queue.category, gameMode: queue.gameMode, queueName: queue.name, mapId: queue.mapId });
}

export function createPracticeToolLobby(): Promise<{ ok: boolean }> {
  return fetch('/api/lcu/create-lobby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ practiceTool: true }),
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.text()).trim() || 'League rejected the Practice Tool lobby');
    return r.json();
  });
}

export function fetchLCUChampSelect(): Promise<unknown> {
  return fetch('/api/lcu/champ-select').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Champion Select is not active');
    return r.json();
  });
}

async function champSelectMutation<T = { ok: boolean }>(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.text()).trim() || 'League rejected the champion-select action');
  return response.json() as Promise<T>;
}

export function fetchLCUChampSelectPickable(): Promise<number[]> {
  return fetch('/api/lcu/champ-select/pickable').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Pickable champions are unavailable');
    return r.json();
  });
}

export function fetchLCUChampSelectBannable(): Promise<number[]> {
  return fetch('/api/lcu/champ-select/bannable').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Bannable champions are unavailable');
    return r.json();
  });
}

export function fetchLCUChampSelectSkins(): Promise<any[]> {
  return fetch('/api/lcu/champ-select/skins').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Champion-select skins are unavailable');
    const value = await r.json();
    return Array.isArray(value) ? value : [];
  });
}

export function submitLCUChampSelectAction(actionId: number, championId: number, completed = false): Promise<{ ok: boolean; completed: boolean }> {
  return champSelectMutation('/api/lcu/champ-select/action', 'POST', { actionId, championId, completed });
}

export function updateLCUChampSelectSelection(selection: { spell1Id?: number; spell2Id?: number; selectedSkinId?: number }): Promise<{ ok: boolean }> {
  return champSelectMutation('/api/lcu/champ-select/selection', 'PATCH', selection);
}

export function rerollLCUChampSelect(): Promise<{ ok: boolean }> {
  return champSelectMutation('/api/lcu/champ-select/reroll', 'POST');
}

export function swapLCUChampSelectBench(championId: number): Promise<{ ok: boolean }> {
  return champSelectMutation('/api/lcu/champ-select/bench/swap', 'POST', { championId });
}

export interface LCURunePage {
  id: number;
  name: string;
  isEditable?: boolean;
  isActive?: boolean;
  current?: boolean;
  isTemporary?: boolean;
  order?: number;
  primaryStyleId: number;
  subStyleId: number;
  selectedPerkIds: number[];
}

export interface LCURunePerk {
  id: number;
  name: string;
  shortDesc?: string;
  longDesc?: string;
  iconPath?: string;
  styleId?: number;
  slotType?: string;
}

export interface LCURuneSlot {
  type: string;
  slotLabel?: string;
  perks: number[];
}

export interface LCURuneStyle {
  id: number;
  name: string;
  iconPath?: string;
  allowedSubStyles?: number[];
  slots: LCURuneSlot[];
}

export interface LCURuneCatalog {
  perks: LCURunePerk[];
  styles: { styles: LCURuneStyle[] };
}

export function fetchLCURunePages(): Promise<LCURunePage[]> {
  return fetch('/api/lcu/champ-select/runes').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Rune pages are unavailable');
    const value = await r.json();
    return Array.isArray(value) ? value as LCURunePage[] : [];
  });
}

export function fetchLCURuneCatalog(): Promise<LCURuneCatalog> {
  return fetch('/api/lcu/champ-select/runes/catalog').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'Rune catalogue is unavailable');
    const value = await r.json() as Partial<LCURuneCatalog>;
    return {
      perks: Array.isArray(value.perks) ? value.perks : [],
      styles: value.styles && Array.isArray(value.styles.styles) ? value.styles : { styles: [] },
    };
  });
}

export function selectLCURunePage(pageId: number): Promise<{ ok: boolean }> {
  return champSelectMutation('/api/lcu/champ-select/runes/select', 'POST', { pageId });
}

export function createLCURunePage(page: Partial<LCURunePage>): Promise<LCURunePage> {
  return champSelectMutation<LCURunePage>('/api/lcu/champ-select/runes/page', 'POST', page);
}

export function updateLCURunePage(page: Pick<LCURunePage, 'id' | 'name' | 'primaryStyleId' | 'subStyleId' | 'selectedPerkIds'>): Promise<{ ok: boolean }> {
  return champSelectMutation('/api/lcu/champ-select/runes/page', 'PUT', page);
}

export function deleteLCURunePage(pageId: number): Promise<{ ok: boolean }> {
  return champSelectMutation('/api/lcu/champ-select/runes/page', 'DELETE', { id: pageId });
}

export function fetchLCUFriends(): Promise<unknown> {
  return fetch('/api/lcu/friends').then(async (r) => {
    if (!r.ok) throw new Error((await r.text()) || 'League friends are unavailable');
    return r.json();
  });
}

export function fetchLCUGameDetail(gameId: number): Promise<any> {
  return fetch(`/api/lcu/game-detail?gameId=${gameId}`).then((r) => {
    if (!r.ok) throw new Error('Failed to fetch game detail');
    return r.json();
  });
}
