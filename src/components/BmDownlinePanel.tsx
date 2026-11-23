import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  HelpCircle,
  RefreshCw,
  Search,
  Target,
  UserCheck,
  Users,
  X,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import type { AuthUser } from '../../shared/types';
import { apiFetch, formatDateTime, formatInr } from '../lib/api';
import type { Lang } from '../lib/i18n';

interface ReferralNode {
  id: number;
  employeeCode: string;
  referralCode: string;
  fullName: string;
  mobile: string;
  email: string;
  isActive: boolean;
  serviceCity: string;
  leadsTotal: number;
  leadsInProgress: number;
  leadsCompleted: number;
  leadsDisbursed: number;
  leadsRejected: number;
  disbursedAmount: number;
  enquiriesTotal: number;
  enquiriesOpen: number;
  enquiriesResolved: number;
  payoutPending: number;
  payoutPaid: number;
}

interface LeadNode {
  id: number;
  leadCode: string;
  customerName: string;
  loanProduct: string;
  loanAmount: number;
  bankNbfc: string;
  status: string;
  referralCode: string;
  referralName: string;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

interface EnquiryNode {
  id: number;
  enquiryCode: string;
  leadId: number | null;
  leadCode: string;
  referralUserId: number;
  referralCode: string;
  referralName: string;
  category: string;
  description: string;
  status: string;
  solutionText: string;
  slaDeadlineAt: string;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
}

interface FieldOfficerNode {
  id: number;
  employeeCode: string;
  fullName: string;
  mobile: string;
  email: string;
  isActive: boolean;
  serviceCity: string;
  servicePincodes: string;
  referralCount: number;
  maxReferralCount: number;
  activeReferralCount: number;
  targetLeads: number;
  targetAmount: number;
  leadsAssigned: number;
  leadsInProgress: number;
  leadsCompleted: number;
  leadsDisbursed: number;
  leadsRejected: number;
  disbursedAmount: number;
  completionPct: number;
  targetAchievementPct: number;
  enquiriesTotal: number;
  enquiriesOpen: number;
  enquiriesResolved: number;
  enquiriesOverdue: number;
  referrals: ReferralNode[];
  leads: LeadNode[];
  enquiries: EnquiryNode[];
}

interface TeamLeaderNode {
  id: number;
  employeeCode: string;
  fullName: string;
  mobile: string;
  email: string;
  isActive: boolean;
  branchName: string;
  teamName: string;
  foCount: number;
  maxFoCount: number;
  activeFoCount: number;
  referralCount: number;
  targetLeads: number;
  targetAmount: number;
  leadsAssigned: number;
  leadsInProgress: number;
  leadsCompleted: number;
  leadsDisbursed: number;
  leadsRejected: number;
  disbursedAmount: number;
  completionPct: number;
  targetAchievementPct: number;
  enquiriesTotal: number;
  enquiriesOpen: number;
  enquiriesResolved: number;
  enquiriesOverdue: number;
  fieldOfficers: FieldOfficerNode[];
}

interface BmOption {
  id: number;
  employeeCode: string;
  fullName: string;
  mobile: string;
  branchId: number | null;
  branchName: string | null;
  branchCode: string | null;
  tlCount: number;
}

interface DownlinePayload {
  monthKey: string;
  canAssignTargets: boolean;
  branchManagers: BmOption[];
  selectedBm: BmOption | null;
  summary: {
    totalTeamLeaders: number;
    maxTeamLeaders: number;
    activeTeamLeaders: number;
    totalFieldOfficers: number;
    maxFieldOfficers: number;
    activeFieldOfficers: number;
    totalReferrals: number;
    totalLeadsAssigned: number;
    totalLeadsInProgress: number;
    totalLeadsCompleted: number;
    totalDisbursedLeads: number;
    totalDisbursedAmount: number;
    completionPct: number;
    totalTargetLeads: number;
    totalTargetAmount: number;
    achievementPct: number;
    totalEnquiries: number;
    openEnquiries: number;
    resolvedEnquiries: number;
    overdueEnquiries: number;
  };
  teamLeaders: TeamLeaderNode[];
}

interface TargetModalState {
  mode: 'single' | 'bulk-tl' | 'bulk-fo';
  userId?: number;
  title: string;
  subtitle: string;
  targetLeads: string;
  targetAmount: string;
  bulkIds?: number[];
}

interface BmDownlinePanelProps {
  user: AuthUser;
  lang: Lang;
  onOpenLead?: (leadId: number) => void;
}

function formatLakhs(amount: number): string {
  if (!amount) return '₹0';
  if (amount >= 10000000) return `₹${(amount / 10000000).toFixed(2)} Cr`;
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(2)} L`;
  return formatInr(amount);
}

function shortLabel(code: string, name: string): string {
  if (code && code.length <= 10) return code;
  const first = (name || code).split(/\s+/)[0] || code;
  return first.slice(0, 10);
}

function getLeadStatusTone(status: string): string {
  if (status === 'Disbursed' || status === 'Approved' || status === 'Closed') {
    return 'text-[#15803D] font-semibold';
  }
  if (status === 'Rejected') {
    return 'text-[#DC2626] font-semibold';
  }
  if (status === 'Documents Pending' || status === 'Lead Generated') {
    return 'text-[#D97706] font-semibold';
  }
  return 'text-[#0F2744] font-semibold';
}

function getEnquiryStatusTone(status: string, isOverdue: boolean): string {
  if (isOverdue) return 'text-[#DC2626] font-semibold';
  if (status === 'Resolved' || status === 'Closed') return 'text-[#15803D] font-semibold';
  if (status === 'Solution Updated') return 'text-[#0F2744] font-semibold';
  return 'text-[#D97706] font-semibold';
}

export const BmDownlinePanel: React.FC<BmDownlinePanelProps> = ({ user, lang, onOpenLead }) => {
  const [monthKey, setMonthKey] = useState(() => new Date().toISOString().slice(0, 7));
  const [selectedBmId, setSelectedBmId] = useState<string>('');
  const [data, setData] = useState<DownlinePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 3-Level Drill-Down Selection
  const [selectedTlId, setSelectedTlId] = useState<number | null>(null);
  const [selectedFoId, setSelectedFoId] = useState<number | null>(null);

  // Chart Metric Mode
  const [tlPerfMetric, setTlPerfMetric] = useState<'leads' | 'amount'>('leads');
  const [foPerfMetric, setFoPerfMetric] = useState<'leads' | 'amount'>('leads');

  // Search & Sub-Tab Filters
  const [tlSearch, setTlSearch] = useState('');
  const [foSearch, setFoSearch] = useState('');
  const [foDetailTab, setFoDetailTab] = useState<'referrals' | 'leads' | 'enquiries'>('referrals');
  const [refSearch, setRefSearch] = useState('');
  const [selectedRefFilter, setSelectedRefFilter] = useState<ReferralNode | null>(null);
  const [leadStatusFilter, setLeadStatusFilter] = useState<string>('ALL');
  const [leadSearch, setLeadSearch] = useState('');
  const [enquiryFilter, setEnquiryFilter] = useState<'ALL' | 'OPEN' | 'OVERDUE' | 'RESOLVED'>('ALL');

  // Target Assignment Modal
  const [targetModal, setTargetModal] = useState<TargetModalState | null>(null);
  const [savingTarget, setSavingTarget] = useState(false);

  const loadData = async (nextMonth = monthKey, nextBmId = selectedBmId) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ month: nextMonth });
      if (nextBmId) params.set('bmId', nextBmId);
      const res = await apiFetch<DownlinePayload>(`/bm/downline-hierarchy?${params.toString()}`);
      setData(res);
      if (!nextBmId && res.selectedBm?.id) {
        setSelectedBmId(String(res.selectedBm.id));
      }
      // If caller is TEAM_LEADER, automatically focus on their TL view (their 10 FOs)
      if (user.role === 'TEAM_LEADER' && res.teamLeaders.length === 1) {
        setSelectedTlId(res.teamLeaders[0].id);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not load BM downline hierarchy');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData(monthKey, selectedBmId);
    const onLiveSync = () => void loadData(monthKey, selectedBmId);
    window.addEventListener('ambika:live-sync', onLiveSync);
    return () => window.removeEventListener('ambika:live-sync', onLiveSync);
  }, [monthKey, selectedBmId]);

  const selectedTl = useMemo(() => {
    if (!data || selectedTlId === null) return null;
    return data.teamLeaders.find((t) => t.id === selectedTlId) || null;
  }, [data, selectedTlId]);

  const selectedFo = useMemo(() => {
    if (!selectedTl || selectedFoId === null) return null;
    return selectedTl.fieldOfficers.find((f) => f.id === selectedFoId) || null;
  }, [selectedTl, selectedFoId]);

  const filteredTls = useMemo(() => {
    const list = data?.teamLeaders || [];
    const q = tlSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t) =>
        t.employeeCode.toLowerCase().includes(q) ||
        t.fullName.toLowerCase().includes(q) ||
        t.mobile.toLowerCase().includes(q)
    );
  }, [data, tlSearch]);

  const filteredFos = useMemo(() => {
    const list = selectedTl?.fieldOfficers || [];
    const q = foSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (f) =>
        f.employeeCode.toLowerCase().includes(q) ||
        f.fullName.toLowerCase().includes(q) ||
        f.mobile.toLowerCase().includes(q) ||
        f.serviceCity.toLowerCase().includes(q)
    );
  }, [selectedTl, foSearch]);

  const filteredReferrals = useMemo(() => {
    const list = selectedFo?.referrals || [];
    const q = refSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (r) =>
        r.referralCode.toLowerCase().includes(q) ||
        r.employeeCode.toLowerCase().includes(q) ||
        r.fullName.toLowerCase().includes(q) ||
        r.mobile.toLowerCase().includes(q)
    );
  }, [selectedFo, refSearch]);

  const filteredFoLeads = useMemo(() => {
    const list = selectedFo?.leads || [];
    const q = leadSearch.trim().toLowerCase();
    return list.filter((l) => {
      if (selectedRefFilter) {
        const rCode = selectedRefFilter.referralCode.toUpperCase();
        const eCode = selectedRefFilter.employeeCode.toUpperCase();
        const lRef = (l.referralCode || '').toUpperCase();
        const matchesRef = l.createdBy === selectedRefFilter.id || lRef === rCode || lRef === eCode;
        if (!matchesRef) return false;
      }
      if (leadStatusFilter !== 'ALL') {
        if (leadStatusFilter === 'COMPLETED') {
          if (l.status !== 'Disbursed' && l.status !== 'Closed') return false;
        } else if (leadStatusFilter === 'IN_PROGRESS') {
          if (l.status === 'Disbursed' || l.status === 'Closed' || l.status === 'Rejected') return false;
        } else if (l.status !== leadStatusFilter) {
          return false;
        }
      }
      if (!q) return true;
      return (
        l.leadCode.toLowerCase().includes(q) ||
        l.customerName.toLowerCase().includes(q) ||
        l.loanProduct.toLowerCase().includes(q) ||
        l.referralCode.toLowerCase().includes(q)
      );
    });
  }, [selectedFo, selectedRefFilter, leadStatusFilter, leadSearch]);

  const filteredFoEnquiries = useMemo(() => {
    const list = selectedFo?.enquiries || [];
    return list.filter((e) => {
      if (selectedRefFilter) {
        const rCode = selectedRefFilter.referralCode.toUpperCase();
        const eCode = selectedRefFilter.employeeCode.toUpperCase();
        const eqRef = (e.referralCode || '').toUpperCase();
        const matchesRef = e.referralUserId === selectedRefFilter.id || eqRef === rCode || eqRef === eCode;
        if (!matchesRef) return false;
      }
      if (enquiryFilter === 'OPEN') return e.status !== 'Resolved' && e.status !== 'Closed';
      if (enquiryFilter === 'OVERDUE') return e.isOverdue;
      if (enquiryFilter === 'RESOLVED') return e.status === 'Resolved' || e.status === 'Closed';
      return true;
    });
  }, [selectedFo, selectedRefFilter, enquiryFilter]);

  const tlChartData = useMemo(() => {
    return (data?.teamLeaders || []).map((tl) => ({
      name: shortLabel(tl.employeeCode, tl.fullName),
      fullName: `${tl.fullName} (${tl.employeeCode})`,
      targetLeads: tl.targetLeads,
      completedLeads: tl.leadsCompleted,
      assignedLeads: tl.leadsAssigned,
      inProgressLeads: tl.leadsInProgress,
      targetLakhs: Number((tl.targetAmount / 100000).toFixed(2)),
      achievedLakhs: Number((tl.disbursedAmount / 100000).toFixed(2)),
    }));
  }, [data]);

  const foChartData = useMemo(() => {
    return (selectedTl?.fieldOfficers || []).map((fo) => ({
      name: shortLabel(fo.employeeCode, fo.fullName),
      fullName: `${fo.fullName} (${fo.employeeCode})`,
      targetLeads: fo.targetLeads,
      completedLeads: fo.leadsCompleted,
      assignedLeads: fo.leadsAssigned,
      inProgressLeads: fo.leadsInProgress,
      targetLakhs: Number((fo.targetAmount / 100000).toFixed(2)),
      achievedLakhs: Number((fo.disbursedAmount / 100000).toFixed(2)),
    }));
  }, [selectedTl]);

  const handleSaveTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetModal) return;
    const tLeads = Math.max(1, Number(targetModal.targetLeads || 0));
    const tAmt = Math.max(50000, Number(targetModal.targetAmount || 0));
    setSavingTarget(true);
    setError(null);
    setToast(null);
    try {
      if (targetModal.mode === 'single' && targetModal.userId) {
        await apiFetch('/bm/assign-target', {
          method: 'POST',
          json: {
            monthKey,
            userId: targetModal.userId,
            targetLeads: tLeads,
            targetAmount: tAmt,
          },
        });
        setToast(
          `Target assigned to ${targetModal.title}: ${tLeads} Leads · ${formatInr(tAmt)} for ${monthKey}.`
        );
      } else if (targetModal.bulkIds && targetModal.bulkIds.length > 0) {
        await apiFetch('/bm/assign-target', {
          method: 'POST',
          json: {
            monthKey,
            targets: targetModal.bulkIds.map((uid) => ({
              userId: uid,
              targetLeads: tLeads,
              targetAmount: tAmt,
            })),
          },
        });
        setToast(
          `Assigned ${tLeads} Leads & ${formatInr(tAmt)} target each to ${targetModal.bulkIds.length} mapped members for ${monthKey}.`
        );
      }
      setTargetModal(null);
      await loadData(monthKey, selectedBmId);
    } catch (err: any) {
      setError(err?.message || 'Could not save target');
    } finally {
      setSavingTarget(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="h-16 rounded-xl bg-white border border-slate-200 animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-white border border-slate-200 animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="h-72 rounded-xl bg-white border border-slate-200 animate-pulse" />
          <div className="h-72 rounded-xl bg-white border border-slate-200 animate-pulse" />
        </div>
      </div>
    );
  }

  const summary = data?.summary;
  const canAssign = Boolean(data?.canAssignTargets);

  return (
    <div className="space-y-5">
      {/* Header & Breadcrumb Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <button
              type="button"
              onClick={() => {
                setSelectedFoId(null);
                setSelectedRefFilter(null);
                if (user.role !== 'TEAM_LEADER') setSelectedTlId(null);
              }}
              className={`font-medium transition-colors whitespace-nowrap ${
                selectedTlId === null ? 'text-[#0F2744] font-semibold' : 'hover:text-[#0F2744]'
              }`}
            >
              {data?.selectedBm
                ? `${data.selectedBm.fullName} (${data.selectedBm.employeeCode})`
                : 'Branch Manager'}
            </button>
            {selectedTl && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFoId(null);
                    setSelectedRefFilter(null);
                  }}
                  className={`font-medium transition-colors whitespace-nowrap ${
                    selectedFoId === null ? 'text-[#0F2744] font-semibold' : 'hover:text-[#0F2744]'
                  }`}
                >
                  TL: {selectedTl.fullName} ({selectedTl.employeeCode})
                </button>
              </>
            )}
            {selectedFo && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="font-semibold text-[#EA580C] whitespace-nowrap">
                  FO: {selectedFo.fullName} ({selectedFo.employeeCode})
                </span>
              </>
            )}
          </div>
          <h1 className="text-xl font-display font-bold text-[#0F2744] tracking-tight">
            {selectedFo
              ? lang === 'hi'
                ? `${selectedFo.fullName} · मैप्ड रेफरल, लीड और इंक्वायरी स्टेटस`
                : `${selectedFo.fullName} · Mapped Referrals, Leads & Enquiry Status`
              : selectedTl
              ? lang === 'hi'
                ? `${selectedTl.fullName} · 10 फील्ड ऑफिसर परफॉर्मेंस व लीड चार्ट`
                : `${selectedTl.fullName} · Mapped Field Officers Performance & Lead Chart`
              : lang === 'hi'
              ? 'BM डाउनलाइन कमांड · 10 टीम लीडर, परफॉर्मेंस चार्ट व टारगेट'
              : 'BM Downline Command · 10 Team Leaders, Performance Charts & Targets'}
          </h1>
          <div className="text-xs text-slate-500 flex flex-wrap items-center gap-2">
            <span>{data?.selectedBm?.branchName || 'Head Office Branch'}</span>
            <span aria-hidden="true">·</span>
            <span>Hierarchy: 1 BM → 10 TLs → 10 FOs → 50 Referrals</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">Month {monthKey}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {user.role === 'SUPER_ADMIN' && data && data.branchManagers.length > 0 && (
            <select
              aria-label="Select Branch Manager"
              value={selectedBmId}
              onChange={(e) => {
                setSelectedBmId(e.target.value);
                setSelectedTlId(null);
                setSelectedFoId(null);
                setSelectedRefFilter(null);
              }}
              className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20"
            >
              {data.branchManagers.map((bm) => (
                <option key={bm.id} value={String(bm.id)}>
                  {bm.employeeCode} · {bm.fullName} ({bm.tlCount} TLs)
                </option>
              ))}
            </select>
          )}
          <input
            type="month"
            aria-label="Target & Performance Month"
            value={monthKey}
            onChange={(e) => setMonthKey(e.target.value)}
            className="px-3 py-2 text-xs font-mono tabular-nums rounded-lg border border-slate-300 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20"
          />
          <button
            type="button"
            onClick={() => void loadData(monthKey, selectedBmId)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-[#DC2626] flex items-center justify-between gap-2">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="font-bold underline shrink-0">
            Dismiss
          </button>
        </div>
      )}

      {toast && (
        <div className="p-3.5 rounded-xl bg-green-50 border border-green-200 text-xs font-medium text-[#15803D] flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {toast}
          </span>
          <button type="button" onClick={() => setToast(null)} className="font-bold underline shrink-0">
            Dismiss
          </button>
        </div>
      )}

      {/* ===================================================================== */}
      {/* LEVEL 1: BM -> 10 MAPPED TEAM LEADERS                                 */}
      {/* ===================================================================== */}
      {!selectedTl && data && summary && (
        <div className="space-y-5">
          {/* 4-Column Flat KPI Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">Mapped Team Leaders</div>
              <div className="text-2xl font-display font-bold text-[#0F2744] mt-1 tabular-nums">
                {summary.totalTeamLeaders} <span className="text-sm font-normal text-slate-400">/ {summary.maxTeamLeaders}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {summary.activeTeamLeaders} Active · {summary.totalFieldOfficers} Mapped FOs
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">Downline FOs &amp; Referrals</div>
              <div className="text-2xl font-display font-bold text-[#0F2744] mt-1 tabular-nums">
                {summary.totalFieldOfficers}{' '}
                <span className="text-sm font-normal text-slate-400">FOs</span>
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                {summary.activeFieldOfficers} Active · {summary.totalReferrals} Referral IDs Mapped
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">Leads Assigned vs Completed</div>
              <div className="text-2xl font-display font-bold text-[#15803D] mt-1 tabular-nums">
                {summary.totalLeadsCompleted}{' '}
                <span className="text-sm font-normal text-slate-400">/ {summary.totalLeadsAssigned}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                {summary.completionPct}% Complete · {summary.totalLeadsInProgress} In Progress
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">Monthly Target vs Achieved</div>
              <div className="text-2xl font-display font-bold text-[#EA580C] mt-1 tabular-nums">
                {formatLakhs(summary.totalDisbursedAmount)}
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                Target {formatLakhs(summary.totalTargetAmount)} ({summary.achievementPct}%) · {summary.openEnquiries} Open Enq
              </div>
            </div>
          </div>

          {/* 2-Column Team Leader Charts */}
          {data.teamLeaders.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Chart 1: TL Target vs Achieved Performance Chart */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-display font-bold text-[#0F2744]">
                      Team Leader Performance Chart (Target vs Achieved)
                    </h2>
                    <p className="text-xs text-slate-500">
                      Comparing monthly assigned target vs actual achievement across mapped TLs
                    </p>
                  </div>
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setTlPerfMetric('leads')}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        tlPerfMetric === 'leads' ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      Leads
                    </button>
                    <button
                      type="button"
                      onClick={() => setTlPerfMetric('amount')}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        tlPerfMetric === 'amount' ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      ₹ Lakhs
                    </button>
                  </div>
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={tlChartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#475569' }} />
                      <YAxis tick={{ fontSize: 11, fill: '#475569' }} allowDecimals={tlPerfMetric === 'amount'} />
                      <Tooltip
                        formatter={(val: any, key: any) =>
                          tlPerfMetric === 'amount' ? [`₹${val} L`, key] : [val, key]
                        }
                        labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName || _label}
                        contentStyle={{
                          borderRadius: '8px',
                          border: '1px solid #E2E8F0',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px' }} />
                      {tlPerfMetric === 'leads' ? (
                        <>
                          <Bar dataKey="targetLeads" name="Target Leads" fill="#0F2744" radius={[4, 4, 0, 0]} />
                          <Bar dataKey="completedLeads" name="Completed Leads" fill="#15803D" radius={[4, 4, 0, 0]} />
                        </>
                      ) : (
                        <>
                          <Bar dataKey="targetLakhs" name="Target (₹ Lakhs)" fill="#0F2744" radius={[4, 4, 0, 0]} />
                          <Bar dataKey="achievedLakhs" name="Disbursed (₹ Lakhs)" fill="#EA580C" radius={[4, 4, 0, 0]} />
                        </>
                      )}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Chart 2: TL Lead Assigned vs Completed Chart */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3">
                <div>
                  <h2 className="text-sm font-display font-bold text-[#0F2744]">
                    Team Leader Lead Assigned vs Completed Chart
                  </h2>
                  <p className="text-xs text-slate-500">
                    Total leads assigned, active pipeline in progress, and completed/disbursed cases
                  </p>
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={tlChartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#475569' }} />
                      <YAxis tick={{ fontSize: 11, fill: '#475569' }} allowDecimals={false} />
                      <Tooltip
                        labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName || _label}
                        contentStyle={{
                          borderRadius: '8px',
                          border: '1px solid #E2E8F0',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px' }} />
                      <Bar dataKey="assignedLeads" name="Leads Assigned" fill="#0F2744" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="inProgressLeads" name="In Progress" fill="#D97706" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="completedLeads" name="Completed" fill="#15803D" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {/* 10 Mapped Team Leaders Table + Target Assigning */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Downline Team Leaders ({filteredTls.length} / {summary.maxTeamLeaders})
                </h2>
                <p className="text-xs text-slate-500">
                  Click any Team Leader to inspect their 10 mapped Field Officers, performance charts, referrals &amp; enquiry status
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={tlSearch}
                    onChange={(e) => setTlSearch(e.target.value)}
                    placeholder="Search TL ID, name, mobile..."
                    className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20 w-56"
                  />
                </div>
                {canAssign && data.teamLeaders.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setTargetModal({
                        mode: 'bulk-tl',
                        title: `All ${data.teamLeaders.length} Mapped Team Leaders`,
                        subtitle: `Assign equal ${monthKey} target to every Team Leader under ${data.selectedBm?.fullName || 'BM'}`,
                        targetLeads: '25',
                        targetAmount: '2500000',
                        bulkIds: data.teamLeaders.map((t) => t.id),
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold whitespace-nowrap shrink-0"
                  >
                    <Target className="w-3.5 h-3.5" />
                    Bulk Assign Target to All TLs
                  </button>
                )}
              </div>
            </div>

            {filteredTls.length === 0 ? (
              <div className="p-10 text-center space-y-2">
                <Users className="w-8 h-8 text-slate-300 mx-auto" />
                <div className="text-sm font-semibold text-[#0F2744]">No Team Leaders mapped under this Branch Manager yet</div>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Super Admin can map up to 10 Team Leader IDs under this Branch Manager in Admin Console → Login IDs &amp; Passwords.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                      <th className="py-2.5 px-4">Team Leader</th>
                      <th className="py-2.5 px-3 text-right">Mapped FOs</th>
                      <th className="py-2.5 px-3 text-right">Referrals</th>
                      <th className="py-2.5 px-3 text-right">Leads (Comp / Assg)</th>
                      <th className="py-2.5 px-3 text-right">Disbursed</th>
                      <th className="py-2.5 px-3">Monthly Target ({monthKey})</th>
                      <th className="py-2.5 px-3 text-right">Enquiries</th>
                      <th className="py-2.5 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredTls.map((tl) => {
                      const pct = tl.targetAchievementPct;
                      const barColor =
                        pct >= 80 ? 'bg-[#15803D]' : pct >= 40 ? 'bg-[#D97706]' : 'bg-[#EA580C]';
                      return (
                        <tr key={tl.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-4">
                            <div className="font-semibold text-[#0F2744]">{tl.fullName}</div>
                            <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-1.5">
                              <span className="font-mono">{tl.employeeCode}</span>
                              {tl.mobile && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono tabular-nums">{tl.mobile}</span>
                                </>
                              )}
                              <span aria-hidden="true">·</span>
                              <span className={tl.isActive ? 'text-[#15803D] font-medium' : 'text-[#DC2626] font-medium'}>
                                {tl.isActive ? 'Active' : 'OFF'}
                              </span>
                            </div>
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums">
                            <span className="font-semibold text-[#0F2744]">{tl.foCount}</span>
                            <span className="text-slate-400"> / {tl.maxFoCount}</span>
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                            {tl.referralCount}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums">
                            <div className="font-semibold text-[#0F2744]">
                              {tl.leadsCompleted} / {tl.leadsAssigned}
                            </div>
                            <div className="text-[11px] text-slate-500">{tl.completionPct}% done</div>
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-[#15803D]">
                            {formatLakhs(tl.disbursedAmount)}
                          </td>
                          <td className="py-3 px-3 min-w-[180px]">
                            {tl.targetLeads > 0 || tl.targetAmount > 0 ? (
                              <div className="space-y-1">
                                <div className="flex items-center justify-between text-[11px] tabular-nums">
                                  <span className="font-medium text-slate-700">
                                    {tl.targetLeads} Leads · {formatLakhs(tl.targetAmount)}
                                  </span>
                                  <span className="font-mono font-semibold text-[#0F2744]">{pct}%</span>
                                </div>
                                <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full ${barColor}`}
                                    style={{ width: `${Math.min(100, pct)}%` }}
                                  />
                                </div>
                              </div>
                            ) : (
                              <span className="text-[11px] text-slate-400">No target assigned</span>
                            )}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums">
                            <div className="text-slate-700">
                              {tl.enquiriesOpen} open / {tl.enquiriesTotal}
                            </div>
                            {tl.enquiriesOverdue > 0 && (
                              <div className="text-[11px] text-[#DC2626] font-semibold">
                                {tl.enquiriesOverdue} overdue
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {canAssign && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setTargetModal({
                                      mode: 'single',
                                      userId: tl.id,
                                      title: `${tl.fullName} (${tl.employeeCode})`,
                                      subtitle: `Team Leader · Monthly target for ${monthKey}`,
                                      targetLeads: String(tl.targetLeads || 25),
                                      targetAmount: String(tl.targetAmount || 2500000),
                                    })
                                  }
                                  className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-semibold whitespace-nowrap shrink-0"
                                >
                                  Assign Target
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedTlId(tl.id);
                                  setSelectedFoId(null);
                                  setSelectedRefFilter(null);
                                  setFoSearch('');
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-[11px] font-semibold whitespace-nowrap shrink-0"
                              >
                                View {tl.foCount} FOs
                                <ChevronRight className="w-3 h-3" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* LEVEL 2: SELECTED TEAM LEADER -> 10 MAPPED FIELD OFFICERS             */}
      {/* ===================================================================== */}
      {selectedTl && !selectedFo && (
        <div className="space-y-5">
          {/* TL Action Bar & Summary Strip */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {user.role !== 'TEAM_LEADER' ? (
              <button
                type="button"
                onClick={() => {
                  setSelectedTlId(null);
                  setSelectedFoId(null);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-[#0F2744] whitespace-nowrap"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back to All Team Leaders
              </button>
            ) : (
              <div className="text-xs text-slate-500">
                Showing Field Officers mapped directly to your Team Leader ID
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {canAssign && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setTargetModal({
                        mode: 'single',
                        userId: selectedTl.id,
                        title: `${selectedTl.fullName} (${selectedTl.employeeCode})`,
                        subtitle: `Team Leader · Monthly target for ${monthKey}`,
                        targetLeads: String(selectedTl.targetLeads || 25),
                        targetAmount: String(selectedTl.targetAmount || 2500000),
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-[#0F2744] whitespace-nowrap"
                  >
                    <Target className="w-3.5 h-3.5 text-[#EA580C]" />
                    Edit TL Target
                  </button>
                  {selectedTl.fieldOfficers.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setTargetModal({
                          mode: 'bulk-fo',
                          title: `All ${selectedTl.fieldOfficers.length} FOs under ${selectedTl.fullName}`,
                          subtitle: `Assign equal ${monthKey} target to every mapped Field Officer`,
                          targetLeads: String(
                            Math.max(
                              3,
                              Math.round((selectedTl.targetLeads || 30) / Math.max(1, selectedTl.fieldOfficers.length))
                            )
                          ),
                          targetAmount: String(
                            Math.max(
                              250000,
                              Math.round((selectedTl.targetAmount || 2500000) / Math.max(1, selectedTl.fieldOfficers.length))
                            )
                          ),
                          bulkIds: selectedTl.fieldOfficers.map((f) => f.id),
                        })
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold whitespace-nowrap"
                    >
                      <Target className="w-3.5 h-3.5" />
                      Assign Target to All FOs
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* TL KPI Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">Mapped Field Officers</div>
              <div className="text-2xl font-display font-bold text-[#0F2744] mt-1 tabular-nums">
                {selectedTl.foCount} <span className="text-sm font-normal text-slate-400">/ {selectedTl.maxFoCount}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                {selectedTl.activeFoCount} Active · {selectedTl.referralCount} Mapped Referrals
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">TL Leads Assigned vs Completed</div>
              <div className="text-2xl font-display font-bold text-[#15803D] mt-1 tabular-nums">
                {selectedTl.leadsCompleted}{' '}
                <span className="text-sm font-normal text-slate-400">/ {selectedTl.leadsAssigned}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                {selectedTl.completionPct}% Complete · {selectedTl.leadsInProgress} In Progress
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">TL Target vs Achieved</div>
              <div className="text-2xl font-display font-bold text-[#EA580C] mt-1 tabular-nums">
                {formatLakhs(selectedTl.disbursedAmount)}
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                Target {formatLakhs(selectedTl.targetAmount)} ({selectedTl.targetAchievementPct}%)
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">Team Enquiries</div>
              <div className="text-2xl font-display font-bold text-[#0F2744] mt-1 tabular-nums">
                {selectedTl.enquiriesOpen}{' '}
                <span className="text-sm font-normal text-slate-400">open / {selectedTl.enquiriesTotal}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                {selectedTl.enquiriesResolved} Resolved ·{' '}
                <span className={selectedTl.enquiriesOverdue > 0 ? 'text-[#DC2626] font-semibold' : ''}>
                  {selectedTl.enquiriesOverdue} Overdue SLA
                </span>
              </div>
            </div>
          </div>

          {/* 2-Column Field Officer Charts */}
          {selectedTl.fieldOfficers.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Chart 1: FO Performance Chart */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-display font-bold text-[#0F2744]">
                      Field Officer Performance Chart
                    </h2>
                    <p className="text-xs text-slate-500">
                      Target vs actual achievement for {selectedTl.fullName}&apos;s mapped Field Officers
                    </p>
                  </div>
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setFoPerfMetric('leads')}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        foPerfMetric === 'leads' ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      Leads
                    </button>
                    <button
                      type="button"
                      onClick={() => setFoPerfMetric('amount')}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        foPerfMetric === 'amount' ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      ₹ Lakhs
                    </button>
                  </div>
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={foChartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#475569' }} />
                      <YAxis tick={{ fontSize: 11, fill: '#475569' }} allowDecimals={foPerfMetric === 'amount'} />
                      <Tooltip
                        formatter={(val: any, key: any) =>
                          foPerfMetric === 'amount' ? [`₹${val} L`, key] : [val, key]
                        }
                        labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName || _label}
                        contentStyle={{
                          borderRadius: '8px',
                          border: '1px solid #E2E8F0',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px' }} />
                      {foPerfMetric === 'leads' ? (
                        <>
                          <Bar dataKey="targetLeads" name="Target Leads" fill="#0F2744" radius={[4, 4, 0, 0]} />
                          <Bar dataKey="completedLeads" name="Completed Leads" fill="#15803D" radius={[4, 4, 0, 0]} />
                        </>
                      ) : (
                        <>
                          <Bar dataKey="targetLakhs" name="Target (₹ Lakhs)" fill="#0F2744" radius={[4, 4, 0, 0]} />
                          <Bar dataKey="achievedLakhs" name="Disbursed (₹ Lakhs)" fill="#EA580C" radius={[4, 4, 0, 0]} />
                        </>
                      )}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Chart 2: FO Lead Assigned & Completed Chart */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-3">
                <div>
                  <h2 className="text-sm font-display font-bold text-[#0F2744]">
                    Field Officer Lead Assigned &amp; Completed Chart
                  </h2>
                  <p className="text-xs text-slate-500">
                    Side-by-side breakdown of Assigned, In Progress, and Completed leads per Field Officer
                  </p>
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={foChartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#475569' }} />
                      <YAxis tick={{ fontSize: 11, fill: '#475569' }} allowDecimals={false} />
                      <Tooltip
                        labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName || _label}
                        contentStyle={{
                          borderRadius: '8px',
                          border: '1px solid #E2E8F0',
                          fontSize: '12px',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '12px' }} />
                      <Bar dataKey="assignedLeads" name="Leads Assigned" fill="#0F2744" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="inProgressLeads" name="In Progress" fill="#D97706" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="completedLeads" name="Completed" fill="#15803D" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {/* 10 Mapped Field Officers Directory Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Field Officers Mapped under {selectedTl.fullName} ({filteredFos.length} / {selectedTl.maxFoCount})
                </h2>
                <p className="text-xs text-slate-500">
                  Click any Field Officer to view all mapped Referral Partners, individual Lead stages, and Enquiry status
                </p>
              </div>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={foSearch}
                  onChange={(e) => setFoSearch(e.target.value)}
                  placeholder="Search FO ID, name, city..."
                  className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20 w-56"
                />
              </div>
            </div>

            {filteredFos.length === 0 ? (
              <div className="p-10 text-center space-y-2">
                <UserCheck className="w-8 h-8 text-slate-300 mx-auto" />
                <div className="text-sm font-semibold text-[#0F2744]">No Field Officers mapped under this Team Leader</div>
                <p className="text-xs text-slate-500">
                  Map up to 10 Field Officers under {selectedTl.employeeCode} from Admin Console → Login IDs &amp; Passwords.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                      <th className="py-2.5 px-4">Field Officer</th>
                      <th className="py-2.5 px-3 text-right">Referrals</th>
                      <th className="py-2.5 px-3 text-right">Assigned</th>
                      <th className="py-2.5 px-3 text-right">In Progress</th>
                      <th className="py-2.5 px-3 text-right">Completed</th>
                      <th className="py-2.5 px-3 text-right">Disbursed</th>
                      <th className="py-2.5 px-3">Target ({monthKey})</th>
                      <th className="py-2.5 px-3 text-right">Enquiries</th>
                      <th className="py-2.5 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredFos.map((fo) => (
                      <tr key={fo.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-semibold text-[#0F2744]">{fo.fullName}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-1.5">
                            <span className="font-mono">{fo.employeeCode}</span>
                            {fo.mobile && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono tabular-nums">{fo.mobile}</span>
                              </>
                            )}
                            {fo.serviceCity && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{fo.serviceCity}</span>
                              </>
                            )}
                            <span aria-hidden="true">·</span>
                            <span className={fo.isActive ? 'text-[#15803D] font-medium' : 'text-[#DC2626] font-medium'}>
                              {fo.isActive ? 'Active' : 'OFF'}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums">
                          <span className="font-semibold text-[#0F2744]">{fo.referralCount}</span>
                          <span className="text-slate-400"> / {fo.maxReferralCount}</span>
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-[#0F2744]">
                          {fo.leadsAssigned}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-[#D97706] font-medium">
                          {fo.leadsInProgress}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums">
                          <span className="font-semibold text-[#15803D]">{fo.leadsCompleted}</span>
                          <span className="text-[11px] text-slate-400 ml-1">({fo.completionPct}%)</span>
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-[#15803D]">
                          {formatLakhs(fo.disbursedAmount)}
                        </td>
                        <td className="py-3 px-3 text-[11px] tabular-nums">
                          {fo.targetLeads > 0 || fo.targetAmount > 0 ? (
                            <div>
                              <div className="font-medium text-slate-700">
                                {fo.targetLeads}L · {formatLakhs(fo.targetAmount)}
                              </div>
                              <div className="text-slate-500">{fo.targetAchievementPct}% achieved</div>
                            </div>
                          ) : (
                            <span className="text-slate-400">Not set</span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums">
                          <div>
                            {fo.enquiriesOpen} / {fo.enquiriesTotal}
                          </div>
                          {fo.enquiriesOverdue > 0 && (
                            <div className="text-[11px] text-[#DC2626] font-semibold">
                              {fo.enquiriesOverdue} overdue
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            {canAssign && (
                              <button
                                type="button"
                                onClick={() =>
                                  setTargetModal({
                                    mode: 'single',
                                    userId: fo.id,
                                    title: `${fo.fullName} (${fo.employeeCode})`,
                                    subtitle: `Field Officer under ${selectedTl.fullName} · ${monthKey}`,
                                    targetLeads: String(fo.targetLeads || 5),
                                    targetAmount: String(fo.targetAmount || 500000),
                                  })
                                }
                                className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-semibold whitespace-nowrap shrink-0"
                              >
                                Target
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedFoId(fo.id);
                                setFoDetailTab('referrals');
                                setSelectedRefFilter(null);
                                setRefSearch('');
                                setLeadSearch('');
                                setLeadStatusFilter('ALL');
                                setEnquiryFilter('ALL');
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-[11px] font-semibold whitespace-nowrap shrink-0"
                            >
                              Referrals &amp; Status
                              <ChevronRight className="w-3 h-3" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* LEVEL 3: SELECTED FIELD OFFICER -> REFERRALS, LEADS & ENQUIRY STATUS  */}
      {/* ===================================================================== */}
      {selectedTl && selectedFo && (
        <div className="space-y-5">
          {/* Back & Quick Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                setSelectedFoId(null);
                setSelectedRefFilter(null);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-[#0F2744] whitespace-nowrap"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to {selectedTl.fullName}&apos;s Field Officers
            </button>

            {canAssign && (
              <button
                type="button"
                onClick={() =>
                  setTargetModal({
                    mode: 'single',
                    userId: selectedFo.id,
                    title: `${selectedFo.fullName} (${selectedFo.employeeCode})`,
                    subtitle: `Field Officer · Monthly target for ${monthKey}`,
                    targetLeads: String(selectedFo.targetLeads || 5),
                    targetAmount: String(selectedFo.targetAmount || 500000),
                  })
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold whitespace-nowrap"
              >
                <Target className="w-3.5 h-3.5" />
                Assign FO Target
              </button>
            )}
          </div>

          {/* FO KPI Summary Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">Mapped Referral Partners</div>
              <div className="text-2xl font-display font-bold text-[#0F2744] mt-1 tabular-nums">
                {selectedFo.referralCount}{' '}
                <span className="text-sm font-normal text-slate-400">/ {selectedFo.maxReferralCount}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {selectedFo.activeReferralCount} Active · {selectedFo.serviceCity || 'Territory All'}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">Leads Assigned / Completed</div>
              <div className="text-2xl font-display font-bold text-[#15803D] mt-1 tabular-nums">
                {selectedFo.leadsCompleted}{' '}
                <span className="text-sm font-normal text-slate-400">/ {selectedFo.leadsAssigned}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                {selectedFo.leadsInProgress} In Progress · {selectedFo.leadsRejected} Rejected
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">Disbursed &amp; Target</div>
              <div className="text-2xl font-display font-bold text-[#EA580C] mt-1 tabular-nums">
                {formatLakhs(selectedFo.disbursedAmount)}
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                Target {formatLakhs(selectedFo.targetAmount)} ({selectedFo.targetAchievementPct}%)
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium">Lead Enquiry Status</div>
              <div className="text-2xl font-display font-bold text-[#0F2744] mt-1 tabular-nums">
                {selectedFo.enquiriesOpen}{' '}
                <span className="text-sm font-normal text-slate-400">open / {selectedFo.enquiriesTotal}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                {selectedFo.enquiriesResolved} Resolved ·{' '}
                <span className={selectedFo.enquiriesOverdue > 0 ? 'text-[#DC2626] font-semibold' : ''}>
                  {selectedFo.enquiriesOverdue} SLA Overdue
                </span>
              </div>
            </div>
          </div>

          {/* Active Referral Filter Notice */}
          {selectedRefFilter && (
            <div className="px-4 py-2.5 rounded-xl bg-slate-100 border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-slate-700">
                Filtered by Referral Partner: <strong>{selectedRefFilter.fullName}</strong> (
                <span className="font-mono">{selectedRefFilter.referralCode}</span>)
              </span>
              <button
                type="button"
                onClick={() => setSelectedRefFilter(null)}
                className="inline-flex items-center gap-1 font-semibold text-[#0F2744] hover:text-[#EA580C]"
              >
                <X className="w-3.5 h-3.5" />
                Show All Referrals
              </button>
            </div>
          )}

          {/* Segmented Tabs: Referrals | Lead Status | Enquiry Status */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setFoDetailTab('referrals')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    foDetailTab === 'referrals' ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                  }`}
                >
                  Mapped Referrals ({selectedFo.referrals.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFoDetailTab('leads')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    foDetailTab === 'leads' ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                  }`}
                >
                  Lead Status ({filteredFoLeads.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFoDetailTab('enquiries')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    foDetailTab === 'enquiries' ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                  }`}
                >
                  Enquiry Status ({filteredFoEnquiries.length})
                </button>
              </div>

              {foDetailTab === 'referrals' && (
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={refSearch}
                    onChange={(e) => setRefSearch(e.target.value)}
                    placeholder="Search Referral code, name, mobile..."
                    className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white w-60 focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20"
                  />
                </div>
              )}

              {foDetailTab === 'leads' && (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={leadSearch}
                      onChange={(e) => setLeadSearch(e.target.value)}
                      placeholder="Search lead code, customer..."
                      className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white w-52 focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20"
                    />
                  </div>
                  <select
                    aria-label="Filter Lead Status"
                    value={leadStatusFilter}
                    onChange={(e) => setLeadStatusFilter(e.target.value)}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700"
                  >
                    <option value="ALL">All Stages</option>
                    <option value="IN_PROGRESS">In Progress</option>
                    <option value="COMPLETED">Completed / Disbursed</option>
                    <option value="Lead Assigned">Lead Assigned</option>
                    <option value="Documents Pending">Documents Pending</option>
                    <option value="Under Process">Under Process</option>
                    <option value="Disbursed">Disbursed</option>
                    <option value="Rejected">Rejected</option>
                  </select>
                </div>
              )}

              {foDetailTab === 'enquiries' && (
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {(
                    [
                      { id: 'ALL', label: 'All' },
                      { id: 'OPEN', label: 'Open' },
                      { id: 'OVERDUE', label: 'Overdue SLA' },
                      { id: 'RESOLVED', label: 'Resolved' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setEnquiryFilter(opt.id)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded-md whitespace-nowrap ${
                        enquiryFilter === opt.id ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Tab A: Mapped Referral Partners */}
            {foDetailTab === 'referrals' && (
              filteredReferrals.length === 0 ? (
                <div className="p-10 text-center space-y-2">
                  <Users className="w-8 h-8 text-slate-300 mx-auto" />
                  <div className="text-sm font-semibold text-[#0F2744]">No Referral Partners mapped under this Field Officer</div>
                  <p className="text-xs text-slate-500">
                    Up to 50 Referral Partner IDs can be mapped under {selectedFo.employeeCode}.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                        <th className="py-2.5 px-4">Referral Partner</th>
                        <th className="py-2.5 px-3">Referral Code</th>
                        <th className="py-2.5 px-3 text-right">Total Leads</th>
                        <th className="py-2.5 px-3 text-right">In Progress</th>
                        <th className="py-2.5 px-3 text-right">Disbursed</th>
                        <th className="py-2.5 px-3 text-right">Volume</th>
                        <th className="py-2.5 px-3 text-right">Enquiries</th>
                        <th className="py-2.5 px-3 text-right">Payout (Pending / Paid)</th>
                        <th className="py-2.5 px-4 text-right">Drill-Down</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {filteredReferrals.map((ref) => (
                        <tr key={ref.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-4">
                            <div className="font-semibold text-[#0F2744]">{ref.fullName}</div>
                            <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-1.5">
                              <span className="font-mono">{ref.employeeCode}</span>
                              {ref.mobile && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono tabular-nums">{ref.mobile}</span>
                                </>
                              )}
                              <span aria-hidden="true">·</span>
                              <span className={ref.isActive ? 'text-[#15803D] font-medium' : 'text-[#DC2626] font-medium'}>
                                {ref.isActive ? 'Active' : 'OFF'}
                              </span>
                            </div>
                          </td>
                          <td className="py-3 px-3 font-mono text-[#0F2744] font-semibold">
                            {ref.referralCode}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold">
                            {ref.leadsTotal}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums text-[#D97706]">
                            {ref.leadsInProgress}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums text-[#15803D] font-semibold">
                            {ref.leadsDisbursed}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-[#15803D]">
                            {formatLakhs(ref.disbursedAmount)}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums">
                            {ref.enquiriesOpen} open / {ref.enquiriesTotal}
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums text-[11px]">
                            <span className="text-[#D97706]">{formatInr(ref.payoutPending)}</span>
                            <span className="text-slate-400"> / </span>
                            <span className="text-[#15803D]">{formatInr(ref.payoutPaid)}</span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedRefFilter(ref);
                                  setFoDetailTab('leads');
                                }}
                                className="px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 text-[11px] font-semibold text-[#0F2744] whitespace-nowrap"
                              >
                                Leads
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedRefFilter(ref);
                                  setFoDetailTab('enquiries');
                                }}
                                className="px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 text-[11px] font-semibold text-[#EA580C] whitespace-nowrap"
                              >
                                Enquiries
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {/* Tab B: Lead Status */}
            {foDetailTab === 'leads' && (
              filteredFoLeads.length === 0 ? (
                <div className="p-10 text-center space-y-2">
                  <AlertTriangle className="w-7 h-7 text-slate-300 mx-auto" />
                  <div className="text-sm font-semibold text-[#0F2744]">No matching leads found</div>
                  <p className="text-xs text-slate-500">
                    Leads assigned to {selectedFo.employeeCode} or submitted by their mapped referrals will appear here.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                        <th className="py-2.5 px-4">Lead &amp; Customer</th>
                        <th className="py-2.5 px-3">Loan Product &amp; Bank</th>
                        <th className="py-2.5 px-3 text-right">Amount</th>
                        <th className="py-2.5 px-3">Referral Source</th>
                        <th className="py-2.5 px-3">Current Status</th>
                        <th className="py-2.5 px-3">Last Updated</th>
                        <th className="py-2.5 px-4 text-right">Case</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {filteredFoLeads.map((lead) => (
                        <tr key={lead.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-4">
                            <div className="font-semibold text-[#0F2744]">{lead.customerName}</div>
                            <div className="text-[11px] font-mono text-slate-500 mt-0.5">{lead.leadCode}</div>
                          </td>
                          <td className="py-3 px-3">
                            <div className="font-medium text-slate-800">{lead.loanProduct}</div>
                            <div className="text-[11px] text-slate-500">{lead.bankNbfc}</div>
                          </td>
                          <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-[#0F2744]">
                            {formatInr(lead.loanAmount)}
                          </td>
                          <td className="py-3 px-3 text-[11px] text-slate-600">
                            {lead.referralCode || lead.referralName ? (
                              <span>
                                {lead.referralCode}
                                {lead.referralName ? ` · ${lead.referralName}` : ''}
                              </span>
                            ) : (
                              <span className="text-slate-400">Direct / Internal</span>
                            )}
                          </td>
                          <td className={`py-3 px-3 text-xs ${getLeadStatusTone(lead.status)}`}>
                            {lead.status}
                          </td>
                          <td className="py-3 px-3 text-[11px] font-mono tabular-nums text-slate-500">
                            {formatDateTime(lead.updatedAt || lead.createdAt)}
                          </td>
                          <td className="py-3 px-4 text-right">
                            {onOpenLead && (
                              <button
                                type="button"
                                onClick={() => onOpenLead(lead.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-[11px] font-semibold text-[#0F2744] whitespace-nowrap"
                              >
                                Open
                                <ArrowUpRight className="w-3 h-3" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {/* Tab C: Enquiry Status */}
            {foDetailTab === 'enquiries' && (
              filteredFoEnquiries.length === 0 ? (
                <div className="p-10 text-center space-y-2">
                  <HelpCircle className="w-7 h-7 text-slate-300 mx-auto" />
                  <div className="text-sm font-semibold text-[#0F2744]">No matching enquiries found</div>
                  <p className="text-xs text-slate-500">
                    Lead enquiries raised by {selectedFo.employeeCode}&apos;s mapped referrals or assigned to this officer appear here.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
                        <th className="py-2.5 px-4">Enquiry &amp; Lead</th>
                        <th className="py-2.5 px-3">Referral Partner</th>
                        <th className="py-2.5 px-3">Category &amp; Details</th>
                        <th className="py-2.5 px-3">Status &amp; SLA</th>
                        <th className="py-2.5 px-3">Solution</th>
                        <th className="py-2.5 px-4 text-right">Created</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {filteredFoEnquiries.map((enq) => (
                        <tr key={enq.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-3 px-4">
                            <div className="font-mono font-semibold text-[#0F2744]">{enq.enquiryCode}</div>
                            {enq.leadCode && (
                              <div className="text-[11px] text-slate-500 font-mono mt-0.5">Lead: {enq.leadCode}</div>
                            )}
                          </td>
                          <td className="py-3 px-3">
                            <div className="font-medium text-slate-800">{enq.referralName || 'Referral Partner'}</div>
                            <div className="text-[11px] font-mono text-slate-500">{enq.referralCode || '—'}</div>
                          </td>
                          <td className="py-3 px-3 max-w-xs">
                            <div className="font-semibold text-slate-800">{enq.category}</div>
                            <div className="text-[11px] text-slate-500 line-clamp-2">{enq.description}</div>
                          </td>
                          <td className="py-3 px-3">
                            <div className={getEnquiryStatusTone(enq.status, enq.isOverdue)}>{enq.status}</div>
                            <div
                              className={`text-[11px] mt-0.5 ${
                                enq.isOverdue ? 'text-[#DC2626] font-semibold' : 'text-slate-500'
                              }`}
                            >
                              {enq.isOverdue ? 'SLA Overdue (1h+)' : 'Within SLA'}
                            </div>
                          </td>
                          <td className="py-3 px-3 max-w-xs text-[11px] text-slate-600">
                            {enq.solutionText || <span className="text-slate-400">Awaiting response</span>}
                          </td>
                          <td className="py-3 px-4 text-right text-[11px] font-mono tabular-nums text-slate-500">
                            {formatDateTime(enq.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* Target Assigning Modal (Single TL / Single FO / Bulk TLs / Bulk FOs) */}
      {targetModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bm-target-modal-title"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
              <div>
                <h3 id="bm-target-modal-title" className="text-sm font-display font-bold text-[#0F2744]">
                  Assign Monthly Target · {monthKey}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{targetModal.subtitle}</p>
              </div>
              <button
                type="button"
                onClick={() => setTargetModal(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                aria-label="Close target dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveTarget} className="p-5 space-y-4">
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
                <div className="text-slate-500">Assigning to</div>
                <div className="font-semibold text-[#0F2744] mt-0.5">{targetModal.title}</div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Target Completed Leads
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={5000}
                    required
                    value={targetModal.targetLeads}
                    onChange={(e) => setTargetModal({ ...targetModal, targetLeads: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Target Disbursement (₹)
                  </label>
                  <input
                    type="number"
                    min={50000}
                    step={50000}
                    required
                    value={targetModal.targetAmount}
                    onChange={(e) => setTargetModal({ ...targetModal, targetAmount: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20"
                  />
                  <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                    {formatLakhs(Number(targetModal.targetAmount || 0))}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setTargetModal(null)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingTarget}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#EA580C] hover:bg-[#C2410C] disabled:opacity-60 text-white"
                >
                  {savingTarget ? 'Saving…' : 'Save & Notify Team'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
