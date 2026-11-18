import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FolderArchive,
  Package,
  QrCode,
  Share2,
  ShieldCheck,
  Smartphone,
  Store,
  X,
} from 'lucide-react';
import type { Lang } from '../lib/i18n';

interface AppInstallModalProps {
  lang: Lang;
  logoDataUrl?: string | null;
  isInstallable: boolean;
  isInstalled: boolean;
  isIOS: boolean;
  isAndroid?: boolean;
  onInstallPWA: () => Promise<boolean>;
  playStoreUrl?: string | null;
  apkDownloadUrl?: string | null;
  hasUploadedApk?: boolean;
  apkFileSize?: number | null;
  onClose: () => void;
}

export const AppInstallModal: React.FC<AppInstallModalProps> = ({
  lang,
  logoDataUrl,
  isInstallable,
  isInstalled,
  isIOS,
  isAndroid,
  onInstallPWA,
  playStoreUrl,
  apkDownloadUrl,
  hasUploadedApk,
  apkFileSize,
  onClose,
}) => {
  const [installing, setInstalling] = useState(false);
  const [installNotice, setInstallNotice] = useState<string | null>(null);
  const [platformTab, setPlatformTab] = useState<'mobile_qr' | 'android' | 'ios' | 'pwa'>(
    isIOS ? 'ios' : isAndroid ? 'android' : 'mobile_qr'
  );
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const defaultMobileUrl = currentOrigin.includes('ais-dev-')
    ? currentOrigin.replace('ais-dev-', 'ais-pre-')
    : currentOrigin;
  const [mobileTestUrl, setMobileTestUrl] = useState<string>(defaultMobileUrl);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    const clean = mobileTestUrl.trim();
    if (!clean) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(clean, { width: 220, margin: 1, color: { dark: '#0F2744', light: '#FFFFFF' } })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mobileTestUrl]);

  const handleCopyMobileUrl = async () => {
    try {
      await navigator.clipboard.writeText(mobileTestUrl.trim());
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const originParam =
    typeof window !== 'undefined' ? encodeURIComponent(window.location.origin) : '';
  const directApkHref = `/api/public/download-apk?origin=${originParam}`;
  const androidKitHref = `/api/public/android-app-kit?origin=${originParam}`;
  const iosProfileHref = `/api/public/ios-app-profile?origin=${originParam}`;
  const hasDirectBinaryApk = Boolean(hasUploadedApk || apkDownloadUrl);
  const apkSizeLabel = apkFileSize ? `${(apkFileSize / (1024 * 1024)).toFixed(1)} MB` : null;

  const handleOneTapInstall = async () => {
    setInstalling(true);
    setInstallNotice(null);
    try {
      const accepted = await onInstallPWA();
      if (accepted) {
        setInstallNotice(
          lang === 'hi'
            ? 'AMBIKA ASSOCIATE ऐप सफलतापूर्वक इंस्टॉल हो गया है!'
            : 'AMBIKA ASSOCIATE Full App installed on your device!'
        );
      } else {
        setInstallNotice(
          lang === 'hi'
            ? 'इंस्टॉल प्रॉम्प्ट रद्द किया गया। आप ब्राउज़र मेनू से कभी भी इंस्टॉल कर सकते हैं।'
            : 'Install prompt dismissed. You can install anytime from Chrome/Safari menu.'
        );
      }
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-xl w-full border border-slate-200 shadow-2xl overflow-hidden my-auto">
        {/* Header with Official AMBIKA ASSOCIATE App Icon */}
        <div className="bg-[#0F2744] text-white px-5 py-4 flex items-center justify-between gap-4 border-b border-white/10">
          <div className="flex items-center gap-3.5 min-w-0">
            <img
              src="/pwa-512x512.png"
              alt="AMBIKA ASSOCIATE Mobile App Icon"
              className="w-14 h-14 rounded-2xl border-2 border-yellow-400/60 shadow-md object-cover shrink-0 bg-[#0F2744]"
            />
            <div className="min-w-0">
              <div className="text-base font-display font-bold tracking-tight truncate">
                AMBIKA ASSOCIATE CRM — Mobile Full Version
              </div>
              <div className="text-[11px] font-medium text-yellow-300 truncate">
                Android APK · iPhone · iPod Touch · iPad · Offline Sync
              </div>
              <div className="text-[10px] font-mono text-slate-300 mt-0.5 truncate">
                in.ambikaassociate.crm · Camera, Voice Call Recording &amp; GPS Ready
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close App Download Modal"
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Platform Switcher Tabs */}
        <div className="px-5 pt-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-1.5">
          {[
            { id: 'mobile_qr', label: lang === 'hi' ? 'मोबाइल QR टेस्ट लिंक' : 'Open on Mobile (QR)' },
            { id: 'android', label: lang === 'hi' ? 'Android APK / Play Store' : 'Android APK & Store' },
            { id: 'ios', label: lang === 'hi' ? 'iPhone / iPod / iPad (iOS)' : 'iPhone / iPod / iPad (iOS)' },
            { id: 'pwa', label: lang === 'hi' ? 'तुरंत फुल ऐप (PWA)' : 'Instant Full App (PWA)' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setPlatformTab(tab.id as any)}
              className={`px-3.5 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-colors whitespace-nowrap ${
                platformTab === tab.id
                  ? 'border-[#EA580C] text-[#0F2744] bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          {installNotice && (
            <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-xs font-medium text-[#15803D] flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{installNotice}</span>
            </div>
          )}

          {/* Quick Download APK + Instant Install Bar (Always prominent inside the prompt) */}
          <div className="p-3.5 rounded-xl bg-orange-50/70 border border-orange-200 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-display font-bold text-[#0F2744]">
                {lang === 'hi'
                  ? 'Android APK डाउनलोड करें'
                  : 'Direct Android APK Download'}
              </div>
              <div className="text-[11px] text-slate-600 mt-0.5">
                {hasUploadedApk
                  ? `Signed APK ready (${apkSizeLabel || 'Android 8.0+'}) · Full CRM + Camera + Call Recording`
                  : apkDownloadUrl
                  ? 'External hosted signed APK ready for Android installation'
                  : 'Downloads pre-configured Android APK Studio Kit (live URL & Ambika icon embedded)'}
              </div>
            </div>
            <a
              href={directApkHref}
              download={hasUploadedApk ? 'ambika-associate-crm.apk' : undefined}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold shadow-xs transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-4 h-4" />
              <span>{lang === 'hi' ? 'Download APK' : 'Download APK'}</span>
            </a>
          </div>

          {platformTab === 'mobile_qr' && (
            <div className="rounded-xl border border-[#0F2744]/20 bg-slate-50 p-4 flex flex-col sm:flex-row items-center gap-4">
              <div className="bg-white p-2.5 rounded-xl border border-slate-200 shadow-xs shrink-0">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Scan QR to open Ambika CRM on Mobile"
                    className="w-36 h-36 object-contain"
                  />
                ) : (
                  <div className="w-36 h-36 flex items-center justify-center text-slate-400">
                    <QrCode className="w-10 h-10" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-2.5 w-full">
                <div className="text-sm font-display font-bold text-[#0F2744]">
                  {lang === 'hi'
                    ? 'फोन कैमरे से स्कैन करके तुरंत चलाएं'
                    : 'Scan with Phone Camera to Operate & Test on Mobile'}
                </div>
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  {lang === 'hi'
                    ? 'Android Chrome या iPhone Safari में लिंक खोलें → "Install App" / "Add to Home Screen" चुनें और फुल-स्क्रीन मोबाइल ऐप के रूप में उपयोग करें।'
                    : 'Open on Android Chrome or iPhone Safari, then tap "Install App" / "Add to Home Screen" to operate the full-screen app with Camera OCR, GPS, Call Recording & 3-Stage Lead Routing.'}
                </p>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={mobileTestUrl}
                    onChange={(e) => setMobileTestUrl(e.target.value)}
                    aria-label="Mobile App Test URL"
                    className="flex-1 min-w-0 px-2.5 py-1.5 text-[11px] font-mono bg-white border border-slate-300 rounded-lg text-[#0F2744]"
                  />
                  <button
                    type="button"
                    onClick={handleCopyMobileUrl}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-[11px] font-semibold whitespace-nowrap shrink-0"
                  >
                    {copiedUrl ? <Check className="w-3.5 h-3.5 text-green-300" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedUrl ? 'Copied' : 'Copy'}
                  </button>
                </div>
                {currentOrigin && defaultMobileUrl !== currentOrigin && (
                  <div className="flex flex-wrap gap-1.5 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setMobileTestUrl(defaultMobileUrl)}
                      className={`px-2 py-0.5 rounded border ${
                        mobileTestUrl === defaultMobileUrl
                          ? 'bg-[#0F2744] text-white border-[#0F2744]'
                          : 'bg-white text-slate-600 border-slate-300'
                      }`}
                    >
                      Shared App URL (Recommended)
                    </button>
                    <button
                      type="button"
                      onClick={() => setMobileTestUrl(currentOrigin)}
                      className={`px-2 py-0.5 rounded border ${
                        mobileTestUrl === currentOrigin
                          ? 'bg-[#0F2744] text-white border-[#0F2744]'
                          : 'bg-white text-slate-600 border-slate-300'
                      }`}
                    >
                      Dev Preview URL
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {platformTab === 'android' && (
            <div className="space-y-3">
              {/* Android Native App + APK Card */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-[#EA580C]/10 text-[#EA580C] shrink-0">
                    <Package className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-display font-bold text-[#0F2744]">
                      {lang === 'hi'
                        ? 'Android फोन ऐप इंस्टॉल विकल्प'
                        : 'Android Mobile Full Version Options'}
                    </h3>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Includes full CRM dashboard, offline lead sync, PAN card OCR, visit selfie geotagging, follow-up call recording, and background GPS.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <a
                    href={directApkHref}
                    download={hasUploadedApk ? 'ambika-associate-crm.apk' : undefined}
                    className="inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    <span>
                      {hasDirectBinaryApk
                        ? lang === 'hi'
                          ? 'APK फ़ाइल डाउनलोड करें'
                          : 'Download Android APK'
                        : lang === 'hi'
                        ? 'Download APK Kit'
                        : 'Download APK Builder Kit'}
                    </span>
                  </a>

                  {playStoreUrl ? (
                    <a
                      href={playStoreUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold transition-colors"
                    >
                      <Store className="w-4 h-4 text-yellow-300" />
                      <span>{lang === 'hi' ? 'Google Play Store खोलें' : 'Open Google Play Store'}</span>
                      <ExternalLink className="w-3.5 h-3.5 opacity-80" />
                    </a>
                  ) : isInstallable ? (
                    <button
                      type="button"
                      disabled={installing}
                      onClick={handleOneTapInstall}
                      className="inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold transition-colors disabled:opacity-60"
                    >
                      <Smartphone className="w-4 h-4" />
                      <span>{installing ? 'Installing...' : 'One-Tap Android App Install'}</span>
                    </button>
                  ) : (
                    <a
                      href={androidKitHref}
                      download="ambika-associate-android-studio-kit.tar.gz"
                      className="inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-lg border border-[#0F2744] text-[#0F2744] hover:bg-[#0F2744] hover:text-white text-xs font-semibold transition-colors"
                    >
                      <FolderArchive className="w-4 h-4" />
                      <span>Android Studio Source (.tar.gz)</span>
                    </a>
                  )}
                </div>

                {!hasDirectBinaryApk && (
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-[11px] text-slate-600 space-y-1">
                    <div className="font-semibold text-[#0F2744]">
                      How to distribute a single-tap .apk binary:
                    </div>
                    <div>
                      1. Download the pre-configured Android Studio Kit above (live server URL &amp; AMBIKA ASSOCIATE launcher icon already embedded).
                      <br />
                      2. Run <code className="font-mono bg-white px-1 py-0.5 rounded border border-slate-200">./gradlew assembleRelease</code> in Android Studio, then upload the generated <span className="font-mono">.apk</span> in <strong>Admin Settings → Rules &amp; Branding</strong>.
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {platformTab === 'ios' && (
            <div className="space-y-3">
              {/* iPhone / iPod Touch / iPad Full Version Profile */}
              <div className="rounded-xl border border-[#0F2744]/30 bg-blue-50/40 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-[#0F2744] text-white shrink-0">
                    <Smartphone className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-display font-bold text-[#0F2744]">
                      iPhone, iPod Touch &amp; iPad Full App Version (iOS)
                    </h3>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Apple iOS/iPod devices do not use Android .apk files. Use the native Apple WebClip profile or Safari Home Screen installer below for full-screen standalone app mode with the AMBIKA ASSOCIATE icon.
                    </p>
                  </div>
                </div>

                <a
                  href={iosProfileHref}
                  download="ambika-associate-crm.mobileconfig"
                  className="w-full py-2.5 px-4 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
                >
                  <Download className="w-4 h-4 text-yellow-300" />
                  <span>
                    {lang === 'hi'
                      ? 'iPhone / iPod ऐप प्रोफ़ाइल डाउनलोड करें (.mobileconfig)'
                      : 'Install iPhone / iPod Full App Profile (.mobileconfig)'}
                  </span>
                </a>

                <div className="p-3 rounded-lg bg-white border border-slate-200 text-xs text-slate-700 space-y-1.5 leading-relaxed">
                  <div className="font-semibold text-[#0F2744]">
                    {lang === 'hi'
                      ? 'तरीका 1 (प्रोफ़ाइल से) या तरीका 2 (Safari से):'
                      : 'Option A (Profile) or Option B (Safari Direct):'}
                  </div>
                  <div>
                    <strong>Option A (iPhone / iPod / iPad Profile):</strong> Tap the button above → tap <strong>Allow</strong> → open <strong>Settings → Profile Downloaded → Install</strong>. Full-screen Ambika CRM appears on your Home Screen.
                  </div>
                  <div className="pt-1 border-t border-slate-100 flex items-start gap-1.5">
                    <Share2 className="w-3.5 h-3.5 text-[#EA580C] mt-0.5 shrink-0" />
                    <span>
                      <strong>Option B (Safari Direct):</strong> Tap Safari&apos;s <strong>Share (□↑)</strong> button → tap <strong>Add to Home Screen</strong> → tap <strong>Add</strong>.
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {platformTab === 'pwa' && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-[#15803D]/10 text-[#15803D] shrink-0">
                    <ShieldCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-display font-bold text-[#0F2744]">
                      {lang === 'hi'
                        ? 'तुरंत मोबाइल / डेस्कटॉप फुल ऐप (PWA)'
                        : 'Instant Mobile & Desktop Full App (PWA)'}
                    </h3>
                    <p className="text-xs text-slate-600 mt-0.5">
                      {lang === 'hi'
                        ? 'ऑफलाइन लीड सेव + ऑटो सिंक, कैमरा, कॉल रिकॉर्डिंग व GPS के साथ होम स्क्रीन पर इंस्टॉल करें।'
                        : 'Installs full-screen mobile app with offline lead capture, auto-sync, camera & GPS on Android, iPhone, iPod, and Desktop.'}
                    </p>
                  </div>
                </div>
                {logoDataUrl && (
                  <img
                    src={logoDataUrl}
                    alt="Custom Branding"
                    className="w-8 h-8 rounded object-contain bg-white border border-slate-200 p-0.5 shrink-0"
                  />
                )}
              </div>

              {isInstalled ? (
                <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-green-100 text-[#15803D] text-xs font-semibold">
                  <CheckCircle2 className="w-4 h-4" />
                  {lang === 'hi'
                    ? 'ऐप पहले से इंस्टॉल मोड में चल रहा है'
                    : 'Running in Full Installed App Mode'}
                </div>
              ) : isInstallable ? (
                <button
                  type="button"
                  disabled={installing}
                  onClick={handleOneTapInstall}
                  className="w-full py-2.5 px-4 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
                >
                  <Download className="w-4 h-4" />
                  {installing
                    ? lang === 'hi'
                      ? 'इंस्टॉल हो रहा है...'
                      : 'Installing...'
                    : lang === 'hi'
                    ? 'अभी फुल मोबाइल ऐप इंस्टॉल करें'
                    : 'Install Full App Now (One-Tap)'}
                </button>
              ) : (
                <div className="text-xs text-slate-700 bg-white border border-slate-200 rounded-lg p-3 leading-relaxed">
                  <strong>In Chrome / Edge:</strong> Tap menu <strong>⋮</strong> →{' '}
                  <strong>Install app / Add to Home screen</strong>. On <strong>iPhone / iPod / iPad</strong>, switch to the{' '}
                  <strong>iPhone / iPod / iPad (iOS)</strong> tab above.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
          <span className="text-[11px] text-slate-500">
            Supports Android 8+, iPhone, iPod Touch &amp; iPad
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold transition-colors"
          >
            {lang === 'hi' ? 'बंद करें' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
};
