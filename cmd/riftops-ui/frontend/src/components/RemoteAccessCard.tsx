import { Copy, RefreshCw, ShieldCheck, Smartphone, Unplug, Wifi } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import { ActionFeedback, type FeedbackState } from './DesignPrimitives';

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
  const [qrNonce, setQrNonce] = useState(() => Date.now());
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await api.fetchRemoteAccessStatus()); }
    catch (error: any) { setStatus({ enabled: false }); showToast(error?.message || 'Phone control is unavailable', 'error'); }
    finally { setLoading(false); }
  }, [showToast]);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 30000); return () => window.clearInterval(timer); }, [refresh]);

  const toggle = async () => {
    setBusy('toggle');
    try {
      const enabled = !status?.enabled;
      const next = await api.setRemoteAccessEnabled(enabled);
      setStatus(next); setQrNonce(Date.now());
      setFeedback({ tone: 'success', message: enabled ? 'Phone control is enabled. Scan the QR to pair.' : 'Phone control is off and active phone sessions are closed.' });
      showToast(enabled ? 'Phone control is ready to pair' : 'Phone control stopped', enabled ? 'success' : 'info');
    } catch (error: any) { const message = error?.message || 'Could not change phone control'; setFeedback({ tone: 'error', message }); showToast(message, 'error'); }
    finally { setBusy(''); }
  };

  const newQR = async () => {
    setBusy('qr');
    try { setStatus(await api.rotateRemoteAccess()); setQrNonce(Date.now()); setFeedback({ tone: 'success', message: 'A fresh one-time QR is ready to scan.' }); showToast('Fresh one-time QR generated', 'success'); }
    catch (error: any) { const message = error?.message || 'Could not generate a pairing code'; setFeedback({ tone: 'error', message }); showToast(message, 'error'); }
    finally { setBusy(''); }
  };

  const revoke = async (id?: string) => {
    setBusy(id || 'all');
    try {
      setStatus(id ? await api.revokeRemoteSession(id) : await api.revokeAllRemoteSessions());
      setFeedback({ tone: 'success', message: id ? 'The selected phone session was disconnected.' : 'All phone sessions were disconnected.' });
      showToast(id ? 'Phone disconnected' : 'All phones disconnected', 'success');
    } catch (error: any) { const message = error?.message || 'Could not disconnect phone'; setFeedback({ tone: 'error', message }); showToast(message, 'error'); }
    finally { setBusy(''); }
  };

  const copy = async () => {
    if (!status?.url) return;
    try { await navigator.clipboard.writeText(status.url); setFeedback({ tone: 'success', message: 'One-time pairing link copied.' }); showToast('One-time pairing link copied', 'success'); }
    catch { setFeedback({ tone: 'error', message: 'Copy failed. Scan the QR instead.' }); showToast('Copy failed; scan the QR instead', 'error'); }
  };

  const sessions = status?.sessions || [];
  return (
    <section className="remote-access glass-card">
      <header className="remote-access__header">
        <span className="remote-access__icon"><Smartphone /></span>
        <div><small>REMOTE ACCESS</small><h2>Control RiftOps from your phone</h2><p>Pair over the same private Wi-Fi, then manage lobby, ready check, champion select, and runes.</p></div>
        <span className={`remote-access__status ${status?.enabled ? 'is-online' : ''}`}><i />{loading ? 'Checking' : status?.enabled ? 'Listening' : 'Off'}</span>
      </header>

      <ActionFeedback state={feedback} className="remote-access__feedback" />
      {!status?.enabled ? <div className="remote-access__off"><ShieldCheck /><span><strong>Off by default</strong><small>No LAN port is open until you enable phone control.</small></span><button type="button" className="btn-primary" disabled={busy !== '' || loading} onClick={() => void toggle()}>{busy === 'toggle' ? <RefreshCw className="animate-spin" /> : <Wifi />}Enable remote access</button></div> : <div className="remote-access__body">
        {status.remote ? <div className="remote-access__phone-state"><ShieldCheck /><div><strong>This phone is connected</strong><span>RiftOps is ready for remote League controls. QR and device-management actions are available on the desktop only.</span></div></div> : <>
        <div className="remote-access__pair">
          {status.url && status.pairingAvailable ? <><div className="remote-access__qr"><img src={`/api/remote/qr.png?nonce=${qrNonce}`} alt="One-time RiftOps phone pairing QR code" width="92" height="92" /></div><div><strong>Scan this one-time code</strong><span>Expires in {relativeTime(status.expiresAt)} and becomes invalid immediately after one phone uses it.</span><button type="button" onClick={() => void copy()}><Copy />Copy link</button></div></> : <div className="remote-access__pair-empty"><Smartphone /><div><strong>No active pairing code</strong><span>Generate one when you want to connect another phone. Existing phones remain connected.</span></div></div>}
          <button type="button" className={status.url ? 'btn-secondary' : 'btn-primary'} disabled={busy !== ''} onClick={() => void newQR()}>{busy === 'qr' ? <RefreshCw className="animate-spin" /> : <RefreshCw />}{status.url ? 'Replace QR' : 'Pair a device'}</button>
        </div>

        <div className="remote-access__sessions">
          <div className="remote-access__sessions-head"><div><strong>Paired devices</strong><span>{sessions.length ? `${sessions.length} active session${sessions.length === 1 ? '' : 's'}` : 'No phones connected'}</span></div>{sessions.length > 0 && <button type="button" disabled={busy !== ''} onClick={() => void revoke()}><Unplug />Disconnect all</button>}</div>
          {sessions.map((session) => <article key={session.id}><span><Smartphone /></span><div><strong>{session.device}</strong><small>Last seen {new Date(session.lastSeen).toLocaleString()} · {relativeTime(session.expiresAt)}</small></div><button type="button" aria-label="Disconnect phone" title="Disconnect this phone" disabled={busy !== ''} onClick={() => void revoke(session.id)}>{busy === session.id ? <RefreshCw className="animate-spin" /> : <Unplug />}</button></article>)}
        </div>

        <footer><span><ShieldCheck />Pairing and session tokens stay in memory and are revoked when RiftOps exits.</span><span className="is-warning">LAN traffic is HTTP, not end-to-end encrypted. Use only a trusted private Wi-Fi.</span><button type="button" disabled={busy !== ''} onClick={() => void toggle()}>Turn off phone control</button></footer>
        </>}
      </div>}
    </section>
  );
}
