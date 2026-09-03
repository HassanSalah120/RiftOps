import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Image, Library, Loader2, Paintbrush, RefreshCw, Search, Sparkles, UserRound, XCircle } from 'lucide-react';
import {
  ddProfileIcon,
  fetchDDProfileIcons,
  fetchDDragonVersion,
  fetchLCUBackgroundChampions,
  fetchLCUBackgroundSkins,
  fetchLCUOwnedProfileIcons,
  fetchLCUProfileIconMetadata,
  fetchLCUProfileRegalia,
  applyProfilePreset,
  deleteProfilePreset,
  fetchProfilePresets,
  previewProfilePreset,
  saveProfilePreset,
  type ProfilePreset,
  type DDProfileIcon,
} from '../api';
import { RiotAssetImage } from '../riotAssets';
import { ActionFeedback, ContextPanel, EmptyState, type FeedbackState, StatusBadge, WorkspaceSection } from './DesignPrimitives';
import PageHeader from './PageHeader';
import { useLCUConnection } from './lcuConnectionContext';

type CatalogueEntry = { id: number; name: string; previewAssetPath?: string };
type StudioTool = 'background' | 'icon';

async function postJSON(path: string, body: object) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.text()).trim() || 'League rejected the profile change.');
}

export default function ProfileStudio() {
  const { connected, qol, refresh } = useLCUConnection();
  const [tool, setTool] = useState<StudioTool>('background');
  const [champions, setChampions] = useState<CatalogueEntry[]>([]);
  const [skins, setSkins] = useState<CatalogueEntry[]>([]);
  const [selectedChampion, setSelectedChampion] = useState(0);
  const [selectedSkin, setSelectedSkin] = useState(0);
  const [catalogueLoading, setCatalogueLoading] = useState(false);
  const [catalogueError, setCatalogueError] = useState('');
  const [profileIcons, setProfileIcons] = useState<DDProfileIcon[]>([]);
  const [ownedIconIds, setOwnedIconIds] = useState<Set<number>>(() => new Set());
  const [ownershipKnown, setOwnershipKnown] = useState(false);
  const [selectedIcon, setSelectedIcon] = useState(0);
  const [ddVersion, setDDVersion] = useState('');
  const [iconQuery, setIconQuery] = useState('');
  const [iconFilter, setIconFilter] = useState<'all' | 'owned'>('all');
  const [iconLimit, setIconLimit] = useState(72);
  const [iconsLoading, setIconsLoading] = useState(true);
  const [iconsError, setIconsError] = useState('');
  const [failedIcons, setFailedIcons] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const statusRef = useRef<HTMLTextAreaElement>(null);
  const [profilePresets, setProfilePresets] = useState<ProfilePreset[]>([]);
  const [presetName, setPresetName] = useState('My profile');
  const [presetBusy, setPresetBusy] = useState('');
  const [regalia, setRegalia] = useState<{ titles: unknown; tokens: unknown; regalia: unknown; mutation: string } | null>(null);

  const loadIcons = useCallback(async () => {
    setIconsLoading(true);
    setIconsError('');
    try {
      const [versionResult, ddragonResult, metadataResult, inventoryResult] = await Promise.allSettled([
        fetchDDragonVersion(),
        fetchDDProfileIcons(),
        connected ? fetchLCUProfileIconMetadata() : Promise.reject(new Error('LCU offline')),
        connected ? fetchLCUOwnedProfileIcons() : Promise.reject(new Error('LCU offline')),
      ]);
      if (versionResult.status === 'fulfilled') setDDVersion(versionResult.value.version);
      const owned = new Set<number>();
      if (inventoryResult.status === 'fulfilled') { inventoryResult.value.iconIds.forEach((id) => owned.add(Number(id))); setOwnershipKnown(inventoryResult.value.complete); } else setOwnershipKnown(false);
      if ((qol?.profileIconId || 0) > 0) owned.add(qol!.profileIconId);
      const entries = new Map<number, DDProfileIcon>();
      if (metadataResult.status === 'fulfilled') metadataResult.value.forEach((entry) => entries.set(entry.id, {
          id: entry.id,
          image: { full: '', sprite: '', group: 'profileicon' },
          name: entry.title || `Profile icon ${entry.id}`,
          lcuImagePath: entry.imagePath,
        }));
      // Data Dragon is the complete, official static catalogue. LCU metadata
      // enriches it with client paths and release details when available.
      if (ddragonResult.status === 'fulfilled') {
        Object.values(ddragonResult.value.data || {}).forEach((entry) => {
          if (!entries.has(entry.id)) entries.set(entry.id, entry);
        });
      }
      owned.forEach((id) => {
        if (!entries.has(id)) entries.set(id, { id, image: { full: '', sprite: '', group: 'profileicon' }, name: `Profile icon ${id}` });
      });
      setOwnedIconIds(owned);
      const catalogue = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
      setProfileIcons(catalogue);
      setSelectedIcon(qol?.profileIconId || 0);
      if (!catalogue.length) setIconsError('League did not return a profile-icon catalogue for this League patch.');
    } catch (reason: any) {
      setIconsError(reason?.message || 'The owned icon catalogue could not be loaded.');
    } finally {
      setIconsLoading(false);
    }
  }, [connected, qol?.profileIconId]);

  useEffect(() => { void loadIcons(); }, [loadIcons]);

  const loadPresets = useCallback(async () => {
    if (!connected) return;
    try { setProfilePresets(await fetchProfilePresets()); } catch { /* Keep the studio usable when the store is unavailable. */ }
  }, [connected]);
  useEffect(() => { void loadPresets(); }, [loadPresets]);
  useEffect(() => {
    if (qol?.statusMessage !== undefined) setStatusMessage(qol.statusMessage || '');
  }, [qol?.statusMessage]);
  useEffect(() => {
    const field = statusRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(Math.max(field.scrollHeight, 52), 180)}px`;
  }, [statusMessage]);
  useEffect(() => { if (!connected) { setRegalia(null); return; } void fetchLCUProfileRegalia().then(setRegalia).catch(() => setRegalia(null)); }, [connected]);

  useEffect(() => {
    if (!connected || champions.length) return;
    setCatalogueLoading(true);
    fetchLCUBackgroundChampions()
      .then((body) => setChampions((Array.isArray(body) ? body : Object.values(body || {}))
        .map((entry: any) => ({ id: Number(entry.id), name: String(entry.name || `Champion ${entry.id}`) }))
        .filter((entry: CatalogueEntry) => entry.id > 0)
        .sort((a: CatalogueEntry, b: CatalogueEntry) => a.name.localeCompare(b.name))))
      .catch((reason) => setCatalogueError(reason?.message || 'Champion catalogue is unavailable.'))
      .finally(() => setCatalogueLoading(false));
  }, [champions.length, connected]);

  useEffect(() => {
    if (!selectedChampion) { setSkins([]); setSelectedSkin(0); return; }
    setCatalogueLoading(true);
    setCatalogueError('');
    fetchLCUBackgroundSkins(selectedChampion)
      .then((body) => setSkins((Array.isArray(body) ? body : Object.values(body || {}))
        .map((entry: any) => ({ id: Number(entry.id), name: String(entry.name || `Skin ${entry.id}`), previewAssetPath: String(entry.previewAssetPath || '') }))
        .filter((entry: CatalogueEntry) => entry.id > 0)
        .sort((a: CatalogueEntry, b: CatalogueEntry) => a.name.localeCompare(b.name))))
      .catch((reason) => setCatalogueError(reason?.message || 'Skin catalogue is unavailable.'))
      .finally(() => setCatalogueLoading(false));
  }, [selectedChampion]);

  const matchingIcons = useMemo(() => {
    const query = iconQuery.trim().toLowerCase();
    return profileIcons.filter((icon) => (iconFilter === 'all' || ownedIconIds.has(icon.id)) && (!query || icon.name.toLowerCase().includes(query) || String(icon.id).includes(query)));
  }, [iconFilter, iconQuery, ownedIconIds, profileIcons]);
  const visibleIcons = matchingIcons.slice(0, iconLimit);
  const selectedBackground = skins.find((entry) => entry.id === selectedSkin);
  const selectedIconEntry = profileIcons.find((entry) => entry.id === selectedIcon);

  const iconURL = (icon: DDProfileIcon) => {
    if (failedIcons.has(icon.id)) return `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${icon.id}.jpg`;
    if (icon.lcuImagePath?.startsWith('/lol-game-data/')) return icon.lcuImagePath;
    return ddVersion ? ddProfileIcon(ddVersion, icon.id) : `https://ddragon.leagueoflegends.com/cdn/img/profileicon/${icon.id}.png`;
  };

  const apply = async () => {
    const background = tool === 'background';
    if ((background && !selectedSkin) || (!background && (!selectedIcon || !ownedIconIds.has(selectedIcon)))) return;
    setBusy(true);
    setFeedback({ tone: 'working', message: background ? 'Applying profile background…' : 'Applying profile icon…' });
    try {
      await postJSON(background ? '/api/lcu/profile-background' : '/api/lcu/profile-icon', background ? { skinId: selectedSkin } : { iconId: selectedIcon });
      await refresh();
      setFeedback({ tone: 'success', message: background ? `${selectedBackground?.name || 'Background'} applied.` : `${selectedIconEntry?.name || 'Profile icon'} applied.` });
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'League rejected the profile change.' });
    } finally {
      setBusy(false);
    }
  };

  const savePreset = async () => {
    if (!presetName.trim()) return;
    setPresetBusy('save');
    try {
      const saved = await saveProfilePreset({ id: `profile-${Date.now().toString(36)}`, name: presetName.trim(), iconId: selectedIcon || undefined, backgroundSkinId: selectedSkin || undefined, statusMessage: statusMessage.slice(0, 255) });
      setProfilePresets((current) => [...current.filter((entry) => entry.id !== saved.id), saved]);
      setFeedback({ tone: 'success', message: 'Profile preset saved locally.' });
    } catch (reason: any) { setFeedback({ tone: 'error', message: reason?.message || 'Could not save profile preset.' }); }
    finally { setPresetBusy(''); }
  };

  const applyPreset = async (preset: ProfilePreset) => {
    setPresetBusy(`apply:${preset.id}`);
    try {
      const preview = await previewProfilePreset(preset.id);
      if (!window.confirm(`Current → proposed\n\nIcon: ${String((preview.current as any)?.iconId || 'unchanged')} → ${preset.iconId || 'unchanged'}\nBackground: ${preset.backgroundSkinId || 'unchanged'}\nStatus: ${preset.statusMessage || 'unchanged'}\n\nApply these values to League?`)) return;
      const result = await applyProfilePreset(preset.id);
      const partial = Object.values(result.results || {}).some((value) => value.startsWith('failed') || value.startsWith('unavailable'));
      setFeedback({ tone: partial ? 'error' : 'success', message: partial ? 'Preset partially applied; review the per-field result.' : 'Profile preset applied.' });
      await refresh();
    } catch (reason: any) { setFeedback({ tone: 'error', message: reason?.message || 'Could not apply profile preset.' }); }
    finally { setPresetBusy(''); }
  };

  return (
    <div className="profile-studio-page">
      <PageHeader variant="collection" icon={UserRound} eyebrow="SUMMONER IDENTITY" title="Profile studio" description="Choose, preview, and apply your League identity without leaving the workspace." meta={<StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>{connected ? 'League connected' : 'League offline'}</StatusBadge>} />

      <div className="profile-studio-page__layout">
        <main className="profile-studio-page__workspace">
          <nav className="profile-studio-page__tools" aria-label="Profile customization tools">
            <button type="button" className={tool === 'background' ? 'is-active' : ''} onClick={() => { setTool('background'); setFeedback(null); }}><Paintbrush /><span><strong>Profile background</strong><small>Any champion skin</small></span></button>
            <button type="button" className={tool === 'icon' ? 'is-active' : ''} onClick={() => { setTool('icon'); setFeedback(null); }}><UserRound /><span><strong>Profile icon</strong><small>{ownedIconIds.size} owned icons</small></span></button>
          </nav>

          {tool === 'background' && <WorkspaceSection eyebrow="SELECT" title="Choose the scene" description="Champion first, then the skin. Your choice appears in the inspector before anything changes in League.">
            <div className="profile-studio-page__selectors">
              <label><span>Champion</span><select value={selectedChampion || ''} disabled={!connected || catalogueLoading} onChange={(event) => { setSelectedChampion(Number(event.target.value)); setSelectedSkin(0); setFeedback(null); }}><option value="">Choose champion</option>{champions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
              <label><span>Skin</span><select value={selectedSkin || ''} disabled={!selectedChampion || catalogueLoading} onChange={(event) => { setSelectedSkin(Number(event.target.value)); setFeedback(null); }}><option value="">Choose skin</option>{skins.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
            </div>
            {catalogueLoading && <ActionFeedback state={{ tone: 'working', message: 'Loading League cosmetics…' }} />}
            {catalogueError && <ActionFeedback state={{ tone: 'error', message: catalogueError }} />}
          </WorkspaceSection>}

          <WorkspaceSection eyebrow="PRESETS" title="Profile presets" description="Save a named identity and compare its fields before applying. Ownership is checked again by League at apply time.">
            <div className="profile-studio-page__preset-create"><input value={presetName} maxLength={48} onChange={(event) => setPresetName(event.target.value)} aria-label="Profile preset name" placeholder="Preset name" /><button type="button" className="btn-secondary" onClick={() => void savePreset()} disabled={!connected || presetBusy !== '' || !presetName.trim()}><Sparkles />{presetBusy === 'save' ? 'Saving…' : 'Save current'}</button></div>
            {profilePresets.length === 0 && <p className="profile-studio-page__preset-empty">No saved presets for this League account.</p>}
            <div className="profile-studio-page__preset-list">{profilePresets.map((preset) => <div key={preset.id}><span><strong>{preset.name}</strong><small>{preset.iconId ? `Icon #${preset.iconId}` : 'Icon unchanged'} · {preset.backgroundSkinId ? `Skin #${preset.backgroundSkinId}` : 'Background unchanged'}</small></span><button type="button" className="btn-primary" onClick={() => void applyPreset(preset)} disabled={!connected || presetBusy !== ''}><Check />{presetBusy === `apply:${preset.id}` ? 'Applying…' : 'Preview & apply'}</button><button type="button" className="btn-danger" onClick={() => { if (window.confirm(`Delete ${preset.name}?`)) { setPresetBusy(`delete:${preset.id}`); void deleteProfilePreset(preset.id).then(() => setProfilePresets((current) => current.filter((entry) => entry.id !== preset.id))).catch((reason: any) => setFeedback({ tone: 'error', message: reason?.message || 'Could not delete preset.' })).finally(() => setPresetBusy('')); } }} disabled={presetBusy !== ''} aria-label={`Delete ${preset.name}`}><XCircle /></button></div>)}</div>
          </WorkspaceSection>

          <WorkspaceSection eyebrow="STATUS" title="Profile status" description="Set the message friends see. RiftOps validates the 255-character limit before sending it to League.">
            <div className="profile-studio-page__status-editor"><textarea ref={statusRef} value={statusMessage} maxLength={255} rows={2} onChange={(event) => setStatusMessage(event.target.value)} placeholder="What should friends see?" aria-label="Profile status message" /><div><span>{statusMessage.length}/255</span><button type="button" className="btn-secondary" disabled={!connected || busy || statusBusy} onClick={() => { setStatusBusy(true); void postJSON('/api/lcu/status-message', { message: statusMessage.trim() }).then(() => setFeedback({ tone: 'success', message: 'Status message updated.' })).catch((reason: any) => setFeedback({ tone: 'error', message: reason?.message || 'League rejected the status message.' })).finally(() => setStatusBusy(false)); }}><Check />{statusBusy ? 'Applying…' : 'Apply status'}</button></div></div>
          </WorkspaceSection>

          <WorkspaceSection eyebrow="REGALIA" title="Titles & banners" description="League-owned challenge titles, tokens, banners, and crests are shown when this client exposes them. Mutation stays disabled until ownership semantics are stable.">
            {regalia ? <div className="profile-studio-page__regalia"><span><strong>Titles</strong><small>{Array.isArray(regalia.titles) ? `${regalia.titles.length} available` : 'Catalogue available'}</small></span><span><strong>Challenge tokens</strong><small>{Array.isArray(regalia.tokens) ? `${regalia.tokens.length} available` : 'Catalogue available'}</small></span><span><strong>Current regalia</strong><small>{regalia.regalia ? 'Loaded' : 'Not exposed'}</small></span><em>{regalia.mutation}</em></div> : <p className="profile-studio-page__ownership-note">Unavailable for this League patch.</p>}
          </WorkspaceSection>

          {tool === 'icon' && <WorkspaceSection eyebrow="SELECT" title="Profile icon library" description="Browse every official icon. Unowned icons are preview-only; Apply is enabled only for verified account inventory.">
            <div className="profile-studio-page__icon-toolbar"><label className="profile-studio-page__search"><Search /><input name="profile-icon-search" autoComplete="off" value={iconQuery} onChange={(event) => { setIconQuery(event.target.value); setIconLimit(72); }} placeholder="Search icons…" aria-label="Search profile icons" /><span>{matchingIcons.length}</span></label><div className="segmented-control" role="group" aria-label="Icon ownership filter"><button type="button" className={iconFilter === 'all' ? 'is-active' : ''} onClick={() => setIconFilter('all')}>All</button><button type="button" className={iconFilter === 'owned' ? 'is-active' : ''} onClick={() => setIconFilter('owned')}>Owned · {ownedIconIds.size}</button></div></div>
            {!ownershipKnown && !iconsLoading && <p className="profile-studio-page__ownership-note">Ownership is not fully available from League yet. Icons remain preview-only until the client confirms ownership.</p>}
            {iconsLoading && <ActionFeedback state={{ tone: 'working', message: 'Loading the official profile icon catalogue…' }} />}
            {!iconsLoading && iconsError && <EmptyState tone="error" icon={XCircle} title="Icon library unavailable" description={iconsError} action={<button type="button" className="btn-secondary" onClick={() => void loadIcons()}><RefreshCw />Retry</button>} />}
            {!iconsLoading && !iconsError && matchingIcons.length === 0 && <EmptyState icon={Search} title="No matching icons" description="Clear the search or switch to All icons." />}
            {!iconsLoading && !iconsError && matchingIcons.length > 0 && <div className="profile-studio-page__icon-grid">{visibleIcons.map((icon) => {
              const selected = icon.id === selectedIcon;
              const current = icon.id === qol?.profileIconId;
              const owned = ownedIconIds.has(icon.id);
              return <button type="button" key={icon.id} className={`${selected ? 'is-selected' : ''} ${owned ? '' : 'is-unowned'}`} onClick={() => { if (owned) { setSelectedIcon(icon.id); setFeedback(null); } }} aria-pressed={selected} aria-disabled={!owned}><span><img src={iconURL(icon)} alt="" width="54" height="54" loading="lazy" onError={() => setFailedIcons((values) => new Set(values).add(icon.id))} />{selected && <Check />}</span><strong>{icon.name}</strong><small>{current ? 'Current · Owned' : owned ? 'Owned' : 'Not owned · Preview'}</small></button>;
            })}</div>}
            {visibleIcons.length < matchingIcons.length && <button type="button" className="profile-studio-page__more" onClick={() => setIconLimit((value) => value + 72)}><Library />Load more icons</button>}
          </WorkspaceSection>}
        </main>

        <ContextPanel
          eyebrow="PREVIEW"
          title={tool === 'background' ? selectedBackground?.name || 'Profile background' : selectedIconEntry?.name || 'Profile icon'}
          description={tool === 'background' ? 'Preview the selected League artwork before applying it.' : 'Confirm the icon that will represent your account.'}
          footer={<><ActionFeedback state={feedback} /><div className="ro-inspector__actions"><button type="button" className="btn-secondary" disabled={busy} onClick={() => { if (tool === 'background') { setSelectedChampion(0); setSelectedSkin(0); } else setSelectedIcon(qol?.profileIconId || 0); setFeedback(null); }}>Reset</button><button type="button" className="btn-primary" disabled={!connected || busy || (tool === 'background' ? !selectedSkin : !selectedIcon || !ownedIconIds.has(selectedIcon))} onClick={() => void apply()}>{busy ? <Loader2 className="animate-spin" /> : <Sparkles />}{busy ? 'Applying…' : 'Apply to League'}</button></div></>}
        >
          <div className={`profile-studio-page__preview is-${tool}`}>
            {tool === 'background' ? selectedBackground ? <RiotAssetImage path={selectedBackground.previewAssetPath} alt={`${selectedBackground.name} profile background preview`} fallback={<div className="profile-studio-page__preview-empty"><Image /><span>Artwork unavailable; the skin can still be applied.</span></div>} /> : <div className="profile-studio-page__preview-empty"><Image /><span>Select a champion and skin to begin.</span></div> : selectedIconEntry ? <img src={iconURL(selectedIconEntry)} width="148" height="148" alt={`${selectedIconEntry.name} preview`} /> : <div className="profile-studio-page__preview-empty"><UserRound /><span>Select an owned icon to begin.</span></div>}
            <span className="profile-studio-page__preview-shade" />
            <div className="profile-studio-page__preview-identity"><i>{tool === 'icon' && selectedIconEntry ? <img src={iconURL(selectedIconEntry)} width="38" height="38" alt="" /> : <UserRound />}</i><span><strong>Summoner identity</strong><small>{connected ? 'Ready to apply' : 'Waiting for League'}</small></span></div>
          </div>
        </ContextPanel>
      </div>
    </div>
  );
}
