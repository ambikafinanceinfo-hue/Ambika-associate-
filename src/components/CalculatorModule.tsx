import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, MessageCircle, Sparkles } from 'lucide-react';
import type { LoanProductConfig, UserRole } from '../../shared/types';
import { formatInr } from '../lib/api';
import type { Lang } from '../lib/i18n';
import {
  buildQuoteText,
  downloadQuoteCardPng,
  evaluateBankEligibility,
} from '../lib/salesEngine';

interface CalculatorModuleProps {
  loanProducts: LoanProductConfig[];
  userRole?: UserRole;
  lang?: Lang;
  activeOption?: string | null;
  onSelectOption?: (opt: string) => void;
}

export const CalculatorModule: React.FC<CalculatorModuleProps> = ({
  loanProducts,
  userRole,
  lang = 'en',
  activeOption,
  onSelectOption,
}) => {
  const isFieldOfficer = userRole === 'FIELD_OFFICER';
  const [selectedProductId, setSelectedProductId] = useState(
    activeOption && loanProducts.some((p) => p.id === activeOption)
      ? activeOption
      : loanProducts[0]?.id || 'home_loan'
  );
  const [principal, setPrincipal] = useState(2500000);
  const [annualRate, setAnnualRate] = useState(loanProducts[0]?.defaultRate || 8.65);
  const [tenureMonths, setTenureMonths] = useState(240);

  // Pre-eligibility & bank matcher inputs
  const [monthlyIncome, setMonthlyIncome] = useState(95000);
  const [existingEmi, setExistingEmi] = useState(10000);
  const [employmentType, setEmploymentType] = useState('Salaried');
  const [customerName, setCustomerName] = useState('');
  const [copiedQuote, setCopiedQuote] = useState(false);

  const applyProduct = (id: string) => {
    setSelectedProductId(id);
    const found = loanProducts.find((p) => p.id === id);
    if (found) {
      setAnnualRate(found.defaultRate);
      if (tenureMonths < found.minTenureMonths) setTenureMonths(found.minTenureMonths);
      if (tenureMonths > found.maxTenureMonths) setTenureMonths(found.maxTenureMonths);
    }
  };

  useEffect(() => {
    if (activeOption && loanProducts.some((p) => p.id === activeOption)) {
      applyProduct(activeOption);
    } else if (activeOption === null && loanProducts[0]?.id) {
      applyProduct(loanProducts[0].id);
    }
  }, [activeOption]);

  const handleProductChange = (id: string) => {
    applyProduct(id);
    onSelectOption?.(id);
  };

  const result = useMemo(() => {
    const P = Math.max(0, Number(principal) || 0);
    const r = Math.max(0, Number(annualRate) || 0) / 12 / 100;
    const n = Math.max(1, Math.round(Number(tenureMonths) || 1));

    if (r === 0) {
      const emi = P / n;
      return { emi, totalRepayment: P, totalInterest: 0, principalPct: 100, schedule: [] as any[] };
    }

    const factor = Math.pow(1 + r, n);
    const emi = (P * r * factor) / (factor - 1);
    const totalRepayment = emi * n;
    const totalInterest = totalRepayment - P;
    const principalPct = totalRepayment > 0 ? Math.round((P / totalRepayment) * 100) : 0;

    const schedule: { year: number; principalPaid: number; interestPaid: number; balance: number }[] = [];
    let balance = P;
    let yrPrincipal = 0;
    let yrInterest = 0;
    for (let m = 1; m <= n; m++) {
      const interest = balance * r;
      const princ = Math.min(balance, emi - interest);
      balance = Math.max(0, balance - princ);
      yrPrincipal += princ;
      yrInterest += interest;
      if (m % 12 === 0 || m === n) {
        schedule.push({
          year: Math.ceil(m / 12),
          principalPaid: yrPrincipal,
          interestPaid: yrInterest,
          balance,
        });
        yrPrincipal = 0;
        yrInterest = 0;
      }
    }

    return { emi, totalRepayment, totalInterest, principalPct, schedule };
  }, [principal, annualRate, tenureMonths]);

  const activeProduct = loanProducts.find((p) => p.id === selectedProductId) || loanProducts[0];

  const eligibility = useMemo(
    () =>
      evaluateBankEligibility({
        loanProduct: activeProduct?.name || 'Home Loan',
        requestedAmount: principal,
        monthlyIncome,
        existingEmi,
        employmentType,
        baseRatePct: annualRate,
        tenureMonths,
      }),
    [activeProduct?.name, principal, monthlyIncome, existingEmi, employmentType, annualRate, tenureMonths]
  );

  const bestBank = isFieldOfficer ? undefined : eligibility.recommendations[0]?.bank;

  const quoteText = useMemo(
    () =>
      buildQuoteText({
        lang,
        customerName: customerName.trim() || undefined,
        loanProduct: activeProduct?.name || 'Loan',
        bankNbfc: bestBank,
        loanAmount: principal,
        ratePct: annualRate,
        tenureMonths,
        emi: result.emi,
        totalInterest: result.totalInterest,
      }),
    [lang, customerName, activeProduct?.name, bestBank, principal, annualRate, tenureMonths, result.emi, result.totalInterest]
  );

  const handleCopyQuote = async () => {
    try {
      await navigator.clipboard.writeText(quoteText);
      setCopiedQuote(true);
      setTimeout(() => setCopiedQuote(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-display font-bold text-[#0F2744]">
          {isFieldOfficer
            ? 'Loan EMI & Quote Share Calculator'
            : 'EMI, Bank Eligibility & Quote Share Calculator'}
        </h1>
        <p className="text-xs text-slate-500 mt-1">
          {isFieldOfficer
            ? 'Calculate monthly EMI and share branded AMBIKA ASSOCIATE quotes on WhatsApp or PNG card.'
            : 'Calculate monthly EMI, check instant bank FOIR eligibility, and share branded AMBIKA ASSOCIATE quotes on WhatsApp or PNG card.'}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Customer Name (for Quote Card)</label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Optional customer name"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Loan Product</label>
            <select
              value={selectedProductId}
              onChange={(e) => handleProductChange(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg bg-white"
            >
              {loanProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (Base {p.defaultRate}%)
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex justify-between text-xs font-semibold text-slate-700 mb-1.5">
              <span>Loan Amount</span>
              <span className="font-mono text-[#0F2744]">{formatInr(principal)}</span>
            </div>
            <input
              type="number"
              min={10000}
              step={10000}
              value={principal}
              onChange={(e) => setPrincipal(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
            />
            <input
              type="range"
              min={50000}
              max={20000000}
              step={50000}
              value={Math.min(20000000, principal)}
              onChange={(e) => setPrincipal(Number(e.target.value))}
              className="w-full mt-2 accent-[#EA580C]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Interest Rate (% p.a.)</label>
              <input
                type="number"
                min={1}
                max={40}
                step={0.05}
                value={annualRate}
                onChange={(e) => setAnnualRate(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Tenure (Months)</label>
              <input
                type="number"
                min={activeProduct?.minTenureMonths || 3}
                max={activeProduct?.maxTenureMonths || 360}
                value={tenureMonths}
                onChange={(e) => setTenureMonths(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {!isFieldOfficer && (
            <div className="pt-3 border-t border-slate-200 space-y-3">
              <div className="text-xs font-semibold text-[#0F2744] flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#EA580C]" />
                Customer Eligibility Inputs
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Monthly Income (₹)</label>
                  <input
                    type="number"
                    min={0}
                    step={5000}
                    value={monthlyIncome}
                    onChange={(e) => setMonthlyIncome(Number(e.target.value))}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Existing EMIs (₹)</label>
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    value={existingEmi}
                    onChange={(e) => setExistingEmi(Number(e.target.value))}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Employment Profile</label>
                <select
                  value={employmentType}
                  onChange={(e) => setEmploymentType(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="Salaried">Salaried</option>
                  <option value="Self-Employed">Self-Employed / Professional</option>
                  <option value="Business">Business Owner</option>
                </select>
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-7 space-y-4">
          <div className="bg-[#0F2744] text-white rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-xs text-slate-300">Estimated Monthly EMI</div>
                <div className="mt-1 text-3xl font-display font-bold font-mono tabular-nums text-yellow-300">
                  {formatInr(Math.round(result.emi))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyQuote}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-semibold whitespace-nowrap"
                >
                  {copiedQuote ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedQuote ? 'Quote Copied' : 'Copy Quote'}
                </button>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(quoteText)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#15803D] hover:bg-green-700 text-white text-xs font-semibold whitespace-nowrap"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  WhatsApp Quote
                </a>
                <button
                  type="button"
                  onClick={() =>
                    downloadQuoteCardPng({
                      customerName: customerName.trim() || undefined,
                      loanProduct: activeProduct?.name || 'Loan',
                      bankNbfc: bestBank,
                      loanAmount: principal,
                      ratePct: annualRate,
                      tenureMonths,
                      emi: result.emi,
                      totalInterest: result.totalInterest,
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  Quote Card PNG
                </button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 pt-4 border-t border-white/15">
              <div>
                <div className="text-xs text-slate-300">Principal Amount</div>
                <div className="mt-1 text-base font-mono font-semibold tabular-nums">{formatInr(principal)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-300">Total Interest</div>
                <div className="mt-1 text-base font-mono font-semibold tabular-nums text-orange-300">
                  {formatInr(Math.round(result.totalInterest))}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-300">Total Repayment</div>
                <div className="mt-1 text-base font-mono font-semibold tabular-nums text-emerald-300">
                  {formatInr(Math.round(result.totalRepayment))}
                </div>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs text-slate-300 mb-1.5">
                <span>Principal ({result.principalPct}%)</span>
                <span>Interest ({100 - result.principalPct}%)</span>
              </div>
              <div className="w-full h-2.5 bg-orange-500 rounded-full overflow-hidden">
                <div className="h-full bg-[#15803D]" style={{ width: `${result.principalPct}%` }} />
              </div>
            </div>
          </div>

          {/* Pre-Eligibility & Top 3 Matched Banks (hidden for Field Officers) */}
          {!isFieldOfficer && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-100">
                <div className="text-xs font-bold text-[#0F2744]">
                  Instant Pre-Eligibility &amp; Best Bank Matches
                </div>
                <div className="text-xs font-mono tabular-nums">
                  Max Eligible:{' '}
                  <strong className="text-[#15803D]">{formatInr(eligibility.maxEligibleAmount)}</strong> · FOIR:{' '}
                  <strong className={eligibility.totalFoirPct > 65 ? 'text-[#DC2626]' : 'text-[#0F2744]'}>
                    {eligibility.totalFoirPct}%
                  </strong>{' '}
                  · Odds:{' '}
                  <strong
                    className={
                      eligibility.overallOdds === 'HIGH'
                        ? 'text-[#15803D]'
                        : eligibility.overallOdds === 'MODERATE'
                        ? 'text-[#D97706]'
                        : 'text-[#DC2626]'
                    }
                  >
                    {eligibility.overallOdds}
                  </strong>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {eligibility.recommendations.map((rec) => (
                  <div key={rec.bank} className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1 text-xs">
                    <div className="font-semibold text-[#0F2744] flex items-center justify-between gap-1">
                      <span className="truncate">{rec.bank}</span>
                      <span className="font-mono text-[#EA580C]">{rec.indicativeRate}%</span>
                    </div>
                    <div className="text-[11px] text-slate-600">
                      Cap: <span className="font-mono font-semibold">{formatInr(rec.maxEligibleAmount)}</span>
                    </div>
                    <div className="text-[11px] text-slate-500">{rec.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 text-xs font-semibold text-[#0F2744]">
              Yearly Amortization Breakdown
            </div>
            <div className="max-h-60 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2 font-semibold">Year</th>
                    <th className="text-right px-4 py-2 font-semibold">Principal Paid</th>
                    <th className="text-right px-4 py-2 font-semibold">Interest Paid</th>
                    <th className="text-right px-4 py-2 font-semibold">Closing Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {result.schedule.map((row) => (
                    <tr key={row.year}>
                      <td className="px-4 py-2 font-sans font-medium text-slate-700">Year {row.year}</td>
                      <td className="px-4 py-2 text-right text-[#15803D]">{formatInr(Math.round(row.principalPaid))}</td>
                      <td className="px-4 py-2 text-right text-[#EA580C]">{formatInr(Math.round(row.interestPaid))}</td>
                      <td className="px-4 py-2 text-right text-slate-800">{formatInr(Math.round(row.balance))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
