import { useCallback, useEffect, useState } from 'react';
import { CircleUserRound, Loader2, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, X, Zap } from 'lucide-react';
import {
  captureSavedLogin,
  deleteLaunchProfile,
  fetchConnectedLeagueAccount,
  fetchLaunchProfiles,
  fetchProfileSessionStatuses,
  saveLaunchProfile,
  switchLaunchProfile,
  type LaunchProfile,
  type ConnectedLeagueAccount,
  type ProfileSessionStatus,
} from '../api';
import { useLCUConnection } from './lcuConnectionContext';

type Toast = (title: string, message: string, type?: 'info' | 'success' | 'error') => void;

const REGIONS = [
  { group: 'Europe', options: [['EUW1', 'Europe West'], ['EUN1', 'Europe Nordic & East'], ['TR1', 'Türkiye'], ['RU', 'Russia']] },
  { group: 'Americas', options: [['NA1', 'North America'], ['BR1', 'Brazil'], ['LA1', 'Latin America North'], ['LA2', 'Latin America South']] },
  { group: 'Asia & Oceania', options: [['KR', 'Korea'], ['JP1', 'Japan'], ['OC1', 'Oceania'], ['PH2', 'Philippines'], ['SG2', 'Singapore'], ['TH2', 'Thailand'], ['TW2', 'Taiwan'], ['VN2', 'Vietnam']] },
] as const;
const LOCALES = ['auto', 'en_US', 'en_GB', 'de_DE', 'fr_FR', 'es_ES', 'it_IT', 'pt_BR', 'pl_PL', 'tr_TR', 'ru_RU', 'ja_JP', 'ko_KR', 'zh_CN', 'zh_TW'] as const;

