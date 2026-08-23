import { MessageSquareText, Radio, RefreshCw, Save, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { setLCUAvailability, setLCUStatusMessage } from '../api';
import { ActionFeedback, type FeedbackState } from './DesignPrimitives';
import FriendsPanel from './FriendsPanel';
import { useLCUConnection } from './lcuConnectionContext';

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
    <section className="phone-companion" aria-label="Phone social controls">
      <div className="phone-companion__heading"><span><Radio /></span><div><small>PHONE-SAFE CONTROLS</small><strong>Presence & friends</strong><p>Update reversible League presence and review your social list without exposing desktop settings.</p></div></div>
      <ActionFeedback state={feedback} />
      <div className="phone-companion__presence">
        <label><span><Users /> Availability</span><select name="phone-league-availability" value={availability} disabled={!connected || busy !== ''} onChange={(event) => setAvailability(event.target.value)}><option value="chat">Online</option><option value="away">Away</option><option value="mobile">Mobile</option><option value="offline">Appear offline</option></select></label>
        <button type="button" disabled={!connected || busy !== ''} onClick={() => void run('availability', () => setLCUAvailability(availability), 'League availability updated.')}><RefreshCw className={busy === 'availability' ? 'animate-spin' : ''} /> Apply</button>
        <label className="phone-companion__message"><span><MessageSquareText /> Status message</span><input name="phone-league-status" autoComplete="off" value={message} maxLength={128} disabled={!connected || busy !== ''} onChange={(event) => setMessage(event.target.value)} placeholder="What should friends see?" /></label>
        <button type="button" disabled={!connected || busy !== ''} onClick={() => void run('message', () => setLCUStatusMessage(message.trim()), 'League status message updated.')}><Save /> Save</button>
      </div>
      <FriendsPanel id="phone-friends" connected={connected} />
    </section>
  );
}
