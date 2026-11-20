import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  let reloadingForUpdate = false;
  const hadControllerAtBoot = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadControllerAtBoot || reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      void updateSW(true);
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      const checkUpdate = () => {
        if (navigator.onLine) {
          registration.update().catch(() => {});
        }
      };
      // Check on launch, every 60 seconds, and whenever downloaded mobile app resumes
      window.setInterval(checkUpdate, 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkUpdate();
      });
      window.addEventListener('online', checkUpdate);
      window.addEventListener('ambika-app-resume', checkUpdate);
    },
    onRegisterError() {
      // ignore in restricted iframe preview environments
    },
  });
}

createRoot(document.getElementById('root')!).render(<App />);
