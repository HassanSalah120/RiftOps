import { Radar, Settings, Code, Medal, History, Sparkles, Wand2 } from 'lucide-react';
import type { Tab } from '../types';

const NAV = [
  { key: 'dashboard' as Tab, icon: Radar, label: 'Command Center' },
  { key: 'history' as Tab, icon: History, label: 'Match History' },
  { key: 'skins' as Tab, icon: Sparkles, label: 'Skin Collection' },
  { key: 'qol' as Tab, icon: Wand2, label: 'Quality of Life' },
  { key: 'scripts' as Tab, icon: Code, label: 'Scripts' },
  { key: 'riot' as Tab, icon: Medal, label: 'Riot Account' },
  { key: 'settings' as Tab, icon: Settings, label: 'Settings' },
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
    <nav className="w-14 shrink-0 bg-base/95 backdrop-blur-xl flex flex-col items-center pt-3.5 pb-3 gap-1.5 border-r border-[#c8aa6e]/15 select-none relative z-10">
      {/* Hextech brand mark */}
      <div className="mb-3 flex items-center justify-center w-full">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#c8aa6e]/30 via-[#c8aa6e]/10 to-transparent border border-[#c8aa6e]/40 flex items-center justify-center shadow-[0_0_15px_rgba(200,170,110,0.25)]">
          <span className="text-sm font-black text-[#f0e6d2] tracking-wider">R</span>
        </div>
      </div>

      {/* Nav items */}
      <div className="flex flex-col items-center gap-1.5 w-full px-1.5">
        {NAV.map((n) => {
          const active = activeTab === n.key;
          const Icon = n.icon;
          return (
            <button
              key={n.key}
              onClick={() => onTabChange(n.key)}
              className={`w-full h-10 rounded-xl flex items-center justify-center transition-all duration-200 cursor-pointer relative group ${
                active
                  ? 'bg-[#c8aa6e]/20 text-[#f0e6d2] border border-[#c8aa6e]/40 shadow-[0_0_18px_rgba(200,170,110,0.3)]'
                  : 'text-text-dim hover:text-white hover:bg-white/[0.05] border border-transparent'
              }`}
              title={n.label}
            >
              <Icon className={`w-4 h-4 transition-transform duration-200 group-hover:scale-110 ${active ? 'text-[#c8aa6e] drop-shadow-[0_0_8px_rgba(200,170,110,0.8)]' : ''}`} />
              
              {/* Active vertical pill indicator */}
              {active && (
                <span className="absolute right-0 top-2 bottom-2 w-1 rounded-l-full bg-[#c8aa6e] shadow-[0_0_10px_#c8aa6e]" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      {/* Live status dot */}
      <div className="flex items-center justify-center" title={`Engine Status: ${phase}`}>
        <span
          className={`block w-2 h-2 rounded-full transition-all duration-500 ${
            isLive
              ? 'bg-[#c8aa6e] shadow-[0_0_12px_#c8aa6e] animate-pulse'
              : 'bg-text-dim/30'
          }`}
        />
      </div>
    </nav>
  );
}
