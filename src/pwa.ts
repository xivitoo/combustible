interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface PWAState {
  canInstall: boolean;
  isInstalled: boolean;
  isIOS: boolean;
}

export function initPWA(onStateChange: (state: PWAState) => void) {
  let deferredPrompt: BeforeInstallPromptEvent | null = null;
  const ua = window.navigator.userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua);

  const checkStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;

  let isInstalled = checkStandalone();

  const notify = () => {
    onStateChange({
      canInstall: Boolean(deferredPrompt),
      isInstalled,
      isIOS,
    });
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    isInstalled = true;
    deferredPrompt = null;
    notify();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      const base = import.meta.env.BASE_URL || '/';
      navigator.serviceWorker
        .register(`${base}sw.js`, { scope: base })
        .catch(() => {
          // Silencioso en entornos sin soporte SW
        });
    });
  }

  notify();

  return {
    promptInstall: async (): Promise<boolean> => {
      if (!deferredPrompt) return false;
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        isInstalled = true;
        deferredPrompt = null;
        notify();
        return true;
      }
      return false;
    },
  };
}
