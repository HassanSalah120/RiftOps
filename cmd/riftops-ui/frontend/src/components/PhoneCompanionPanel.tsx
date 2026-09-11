import { MessageSquareText, Radio, RefreshCw, Save, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { setLCUAvailability, setLCUStatusMessage } from '../api';
import { ActionFeedback, type FeedbackState } from './DesignPrimitives';
import FriendsPanel from './FriendsPanel';
import { useLCUConnection } from './lcuConnectionContext';
import PWAInstallBanner from './PWAInstallBanner';

type Toast = (message: string, type?: 'info' | 'success' | 'error') => void;

export default function PhoneCompanionPanel({ showToast }: { showToast: Toast }) {
  const { qol, connected, refresh } = useLCUConnection();
  const [availability, setAvailability] = useState('chat');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  useEffect(() => {
    if (qol?.availability) setAvailability(qol.availability);
    if (typeof qol?.statusMessage === 'string') setMessage(qol.statusMessage);
  }, [qol?.availability, qol?.statusMessage]);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setFeedback({ tone: 'working', message: 'Applying this change in League…' });
    try {
      await action();
      await refresh();
      setFeedback({ tone: 'success', message: success });
      showToast(success, 'success');
    } catch (reason: any) {
      const detail = reason?.message || 'League rejected the change.';
      setFeedback({ tone: 'error', message: detail });
      showToast(detail, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="flex flex-col gap-3.5 p-4 rounded-2xl border border-primary/20 bg-surface/80 glass-card" aria-label="Phone social controls">
      <PWAInstallBanner />
      <div className="flex items-start gap-3 border-b border-white/[0.06] pb-3">
        <span className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/25 text-cyan-400 flex items-center justify-center shrink-0">
          <Radio className="w-4 h-4" />
        </span>
        <div>
          <small className="text-[9px] font-black tracking-widest text-text-muted uppercase block">PHONE-SAFE CONTROLS</small>
          <strong className="text-base font-bold text-white block">Presence & friends</strong>
          <p className="text-[11px] text-text-muted mt-0.5">Update reversible League presence and review your social list without exposing desktop settings.</p>
        </div>
      </div>
      <ActionFeedback state={feedback} />
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2.5 items-end">
        <label className="flex flex-col gap-1 text-xs text-text-muted font-bold">
          <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5 text-primary" /> Availability</span>
          <select name="phone-league-availability" value={availability} disabled={!connected || busy !== ''} onChange={(event) => setAvailability(event.target.value)} className="w-full text-xs">
            <option value="chat">Online</option>
            <option value="away">Away</option>
            <option value="mobile">Mobile</option>
            <option value="offline">Appear offline</option>
          </select>
        </label>
        <button type="button" className="btn-secondary text-xs flex items-center justify-center gap-1.5 h-[38px] px-4" disabled={!connected || busy !== ''} onClick={() => void run('availability', () => setLCUAvailability(availability), 'League availability updated.')}>
          <RefreshCw className={`w-3.5 h-3.5 ${busy === 'availability' ? 'animate-spin' : ''}`} /> Apply
        </button>
        <label className="flex flex-col gap-1 text-xs text-text-muted font-bold">
          <span className="flex items-center gap-1.5"><MessageSquareText className="w-3.5 h-3.5 text-primary" /> Status message</span>
          <input name="phone-league-status" autoComplete="off" value={message} maxLength={128} disabled={!connected || busy !== ''} onChange={(event) => setMessage(event.target.value)} placeholder="What should friends see?" className="w-full text-xs" />
        </label>
        <button type="button" className="btn-primary text-xs flex items-center justify-center gap-1.5 h-[38px] px-4" disabled={!connected || busy !== ''} onClick={() => void run('message', () => setLCUStatusMessage(message.trim()), 'League status message updated.')}>
          <Save className="w-3.5 h-3.5" /> Save
        </button>
      </div>
      <FriendsPanel id="phone-friends" connected={connected} />
    </section>
  );
}
