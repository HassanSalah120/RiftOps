import { createContext, useContext } from 'react';

export type PerformanceMode = 'quiet' | 'balanced' | 'fast';

export const PERFORMANCE_MODES: Record<PerformanceMode, { label: string; description: string; pollMs: number }> = {
  quiet: { label: 'Quiet', description: 'Lowest background activity while idle.', pollMs: 15000 },
  balanced: { label: 'Balanced', description: 'Recommended for everyday play.', pollMs: 5000 },
  fast: { label: 'Fast', description: 'Faster updates during active queues.', pollMs: 2000 },
};

export interface LCUConnectionSnapshot {
  status: import('../api').LCUStatus | null;
  health: import('../api').LCUHealth | null;
  qol: import('../api').QoLState | null;
  gameflowSession: import('../api').LCUGameflowSession | null;
  gameflowSessionAvailable: boolean | null;
  connected: boolean;
  leagueReady: boolean;
  loading: boolean;
  stale: boolean;
  error: string | null;
  lastUpdated: Date | null;
  performanceMode: PerformanceMode;
  setPerformanceMode: (mode: PerformanceMode) => void;
  pageVisible: boolean;
  pollInterval: number;
  realtimeInterval: number;
  refresh: () => Promise<void>;
}

export const LCUConnectionContext = createContext<LCUConnectionSnapshot | null>(null);

export function useLCUConnection() {
  const value = useContext(LCUConnectionContext);
  if (!value) throw new Error('useLCUConnection must be used inside LCUConnectionProvider');
  return value;
}
