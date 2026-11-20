import React, { useState } from 'react';
import { Lock, ShieldCheck, Smartphone, Eye, EyeOff, Languages, Download, Package } from 'lucide-react';
import type { AuthUser } from '../../shared/types';
import { apiFetch, setStoredToken } from '../lib/api';
import type { Lang } from '../lib/i18n';
import { usePWAInstall } from '../lib/usePWAInstall';
import { AppInstallModal } from './AppInstallModal';
import { BrandMark } from './BrandMark';
import { MobileAppPromptBanner } from './MobileAppPromptBanner';
import { LegalTermsModal, type LegalTab } from './LegalTermsModal';

interface LoginViewProps {
  logoDataUrl: string | null;
  playStoreUrl?: string | null;
  apkDownloadUrl?: string | null;
  hasUploadedApk?: boolean;
  apkFileSize?: number | null;
  hasUploadedAab?: boolean;
  aabFileSize?: number | null;
  lang: Lang;
  onToggleLang: () => void;
  onAuthenticated: (user: AuthUser) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({
  logoDataUrl,
  playStoreUrl,
  apkDownloadUrl,
  hasUploadedApk,
  apkFileSize,
  hasUploadedAab,
  aabFileSize,
  lang,
  onToggleLang,
  onAuthenticated,
}) => {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAppModal, setShowAppModal] = useState(false);
  const [legalModalTab, setLegalModalTab] = useState<LegalTab | null>(null);
  const [termsAccepted, setTermsAccepted] = useState<boolean>(() => {
    try {
      return localStorage.getItem('ambika_terms_accepted_v1') === 'true';
    } catch {
      return false;
    }
  });
  const { isInstallable, isInstalled, isIOS, isAndroid, install } = usePWAInstall();

