import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, CircleUserRound, Loader2, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Upload, X, Zap } from 'lucide-react';
import {
  captureSavedLogin,
  deleteLaunchProfile,
  fetchLaunchProfiles,
  fetchProfileSessionStatuses,
  saveLaunchProfile,
  switchLaunchProfile,
  type LaunchProfile,
  type ProfileSessionStatus,
} from '../api';
import { useLCUConnection } from './lcuConnectionContext';

type Toast = (title: string, message: string, type?: 'info' | 'success' | 'error') => void;

const REGIONS = [
  ['EUW1', 'Europe West'],
  ['EUN1', 'Europe Nordic & East'],
  ['NA1', 'North America'],
  ['KR', 'Korea'],
  ['BR1', 'Brazil'],
  ['LA1', 'Latin America North'],
  ['LA2', 'Latin America South'],
  ['OC1', 'Oceania'],
  ['TR1', 'Türkiye'],
  ['JP1', 'Japan'],
] as const;
const LOCALES = ['auto', 'en_US', 'en_GB', 'de_DE', 'fr_FR', 'es_ES', 'it_IT', 'pt_BR', 'pl_PL', 'tr_TR', 'ru_RU', 'ja_JP', 'ko_KR', 'zh_CN', 'zh_TW'] as const;

function sessionLabel(status: ProfileSessionStatus | undefined): string {
  if (!status) return 'Checking saved login…';
  if (status.error) return 'Saved login unavailable';
  if (status.expired) return 'Expired · sign in again';
  if (!status.saved) return 'No saved login yet';
  if (!status.expiresAt) return 'Saved login ready';
  const remaining = new Date(status.expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return 'Expired · sign in again';
  const days = Math.max(1, Math.ceil(remaining / 86_400_000));
  return `Saved login · ${days}d left`;
}

export default function LaunchProfilesPanel({
  activeProfileId,
  showToast,
  onRefreshSnapshot,
}: {
  activeProfileId: string;
  showToast: Toast;
  onRefreshSnapshot: () => Promise<void>;
}) {
  const { streamerMode } = useLCUConnection();
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ProfileSessionStatus>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', accountLabel: '', riotId: '', region: 'EUW1', leagueLocale: 'auto' });

  const resetDraft = () => {
    setDraft({ name: '', accountLabel: '', riotId: '', region: 'EUW1', leagueLocale: 'auto' });
    setEditingId(null);
    setAdding(false);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextProfiles, nextStatuses] = await Promise.all([
        fetchLaunchProfiles(),
        fetchProfileSessionStatuses(),
      ]);
      setProfiles(nextProfiles);
      setStatuses(nextStatuses);
    } catch (cause: any) {
      setError(cause?.message || 'Launch profiles could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) || profiles[0],
    [activeProfileId, profiles],
  );

  const runSwitch = async (profile: LaunchProfile, forceLogin = false) => {
    setBusy(`switch:${profile.id}${forceLogin ? ':force' : ''}`);
    try {
      const result = await switchLaunchProfile(profile.id, forceLogin);
      await onRefreshSnapshot().catch(() => undefined);
      await load();
      if (forceLogin) {
        showToast('Fresh sign-in ready', `${profile.name} is launching with a clean login screen. Sign in to your account.`, 'info');
      } else if (result.targetSessionAvailable) {
        showToast('Account switch started', `${profile.name} is launching without a Riot password prompt.`, 'success');
      } else if (result.targetSessionExpired) {
        showToast('Session expired', `${profile.name} needs one fresh Riot sign-in. Capture it afterward to save it again.`, 'info');
      } else {
        showToast('Profile selected', `${profile.name} has no saved login yet. Riot will show the sign-in screen.`, 'info');
      }
    } catch (cause: any) {
      showToast('Account switch failed', cause?.message || 'RiftOps could not switch Riot profiles.', 'error');
    } finally {
      setBusy('');
    }
  };

  const saveCurrentSession = async () => {
    if (!activeProfile) return;
    setBusy('capture');
    try {
      await captureSavedLogin();
      await load();
      showToast('Riot session saved', `${activeProfile.name} is ready for one-click switching for 30 days.`, 'success');
    } catch (cause: any) {
      showToast('Could not save Riot session', cause?.message || 'Keep Riot Client open and signed in, then try again.', 'error');
    } finally {
      setBusy('');
    }
  };

  const openProfileEditor = (profile: LaunchProfile) => {
    setDraft({
      name: profile.name,
      accountLabel: profile.accountLabel || '',
      riotId: profile.riotId || '',
      region: profile.region || 'EUW1',
      leagueLocale: profile.leagueLocale || 'auto',
    });
    setEditingId(profile.id);
    setAdding(true);
  };

  const saveProfile = async () => {
    const name = draft.name.trim();
    if (!name) return;
    const editingProfile = editingId ? profiles.find((profile) => profile.id === editingId) : undefined;
    setBusy('add');
    try {
      await saveLaunchProfile(editingProfile ? {
        ...editingProfile,
        name,
        accountLabel: draft.accountLabel.trim(),
        riotId: draft.riotId.trim(),
        region: draft.region,
        leagueLocale: draft.leagueLocale,
      } : {
        id: '',
        name,
        accountLabel: draft.accountLabel.trim(),
        riotId: draft.riotId.trim(),
        region: draft.region,
        enabled: true,
        status: 'offline',
        defaultGame: 'lol',
        startupStatus: 'last',
        connectToMUC: true,
        patchline: 'live',
        leagueLocale: draft.leagueLocale,
      });
      resetDraft();
      await load();
      await onRefreshSnapshot().catch(() => undefined);
      showToast(editingProfile ? 'Profile updated' : 'Profile added', editingProfile
        ? `${name} was updated without changing its saved Riot session.`
        : `${name} is now selected. Sign into that Riot account, then save the current session.`, 'success');
    } catch (cause: any) {
      showToast(editingProfile ? 'Profile could not be updated' : 'Profile could not be added', cause?.message || 'Check the profile details and try again.', 'error');
    } finally {
      setBusy('');
    }
  };

  const removeProfile = async (profile: LaunchProfile) => {
    if (profiles.length <= 1 || !window.confirm(`Delete the ${profile.name} profile and its saved Riot session?`)) return;
    setBusy(`delete:${profile.id}`);
    try {
      await deleteLaunchProfile(profile.id);
      await load();
      await onRefreshSnapshot().catch(() => undefined);
      showToast('Profile deleted', `${profile.name} and its saved session were removed.`, 'success');
    } catch (cause: any) {
      showToast('Profile could not be deleted', cause?.message || 'The profile is still in use.', 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="dashboard-section dashboard-section--profiles glass-card p-4 space-y-3" aria-labelledby="launch-profiles-title">
      <div className="dashboard-section__heading">
        <span className="dashboard-section__icon"><CircleUserRound /></span>
        <span><small>RIOT ACCOUNT SESSIONS</small><strong id="launch-profiles-title">One-click account switching</strong></span>
        <button type="button" className="ml-auto text-text-dim hover:text-primary transition" onClick={() => void load()} disabled={loading || busy !== ''} aria-label="Refresh launch profiles" title="Refresh profiles">
          <RefreshCw className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-text-muted">
        Save each Riot login once. RiftOps closes Riot, swaps the encrypted session, and launches the selected profile. Riot asks for a password again only when that session expires.
      </p>

      {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">{error}</div>}

      <div className="grid gap-2 sm:grid-cols-2">
        {profiles.map((profile, index) => {
          const active = profile.id === activeProfileId;
          const switching = busy === `switch:${profile.id}`;
          const forceSwitching = busy === `switch:${profile.id}:force`;
          const profileDisplayName = streamerMode
            ? (active ? 'Main Profile' : `Secondary Profile ${index}`)
            : profile.name;
          const profileDisplayRiotId = streamerMode ? undefined : profile.riotId;
          return (
            <article key={profile.id} className={`rounded-xl border p-3 transition ${active ? 'border-primary/50 bg-primary/10 shadow-[0_0_18px_rgba(200,170,110,.12)]' : 'border-white/[0.08] bg-black/10 hover:border-primary/30'}`}>
              <div className="flex items-start gap-2">
                <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${active ? 'bg-primary/20 text-primary' : 'bg-white/[0.06] text-text-dim'}`}><ShieldCheck className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <strong className="truncate text-xs text-white">{profileDisplayName}</strong>
                    {active && <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-bold text-success">ACTIVE</span>}
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-text-muted">{profile.region || 'Region not set'}{profileDisplayRiotId ? ` · ${profileDisplayRiotId}` : ''}</p>
                  <p className={`mt-2 text-[10px] ${statuses[profile.id]?.saved ? 'text-success' : statuses[profile.id]?.expired ? 'text-warning' : 'text-text-dim'}`}>
                    {sessionLabel(statuses[profile.id])}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" className="text-text-dim hover:text-primary transition disabled:opacity-40" onClick={() => openProfileEditor(profile)} disabled={busy !== ''} aria-label={`Edit ${profile.name}`} title="Edit profile">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" className="text-text-dim hover:text-danger transition disabled:opacity-40" onClick={() => void removeProfile(profile)} disabled={busy !== '' || profiles.length <= 1} aria-label={`Delete ${profile.name}`} title="Delete profile">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1.5">
                <button
                  type="button"
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-[10px] font-bold transition ${
                    active
                      ? 'bg-primary text-black hover:bg-primary-hover'
                      : 'border border-primary/25 bg-primary/10 text-primary hover:bg-primary/20'
                  }`}
                  onClick={() => void runSwitch(profile, false)}
                  disabled={busy !== ''}
                >
                  {switching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : active ? (
                    <Zap className="h-3.5 w-3.5" />
                  ) : (
                    <Upload className="h-3.5 w-3.5 rotate-90" />
                  )}
                  {switching
                    ? 'Switching…'
                    : active
                    ? 'Launch Account'
                    : statuses[profile.id]?.saved
                    ? 'Switch & Auto-Login'
                    : 'Switch & Launch'}
                </button>
                <button
                  type="button"
                  className="px-2.5 py-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-[10px] font-semibold text-text-muted hover:text-white transition whitespace-nowrap"
                  onClick={() => void runSwitch(profile, true)}
                  disabled={busy !== ''}
                  title="Clear active session tokens and launch Riot with a clean sign-in prompt for this account"
                >
                  {forceSwitching ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Re-login'}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {activeProfile && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-success/20 bg-success/[0.06] px-3 py-2">
          <div className="flex min-w-0 items-center gap-2"><Check className="h-4 w-4 shrink-0 text-success" /><span className="truncate text-[10px] text-text-muted">Current profile: <strong className="text-white">{streamerMode ? 'Main Profile' : activeProfile.name}</strong></span></div>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-2.5 py-1.5 text-[10px] font-bold text-success transition hover:bg-success/20 disabled:opacity-50" onClick={() => void saveCurrentSession()} disabled={busy !== '' || loading}>
            {busy === 'capture' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            Save current Riot login · 30 days
          </button>
        </div>
      )}

      {adding ? (
        <div className="rounded-xl border border-primary/25 bg-primary/[0.05] p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <strong className="text-xs text-white">{editingId ? 'Edit profile details' : 'Add Riot account profile'}</strong>
            <button type="button" className="text-text-dim transition hover:text-white disabled:opacity-50" onClick={resetDraft} disabled={busy !== ''} aria-label="Close profile editor" title="Close"><X className="h-4 w-4" /></button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="w-full text-xs" placeholder="Profile name (EUW, EUNE…)" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} autoFocus />
            <select className="w-full text-xs" value={draft.region} onChange={(event) => setDraft((current) => ({ ...current, region: event.target.value }))}>
              {REGIONS.map(([value, label]) => <option key={value} value={value}>{value} · {label}</option>)}
            </select>
            <input className="w-full text-xs" placeholder="Riot ID (optional)" value={draft.riotId} onChange={(event) => setDraft((current) => ({ ...current, riotId: event.target.value }))} />
            <input className="w-full text-xs" placeholder="Account label (optional)" value={draft.accountLabel} onChange={(event) => setDraft((current) => ({ ...current, accountLabel: event.target.value }))} />
            <select className="w-full text-xs" value={draft.leagueLocale} onChange={(event) => setDraft((current) => ({ ...current, leagueLocale: event.target.value }))} aria-label="League language"><option value="auto">League language · System</option>{LOCALES.filter((locale) => locale !== 'auto').map((locale) => <option key={locale} value={locale}>{locale}</option>)}</select>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-primary inline-flex items-center gap-1.5 px-3 py-2 text-[10px]" onClick={() => void saveProfile()} disabled={busy !== '' || !draft.name.trim()}>{busy === 'add' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : editingId ? <Pencil className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}{editingId ? 'Save changes' : 'Add profile'}</button>
            <button type="button" className="btn-secondary px-3 py-2 text-[10px]" onClick={resetDraft} disabled={busy !== ''}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="inline-flex items-center gap-1.5 text-[10px] font-bold text-primary hover:text-primary-hover transition" onClick={() => setAdding(true)} disabled={busy !== ''}><Plus className="h-3.5 w-3.5" />Add Riot account profile</button>
      )}
    </section>
  );
}
