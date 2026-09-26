import { CheckCircle2, AlertCircle, Shield, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { Notification } from '../types';

export default function Toast({ notification, onClose }: { notification: Notification | null; onClose?: () => void }) {
  if (!notification) return null;
  return createPortal(
    <div
      className={`riftops-toast is-${notification.type}`}
      role={notification.type === 'error' ? 'alert' : 'status'}
      aria-live={notification.type === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className="flex items-start gap-2.5">
        {notification.type === 'success' && <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />}
        {notification.type === 'error' && <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />}
        {notification.type === 'info' && <Shield className="w-4 h-4 text-info shrink-0 mt-0.5" />}
        <div className="flex-1 min-w-0">
          <h5 className="text-xs font-bold text-white leading-none mt-0.5">{notification.title}</h5>
          <p className="text-[11px] text-text-muted mt-1 leading-relaxed">{notification.message}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="riftops-toast__close"
          aria-label="Dismiss notification"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
