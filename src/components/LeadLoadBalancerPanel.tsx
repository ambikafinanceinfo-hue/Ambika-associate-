import React, { useEffect, useState } from 'react';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Compass,
  Loader2,
  MapPin,
  RefreshCw,
  Scale,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import type { AuthUser, FieldOfficerWorkload, LoadBalanceCandidate } from '../../shared/types';
import { apiFetch, formatDateTime, formatInr } from '../lib/api';

interface OverviewResponse {
  settings: {
    autoAssignIncomingLeads: boolean;
    maxActiveLeads: number;
    geoWeight: number;
  };
  officers: FieldOfficerWorkload[];
  unassignedCount: number;
  unassignedPreview: {
    id: number;
    leadCode: string;
    customerName: string;
    city: string | null;
    state: string | null;
    pinCode: string | null;
    loanProduct: string;
    loanAmount: number;
    createdAt: string;
  }[];
  recentAutoAssignments: {
    id: number;
    userName: string;
    userRole: string;
    action: string;
    leadCode: string | null;
    details: string;
    createdAt: string;
  }[];
}

interface BatchResultItem {
  leadId: number;
  leadCode: string;
  customerName: string;
  city: string | null;
  pinCode: string | null;
  assignedOfficerId: number;
  assignedOfficerName: string;
  assignedOfficerCode: string;
  compositeScore: number;
  geoMatchReasons: string[];
  previousActiveLoad: number;
}

interface LeadLoadBalancerPanelProps {
  user: AuthUser;
  branches: { id: number; name: string; city: string; state: string }[];
  onDistributed: () => void;
  onOpenLead: (leadId: number) => void;
}

