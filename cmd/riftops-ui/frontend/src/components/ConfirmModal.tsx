import { useRef } from 'react';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { ConfirmAction } from '../types';
import { useDialogFocus } from './useDialogFocus';

export default function ConfirmModal({
  action,
  onClose,
}: {
  action: ConfirmAction;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(action.open, onClose, cancelRef);

  if (!action.open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fadeIn"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="hextech-modal max-w-sm w-full p-5 space-y-4 shadow-2xl relative overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hextech Gold top accent border line */}
        <div className={`absolute top-0 left-0 right-0 h-1 ${action.danger ? 'bg-danger shadow-[0_0_12px_#ff4655]' : 'bg-primary shadow-[0_0_12px_#c8aa6e]'}`} />

        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
            action.danger
              ? 'bg-danger/10 border-danger/30 text-danger'
              : 'bg-primary/10 border-primary/30 text-primary'
          }`}>
            {action.danger ? <AlertTriangle className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
          </div>
          <div>
            <h4 id="confirm-title" className="text-sm font-black text-white">{action.title}</h4>
            <p className="text-xs text-text-muted mt-1 leading-relaxed">{action.message}</p>
          </div>
        </div>

        <div className="flex justify-end gap-2.5 pt-2 border-t border-white/[0.06]">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-bold text-text-muted hover:text-white bg-white/[0.04] hover:bg-white/[0.08] transition cursor-pointer border border-white/[0.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => action.onConfirm()}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition cursor-pointer ${
              action.danger
                ? 'bg-danger text-white hover:bg-red-600 shadow-[0_0_18px_rgba(255,70,85,0.4)]'
                : 'btn-primary'
            }`}
          >
            {action.actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
