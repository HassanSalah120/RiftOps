import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, BookOpen, Check, Loader2, Save, X } from 'lucide-react';
import {
  fetchLCURuneCatalog,
  updateLCURunePage,
  type LCURuneCatalog,
  type LCURunePage,
  type LCURunePerk,
  type LCURuneSlot,
  type LCURuneStyle,
} from '../api';
import { useDialogFocus } from './useDialogFocus';

type Props = {
  open: boolean;
  page: LCURunePage | null;
  onClose: () => void;
  onSaved: (page: LCURunePage) => void | Promise<void>;
};

function styleSlots(style: LCURuneStyle | undefined): LCURuneSlot[] {
  return (style?.slots || []).filter((slot) => slot.type === 'kKeyStone' || slot.type === 'kMixedRegularSplashable');
}

function secondarySlots(style: LCURuneStyle | undefined): LCURuneSlot[] {
  return (style?.slots || []).filter((slot) => slot.type === 'kMixedRegularSplashable');
}

function statSlots(style: LCURuneStyle | undefined): LCURuneSlot[] {
  return (style?.slots || []).filter((slot) => slot.type === 'kStatMod');
}

function choicesForSlots(slots: LCURuneSlot[], selected: number[], fill = true): number[] {
  return slots.map((slot) => selected.find((id) => slot.perks.includes(id)) || (fill ? Number(slot.perks[0] || 0) : 0));
}

function initialSecondaryChoices(slots: LCURuneSlot[], selected: number[]): number[] {
  const choices = choicesForSlots(slots, selected, false);
  for (let index = 0; choices.filter(Boolean).length < 2 && index < slots.length; index += 1) {
    if (!choices[index]) choices[index] = Number(slots[index].perks[0] || 0);
  }
  return choices;
}

function assetPath(path?: string): string {
  if (!path) return '';
  if (path.startsWith('/')) return path;
  return `/lol-game-data/assets/v1/${path.replace(/^assets\//, '')}`;
}

