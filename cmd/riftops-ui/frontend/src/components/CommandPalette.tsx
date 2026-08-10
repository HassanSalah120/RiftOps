import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Check, CheckCircle2, CircleStop, Command, Gem, History, Medal, Play, Radar, RefreshCw, RotateCcw, Search, Settings, Shield, Sparkles, Wand2, X, type LucideIcon } from 'lucide-react';
import type { Tab } from '../types';

type PaletteCommand = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  tab?: Tab;
  action?: string;
};

const COMMANDS: PaletteCommand[] = [
  { id: 'dashboard', label: 'Open Command Center', description: 'Launch games and manage presence', icon: Radar, tab: 'dashboard' },
  { id: 'qol', label: 'Open League QoL', description: 'Queue, automation, champion select, and post-game controls', icon: Wand2, tab: 'qol' },
  { id: 'history', label: 'Open Match History', description: 'Review recent games and performance', icon: History, tab: 'history' },
  { id: 'skins', label: 'Open Skin Collection', description: 'Browse champions and skins', icon: Sparkles, tab: 'skins' },
  { id: 'loot', label: 'Open Loot & Collection', description: 'Review shards, essence, and loot', icon: Gem, tab: 'loot' },
  { id: 'riot', label: 'Open Riot Account', description: 'Profile, ranked, and mastery information', icon: Medal, tab: 'riot' },
  { id: 'settings', label: 'Open Settings', description: 'App preferences and Riot Client location', icon: Settings, tab: 'settings' },
  { id: 'launch', label: 'Launch selected game', description: 'Run the preflight launch flow', icon: Check, action: 'launch' },
  { id: 'stop', label: 'Stop RiftOps', description: 'Stop the engine and presence bridge', icon: CircleStop, action: 'stop' },
  { id: 'accept', label: 'Accept ready check', description: 'Confirm the active League ready check', icon: CheckCircle2, action: 'accept' },
  { id: 'start-queue', label: 'Start matchmaking', description: 'Start the current lobby queue', icon: Play, action: 'start-queue' },
  { id: 'stop-queue', label: 'Stop matchmaking', description: 'Stop the active queue search', icon: CircleStop, action: 'stop-queue' },
  { id: 'play-again', label: 'Play again', description: 'Return to the lobby after a match', icon: RotateCcw, action: 'play-again' },
  { id: 'toggle-mask', label: 'Toggle presence shield', description: 'Enable or disable presence masking', icon: Shield, action: 'toggle-mask' },
  { id: 'refresh', label: 'Refresh client state', description: 'Reload Riot Client and RiftOps status', icon: RefreshCw, action: 'refresh' },
  { id: 'notifications', label: 'Open notifications', description: 'Review recent RiftOps activity', icon: Bell, action: 'notifications' },
];

export default function CommandPalette({
  open,
  onClose,
  onSelectTab,
  onCommand,
}: {
  open: boolean;
  onClose: () => void;
  onSelectTab: (tab: Tab) => void;
  onCommand?: (command: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return COMMANDS.filter((command) => !normalized || `${command.label} ${command.description}`.toLowerCase().includes(normalized));
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [activeIndex, filtered.length]);

  if (!open) return null;

  const choose = (command: PaletteCommand | undefined) => {
    if (!command) return;
    if (command.tab) onSelectTab(command.tab);
    if (command.action) onCommand?.(command.action);
    onClose();
  };

  return (
    <div className="command-palette__backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="RiftOps command palette">
        <div className="command-palette__search">
          <Search />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, filtered.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
              if (event.key === 'Enter') { event.preventDefault(); choose(filtered[activeIndex]); }
            }}
            placeholder="Search RiftOps…"
            aria-label="Search commands"
          />
          <kbd>ESC</kbd>
          <button type="button" onClick={onClose} aria-label="Close command palette"><X /></button>
        </div>

        <div className="command-palette__hint"><Command /> <span>Navigate with arrow keys</span><span className="command-palette__hint-spacer" /><span>Press Enter to open</span></div>

        <div className="command-palette__list">
          {filtered.map((command, index) => {
            const Icon = command.icon;
            const active = index === activeIndex;
            return (
              <button
                key={command.id}
                type="button"
                className={`command-palette__item ${active ? 'is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(command)}
              >
                <span className="command-palette__item-icon"><Icon /></span>
                <span className="command-palette__item-copy"><strong>{command.label}</strong><small>{command.description}</small></span>
                {active && <span className="command-palette__item-enter">↵</span>}
              </button>
            );
          })}
          {filtered.length === 0 && <div className="command-palette__empty">No commands match “{query}”.</div>}
        </div>
      </section>
    </div>
  );
}
