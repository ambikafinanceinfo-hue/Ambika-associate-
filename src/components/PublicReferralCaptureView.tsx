import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Languages, ArrowLeft, ShieldCheck, CloudOff } from 'lucide-react';
import type { LoanProductConfig } from '../../shared/types';
import { ApiError, apiFetch } from '../lib/api';
import type { Lang } from '../lib/i18n';
import { enqueueOfflineLead } from '../lib/offlineLeadQueue';
import { BrandMark } from './BrandMark';

interface PublicReferralCaptureViewProps {
  referralCode: string;
  logoDataUrl: string | null;
  lang: Lang;
  onToggleLang: () => void;
  onExitToLogin: () => void;
}

export const PublicReferralCaptureView: React.FC<PublicReferralCaptureViewProps> = ({
  referralCode,
  logoDataUrl,
  lang,
  onToggleLang,
  onExitToLogin,
}) => {
  const [partnerInfo, setPartnerInfo] = useState<{
    referralCode: string;
    partnerName: string;
    branchName: string;
    branchCity: string;
    loanProducts: LoanProductConfig[];
    companyLogoDataUrl: string | null;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    duplicateDetected?: boolean;
    queuedOffline?: boolean;
    queueId?: string;
    leadCode?: string;
    requestCode?: string;
  } | null>(null);

  const [form, setForm] = useState({
    customerName: '',
    customerMobile: '',
    panNumber: '',
    city: '',
    loanProduct: 'Home Loan',
    loanAmount: '',
    monthlyIncome: '',
    employmentType: 'Salaried',
    remarks: '',
    customerConsent: false,
  });

  useEffect(() => {
    const loadPartner = async () => {
      try {
        const res = await apiFetch<any>(`/public/referral/${encodeURIComponent(referralCode)}`);
        setPartnerInfo(res);
        if (res.loanProducts?.[0]?.name) {
          setForm((prev) => ({ ...prev, loanProduct: res.loanProducts[0].name }));
        }
      } catch (err: any) {
        setLoadError(err.message || 'Invalid Referral QR Link');
      }
    };
    loadPartner();
  }, [referralCode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    const payload = {
      referralCode,
      ...form,
      loanAmount: Number(form.loanAmount || 0),
      monthlyIncome: form.monthlyIncome ? Number(form.monthlyIncome) : null,
    };

    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const queued = await enqueueOfflineLead({
          endpoint: '/api/public/referral-lead',
          payload,
          customerName: form.customerName.trim(),
          loanProduct: form.loanProduct,
          loanAmount: Number(form.loanAmount || 0),
          bankNbfc: 'HDFC Bank',
        });
        setResult({ queuedOffline: true, queueId: queued.queueId });
        return;
      }

      const res = await apiFetch<any>('/public/referral-lead', {
        method: 'POST',
        json: payload,
      });
      setResult(res);
    } catch (err: any) {
      if (!(err instanceof ApiError)) {
        const queued = await enqueueOfflineLead({
          endpoint: '/api/public/referral-lead',
          payload,
          customerName: form.customerName.trim(),
          loanProduct: form.loanProduct,
          loanAmount: Number(form.loanAmount || 0),
          bankNbfc: 'HDFC Bank',
        });
        setResult({ queuedOffline: true, queueId: queued.queueId });
      } else {
        setSubmitError(err.message || 'Could not submit application');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-[#0F2744] text-white px-5 py-4 flex items-center justify-between gap-4 border-b border-white/10">
        <BrandMark logoDataUrl={partnerInfo?.companyLogoDataUrl ?? logoDataUrl} darkSurface />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleLang}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-white/10 hover:bg-white/15 text-white whitespace-nowrap shrink-0"
          >
            <Languages className="w-4 h-4" />
            {lang === 'en' ? 'हिंदी' : 'English'}
          </button>
          <button
            type="button"
            onClick={onExitToLogin}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Staff Login
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-8">
        {loadError ? (
          <div className="bg-white border border-red-200 rounded-xl p-6 text-center space-y-3">
            <AlertTriangle className="w-8 h-8 text-[#DC2626] mx-auto" />
            <h1 className="text-base font-display font-bold text-[#0F2744]">Referral Link Unavailable</h1>
            <p className="text-xs text-slate-600">{loadError}</p>
            <button
              type="button"
              onClick={onExitToLogin}
              className="px-4 py-2 rounded-lg bg-[#0F2744] text-white text-xs font-semibold"
            >
              Go to AMBIKA ASSOCIATE Portal
            </button>
          </div>
        ) : result ? (
          <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 text-center space-y-4">
            {result.queuedOffline ? (
              <>
                <CloudOff className="w-10 h-10 text-[#EA580C] mx-auto" />
                <h1 className="text-lg font-display font-bold text-[#0F2744]">
                  {lang === 'hi' ? 'ऑफ़लाइन सहेजा गया — ऑटो-सिंक तैयार' : 'Saved Offline — Auto-Sync Ready'}
                </h1>
                <p className="text-xs text-slate-600">
                  {lang === 'hi'
                    ? 'इंटरनेट वापस आते ही आपका लोन आवेदन स्वतः सर्वर पर सबमिट हो जाएगा।'
                    : 'Your loan application is safely stored offline and will automatically submit to AMBIKA ASSOCIATE as soon as internet connectivity is restored.'}
                </p>
                <div className="inline-block px-4 py-2 rounded-lg bg-slate-50 border border-slate-200 font-mono text-sm font-bold text-[#0F2744]">
                  {result.queueId}
                </div>
              </>
            ) : result.duplicateDetected ? (
              <>
                <AlertTriangle className="w-10 h-10 text-amber-600 mx-auto" />
                <h1 className="text-lg font-display font-bold text-[#0F2744]">
                  {lang === 'hi' ? 'आपका आवेदन पहले से दर्ज है' : 'Existing Application Detected'}
                </h1>
                <p className="text-xs text-slate-600">
                  {lang === 'hi'
                    ? `संदर्भ अनुरोध ${result.requestCode} हमारी टीम के पास सत्यापन के लिए भेज दिया गया है।`
                    : `Your enquiry (${result.requestCode}) has been forwarded to our verification desk. Our executive will contact you shortly.`}
                </p>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-10 h-10 text-[#15803D] mx-auto" />
                <h1 className="text-lg font-display font-bold text-[#0F2744]">
                  {lang === 'hi' ? 'लोन आवेदन सफलतापूर्वक दर्ज!' : 'Loan Request Submitted Successfully'}
                </h1>
                <p className="text-xs text-slate-600">
                  {lang === 'hi'
                    ? 'आपका लीड रेफरेंस नंबर नीचे दिया गया है। हमारा फील्ड ऑफिसर 10 मिनट में आपसे संपर्क करेगा।'
                    : 'Our assigned Loan Specialist will reach out within 10 minutes with best bank/NBFC offers.'}
                </p>
                <div className="inline-block px-4 py-2 rounded-lg bg-slate-50 border border-slate-200 font-mono text-sm font-bold text-[#0F2744]">
                  {result.leadCode}
                </div>
              </>
            )}
            <div className="pt-2 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={() => setResult(null)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-[#0F2744]"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {lang === 'hi' ? 'फॉर्म पर वापस जाएं' : 'Back to Form'}
              </button>
              <button
                type="button"
                onClick={onExitToLogin}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold"
              >
                {lang === 'hi' ? 'पोर्टल पर वापस' : 'Back to Staff Portal'}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-5">
            <div className="pb-4 border-b border-slate-200">
              <div className="text-xs font-semibold text-[#EA580C]">
                {lang === 'hi' ? 'त्वरित लोन पात्रता अनुरोध' : 'EXPRESS LOAN APPLICATION'}
              </div>
              <h1 className="text-xl font-display font-bold text-[#0F2744] mt-1">
                {lang === 'hi' ? 'AMBIKA ASSOCIATE से सर्वोत्तम लोन ऑफ़र पाएं' : 'Get Best Bank & NBFC Loan Offers'}
              </h1>
              {partnerInfo && (
                <p className="text-xs text-slate-600 mt-1">
                  Referred via authorized DSA Partner: <strong>{partnerInfo.partnerName}</strong>{' '}
                  (<span className="font-mono">{partnerInfo.referralCode}</span> · {partnerInfo.branchName})
                </p>
              )}
            </div>

            {submitError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {submitError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {lang === 'hi' ? 'पूरा नाम *' : 'Full Name *'}
                </label>
                <input
                  type="text"
                  required
                  value={form.customerName}
                  onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {lang === 'hi' ? 'मोबाइल नंबर *' : 'Mobile Number *'}
                </label>
                <input
                  type="tel"
                  required
                  value={form.customerMobile}
                  onChange={(e) => setForm({ ...form, customerMobile: e.target.value })}
                  placeholder="10-digit mobile"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {lang === 'hi' ? 'लोन उत्पाद *' : 'Loan Product *'}
                </label>
                <select
                  value={form.loanProduct}
                  onChange={(e) => setForm({ ...form, loanProduct: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {(partnerInfo?.loanProducts || []).map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {lang === 'hi' ? 'आवश्यक लोन राशि (₹) *' : 'Loan Amount Required (₹) *'}
                </label>
                <input
                  type="number"
                  required
                  min={10000}
                  value={form.loanAmount}
                  onChange={(e) => setForm({ ...form, loanAmount: e.target.value })}
                  placeholder="e.g. 1500000"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {lang === 'hi' ? 'मासिक आय (₹)' : 'Monthly Income (₹)'}
                </label>
                <input
                  type="number"
                  value={form.monthlyIncome}
                  onChange={(e) => setForm({ ...form, monthlyIncome: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {lang === 'hi' ? 'रोज़गार प्रकार' : 'Employment Type'}
                </label>
                <select
                  value={form.employmentType}
                  onChange={(e) => setForm({ ...form, employmentType: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="Salaried">Salaried</option>
                  <option value="Self-Employed">Self-Employed / Professional</option>
                  <option value="Business">Business Owner</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {lang === 'hi' ? 'शहर' : 'City'}
                </label>
                <input
                  type="text"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {lang === 'hi' ? 'पैन नंबर (वैकल्पिक)' : 'PAN Number (Optional)'}
                </label>
                <input
                  type="text"
                  maxLength={10}
                  value={form.panNumber}
                  onChange={(e) => setForm({ ...form, panNumber: e.target.value.toUpperCase() })}
                  placeholder="ABCDE1234F"
                  className="w-full px-3 py-2 text-sm font-mono uppercase border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                required
                checked={form.customerConsent}
                onChange={(e) => setForm({ ...form, customerConsent: e.target.checked })}
                className="mt-0.5 rounded border-slate-300 accent-[#15803D]"
              />
              <span>
                {lang === 'hi'
                  ? 'मैं AMBIKA ASSOCIATE और भागीदार बैंकों/NBFC के साथ ऋण पात्रता जांच हेतु अपना विवरण साझा करने की सहमति देता/देती हूँ।'
                  : 'I authorize AMBIKA ASSOCIATE and its partner Banks/NBFCs to contact me and process my loan eligibility.'}
              </span>
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-sm font-semibold disabled:opacity-50"
            >
              {submitting
                ? lang === 'hi'
                  ? 'सबमिट किया जा रहा है...'
                  : 'Submitting...'
                : lang === 'hi'
                ? 'लोन अनुरोध सबमिट करें'
                : 'Submit Loan Request'}
            </button>

            <div className="pt-3 border-t border-slate-100 flex items-center gap-2 text-[11px] text-slate-500">
              <ShieldCheck className="w-4 h-4 text-[#15803D] shrink-0" />
              <span>Encrypted submission · Zero spam · Authorized DSA channel</span>
            </div>
          </form>
        )}
      </main>
    </div>
  );
};
