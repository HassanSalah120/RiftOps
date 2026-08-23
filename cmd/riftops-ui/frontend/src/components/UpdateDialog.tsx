import { Shield, Download, X } from 'lucide-react';
import { useRef } from 'react';
import type { Release } from '../types';
import { safeReleaseURL } from '../externalURL';
import { useDialogFocus } from './useDialogFocus';

export default function UpdateDialog({ release, onDismiss }: { release: Release | null; onDismiss: () => void }) {
  const primaryActionRef = useRef<HTMLAnchorElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(Boolean(release), onDismiss, primaryActionRef);
  if (!release) return null;
  const downloadURL = safeReleaseURL(release.url);
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="riftops-update-title" className="hextech-modal max-w-sm w-full p-5 space-y-4 animate-[fadeIn_0.2s_ease-out] relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-primary shadow-[0_0_12px_#c8aa6e]" />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <span className="text-[10px] font-extrabold uppercase tracking-wider text-primary bg-primary/10 border border-primary/20 px-2.5 py-0.5 rounded-full">
              Update Available
            </span>
          </div>
          <button type="button" onClick={onDismiss} aria-label="Dismiss update" className="text-text-dim hover:text-white transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div>
          <h4 id="riftops-update-title" className="text-base font-black text-white">RiftOps v{release.version}</h4>
          <p className="text-xs text-text-muted mt-1 leading-relaxed">
            A new version of RiftOps is ready for download. Update recommended for patch and LCU compatibility.
          </p>
        </div>

        <div className="flex justify-end gap-2.5 pt-2 border-t border-white/[0.08]">
          <button type="button" onClick={onDismiss} className="px-4 py-2 rounded-xl text-xs font-bold text-text-muted hover:text-white bg-white/[0.04] transition cursor-pointer border border-white/[0.06]">
            Later
          </button>
          {downloadURL ? <a ref={primaryActionRef}
            href={downloadURL} target="_blank" rel="noopener noreferrer"
            className="btn-primary px-4 py-2 text-xs inline-flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download</span>
          </a> : <button type="button" disabled className="btn-primary px-4 py-2 text-xs inline-flex items-center gap-1.5 opacity-50"><Download className="w-3.5 h-3.5" /><span>Link unavailable</span></button>}
        </div>
      </div>
    </div>
  );
}
