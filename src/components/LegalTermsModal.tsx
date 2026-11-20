import React, { useState } from 'react';
import { CheckCircle2, FileText, ShieldCheck, Trash2, X } from 'lucide-react';
import type { Lang } from '../lib/i18n';

export type LegalTab = 'terms' | 'privacy' | 'permissions' | 'deletion';

interface LegalTermsModalProps {
  lang: Lang;
  initialTab?: LegalTab;
  onAccept?: () => void;
  onClose: () => void;
}

export const LegalTermsModal: React.FC<LegalTermsModalProps> = ({
  lang,
  initialTab = 'terms',
  onAccept,
  onClose,
}) => {
  const [tab, setTab] = useState<LegalTab>(initialTab);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-2xl w-full border border-slate-200 shadow-2xl overflow-hidden my-auto">
        <div className="bg-[#0F2744] text-white px-5 py-4 flex items-center justify-between gap-3 border-b border-white/10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-[#EA580C] text-white shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-display font-bold truncate">
                AMBIKA ASSOCIATE CRM — Terms, Privacy &amp; Play Store Compliance
              </div>
              <div className="text-[11px] text-yellow-300 truncate">
                in.ambikaassociate.crm · Data Safety, Permissions &amp; User Consent Policy
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Legal Modal"
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pt-3 bg-slate-50 border-b border-slate-200 flex flex-wrap gap-1.5">
          {[
            { id: 'terms', label: lang === 'hi' ? 'नियम व शर्तें (Terms)' : 'Terms & Conditions' },
            { id: 'privacy', label: lang === 'hi' ? 'गोपनीयता नीति (Privacy)' : 'Privacy Policy' },
            { id: 'permissions', label: lang === 'hi' ? 'ऐप अनुमतियां (Permissions)' : 'App Permissions' },
            { id: 'deletion', label: lang === 'hi' ? 'खाता हटाना (Deletion)' : 'Account Deletion' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id as any)}
              className={`px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 whitespace-nowrap transition-colors ${
                tab === item.id
                  ? 'border-[#EA580C] text-[#0F2744] bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="p-5 max-h-[65vh] overflow-y-auto space-y-4 text-xs text-slate-700 leading-relaxed">
          {tab === 'terms' && (
            <div className="space-y-3">
              <div className="font-display font-bold text-sm text-[#0F2744] flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#EA580C]" />
                Authorized CRM Usage Terms &amp; Conditions
              </div>
              <p>
                <strong>1. Authorized Accounts &amp; Hierarchy:</strong> Access to AMBIKA ASSOCIATE CRM is strictly for authorized staff and registered DSA/Referral Partners under the company hierarchy (1 Branch Manager → up to 10 Team Leaders → up to 10 Field Officers → up to 50 Referral Partners). Super Admin may disable or revoke any login ID at any time.
              </p>
              <p>
                <strong>2. Mandatory Customer Consent:</strong> Users must confirm explicit customer consent before submitting leads, scanning PAN cards, uploading KYC documents, or recording follow-up conversations.
              </p>
              <p>
                <strong>3. Confidentiality &amp; Data Protection:</strong> Customer loan applications, mobile numbers, PAN details, and bank/NBFC records are confidential business records. Referral Partners only receive redacted progress updates. Unauthorized copying or external sharing is strictly prohibited.
              </p>
              <p>
                <strong>4. SLA &amp; Accuracy:</strong> False leads, duplicate manipulation, or unapproved field claims are subject to automated SLA penalty review.
              </p>
            </div>
          )}

          {tab === 'privacy' && (
            <div className="space-y-3">
              <div className="font-display font-bold text-sm text-[#0F2744]">
                Privacy Policy &amp; Encryption Standards
              </div>
              <p>
                <strong>Data Collected:</strong> Employee/Partner ID, name, mobile, email, customer loan application fields, consented KYC/PAN scans, field visit GPS coordinates (when active), and optional consented follow-up call recordings.
              </p>
              <p>
                <strong>Security:</strong> All API traffic is encrypted via HTTPS/TLS. Customer mobile numbers, PAN numbers, and addresses are encrypted at rest on the server, and passwords are hashed with bcrypt. We never sell user or customer data to third parties.
              </p>
              <p>
                <strong>7-Day Audio Auto-Delete:</strong> Customer follow-up call recordings are restricted to Super Admin playback only and are automatically purged after 7 days (1 week).
              </p>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 font-mono text-[11px]">
                Public Policy URL: {typeof window !== 'undefined' ? `${window.location.origin}/privacy-policy` : '/privacy-policy'}
              </div>
            </div>
          )}

          {tab === 'permissions' && (
            <div className="space-y-2.5">
              <div className="font-display font-bold text-sm text-[#0F2744]">
                Prominent Disclosure — Android App Permissions
              </div>
              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                <strong>Camera:</strong> Used when tapping Quick Camera / Document Scanner to scan PAN cards (on-device OCR pre-fill) and capture geotagged field visit verification photos.
              </div>
              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                <strong>Precise Location (GPS + Foreground Service):</strong> Used during Field Officer check-in and active Bike Run mileage tracking with a visible notification and explicit GPS consent.
              </div>
              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                <strong>Microphone (Record Audio):</strong> Used only when voluntarily recording a consented customer follow-up conversation (auto-deleted after 7 days).
              </div>
              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                <strong>Phone Dialer (`tel:`):</strong> Launches your phone&apos;s dialer when tapping a customer mobile number for follow-up calling.
              </div>
            </div>
          )}

          {tab === 'deletion' && (
            <div className="space-y-3">
              <div className="font-display font-bold text-sm text-[#0F2744] flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-[#DC2626]" />
                Account &amp; Data Deletion Policy
              </div>
              <p>
                Users can request immediate deactivation of their login ID and revocation of all active tokens/OTP sessions via:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li><strong>Super Admin / Back Office Console:</strong> Instant account deactivation or Referral ID removal.</li>
                <li>
                  <strong>Email Request:</strong> Send your Employee/Referral Code to{' '}
                  <span className="font-mono font-semibold">rajadineshgupta0@gmail.com</span> or{' '}
                  <span className="font-mono font-semibold">support@ambikaassociate.in</span>.
                </li>
              </ul>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 font-mono text-[11px]">
                Public Deletion URL: {typeof window !== 'undefined' ? `${window.location.origin}/account-deletion` : '/account-deletion'}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-3 text-[11px]">
            <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-[#0F2744] font-semibold hover:underline">
              Open Privacy URL ↗
            </a>
            <a href="/terms-and-conditions" target="_blank" rel="noopener noreferrer" className="text-[#0F2744] font-semibold hover:underline">
              Open Terms URL ↗
            </a>
            <a href="/account-deletion" target="_blank" rel="noopener noreferrer" className="text-[#0F2744] font-semibold hover:underline">
              Open Deletion URL ↗
            </a>
          </div>
          <div className="flex items-center gap-2">
            {onAccept && (
              <button
                type="button"
                onClick={() => {
                  onAccept();
                  onClose();
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                {lang === 'hi' ? 'मैं सहमत हूँ (Accept)' : 'Accept Terms & Continue'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold"
            >
              {lang === 'hi' ? 'बंद करें' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
