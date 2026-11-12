import { useState } from 'react';
import { Bell, Eye, EyeOff, Flame, Search, ShieldCheck } from 'lucide-react';
import type { Tab } from '../types';
import { useLocale } from '../localeContext';
import { useLCUConnection } from './lcuConnectionContext';
import { normalizeLivePhase, livePhaseLabel } from '../liveSession';
import AccountSwitcherPopover from './AccountSwitcherPopover';
import ConfirmModal from './ConfirmModal';
import type { ConfirmAction } from '../types';

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

interface WorkspaceHeaderProps {
  activeTab: Tab;
  presenceLabel: string;
  detail: string;
  onOpenCommandPalette: () => void;
  onOpenNotifications?: () => void;
  unreadNotifications?: number;
  notificationCenterOpen?: boolean;
  activeProfileId?: string;
  onRefreshSnapshot?: () => Promise<void>;
  showToast?: (title: string, message: string, type?: 'info' | 'success' | 'error') => void;
  presenceMasked?: boolean;
  onToggleMasking?: (enabled: boolean) => void;
  onDodge?: () => void;
}

export default function WorkspaceHeader({
  activeTab,
  detail,
  onOpenCommandPalette,
  onOpenNotifications,
  unreadNotifications = 0,
  notificationCenterOpen = false,
  activeProfileId,
  onRefreshSnapshot,
  showToast,
  presenceMasked = false,
  onToggleMasking,
  onDodge,
}: WorkspaceHeaderProps) {
  const { t } = useLocale();
  const { connected, qol } = useLCUConnection();
  const [dodgeConfirm, setDodgeConfirm] = useState<ConfirmAction | null>(null);

  const sessionPhase = normalizeLivePhase(qol?.phase, qol?.queueState);
  const live = connected && sessionPhase !== 'IDLE';
  const isChampSelect = sessionPhase === 'CHAMP_SELECT';
  const leagueLabel = connected ? livePhaseLabel(sessionPhase) : 'League offline';
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
  const labelKey = TAB_LOCALE_MAP[activeTab];
  const label = labelKey ? t(labelKey) : TAB_LABELS[activeTab];

  const handleDodgeClick = () => {
    setDodgeConfirm({
      open: true,
      title: 'Leave Champion Select (Dodge)?',
      message: 'This will dodge the current lobby. League LP penalties and timer lockouts apply according to standard Riot queue rules.',
      actionLabel: 'Dodge Lobby Now',
      danger: true,
      onConfirm: () => {
        setDodgeConfirm(null);
        onDodge?.();
      },
    });
  };

  return (
    <>
      <header className="workspace-header">
        <div className="workspace-header__crumbs">
          <span className="workspace-header__mark"><ShieldCheck /></span>
          <span className="workspace-header__slash">RIFTOPS</span>
          <span className="workspace-header__divider">/</span>
          <strong>{label}</strong>
          {detail && <span className="workspace-header__detail">{detail}</span>}
        </div>

        <div className="workspace-header__tools">
          {/* Active Account Quick Switcher */}
          <AccountSwitcherPopover
            activeProfileId={activeProfileId}
            onRefreshSnapshot={onRefreshSnapshot}
            showToast={showToast}
          />

          {/* Emergency Dodge Button (visible during Champ Select) */}
          {isChampSelect && (
            <button
              type="button"
              onClick={handleDodgeClick}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-danger/20 hover:bg-danger/30 text-danger border border-danger/40 hover:border-danger font-bold text-xs transition cursor-pointer shadow-[0_0_14px_rgba(255,70,85,0.3)] animate-pulse"
              title="Leave Champion Select (Dodge)"
            >
              <Flame className="w-3.5 h-3.5 fill-current" />
              <span>Dodge Match</span>
            </button>
          )}

          {/* Prominent Ghost / Offline Presence Pill */}
          <button
            type="button"
            onClick={() => onToggleMasking?.(!presenceMasked)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-bold transition cursor-pointer select-none ${
              presenceMasked
                ? 'bg-cyan-950/40 text-cyan-300 border-cyan-500/40 hover:bg-cyan-950/60 shadow-[0_0_12px_rgba(10,200,185,0.2)]'
                : 'bg-black/30 text-emerald-400 border-emerald-500/30 hover:border-emerald-500/50 hover:bg-black/50'
            }`}
            title={
              presenceMasked
                ? 'Presence Masking is ACTIVE. You appear offline to all Riot and League friends.'
                : 'Presence Masking is OFF. You appear online. Click to enable Ghost / Offline mode.'
            }
          >
            {presenceMasked ? (
              <>
                <EyeOff className="w-3.5 h-3.5 text-cyan-400" />
                <span>Masked (Ghost)</span>
              </>
            ) : (
              <>
                <Eye className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-text-muted">Online</span>
              </>
            )}
          </button>

          {/* Live Phase indicator */}
          <div className={`workspace-header__phase ${live ? 'is-live' : ''}`}><span />{leagueLabel}</div>

          {/* Command Palette trigger */}
          <button type="button" className="workspace-header__command" aria-label="Search commands" title={`Search commands (${shortcut})`} onClick={onOpenCommandPalette}>
            <Search /><span>Jump to…</span><kbd>{shortcut}</kbd>
          </button>

          {/* Notification bell */}
          <button type="button" className="workspace-header__notifications" onClick={onOpenNotifications} aria-label={`Notifications${unreadNotifications ? `, ${unreadNotifications} unread` : ''}`} aria-haspopup="dialog" aria-expanded={notificationCenterOpen} title="Notifications">
            <Bell aria-hidden="true" />
            {unreadNotifications > 0 && <span>{unreadNotifications > 9 ? '9+' : unreadNotifications}</span>}
          </button>
        </div>
      </header>

      {/* Dodge confirmation modal */}
      {dodgeConfirm && <ConfirmModal action={dodgeConfirm} onClose={() => setDodgeConfirm(null)} />}
    </>
  );
}
