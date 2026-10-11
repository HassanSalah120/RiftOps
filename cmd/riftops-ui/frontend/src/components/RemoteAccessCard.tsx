import { Copy, RefreshCw, ShieldCheck, Smartphone, Unplug, Wifi } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { ActionFeedback, EmptyState, type FeedbackState } from './DesignPrimitives';

function relativeTime(value?: string): string {
  const time = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(time)) return 'unknown';
  const remaining = time - Date.now();
  if (remaining <= 0) return 'expired';
  if (remaining < 3600000) return `${Math.max(1, Math.round(remaining / 60000))}m left`;
  return `${Math.max(1, Math.round(remaining / 3600000))}h left`;
}

export default function RemoteAccessCard({ showToast }: { showToast: (message: string, type?: 'info' | 'success' | 'error') => void }) {
  const [status, setStatus] = useState<api.RemoteAccessStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [qrNonce, setQrNonce] = useState(() => Date.now());
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const actionLock = useRef(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try { setStatus(await api.fetchRemoteAccessStatus()); setStatusError(''); }
    catch (error: any) { setStatusError(error?.message || 'Phone control status could not be read.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 30000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);

  const toggle = async () => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy('toggle');
    try {
      const enabled = !status?.enabled;
      const next = await api.setRemoteAccessEnabled(enabled);
      setStatus(next); setQrNonce(Date.now());
      setFeedback({ tone: 'success', message: enabled ? 'Phone control is enabled. Scan the QR to pair.' : 'Phone control is off and active phone sessions are closed.' });
      showToast(enabled ? 'Phone control is ready to pair' : 'Phone control stopped', enabled ? 'success' : 'info');
    } catch (error: any) { const message = error?.message || 'Could not change phone control'; setFeedback({ tone: 'error', message }); showToast(message, 'error'); }
    finally { actionLock.current = false; setBusy(''); }
  };

  const newQR = async () => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy('qr');
    try { setStatus(await api.rotateRemoteAccess()); setQrNonce(Date.now()); setFeedback({ tone: 'success', message: 'A fresh one-time QR is ready to scan.' }); showToast('Fresh one-time QR generated', 'success'); }
    catch (error: any) { const message = error?.message || 'Could not generate a pairing code'; setFeedback({ tone: 'error', message }); showToast(message, 'error'); }
    finally { actionLock.current = false; setBusy(''); }
  };

  const revoke = async (id?: string) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(id || 'all');
    try {
      setStatus(id ? await api.revokeRemoteSession(id) : await api.revokeAllRemoteSessions());
      setFeedback({ tone: 'success', message: id ? 'The selected phone session was disconnected.' : 'All phone sessions were disconnected.' });
      showToast(id ? 'Phone disconnected' : 'All phones disconnected', 'success');
    } catch (error: any) { const message = error?.message || 'Could not disconnect phone'; setFeedback({ tone: 'error', message }); showToast(message, 'error'); }
    finally { actionLock.current = false; setBusy(''); }
  };

  const copy = async () => {
    if (!status?.url) return;
    try { await navigator.clipboard.writeText(status.url); setFeedback({ tone: 'success', message: 'One-time pairing link copied.' }); showToast('One-time pairing link copied', 'success'); }
    catch { setFeedback({ tone: 'error', message: 'Copy failed. Scan the QR instead.' }); showToast('Copy failed; scan the QR instead', 'error'); }
  };

  const sessions = status?.sessions || [];
  const pairingExpired = Boolean(status?.expiresAt && new Date(status.expiresAt).getTime() <= now);
  return (
    <section className="remote-access glass-card">
      <header className="remote-access__header">
        <span className="remote-access__icon"><Smartphone /></span>
        <div><h2>Control RiftOps from your phone</h2><p>Pair over the same private Wi-Fi, then manage lobby, ready check, champion select, and runes.</p></div>
        <span className={`remote-access__status ${status?.enabled ? 'is-online' : ''}`}><i />{statusError ? 'Unknown' : loading ? 'Checking' : status?.enabled ? 'Listening' : 'Off'}</span>
      </header>

      <ActionFeedback state={feedback} className="remote-access__feedback" />
      {statusError ? <EmptyState tone="error" icon={Wifi} title="Connection status unavailable" description={statusError} action={<button type="button" className="btn-secondary" onClick={() => { setLoading(true); void refresh(); }} disabled={loading}><RefreshCw />Retry status</button>} /> : !status?.enabled ? <div className="remote-access__off"><ShieldCheck /><span><strong>Off by default</strong><small>No LAN port is open until you enable phone control.</small></span><button type="button" className="btn-primary" disabled={busy !== '' || loading} onClick={() => void toggle()}>{busy === 'toggle' ? <RefreshCw className="animate-spin" /> : <Wifi />}Enable remote access</button></div> : <div className="remote-access__body">
        {status.remote ? <div className="remote-access__phone-state"><ShieldCheck /><div><strong>This phone is connected</strong><span>RiftOps is ready for remote League controls. QR and device-management actions are available on the desktop only.</span></div></div> : <>
        <div className="remote-access__pair">
          {status.url && status.pairingAvailable && !pairingExpired ? <><div className="remote-access__qr"><img src={`/api/remote/qr.png?nonce=${qrNonce}`} alt="One-time RiftOps phone pairing QR code" width="136" height="136" /></div><div><strong>Scan this one-time code</strong><span>Valid for {relativeTime(status.expiresAt)} and becomes invalid immediately after one phone uses it.</span><button type="button" disabled={busy !== ''} onClick={() => void copy()}><Copy />Copy link</button></div></> : <div className="remote-access__pair-empty"><Smartphone /><div><strong>{pairingExpired ? 'Pairing code expired' : 'No active pairing code'}</strong><span>Generate a fresh code to connect another phone. Existing phones remain connected.</span></div></div>}
          <button type="button" className={status.url ? 'btn-secondary' : 'btn-primary'} disabled={busy !== ''} onClick={() => void newQR()}>{busy === 'qr' ? <RefreshCw className="animate-spin" /> : <RefreshCw />}{status.url ? 'Replace QR' : 'Pair a device'}</button>
        </div>

        <div className="remote-access__sessions">
          <div className="remote-access__sessions-head"><div><strong>Paired devices</strong><span>{sessions.length ? `${sessions.length} active session${sessions.length === 1 ? '' : 's'}` : 'No phones connected'}</span></div>{sessions.length > 0 && <button type="button" disabled={busy !== ''} onClick={() => void revoke()}><Unplug />Disconnect all</button>}</div>
          {sessions.map((session) => <article key={session.id}><span><Smartphone /></span><div><strong>{session.device}</strong><small>Last seen {new Date(session.lastSeen).toLocaleString()} · {relativeTime(session.expiresAt)}</small></div><button type="button" aria-label={`Disconnect ${session.device}`} title="Disconnect this phone" disabled={busy !== ''} onClick={() => void revoke(session.id)}>{busy === session.id ? <RefreshCw className="animate-spin" /> : <Unplug />}</button></article>)}
        </div>

        <footer><span><ShieldCheck />Pairing and session tokens stay in memory and are revoked when RiftOps exits.</span><span className="is-warning">LAN traffic uses HTTPS with a local certificate. Your phone may show a first-visit certificate warning; use only your trusted private Wi-Fi.</span><button type="button" disabled={busy !== ''} onClick={() => void toggle()}>Turn off &amp; disconnect phones</button></footer>
        </>}
      </div>}
    </section>
  );
}
