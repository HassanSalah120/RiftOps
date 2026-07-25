// RiftOps API TypeScript types
// Keep in sync with Go backend types

export interface LaunchProfile {
  id: string;
  name: string;
  accountLabel?: string;
  riotId?: string;
  region?: string;
  enabled: boolean;
  status: string;
  defaultGame: string;
  startupStatus: string;
  connectToMUC: boolean;
  patchline: string;
  riotClientArgs?: string[];
  gameArgs?: string[];
  /** Per-game status overrides: maps game key (e.g. "lol", "valorant") to status string */
  gameStatuses?: Record<string, string>;
}

export interface WebSnapshot {
  Phase: string;
  Detail: string;
  Game: string;
  Status: string;
  Enabled: boolean;
  ChatPort: number;
  StartedAt: string;
  ActiveProfileID: string;
  /** Per-game status overrides from the active profile */
  GameStatuses: Record<string, string>;
}

export interface SessionStatus {
  active: boolean;
  saved: boolean;
  expiresIn: string;
  error: string;
}

export interface UpdateInfo {
  available: boolean;
  release?: {
    version: string;
    url: string;
  };
}

export interface AutostartStatus {
  enabled: boolean;
}

// API request/response types

export interface SelectProfileRequest {
  id: string;
}

export interface SwitchProfileRequest {
  id: string;
}

export interface SaveProfileRequest extends LaunchProfile {}

export interface DeleteProfileRequest {
  id: string;
}

export interface SetEnabledRequest {
  enabled: boolean;
}

export interface SetStatusRequest {
  status: string; // "online" | "offline" | "mobile"
}

export interface StartEngineRequest {
  stopExisting: boolean;
}

export interface SetAutostartRequest {
  enabled: boolean;
}

export interface SavePreferencesRequest {
  game: string;
  startupStatus: string;
  connectToMUC: boolean;
  checkUpdates: boolean;
}
