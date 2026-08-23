import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bell, Check, CheckCircle2, CircleStop, Command, Gem, History, Play, Radar, RadioTower, RefreshCw, RotateCcw, Search, Settings, Shield, Sparkles, Swords, Wand2, X, type LucideIcon } from 'lucide-react';
import type { Tab } from '../types';
import { commandAvailable } from '../clientCapabilities';
import { useDialogFocus } from './useDialogFocus';

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
  { id: 'play-flow', label: 'Open Play Flow', description: 'Guided launch, queue, and champion-select automation', icon: Swords, tab: 'play' },
  { id: 'live-session', label: 'Open Live Session', description: 'Follow queue, ready check, champion select, and the current match', icon: Activity, tab: 'live' },
  { id: 'qol', label: 'Open League QoL', description: 'Queue, automation, champion select, and post-game controls', icon: Wand2, tab: 'qol' },
  { id: 'history', label: 'Open Match History', description: 'Review recent games and performance', icon: History, tab: 'history' },
  { id: 'skins', label: 'Open Collection', description: 'Browse skins and customize your profile', icon: Sparkles, tab: 'skins' },
  { id: 'loot', label: 'Open Loot Workshop', description: 'Review shards, essence, and crafting', icon: Gem, tab: 'loot' },
  { id: 'remote', label: 'Open Remote Access', description: 'Pair and manage phone sessions', icon: RadioTower, tab: 'remote' },
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
  remoteClient = false,
}: {
  open: boolean;
  onClose: () => void;
  onSelectTab: (tab: Tab) => void;
  onCommand?: (command: string) => void;
  remoteClient?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose, inputRef);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const available = COMMANDS.filter((command) => commandAvailable(command, remoteClient));
    return available.filter((command) => !normalized || `${command.label} ${command.description}`.toLowerCase().includes(normalized));
  }, [query, remoteClient]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
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
      <section ref={dialogRef} tabIndex={-1} className="command-palette" role="dialog" aria-modal="true" aria-label="RiftOps command palette">
        <div className="command-palette__search">
          <Search />
          <input
            ref={inputRef}
            name="riftops-command-search"
            autoComplete="off"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={(event) => {
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
