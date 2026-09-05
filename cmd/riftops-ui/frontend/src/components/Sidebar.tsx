import { Activity, Command, Gem, History, PanelLeftClose, PanelLeftOpen, Radar, RadioTower, Settings, Sparkles, Swords, Wand2, Users } from 'lucide-react';
import { useState } from 'react';
import type { Tab } from '../types';
import { tabAvailable } from '../clientCapabilities';
import HealthIndicator from './HealthIndicator';
import { livePhaseLabel, normalizeLivePhase } from '../liveSession';
import { useLCUConnection } from './lcuConnectionContext';
import { useLocale } from '../localeContext';

const NAV = [
  { key: 'dashboard' as Tab, icon: Radar, label: 'Command Center', mobileLabel: 'Home', hint: 'Readiness and launch', group: 'operate' },
  { key: 'play' as Tab, icon: Swords, label: 'Play Flow', mobileLabel: 'Play', hint: 'Prepare matchmaking', group: 'operate' },
  { key: 'live' as Tab, icon: Activity, label: 'Live Session', mobileLabel: 'Live', hint: 'Follow the current game', group: 'operate' },
  { key: 'social' as Tab, icon: Users, label: 'Social Center', mobileLabel: 'Social', hint: 'Friends and invitations', group: 'operate' },
  { key: 'history' as Tab, icon: History, label: 'Match History', mobileLabel: 'History', hint: 'Review performance', group: 'review' },
  { key: 'skins' as Tab, icon: Sparkles, label: 'Collection', mobileLabel: 'Skins', hint: 'Skins and profile studio', group: 'review' },
  { key: 'loot' as Tab, icon: Gem, label: 'Loot Workshop', mobileLabel: 'Loot', hint: 'Inventory and crafting', group: 'review' },
  { key: 'qol' as Tab, icon: Wand2, label: 'Quality of Life', mobileLabel: 'Tools', hint: 'Client utilities', group: 'system' },
  { key: 'remote' as Tab, icon: RadioTower, label: 'Remote Access', mobileLabel: 'Phone', hint: 'Pair and manage phones', group: 'system' },
  { key: 'settings' as Tab, icon: Settings, label: 'Settings', mobileLabel: 'Settings', hint: 'Application preferences', group: 'system' },
];

export default function Sidebar({
  activeTab,
  onTabChange,
  phase,
  onOpenCommandPalette,
  remoteClient = false,
}: {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  phase: string;
  onOpenCommandPalette: () => void;
  remoteClient?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('riftops.sidebarCollapsed') === 'true'; } catch { return false; }
  });
  const { qol, stale } = useLCUConnection();
  const { t } = useLocale();
  const sessionPhase = normalizeLivePhase(qol?.phase, qol?.queueState);
  const isLive = sessionPhase !== 'IDLE' || (phase !== 'idle' && phase !== 'error');
  const visibleNav = NAV.filter((item) => tabAvailable(item.key, remoteClient));

  const toggleCollapsed = () => setCollapsed((value) => {
    const next = !value;
    try { localStorage.setItem('riftops.sidebarCollapsed', String(next)); } catch { /* Optional preference. */ }
    return next;
  });

  const translatedLabel = (key: Tab, fallback: string) => {
    const map: Partial<Record<Tab, string>> = { dashboard: 'nav.command', play: 'nav.play', live: 'nav.live', social: 'nav.social', history: 'nav.history', skins: 'nav.skins', loot: 'nav.loot', qol: 'nav.qol', remote: 'nav.remote', settings: 'nav.settings' };
    return map[key] ? t(map[key]!) : fallback;
  };
  const renderNavItem = (item: typeof NAV[number]) => {
    const active = activeTab === item.key;
    const Icon = item.icon;
    return (
      <button
        type="button"
        key={item.key}
        className={`app-sidebar__item ${['loot', 'qol', 'remote', 'settings'].includes(item.key) ? 'is-mobile-hidden' : ''} ${active ? 'is-active' : ''}`}
        onClick={() => onTabChange(item.key)}
        aria-current={active ? 'page' : undefined}
      >
        <span className="app-sidebar__item-icon"><Icon /></span>
        <span className="app-sidebar__item-copy">
          <strong>{translatedLabel(item.key, item.label)}</strong>
          <span className="app-sidebar__item-mobile-label" aria-hidden="true">{item.mobileLabel}</span>
          <small>{item.key === 'social' ? t('nav.socialHint') : item.hint}</small>
        </span>
        {item.key === 'live' && <span className={`app-sidebar__live-badge ${stale ? 'is-stale' : ''}`}>{stale ? 'Retrying' : livePhaseLabel(sessionPhase)}</span>}
        {active && <span className="app-sidebar__active-dot" />}
      </button>
    );
  };

  return (
    <nav className={`app-sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="RiftOps workspaces">
      <div className="app-sidebar__brand">
        <img className="app-sidebar__mark app-sidebar__mark--image" src="/icons/riftops-128.png" alt="" width="128" height="128" />
        <div>
          <strong>RiftOps</strong>
          <span>League companion</span>
        </div>
      </div>

      <button type="button" className="app-sidebar__collapse" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}<span>{collapsed ? 'Expand' : 'Collapse'}</span>
      </button>

      <div className="app-sidebar__section-label">Operate</div>
      <button type="button" className="app-sidebar__command" onClick={onOpenCommandPalette} aria-label="Search RiftOps commands">
        <span className="app-sidebar__command-icon"><Command /></span>
        <span>Search commands</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="app-sidebar__nav">
        {visibleNav.filter((item) => item.group === 'operate').map(renderNavItem)}
      </div>
      <div className="app-sidebar__group-divider"><span>Review</span></div>
      <div className="app-sidebar__nav">
        {visibleNav.filter((item) => item.group === 'review').map(renderNavItem)}
      </div>
      <div className="app-sidebar__group-divider"><span>System</span></div>
      <div className="app-sidebar__nav">
        {visibleNav.filter((item) => item.group === 'system').map(renderNavItem)}
      </div>

      <div className="app-sidebar__health-wrap">
        <HealthIndicator />
      </div>

      <div className="app-sidebar__status">
        <span className={`app-sidebar__status-dot ${isLive ? 'is-live' : ''}`} />
        <span>
          <small>RiftOps engine</small>
          <strong>{isLive ? 'Active' : 'Standing by'}</strong>
        </span>
      </div>
    </nav>
  );
}
