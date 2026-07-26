import { History, Medal, Radar, Settings, Sparkles, Wand2 } from 'lucide-react';
import type { Tab } from '../types';

const NAV = [
  { key: 'dashboard' as Tab, icon: Radar, label: 'Command Center', hint: 'Launch and presence' },
  { key: 'history' as Tab, icon: History, label: 'Match History', hint: 'Recent performance' },
  { key: 'skins' as Tab, icon: Sparkles, label: 'Skin Collection', hint: 'Browse cosmetics' },
  { key: 'qol' as Tab, icon: Wand2, label: 'Quality of Life', hint: 'Client controls' },
  { key: 'riot' as Tab, icon: Medal, label: 'Riot Account', hint: 'Profile and rank' },
  { key: 'settings' as Tab, icon: Settings, label: 'Settings', hint: 'App preferences' },
];

export default function Sidebar({
  activeTab,
  onTabChange,
  phase,
}: {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  phase: string;
}) {
  const isLive = phase !== 'idle' && phase !== 'error';

  return (
    <nav className="app-sidebar">
      <div className="app-sidebar__brand">
        <div className="app-sidebar__mark">R</div>
        <div>
          <strong>RiftOps</strong>
          <span>League companion</span>
        </div>
      </div>

      <div className="app-sidebar__section-label">Workspace</div>
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
