import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Award,
  CheckCircle2,
  FileCheck2,
  MinusCircle,
  RefreshCw,
  Search,
  TrendingUp,
  Users,
} from 'lucide-react';
import type { AuthUser, StaffRewardRecord } from '../../shared/types';
import { apiFetch, formatDateTime, formatInr } from '../lib/api';
import { StaffRewardsModule } from './StaffRewardsModule';

interface RewardSummary {
  loginRewardPts: number;
  loginRewardCount: number;
  disbursementRewardPts: number;
  disbursementRewardCount: number;
  wrongLeadPenaltyPts: number;
  wrongLeadCount: number;
  netRewardPts: number;
}

interface RewardDashboardProps {
  user: AuthUser;
  activeOption?: 'my' | 'team' | null;
  onSelectOption?: (opt: 'my' | 'team') => void;
  onOpenLead: (leadId: number) => void;
  onAlertsChanged: () => void;
}

export const RewardDashboard: React.FC<RewardDashboardProps> = ({
  user,
  activeOption,
  onSelectOption,
  onOpenLead,
  onAlertsChanged,
}) => {
  const isManager = ['SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER'].includes(user.role);
  const [viewMode, setViewMode] = useState<'my' | 'team'>(
    activeOption === 'team' && isManager ? 'team' : 'my'
  );

  useEffect(() => {
    if (activeOption === 'team' && isManager) setViewMode('team');
    else if (activeOption === 'my' || activeOption === null) setViewMode('my');
  }, [activeOption, isManager]);

  const changeViewMode = (mode: 'my' | 'team') => {
    setViewMode(mode);
    onSelectOption?.(mode);
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mySummary, setMySummary] = useState<RewardSummary>({
    loginRewardPts: 0,
    loginRewardCount: 0,
    disbursementRewardPts: 0,
    disbursementRewardCount: 0,
    wrongLeadPenaltyPts: 0,
    wrongLeadCount: 0,
    netRewardPts: 0,
  });
  const [myEntries, setMyEntries] = useState<StaffRewardRecord[]>([]);
  const [rules, setRules] = useState({
    loginRewardOfficerPts: 50,
    loginRewardGeneratorPts: 30,
    disbursementRewardOfficerPts: 150,
    disbursementRewardGeneratorPts: 100,
    wrongLeadPenaltyMin: 10,
    wrongLeadPenaltyMax: 100,
  });

  const [filterType, setFilterType] = useState<
    'ALL' | 'CREDITS' | 'DOC_LOGIN_REWARD' | 'DISBURSEMENT_REWARD' | 'WRONG_LEAD_PENALTY'
  >('ALL');
  const [search, setSearch] = useState('');

  const loadMyRewards = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{
        mySummary: RewardSummary;
        myEntries: StaffRewardRecord[];
        rules: any;
      }>('/rewards');
      setMySummary(res.mySummary);
      setMyEntries(res.myEntries || []);
      if (res.rules) setRules(res.rules);
    } catch (err: any) {
      setError(err.message || 'Could not load reward dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMyRewards();
  }, [user.id]);

  const grossEarnedPts = mySummary.loginRewardPts + mySummary.disbursementRewardPts;
  const docSharePct = grossEarnedPts > 0 ? Math.round((mySummary.loginRewardPts / grossEarnedPts) * 100) : 0;
  const disbSharePct = grossEarnedPts > 0 ? 100 - docSharePct : 0;

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return myEntries.filter((row) => {
      if (filterType === 'CREDITS' && row.pointsDelta <= 0) return false;
      if (
        filterType !== 'ALL' &&
        filterType !== 'CREDITS' &&
        row.entryType !== filterType
      ) {
        return false;
      }
      if (!q) return true;
      return (
        row.rewardCode.toLowerCase().includes(q) ||
        (row.leadCode || '').toLowerCase().includes(q) ||
        (row.customerName || '').toLowerCase().includes(q) ||
        row.reason.toLowerCase().includes(q)
      );
    });
  }, [myEntries, filterType, search]);

  if (viewMode === 'team' && isManager) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => changeViewMode('my')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-[#0F2744]"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to My Rewards
            </button>
            <span className="text-xs font-semibold text-[#0F2744]">
              Reward Dashboard View Mode
            </span>
          </div>
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => changeViewMode('my')}
              className="px-3 py-1.5 rounded-md text-xs font-semibold text-slate-600 hover:text-slate-900 whitespace-nowrap"
            >
              My Reward Dashboard
            </button>
            <button
              type="button"
              onClick={() => changeViewMode('team')}
              className="px-3 py-1.5 rounded-md text-xs font-semibold bg-white text-[#0F2744] shadow-sm whitespace-nowrap"
            >
              Team Ledger &amp; Wrong-Lead Penalties
            </button>
          </div>
        </div>

        <StaffRewardsModule
          user={user}
          onOpenLead={onOpenLead}
          onAlertsChanged={onAlertsChanged}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header & Mode Switch */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            Reward Dashboard — {user.fullName}
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Personal accumulated reward points for <span className="font-mono font-semibold">{user.employeeCode}</span> ({user.role.replace('_', ' ')}), broken down by successful document uploads &amp; finance login vs. disbursement milestones and incorrect lead deductions.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isManager && (
            <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
              <button
                type="button"
                onClick={() => changeViewMode('my')}
                className="px-3 py-1.5 rounded-md text-xs font-semibold bg-white text-[#0F2744] shadow-sm whitespace-nowrap"
              >
                My Rewards
              </button>
              <button
                type="button"
                onClick={() => changeViewMode('team')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold text-slate-600 hover:text-slate-900 whitespace-nowrap"
              >
                <Users className="w-3.5 h-3.5" />
                Team &amp; Penalties
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={loadMyRewards}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-[#DC2626]">
          {error}
        </div>
      )}

      {/* 4 Breakdown KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-[#0F2744] text-white border border-[#0F2744] rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>Total Accumulated Points</span>
            <Award className="w-4 h-4 text-yellow-300" />
          </div>
          <div className="mt-2 text-2xl font-display font-bold font-mono tabular-nums">
            {mySummary.netRewardPts >= 0 ? `+${mySummary.netRewardPts}` : mySummary.netRewardPts} pts
          </div>
          <div className="mt-1 text-[11px] text-slate-300 font-mono tabular-nums">
            Net Value: {mySummary.netRewardPts < 0 ? `-${formatInr(Math.abs(mySummary.netRewardPts))}` : formatInr(mySummary.netRewardPts)} · Gross +{grossEarnedPts} pts
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Document Uploads &amp; Login</span>
            <FileCheck2 className="w-4 h-4 text-[#0F2744]" />
          </div>
          <div className="mt-2 text-2xl font-display font-bold font-mono tabular-nums text-[#0F2744]">
            +{mySummary.loginRewardPts} pts
          </div>
          <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
            {mySummary.loginRewardCount} completed doc &amp; login milestones
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Lead Disbursement Milestones</span>
            <TrendingUp className="w-4 h-4 text-[#15803D]" />
          </div>
          <div className="mt-2 text-2xl font-display font-bold font-mono tabular-nums text-[#15803D]">
            +{mySummary.disbursementRewardPts} pts
          </div>
          <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
            {mySummary.disbursementRewardCount} disbursed case milestones
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Incorrect Lead Deductions</span>
            <MinusCircle className="w-4 h-4 text-[#DC2626]" />
          </div>
          <div className="mt-2 text-2xl font-display font-bold font-mono tabular-nums text-[#DC2626]">
            -{mySummary.wrongLeadPenaltyPts} pts
          </div>
          <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
            {mySummary.wrongLeadCount} incorrect lead entries (-₹{mySummary.wrongLeadPenaltyPts})
          </div>
        </div>
      </div>

      {/* Milestone Share Breakdown Bar + Earning Rules */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-display font-bold text-[#0F2744]">
            Points Breakdown by Milestone
          </h2>
          <div className="text-[11px] text-slate-500 font-mono tabular-nums">
            Doc+Login: +{rules.loginRewardOfficerPts} FO / +{rules.loginRewardGeneratorPts} Gen · Disbursed: +{rules.disbursementRewardOfficerPts} FO / +{rules.disbursementRewardGeneratorPts} Gen · Wrong Lead: -₹{rules.wrongLeadPenaltyMin}–₹{rules.wrongLeadPenaltyMax}
          </div>
        </div>

        <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden flex">
          {grossEarnedPts > 0 ? (
            <>
              <div
                className="h-full bg-[#0F2744]"
                style={{ width: `${docSharePct}%` }}
                title={`Document Upload & Login: +${mySummary.loginRewardPts} pts (${docSharePct}%)`}
              />
              <div
                className="h-full bg-[#15803D]"
                style={{ width: `${disbSharePct}%` }}
                title={`Lead Disbursement Milestones: +${mySummary.disbursementRewardPts} pts (${disbSharePct}%)`}
              />
            </>
          ) : (
            <div className="h-full w-full bg-slate-200" />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-5">
            <span className="inline-flex items-center gap-2 text-slate-700 font-medium">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#0F2744]" />
              Successful Document Uploads &amp; Login: <strong className="font-mono tabular-nums">+{mySummary.loginRewardPts} pts ({docSharePct}%)</strong>
            </span>
            <span className="inline-flex items-center gap-2 text-slate-700 font-medium">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#15803D]" />
              Lead Disbursement Milestones: <strong className="font-mono tabular-nums">+{mySummary.disbursementRewardPts} pts ({disbSharePct}%)</strong>
            </span>
          </div>
          <span className="text-xs font-mono font-semibold text-[#DC2626] tabular-nums">
            Deductions: -{mySummary.wrongLeadPenaltyPts} pts
          </span>
        </div>
      </div>

      {/* Individual Credits & Deductions Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-display font-bold text-[#0F2744]">
              Individual Reward Credits &amp; Deductions
            </h2>
            <p className="text-[11px] text-slate-500">
              Line-by-line history of document upload + login credits, disbursement credits, and incorrect lead deductions.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search Lead ID, reason..."
                className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg w-48"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {[
                { id: 'ALL', label: `All (${myEntries.length})` },
                { id: 'CREDITS', label: 'Credits (+)' },
                { id: 'DOC_LOGIN_REWARD', label: 'Doc + Login' },
                { id: 'DISBURSEMENT_REWARD', label: 'Disbursed' },
                { id: 'WRONG_LEAD_PENALTY', label: 'Deductions (-)' },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilterType(f.id as any)}
                  className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors whitespace-nowrap ${
                    filterType === f.id
                      ? 'bg-white text-[#0F2744] shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Date &amp; Ref Code</th>
                <th className="text-left px-4 py-2.5 font-semibold">Lead ID &amp; Customer</th>
                <th className="text-left px-4 py-2.5 font-semibold">Milestone / Deduction Type</th>
                <th className="text-left px-4 py-2.5 font-semibold">Capacity</th>
                <th className="text-left px-4 py-2.5 font-semibold">Reason / Details</th>
                <th className="text-right px-4 py-2.5 font-semibold">Credit / Deduction</th>
                <th className="text-left px-4 py-2.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Loading reward credits and deductions...
                  </td>
                </tr>
              )}
              {!loading &&
                filteredRows.map((row) => {
                  const isCredit = row.pointsDelta >= 0;
                  const isWaived = row.status === 'WAIVED';
                  return (
                    <tr
                      key={row.id}
                      className={isWaived ? 'opacity-55 bg-slate-50/40' : 'hover:bg-slate-50/70'}
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <div className="font-mono text-[11px] font-semibold text-[#0F2744]">
                          {row.rewardCode}
                        </div>
                        <div className="font-mono text-[10px] text-slate-400">
                          {formatDateTime(row.createdAt)}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        {row.leadId && row.leadCode ? (
                          <div>
                            <button
                              type="button"
                              onClick={() => onOpenLead(row.leadId!)}
                              className="font-mono font-semibold text-[#EA580C] hover:underline"
                            >
                              {row.leadCode}
                            </button>
                            {row.customerName && (
                              <div className="text-[11px] text-slate-500 truncate max-w-[160px]">
                                {row.customerName}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-semibold whitespace-nowrap">
                        {row.entryType === 'DOC_LOGIN_REWARD' ? (
                          <span className="text-[#0F2744]">Document Upload &amp; Login</span>
                        ) : row.entryType === 'DISBURSEMENT_REWARD' ? (
                          <span className="text-[#15803D]">Lead Disbursement</span>
                        ) : (
                          <span className="text-[#DC2626]">Incorrect Lead Data</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">
                        {row.staffBucket === 'FIELD_OFFICER' ? 'Field Officer' : 'Lead Generator'}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700 max-w-xs">{row.reason}</td>
                      <td
                        className={`px-4 py-2.5 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                          isWaived
                            ? 'line-through text-slate-400'
                            : isCredit
                            ? 'text-[#15803D]'
                            : 'text-[#DC2626]'
                        }`}
                      >
                        {isCredit ? `+${row.pointsDelta} pts` : `-${Math.abs(row.pointsDelta)} pts (-₹${Math.abs(row.pointsDelta)})`}
                      </td>
                      <td className="px-4 py-2.5 font-semibold whitespace-nowrap">
                        {isWaived ? (
                          <span className="text-slate-500">Waived</span>
                        ) : isCredit ? (
                          <span className="inline-flex items-center gap-1 text-[#15803D]">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Credited
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[#DC2626]">
                            <MinusCircle className="w-3.5 h-3.5" />
                            Deducted
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              {!loading && filteredRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    No reward credits or deductions match this filter yet.
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
