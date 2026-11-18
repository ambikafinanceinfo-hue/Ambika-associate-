import React, { useEffect, useState } from 'react';
import { RefreshCw, ArrowUpRight, PhoneCall, Target, QrCode, ShieldCheck, UserPlus } from 'lucide-react';
import type { AuthUser } from '../../shared/types';
import { apiFetch, formatInr } from '../lib/api';
import { t, type Lang } from '../lib/i18n';

interface DashboardViewProps {
  user: AuthUser;
  lang: Lang;
  logoDataUrl?: string | null;
  onNavigate: (tab: string, subOption?: string | null) => void;
  onOpenLead?: (leadId: number) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ user, lang, logoDataUrl, onNavigate, onOpenLead }) => {
  const [data, setData] = useState<any>(null);
  const [salesOverview, setSalesOverview] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, sales] = await Promise.all([
        apiFetch('/dashboard'),
        apiFetch('/sales/overview').catch(() => null),
      ]);
      setData(res);
      setSalesOverview(sales);
    } catch (err: any) {
      setError(err.message || 'Could not load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [user.id]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg bg-white border border-slate-200 animate-pulse p-4" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 bg-white border border-red-200 rounded-xl text-sm text-red-700">
        {error || 'Dashboard unavailable'}
      </div>
    );
  }

  const { kpis, penaltySummary, petrolSummary, rewardSummary, employeePerformance, referralPerformance } = data;
  const isReferral = user.role === 'REFERRAL_PARTNER';

  const kpiCards = [
    { label: t(lang, 'totalLeads'), value: kpis.totalLeads, accent: 'text-[#0F2744]', tab: 'leads' },
    { label: t(lang, 'todaysLeads'), value: kpis.todaysLeads, accent: 'text-[#0F2744]', tab: 'leads' },
    { label: t(lang, 'pendingLeads'), value: kpis.pendingLeads, accent: 'text-[#D97706]', tab: 'leads' },
    ...(!isReferral
      ? [{ label: t(lang, 'followupDue'), value: kpis.followupDue, accent: 'text-[#EA580C]', tab: 'leads' }]
      : []),
    { label: t(lang, 'docsPending'), value: kpis.docsPending, accent: 'text-[#D97706]', tab: 'leads' },
    { label: t(lang, 'casesLoggedIn'), value: kpis.casesLoggedIn, accent: 'text-[#0F2744]', tab: 'leads' },
    { label: t(lang, 'underProcess'), value: kpis.underProcess, accent: 'text-[#0F2744]', tab: 'leads' },
    { label: t(lang, 'approvedCases'), value: kpis.approvedCases, accent: 'text-[#15803D]', tab: 'leads' },
    { label: t(lang, 'rejectedCases'), value: kpis.rejectedCases, accent: 'text-[#DC2626]', tab: 'leads' },
    { label: t(lang, 'disbursedCases'), value: kpis.disbursedCases, accent: 'text-[#15803D]', tab: 'leads' },
    ...(!isReferral
      ? [
          {
            label: t(lang, 'totalDisbursement'),
            value: formatInr(kpis.totalDisbursementAmount),
            accent: 'text-[#15803D]',
            tab: 'reports',
          },
        ]
      : []),
    { label: t(lang, 'pendingEnquiries'), value: kpis.pendingEnquiries, accent: 'text-[#EA580C]', tab: 'enquiries' },
    ...(user.role === 'SUPER_ADMIN'
      ? [
          {
            label: t(lang, 'pendingDuplicates'),
            value: kpis.pendingDuplicates,
            accent: kpis.pendingDuplicates > 0 ? 'text-[#DC2626]' : 'text-slate-800',
            tab: 'duplicates',
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4 min-w-0">
          <img
            src={logoDataUrl || '/ambika-logo-banner.png'}
            alt="AMBIKA ASSOCIATE — Smart Finance Smart Saving"
            referrerPolicy="no-referrer"
            className="h-14 sm:h-16 w-auto rounded-lg border border-slate-200 object-contain bg-white shrink-0 shadow-xs"
          />
          <div className="min-w-0">
            <h1 className="text-xl font-display font-bold text-[#0F2744]">
              {t(lang, 'welcomeBack')}, {user.fullName}
            </h1>
            <div className="text-xs text-slate-500 mt-1 flex flex-wrap items-center gap-2">
              <span>{user.employeeCode}</span>
              <span aria-hidden="true">·</span>
              <span>{user.role.replace('_', ' ')}</span>
              {user.branchName && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{user.branchName}</span>
                </>
              )}
              {user.referralCode && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{user.referralCode}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          {user.role === 'SUPER_ADMIN' && (
            <button
              type="button"
              onClick={() => onNavigate('admin', 'users')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white whitespace-nowrap shrink-0"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-[#EA580C]" />
              {lang === 'hi' ? 'एडमिन कंसोल · ID / लॉगिन कंट्रोल' : 'Admin Console · IDs & Login Control'}
            </button>
          )}
          {['SUPER_ADMIN', 'LEAD_GENERATOR'].includes(user.role) && (
            <button
              type="button"
              onClick={() => onNavigate('referrals')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-[#15803D] hover:bg-green-800 text-white whitespace-nowrap shrink-0"
            >
              <UserPlus className="w-3.5 h-3.5" />
              {t(lang, 'navReferrals')}
            </button>
          )}
          {user.role === 'FIELD_OFFICER' && (
            <button
              type="button"
              onClick={() => onNavigate('referrals')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-[#15803D] hover:bg-green-800 text-white whitespace-nowrap shrink-0"
            >
              <UserPlus className="w-3.5 h-3.5" />
              {t(lang, 'navCreateReferral')}
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate('leads')}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white whitespace-nowrap shrink-0"
          >
            + {t(lang, 'newLead')}
          </button>
        </div>
      </div>

      {/* KPI Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        {kpiCards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => onNavigate(card.tab)}
            className="text-left bg-white border border-slate-200 rounded-lg p-4 hover:border-[#0F2744]/40 transition-colors group"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-500 truncate">{card.label}</span>
              <ArrowUpRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-[#0F2744] shrink-0" />
            </div>
            <div className={`mt-2 text-xl font-display font-bold tabular-nums ${card.accent}`}>
              {card.value}
            </div>
          </button>
        ))}
      </div>

      {/* Penalty, Petrol & Staff Reward Points Summary Row (Hidden from Referral Partners) */}
      {!isReferral && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-100">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">
                {t(lang, 'penaltySummary')}
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('penalties')}
                className="text-xs font-semibold text-[#EA580C] hover:underline whitespace-nowrap"
              >
                Open Register
              </button>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-slate-500">Pending Review</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#D97706]">
                  {formatInr(penaltySummary.pendingAmount)}
                </div>
                <div className="text-[11px] text-slate-400 tabular-nums">{penaltySummary.pendingCount} events</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Approved</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#DC2626]">
                  {formatInr(penaltySummary.approvedAmount)}
                </div>
                <div className="text-[11px] text-slate-400">Finalized</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Total Logged</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#0F2744]">
                  {penaltySummary.totalCount}
                </div>
                <div className="text-[11px] text-slate-400">SLA Events</div>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-100">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">
                {t(lang, 'petrolSummary')}
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('field-ops')}
                className="text-xs font-semibold text-[#15803D] hover:underline whitespace-nowrap"
              >
                Open Bike Runs
              </button>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-slate-500">Eligible KM</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#0F2744]">
                  {Number(petrolSummary.totalKm || 0).toFixed(1)} km
                </div>
                <div className="text-[11px] text-slate-400 tabular-nums">{petrolSummary.totalRuns} runs</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Approved Payout</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#15803D]">
                  {formatInr(petrolSummary.approvedIncentive)}
                </div>
                <div className="text-[11px] text-slate-400">Verified</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Pending</div>
                <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#D97706]">
                  {formatInr(petrolSummary.pendingIncentive)}
                </div>
                <div className="text-[11px] text-slate-400">Awaiting Admin</div>
              </div>
            </div>
          </div>

          {rewardSummary && (
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-100">
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  {t(lang, 'rewardSummary')}
                </h2>
                <button
                  type="button"
                  onClick={() => onNavigate('rewards')}
                  className="text-xs font-semibold text-[#EA580C] hover:underline whitespace-nowrap"
                >
                  Open Rewards
                </button>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <div>
                  <div className="text-xs text-slate-500">Docs + Login</div>
                  <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#0F2744]">
                    +{rewardSummary.loginRewardPts}
                  </div>
                  <div className="text-[11px] text-slate-400 tabular-nums">
                    Disb: +{rewardSummary.disbursementRewardPts}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Wrong Lead (-)</div>
                  <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#DC2626]">
                    -{formatInr(rewardSummary.wrongLeadPenaltyPts)}
                  </div>
                  <div className="text-[11px] text-slate-400 tabular-nums">
                    {rewardSummary.wrongLeadCount} leads
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Net Balance</div>
                  <div
                    className={`mt-1 text-lg font-bold font-mono tabular-nums ${
                      rewardSummary.netRewardPts >= 0 ? 'text-[#15803D]' : 'text-[#DC2626]'
                    }`}
                  >
                    {rewardSummary.netRewardPts >= 0 ? `+${rewardSummary.netRewardPts}` : rewardSummary.netRewardPts}
                  </div>
                  <div className="text-[11px] text-slate-400">Points (₹)</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Performance Tables */}
      {!isReferral && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">
                Employee-wise Performance
              </h2>
              <span className="text-xs text-slate-500">Field Officers</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-semibold px-4 py-2.5">Officer</th>
                    <th className="text-right font-semibold px-4 py-2.5">Leads</th>
                    <th className="text-right font-semibold px-4 py-2.5">Disbursed</th>
                    <th className="text-right font-semibold px-4 py-2.5">Volume</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {employeePerformance.map((emp: any) => (
                    <tr key={emp.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-900">{emp.name}</div>
                        <div className="text-xs font-mono text-slate-400">{emp.code}</div>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{emp.totalLeads}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#15803D]">
                        {emp.disbursedCount}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums font-medium">
                        {formatInr(emp.disbursedAmount)}
                      </td>
                    </tr>
                  ))}
                  {employeePerformance.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-xs text-slate-500">
                        No field officer records yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">
                Referral-wise Performance
              </h2>
              <span className="text-xs text-slate-500">DSA Partners</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-semibold px-4 py-2.5">Partner</th>
                    <th className="text-right font-semibold px-4 py-2.5">Leads</th>
                    <th className="text-right font-semibold px-4 py-2.5">Disbursed</th>
                    <th className="text-right font-semibold px-4 py-2.5">Volume</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {referralPerformance.map((ref: any) => (
                    <tr key={ref.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-900">{ref.name}</div>
                        <div className="text-xs font-mono text-slate-400">{ref.code}</div>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{ref.totalLeads}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#15803D]">
                        {ref.disbursedCount}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums font-medium">
                        {formatInr(ref.disbursedAmount)}
                      </td>
                    </tr>
                  ))}
                  {referralPerformance.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-xs text-slate-500">
                        No referral partner activity yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Sales Growth Quick Row: Priority Calls & Monthly Targets */}
      {!isReferral && salesOverview && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-3 pb-2.5 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <PhoneCall className="w-4 h-4 text-[#EA580C]" />
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Today&apos;s Priority Calls
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('sales-hub')}
                className="text-xs font-semibold text-[#EA580C] hover:underline whitespace-nowrap"
              >
                Open Sales Hub
              </button>
            </div>
            <div className="divide-y divide-slate-100">
              {(salesOverview.priorityQueue || []).slice(0, 4).map((item: any) => (
                <div key={item.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold text-[#0F2744] truncate">
                      <span className="font-mono">{item.leadCode}</span> · {item.customerName}
                    </div>
                    <div
                      className={`text-[11px] font-medium truncate ${
                        item.urgencyLevel === 'CRITICAL' ? 'text-[#DC2626]' : 'text-[#EA580C]'
                      }`}
                    >
                      {item.urgencyReason}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => (onOpenLead ? onOpenLead(item.id) : onNavigate('leads'))}
                    className="px-2.5 py-1 rounded border border-slate-300 hover:bg-slate-50 font-semibold text-[#0F2744] whitespace-nowrap shrink-0"
                  >
                    Open
                  </button>
                </div>
              ))}
              {(salesOverview.priorityQueue || []).length === 0 && (
                <div className="py-4 text-xs text-slate-500">All active leads are on track.</div>
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between gap-3 pb-2.5 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-[#15803D]" />
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Monthly Target Progress ({salesOverview.monthKey})
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('sales-hub')}
                className="text-xs font-semibold text-[#15803D] hover:underline whitespace-nowrap"
              >
                Targets &amp; Funnel
              </button>
            </div>
            <div className="space-y-3">
              {(salesOverview.targets || []).slice(0, 3).map((tgt: any) => (
                <div key={tgt.id} className="space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-800 truncate">
                      {tgt.userName ? `${tgt.userName} (${tgt.employeeCode})` : `Branch: ${tgt.branchName}`}
                    </span>
                    <span className="font-mono tabular-nums font-bold text-[#15803D] shrink-0">
                      {formatInr(tgt.disbursedAmount)} / {formatInr(tgt.targetAmount)} ({tgt.achievementPct}%)
                    </span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#15803D]"
                      style={{ width: `${Math.min(100, tgt.achievementPct)}%` }}
                    />
                  </div>
                </div>
              ))}
              {(salesOverview.targets || []).length === 0 && (
                <div className="py-4 text-xs text-slate-500">No monthly targets configured yet.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {isReferral && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-display font-bold text-[#0F2744]">
              Referral Partner Growth &amp; Privacy Protection
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              Share your branded QR Lead Link, track your commission slabs &amp; payouts, monitor case progress,
              and raise help-desk enquiries. Confidential customer KYC and loan amounts remain strictly protected.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigate('sales-hub')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#EA580C] text-white text-xs font-semibold hover:bg-[#C2410C] whitespace-nowrap"
            >
              <QrCode className="w-3.5 h-3.5" />
              QR Code &amp; Payouts
            </button>
            <button
              type="button"
              onClick={() => onNavigate('enquiries')}
              className="px-4 py-2 rounded-lg bg-[#0F2744] text-white text-xs font-semibold hover:bg-[#16365D] whitespace-nowrap"
            >
              Raise / View Enquiries
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
