import { Bell, CheckCircle2, AlertCircle, Shield, Trash2, X } from 'lucide-react';
import type { Notification } from '../types';

export type NotificationEntry = Notification & { id: number; createdAt: string; read: boolean };

export default function NotificationCenter({
  open,
  entries,
  onClose,
  onRead,
  onClear,
}: {
  open: boolean;
  entries: NotificationEntry[];
  onClose: () => void;
  onRead: (id: number) => void;
  onClear: () => void;
}) {
  if (!open) return null;
  return (
    <div className="notification-center__backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="notification-center" role="dialog" aria-modal="true" aria-label="RiftOps notifications">
        <div className="notification-center__header">
          <div><span className="notification-center__eyebrow">ACTIVITY LOG</span><h2><Bell /> Notifications</h2></div>
          <div className="notification-center__tools">
            <button type="button" onClick={onClear} title="Clear notifications" aria-label="Clear notifications"><Trash2 /></button>
            <button type="button" onClick={onClose} title="Close notifications" aria-label="Close notifications"><X /></button>
          </div>
        </div>
        <div className="notification-center__list">
          {entries.length === 0 && <div className="notification-center__empty"><Bell /><strong>No activity yet</strong><span>Launches, client changes, and actions will appear here.</span></div>}
          {entries.map((entry) => (
            <button key={entry.id} type="button" className={`notification-center__item ${entry.read ? 'is-read' : 'is-unread'}`} onClick={() => onRead(entry.id)}>
              <span className={`notification-center__icon notification-center__icon--${entry.type}`}>
                {entry.type === 'success' ? <CheckCircle2 /> : entry.type === 'error' ? <AlertCircle /> : <Shield />}
              </span>
              <span className="notification-center__copy"><strong>{entry.title}</strong><span>{entry.message}</span><small>{entry.createdAt}</small></span>
              {!entry.read && <span className="notification-center__dot" />}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
