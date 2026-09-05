import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, ShieldAlert, X } from 'lucide-react';
import { useDialogFocus } from './useDialogFocus';

export interface ReviewOperationData {
  previewId: string;
  kind: string;
  title: string;
  description: string;
  confirmation: string;
  targetCount: number;
  targetLabels?: string[];
  danger?: boolean;
}

export default function ReviewOperationModal({
  operation,
  onClose,
  onConfirm,
}: {
  operation: ReviewOperationData | null;
  onClose: () => void;
  onConfirm: (previewId: string, confirmationText: string) => Promise<void>;
}) {
  const [inputText, setInputText] = useState('');
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(Boolean(operation), onClose, inputRef);

  useEffect(() => {
    if (operation) {
      setInputText('');
      setExecuting(false);
      setError('');
    }
  }, [operation]);

  if (!operation) return null;

  const isMatched = inputText.trim() === operation.confirmation.trim();

  const handleExecute = async () => {
    if (!isMatched || executing) return;
    setExecuting(true);
    setError('');
    try {
      await onConfirm(operation.previewId, inputText.trim());
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Operation failed. Please try again.');
      setExecuting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fadeIn"
      onClick={() => { if (!executing) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-modal-title"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="hextech-modal max-w-md w-full p-6 space-y-5 shadow-2xl relative overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hextech Gold / Danger Accent Border */}
        <div className={`absolute top-0 left-0 right-0 h-1 ${operation.danger ? 'bg-danger shadow-[0_0_14px_#ff4655]' : 'bg-primary shadow-[0_0_14px_#c8aa6e]'}`} />

        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
              operation.danger
                ? 'bg-danger/10 border-danger/30 text-danger'
                : 'bg-primary/10 border-primary/30 text-primary'
            }`}>
              {operation.danger ? <AlertTriangle className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
            </div>
            <div>
              <h4 id="review-modal-title" className="text-base font-black text-white">{operation.title}</h4>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">{operation.description}</p>
            </div>
          </div>
          <button
            type="button"
            disabled={executing}
            onClick={onClose}
            className="text-text-dim hover:text-white transition p-1 cursor-pointer"
            aria-label="Close review dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Operation Details Card */}
        <div className="p-3.5 rounded-xl bg-black/40 border border-white/[0.08] space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-dim font-bold uppercase tracking-wider">Affected Targets</span>
            <span className="font-mono font-bold text-white bg-white/[0.06] px-2 py-0.5 rounded-md">
              {operation.targetCount} item{operation.targetCount === 1 ? '' : 's'}
            </span>
          </div>

          {operation.targetLabels && operation.targetLabels.length > 0 && (
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pt-1">
              {operation.targetLabels.map((label, idx) => (
                <span key={idx} className="text-[11px] font-medium px-2 py-0.5 rounded bg-white/[0.04] text-text-muted border border-white/[0.05]">
                  {label}
                </span>
              ))}
            </div>
          )}

          <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between text-xs">
            <span className="text-text-dim">Required Confirmation:</span>
            <code className="px-2 py-0.5 rounded bg-primary/10 text-primary font-mono font-black text-xs border border-primary/30 select-all">
              {operation.confirmation}
            </code>
          </div>
        </div>

        {/* Confirmation Input Field */}
        <div className="space-y-1.5">
          <label htmlFor="review-confirmation-input" className="block text-xs font-bold text-text-muted">
            Type <span className="text-white font-mono">{operation.confirmation}</span> to confirm:
          </label>
          <input
            id="review-confirmation-input"
            ref={inputRef}
            type="text"
            value={inputText}
            disabled={executing}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isMatched && !executing) {
                e.preventDefault();
                void handleExecute();
              }
            }}
            placeholder={`Type ${operation.confirmation} here`}
            autoComplete="off"
            className="w-full px-3 py-2 text-sm bg-black/60 border border-white/20 rounded-xl text-white font-mono focus:border-primary focus:outline-none"
          />
          {error && <p className="text-xs text-danger font-medium mt-1">{error}</p>}
        </div>

        {/* Modal Actions */}
        <div className="flex justify-end gap-2.5 pt-2 border-t border-white/[0.06]">
          <button
            ref={cancelRef}
            type="button"
            disabled={executing}
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-bold text-text-muted hover:text-white bg-white/[0.04] hover:bg-white/[0.08] transition cursor-pointer border border-white/[0.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!isMatched || executing}
            onClick={() => void handleExecute()}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 cursor-pointer ${
              operation.danger
                ? 'bg-danger text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_18px_rgba(255,70,85,0.4)]'
                : 'btn-primary disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            {executing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {executing ? 'Processing...' : operation.danger ? 'Confirm Removal' : 'Confirm Operation'}
          </button>
        </div>
      </div>
    </div>
  );
}
