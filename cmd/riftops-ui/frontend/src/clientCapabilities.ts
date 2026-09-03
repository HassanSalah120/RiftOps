import type { Tab } from './types';

export const ALL_TABS: readonly Tab[] = ['dashboard', 'play', 'live', 'social', 'history', 'skins', 'loot', 'qol', 'remote', 'settings'];
export const PHONE_TABS: readonly Tab[] = ['dashboard', 'play', 'live', 'social', 'history', 'skins'];
export const DESKTOP_ONLY_ACTIONS = new Set(['launch', 'stop', 'toggle-mask']);

export function availableTabs(remoteClient: boolean): readonly Tab[] {
  return remoteClient ? PHONE_TABS : ALL_TABS;
}

export function tabAvailable(tab: Tab, remoteClient: boolean): boolean {
  return availableTabs(remoteClient).includes(tab);
}

export function commandAvailable(command: { tab?: Tab; action?: string }, remoteClient: boolean): boolean {
  if (!remoteClient) return true;
  if (command.tab && !tabAvailable(command.tab, true)) return false;
  return !command.action || !DESKTOP_ONLY_ACTIONS.has(command.action);
}
