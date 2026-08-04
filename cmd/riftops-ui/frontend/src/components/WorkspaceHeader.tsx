import { Command, Search, ShieldCheck, Zap } from 'lucide-react';
import type { Tab } from '../types';

const TAB_LABELS: Record<Tab, string> = {
  dashboard: 'Command Center',
  qol: 'League QoL',
  history: 'Match History',
  skins: 'Skin Collection',
  loot: 'Loot & Collection',
  riot: 'Riot Account',
  settings: 'Settings',
};

export default function WorkspaceHeader({
  activeTab,
  phase,
  detail,
  onOpenCommandPalette,
}: {
  activeTab: Tab;
  phase: string;
  detail: string;
  onOpenCommandPalette: () => void;
}) {
  const live = phase !== 'idle' && phase !== 'error';
  return (
    <header className="workspace-header">
      <div className="workspace-header__crumbs">
        <span className="workspace-header__mark"><ShieldCheck /></span>
        <span className="workspace-header__slash">RIFT / OPS</span>
        <span className="workspace-header__divider">/</span>
        <strong>{TAB_LABELS[activeTab]}</strong>
        {detail && <span className="workspace-header__detail">{detail}</span>}
      </div>
      <div className="workspace-header__tools">
        <div className={`workspace-header__phase ${live ? 'is-live' : ''}`}><span />{phase || 'Idle'}</div>
        <button type="button" className="workspace-header__command" onClick={onOpenCommandPalette}>
          <Search /><span>Jump to…</span><kbd><Command />K</kbd>
        </button>
        <span className="workspace-header__pulse" title="RiftOps is ready"><Zap /></span>
      </div>
    </header>
  );
}
