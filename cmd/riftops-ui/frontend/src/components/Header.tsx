import { Shield } from 'lucide-react';
import type { Tab } from '../types';

export default function Header({
  activeTab,
  onTabChange,
  phase,
}: {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  phase: string;
}) {
  const tabs: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: 'Control' },
    { key: 'settings', label: 'Settings' },
  ];

  return (
    <header className="shrink-0 px-4 pt-4 pb-1 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl bg-primary/15 flex items-center justify-center">
          <Shield className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h1 className="text-sm font-black tracking-wider text-white">RIFT / OPS</h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${phase === 'idle' || phase === 'error' ? 'bg-text-dim' : 'bg-primary animate-pulse'}`} />
            <p className="text-[9px] text-text-dim font-bold tracking-widest uppercase">{phase}</p>
          </div>
        </div>
      </div>

      <nav className="flex items-center gap-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => onTabChange(t.key)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeTab === t.key
                ? 'bg-primary/15 text-primary'
                : 'text-text-dim hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
