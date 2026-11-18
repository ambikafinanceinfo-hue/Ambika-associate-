import React, { useState } from 'react';
import { Download, Package, Smartphone, X } from 'lucide-react';
import type { Lang } from '../lib/i18n';

interface MobileAppPromptBannerProps {
  lang: Lang;
  isInstalled: boolean;
  isInstallable: boolean;
  isIOS: boolean;
  hasUploadedApk?: boolean;
  apkDownloadUrl?: string | null;
  onInstallPWA: () => Promise<boolean>;
  onOpenInstallModal: () => void;
}

const DISMISS_KEY = 'ambika_mobile_prompt_dismissed_v1';

export const MobileAppPromptBanner: React.FC<MobileAppPromptBannerProps> = ({
  lang,
  isInstalled,
  isInstallable,
  isIOS,
  hasUploadedApk,
  apkDownloadUrl,
  onInstallPWA,
  onOpenInstallModal,
}) => {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [installing, setInstalling] = useState(false);

  if (isInstalled || dismissed) {
    return null;
  }

  const originParam =
    typeof window !== 'undefined' ? encodeURIComponent(window.location.origin) : '';
  const directApkHref = `/api/public/download-apk?origin=${originParam}`;
  const hasBinaryApk = Boolean(hasUploadedApk || apkDownloadUrl);

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore storage error
    }
  };

  const handleInstallClick = async () => {
    if (isInstallable) {
      setInstalling(true);
      try {
        const ok = await onInstallPWA();
        if (!ok) {
          onOpenInstallModal();
        }
      } finally {
        setInstalling(false);
      }
      return;
    }
    onOpenInstallModal();
  };

  return (
    <div className="bg-gradient-to-r from-[#0F2744] to-[#16365D] text-white border border-yellow-400/30 rounded-xl px-4 py-3 shadow-sm flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <img
          src="/pwa-192x192.png"
          alt="AMBIKA ASSOCIATE App Icon"
          className="w-10 h-10 rounded-xl border border-yellow-400/50 object-cover shrink-0 bg-[#0F2744]"
        />
        <div className="min-w-0">
          <div className="text-xs sm:text-sm font-display font-bold truncate">
            {lang === 'hi'
              ? 'AMBIKA ASSOCIATE मोबाइल ऐप (फुल वर्जन)'
              : 'Install AMBIKA ASSOCIATE Full Mobile App'}
          </div>
          <div className="text-[11px] text-slate-300 truncate">
            {isIOS
              ? 'iPhone / iPod Touch / iPad (iOS) Full App & Android APK ready'
              : 'Android APK, iPhone / iPod (iOS) & Offline Field CRM'}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <a
          href={directApkHref}
          download={hasBinaryApk ? 'ambika-associate-crm.apk' : undefined}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold transition-colors whitespace-nowrap"
        >
          <Package className="w-3.5 h-3.5" />
          <span>{lang === 'hi' ? 'Download APK' : 'Download APK'}</span>
        </a>

        <button
          type="button"
          disabled={installing}
          onClick={handleInstallClick}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#15803D] hover:bg-green-700 text-white text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-60"
        >
          {isIOS ? <Smartphone className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
          <span>
            {installing
              ? 'Installing...'
              : isIOS
              ? lang === 'hi'
                ? 'iPhone / iPod ऐप इंस्टॉल'
                : 'Install iPhone / iPod App'
              : lang === 'hi'
              ? 'मोबाइल ऐप इंस्टॉल करें'
              : 'Install Full App'}
          </span>
        </button>

        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss Mobile App Prompt"
          className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
