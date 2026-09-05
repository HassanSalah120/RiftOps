import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Crown,
  Image,
  Library,
  Loader2,
  Paintbrush,
  RefreshCw,
  Search,
  Shield,
  Sliders,
  Sparkles,
  Trash2,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import {
  ddProfileIcon,
  fetchDDProfileIcons,
  fetchDDragonVersion,
  fetchLCUBackgroundChampions,
  fetchLCUBackgroundSkins,
  fetchLCUOwnedProfileIcons,
  fetchLCUProfileIconMetadata,
  fetchLCUProfileRegalia,
  applyLCUProfileRegalia,
  applyProfilePreset,
  deleteProfilePreset,
  fetchProfilePresets,
  previewProfilePreset,
  saveProfilePreset,
  fetchLCUProfile,
  type LCUSummoner,
  type ProfilePreset,
  type DDProfileIcon,
  type ProfileRegaliaInventory,
} from '../api';
import { RiotAssetImage } from '../riotAssets';
import type { ConfirmAction } from '../types';
import ConfirmModal from './ConfirmModal';
import { ActionFeedback, ContextPanel, EmptyState, type FeedbackState, StatusBadge, WorkspaceSection } from './DesignPrimitives';
import PageHeader from './PageHeader';
import { useLCUConnection } from './lcuConnectionContext';

type CatalogueEntry = { id: number; name: string; previewAssetPath?: string };
type StudioTool = 'background' | 'icon' | 'regalia' | 'presets';

async function postJSON(path: string, body: object) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.text()).trim() || 'League rejected the profile change.');
}

