import React, { useEffect, useState } from 'react';
import { Award, CheckCircle2, FileCheck2, MinusCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import type { AuthUser, StaffRewardRecord } from '../../shared/types';
import { apiFetch, formatDateTime, formatInr } from '../lib/api';

interface StaffRewardsModuleProps {
  user: AuthUser;
  onOpenLead: (leadId: number) => void;
  onAlertsChanged: () => void;
}

export const StaffRewardsModule: React.FC<StaffRewardsModuleProps> = ({
  user,
  onOpenLead,
  onAlertsChanged,
}) => {
  const [data, setData] = useState<{
    summary: {
      loginRewardPts: number;
      loginRewardCount: number;
      disbursementRewardPts: number;
      disbursementRewardCount: number;
      wrongLeadPenaltyPts: number;
      wrongLeadCount: number;
      netRewardPts: number;
    };
    entries: StaffRewardRecord[];
    staffBalances: {
      employeeId: number;
      employeeName: string;
      employeeCode: string;
      employeeRole: string;
      loginPts: number;
      disbursementPts: number;
      wrongLeadPenaltyPts: number;
      netPts: number;
    }[];
    eligibleStaff: { id: number; fullName: string; employeeCode: string; role: string }[];
    rules: {
      loginRewardOfficerPts: number;
      loginRewardGeneratorPts: number;
      disbursementRewardOfficerPts: number;
      disbursementRewardGeneratorPts: number;
      wrongLeadPenaltyMin: number;
      wrongLeadPenaltyMax: number;
      wrongLeadPenaltyDefault: number;
    };
  } | null>(null);
  const [leads, setLeads] = useState<{ id: number; leadCode: string; customerName: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<'ALL' | 'DOC_LOGIN_REWARD' | 'DISBURSEMENT_REWARD' | 'WRONG_LEAD_PENALTY'>('ALL');
  const [msg, setMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Wrong lead penalty form (Managers & Super Admin only)
  const canImposePenalty = ['SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER'].includes(user.role);
  const isSuperAdmin = user.role === 'SUPER_ADMIN';
  const [penEmployeeId, setPenEmployeeId] = useState('');
  const [penLeadId, setPenLeadId] = useState('');
  const [penAmount, setPenAmount] = useState(50);
  const [penReason, setPenReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [rRes, lRes] = await Promise.all([
        apiFetch<any>('/rewards'),
        canImposePenalty ? apiFetch<{ leads: any[] }>('/leads').catch(() => ({ leads: [] })) : Promise.resolve({ leads: [] }),
      ]);
      setData(rRes);
      setLeads(
        (lRes.leads || []).map((l: any) => ({
          id: l.id,
          leadCode: l.leadCode,
          customerName: l.customerName,
        }))
      );
      if (rRes.rules?.wrongLeadPenaltyDefault) {
        setPenAmount((prev) => prev || rRes.rules.wrongLeadPenaltyDefault);
      }
      if (!penEmployeeId && rRes.eligibleStaff?.length > 0) {
        const fo = rRes.eligibleStaff.find((s: any) => s.role === 'FIELD_OFFICER') || rRes.eligibleStaff[0];
        if (fo) setPenEmployeeId(String(fo.id));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [user.id]);

  const handleImposePenalty = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErrMsg(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ rewardCode: string }>('/rewards/wrong-lead-penalty', {
        method: 'POST',
        json: {
          employeeId: Number(penEmployeeId),
          leadId: penLeadId ? Number(penLeadId) : null,
          amount: Number(penAmount),
          reason: penReason,
        },
      });
      setMsg(`Wrong-lead minus penalty (-₹${penAmount}) recorded (${res.rewardCode}).`);
      setPenReason('');
      setPenLeadId('');
      await load();
      onAlertsChanged();
    } catch (err: any) {
      setErrMsg(err.message || 'Could not apply penalty');
    } finally {
      setSubmitting(false);
    }
  };

  const handleWaive = async (id: number) => {
    setMsg(null);
    await apiFetch(`/rewards/${id}/waive`, { method: 'PATCH' });
    setMsg('Wrong-lead deduction waived by Super Admin.');
    await load();
    onAlertsChanged();
  };

  if (loading || !data) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
        Loading staff reward points ledger...
      </div>
    );
  }

  const { summary, entries, staffBalances, eligibleStaff, rules } = data;
  const filteredEntries =
    filterType === 'ALL' ? entries : entries.filter((e) => e.entryType === filterType);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            Field Officer &amp; Staff Reward Points
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Separate rewards for Complete KYC + Finance Company Login, Loan Disbursement, and Wrong-Lead Minus Penalties (₹{rules.wrongLeadPenaltyMin}–₹{rules.wrongLeadPenaltyMax}). Internal staff only.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 whitespace-nowrap shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Active Reward & Penalty Rule Strip */}
      <div className="bg-[#0F2744] text-white rounded-xl p-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div className="bg-white/10 rounded-lg p-3 space-y-0.5">
          <div className="text-slate-300 font-medium flex items-center gap-1.5">
            <FileCheck2 className="w-3.5 h-3.5 text-yellow-300" />
            1. Docs Complete + Finance Login
          </div>
          <div className="font-mono font-bold text-sm tabular-nums">
            +{rules.loginRewardOfficerPts} pts (Field Officer) · +{rules.loginRewardGeneratorPts} pts (Lead Gen)
          </div>
        </div>
        <div className="bg-white/10 rounded-lg p-3 space-y-0.5">
          <div className="text-slate-300 font-medium flex items-center gap-1.5">
            <Award className="w-3.5 h-3.5 text-green-300" />
            2. Loan Disbursement Reward (Separate)
          </div>
          <div className="font-mono font-bold text-sm tabular-nums">
            +{rules.disbursementRewardOfficerPts} pts (Field Officer) · +{rules.disbursementRewardGeneratorPts} pts (Lead Gen)
          </div>
        </div>
        <div className="bg-white/10 rounded-lg p-3 space-y-0.5">
          <div className="text-slate-300 font-medium flex items-center gap-1.5">
            <MinusCircle className="w-3.5 h-3.5 text-red-300" />
            3. Wrong Lead Captured Minus Penalty
          </div>
          <div className="font-mono font-bold text-sm tabular-nums text-red-200">
            -₹{rules.wrongLeadPenaltyMin} to -₹{rules.wrongLeadPenaltyMax} per wrong lead (1 pt = ₹1)
          </div>
        </div>
      </div>

      {msg && (
        <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-xs font-medium text-[#15803D]">
          {msg}
        </div>
      )}
      {errMsg && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-[#DC2626]">
          {errMsg}
        </div>
      )}

      {/* 4 Separate KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Docs + Finance Login Rewards</div>
          <div className="mt-1.5 text-2xl font-display font-bold font-mono tabular-nums text-[#0F2744]">
            +{summary.loginRewardPts} pts
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
            {summary.loginRewardCount} logged-in cases · {formatInr(summary.loginRewardPts)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Disbursement Rewards</div>
          <div className="mt-1.5 text-2xl font-display font-bold font-mono tabular-nums text-[#15803D]">
            +{summary.disbursementRewardPts} pts
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
            {summary.disbursementRewardCount} disbursed cases · {formatInr(summary.disbursementRewardPts)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Wrong Lead Minus Penalty</div>
          <div className="mt-1.5 text-2xl font-display font-bold font-mono tabular-nums text-[#DC2626]">
            -{summary.wrongLeadPenaltyPts} pts
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
            {summary.wrongLeadCount} wrong leads · -{formatInr(summary.wrongLeadPenaltyPts)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Net Reward Balance</div>
          <div
            className={`mt-1.5 text-2xl font-display font-bold font-mono tabular-nums ${
              summary.netRewardPts >= 0 ? 'text-[#EA580C]' : 'text-[#DC2626]'
            }`}
          >
            {summary.netRewardPts >= 0 ? `+${summary.netRewardPts}` : summary.netRewardPts} pts
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
            Net Value: {summary.netRewardPts < 0 ? `-${formatInr(Math.abs(summary.netRewardPts))}` : formatInr(summary.netRewardPts)}
          </div>
        </div>
      </div>

      {/* Wrong Lead Minus Reward Form (Admin / BM / TL Only) */}
      {canImposePenalty && (
        <form onSubmit={handleImposePenalty} className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-display font-bold text-[#0F2744] flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-[#DC2626]" />
              Record Wrong Lead Minus Reward Penalty (₹{rules.wrongLeadPenaltyMin} – ₹{rules.wrongLeadPenaltyMax} per lead)
            </h2>
            <div className="flex items-center gap-1.5">
              {[10, 25, 50, 75, 100]
                .filter((amt) => amt >= rules.wrongLeadPenaltyMin && amt <= rules.wrongLeadPenaltyMax)
                .map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setPenAmount(amt)}
                    className={`px-2 py-1 rounded text-[11px] font-mono font-semibold border whitespace-nowrap ${
                      penAmount === amt
                        ? 'bg-[#DC2626] text-white border-[#DC2626]'
                        : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                    }`}
                  >
                    -₹{amt}
                  </button>
                ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <select
              required
              value={penEmployeeId}
              onChange={(e) => setPenEmployeeId(e.target.value)}
              className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="">Select Staff (FO / Lead Gen)</option>
              {eligibleStaff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName} ({s.employeeCode} · {s.role.replace('_', ' ')})
                </option>
              ))}
            </select>

            <select
              value={penLeadId}
              onChange={(e) => setPenLeadId(e.target.value)}
              className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="">Link Lead (Optional)</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.leadCode} — {l.customerName}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold text-[#DC2626] shrink-0">-₹</span>
              <input
                type="number"
                required
                min={rules.wrongLeadPenaltyMin}
                max={rules.wrongLeadPenaltyMax}
                value={penAmount}
                onChange={(e) => setPenAmount(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
              />
            </div>

            <input
              type="text"
              required
              value={penReason}
              onChange={(e) => setPenReason(e.target.value)}
              placeholder="Reason (e.g. Fake mobile / wrong PAN)"
              className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />

            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-lg bg-[#DC2626] hover:bg-red-700 text-white text-xs font-semibold whitespace-nowrap disabled:opacity-60"
            >
              {submitting ? 'Applying...' : `Deduct -₹${penAmount}`}
            </button>
          </div>
        </form>
      )}

      {/* Staff Balance Breakdown Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-display font-bold text-[#0F2744]">
            Employee Reward Points Breakdown (Field Officer &amp; Lead Generator Staff)
          </h2>
          <span className="text-xs text-slate-500">{staffBalances.length} staff</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Employee</th>
                <th className="text-left px-4 py-2.5 font-semibold">Role</th>
                <th className="text-right px-4 py-2.5 font-semibold">Docs + Login (+)</th>
                <th className="text-right px-4 py-2.5 font-semibold">Disbursement (+)</th>
                <th className="text-right px-4 py-2.5 font-semibold">Wrong Lead (-)</th>
                <th className="text-right px-4 py-2.5 font-semibold">Net Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {staffBalances.map((sb) => (
                <tr key={sb.employeeId} className="hover:bg-slate-50/70">
                  <td className="px-4 py-2.5">
                    <span className="font-semibold text-slate-900">{sb.employeeName}</span>{' '}
                    <span className="font-mono text-[11px] text-slate-500">({sb.employeeCode})</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{sb.employeeRole.replace('_', ' ')}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold text-[#0F2744] tabular-nums">
                    +{sb.loginPts} pts
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold text-[#15803D] tabular-nums">
                    +{sb.disbursementPts} pts
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono font-semibold text-[#DC2626] tabular-nums">
                    {sb.wrongLeadPenaltyPts > 0 ? `-₹${sb.wrongLeadPenaltyPts}` : '₹0'}
                  </td>
                  <td
                    className={`px-4 py-2.5 text-right font-mono font-bold tabular-nums ${
                      sb.netPts >= 0 ? 'text-[#EA580C]' : 'text-[#DC2626]'
                    }`}
                  >
                    {sb.netPts >= 0 ? `+${sb.netPts} pts` : `${sb.netPts} pts`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detailed Reward & Deduction Ledger */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-display font-bold text-[#0F2744]">
            Reward Points &amp; Deduction Ledger
          </h2>
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {[
              { id: 'ALL', label: `All (${entries.length})` },
              { id: 'DOC_LOGIN_REWARD', label: 'Docs + Login' },
              { id: 'DISBURSEMENT_REWARD', label: 'Disbursement' },
              { id: 'WRONG_LEAD_PENALTY', label: 'Wrong Lead (-)' },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilterType(f.id as any)}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors whitespace-nowrap ${
                  filterType === f.id ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Date &amp; Code</th>
                <th className="text-left px-4 py-2.5 font-semibold">Staff &amp; Role</th>
                <th className="text-left px-4 py-2.5 font-semibold">Reward Category</th>
                <th className="text-left px-4 py-2.5 font-semibold">Lead</th>
                <th className="text-left px-4 py-2.5 font-semibold">Reason / Milestone</th>
                <th className="text-right px-4 py-2.5 font-semibold">Points / ₹</th>
                <th className="text-left px-4 py-2.5 font-semibold">Status</th>
                {isSuperAdmin && <th className="text-right px-4 py-2.5 font-semibold">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredEntries.map((row) => (
                <tr key={row.id} className={row.status === 'WAIVED' ? 'opacity-55 bg-slate-50/40' : 'hover:bg-slate-50/70'}>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="font-mono text-[11px] font-semibold text-[#0F2744]">{row.rewardCode}</div>
                    <div className="font-mono text-[10px] text-slate-400">{formatDateTime(row.createdAt)}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-slate-900">{row.employeeName}</div>
                    <div className="text-[11px] text-slate-500">
                      {row.employeeCode} · {row.staffBucket === 'FIELD_OFFICER' ? 'Field Officer' : 'Lead Generator'}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-semibold whitespace-nowrap">
                    {row.entryType === 'DOC_LOGIN_REWARD' ? (
                      <span className="text-[#0F2744]">Docs Complete + Login</span>
                    ) : row.entryType === 'DISBURSEMENT_REWARD' ? (
                      <span className="text-[#15803D]">Disbursement Reward</span>
                    ) : (
                      <span className="text-[#DC2626]">Wrong Lead Penalty</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono">
                    {row.leadId && row.leadCode ? (
                      <button
                        type="button"
                        onClick={() => onOpenLead(row.leadId!)}
                        className="font-semibold text-[#EA580C] hover:underline"
                      >
                        {row.leadCode}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700 max-w-xs">{row.reason}</td>
                  <td
                    className={`px-4 py-2.5 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                      row.pointsDelta >= 0 ? 'text-[#15803D]' : 'text-[#DC2626]'
                    }`}
                  >
                    {row.pointsDelta >= 0 ? `+${row.pointsDelta} pts` : `-₹${Math.abs(row.pointsDelta)}`}
                  </td>
                  <td className="px-4 py-2.5 font-semibold">
                    {row.status === 'ACTIVE' ? (
                      <span className="inline-flex items-center gap-1 text-[#15803D]">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Active
                      </span>
                    ) : (
                      <span className="text-slate-500">Waived</span>
                    )}
                  </td>
                  {isSuperAdmin && (
                    <td className="px-4 py-2.5 text-right">
                      {row.entryType === 'WRONG_LEAD_PENALTY' && row.status === 'ACTIVE' ? (
                        <button
                          type="button"
                          onClick={() => handleWaive(row.id)}
                          className="px-2.5 py-1 rounded border border-slate-300 text-[11px] font-semibold text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                        >
                          Waive
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-400">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {filteredEntries.length === 0 && (
                <tr>
                  <td colSpan={isSuperAdmin ? 8 : 7} className="px-4 py-10 text-center text-slate-500">
                    No reward or penalty entries in this filter yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
