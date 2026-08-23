import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Image, Library, Loader2, Paintbrush, RefreshCw, Search, Sparkles, UserRound, XCircle } from 'lucide-react';
import {
  ddProfileIcon,
  fetchDDragonVersion,
  fetchLCUBackgroundChampions,
  fetchLCUBackgroundSkins,
  fetchLCUOwnedProfileIcons,
  fetchLCUProfileIconMetadata,
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
  const [selectedIcon, setSelectedIcon] = useState(0);
  const [ddVersion, setDDVersion] = useState('');
  const [iconQuery, setIconQuery] = useState('');
  const [iconLimit, setIconLimit] = useState(72);
  const [iconsLoading, setIconsLoading] = useState(true);
  const [iconsError, setIconsError] = useState('');
  const [failedIcons, setFailedIcons] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const loadIcons = useCallback(async () => {
    if (!connected) {
      setIconsLoading(false);
      setIconsError('Launch League and sign in to load your profile icons.');
      return;
    }
    setIconsLoading(true);
    setIconsError('');
    try {
      const [versionResult, metadataResult, inventoryResult] = await Promise.allSettled([
        fetchDDragonVersion(),
        fetchLCUProfileIconMetadata(),
        fetchLCUOwnedProfileIcons(),
      ]);
      if (versionResult.status === 'fulfilled') setDDVersion(versionResult.value.version);
      const owned = new Set<number>();
      if (inventoryResult.status === 'fulfilled') inventoryResult.value.iconIds.forEach((id) => owned.add(Number(id)));
      if ((qol?.profileIconId || 0) > 0) owned.add(qol!.profileIconId);
      const entries = new Map<number, DDProfileIcon>();
      if (metadataResult.status === 'fulfilled') metadataResult.value.forEach((entry) => entries.set(entry.id, {
          id: entry.id,
          image: { full: '', sprite: '', group: 'profileicon' },
          name: entry.title || `Profile icon ${entry.id}`,
          lcuImagePath: entry.imagePath,
        }));
      owned.forEach((id) => {
        if (!entries.has(id)) entries.set(id, { id, image: { full: '', sprite: '', group: 'profileicon' }, name: `Profile icon ${id}` });
      });
      setOwnedIconIds(owned);
      const usable = [...entries.values()].filter((icon) => owned.has(icon.id)).sort((a, b) => a.name.localeCompare(b.name));
      setProfileIcons(usable);
      setSelectedIcon(qol?.profileIconId || 0);
      if (!usable.length) setIconsError('League did not return an owned profile-icon inventory yet. Keep the client open and retry.');
    } catch (reason: any) {
      setIconsError(reason?.message || 'The owned icon catalogue could not be loaded.');
    } finally {
      setIconsLoading(false);
    }
  }, [connected, qol?.profileIconId]);

  useEffect(() => { void loadIcons(); }, [loadIcons]);

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
    return profileIcons.filter((icon) => !query || icon.name.toLowerCase().includes(query) || String(icon.id).includes(query));
  }, [iconQuery, profileIcons]);
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
    if ((background && !selectedSkin) || (!background && !selectedIcon)) return;
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

          {tool === 'icon' && <WorkspaceSection eyebrow="SELECT" title="Owned icon library" description="Select an icon to preview it. The account changes only after Apply.">
            <label className="profile-studio-page__search"><Search /><input name="profile-icon-search" autoComplete="off" value={iconQuery} onChange={(event) => { setIconQuery(event.target.value); setIconLimit(72); }} placeholder="Search owned icons…" aria-label="Search owned profile icons" /><span>{matchingIcons.length}</span></label>
            {iconsLoading && <ActionFeedback state={{ tone: 'working', message: 'Loading owned profile icons…' }} />}
            {!iconsLoading && iconsError && <EmptyState tone="error" icon={XCircle} title="Icon library unavailable" description={iconsError} action={<button type="button" className="btn-secondary" onClick={() => void loadIcons()}><RefreshCw />Retry</button>} />}
            {!iconsLoading && !iconsError && matchingIcons.length === 0 && <EmptyState icon={Search} title="No matching icons" description="Clear the search to see your owned profile icons." />}
            {!iconsLoading && !iconsError && matchingIcons.length > 0 && <div className="profile-studio-page__icon-grid">{visibleIcons.map((icon) => {
              const selected = icon.id === selectedIcon;
              const current = icon.id === qol?.profileIconId;
              return <button type="button" key={icon.id} className={selected ? 'is-selected' : ''} onClick={() => { setSelectedIcon(icon.id); setFeedback(null); }} aria-pressed={selected}><span><img src={iconURL(icon)} alt="" width="54" height="54" loading="lazy" onError={() => setFailedIcons((values) => new Set(values).add(icon.id))} />{selected && <Check />}</span><strong>{icon.name}</strong><small>{current ? 'Current' : `#${icon.id}`}</small></button>;
            })}</div>}
            {visibleIcons.length < matchingIcons.length && <button type="button" className="profile-studio-page__more" onClick={() => setIconLimit((value) => value + 72)}><Library />Load more icons</button>}
          </WorkspaceSection>}
        </main>

        <ContextPanel eyebrow="PREVIEW" title={tool === 'background' ? selectedBackground?.name || 'Profile background' : selectedIconEntry?.name || 'Profile icon'} description={tool === 'background' ? 'Preview the selected League artwork before applying it.' : 'Confirm the icon that will represent your account.'} footer={<><ActionFeedback state={feedback} /><div className="ro-inspector__actions"><button type="button" className="btn-secondary" disabled={busy} onClick={() => { if (tool === 'background') { setSelectedChampion(0); setSelectedSkin(0); } else setSelectedIcon(qol?.profileIconId || 0); setFeedback(null); }}>Reset</button><button type="button" className="btn-primary" disabled={!connected || busy || (tool === 'background' ? !selectedSkin : !selectedIcon)} onClick={() => void apply()}>{busy ? <Loader2 className="animate-spin" /> : <Sparkles />}{busy ? 'Applying…' : 'Apply to League'}</button></div></>}>
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