function sessionLabel(status: ProfileSessionStatus | undefined): string {
  if (!status) return 'Checking saved login…';
  if (status.needsRecapture) return 'Re-save after verifying account';
  if (status.error) return 'Saved login unavailable';
  if (status.expired) return 'Local save expired · sign in again';
  if (!status.saved) return 'No saved login yet';
  if (!status.expiresAt) return 'Identity-verified local save';
  const remaining = new Date(status.expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return 'Local save expired · sign in again';
  const days = Math.max(1, Math.ceil(remaining / 86_400_000));
  return `Identity-verified save · up to ${days}d locally`;
}

function sameRiotId(left?: string, right?: string): boolean {
  return Boolean(left && right && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase());
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
  const [connected, setConnected] = useState<ConnectedLeagueAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', accountLabel: '', riotId: '', region: '', leagueLocale: 'auto' });

  const resetDraft = () => {
    setDraft({ name: '', accountLabel: '', riotId: '', region: '', leagueLocale: 'auto' });
    setEditingId(null);
    setAdding(false);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextProfiles, nextStatuses, nextConnected] = await Promise.all([
        fetchLaunchProfiles(),
        fetchProfileSessionStatuses(),
        fetchConnectedLeagueAccount().catch(() => ({ available: false, reason: 'Could not check the League Client. Try Refresh.' })),
      ]);
      setProfiles(nextProfiles);
      setStatuses(nextStatuses);
      setConnected(nextConnected);
    } catch (cause: any) {
      setError(cause?.message || 'Launch profiles could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || profiles[0];
  const activeRegionMismatch = Boolean(connected?.available && activeProfile && sameRiotId(activeProfile.riotId, connected.riotId) && activeProfile.region !== connected.region);

  const openNewProfileEditor = () => {
    setDraft({ name: '', accountLabel: '', riotId: connected?.riotId || '', region: connected?.region || '', leagueLocale: 'auto' });
    setEditingId(null);
    setAdding(true);
  };

  const runSwitch = async (profile: LaunchProfile, forceLogin = false) => {
    const profileLabel = streamerMode ? 'this profile' : profile.name;
    setBusy(`switch:${profile.id}${forceLogin ? ':force' : ''}`);
    setError('');
    try {
      const result = await switchLaunchProfile(profile.id, forceLogin);
      await onRefreshSnapshot().catch(() => undefined);
      await load();
      if (result.verification === 'verified') {
        showToast('Account verified', `${profileLabel} signed in with the saved Riot account.`, 'success');
      } else if (result.verification === 'wrong-account') {
        setError('Riot opened a different account. Use Re-login, sign in to the intended Riot ID, then save that login again.');
        showToast('Wrong Riot account opened', `Riot opened a different account for ${profileLabel}. Use Re-login, sign in to the intended account, then save it again.`, 'error');
      } else if (result.verification === 'not-verified') {
        setError('RiftOps could not verify which Riot account opened. Check Riot Client before using this profile.');
        showToast('Sign-in not verified', `RiftOps could not confirm ${profileLabel}'s account. Check Riot Client; use Re-login if it opened the wrong account.`, 'error');
      } else if (forceLogin) {
        showToast('Fresh sign-in needed', `Sign in to the intended Riot account for ${profileLabel}, then save its login.`, 'info');
      } else if (result.targetSessionUnverified) {
        showToast('One-time re-save needed', `The old save for ${profileLabel} has no verified identity. Sign in to the correct account, then save it again.`, 'info');
      } else if (result.targetSessionExpired) {
        showToast('Local save expired', `${profileLabel} needs a fresh Riot sign-in. Save it afterward.`, 'info');
      } else {
        showToast('Sign-in needed', `${profileLabel} has no verified saved login. Sign in to Riot, then save it.`, 'info');
      }
    } catch (cause: any) {
      setError(cause?.message || 'RiftOps could not switch Riot profiles.');
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
      showToast('Riot login saved', `${streamerMode ? 'This profile' : activeProfile.name} is bound to the signed-in Riot account. Riot may still require sign-in later.`, 'success');
    } catch (cause: any) {
      setError(cause?.message || 'The current Riot login could not be saved.');
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
      region: profile.region || '',
      leagueLocale: profile.leagueLocale || 'auto',
    });
    setEditingId(profile.id);
    setAdding(true);
  };

  const useConnectedAccount = () => {
    if (!connected?.available || !connected.riotId || !connected.region) return;
    setDraft((current) => ({ ...current, riotId: connected.riotId || '', region: connected.region || '' }));
  };

  const updateDetectedServer = async (profile: LaunchProfile) => {
    if (!connected?.available || !connected.region || !sameRiotId(profile.riotId, connected.riotId)) return;
    setBusy(`region:${profile.id}`);
    try {
      await saveLaunchProfile({ ...profile, region: connected.region });
      await load();
      showToast('Server updated', `${streamerMode ? 'This profile' : profile.name} now uses the server reported by League.`, 'success');
    } catch (cause: any) {
      setError(cause?.message || 'Could not update the profile server.');
    } finally {
      setBusy('');
    }
  };

  const saveProfile = async () => {
    const name = draft.name.trim();
    if (!name || !draft.region) return;
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
        ? `${streamerMode ? 'This profile' : name} was updated. Any saved login must still match its Riot ID.`
        : `${streamerMode ? 'The new profile' : name} is now selected. Sign into that Riot account, then save the current session.`, 'success');
    } catch (cause: any) {
      showToast(editingProfile ? 'Profile could not be updated' : 'Profile could not be added', cause?.message || 'Check the profile details and try again.', 'error');
    } finally {
      setBusy('');
    }
  };

  const removeProfile = async (profile: LaunchProfile) => {
    const profileLabel = streamerMode ? 'selected' : profile.name;
    if (profiles.length <= 1 || !window.confirm(`Delete the ${profileLabel} profile and its saved Riot session?`)) return;
    setBusy(`delete:${profile.id}`);
    try {
      await deleteLaunchProfile(profile.id);
      await load();
      await onRefreshSnapshot().catch(() => undefined);
      showToast('Profile deleted', `${streamerMode ? 'The profile' : profile.name} and its saved session were removed.`, 'success');
    } catch (cause: any) {
      showToast('Profile could not be deleted', cause?.message || 'The profile is still in use.', 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="dashboard-section account-switcher glass-card" aria-labelledby="launch-profiles-title">
      <header className="account-switcher__header">
        <div className="account-switcher__heading">
          <CircleUserRound aria-hidden="true" />
          <div>
            <h2 id="launch-profiles-title">Riot accounts</h2>
            <p>Choose an account to launch. Save its login after signing in.</p>
          </div>
        </div>
        <div className="account-switcher__header-actions">
          <button type="button" className="account-switcher__icon-button" onClick={() => void load()} disabled={loading || busy !== ''} aria-label="Refresh accounts and detect server" title="Refresh accounts and detect server">
            <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
          <button type="button" className="btn-secondary account-switcher__add" onClick={openNewProfileEditor} disabled={busy !== ''}>
            <Plus aria-hidden="true" /> Add account
          </button>
        </div>
      </header>

      <div className="account-switcher__current" role="status" aria-live="polite">
        <span className={`account-switcher__signal ${connected?.available ? 'is-connected' : ''}`} aria-hidden="true" />
        <div className="account-switcher__current-copy">
          <strong>{connected?.available ? `League connected · ${connected.region}` : loading ? 'Checking League server…' : 'Server not detected'}</strong>
          <span>{connected?.available ? (streamerMode ? 'Current Riot identity hidden' : connected.riotId) : connected?.reason || 'Connect League to detect the signed-in account.'}</span>
          {connected?.available && activeProfile && !sameRiotId(activeProfile.riotId, connected.riotId) && <span className="account-switcher__identity-warning">Current account differs from selected profile. Edit that profile or sign in to its Riot ID.</span>}
        </div>
        {activeProfile && (
          <button type="button" className="btn-primary account-switcher__save-login" onClick={() => void saveCurrentSession()} disabled={busy !== '' || loading || activeRegionMismatch || Boolean(connected?.available && !sameRiotId(activeProfile.riotId, connected.riotId))} title={activeRegionMismatch ? 'Update this profile to the server League reports before saving its login' : undefined}>
            {busy === 'capture' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
            Save current login
          </button>
        )}
      </div>

      {error && <p className="account-switcher__error" role="alert">{error}</p>}

      {adding && (
        <form className="account-switcher__editor" onSubmit={(event) => { event.preventDefault(); void saveProfile(); }}>
          <div className="account-switcher__editor-heading">
            <div>
              <h3>{editingId ? 'Edit account' : 'Add account'}</h3>
              <p>Server detection applies only to the account currently signed in to League.</p>
            </div>
            <button type="button" className="account-switcher__icon-button" onClick={resetDraft} disabled={busy !== ''} aria-label="Close account editor"><X aria-hidden="true" /></button>
          </div>
          {connected?.available && (
            <button type="button" className="account-switcher__detect-button" onClick={useConnectedAccount} disabled={busy !== ''}>
              Use connected account <span>{streamerMode ? connected.region : `${connected.riotId} · ${connected.region}`}</span>
            </button>
          )}
          <div className="account-switcher__fields">
            <label>Profile name<input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Main account" maxLength={48} required autoFocus /></label>
            <label>Riot ID<input value={draft.riotId} onChange={(event) => setDraft((current) => ({ ...current, riotId: event.target.value }))} placeholder="Name#Tag" maxLength={80} type={streamerMode ? 'password' : 'text'} autoComplete="off" /></label>
            <label>League server<select value={draft.region} onChange={(event) => setDraft((current) => ({ ...current, region: event.target.value }))} required>
              <option value="" disabled>Choose a server</option>
              {draft.region && !REGIONS.some((group) => group.options.some(([value]) => value === draft.region)) && <option value={draft.region}>{draft.region} · previously saved</option>}
              {REGIONS.map((group) => <optgroup key={group.group} label={group.group}>{group.options.map(([value, label]) => <option key={value} value={value}>{label} · {value}</option>)}</optgroup>)}
            </select></label>
          </div>
          <details className="account-switcher__advanced">
            <summary>Language and account label</summary>
            <div className="account-switcher__fields">
              <label>Account label<input value={draft.accountLabel} onChange={(event) => setDraft((current) => ({ ...current, accountLabel: event.target.value }))} placeholder="Optional note" maxLength={80} /></label>
              <label>League language<select value={draft.leagueLocale} onChange={(event) => setDraft((current) => ({ ...current, leagueLocale: event.target.value }))}><option value="auto">System default</option>{LOCALES.filter((locale) => locale !== 'auto').map((locale) => <option key={locale} value={locale}>{locale}</option>)}</select></label>
            </div>
          </details>
          <div className="account-switcher__editor-actions">
            <button type="submit" className="btn-primary" disabled={busy !== '' || !draft.name.trim() || !draft.region}>{busy === 'add' && <Loader2 className="animate-spin" aria-hidden="true" />}{editingId ? 'Save changes' : 'Add account'}</button>
            <button type="button" className="btn-secondary" onClick={resetDraft} disabled={busy !== ''}>Cancel</button>
            {editingId && profiles.length > 1 && <button type="button" className="account-switcher__delete" onClick={() => { const profile = profiles.find((item) => item.id === editingId); if (profile) void removeProfile(profile); }} disabled={busy !== ''}><Trash2 aria-hidden="true" /> Delete account</button>}
          </div>
        </form>
      )}

      <div className="account-switcher__list">
        {profiles.map((profile, index) => {
          const active = profile.id === activeProfileId;
          const switching = busy === `switch:${profile.id}`;
          const forceSwitching = busy === `switch:${profile.id}:force`;
          const status = statuses[profile.id];
          const detectedMismatch = active && connected?.available && sameRiotId(profile.riotId, connected.riotId) && profile.region !== connected.region;
          const profileDisplayName = streamerMode ? (active ? 'Main profile' : `Profile ${index + 1}`) : profile.name;
          return (
            <article key={profile.id} className={`account-switcher__row ${active ? 'is-active' : ''}`}>
              <div className="account-switcher__identity">
                <span className="account-switcher__avatar" aria-hidden="true">{profileDisplayName.slice(0, 1).toUpperCase()}</span>
                <div className="account-switcher__identity-copy">
                  <div className="account-switcher__name"><strong>{profileDisplayName}</strong>{active && <span>Selected</span>}</div>
                  <p>{streamerMode ? 'Riot ID hidden' : profile.riotId || 'Riot ID not set'} <span aria-hidden="true">·</span> {profile.region || 'Server not set'}</p>
                  <small className={status?.saved ? 'is-ready' : status?.needsRecapture || status?.expired ? 'is-warning' : ''}>{sessionLabel(status)}</small>
                  {detectedMismatch && <div className="account-switcher__region-note">League reports {connected.region}. <button type="button" onClick={() => void updateDetectedServer(profile)} disabled={busy !== ''}>Update server</button></div>}
                </div>
              </div>
              <div className="account-switcher__row-actions">
                <button type="button" className={active ? 'btn-primary' : 'btn-secondary'} onClick={() => void runSwitch(profile)} disabled={busy !== ''}>
                  {switching ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Zap aria-hidden="true" />}
                  {switching ? 'Switching…' : active ? 'Launch' : status?.saved ? 'Switch' : 'Sign in'}
                </button>
                <button type="button" className="account-switcher__text-button" onClick={() => void runSwitch(profile, true)} disabled={busy !== ''} title="Clear the active Riot login and open a fresh sign-in screen">
                  {forceSwitching ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}Fresh sign-in
                </button>
                <button type="button" className="account-switcher__icon-button" onClick={() => openProfileEditor(profile)} disabled={busy !== ''} aria-label={`Edit ${profileDisplayName}`} title="Edit account"><Pencil aria-hidden="true" /></button>
              </div>
            </article>
          );
        })}
      </div>
      <p className="account-switcher__footnote">Old saved logins need one verified re-save. Riot may still ask you to sign in later.</p>
    </section>
  );
}
