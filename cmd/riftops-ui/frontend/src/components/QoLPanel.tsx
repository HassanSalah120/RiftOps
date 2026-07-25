import { useState, useEffect, useCallback } from 'react';
import {
  Ghost, Zap, Trophy, SkipForward, MessageSquare, Image,
  User, Gift, Loader2, CheckCircle, XCircle,
  Sword, Star, Wifi, WifiOff, ChevronDown, ChevronUp
} from 'lucide-react';
import { fetchLCUBackgroundChampions, fetchLCUBackgroundSkins } from '../api';

// ─── API Helpers ────────────────────────────────────────────────────────────

const lcuPost = (path: string, body?: object) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

const ROLE_OPTIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'FILL'];

async function responseError(response: Response, fallback: string): Promise<string> {
  const text = await response.text();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed.error || parsed.message || fallback;
  } catch {
    return text;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

type ToastState = { msg: string; ok: boolean } | null;
type BackgroundSkin = {
  id: number;
  name: string;
};
type BackgroundChampion = { id: number; name: string };

// ─── Sub-section wrapper ─────────────────────────────────────────────────────

function Section({ title, icon: Icon, children, color = 'primary' }: {
  title: string; icon: any; children: React.ReactNode; color?: string;
}) {
  const [open, setOpen] = useState(true);
  const colorMap: Record<string, string> = {
    primary:  'text-primary border-primary/30',
    emerald:  'text-emerald-400 border-emerald-400/30',
    rose:     'text-rose-400 border-rose-400/30',
    amber:    'text-amber-400 border-amber-400/30',
    cyan:     'text-cyan-400 border-cyan-400/30',
    violet:   'text-violet-400 border-violet-400/30',
  };
  const cls = colorMap[color] ?? colorMap.primary;
  return (
    <div className={`glass-card rounded-2xl border ${cls} overflow-hidden`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 p-3.5 hover:bg-white/[0.03] transition"
      >
        <Icon className={`w-4 h-4 shrink-0 ${cls.split(' ')[0]}`} />
        <span className="font-bold text-sm text-white flex-1 text-left">{title}</span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-text-dim" /> : <ChevronDown className="w-3.5 h-3.5 text-text-dim" />}
      </button>
      {open && <div className="px-3.5 pb-3.5 space-y-3 border-t border-white/[0.06] pt-3">{children}</div>}
    </div>
  );
}

// ─── Toggle Row ──────────────────────────────────────────────────────────────

function ToggleRow({ label, desc, value, onChange, loading }: {
  label: string; desc?: string; value: boolean; onChange: (v: boolean) => void; loading?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white">{label}</p>
        {desc && <p className="text-[11px] text-text-muted mt-0.5">{desc}</p>}
      </div>
      <button
        onClick={() => onChange(!value)}
        disabled={loading}
        className={`relative w-10 h-5 rounded-full transition-all duration-200 shrink-0 ${
          value ? 'bg-primary shadow-[0_0_10px_rgba(200,170,110,0.5)]' : 'bg-white/10'
        } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200 ${
          value ? 'left-5' : 'left-0.5'
        }`} />
      </button>
    </div>
  );
}

// ─── Action Button ───────────────────────────────────────────────────────────

function ActionBtn({ label, icon: Icon, onClick, variant = 'default', loading, disabled }: {
  label: string; icon: any; onClick: () => void;
  variant?: 'default' | 'danger' | 'success' | 'amber';
  loading?: boolean; disabled?: boolean;
}) {
  const variantCls = {
    default: 'bg-primary/15 text-primary border-primary/30 hover:bg-primary/25',
    danger:  'bg-rose-500/15 text-rose-400 border-rose-500/30 hover:bg-rose-500/25',
    success: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25',
    amber:   'bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25',
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-bold transition-all ${variantCls} ${
        (loading || disabled) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      {label}
    </button>
  );
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function ToastBar({ toast }: { toast: ToastState }) {
  if (!toast) return null;
  return (
    <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-2xl border shadow-2xl text-sm font-semibold animate-fadeIn ${
      toast.ok
        ? 'bg-emerald-950/90 text-emerald-300 border-emerald-500/40'
        : 'bg-rose-950/90 text-rose-300 border-rose-500/40'
    }`}>
      {toast.ok ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
      {toast.msg}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function QoLPanel() {
  const [toast, setToast] = useState<ToastState>(null);
  const [offline, setOffline] = useState(false);
  const [offlineLoading, setOfflineLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusLoading, setStatusLoading] = useState(false);
  const [backgroundChampions, setBackgroundChampions] = useState<BackgroundChampion[]>([]);
  const [backgroundSkins, setBackgroundSkins] = useState<BackgroundSkin[]>([]);
  const [backgroundLoadingData, setBackgroundLoadingData] = useState(true);
  const [backgroundSkinLoading, setBackgroundSkinLoading] = useState(false);
  const [backgroundLoadError, setBackgroundLoadError] = useState('');
  const [backgroundReload, setBackgroundReload] = useState(0);
  const [selectedBackgroundChampion, setSelectedBackgroundChampion] = useState<number | null>(null);
  const [selectedBackgroundSkin, setSelectedBackgroundSkin] = useState<number | null>(null);
  const [bgLoading, setBgLoading] = useState(false);
  const [iconId, setIconId] = useState('');
  const [iconLoading, setIconLoading] = useState(false);
  const [dodgeLoading, setDodgeLoading] = useState(false);
  const [playAgainLoading, setPlayAgainLoading] = useState(false);
  const [claimLoading, setClaimLoading] = useState(false);
  const [readyCheckLoading, setReadyCheckLoading] = useState(false);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [firstRole, setFirstRole] = useState('MIDDLE');
  const [secondRole, setSecondRole] = useState('TOP');
  const [phase, setPhase] = useState<string>('—');

  const showToast = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    if (phase !== '—') setBackgroundReload((value) => value + 1);
  }, [phase]);

  // Poll gameflow phase every 5s
  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch('/api/lcu/gameflow-phase');
        if (r.ok) {
          const d = await r.json();
          setPhase(d.phase || '—');
        }
      } catch { /* LCU not ready */ }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const loadBackgroundChampions = async () => {
      setBackgroundLoadingData(true);
      setBackgroundLoadError('');
      try {
        const data = await fetchLCUBackgroundChampions();
        const champions = (Array.isArray(data) ? data : Object.values(data || {}))
          .map((champion: any) => ({ id: Number(champion.id), name: champion.name || `Champion ${champion.id}` }))
          .filter((champion: BackgroundChampion) => champion.id > 0 && champion.name)
          .sort((left: BackgroundChampion, right: BackgroundChampion) => left.name.localeCompare(right.name));
        setBackgroundChampions(champions);
      } catch (error: any) {
        setBackgroundLoadError(error.message || 'Launch League to load the champion catalogue.');
      } finally {
        setBackgroundLoadingData(false);
      }
    };
    void loadBackgroundChampions();
  }, [backgroundReload]);

  useEffect(() => {
    if (!selectedBackgroundChampion) {
      setBackgroundSkins([]);
      return;
    }
    let cancelled = false;
    const loadChampionSkins = async () => {
      setBackgroundSkinLoading(true);
      setBackgroundLoadError('');
      try {
        const data = await fetchLCUBackgroundSkins(selectedBackgroundChampion);
        const skins = (Array.isArray(data) ? data : Object.values(data || {}))
          .map((skin: any) => ({ id: Number(skin.id), name: skin.name || `Skin ${skin.id}` }))
          .filter((skin: BackgroundSkin) => skin.id > 0)
          .sort((left: BackgroundSkin, right: BackgroundSkin) => left.name.localeCompare(right.name));
        if (!cancelled) setBackgroundSkins(skins);
      } catch (error: any) {
        if (!cancelled) setBackgroundLoadError(error.message || 'Unable to load skins for this champion.');
      } finally {
        if (!cancelled) setBackgroundSkinLoading(false);
      }
    };
    void loadChampionSkins();
    return () => { cancelled = true; };
  }, [selectedBackgroundChampion]);

  // ── Handlers ──

  const handleOfflineToggle = async (val: boolean) => {
    setOfflineLoading(true);
    try {
      const r = await lcuPost('/api/lcu/appear-offline', { offline: val });
      if (r.ok) { setOffline(val); showToast(val ? 'Now appearing offline' : 'Now appearing online', true); }
      else showToast('Failed — is League running?', false);
    } finally { setOfflineLoading(false); }
  };

  const handleSetStatus = async () => {
    if (!statusMsg.trim()) return;
    setStatusLoading(true);
    try {
      const r = await lcuPost('/api/lcu/status-message', { message: statusMsg.trim() });
      if (r.ok) showToast('Status message updated!', true);
      else showToast('Failed to set status', false);
    } finally { setStatusLoading(false); }
  };

  const handleSetBg = async () => {
    if (!selectedBackgroundSkin) return showToast('Choose a skin first', false);
    setBgLoading(true);
    try {
      const r = await lcuPost('/api/lcu/profile-background', { skinId: selectedBackgroundSkin });
      if (r.ok) showToast('Profile background updated!', true);
      else showToast(await r.text() || 'Failed to set background', false);
    } finally { setBgLoading(false); }
  };

  const handleSetIcon = async () => {
    const id = parseInt(iconId);
    if (!id) return showToast('Enter a valid icon ID', false);
    setIconLoading(true);
    try {
      const r = await lcuPost('/api/lcu/profile-icon', { iconId: id });
      if (r.ok) showToast(`Profile icon set to ${id}!`, true);
      else showToast('Failed to set icon', false);
    } finally { setIconLoading(false); }
  };

  const handleDodge = async () => {
    if (!confirm('⚠️ Dodging will cost -3 LP and a 5-min queue block. Proceed?')) return;
    setDodgeLoading(true);
    try {
      const r = await lcuPost('/api/lcu/dodge');
      if (r.ok) showToast('Dodge request sent.', true);
      else showToast(await responseError(r, 'Dodge failed.'), false);
    } finally { setDodgeLoading(false); }
  };

  const handlePlayAgain = async () => {
    setPlayAgainLoading(true);
    try {
      const r = await lcuPost('/api/lcu/play-again');
      if (r.ok) showToast('Returning to lobby!', true);
      else showToast('Failed — not in end-of-game screen?', false);
    } finally { setPlayAgainLoading(false); }
  };

  const handleClaimMissions = async () => {
    setClaimLoading(true);
    try {
      const r = await lcuPost('/api/lcu/claim-missions');
      if (r.ok) {
        const d = await r.json();
        showToast(`Claimed ${d.claimed} mission reward${d.claimed !== 1 ? 's' : ''}!`, true);
      } else showToast('Failed to claim missions', false);
    } finally { setClaimLoading(false); }
  };

  const handleAcceptReadyCheck = async () => {
    setReadyCheckLoading(true);
    try {
      const r = await lcuPost('/api/lcu/auto-accept');
      if (r.ok) showToast('Ready check accepted.', true);
      else showToast(await responseError(r, 'Ready check could not be accepted.'), false);
    } finally { setReadyCheckLoading(false); }
  };

  const handleSetRoles = async () => {
    setRolesLoading(true);
    try {
      const r = await lcuPost('/api/lcu/auto-roles', { first: firstRole, second: secondRole });
      if (r.ok) showToast('Position preferences saved.', true);
      else showToast(await responseError(r, 'Position preferences could not be saved.'), false);
    } finally { setRolesLoading(false); }
  };

  const phaseColor = {
    ChampSelect: 'text-amber-400',
    InProgress: 'text-emerald-400',
    Lobby: 'text-cyan-400',
    EndOfGame: 'text-violet-400',
    WaitingForStats: 'text-violet-400',
    Matchmaking: 'text-primary',
    ReadyCheck: 'text-rose-400',
  }[phase] ?? 'text-text-muted';
  return (
    <div className="h-full overflow-y-auto p-4 space-y-3 scrollbar-thin">
      <ToastBar toast={toast} />

      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <div>
          <h2 className="text-lg font-black text-white">Quality of Life</h2>
          <p className="text-xs text-text-muted">LCU automation features from KO3-QoL</p>
        </div>
        <div className="flex items-center gap-2 glass-card px-3 py-1.5 rounded-xl border border-white/10">
          <span className="text-[10px] text-text-dim font-bold uppercase tracking-wider">Phase</span>
          <span className={`text-xs font-black ${phaseColor}`}>{phase}</span>
        </div>
      </div>

      {/* Social */}
      <Section title="Social & Presence" icon={Ghost} color="cyan">
        <ToggleRow
          label="Appear Offline"
          desc="Show as offline to friends while still playing"
          value={offline}
          onChange={handleOfflineToggle}
          loading={offlineLoading}
        />
        <div className="flex items-center gap-2 pt-1">
          <div className="flex-1 relative">
            <MessageSquare className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-dim" />
            <input
              type="text"
              value={statusMsg}
              onChange={e => setStatusMsg(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSetStatus()}
              placeholder="Custom status message…"
              maxLength={128}
              className="w-full bg-black/30 border border-white/10 rounded-xl text-xs text-white pl-8 pr-3 py-2 placeholder:text-text-dim focus:outline-none focus:border-primary/50"
            />
          </div>
          <ActionBtn label="Set" icon={CheckCircle} onClick={handleSetStatus} loading={statusLoading} />
        </div>
      </Section>

      {/* Profile */}
      <Section title="Profile Customization" icon={User} color="violet">
        <div className="space-y-1">
          <label className="text-[10px] text-text-dim font-bold uppercase tracking-wider">Profile Background</label>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={selectedBackgroundChampion ?? ''}
              disabled={backgroundLoadingData || !!backgroundLoadError}
              onChange={(event) => {
                const championId = Number(event.target.value) || null;
                setSelectedBackgroundChampion(championId);
                setSelectedBackgroundSkin(null);
              }}
              className="bg-black/30 border border-white/10 rounded-xl text-xs text-white px-2.5 py-2 focus:outline-none focus:border-violet-400/50 disabled:opacity-50"
            >
              <option value="">{backgroundLoadingData ? 'Loading champions…' : 'Choose champion'}</option>
              {backgroundChampions.map((champion) => <option key={champion.id} value={champion.id}>{champion.name}</option>)}
            </select>
            <select
              value={selectedBackgroundSkin ?? ''}
              disabled={!selectedBackgroundChampion || backgroundLoadingData || backgroundSkinLoading || !!backgroundLoadError}
              onChange={(event) => setSelectedBackgroundSkin(Number(event.target.value) || null)}
              className="bg-black/30 border border-white/10 rounded-xl text-xs text-white px-2.5 py-2 focus:outline-none focus:border-violet-400/50 disabled:opacity-50"
            >
              <option value="">{backgroundSkinLoading ? 'Loading skins…' : 'Choose skin'}</option>
              {backgroundSkins.map((skin) => <option key={skin.id} value={skin.id}>{skin.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <ActionBtn label="Apply Background" icon={Image} onClick={handleSetBg} loading={bgLoading} disabled={!selectedBackgroundSkin || backgroundLoadingData || backgroundSkinLoading || !!backgroundLoadError} variant="default" />
            {backgroundLoadError
              ? <button onClick={() => setBackgroundReload((value) => value + 1)} className="text-[10px] text-rose-300 hover:text-rose-200 underline cursor-pointer">Retry loading champions</button>
              : <span className="text-[10px] text-text-dim">Any skin can be used as a profile background.</span>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[10px] text-text-dim font-bold uppercase tracking-wider">Profile Icon ID</label>
            <div className="flex gap-1.5">
              <input
                type="number"
                value={iconId}
                onChange={e => setIconId(e.target.value)}
                placeholder="e.g. 4895"
                className="flex-1 bg-black/30 border border-white/10 rounded-xl text-xs text-white px-2.5 py-2 placeholder:text-text-dim focus:outline-none focus:border-violet-400/50"
              />
              <ActionBtn label="Set" icon={Star} onClick={handleSetIcon} loading={iconLoading} variant="default" />
            </div>
          </div>
        </div>
      </Section>

      {/* Champ Select actions */}
      <Section title="Queue & Lobby" icon={Zap} color="cyan">
        <div className="flex flex-wrap items-center gap-2">
          <ActionBtn label="Accept Ready Check" icon={CheckCircle} onClick={handleAcceptReadyCheck} loading={readyCheckLoading} disabled={phase !== 'ReadyCheck'} variant="success" />
          <span className="text-[10px] text-text-dim">Available only while a ready check is active.</span>
        </div>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 pt-1">
          <select value={firstRole} onChange={(event) => setFirstRole(event.target.value)} disabled={phase !== 'Lobby' || rolesLoading} className="bg-black/30 border border-white/10 rounded-xl text-xs text-white px-2.5 py-2 disabled:opacity-50">
            {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
          <select value={secondRole} onChange={(event) => setSecondRole(event.target.value)} disabled={phase !== 'Lobby' || rolesLoading} className="bg-black/30 border border-white/10 rounded-xl text-xs text-white px-2.5 py-2 disabled:opacity-50">
            {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
          <ActionBtn label="Save Roles" icon={CheckCircle} onClick={handleSetRoles} loading={rolesLoading} disabled={phase !== 'Lobby'} />
        </div>
        <p className="text-[10px] text-text-dim">Set primary and secondary roles from an active lobby.</p>
      </Section>

      <Section title="Champion Select" icon={Sword} color="rose">
        <div className="space-y-2">
          <p className="text-[11px] text-text-muted">Actions that work while you are in champion select.</p>
          <div className="flex flex-wrap gap-2">
            <ActionBtn
              label="Dodge Game"
              icon={Zap}
              onClick={handleDodge}
              variant="danger"
              loading={dodgeLoading}
              disabled={phase !== 'ChampSelect'}
            />
          </div>
          <div className="flex items-start gap-2 bg-rose-950/20 border border-rose-500/20 rounded-xl p-2.5 text-[11px] text-rose-300">
            <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>Dodge costs −3 LP and blocks queue for 5 min. Use sparingly.</span>
          </div>
        </div>
      </Section>

      {/* Post-game */}
      <Section title="Post-Game & End-of-Game" icon={Trophy} color="amber">
        <div className="flex flex-wrap gap-2">
          <ActionBtn
            label="Play Again"
            icon={SkipForward}
            onClick={handlePlayAgain}
            variant="amber"
            loading={playAgainLoading}
            disabled={phase !== 'EndOfGame'}
          />
        </div>
        <p className="text-[11px] text-text-muted">Skips the end-of-game screen and returns you to the lobby instantly.</p>
      </Section>

      {/* Loot & Missions */}
      <Section title="Loot & Missions" icon={Gift} color="emerald">
        <div className="flex flex-wrap gap-2">
          <ActionBtn
            label="Claim All Missions"
            icon={Gift}
            onClick={handleClaimMissions}
            variant="success"
            loading={claimLoading}
          />
        </div>
        <p className="text-[11px] text-text-muted">Claims rewards for all completed missions in your mission log.</p>
      </Section>

      {/* Connection status */}
      <div className="flex items-center gap-2 text-[10px] text-text-dim px-1">
        {phase !== '—'
          ? <><Wifi className="w-3 h-3 text-emerald-400" /> League client connected</>
          : <><WifiOff className="w-3 h-3 text-rose-400" /> League client not detected — launch League first</>
        }
      </div>
    </div>
  );
}
