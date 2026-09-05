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
    <div className="pwa-install-banner" role="complementary" aria-label="Install mobile companion app">
      <div className="pwa-install-banner__icon">
        <Smartphone className="w-5 h-5 text-[#C8AA6E]" />
      </div>
      <div className="pwa-install-banner__text">
        <strong>Install RiftOps Companion</strong>
        <p>
          {ios ? (
            <span>
              Tap <Share2 className="inline w-3.5 h-3.5 mx-0.5 text-[#C8AA6E]" /> <strong>Share</strong> then <strong>Add to Home Screen</strong> for full-screen queue pop control.
            </span>
          ) : (
            'Add to your home screen for full-screen companion controls without the browser bar.'
          )}
        </p>
      </div>
      <div className="pwa-install-banner__actions">
        {installPrompt && (
          <button
            type="button"
            className="btn-gold pwa-install-banner__btn"
            onClick={handleInstallClick}
          >
            <Download className="w-4 h-4 mr-1.5" />
            Install App
          </button>
        )}
        <button
          type="button"
          className="pwa-install-banner__close"
          onClick={handleDismiss}
          aria-label="Dismiss installation prompt"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