function plainText(value?: string): string {
  return String(value || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function RuneChoice({ perk, selected, disabled, onClick }: { perk?: LCURunePerk; selected: boolean; disabled?: boolean; onClick: () => void }) {
  if (!perk) return null;
  const icon = assetPath(perk.iconPath);
  return (
    <button
      type="button"
      className={`rune-editor__perk ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      title={plainText(perk.longDesc || perk.shortDesc) || perk.name}
    >
      <span className="rune-editor__perk-icon">
        <span>{perk.name.slice(0, 1)}</span>
        {icon && <img src={icon} alt="" width="32" height="32" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}
      </span>
      <span>{perk.name}</span>
      {selected && <Check />}
    </button>
  );
}

export default function RunePageEditor({ open, page, onClose, onSaved }: Props) {
  const [catalog, setCatalog] = useState<LCURuneCatalog | null>(null);
  const [name, setName] = useState('');
  const [primaryStyleID, setPrimaryStyleID] = useState(0);
  const [secondaryStyleID, setSecondaryStyleID] = useState(0);
  const [primaryChoices, setPrimaryChoices] = useState<number[]>([]);
  const [secondaryChoices, setSecondaryChoices] = useState<number[]>([]);
  const [statChoices, setStatChoices] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialogFocus<HTMLElement>(open, () => { if (!saving) onClose(); });

  const styles = catalog?.styles.styles || [];
  const perkMap = useMemo(() => new Map((catalog?.perks || []).map((perk) => [perk.id, perk])), [catalog]);
  const primaryStyle = styles.find((style) => style.id === primaryStyleID);
  const secondaryStyle = styles.find((style) => style.id === secondaryStyleID);
  const primaryRows = styleSlots(primaryStyle);
  const secondaryRows = secondarySlots(secondaryStyle);
  const shardRows = statSlots(primaryStyle);
  const allowedSecondaryIDs = primaryStyle?.allowedSubStyles?.length
    ? primaryStyle.allowedSubStyles
    : styles.filter((style) => style.id !== primaryStyleID).map((style) => style.id);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !page) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    void fetchLCURuneCatalog().then((next) => {
      if (cancelled) return;
      const nextStyles = next.styles.styles;
      const primary = nextStyles.find((style) => style.id === page.primaryStyleId) || nextStyles[0];
      const allowed = primary?.allowedSubStyles?.length
        ? primary.allowedSubStyles
        : nextStyles.filter((style) => style.id !== primary?.id).map((style) => style.id);
      const secondary = nextStyles.find((style) => style.id === page.subStyleId && allowed.includes(style.id))
        || nextStyles.find((style) => allowed.includes(style.id));
      setCatalog(next);
      setName(page.name || 'RiftOps runes');
      setPrimaryStyleID(Number(primary?.id || 0));
      setSecondaryStyleID(Number(secondary?.id || 0));
      setPrimaryChoices(choicesForSlots(styleSlots(primary), page.selectedPerkIds || []));
      setSecondaryChoices(initialSecondaryChoices(secondarySlots(secondary), page.selectedPerkIds || []));
      setStatChoices(choicesForSlots(statSlots(primary), page.selectedPerkIds || []));
    }).catch((reason: any) => {
      if (!cancelled) setError(reason?.message || 'Could not load League’s rune catalogue.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, page]);

  if (!open) return null;

  const choosePrimaryStyle = (style: LCURuneStyle) => {
    const allowed = style.allowedSubStyles?.length
      ? style.allowedSubStyles
      : styles.filter((candidate) => candidate.id !== style.id).map((candidate) => candidate.id);
    const nextSecondary = allowed.includes(secondaryStyleID)
      ? styles.find((candidate) => candidate.id === secondaryStyleID)
      : styles.find((candidate) => allowed.includes(candidate.id));
    setPrimaryStyleID(style.id);
    setPrimaryChoices(choicesForSlots(styleSlots(style), []));
    setStatChoices(choicesForSlots(statSlots(style), []));
    if (nextSecondary?.id !== secondaryStyleID) {
      setSecondaryStyleID(Number(nextSecondary?.id || 0));
      setSecondaryChoices(initialSecondaryChoices(secondarySlots(nextSecondary), []));
    }
    setError('');
  };

  const chooseSecondaryStyle = (style: LCURuneStyle) => {
    setSecondaryStyleID(style.id);
    setSecondaryChoices(initialSecondaryChoices(secondarySlots(style), []));
    setError('');
  };

  const chooseSecondaryPerk = (rowIndex: number, perkID: number) => {
    setSecondaryChoices((current) => {
      const next = [...current];
      if (next[rowIndex] === perkID) {
        next[rowIndex] = 0;
        return next;
      }
      if (!next[rowIndex] && next.filter(Boolean).length >= 2) {
        const replaceIndex = next.findIndex((value, index) => value > 0 && index !== rowIndex);
        if (replaceIndex >= 0) next[replaceIndex] = 0;
      }
      next[rowIndex] = perkID;
      return next;
    });
    setError('');
  };

  const save = async () => {
    if (!page || saving) return;
    const trimmedName = name.trim();
    const selectedSecondary = secondaryChoices.filter((id) => id > 0);
    const selectedPerkIds = [...primaryChoices, ...selectedSecondary, ...statChoices].map(Number).filter((id) => id > 0);
    if (!trimmedName || trimmedName.length > 25) {
      setError('Use a rune page name between 1 and 25 characters.');
      return;
    }
    if (primaryRows.length !== 4 || primaryChoices.length !== 4 || primaryChoices.some((id) => id <= 0)) {
      setError('Choose one rune from every primary row.');
      return;
    }
    if (selectedSecondary.length !== 2) {
      setError('Choose two secondary runes from two different rows.');
      return;
    }
    if (shardRows.length !== 3 || statChoices.length !== 3 || statChoices.some((id) => id <= 0) || selectedPerkIds.length !== 9) {
      setError('Choose one stat shard from every row.');
      return;
    }
    if (page.isEditable === false) {
      setError('League marks this rune page as read-only. Select an editable custom page first.');
      return;
    }
    setSaving(true);
    setError('');
    const updated: LCURunePage = {
      ...page,
      name: trimmedName,
      primaryStyleId: primaryStyleID,
      subStyleId: secondaryStyleID,
      selectedPerkIds,
    };
    try {
      await updateLCURunePage(updated);
      await onSaved(updated);
      onClose();
    } catch (reason: any) {
      setError(reason?.message || 'League rejected the rune page update.');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="rune-editor__backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="rune-editor" role="dialog" aria-modal="true" aria-labelledby="rune-editor-title">
        <header className="rune-editor__header">
          <span className="rune-editor__header-icon"><BookOpen /></span>
          <div><small>LIVE RUNE BUILDER</small><h2 id="rune-editor-title">Edit current rune page</h2><p>Changes are written directly to the selected League page.</p></div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close rune editor"><X /></button>
        </header>

        {loading ? <div className="rune-editor__loading"><Loader2 className="animate-spin" /><span>Loading runes from League Client…</span></div> : (
          <div className="rune-editor__body">
            <label className="rune-editor__name"><span>Page name</span><input name="rune-page-name" autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} maxLength={25} disabled={saving} /><small>{name.trim().length}/25</small></label>

            <section className="rune-editor__section">
              <div className="rune-editor__section-heading"><span>1</span><div><strong>Primary path</strong><small>Keystone plus one rune from each primary row</small></div></div>
              <div className="rune-editor__styles" role="radiogroup" aria-label="Primary rune style">
                {styles.map((style) => <button type="button" key={style.id} className={primaryStyleID === style.id ? 'is-selected' : ''} onClick={() => choosePrimaryStyle(style)} disabled={saving}><span>{style.name.slice(0, 1)}</span>{assetPath(style.iconPath) && <img src={assetPath(style.iconPath)} alt="" width="32" height="32" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}<strong>{style.name}</strong>{primaryStyleID === style.id && <Check />}</button>)}
              </div>
              <div className="rune-editor__rows">
                {primaryRows.map((slot, rowIndex) => <div className="rune-editor__row" key={`${slot.slotLabel || 'primary'}-${rowIndex}`}><div><span>{rowIndex === 0 ? 'Keystone' : `Primary row ${rowIndex}`}</span><small>{slot.slotLabel}</small></div><div>{slot.perks.map((id) => <RuneChoice key={id} perk={perkMap.get(id)} selected={primaryChoices[rowIndex] === id} disabled={saving} onClick={() => { setPrimaryChoices((current) => current.map((value, index) => index === rowIndex ? id : value)); setError(''); }} />)}</div></div>)}
              </div>
            </section>

            <section className="rune-editor__section">
              <div className="rune-editor__section-heading"><span>2</span><div><strong>Secondary path</strong><small>Choose exactly two runes from different rows</small></div></div>
              <div className="rune-editor__styles" role="radiogroup" aria-label="Secondary rune style">
                {styles.filter((style) => allowedSecondaryIDs.includes(style.id)).map((style) => <button type="button" key={style.id} className={secondaryStyleID === style.id ? 'is-selected' : ''} onClick={() => chooseSecondaryStyle(style)} disabled={saving}><span>{style.name.slice(0, 1)}</span>{assetPath(style.iconPath) && <img src={assetPath(style.iconPath)} alt="" width="32" height="32" onError={(event) => { event.currentTarget.style.display = 'none'; }} />}<strong>{style.name}</strong>{secondaryStyleID === style.id && <Check />}</button>)}
              </div>
              <div className="rune-editor__rows">
                {secondaryRows.map((slot, rowIndex) => <div className="rune-editor__row" key={`${slot.slotLabel || 'secondary'}-${rowIndex}`}><div><span>Secondary row {rowIndex + 1}</span><small>{slot.slotLabel}</small></div><div>{slot.perks.map((id) => <RuneChoice key={id} perk={perkMap.get(id)} selected={secondaryChoices[rowIndex] === id} disabled={saving} onClick={() => chooseSecondaryPerk(rowIndex, id)} />)}</div></div>)}
              </div>
            </section>

            <section className="rune-editor__section">
              <div className="rune-editor__section-heading"><span>3</span><div><strong>Stat shards</strong><small>Choose one shard from each row</small></div></div>
              <div className="rune-editor__rows is-shards">
                {shardRows.map((slot, rowIndex) => <div className="rune-editor__row" key={`${slot.slotLabel || 'shard'}-${rowIndex}`}><div><span>Shard row {rowIndex + 1}</span><small>{slot.slotLabel}</small></div><div>{slot.perks.map((id) => <RuneChoice key={id} perk={perkMap.get(id)} selected={statChoices[rowIndex] === id} disabled={saving} onClick={() => { setStatChoices((current) => current.map((value, index) => index === rowIndex ? id : value)); setError(''); }} />)}</div></div>)}
              </div>
            </section>
          </div>
        )}

        <footer className="rune-editor__footer">
          <div className={`rune-editor__message ${error ? 'is-error' : ''}`}>{error ? <><AlertCircle />{error}</> : <><Check />4 primary · 2 secondary · 3 shards</>}</div>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="rune-editor__save" onClick={() => void save()} disabled={loading || saving || !page}>{saving ? <Loader2 className="animate-spin" /> : <Save />}Save to League</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