export const LeadLoadBalancerPanel: React.FC<LeadLoadBalancerPanelProps> = ({
  user,
  branches,
  onDistributed,
  onOpenLead,
}) => {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [distributing, setDistributing] = useState(false);
  const [assigningLeadId, setAssigningLeadId] = useState<number | null>(null);
  const [togglingSetting, setTogglingSetting] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchResultItem[] | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  // Live routing simulator inputs
  const [simCity, setSimCity] = useState('Mumbai');
  const [simPinCode, setSimPinCode] = useState('400053');
  const [simAddress, setSimAddress] = useState('Andheri West');
  const [simBranchId, setSimBranchId] = useState('');
  const [simCandidates, setSimCandidates] = useState<LoadBalanceCandidate[] | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  const isSuperAdmin = user.role === 'SUPER_ADMIN';

  const loadOverview = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<OverviewResponse>('/leads/load-balance/overview');
      setOverview(res);
    } finally {
      setLoading(false);
    }
  };

  const runSimulation = async (
    city = simCity,
    pinCode = simPinCode,
    address = simAddress,
    branchId = simBranchId
  ) => {
    setSimLoading(true);
    try {
      const res = await apiFetch<{ candidates: LoadBalanceCandidate[] }>('/leads/load-balance/preview', {
        method: 'POST',
        json: {
          city: city.trim() || null,
          pinCode: pinCode.trim() || null,
          address: address.trim() || null,
          branchId: branchId ? Number(branchId) : null,
        },
      });
      setSimCandidates(res.candidates);
    } finally {
      setSimLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
    runSimulation('Mumbai', '400053', 'Andheri West', '');
  }, []);

  const handleBatchDistribute = async () => {
    setDistributing(true);
    setStatusBanner(null);
    setBatchResults(null);
    try {
      const res = await apiFetch<{ distributedCount: number; assignments: BatchResultItem[] }>(
        '/leads/load-balance/distribute-unassigned',
        { method: 'POST' }
      );
      setBatchResults(res.assignments);
      setStatusBanner(
        res.distributedCount > 0
          ? `Successfully auto-distributed ${res.distributedCount} lead(s) across active Field Officers by workload and geography.`
          : 'No unassigned active leads currently awaiting distribution.'
      );
      await loadOverview();
      await runSimulation();
      onDistributed();
    } catch (err: any) {
      setStatusBanner(err.message || 'Batch distribution failed');
    } finally {
      setDistributing(false);
    }
  };

  const handleAutoAssignSingle = async (leadId: number) => {
    setAssigningLeadId(leadId);
    setStatusBanner(null);
    try {
      const res = await apiFetch<{ decision: LoadBalanceCandidate }>(`/leads/${leadId}/auto-assign`, {
        method: 'POST',
      });
      setStatusBanner(
        `Assigned lead to ${res.decision.officer.fullName} (${res.decision.officer.employeeCode}) · Score ${res.decision.compositeScore} · ${res.decision.geoMatchReasons.join(', ')}`
      );
      await loadOverview();
      await runSimulation();
      onDistributed();
    } catch (err: any) {
      setStatusBanner(err.message || 'Auto-assign failed');
    } finally {
      setAssigningLeadId(null);
    }
  };

  const handleToggleAutoAssign = async () => {
    if (!overview || !isSuperAdmin) return;
    setTogglingSetting(true);
    try {
      await apiFetch('/admin/settings', {
        method: 'PATCH',
        json: { autoAssignIncomingLeads: !overview.settings.autoAssignIncomingLeads },
      });
      await loadOverview();
    } finally {
      setTogglingSetting(false);
    }
  };

  const getLoadBadgeStyle = (status: FieldOfficerWorkload['loadStatus']) => {
    if (status === 'AT_CAPACITY') return 'text-[#DC2626] bg-red-50 border-red-200';
    if (status === 'HIGH_LOAD') return 'text-[#EA580C] bg-orange-50 border-orange-200';
    if (status === 'BALANCED') return 'text-[#0F2744] bg-blue-50 border-blue-200';
    return 'text-[#15803D] bg-green-50 border-green-200';
  };

  const getLoadStatusLabel = (status: FieldOfficerWorkload['loadStatus']) => {
    if (status === 'AT_CAPACITY') return 'At Capacity';
    if (status === 'HIGH_LOAD') return 'High Load';
    if (status === 'BALANCED') return 'Balanced';
    return 'Available';
  };

  if (loading && !overview) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-xs text-slate-500">
        Loading Field Officer workload &amp; geographical territory matrix...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header Control Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Scale className="w-5 h-5 text-[#EA580C]" />
            <h2 className="text-base font-display font-bold text-[#0F2744]">
              Automated Lead Load-Balancing Engine
            </h2>
            <span
              className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                overview?.settings.autoAssignIncomingLeads
                  ? 'bg-green-50 text-[#15803D] border-green-200'
                  : 'bg-slate-100 text-slate-600 border-slate-300'
              }`}
            >
              {overview?.settings.autoAssignIncomingLeads ? 'Auto-Distribute ON' : 'Manual Queue Mode'}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Scores every active Field Officer by geographical match (PIN code, locality, city, branch, live GPS)
            minus active pipeline workload &amp; daily load fairness. Config: Geo Weight{' '}
            <strong className="font-mono text-[#0F2744]">{overview?.settings.geoWeight ?? 60}%</strong> · Workload{' '}
            <strong className="font-mono text-[#0F2744]">{100 - (overview?.settings.geoWeight ?? 60)}%</strong> · Soft Cap{' '}
            <strong className="font-mono text-[#0F2744]">{overview?.settings.maxActiveLeads ?? 25}</strong> active leads.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isSuperAdmin && overview && (
            <button
              type="button"
              disabled={togglingSetting}
              onClick={handleToggleAutoAssign}
              className="px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-[#0F2744] whitespace-nowrap"
            >
              {overview.settings.autoAssignIncomingLeads ? 'Pause Auto-Intake' : 'Enable Auto-Intake'}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              loadOverview();
              runSimulation();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <button
            type="button"
            disabled={distributing || !overview || overview.unassignedCount === 0}
            onClick={handleBatchDistribute}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
          >
            {distributing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Auto-Distribute Queue ({overview?.unassignedCount ?? 0})
          </button>
        </div>
      </div>

      {statusBanner && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-medium text-[#15803D] flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{statusBanner}</span>
        </div>
      )}

      {/* Batch Distribution Results */}
      {batchResults && batchResults.length > 0 && (
        <div className="bg-white border border-emerald-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 bg-emerald-50/70 border-b border-emerald-200 text-xs font-display font-bold text-[#0F2744]">
            Batch Load-Balance Distribution Summary ({batchResults.length} Leads Assigned)
          </div>
          <div className="divide-y divide-slate-100">
            {batchResults.map((item) => (
              <div key={item.leadId} className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <button
                    type="button"
                    onClick={() => onOpenLead(item.leadId)}
                    className="font-mono font-bold text-[#0F2744] hover:underline"
                  >
                    {item.leadCode}
                  </button>{' '}
                  · <span className="font-semibold text-slate-800">{item.customerName}</span>
                  {(item.city || item.pinCode) && (
                    <span className="text-slate-500 ml-1.5">
                      ({[item.city, item.pinCode].filter(Boolean).join(' - ')})
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                  <span className="font-semibold text-[#15803D]">
                    {item.assignedOfficerName} ({item.assignedOfficerCode})
                  </span>
                  <span className="text-[11px] font-mono text-slate-500">
                    Prior Load: {item.previousActiveLoad} · Score: {item.compositeScore}
                  </span>
                  <span className="text-[11px] text-[#0F2744] bg-slate-100 px-2 py-0.5 rounded">
                    {item.geoMatchReasons[0] || 'Balanced'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active Field Officer Workload & Geographical Territory Matrix */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-display font-bold text-[#0F2744]">
            <Users className="w-4 h-4 text-[#EA580C]" />
            Active Field Officer Workload &amp; Geographical Coverage ({overview?.officers.length ?? 0})
          </div>
          <span className="text-[11px] text-slate-500">
            Territories can be updated under Admin &rarr; Users &amp; Roles
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left font-semibold px-4 py-3">Field Officer</th>
                <th className="text-left font-semibold px-4 py-3">Team Leader · Branch Manager</th>
                <th className="text-left font-semibold px-4 py-3">Working Location &amp; Branch</th>
                <th className="text-left font-semibold px-4 py-3">PIN Codes / Zones</th>
                <th className="text-left font-semibold px-4 py-3">Active Workload</th>
                <th className="text-right font-semibold px-4 py-3">Today / Urgent</th>
                <th className="text-right font-semibold px-4 py-3">Pipeline ₹</th>
                <th className="text-left font-semibold px-4 py-3">Availability</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {overview?.officers.map((fo) => (
                <tr key={fo.id} className="hover:bg-slate-50/70">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-slate-900">{fo.fullName}</div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {fo.employeeCode} · {fo.mobile}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs font-semibold text-[#0F2744]">
                      TL: {fo.teamLeaderName ? `${fo.teamLeaderName} (${fo.teamLeaderCode})` : 'Direct Branch'}
                    </div>
                    <div className="text-[11px] text-slate-600 mt-0.5">
                      BM: {fo.branchManagerName ? `${fo.branchManagerName} (${fo.branchManagerCode})` : '—'}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-[#0F2744]">{fo.serviceCity || fo.branchCity || '—'}</div>
                    <div className="text-[11px] text-slate-500">{fo.branchName || 'Unassigned Branch'}</div>
                  </td>
                  <td className="px-4 py-3 max-w-[230px]">
                    <div className="text-[11px] text-slate-700 font-mono truncate" title={fo.servicePincodes || ''}>
                      {fo.servicePincodes || 'All branch zones'}
                    </div>
                    {fo.lastGpsAt && (
                      <div className="text-[10px] text-[#15803D] flex items-center gap-1 mt-0.5">
                        <MapPin className="w-3 h-3" />
                        GPS check: {formatDateTime(fo.lastGpsAt)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 min-w-[155px]">
                    <div className="flex items-center justify-between font-mono text-[11px] mb-1">
                      <span className="font-bold text-[#0F2744]">
                        {fo.activeLeadCount} / {overview.settings.maxActiveLeads}
                      </span>
                      <span className="text-slate-500">{fo.utilizationPct}%</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          fo.loadStatus === 'AT_CAPACITY'
                            ? 'bg-[#DC2626]'
                            : fo.loadStatus === 'HIGH_LOAD'
                              ? 'bg-[#EA580C]'
                              : 'bg-[#15803D]'
                        }`}
                        style={{ width: `${Math.max(4, fo.utilizationPct)}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    <div className="font-semibold text-slate-800">{fo.assignedTodayCount} today</div>
                    <div className="text-[11px] text-slate-500">{fo.urgentPendingCount} pending SLA</div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-[#0F2744]">
                    {formatInr(fo.activePipelineAmount)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded border text-[11px] font-semibold whitespace-nowrap ${getLoadBadgeStyle(
                        fo.loadStatus
                      )}`}
                    >
                      {getLoadStatusLabel(fo.loadStatus)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Two Column: Live Simulator + Unassigned Queue */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Interactive Geo + Workload Simulator */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-display font-bold text-[#0F2744]">
              <Compass className="w-4 h-4 text-[#EA580C]" />
              Live Routing Simulator (Test Geography &amp; Workload Scoring)
            </div>
            {simLoading && <Loader2 className="w-4 h-4 animate-spin text-[#0F2744]" />}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
            <input
              type="text"
              value={simCity}
              onChange={(e) => setSimCity(e.target.value)}
              placeholder="City (e.g. Mumbai, Pune)"
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              maxLength={6}
              value={simPinCode}
              onChange={(e) => setSimPinCode(e.target.value)}
              placeholder="PIN (e.g. 400053)"
              className="px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
            />
            <input
              type="text"
              value={simAddress}
              onChange={(e) => setSimAddress(e.target.value)}
              placeholder="Locality (e.g. Andheri)"
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            />
            <div className="flex gap-1.5">
              <select
                value={simBranchId}
                onChange={(e) => setSimBranchId(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="">Any Branch</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.city}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => runSimulation()}
                className="px-3 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold whitespace-nowrap"
              >
                Score
              </button>
            </div>
          </div>

          {simCandidates && (
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {simCandidates.map((cand, idx) => (
                <div
                  key={cand.officer.id}
                  className={`px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs ${
                    idx === 0 ? 'bg-emerald-50/70' : 'bg-white'
                  }`}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-[#0F2744]">#{idx + 1}</span>
                      <span className="font-semibold text-slate-900">
                        {cand.officer.fullName} ({cand.officer.employeeCode})
                      </span>
                      {idx === 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-[#15803D] text-white text-[10px] font-bold">
                          BEST MATCH
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-600 flex flex-wrap gap-1.5">
                      {cand.geoMatchReasons.map((r, rIdx) => (
                        <span key={rIdx} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                          {r}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right font-mono tabular-nums shrink-0">
                    <div className="text-sm font-bold text-[#0F2744]">Score {cand.compositeScore}</div>
                    <div className="text-[10px] text-slate-500">
                      Geo {cand.geoScore >= 0 ? `+${cand.geoScore}` : cand.geoScore} · Load -{cand.workloadPenalty} ·
                      Fair +{cand.fairnessBonus}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Unassigned Queue + Recent Auto-Assignments */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-display font-bold text-[#0F2744] flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#EA580C]" />
                Unassigned Leads ({overview?.unassignedCount ?? 0})
              </div>
            </div>
            {overview && overview.unassignedPreview.length === 0 ? (
              <div className="p-4 rounded-lg bg-slate-50 text-xs text-slate-500 text-center">
                All active incoming leads are currently balanced across Field Officers.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {overview?.unassignedPreview.map((lead) => (
                  <div key={lead.id} className="px-3 py-2.5 flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => onOpenLead(lead.id)}
                        className="font-mono font-bold text-[#0F2744] hover:underline"
                      >
                        {lead.leadCode}
                      </button>{' '}
                      · <span className="font-semibold text-slate-800">{lead.customerName}</span>
                      <div className="text-[11px] text-slate-500 truncate">
                        {[lead.loanProduct, lead.city, lead.pinCode].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={assigningLeadId === lead.id}
                      onClick={() => handleAutoAssignSingle(lead.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] disabled:opacity-50 text-white text-[11px] font-semibold whitespace-nowrap shrink-0"
                    >
                      {assigningLeadId === lead.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Zap className="w-3 h-3" />
                      )}
                      Auto-Assign
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="text-sm font-display font-bold text-[#0F2744] flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#15803D]" />
              Recent Automated Distributions
            </div>
            {overview && overview.recentAutoAssignments.length === 0 ? (
              <div className="text-xs text-slate-500">No automated distributions logged yet.</div>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {overview?.recentAutoAssignments.map((log) => (
                  <div key={log.id} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px]">
                    <div className="flex items-center justify-between gap-2 font-semibold text-[#0F2744]">
                      <span>{log.leadCode || 'Batch'}</span>
                      <span className="font-normal text-slate-400">{formatDateTime(log.createdAt)}</span>
                    </div>
                    <div className="text-slate-600 mt-0.5">{log.details}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
