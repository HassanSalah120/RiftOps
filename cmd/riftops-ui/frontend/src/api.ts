import type { Release, Snapshot } from './types';

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
  if (!res.ok) throw new Error(await res.text());
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
  return fetch('/api/ddragon/version').then((r) => r.json());
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
  return fetch('/api/ddragon/champions').then((r) => r.json());
}

export interface DDProfileIcon {
  id: number;
  image: { full: string; sprite: string; group: string };
  name: string;
}

export interface DDProfileIconList {
  data: Record<string, DDProfileIcon>;
}

export function fetchDDProfileIcons(): Promise<DDProfileIconList> {
  return fetch('/api/ddragon/profile-icons').then((r) => r.json());
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

export function fetchLCUMatchHistory(): Promise<any> {
  return fetch('/api/lcu/match-history').then((r) => {
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
  return fetch('/api/lcu/background-champions').then((r) => {
    if (!r.ok) throw new Error('Failed to fetch champion catalogue');
    return r.json();
  });
}

export function fetchLCUBackgroundSkins(championId: number): Promise<any> {
  return fetch(`/api/lcu/background-skins?championId=${encodeURIComponent(championId)}`).then((r) => {
    if (!r.ok) throw new Error('Failed to fetch champion skins');
    return r.json();
  });
}

export function lcuAutoAccept(): Promise<{ accepted: boolean }> {
  return fetch('/api/lcu/auto-accept', { method: 'POST' }).then((r) => {
    if (!r.ok) throw new Error('Ready check not active');
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

export function lcuAutoRoles(first: string, second: string): Promise<{ ok: boolean }> {
  return fetch('/api/lcu/auto-roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first, second }),
  }).then((r) => {
    if (!r.ok) throw new Error('Failed to set role preferences');
    return r.json();
  });
}

export function fetchLCULoot(): Promise<any> {
  return fetch('/api/lcu/loot').then((r) => {
    if (!r.ok) return [];
    return r.json();
  });
}

export interface QoLPreferences {
  autoAccept: boolean;
  autoPlayAgain: boolean;
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

export function fetchLCUGameDetail(gameId: number): Promise<any> {
  return fetch(`/api/lcu/game-detail?gameId=${gameId}`).then((r) => {
    if (!r.ok) throw new Error('Failed to fetch game detail');
    return r.json();
  });
}
