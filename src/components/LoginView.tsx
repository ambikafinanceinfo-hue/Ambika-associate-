import React, { useState } from 'react';
import { Lock, ShieldCheck, Smartphone, Eye, EyeOff, Languages, Download, Package } from 'lucide-react';
import type { AuthUser } from '../../shared/types';
import { apiFetch, setStoredToken } from '../lib/api';
import type { Lang } from '../lib/i18n';
import { usePWAInstall } from '../lib/usePWAInstall';
import { AppInstallModal } from './AppInstallModal';
import { BrandMark } from './BrandMark';
import { MobileAppPromptBanner } from './MobileAppPromptBanner';

interface LoginViewProps {
  logoDataUrl: string | null;
  playStoreUrl?: string | null;
  apkDownloadUrl?: string | null;
  hasUploadedApk?: boolean;
  apkFileSize?: number | null;
  lang: Lang;
  onToggleLang: () => void;
  onAuthenticated: (user: AuthUser) => void;
}

const TEST_ACCOUNTS = [
  { role: 'Super Admin', code: 'ADM001', pass: 'Admin@123', desc: 'Full system, duplicates, penalties, settings & audit' },
  { role: 'Branch Manager', code: 'BM001', pass: 'Branch@123', desc: 'Branch leads, staff & branch performance reports' },
  { role: 'Team Leader', code: 'TL001', pass: 'Leader@123', desc: 'Team leads, follow-ups & enquiry escalation' },
  { role: 'Back Office Lead Gen', code: 'LG001', pass: 'Backoffice@123', desc: 'Generate leads & distribute to Field Officers by Name/ID' },
  { role: 'Field Officer', code: 'FO001', pass: 'Field@123', desc: 'Assigned leads, KYC camera/docs, GPS & Bike Run' },
  { role: 'DSA / Referral Partner', code: 'REF001', pass: 'Referral@123', desc: 'Submit leads, view redacted status & raise enquiries' },
];

export const LoginView: React.FC<LoginViewProps> = ({
  logoDataUrl,
  playStoreUrl,
  apkDownloadUrl,
  hasUploadedApk,
  apkFileSize,
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
  const { isInstallable, isInstalled, isIOS, isAndroid, install } = usePWAInstall();

  const [otpChallenge, setOtpChallenge] = useState<{
    challengeId: number;
    maskedMobile: string;
    verificationOtpPreview?: string;
  } | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [showTestAccounts, setShowTestAccounts] = useState(true);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<any>('/auth/login', {
        method: 'POST',
        json: { identifier, password },
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

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6 lg:py-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
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
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="e.g. ADM001 or 9800000001"
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
                    src="/pwa-192x192.png"
                    alt="AMBIKA ASSOCIATE App Icon"
                    className="w-9 h-9 rounded-lg border border-slate-200 object-cover shrink-0 bg-[#0F2744]"
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

        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="text-base font-display font-bold text-[#0F2744]">
                {lang === 'hi' ? 'भूमिका परीक्षण खाते (Role Verification)' : 'Role Verification Test Accounts'}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Click any account below to pre-fill credentials and test server-enforced permissions.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowTestAccounts(!showTestAccounts)}
              className="text-xs font-semibold text-[#0F2744] hover:underline whitespace-nowrap shrink-0"
            >
              {showTestAccounts ? 'Hide' : 'Show'}
            </button>
          </div>

          {showTestAccounts && (
            <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden">
              {TEST_ACCOUNTS.map((acc) => (
                <button
                  key={acc.code}
                  type="button"
                  onClick={() => {
                    setIdentifier(acc.code);
                    setPassword(acc.pass);
                    setError(null);
                  }}
                  className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#0F2744]">{acc.role}</div>
                    <div className="text-xs text-slate-500 mt-0.5 truncate">{acc.desc}</div>
                  </div>
                  <div className="text-right shrink-0 font-mono text-xs">
                    <div className="font-semibold text-slate-800">{acc.code}</div>
                    <div className="text-slate-500">{acc.pass}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="mt-5 p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 space-y-1.5">
            <div className="font-semibold text-[#0F2744]">Important Referral Privacy Verification</div>
            <p>
              Sign in as <span className="font-mono font-semibold">REF001</span> to confirm that Customer Mobile,
              Address, PAN, Loan Amount, KYC Documents, Internal Remarks, and other partners&apos; enquiries are
              strictly redacted by the backend API.
            </p>
          </div>
        </section>
      </main>

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
          onClose={() => setShowAppModal(false)}
        />
      )}
    </div>
  );
};
