import { Download, Share2, Smartphone, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isIOS, isStandalone, subscribeInstallPrompt, triggerInstall, type BeforeInstallPromptEvent } from '../pwa';

export default function PWAInstallBanner() {
  const [standalone, setStandalone] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('riftops.pwaBannerDismissed') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    setStandalone(isStandalone());
    const unsubscribe = subscribeInstallPrompt((prompt) => {
      setInstallPrompt(prompt);
    });
    return unsubscribe;
  }, []);

  if (standalone || dismissed) {
    return null;
  }

  const ios = isIOS();
  // Only show if we either have an install prompt (Android/Desktop Chrome) or are on iOS Safari
  if (!installPrompt && !ios) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem('riftops.pwaBannerDismissed', 'true');
    } catch {}
  };

  const handleInstallClick = async () => {
    if (installPrompt) {
      await triggerInstall();
    }
  };

  return (
    <div className="relative z-40 flex items-center justify-between gap-3 p-3.5 my-2.5 rounded-xl border border-primary/35 bg-gradient-to-br from-[#091428]/95 to-[#040c16]/98 shadow-xl backdrop-blur-md max-[520px]:flex-wrap" role="complementary" aria-label="Install mobile companion app">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/25 flex items-center justify-center">
          <Smartphone className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <strong className="block text-xs font-bold text-white tracking-wide">Install RiftOps Companion</strong>
          <p className="text-[11px] text-text-muted mt-0.5 leading-snug">
            {ios ? (
              <span>
                Tap <Share2 className="inline w-3.5 h-3.5 mx-0.5 text-primary" /> <strong>Share</strong> then <strong>Add to Home Screen</strong> for full-screen queue pop control.
              </span>
            ) : (
              'Add to your home screen for full-screen companion controls without the browser bar.'
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 max-[520px]:w-full max-[520px]:justify-end">
        {installPrompt && (
          <button
            type="button"
            className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
            onClick={handleInstallClick}
          >
            <Download className="w-3.5 h-3.5" />
            Install App
          </button>
        )}
        <button
          type="button"
          className="w-7 h-7 rounded-md border border-white/10 bg-white/5 text-text-muted hover:text-white hover:border-primary/30 flex items-center justify-center transition cursor-pointer"
          onClick={handleDismiss}
          aria-label="Dismiss installation prompt"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
