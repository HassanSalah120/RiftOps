import { Bell, Search, ShieldCheck } from 'lucide-react';
import type { Tab } from '../types';
import { useLocale } from '../localeContext';
import { useLCUConnection } from './lcuConnectionContext';
import { normalizeLivePhase, livePhaseLabel } from '../liveSession';

const TAB_LABELS: Record<Tab, string> = {
  dashboard: 'Home',
  play: 'Play & Queue',
  live: 'Live Game',
  social: 'Friends',
  qol: 'Automations',
  history: 'Match History',
  skins: 'Skins & Splash',
  progress: 'Progress',
  loot: 'Hextech Loot',
  remote: 'Phone Companion',
  settings: 'Settings',
};

const TAB_LOCALE_MAP: Partial<Record<Tab, string>> = {
  dashboard: 'nav.command',
  play: 'nav.play',
  live: 'nav.live',
  social: 'nav.social',
  history: 'nav.history',
  skins: 'nav.skins',
  progress: 'nav.progress',
  loot: 'nav.loot',
  qol: 'nav.qol',
  remote: 'nav.remote',
  settings: 'nav.settings',
};

export default function WorkspaceHeader({
  activeTab,
  presenceLabel,
  detail,
  onOpenCommandPalette,
  onOpenNotifications,
  unreadNotifications = 0,
  notificationCenterOpen = false,
}: {
  activeTab: Tab;
  presenceLabel: string;
  detail: string;
  onOpenCommandPalette: () => void;
  onOpenNotifications?: () => void;
  unreadNotifications?: number;
  notificationCenterOpen?: boolean;
}) {
  const { t } = useLocale();
  const { connected, qol } = useLCUConnection();
  const sessionPhase = normalizeLivePhase(qol?.phase, qol?.queueState);
  const live = connected && sessionPhase !== 'IDLE';
  const leagueLabel = connected ? livePhaseLabel(sessionPhase) : 'League offline';
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
  const labelKey = TAB_LOCALE_MAP[activeTab];
  const label = labelKey ? t(labelKey) : TAB_LABELS[activeTab];
  return (
    <header className="workspace-header">
      <div className="workspace-header__crumbs">
        <span className="workspace-header__mark"><ShieldCheck /></span>
        <span className="workspace-header__slash">RIFTOPS</span>
        <span className="workspace-header__divider">/</span>
        <strong>{label}</strong>
        {detail && <span className="workspace-header__detail">{detail}</span>}
      </div>
      <div className="workspace-header__tools">
        <div className={`workspace-header__phase ${live ? 'is-live' : ''}`}><span />{leagueLabel}</div>
        <button type="button" className="workspace-header__command" aria-label="Search commands" title={`Search commands (${shortcut})`} onClick={onOpenCommandPalette}>
          <Search /><span>Jump to…</span><kbd>{shortcut}</kbd>
        </button>
        <button type="button" className="workspace-header__notifications" onClick={onOpenNotifications} aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ''}`} aria-haspopup="dialog" aria-expanded={notificationCenterOpen} title="Notifications">
          <Bell aria-hidden="true" />
          {unreadNotifications > 0 && <span>{unreadNotifications > 9 ? '9+' : unreadNotifications}</span>}
        </button>
        <span className="workspace-header__system"><i />{presenceLabel}</span>
      </div>
    </header>
  );
}
