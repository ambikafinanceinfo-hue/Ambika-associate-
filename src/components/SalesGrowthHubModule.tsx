import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowUpRight,
  Award,
  BarChart3,
  Check,
  Copy,
  Download,
  ExternalLink,
  IndianRupee,
  PhoneCall,
  QrCode,
  RefreshCw,
  Repeat,
  Target,
  TrendingUp,
} from 'lucide-react';
import type { AuthUser } from '../../shared/types';
import { apiFetch, buildTelHref, formatInr } from '../lib/api';

interface SalesGrowthHubProps {
  user: AuthUser;
  activeOption?: 'priority' | 'analytics' | 'referral' | null;
  onSelectOption?: (opt: 'priority' | 'analytics' | 'referral') => void;
  onOpenLead: (leadId: number) => void;
  onCreateCrossSell: (seed: {
    customerName: string;
    customerMobile: string;
    panNumber: string;
    loanProduct: string;
    bankNbfc: string;
    remarks: string;
  }) => void;
  onPreviewPublicReferral: (referralCode: string) => void;
}

export const SalesGrowthHubModule: React.FC<SalesGrowthHubProps> = ({
  user,
  activeOption,
  onSelectOption,
  onOpenLead,
  onCreateCrossSell,
  onPreviewPublicReferral,
}) => {
  const isReferral = user.role === 'REFERRAL_PARTNER';
  const canEditTargets = ['SUPER_ADMIN', 'BRANCH_MANAGER'].includes(user.role);
  const isSuperAdmin = user.role === 'SUPER_ADMIN';

  const defaultTab: 'priority' | 'analytics' | 'referral' = isReferral ? 'referral' : 'priority';
  const [subTab, setSubTab] = useState<'priority' | 'analytics' | 'referral'>(
    activeOption && ['priority', 'analytics', 'referral'].includes(activeOption) ? activeOption : defaultTab
  );

  useEffect(() => {
    if (activeOption && ['priority', 'analytics', 'referral'].includes(activeOption)) {
      if (isReferral && activeOption === 'priority') return;
      setSubTab(activeOption);
    } else if (activeOption === null) {
      setSubTab(defaultTab);
    }
  }, [activeOption, isReferral]);

  const changeSubTab = (next: 'priority' | 'analytics' | 'referral') => {
    setSubTab(next);
    onSelectOption?.(next);
  };
  const [overview, setOverview] = useState<any>(null);
  const [referralHub, setReferralHub] = useState<any>(null);
  const [directory, setDirectory] = useState<{ branches: any[]; fieldOfficers: any[]; referrals: any[] }>({
    branches: [],
    fieldOfficers: [],
    referrals: [],
  });
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  // Target editor state
  const [targetType, setTargetType] = useState<'officer' | 'branch'>('officer');
  const [targetUserId, setTargetUserId] = useState('');
  const [targetBranchId, setTargetBranchId] = useState('1');
  const [targetLeads, setTargetLeads] = useState('12');
  const [targetAmount, setTargetAmount] = useState('7500000');

  // QR code state
  const [selectedRefCode, setSelectedRefCode] = useState(user.referralCode || '');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [ov, rh, dir] = await Promise.all([
        apiFetch<any>('/sales/overview'),
        apiFetch<any>('/sales/referral-hub'),
        apiFetch<any>('/directory'),
      ]);
      setOverview(ov);
      setReferralHub(rh);
      setDirectory(dir);
      if (!targetUserId && dir.fieldOfficers?.[0]?.id) {
        setTargetUserId(String(dir.fieldOfficers[0].id));
      }
      if (!selectedRefCode) {
        setSelectedRefCode(user.referralCode || dir.referrals?.[0]?.referralCode || 'REF-AA-101');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [user.id]);

  const activeReferralLink =
    typeof window !== 'undefined' && selectedRefCode
      ? `${window.location.origin}/?ref=${encodeURIComponent(selectedRefCode)}`
      : '';

  useEffect(() => {
    if (!activeReferralLink) return;
    QRCode.toDataURL(activeReferralLink, {
      width: 280,
      margin: 2,
      color: { dark: '#0F2744', light: '#FFFFFF' },
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => setQrDataUrl(''));
  }, [activeReferralLink]);

  const handleSaveTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    await apiFetch('/sales/targets', {
      method: 'POST',
      json: {
        userId: targetType === 'officer' ? Number(targetUserId) : null,
        branchId: targetType === 'branch' ? Number(targetBranchId) : null,
        targetLeads: Number(targetLeads),
        targetAmount: Number(targetAmount),
      },
    });
    setMsg('Monthly sales target updated.');
    await loadAll();
  };

  const handlePayoutDecision = async (payoutId: number, payoutStatus: 'APPROVED' | 'PAID') => {
    setMsg(null);
    await apiFetch(`/sales/payouts/${payoutId}`, {
      method: 'PATCH',
      json: { payoutStatus },
    });
    setMsg(`Referral payout marked ${payoutStatus}.`);
    await loadAll();
  };

  const handleCopyLink = async () => {
    if (!activeReferralLink) return;
    try {
      await navigator.clipboard.writeText(activeReferralLink);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleDownloadQrPoster = () => {
    if (!qrDataUrl) return;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 820;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#0F2744';
    ctx.fillRect(0, 0, canvas.width, 130);

    ctx.fillStyle = '#EA580C';
    ctx.fillRect(0, 130, canvas.width * 0.65, 8);
    ctx.fillStyle = '#15803D';
    ctx.fillRect(canvas.width * 0.65, 130, canvas.width * 0.35, 8);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 30px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('AMBIKA ASSOCIATE', canvas.width / 2, 62);

    ctx.fillStyle = '#FACC15';
    ctx.font = 'bold 15px Inter, system-ui, sans-serif';
    ctx.fillText('SMART FINANCE SMART SAVING', canvas.width / 2, 96);

    ctx.fillStyle = '#0F2744';
    ctx.font = 'bold 24px Inter, system-ui, sans-serif';
    ctx.fillText('Scan for Instant Loan Enquiry', canvas.width / 2, 195);

    ctx.fillStyle = '#475569';
    ctx.font = '16px Inter, system-ui, sans-serif';
    ctx.fillText('Home Loan · LAP · Business Loan · Personal Loan · Auto Loan', canvas.width / 2, 228);

    const qrImg = new Image();
    qrImg.onload = () => {
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 3;
      ctx.strokeRect(150, 260, 340, 340);
      ctx.drawImage(qrImg, 165, 275, 310, 310);

      ctx.fillStyle = '#0F2744';
      ctx.font = 'bold 20px monospace';
      ctx.fillText(`Partner Code: ${selectedRefCode}`, canvas.width / 2, 650);

      ctx.fillStyle = '#15803D';
      ctx.font = 'bold 15px Inter, system-ui, sans-serif';
      ctx.fillText('Fast Eligibility Check · Zero Hidden Charges · Multi-Bank Offers', canvas.width / 2, 695);

      ctx.fillStyle = '#64748B';
      ctx.font = '13px Inter, system-ui, sans-serif';
      ctx.fillText(activeReferralLink, canvas.width / 2, 760);

      const link = document.createElement('a');
      link.download = `AMBIKA_QR_${selectedRefCode}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    };
    qrImg.src = qrDataUrl;
  };

  if (loading || !overview || !referralHub) {
    return (
      <div className="p-8 bg-white border border-slate-200 rounded-xl text-center text-xs text-slate-500">
        Loading Sales &amp; Growth Hub...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            Sales Acceleration &amp; Referral Growth Hub
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Priority action queue, monthly targets, pipeline conversion analytics, cross-sell radar, and referral payouts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
            {!isReferral && (
              <button
                type="button"
                onClick={() => changeSubTab('priority')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md whitespace-nowrap ${
                  subTab === 'priority' ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
                }`}
              >
                <Target className="w-3.5 h-3.5" />
                Priority &amp; Targets
              </button>
            )}
            <button
              type="button"
              onClick={() => changeSubTab('analytics')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md whitespace-nowrap ${
                subTab === 'analytics' ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              Funnel &amp; Banks
            </button>
            <button
              type="button"
              onClick={() => changeSubTab('referral')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md whitespace-nowrap ${
                subTab === 'referral' ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
              }`}
            >
              <QrCode className="w-3.5 h-3.5" />
              Referral Payouts &amp; QR
            </button>
          </div>

          <button
            type="button"
            onClick={loadAll}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {msg && (
        <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-xs font-medium text-[#15803D]">
          {msg}
        </div>
      )}

      {/* TAB 1: PRIORITY CALLS, TARGETS & CROSS-SELL */}
      {subTab === 'priority' && !isReferral && (
        <div className="space-y-5">
          {/* Today's Next-Best-Action Queue */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <PhoneCall className="w-4 h-4 text-[#EA580C]" />
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Today&apos;s Priority Calls (Next-Best-Action Queue)
                </h2>
              </div>
              <span className="text-xs text-slate-500">Ranked by SLA &amp; disbursement readiness</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold">Priority Reason</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Lead &amp; Customer</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Product · Bank</th>
                    <th className="text-right px-4 py-2.5 font-semibold">Amount</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                    <th className="text-right px-4 py-2.5 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {overview.priorityQueue.map((item: any) => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <span
                          className={`font-semibold ${
                            item.urgencyLevel === 'CRITICAL'
                              ? 'text-[#DC2626]'
                              : item.urgencyLevel === 'HIGH'
                              ? 'text-[#EA580C]'
                              : 'text-[#0F2744]'
                          }`}
                        >
                          {item.urgencyReason}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-mono font-semibold text-[#0F2744]">{item.leadCode}</div>
                        <div className="text-slate-800 font-medium">{item.customerName}</div>
                        {item.customerMobile && (
                          <a
                            href={buildTelHref(item.customerMobile)}
                            title={`Call ${item.customerName} (${item.customerMobile})`}
                            className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-[#15803D] hover:underline mt-0.5"
                          >
                            <PhoneCall className="w-3 h-3 shrink-0" />
                            <span>{item.customerMobile}</span>
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-slate-800 font-medium">{item.loanProduct}</div>
                        <div className="text-slate-500">{item.bankNbfc}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-800 whitespace-nowrap">
                        {formatInr(item.loanAmount)}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">{item.status}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => onOpenLead(item.id)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold whitespace-nowrap"
                        >
                          Open Case
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {overview.priorityQueue.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        All active leads are up to date.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Monthly Target vs Achievement + Set Target Editor */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            <div className={`${canEditTargets ? 'lg:col-span-8' : 'lg:col-span-12'} bg-white border border-slate-200 rounded-xl p-5 space-y-4`}>
              <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-[#15803D]" />
                  <h2 className="text-sm font-display font-bold text-[#0F2744]">
                    Monthly Target vs. Achievement ({overview.monthKey})
                  </h2>
                </div>
                <span className="text-xs text-slate-500">Disbursed Volume &amp; Active Pipeline</span>
              </div>

              <div className="space-y-4">
                {overview.targets.map((tgt: any) => (
                  <div key={tgt.id} className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div>
                        <span className="font-semibold text-[#0F2744]">
                          {tgt.userName ? `${tgt.userName} (${tgt.employeeCode})` : `Branch: ${tgt.branchName}`}
                        </span>
                        <span className="text-slate-500 ml-2">
                          {tgt.achievedLeads}/{tgt.targetLeads} leads · {tgt.disbursedCount} disbursed
                        </span>
                      </div>
                      <div className="font-mono tabular-nums font-bold text-[#15803D]">
                        {formatInr(tgt.disbursedAmount)} / {formatInr(tgt.targetAmount)} ({tgt.achievementPct}%)
                      </div>
                    </div>
                    <div className="w-full h-2.5 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#15803D] transition-all"
                        style={{ width: `${Math.min(100, tgt.achievementPct)}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-slate-500 flex justify-between">
                      <span>Active Pipeline: <strong className="font-mono text-[#0F2744]">{formatInr(tgt.pipelineAmount)}</strong></span>
                      <span>Remaining to Target: <strong className="font-mono text-[#EA580C]">{formatInr(Math.max(0, tgt.targetAmount - tgt.disbursedAmount))}</strong></span>
                    </div>
                  </div>
                ))}
                {overview.targets.length === 0 && (
                  <p className="text-xs text-slate-500">No targets configured for this month yet.</p>
                )}
              </div>
            </div>

            {canEditTargets && (
              <form onSubmit={handleSaveTarget} className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-3.5">
                <h3 className="text-sm font-display font-bold text-[#0F2744]">Set Monthly Target</h3>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setTargetType('officer')}
                    className={`py-1.5 text-xs font-semibold rounded-lg border ${
                      targetType === 'officer'
                        ? 'bg-[#0F2744] text-white border-[#0F2744]'
                        : 'bg-white text-slate-700 border-slate-300'
                    }`}
                  >
                    Field Officer
                  </button>
                  <button
                    type="button"
                    onClick={() => setTargetType('branch')}
                    className={`py-1.5 text-xs font-semibold rounded-lg border ${
                      targetType === 'branch'
                        ? 'bg-[#0F2744] text-white border-[#0F2744]'
                        : 'bg-white text-slate-700 border-slate-300'
                    }`}
                  >
                    Branch
                  </button>
                </div>

                {targetType === 'officer' ? (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Field Officer</label>
                    <select
                      value={targetUserId}
                      onChange={(e) => setTargetUserId(e.target.value)}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      {directory.fieldOfficers.map((fo) => (
                        <option key={fo.id} value={fo.id}>
                          {fo.fullName} ({fo.employeeCode})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Branch</label>
                    <select
                      value={targetBranchId}
                      onChange={(e) => setTargetBranchId(e.target.value)}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      {directory.branches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Target Leads (Count)</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={targetLeads}
                    onChange={(e) => setTargetLeads(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Disbursement Target (₹)</label>
                  <input
                    type="number"
                    min={100000}
                    step={100000}
                    required
                    value={targetAmount}
                    onChange={(e) => setTargetAmount(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold"
                >
                  Save Monthly Target
                </button>
              </form>
            )}
          </div>

          {/* Cross-Sell / Top-Up Radar */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Repeat className="w-4 h-4 text-[#15803D]" />
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Cross-Sell &amp; Top-Up Eligibility Radar
                </h2>
              </div>
              <span className="text-xs text-slate-500">Seasoned disbursed customers (120+ days)</span>
            </div>
            <div className="divide-y divide-slate-100">
              {overview.crossSellCandidates.map((c: any) => (
                <div key={c.id} className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold text-[#0F2744]">
                      <span className="font-mono">{c.leadCode}</span> · {c.customerName} ({c.ageDays} days since disbursement)
                    </div>
                    <div className="text-xs text-slate-600">
                      Existing: {c.loanProduct} · {formatInr(c.loanAmount)} ({c.bankNbfc}) ·{' '}
                      <strong className="text-[#15803D]">{c.offerSuggestion}</strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      onCreateCrossSell({
                        customerName: c.customerName,
                        customerMobile: c.customerMobile || '',
                        panNumber: c.panNumber || '',
                        loanProduct: 'Personal Loan',
                        bankNbfc: c.bankNbfc,
                        remarks: `Top-up / Cross-sell opportunity from seasoned loan ${c.leadCode} (${c.offerSuggestion})`,
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                  >
                    Launch Top-Up Lead
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              {overview.crossSellCandidates.length === 0 && (
                <div className="px-5 py-6 text-center text-xs text-slate-500">
                  No seasoned (120+ days) disbursed customers eligible for top-up yet.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PIPELINE FUNNEL, BANK TURNAROUND & LOST-LEAD REASONS */}
      {subTab === 'analytics' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Stage-Wise Conversion Funnel */}
            <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="pb-3 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Stage-Wise Sales Conversion Funnel
                </h2>
                <span className="text-xs text-slate-500">Lead → Disbursed</span>
              </div>
              <div className="space-y-3">
                {overview.funnel.map((st: any, idx: number) => (
                  <div key={st.stage} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="font-semibold text-slate-700">{st.stage}</span>
                      <span className="font-mono tabular-nums text-[#0F2744] font-bold">
                        {st.count} ({st.pct}%)
                      </span>
                    </div>
                    <div className="w-full h-3 bg-slate-100 rounded-md overflow-hidden">
                      <div
                        className={`h-full ${
                          idx === overview.funnel.length - 1
                            ? 'bg-[#15803D]'
                            : idx === 0
                            ? 'bg-[#0F2744]'
                            : 'bg-[#EA580C]'
                        }`}
                        style={{ width: `${Math.max(4, st.pct)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Lost-Lead Reason Breakdown (Non-Referral) */}
            {!isReferral && (
              <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="pb-3 border-b border-slate-100 flex items-center justify-between">
                  <h2 className="text-sm font-display font-bold text-[#0F2744]">
                    Lost &amp; Rejected Lead Reasons
                  </h2>
                  <span className="text-xs text-slate-500">Pipeline Leakage Diagnostics</span>
                </div>
                {overview.lostReasons.length > 0 ? (
                  <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                    {overview.lostReasons.map((lr: any) => (
                      <div key={lr.reason} className="px-4 py-2.5 flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-800">{lr.reason}</span>
                        <span className="font-mono font-bold text-[#DC2626] tabular-nums">{lr.count} cases</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-8 text-center text-xs text-slate-500">
                    No rejected or closed leads with drop-off reasons recorded yet. Updating any case to Rejected or Closed prompts for a reason.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bank / NBFC Turnaround & Approval Matrix */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">
                Bank &amp; NBFC Approval &amp; Turnaround Analytics
              </h2>
              <span className="text-xs text-slate-500">Spot fast-sanctioning lenders</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold">Bank / NBFC</th>
                    <th className="text-right px-4 py-3 font-semibold">Total Leads</th>
                    <th className="text-right px-4 py-3 font-semibold">Active</th>
                    <th className="text-right px-4 py-3 font-semibold">Disbursed</th>
                    <th className="text-right px-4 py-3 font-semibold">Rejected</th>
                    <th className="text-right px-4 py-3 font-semibold">Approval Rate</th>
                    <th className="text-right px-4 py-3 font-semibold">Avg Turnaround</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {overview.bankAnalytics.map((b: any) => (
                    <tr key={b.bank}>
                      <td className="px-4 py-3 font-sans font-semibold text-[#0F2744]">{b.bank}</td>
                      <td className="px-4 py-3 text-right">{b.total}</td>
                      <td className="px-4 py-3 text-right text-slate-600">{b.active}</td>
                      <td className="px-4 py-3 text-right text-[#15803D] font-semibold">{b.disbursed}</td>
                      <td className="px-4 py-3 text-right text-[#DC2626]">{b.rejected}</td>
                      <td className="px-4 py-3 text-right font-bold text-[#0F2744]">{b.approvalRatePct}%</td>
                      <td className="px-4 py-3 text-right text-slate-600">
                        {b.avgTurnaroundHours !== null ? `${b.avgTurnaroundHours} hrs` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: REFERRAL PAYOUTS, QR LEAD LINK & LEADERBOARD */}
      {subTab === 'referral' && (
        <div className="space-y-5">
          {/* Top Row: QR Code Card + Commission Slabs */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <QrCode className="w-4 h-4 text-[#EA580C]" />
                  <h2 className="text-sm font-display font-bold text-[#0F2744]">
                    Branded Referral QR &amp; Lead Link
                  </h2>
                </div>
                {!isReferral && directory.referrals.length > 0 && (
                  <select
                    value={selectedRefCode}
                    onChange={(e) => setSelectedRefCode(e.target.value)}
                    className="px-2 py-1 text-xs font-mono border border-slate-300 rounded-lg bg-white"
                  >
                    {directory.referrals.map((r) => (
                      <option key={r.id} value={r.referralCode}>
                        {r.referralCode} · {r.fullName}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-4">
                <div className="p-2.5 border border-slate-200 rounded-xl bg-white shrink-0">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt={`QR Code for ${selectedRefCode}`} className="w-36 h-36" />
                  ) : (
                    <div className="w-36 h-36 bg-slate-100 flex items-center justify-center text-xs text-slate-400">
                      Generating QR...
                    </div>
                  )}
                </div>
                <div className="space-y-2.5 min-w-0 flex-1">
                  <div className="text-xs font-mono font-bold text-[#0F2744]">Code: {selectedRefCode}</div>
                  <p className="text-xs text-slate-600">
                    Share this QR poster or link with customers. Submitted leads auto-tag your Referral ID and trigger a 10-minute Field Officer follow-up.
                  </p>
                  <div className="text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 truncate text-slate-700">
                    {activeReferralLink}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleCopyLink}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F2744] text-white text-xs font-semibold whitespace-nowrap"
                    >
                      {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedLink ? 'Copied' : 'Copy Link'}
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadQrPoster}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#15803D] text-white text-xs font-semibold whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      QR Poster PNG
                    </button>
                    <button
                      type="button"
                      onClick={() => onPreviewPublicReferral(selectedRefCode)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-[#0F2744] hover:bg-slate-50 whitespace-nowrap"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Preview Form
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Payout Summary + Product Slabs */}
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <IndianRupee className="w-4 h-4 text-[#15803D]" />
                  <h2 className="text-sm font-display font-bold text-[#0F2744]">
                    Commission Slabs &amp; Monthly Tier Bonus
                  </h2>
                </div>
                <span className="text-xs font-semibold text-[#EA580C]">
                  +{referralHub.bonusPct}% Extra Bonus at {referralHub.bonusThreshold}+ Monthly Disbursals
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-[11px] text-slate-500">Total Earned</div>
                  <div className="text-lg font-mono font-bold text-[#0F2744] tabular-nums">
                    {formatInr(referralHub.summary.totalEarned)}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-[11px] text-slate-500">Paid Out</div>
                  <div className="text-lg font-mono font-bold text-[#15803D] tabular-nums">
                    {formatInr(referralHub.summary.paidAmount)}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-[11px] text-slate-500">Pending Settlement</div>
                  <div className="text-lg font-mono font-bold text-[#EA580C] tabular-nums">
                    {formatInr(referralHub.summary.pendingAmount)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                {referralHub.commissionSlabs.map((slab: any) => (
                  <div key={slab.id} className="p-2.5 rounded-lg border border-slate-200 flex items-center justify-between gap-2">
                    <span className="text-slate-700 font-medium truncate">{slab.name}</span>
                    <span className="font-mono font-bold text-[#15803D] shrink-0">{slab.commissionPct}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Payout Ledger + Monthly Leaderboard */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Referral Payout Ledger
                </h2>
                <span className="text-xs text-slate-500">Auto-calculated on Disbursement</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="text-left px-4 py-2.5 font-semibold">Lead &amp; Customer</th>
                      {!isReferral && <th className="text-left px-4 py-2.5 font-semibold">Partner</th>}
                      <th className="text-left px-4 py-2.5 font-semibold">Product · Slab</th>
                      <th className="text-right px-4 py-2.5 font-semibold">Payout</th>
                      <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                      {isSuperAdmin && <th className="text-right px-4 py-2.5 font-semibold">Action</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {referralHub.payoutRows.map((p: any) => (
                      <tr key={p.id}>
                        <td className="px-4 py-3">
                          <div className="font-mono font-semibold text-[#0F2744]">{p.leadCode}</div>
                          <div className="text-slate-700">{p.customerName}</div>
                        </td>
                        {!isReferral && (
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-800">{p.partnerName || '-'}</div>
                            <div className="font-mono text-[11px] text-slate-500">{p.referralCode}</div>
                          </td>
                        )}
                        <td className="px-4 py-3">
                          <div>{p.loanProduct}</div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {p.baseRatePct}%{p.bonusRatePct > 0 ? ` + ${p.bonusRatePct}% bonus` : ''}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold tabular-nums text-[#15803D]">
                          {formatInr(p.payoutAmount)}
                        </td>
                        <td className="px-4 py-3 font-semibold">
                          <span
                            className={
                              p.payoutStatus === 'PAID'
                                ? 'text-[#15803D]'
                                : p.payoutStatus === 'APPROVED'
                                ? 'text-[#0F2744]'
                                : 'text-[#EA580C]'
                            }
                          >
                            {p.payoutStatus}
                          </span>
                        </td>
                        {isSuperAdmin && (
                          <td className="px-4 py-3 text-right space-x-1.5 whitespace-nowrap">
                            {p.payoutStatus === 'PENDING' && (
                              <button
                                type="button"
                                onClick={() => handlePayoutDecision(p.id, 'APPROVED')}
                                className="px-2.5 py-1 rounded border border-[#0F2744] text-[#0F2744] font-semibold hover:bg-slate-50"
                              >
                                Approve
                              </button>
                            )}
                            {p.payoutStatus !== 'PAID' && (
                              <button
                                type="button"
                                onClick={() => handlePayoutDecision(p.id, 'PAID')}
                                className="px-2.5 py-1 rounded bg-[#15803D] text-white font-semibold hover:bg-green-800"
                              >
                                Mark Paid
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                    {referralHub.payoutRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                          No referral payouts generated yet. Payouts generate automatically when referred leads reach Disbursed.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Monthly DSA Leaderboard */}
            <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-2">
                <Award className="w-4 h-4 text-[#EA580C]" />
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  DSA Partner Leaderboard
                </h2>
              </div>
              <div className="divide-y divide-slate-100">
                {referralHub.leaderboard.map((row: any) => (
                  <div
                    key={row.rank}
                    className={`px-4 py-3 flex items-center justify-between gap-3 text-xs ${
                      row.isSelf ? 'bg-orange-50/60' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-[#0F2744] truncate">
                        #{row.rank} {row.partnerName} {row.isSelf ? '(You)' : ''}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Tier: <strong className="text-[#EA580C]">{row.tier}</strong> · {row.totalLeads} leads
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono font-bold text-[#15803D] tabular-nums">
                        {row.disbursedCount} Disbursed
                      </div>
                      {row.bonusUnlocked && (
                        <div className="text-[10px] font-semibold text-[#15803D]">Bonus Active</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
