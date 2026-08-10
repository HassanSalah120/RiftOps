import { Command, Gem, History, Medal, PanelLeftClose, PanelLeftOpen, Radar, Settings, Sparkles, Wand2 } from 'lucide-react';
import { useState } from 'react';
import type { Tab } from '../types';
import HealthIndicator from './HealthIndicator';

const NAV = [
  { key: 'dashboard' as Tab, icon: Radar, label: 'Command Center', hint: 'Launch and presence' },
  { key: 'history' as Tab, icon: History, label: 'Match History', hint: 'Recent performance' },
  { key: 'skins' as Tab, icon: Sparkles, label: 'Skin Collection', hint: 'Browse cosmetics' },
  { key: 'loot' as Tab, icon: Gem, label: 'Loot & Collection', hint: 'Shards and currencies' },
  { key: 'qol' as Tab, icon: Wand2, label: 'Quality of Life', hint: 'Client controls' },
  { key: 'riot' as Tab, icon: Medal, label: 'Riot Account', hint: 'Profile and rank' },
  { key: 'settings' as Tab, icon: Settings, label: 'Settings', hint: 'App preferences' },
];

export default function Sidebar({
  activeTab,
  onTabChange,
  phase,
  onOpenCommandPalette,
}: {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  phase: string;
  onOpenCommandPalette: () => void;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('riftops.sidebarCollapsed') === 'true'; } catch { return false; }
  });
  const isLive = phase !== 'idle' && phase !== 'error';

  const toggleCollapsed = () => setCollapsed((value) => {
    const next = !value;
    try { localStorage.setItem('riftops.sidebarCollapsed', String(next)); } catch { /* Optional preference. */ }
    return next;
  });

  return (
    <nav className={`app-sidebar ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="app-sidebar__brand">
        <div className="app-sidebar__mark">R</div>
        <div>
          <strong>RiftOps</strong>
          <span>League companion</span>
        </div>
      </div>

      <button type="button" className="app-sidebar__collapse" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}<span>{collapsed ? 'Expand' : 'Collapse'}</span>
      </button>

      <div className="app-sidebar__section-label">Workspace</div>
      <button type="button" className="app-sidebar__command" onClick={onOpenCommandPalette}>
        <span className="app-sidebar__command-icon"><Command /></span>
        <span>Search commands</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="app-sidebar__nav">
        {NAV.map((item) => {
          const active = activeTab === item.key;
          const Icon = item.icon;
          return (
            <button
              type="button"
              key={item.key}
              className={`app-sidebar__item ${active ? 'is-active' : ''}`}
              onClick={() => onTabChange(item.key)}
              aria-current={active ? 'page' : undefined}
            >
              <span className="app-sidebar__item-icon"><Icon /></span>
              <span className="app-sidebar__item-copy">
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </span>
              {active && <span className="app-sidebar__active-dot" />}
            </button>
          );
        })}
      </div>

      <div style={{ padding: '0 10px 8px' }}>
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