  const [otpChallenge, setOtpChallenge] = useState<{
    challengeId: number;
    maskedMobile: string;
    verificationOtpPreview?: string;
  } | null>(null);
  const [otpCode, setOtpCode] = useState('');

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!termsAccepted) {
      setError(
        lang === 'hi'
          ? 'कृपया साइन इन करने से पहले नियम व शर्तें, गोपनीयता नीति और अनुमति प्रकटीकरण स्वीकार करें।'
          : 'Please accept the Terms & Conditions, Privacy Policy, and Permission Disclosure before signing in.'
      );
      return;
    }
    try {
      localStorage.setItem('ambika_terms_accepted_v1', 'true');
    } catch {
      // ignore storage errors
    }
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<any>('/auth/login', {
        method: 'POST',
        json: { identifier: identifier.trim(), password: password.trim() },
      });
      if (res.requiresOtp) {
        setOtpChallenge({
          challengeId: res.challengeId,
          maskedMobile: res.maskedMobile,
          verificationOtpPreview: res.verificationOtpPreview,
        });
      } else if (res.token && res.user) {
        setStoredToken(res.token);
        onAuthenticated(res.user);
      }
    } catch (err: any) {
      setError(err.message || 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpChallenge) return;
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/auth/verify-otp', {
        method: 'POST',
        json: { challengeId: otpChallenge.challengeId, otpCode },
      });
      setStoredToken(res.token);
      onAuthenticated(res.user);
    } catch (err: any) {
      setError(err.message || 'OTP verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-[#0F2744] text-white px-4 sm:px-6 py-4 flex items-center justify-between gap-3 border-b border-white/10">
        <BrandMark logoDataUrl={logoDataUrl} darkSurface />
        <div className="flex items-center gap-2 shrink-0">
          {!isInstalled && (
            <button
              type="button"
              onClick={() => setShowAppModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{lang === 'hi' ? 'ऐप डाउनलोड / APK' : 'Get App / APK'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onToggleLang}
            className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-white/10 hover:bg-white/15 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <Languages className="w-4 h-4" />
            {lang === 'en' ? 'हिंदी' : 'English'}
          </button>
        </div>
      </header>

      <div className="max-w-6xl w-full mx-auto px-4 pt-5">
        <MobileAppPromptBanner
          lang={lang}
          isInstalled={isInstalled}
          isInstallable={isInstallable}
          isIOS={isIOS}
          hasUploadedApk={hasUploadedApk}
          apkDownloadUrl={apkDownloadUrl}
          onInstallPWA={install}
          onOpenInstallModal={() => setShowAppModal(true)}
        />
      </div>

      <main className="flex-1 max-w-xl w-full mx-auto px-4 py-6 lg:py-10 flex flex-col justify-center">
        <section className="w-full bg-white border border-slate-200 rounded-xl p-6 sm:p-8 shadow-xs">
          <div className="mb-5 pb-4 border-b border-slate-100 flex items-center justify-center bg-[#068220]/5 rounded-lg p-2">
            <img
              src={logoDataUrl || '/assets/aistudio/LOGO_AMBIKA_2025_FINAL_a8908f5d.jpg?v=20261120'}
              alt="AMBIKA ASSOCIATE — Smart Finance Smart Saving"
              referrerPolicy="no-referrer"
              className="max-h-20 w-auto rounded-md object-contain"
            />
          </div>
          <div className="mb-6">
            <p className="text-xs font-semibold tracking-wide text-[#EA580C]">
              {lang === 'hi' ? 'सुरक्षित सीआरएम पोर्टल' : 'SECURE ENTERPRISE CRM PORTAL'}
            </p>
            <h1 className="mt-1 text-2xl font-display font-bold text-[#0F2744] text-balance">
              {otpChallenge
                ? lang === 'hi'
                  ? 'मोबाइल OTP सत्यापन'
                  : 'Verify Mobile OTP'
                : lang === 'hi'
                ? 'अपने कर्मचारी खाते में साइन इन करें'
                : 'Sign in to AMBIKA ASSOCIATE CRM'}
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              {lang === 'hi'
                ? 'लीड प्रबंधन, केस ट्रैकिंग, GPS फील्ड विजिट और रिपोर्टिंग के लिए भूमिका-आधारित लॉगिन।'
                : 'Role-based access for Lead Generation, Case Tracking, Duplicate Verification, Field GPS & Reports.'}
            </p>
          </div>

          {error && (
            <div className="mb-5 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              {error}
            </div>
          )}

          {!otpChallenge ? (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  {lang === 'hi' ? 'कर्मचारी कोड / मोबाइल / ईमेल' : 'Employee Code / Mobile Number / Email'}
                </label>
                <div className="relative">
                  <Smartphone className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete="username"
                    spellCheck={false}
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="Employee Code, Mobile or Email"
                    className="w-full pl-10 pr-4 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20 focus:border-[#0F2744]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  {lang === 'hi' ? 'पासवर्ड' : 'Password'}
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type={showPass ? 'text' : 'password'}
                    required
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete="current-password"
                    spellCheck={false}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                    className="w-full pl-10 pr-10 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20 focus:border-[#0F2744]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                    aria-label="Toggle password visibility"
                  >
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <label className="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-200 cursor-pointer text-xs text-slate-600 leading-relaxed">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => {
                    setTermsAccepted(e.target.checked);
                    if (e.target.checked) setError(null);
                  }}
                  className="mt-0.5 rounded border-slate-300 text-[#0F2744] focus:ring-[#0F2744]"
                />
                <span>
                  {lang === 'hi' ? 'मैं ' : 'I accept the '}
                  <button
                    type="button"
                    onClick={() => setLegalModalTab('terms')}
                    className="font-semibold text-[#0F2744] underline hover:text-[#EA580C]"
                  >
                    Terms &amp; Conditions
                  </button>
                  {', '}
                  <button
                    type="button"
                    onClick={() => setLegalModalTab('privacy')}
                    className="font-semibold text-[#0F2744] underline hover:text-[#EA580C]"
                  >
                    Privacy Policy
                  </button>
                  {' & '}
                  <button
                    type="button"
                    onClick={() => setLegalModalTab('permissions')}
                    className="font-semibold text-[#0F2744] underline hover:text-[#EA580C]"
                  >
                    Location/Camera/Audio Disclosure
                  </button>
                  {lang === 'hi' ? ' स्वीकार करता हूँ।' : '.'}
                </span>
              </label>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white font-semibold text-sm transition-colors disabled:opacity-60"
              >
                {loading
                  ? lang === 'hi'
                    ? 'सत्यापित किया जा रहा है...'
                    : 'Authenticating...'
                  : lang === 'hi'
                  ? 'सुरक्षित लॉगिन करें'
                  : 'Sign In Securely'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleOtpSubmit} className="space-y-4">
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-700">
                OTP sent to registered mobile <span className="font-mono font-semibold">{otpChallenge.maskedMobile}</span>.
                {otpChallenge.verificationOtpPreview && (
                  <div className="mt-1 text-xs text-[#15803D] font-mono">
                    Verification OTP Code: <strong>{otpChallenge.verificationOtpPreview}</strong>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">6-Digit OTP</label>
                <input
                  type="text"
                  required
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  placeholder="Enter 6-digit OTP"
                  className="w-full px-4 py-2.5 text-sm font-mono tracking-widest border border-slate-300 rounded-lg focus:outline-none focus:border-[#0F2744]"
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setOtpChallenge(null);
                    setOtpCode('');
                  }}
                  className="px-4 py-2.5 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 py-2.5 px-4 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white font-semibold text-sm transition-colors"
                >
                  {loading ? 'Verifying...' : 'Verify OTP & Sign In'}
                </button>
              </div>
            </form>
          )}

          <div className="mt-6 pt-5 border-t border-slate-200 space-y-3">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <ShieldCheck className="w-4 h-4 text-[#15803D] shrink-0" />
              <span>AES-256 encrypted PII · Server-enforced RBAC · Full audit trail</span>
            </div>
            {!isInstalled && (
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <img
                    src="/pwa-192x192.png?v=20261120"
                    alt="AMBIKA ASSOCIATE App Icon"
                    className="w-9 h-9 rounded-lg border border-yellow-400/50 object-cover shrink-0 bg-[#068220]"
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[#0F2744] truncate">
                      {lang === 'hi' ? 'मोबाइल ऐप इंस्टॉल / APK डाउनलोड' : 'AMBIKA ASSOCIATE Mobile App'}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {lang === 'hi' ? 'Android APK, iPhone, iPod व iPad' : 'Android APK, iPhone, iPod & iPad Full Version'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={`/api/public/download-apk?origin=${encodeURIComponent(window.location.origin)}`}
                    download={hasUploadedApk || apkDownloadUrl ? 'ambika-associate-crm.apk' : undefined}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold"
                  >
                    <Package className="w-3.5 h-3.5" />
                    <span>Download APK</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => setShowAppModal(true)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{lang === 'hi' ? 'iOS / APK' : 'Install'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white px-4 py-4">
        <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
          <span>© {new Date().getFullYear()} AMBIKA ASSOCIATE · Smart Finance Smart Saving</span>
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => setLegalModalTab('privacy')}
              className="hover:text-[#0F2744] font-medium underline"
            >
              Privacy Policy
            </button>
            <button
              type="button"
              onClick={() => setLegalModalTab('terms')}
              className="hover:text-[#0F2744] font-medium underline"
            >
              Terms &amp; Conditions
            </button>
            <button
              type="button"
              onClick={() => setLegalModalTab('permissions')}
              className="hover:text-[#0F2744] font-medium underline"
            >
              Permission Disclosure
            </button>
            <button
              type="button"
              onClick={() => setLegalModalTab('deletion')}
              className="hover:text-[#0F2744] font-medium underline"
            >
              Account &amp; Data Deletion
            </button>
          </div>
        </div>
      </footer>

      {showAppModal && (
        <AppInstallModal
          lang={lang}
          logoDataUrl={logoDataUrl}
          isInstallable={isInstallable}
          isInstalled={isInstalled}
          isIOS={isIOS}
          isAndroid={isAndroid}
          onInstallPWA={install}
          playStoreUrl={playStoreUrl}
          apkDownloadUrl={apkDownloadUrl}
          hasUploadedApk={hasUploadedApk}
          apkFileSize={apkFileSize}
          hasUploadedAab={hasUploadedAab}
          aabFileSize={aabFileSize}
          onClose={() => setShowAppModal(false)}
        />
      )}

      {legalModalTab && (
        <LegalTermsModal
          lang={lang}
          initialTab={legalModalTab}
          onAccept={() => {
            setTermsAccepted(true);
            try {
              localStorage.setItem('ambika_terms_accepted_v1', 'true');
            } catch {
              // ignore
            }
            setError(null);
            setLegalModalTab(null);
          }}
          onClose={() => setLegalModalTab(null)}
        />
      )}
    </div>
  );
};
