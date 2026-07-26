export interface Snapshot {
  Version: string;
  Platform: string;
  Phase: string;
  Detail: string;
  Game: string;
  Status: string;
  Enabled: boolean;
  ChatPort: number;
  StartedAt: string;
  ActiveProfileID: string;
}

export interface LogLine {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface AssistantMessage {
  text: string;
  action: string | null;
  tab: 'dashboard' | 'settings' | null;
}

export interface Notification {
  title: string;
  message: string;
  type: 'info' | 'success' | 'error';
}

export interface ConfirmAction {
  open: boolean;
  title: string;
  message: string;
  actionLabel: string;
  danger: boolean;
  onConfirm: () => void;
}

export interface Release {
  version: string;
  url: string;
}

export type Tab = 'dashboard' | 'settings' | 'riot' | 'history' | 'skins' | 'qol';

/** Go-compatible game codes — these are what ParseGame() accepts */
export const GAMES = [
  { value: "lol",      label: "League of Legends",     color: "#c8aa6e", bg: "from-amber-900/40 via-yellow-950/20 to-blue-950/40" },
  { value: "valorant", label: "VALORANT",               color: "#ff4655", bg: "from-red-900/40 via-stone-950/30 to-red-950/40" },
  { value: "lor",      label: "Legends of Runeterra",   color: "#0ac8b9", bg: "from-teal-900/40 via-slate-950/30 to-cyan-950/40" },
  { value: "lion",     label: "2XKO",                   color: "#ff0055", bg: "from-fuchsia-900/40 via-purple-950/30 to-pink-950/40" },
  { value: "riot-client", label: "Riot Client",         color: "#00b4d8", bg: "from-sky-900/40 via-blue-950/30 to-indigo-950/40" },
] as const;

/** Look up display label from a game code */
export function gameLabel(code: string): string {
  return GAMES.find((g) => g.value === code)?.label ?? 'Not selected';
}

/** Look up game display color from a game code */
export function gameColor(code: string): string {
  return GAMES.find((g) => g.value === code)?.color ?? '#8888a0';
}

export const REGIONS = ["Auto", "BR1", "EUN1", "EUW1", "JP1", "KR", "LA1", "LA2", "NA1", "OC1", "PH2", "SG2", "TH2", "TR1", "TW2", "VN2"] as const;

/** Predefined avatar colors for profile color dots */
export const AVATAR_COLORS = [
  '#c8aa6e', // hextech gold
  '#ff4655', // riot red
  '#0ac8b9', // hextech teal
  '#f97316', // orange
  '#10b981', // emerald
  '#03b6c1', // cyan
  '#f0e6d2', // gold light
  '#3b82f6', // blue
] as const;
