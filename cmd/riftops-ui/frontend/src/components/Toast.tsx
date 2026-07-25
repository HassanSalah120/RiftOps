import { CheckCircle2, AlertCircle, Shield, X } from 'lucide-react';
import type { Notification } from '../types';

export default function Toast({ notification, onClose }: { notification: Notification | null; onClose?: () => void }) {
  if (!notification) return null;
  return (
    <div
      className="fixed bottom-4 right-4 left-4 z-50 glass rounded-2xl p-3.5 shadow-2xl animate-[fadeIn_0.2s_ease-out] cursor-pointer"
      onClick={onClose}
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
          onClick={(e) => { e.stopPropagation(); onClose?.(); }}
          className="p-1 rounded-lg hover:bg-white/[0.06] text-text-dim hover:text-white transition shrink-0 cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
