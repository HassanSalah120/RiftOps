import { useState } from 'react';
import { ArrowRight, Check, ChevronDown } from 'lucide-react';
import { GAMES } from '../types';
import { PERFORMANCE_MODES, type PerformanceMode } from './lcuConnectionContext';
import './firstRunSetup.css';

type SetupChoices = { game: string; startupStatus: string; performance: PerformanceMode };

export default function FirstRunSetup({ game, startupStatus, performance, preferencesReady, preferencesLoading, onApply, onSkip }: {
  game: string;
  startupStatus: string;
  performance: PerformanceMode;
  preferencesReady: boolean;
  preferencesLoading: boolean;
  onApply: (choices: SetupChoices) => Promise<void>;
  onSkip: () => void;
}) {
  const [choices, setChoices] = useState<SetupChoices>({ game, startupStatus, performance });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const apply = async () => {
    setBusy(true);
    setError('');
    try { await onApply(choices); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save setup. Try again or skip for now.'); }
    finally { setBusy(false); }
  };

  return (
    <main className="first-run" aria-labelledby="first-run-title">
      <div className="first-run__content">
        <img className="first-run__logo" src="/branding/riftops-full-logo.png" alt="RiftOps" width="96" height="96" />
        <h1 id="first-run-title">Make RiftOps yours.</h1>
        <p className="first-run__intro">A few defaults, then you’re ready to play. You can change everything in Settings later.</p>
        <section className="first-run__defaults" aria-label="Your starting settings">
          <h2>Your starting settings</h2>
          <dl>
            <div><dt>Preferred game</dt><dd>{GAMES.find((item) => item.value === choices.game)?.label || 'League of Legends'}</dd></div>
            <div><dt>Launch presence</dt><dd>{{ last: 'Remember last status', chat: 'Online', offline: 'Offline (masked)', mobile: 'Mobile' }[choices.startupStatus] || 'Remember last status'}</dd></div>
            <div><dt>Background activity</dt><dd>{PERFORMANCE_MODES[choices.performance].label}{choices.performance === 'balanced' && <span className="first-run__recommended">Recommended</span>}</dd></div>
          </dl>
          <p><Check size={16} aria-hidden="true" /> Setup doesn’t launch games or change Windows startup.</p>
        </section>
        {preferencesReady && <details className="first-run__customize">
          <summary>Customize before starting <ChevronDown size={16} aria-hidden="true" /></summary>
          <div className="first-run__fields">
            <label>Preferred game<select value={choices.game} disabled={busy} onChange={(event) => setChoices({ ...choices, game: event.target.value })}>{GAMES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label>Launch presence<select value={choices.startupStatus} disabled={busy} onChange={(event) => setChoices({ ...choices, startupStatus: event.target.value })}><option value="last">Remember last status</option><option value="chat">Online</option><option value="offline">Offline (masked)</option><option value="mobile">Mobile</option></select></label>
            <fieldset disabled={busy}><legend>Background activity</legend>{Object.entries(PERFORMANCE_MODES).map(([value, mode]) => <label className="first-run__radio" key={value}><input type="radio" name="setup-performance" value={value} checked={choices.performance === value} onChange={() => setChoices({ ...choices, performance: value as PerformanceMode })} /><span><strong>{mode.label}</strong><small>{mode.description}</small></span></label>)}</fieldset>
          </div>
        </details>}
        {preferencesLoading && <p role="status">Loading your settings… You can skip and explore while they load.</p>}
        {!preferencesReady && !preferencesLoading && <p role="alert">Settings couldn’t be loaded. Skip for now and try again in Settings.</p>}
        {error && <p className="first-run__error" role="alert">{error}</p>}
        <div className="first-run__actions">
          <button type="button" className="btn-primary" disabled={busy || !preferencesReady} onClick={() => void apply()}>{busy ? 'Saving…' : 'Save & open Home'}{!busy && <ArrowRight size={17} aria-hidden="true" />}</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={onSkip}>Skip for now</button>
        </div>
        <p className="first-run__next">Next: launch your game from Home. All other settings can wait.</p>
      </div>
    </main>
  );
}
