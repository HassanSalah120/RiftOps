import { Bell, Command, Search, ShieldCheck } from 'lucide-react';
import type { Tab } from '../types';

const TAB_LABELS: Record<Tab, string> = {
  dashboard: 'Command Center',
  play: 'Play Flow',
  live: 'Live Session',
  qol: 'League QoL',
  history: 'Match History',
  skins: 'Skin Collection',
  loot: 'Loot Workshop',
  remote: 'Remote Access',
  settings: 'Settings',
};

export default function WorkspaceHeader({
  activeTab,
  phase,
  detail,
  onOpenCommandPalette,
  onOpenNotifications,
  unreadNotifications = 0,
}: {
  activeTab: Tab;
  phase: string;
  detail: string;
  onOpenCommandPalette: () => void;
  onOpenNotifications?: () => void;
  unreadNotifications?: number;
}) {
  const live = phase !== 'idle' && phase !== 'error';
  return (
    <header className="workspace-header">
      <div className="workspace-header__crumbs">
        <span className="workspace-header__mark"><ShieldCheck /></span>
        <span className="workspace-header__slash">RIFTOPS</span>
        <span className="workspace-header__divider">/</span>
        <strong>{TAB_LABELS[activeTab]}</strong>
        {detail && <span className="workspace-header__detail">{detail}</span>}
      </div>
      <div className="workspace-header__tools">
        <div className={`workspace-header__phase ${live ? 'is-live' : ''}`}><span />{phase || 'Idle'}</div>
        <button type="button" className="workspace-header__command" onClick={onOpenCommandPalette}>
          <Search /><span>Jump to…</span><kbd><Command />K</kbd>
        </button>
        <button type="button" className="workspace-header__notifications" onClick={onOpenNotifications} aria-label="Open notifications" title="Notifications">
          <Bell />
          {unreadNotifications > 0 && <span>{unreadNotifications > 9 ? '9+' : unreadNotifications}</span>}
        </button>
        <span className="workspace-header__system"><i />SYSTEM READY</span>
      </div>
    </header>
  );
}