export default function ProfileStudio({ remoteClient: _remoteClient = false }: { remoteClient?: boolean } = {}) {
  const { connected, qol, refresh, streamerMode } = useLCUConnection();
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
  const [regalia, setRegalia] = useState<ProfileRegaliaInventory | null>(null);
  const [selectedTitleId, setSelectedTitleId] = useState(0);
  const [selectedTokenIds, setSelectedTokenIds] = useState<number[]>([]);
  const [selectedBannerAccent, setSelectedBannerAccent] = useState('');
  const [selectedCrestId, setSelectedCrestId] = useState(0);
  const [regaliaBusy, setRegaliaBusy] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmAction | null>(null);
  const [summoner, setSummoner] = useState<LCUSummoner | null>(null);

  useEffect(() => {
    if (!connected) { setSummoner(null); return; }
    void fetchLCUProfile().then((p) => setSummoner(p.summoner)).catch(() => setSummoner(null));
  }, [connected]);

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
      if (inventoryResult.status === 'fulfilled') {
        inventoryResult.value.iconIds.forEach((id) => owned.add(Number(id)));
        setOwnershipKnown(inventoryResult.value.complete);
      } else {
        setOwnershipKnown(false);
      }
      if ((qol?.profileIconId || 0) > 0) owned.add(qol!.profileIconId);
      const entries = new Map<number, DDProfileIcon>();
      if (metadataResult.status === 'fulfilled') {
        metadataResult.value.forEach((entry) => entries.set(entry.id, {
          id: entry.id,
          image: { full: '', sprite: '', group: 'profileicon' },
          name: entry.title || `Profile icon ${entry.id}`,
          lcuImagePath: entry.imagePath,
        }));
      }
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

  useEffect(() => {
    if (!connected) { setRegalia(null); return; }
    void fetchLCUProfileRegalia().then((next) => {
      setRegalia(next);
      const current = next.current || {};
      const title = current.title && typeof current.title === 'object' ? Number((current.title as Record<string, unknown>).itemId) : Number(current.title);
      const top = Array.isArray(current.topChallenges) ? current.topChallenges.map((entry: any) => Number(entry?.id)).filter((id) => id > 0).slice(0, 3) : [];
      setSelectedTitleId(title > 0 ? title : 0);
      setSelectedTokenIds(top);
      setSelectedBannerAccent(String(current.bannerId || current.bannerAccent || ''));
      setSelectedCrestId(Number(current.selectedPrestigeCrest) || 0);
    }).catch(() => setRegalia(null));
  }, [connected]);

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
  const selectedTitleName = regalia?.titles.find((t) => Number(t.id) === selectedTitleId)?.name;

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
      const crest = regalia?.crests.find((entry) => Number(entry.id) === selectedCrestId);
      const banner = regalia?.banners.find((entry) => entry.id === selectedBannerAccent);
      const saved = await saveProfilePreset({
        id: `profile-${Date.now().toString(36)}`,
        name: presetName.trim(),
        iconId: selectedIcon || undefined,
        backgroundSkinId: selectedSkin || undefined,
        titleId: selectedTitleId || undefined,
        tokenIds: selectedTokenIds,
        bannerAccent: selectedBannerAccent || undefined,
        preferredBannerType: banner?.regaliaType,
        preferredCrestType: crest?.regaliaType,
        selectedPrestigeCrest: selectedCrestId || undefined,
        statusMessage: statusMessage.slice(0, 255),
      });
      setProfilePresets((current) => [...current.filter((entry) => entry.id !== saved.id), saved]);
      setFeedback({ tone: 'success', message: 'Profile preset saved locally.' });
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'Could not save profile preset.' });
    } finally {
      setPresetBusy('');
    }
  };

  const applyRegalia = async () => {
    if (!regalia) return;
    const crest = regalia.crests.find((entry) => Number(entry.id) === selectedCrestId);
    const banner = regalia.banners.find((entry) => entry.id === selectedBannerAccent);
    setRegaliaBusy(true);
    try {
      const result = await applyLCUProfileRegalia({
        titleId: selectedTitleId || undefined,
        tokenIds: selectedTokenIds,
        bannerAccent: selectedBannerAccent || undefined,
        preferredBannerType: banner?.regaliaType,
        preferredCrestType: crest?.regaliaType,
        selectedPrestigeCrest: selectedCrestId || undefined,
      });
      const partial = Object.values(result.results).some((value) => value.startsWith('failed') || value.startsWith('skipped') || value.startsWith('unavailable') || value.startsWith('waiting'));
      setFeedback({ tone: partial ? 'error' : 'success', message: partial ? 'Some identity fields could not be applied; League ownership was preserved.' : 'Profile title, tokens, banner, and crest applied.' });
      await refresh();
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'League rejected the regalia change.' });
    } finally {
      setRegaliaBusy(false);
    }
  };

  const requestApplyPreset = async (preset: ProfilePreset) => {
    setPresetBusy(`apply:${preset.id}`);
    try {
      const preview = await previewProfilePreset(preset.id);
      const current = (preview.current && typeof preview.current === 'object' ? preview.current : {}) as Record<string, unknown>;
      const currentRegalia = current.regalia && typeof current.regalia === 'object' ? current.regalia as Record<string, unknown> : {};
      const currentTokens = Array.isArray(currentRegalia.topChallenges) ? currentRegalia.topChallenges.map((entry: any) => entry?.id).filter(Boolean).join(', ') : 'unchanged';
      const proposedTokens = preset.tokenIds?.length ? preset.tokenIds.join(', ') : 'unchanged';
      const diffLines = [
        'Review identity changes before applying to League:',
        '',
        `• Icon: ${String(current.iconId || 'unchanged')} → ${preset.iconId || 'unchanged'}`,
        `• Background: ${String(current.backgroundSkinId || 'unchanged')} → ${preset.backgroundSkinId || 'unchanged'}`,
        `• Title: ${String(currentRegalia.title || 'unchanged')} → ${preset.titleId || 'unchanged'}`,
        `• Tokens: ${currentTokens} → ${proposedTokens}`,
        `• Banner: ${String(currentRegalia.bannerAccent || currentRegalia.bannerId || 'unchanged')} → ${preset.bannerAccent || 'unchanged'}`,
        `• Crest: ${String(currentRegalia.selectedPrestigeCrest || 'unchanged')} → ${preset.selectedPrestigeCrest || 'unchanged'}`,
        `• Status: ${String(current.statusMessage || 'unchanged')} → ${preset.statusMessage || 'unchanged'}`,
      ].join('\n');

      setConfirmModal({
        open: true,
        title: `Apply Preset "${preset.name}"`,
        message: diffLines,
        actionLabel: 'Apply Preset',
        danger: false,
        onConfirm: async () => {
          setConfirmModal(null);
          try {
            const result = await applyProfilePreset(preset.id, preview.previewId);
            const partial = Object.values(result.results || {}).some((value) => value.startsWith('failed') || value.startsWith('skipped') || value.startsWith('unavailable') || value.startsWith('waiting'));
            setFeedback({ tone: partial ? 'error' : 'success', message: partial ? 'Preset partially applied; review per-field result.' : 'Profile preset applied.' });
            await refresh();
          } catch (err: any) {
            setFeedback({ tone: 'error', message: err?.message || 'Could not apply profile preset.' });
          }
        },
      });
    } catch (reason: any) {
      setFeedback({ tone: 'error', message: reason?.message || 'Could not prepare preset diff.' });
    } finally {
      setPresetBusy('');
    }
  };

  const requestDeletePreset = (preset: ProfilePreset) => {
    setConfirmModal({
      open: true,
      title: 'Delete Preset',
      message: `Delete profile preset "${preset.name}"? This action cannot be undone.`,
      actionLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        setConfirmModal(null);
        setPresetBusy(`delete:${preset.id}`);
        void deleteProfilePreset(preset.id)
          .then(() => setProfilePresets((current) => current.filter((entry) => entry.id !== preset.id)))
          .catch((reason: any) => setFeedback({ tone: 'error', message: reason?.message || 'Could not delete preset.' }))
          .finally(() => setPresetBusy(''));
      },
    });
  };

  // Challenge Token Slot Handlers
  const handleAssignToken = (slotIndex: number, tokenId: number) => {
    setSelectedTokenIds((prev) => {
      const next = [...prev];
      if (tokenId === 0) {
        next.splice(slotIndex, 1);
      } else {
        next[slotIndex] = tokenId;
      }
      return next.filter((id) => id > 0).slice(0, 3);
    });
  };

  return (
    <div className="profile-studio-page">
      <PageHeader
        variant="collection"
        icon={UserRound}
        eyebrow="SUMMONER IDENTITY"
        title="Profile studio"
        description="Choose, preview, and apply your League identity without leaving the workspace."
        meta={<StatusBadge tone={connected ? 'live' : 'neutral'} pulse={connected}>{connected ? 'League connected' : 'League offline'}</StatusBadge>}
      />

      <div className="profile-studio-page__layout">
        <main className="profile-studio-page__workspace">
          {/* Sub-Navigation Category Tabs */}
          <nav className="profile-studio-page__tools" aria-label="Profile customization categories">
            <button
              type="button"
              className={tool === 'background' ? 'is-active' : ''}
              onClick={() => { setTool('background'); setFeedback(null); }}
            >
              <Paintbrush />
              <span>
                <strong>Background Artwork</strong>
                <small>Champion & skin scenes</small>
              </span>
            </button>
            <button
              type="button"
              className={tool === 'icon' ? 'is-active' : ''}
              onClick={() => { setTool('icon'); setFeedback(null); }}
            >
              <UserRound />
              <span>
                <strong>Profile Icon</strong>
                <small>{ownedIconIds.size} owned icons</small>
              </span>
            </button>
            <button
              type="button"
              className={tool === 'regalia' ? 'is-active' : ''}
              onClick={() => { setTool('regalia'); setFeedback(null); }}
            >
              <Crown />
              <span>
                <strong>Regalia & Banners</strong>
                <small>Titles, tokens & crests</small>
              </span>
            </button>
            <button
              type="button"
              className={tool === 'presets' ? 'is-active' : ''}
              onClick={() => { setTool('presets'); setFeedback(null); }}
            >
              <Sliders />
              <span>
                <strong>Presets & Status</strong>
                <small>{profilePresets.length} saved presets</small>
              </span>
            </button>
          </nav>

          {/* TAB 1: BACKGROUND ARTWORK */}
          {tool === 'background' && (
            <WorkspaceSection eyebrow="SELECT" title="Choose the scene" description="Champion first, then the skin. Your choice appears in the live summoner inspector before applying.">
              <div className="profile-studio-page__selectors">
                <label>
                  <span>Champion</span>
                  <select
                    value={selectedChampion || ''}
                    disabled={!connected || catalogueLoading}
                    onChange={(event) => { setSelectedChampion(Number(event.target.value)); setSelectedSkin(0); setFeedback(null); }}
                  >
                    <option value="">Choose champion</option>
                    {champions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                  </select>
                </label>
                <label>
                  <span>Skin</span>
                  <select
                    value={selectedSkin || ''}
                    disabled={!selectedChampion || catalogueLoading}
                    onChange={(event) => { setSelectedSkin(Number(event.target.value)); setFeedback(null); }}
                  >
                    <option value="">Choose skin</option>
                    {skins.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                  </select>
                </label>
              </div>
              {catalogueLoading && <ActionFeedback state={{ tone: 'working', message: 'Loading League cosmetics…' }} />}
              {catalogueError && <ActionFeedback state={{ tone: 'error', message: catalogueError }} />}
            </WorkspaceSection>
          )}

          {/* TAB 2: PROFILE ICON */}
          {tool === 'icon' && (
            <WorkspaceSection eyebrow="SELECT" title="Profile icon library" description="Browse every official icon. Unowned icons are preview-only; Apply is enabled only for verified account inventory.">
              <div className="profile-studio-page__icon-toolbar">
                <label className="profile-studio-page__search">
                  <Search />
                  <input
                    name="profile-icon-search"
                    autoComplete="off"
                    value={iconQuery}
                    onChange={(event) => { setIconQuery(event.target.value); setIconLimit(72); }}
                    placeholder="Search icons…"
                    aria-label="Search profile icons"
                  />
                  <span>{matchingIcons.length}</span>
                </label>
                <div className="segmented-control" role="group" aria-label="Icon ownership filter">
                  <button type="button" className={iconFilter === 'all' ? 'is-active' : ''} onClick={() => setIconFilter('all')}>
                    All
                  </button>
                  <button type="button" className={iconFilter === 'owned' ? 'is-active' : ''} onClick={() => setIconFilter('owned')}>
                    Owned · {ownedIconIds.size}
                  </button>
                </div>
              </div>
              {!ownershipKnown && !iconsLoading && (
                <p className="profile-studio-page__ownership-note">Ownership is not fully available from League yet. Icons remain preview-only until the client confirms ownership.</p>
              )}
              {iconsLoading && <ActionFeedback state={{ tone: 'working', message: 'Loading the official profile icon catalogue…' }} />}
              {!iconsLoading && iconsError && (
                <EmptyState tone="error" icon={XCircle} title="Icon library unavailable" description={iconsError} action={<button type="button" className="btn-secondary" onClick={() => void loadIcons()}><RefreshCw />Retry</button>} />
              )}
              {!iconsLoading && !iconsError && matchingIcons.length === 0 && (
                <EmptyState icon={Search} title="No matching icons" description="Clear the search or switch to All icons." />
              )}
              {!iconsLoading && !iconsError && matchingIcons.length > 0 && (
                <div className="profile-studio-page__icon-grid">
                  {visibleIcons.map((icon) => {
                    const selected = icon.id === selectedIcon;
                    const current = icon.id === qol?.profileIconId;
                    const owned = ownedIconIds.has(icon.id);
                    return (
                      <button
                        type="button"
                        key={icon.id}
                        className={`${selected ? 'is-selected' : ''} ${owned ? '' : 'is-unowned'}`}
                        onClick={() => { if (owned) { setSelectedIcon(icon.id); setFeedback(null); } }}
                        aria-pressed={selected}
                        aria-disabled={!owned}
                      >
                        <span>
                          <img src={iconURL(icon)} alt="" width="54" height="54" loading="lazy" onError={() => setFailedIcons((values) => new Set(values).add(icon.id))} />
                          {selected && <Check />}
                        </span>
                        <strong>{icon.name}</strong>
                        <small>{current ? 'Current · Owned' : owned ? 'Owned' : 'Not owned · Preview'}</small>
                      </button>
                    );
                  })}
                </div>
              )}
              {visibleIcons.length < matchingIcons.length && (
                <button type="button" className="profile-studio-page__more" onClick={() => setIconLimit((value) => value + 72)}>
                  <Library /> Load more icons
                </button>
              )}
            </WorkspaceSection>
          )}

          {/* TAB 3: REGALIA & BANNERS */}
          {tool === 'regalia' && (
            <WorkspaceSection eyebrow="REGALIA" title="Titles, challenge tokens & banners" description="Only items returned by League for the signed-in account can be applied. Ownership is rechecked immediately before every change.">
              {regalia ? (
                <div className="profile-studio-page__regalia-editor space-y-5">
                  <div className="profile-studio-page__regalia-grid">
                    <label>
                      <span>Challenge title</span>
                      <select value={selectedTitleId || ''} onChange={(event) => setSelectedTitleId(Number(event.target.value))}>
                        <option value="">No change</option>
                        {regalia.titles.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>Banner accent</span>
                      <select value={selectedBannerAccent} onChange={(event) => setSelectedBannerAccent(event.target.value)}>
                        <option value="">No change</option>
                        {regalia.banners.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>Prestige crest</span>
                      <select value={selectedCrestId || ''} onChange={(event) => setSelectedCrestId(Number(event.target.value))}>
                        <option value="">No change</option>
                        {regalia.crests.filter((entry) => Number(entry.id) > 0).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                      </select>
                    </label>
                  </div>

                  {/* Visual 3-Slot Challenge Token Picker */}
                  <div className="p-4 rounded-2xl bg-black/40 border border-white/[0.08] space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <strong className="text-xs font-black text-white block">Equipped Challenge Tokens (3 Slots)</strong>
                        <span className="text-[11px] text-text-muted">Pick up to 3 challenge badges displayed on your summoner profile.</span>
                      </div>
                      <span className="text-xs font-mono font-bold text-primary px-2.5 py-0.5 rounded-full bg-primary/10 border border-primary/20">
                        {selectedTokenIds.length}/3 equipped
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      {[0, 1, 2].map((slotIdx) => {
                        const tokenId = selectedTokenIds[slotIdx];
                        const tokenObj = regalia.tokens.find((t) => Number(t.id) === tokenId);
                        return (
                          <div key={slotIdx} className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] flex flex-col gap-2 relative group hover:border-primary/40 transition">
                            <div className="flex items-center justify-between text-[11px] text-text-dim font-bold">
                              <span>Slot #{slotIdx + 1}</span>
                              {tokenId ? (
                                <button
                                  type="button"
                                  onClick={() => handleAssignToken(slotIdx, 0)}
                                  className="text-text-dim hover:text-danger p-0.5 transition cursor-pointer"
                                  title="Clear token slot"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2 min-h-[36px]">
                              <Shield className={`w-5 h-5 shrink-0 ${tokenId ? 'text-primary' : 'text-text-dim/40'}`} />
                              <span className="text-xs font-bold text-white truncate">
                                {tokenObj?.name || <em className="text-text-dim font-normal">Empty slot</em>}
                              </span>
                            </div>
                            <select
                              value={tokenId || ''}
                              onChange={(e) => handleAssignToken(slotIdx, Number(e.target.value))}
                              className="w-full text-[11px] p-1.5 rounded-lg bg-black/60 border border-white/10 text-text-muted hover:text-white transition cursor-pointer"
                              aria-label={`Select token for slot ${slotIdx + 1}`}
                            >
                              <option value="">{tokenId ? 'Change token…' : '+ Assign token…'}</option>
                              {regalia.tokens.map((token) => (
                                <option key={token.id} value={token.id}>
                                  {token.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="profile-studio-page__regalia-action">
                    <span>
                      <Crown />
                      <small>{regalia.titles.length} titles · {regalia.tokens.length} tokens · {regalia.banners.length} banners · {regalia.crests.length} crests</small>
                    </span>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={regaliaBusy || (!selectedTitleId && !selectedTokenIds.length && !selectedBannerAccent && !selectedCrestId)}
                      onClick={() => void applyRegalia()}
                    >
                      {regaliaBusy ? <Loader2 className="animate-spin" /> : <Check />}
                      {regaliaBusy ? 'Applying…' : 'Apply owned regalia'}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="profile-studio-page__ownership-note">Unavailable for this League patch.</p>
              )}
            </WorkspaceSection>
          )}

          {/* TAB 4: PRESETS & STATUS */}
          {tool === 'presets' && (
            <div className="space-y-4">
              <WorkspaceSection eyebrow="PRESETS" title="Profile presets" description="Save a named identity snapshot and compare its fields before applying. Ownership is checked again by League at apply time.">
                <div className="profile-studio-page__preset-create">
                  <input
                    value={presetName}
                    maxLength={48}
                    onChange={(event) => setPresetName(event.target.value)}
                    aria-label="Profile preset name"
                    placeholder="Preset name"
                  />
                  <button type="button" className="btn-secondary" onClick={() => void savePreset()} disabled={!connected || presetBusy !== '' || !presetName.trim()}>
                    <Sparkles />
                    {presetBusy === 'save' ? 'Saving…' : 'Save current snapshot'}
                  </button>
                </div>
                {profilePresets.length === 0 && <p className="profile-studio-page__preset-empty">No saved presets for this League account.</p>}
                <div className="profile-studio-page__preset-list">
                  {profilePresets.map((preset) => (
                    <div key={preset.id}>
                      <span>
                        <strong>{preset.name}</strong>
                        <small>
                          {preset.iconId ? `Icon #${preset.iconId}` : 'Icon unchanged'} · {preset.backgroundSkinId ? `Skin #${preset.backgroundSkinId}` : 'Background unchanged'}
                        </small>
                      </span>
                      <button type="button" className="btn-primary" onClick={() => void requestApplyPreset(preset)} disabled={!connected || presetBusy !== ''}>
                        <Check />
                        {presetBusy === `apply:${preset.id}` ? 'Applying…' : 'Preview & apply'}
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => requestDeletePreset(preset)}
                        disabled={presetBusy !== ''}
                        aria-label={`Delete ${preset.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </WorkspaceSection>

              <WorkspaceSection eyebrow="STATUS" title="Profile status message" description="Set the custom status text friends see under your summoner name. RiftOps validates the 255-character limit before sending to League.">
                <div className="profile-studio-page__status-editor">
                  <textarea
                    ref={statusRef}
                    value={statusMessage}
                    maxLength={255}
                    rows={2}
                    onChange={(event) => setStatusMessage(event.target.value)}
                    placeholder="What should friends see?"
                    aria-label="Profile status message"
                  />
                  <div>
                    <span>{statusMessage.length}/255</span>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={!connected || busy || statusBusy}
                      onClick={() => {
                        setStatusBusy(true);
                        void postJSON('/api/lcu/status-message', { message: statusMessage.trim() })
                          .then(() => setFeedback({ tone: 'success', message: 'Status message updated.' }))
                          .catch((reason: any) => setFeedback({ tone: 'error', message: reason?.message || 'League rejected the status message.' }))
                          .finally(() => setStatusBusy(false));
                      }}
                    >
                      <Check />
                      {statusBusy ? 'Applying…' : 'Apply status'}
                    </button>
                  </div>
                </div>
              </WorkspaceSection>
            </div>
          )}
        </main>

        {/* RIGHT PANEL: LIVE AUTHENTIC SUMMONER CARD COMPOSITE */}
        <ContextPanel
          eyebrow="LIVE IDENTITY PREVIEW"
          title={selectedBackground?.name || (selectedIconEntry?.name ?? 'Summoner Card')}
          description="Composite preview of how your summoner card, background artwork, regalia and title appear to others."
          footer={(
            <>
              <ActionFeedback state={feedback} />
              <div className="ro-inspector__actions">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    if (tool === 'background') {
                      setSelectedChampion(0);
                      setSelectedSkin(0);
                    } else if (tool === 'icon') {
                      setSelectedIcon(qol?.profileIconId || 0);
                    }
                    setFeedback(null);
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!connected || busy || (tool === 'background' ? !selectedSkin : tool === 'icon' ? !selectedIcon || !ownedIconIds.has(selectedIcon) : false)}
                  onClick={() => void apply()}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
                  {busy ? 'Applying…' : 'Apply to League'}
                </button>
              </div>
            </>
          )}
        >
          {/* Authentic League Summoner Card Composite */}
          <div className="summoner-card-composite relative rounded-2xl overflow-hidden border border-white/10 shadow-2xl bg-[#091422]">
            {/* Background Artwork Banner */}
            <div className="summoner-card-composite__artwork h-44 w-full relative overflow-hidden bg-black/60">
              {selectedBackground ? (
                <RiotAssetImage
                  path={selectedBackground.previewAssetPath}
                  alt={`${selectedBackground.name} background`}
                  className="w-full h-full object-cover object-center"
                  fallback={<div className="profile-studio-page__preview-empty"><Image /><span>Skin artwork loading…</span></div>}
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-b from-[#1c2d3d] via-[#0f1923] to-[#091422] flex items-center justify-center text-text-dim text-xs">
                  <span>Current League Background</span>
                </div>
              )}
              {/* Vignette Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-[#091422] via-[#091422]/60 to-transparent" />
            </div>

            {/* Summoner Identity Composite Overlay */}
            <div className="summoner-card-composite__body p-4 pt-0 relative -mt-12 flex flex-col gap-3">
              <div className="flex items-end gap-3">
                {/* Profile Icon Avatar with Radiant Crest */}
                <div className="relative shrink-0">
                  <div className="w-20 h-20 rounded-full border-2 border-primary/60 shadow-[0_0_20px_rgba(200,170,110,0.3)] bg-black/80 overflow-hidden p-0.5">
                    {selectedIconEntry ? (
                      <img src={iconURL(selectedIconEntry)} alt="" className="w-full h-full rounded-full object-cover" />
                    ) : qol?.profileIconId ? (
                      <img src={`/lol-game-data/assets/v1/profile-icons/${qol.profileIconId}.jpg`} alt="" className="w-full h-full rounded-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-text-dim"><UserRound className="w-8 h-8" /></div>
                    )}
                  </div>
                  {/* Level Pill */}
                  <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 px-2 py-0.2 rounded-full bg-black/90 border border-primary/50 text-[10px] font-black text-primary font-mono shadow-md">
                    {summoner?.summonerLevel || 1}
                  </span>
                </div>

                {/* Name & Title */}
                <div className="min-w-0 pb-1">
                  <h3 className="text-sm font-black text-white truncate drop-shadow-md">
                    {streamerMode ? 'Demo Player#EUW' : (summoner?.gameName ? `${summoner.gameName}#${summoner.tagLine || ''}` : summoner?.displayName || 'Summoner')}
                  </h3>
                  {selectedTitleName && (
                    <span className="inline-block text-[10px] font-bold text-primary tracking-wider uppercase bg-primary/10 px-2 py-0.5 rounded border border-primary/20 mt-0.5">
                      {selectedTitleName}
                    </span>
                  )}
                </div>
              </div>

              {/* Status Message Bubble */}
              {statusMessage && !streamerMode && (
                <div className="p-2.5 rounded-xl bg-black/50 border border-white/[0.06] text-xs text-text-muted italic flex items-start gap-2">
                  <span className="text-primary font-serif text-base leading-none">“</span>
                  <span className="line-clamp-2">{statusMessage}</span>
                  <span className="text-primary font-serif text-base leading-none">”</span>
                </div>
              )}

              {/* Challenge Tokens Display (up to 3) */}
              <div className="pt-2 border-t border-white/[0.06]">
                <div className="flex items-center justify-between text-[10px] text-text-dim font-bold uppercase tracking-wider mb-1.5">
                  <span>Equipped Tokens</span>
                  <span>{selectedTokenIds.length} of 3</span>
                </div>
                <div className="flex items-center gap-2">
                  {[0, 1, 2].map((idx) => {
                    const tokenId = selectedTokenIds[idx];
                    const token = regalia?.tokens.find((t) => Number(t.id) === tokenId);
                    return (
                      <div
                        key={idx}
                        className={`flex-1 p-2 rounded-xl border flex items-center gap-1.5 min-w-0 ${
                          token
                            ? 'bg-primary/5 border-primary/30 text-primary'
                            : 'bg-white/[0.02] border-white/[0.05] text-text-dim'
                        }`}
                      >
                        <Shield className="w-3.5 h-3.5 shrink-0" />
                        <span className="text-[10px] font-bold truncate">
                          {token ? token.name : '—'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </ContextPanel>
      </div>

      {/* Confirmation Modal */}
      {confirmModal && (
        <ConfirmModal action={confirmModal} onClose={() => setConfirmModal(null)} />
      )}
    </div>
  );
}
