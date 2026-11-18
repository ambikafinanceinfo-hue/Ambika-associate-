import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Search,
  Sparkles,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import { HIERARCHY_LIMITS, type AuthUser } from '../../shared/types';
import { apiFetch, formatDateTime } from '../lib/api';
import type { Lang } from '../lib/i18n';

interface ReferralConsoleProps {
  user: AuthUser;
  lang: Lang;
}

interface ManagedReferral {
  id: number;
  employeeCode: string;
  fullName: string;
  mobile: string;
  email: string;
  referralCode: string;
  branchId: number | null;
  branchName: string | null;
  serviceCity: string | null;
  assignedFieldOfficerId: number | null;
  assignedFieldOfficerName: string | null;
  assignedFieldOfficerCode: string | null;
  isActive: boolean;
  createdAt: string;
}

interface FoQuotaItem {
  id: number;
  employeeCode: string;
  fullName: string;
  mobile: string;
  branchId: number | null;
  branchName: string | null;
  referralCount: number;
  maxReferrals: number;
}

interface CreatedCred {
  employeeCode: string;
  password: string;
  fullName: string;
  referralCode: string;
  assignedFieldOfficerName: string;
  assignedFieldOfficerCode: string;
}

function generateReferralPassword(length = 8): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export const ReferralConsoleModule: React.FC<ReferralConsoleProps> = ({ user, lang }) => {
  const isFieldOfficer = user.role === 'FIELD_OFFICER';
  const [referrals, setReferrals] = useState<ManagedReferral[]>([]);
  const [fieldOfficers, setFieldOfficers] = useState<FoQuotaItem[]>([]);
  const [permissions, setPermissions] = useState({
    canCreate: true,
    canChangeFieldOfficer: !isFieldOfficer,
    canRemove: !isFieldOfficer,
  });
  const [maxPerFo, setMaxPerFo] = useState<number>(HIERARCHY_LIMITS.REFERRALS_PER_FO);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(!isFieldOfficer);
  const [search, setSearch] = useState('');
  const [filterFoId, setFilterFoId] = useState<string>('ALL');
  const [msg, setMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [form, setForm] = useState({
    fullName: '',
    mobile: '',
    employeeCode: '',
    password: generateReferralPassword(8),
    referralCode: '',
    serviceCity: '',
    assignedFieldOfficerId: isFieldOfficer ? String(user.id) : '',
  });

  const [createdCreds, setCreatedCreds] = useState<CreatedCred[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Back Office / Admin-only inline states (never shown to FO)
  const [editingFoId, setEditingFoId] = useState<number | null>(null);
  const [selectedNewFoId, setSelectedNewFoId] = useState<string>('');
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
  const [busyRowId, setBusyRowId] = useState<number | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{
        referrals: ManagedReferral[];
        fieldOfficers: FoQuotaItem[];
        maxReferralsPerFo: number;
        permissions: { canCreate: boolean; canChangeFieldOfficer: boolean; canRemove: boolean };
      }>('/referrals/manage');
      setReferrals(res.referrals);
      setFieldOfficers(res.fieldOfficers);
      setMaxPerFo(res.maxReferralsPerFo || HIERARCHY_LIMITS.REFERRALS_PER_FO);
      setPermissions(res.permissions);
      if (isFieldOfficer) {
        setForm((prev) => ({ ...prev, assignedFieldOfficerId: String(user.id) }));
      } else {
        setForm((prev) => {
          if (prev.assignedFieldOfficerId) return prev;
          const avail = res.fieldOfficers.find((fo) => fo.referralCount < (res.maxReferralsPerFo || 50));
          return { ...prev, assignedFieldOfficerId: avail ? String(avail.id) : '' };
        });
      }
    } catch (err: any) {
      setErrMsg(err.message || 'Could not load Referral ID console');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user.id]);

  const selfFoQuota = useMemo(() => {
    if (!isFieldOfficer) return null;
    return fieldOfficers.find((f) => f.id === user.id) || {
      id: user.id,
      employeeCode: user.employeeCode,
      fullName: user.fullName,
      mobile: user.mobile,
      branchId: user.branchId,
      branchName: user.branchName,
      referralCount: referrals.length,
      maxReferrals: maxPerFo,
    };
  }, [isFieldOfficer, fieldOfficers, user, referrals.length, maxPerFo]);

  const filteredReferrals = useMemo(() => {
    const q = search.trim().toLowerCase();
    return referrals.filter((r) => {
      if (filterFoId !== 'ALL' && String(r.assignedFieldOfficerId || '') !== filterFoId) return false;
      if (!q) return true;
      return (
        r.fullName.toLowerCase().includes(q) ||
        r.employeeCode.toLowerCase().includes(q) ||
        r.referralCode?.toLowerCase().includes(q) ||
        r.mobile?.toLowerCase().includes(q) ||
        r.assignedFieldOfficerName?.toLowerCase().includes(q) ||
        r.assignedFieldOfficerCode?.toLowerCase().includes(q)
      );
    });
  }, [referrals, search, filterFoId]);

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  const downloadCredsCsv = () => {
    if (createdCreds.length === 0) return;
    const rows = [
      ['Login ID', 'Password', 'Partner Name', 'Referral Code', 'Assigned Field Officer'],
      ...createdCreds.map((c) => [
        c.employeeCode,
        c.password,
        c.fullName,
        c.referralCode,
        `${c.assignedFieldOfficerName} (${c.assignedFieldOfficerCode})`,
      ]),
    ];
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ambika-referral-ids-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCreateReferral = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErrMsg(null);
    setSubmitting(true);
    try {
      const payload: Record<string, any> = {
        fullName: form.fullName.trim(),
        mobile: form.mobile.trim(),
        employeeCode: form.employeeCode.trim() || undefined,
        password: form.password.trim() || undefined,
        referralCode: form.referralCode.trim() || undefined,
        serviceCity: form.serviceCity.trim() || undefined,
      };
      if (!isFieldOfficer) {
        payload.assignedFieldOfficerId = form.assignedFieldOfficerId ? Number(form.assignedFieldOfficerId) : undefined;
      }

      const res = await apiFetch<{ ok: boolean; created: CreatedCred }>('/referrals/manage', {
        method: 'POST',
        json: payload,
      });

      setCreatedCreds((prev) => [res.created, ...prev]);
      setMsg(
        `Referral ID "${res.created.employeeCode}" (${res.created.referralCode}) created under Field Officer ${res.created.assignedFieldOfficerName} (${res.created.assignedFieldOfficerCode}).`
      );
      setForm((prev) => ({
        ...prev,
        fullName: '',
        mobile: '',
        employeeCode: '',
        password: generateReferralPassword(8),
        referralCode: '',
        serviceCity: '',
      }));
      await loadData();
    } catch (err: any) {
      setErrMsg(err.message || 'Could not create Referral ID');
    } finally {
      setSubmitting(false);
    }
  };

  const handleChangeFieldOfficer = async (referralId: number) => {
    if (!permissions.canChangeFieldOfficer || !selectedNewFoId) return;
    setMsg(null);
    setErrMsg(null);
    setBusyRowId(referralId);
    try {
      await apiFetch(`/referrals/manage/${referralId}/field-officer`, {
        method: 'PATCH',
        json: { assignedFieldOfficerId: Number(selectedNewFoId) },
      });
      setEditingFoId(null);
      setSelectedNewFoId('');
      setMsg('Field Officer updated for Referral ID.');
      await loadData();
    } catch (err: any) {
      setErrMsg(err.message || 'Could not change Field Officer');
    } finally {
      setBusyRowId(null);
    }
  };

  const handleRemoveReferral = async (referral: ManagedReferral) => {
    if (!permissions.canRemove) return;
    setMsg(null);
    setErrMsg(null);
    setBusyRowId(referral.id);
    try {
      await apiFetch(`/referrals/manage/${referral.id}`, {
        method: 'DELETE',
      });
      setConfirmRemoveId(null);
      setMsg(
        `Removed Referral ID ${referral.employeeCode} (${referral.fullName}). Slot freed under Field Officer ${referral.assignedFieldOfficerCode || ''}.`
      );
      await loadData();
    } catch (err: any) {
      setErrMsg(err.message || 'Could not remove Referral ID');
    } finally {
      setBusyRowId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            {isFieldOfficer
              ? lang === 'hi'
                ? 'रेफरल आईडी बनाएं (फील्ड ऑफिसर पैनल)'
                : 'Create Referral ID · Field Officer Panel'
              : lang === 'hi'
                ? 'रेफरल आईडी कंसोल (बैक ऑफिस / एडमिन)'
                : 'Referral ID Console · Back Office & Admin'}
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {isFieldOfficer
              ? `Create up to ${maxPerFo} Referral Partner IDs linked under your Field Officer ID (${user.employeeCode}). Only Back Office Team or Admin can remove or reassign Referral IDs.`
              : `Create Referral Partner IDs (max ${maxPerFo} per Field Officer), change assigned Field Officer, or remove Referral IDs.`}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreateForm((v) => !v)}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold shadow-xs whitespace-nowrap"
        >
          <UserPlus className="w-4 h-4" />
          {showCreateForm ? 'Hide Create Referral Panel' : 'Create Referral ID'}
        </button>
      </div>

      {errMsg && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-[#DC2626] flex items-center justify-between gap-2">
          <span>{errMsg}</span>
          <button type="button" onClick={() => setErrMsg(null)} className="text-[11px] font-bold underline">
            Dismiss
          </button>
        </div>
      )}

      {msg && (
        <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-xs font-medium text-[#15803D] flex items-center justify-between gap-2">
          <span>{msg}</span>
          <button type="button" onClick={() => setMsg(null)} className="text-[11px] font-bold underline">
            Dismiss
          </button>
        </div>
      )}

      {/* FO Capacity Summary */}
      {isFieldOfficer && selfFoQuota ? (
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-xs font-semibold text-slate-500">
              My Referral ID Quota ({selfFoQuota.employeeCode})
            </div>
            <div className="text-lg font-display font-bold text-[#0F2744] font-mono tabular-nums">
              {selfFoQuota.referralCount} / {maxPerFo} Referral IDs Active
            </div>
            <div className="text-[11px] text-slate-500">
              Remaining slots: <strong>{Math.max(0, maxPerFo - selfFoQuota.referralCount)}</strong>
            </div>
          </div>
          <div className="w-full sm:w-64">
            <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden border border-slate-200">
              <div
                className={`h-full transition-all ${
                  selfFoQuota.referralCount >= maxPerFo ? 'bg-[#DC2626]' : 'bg-[#15803D]'
                }`}
                style={{ width: `${Math.min(100, Math.round((selfFoQuota.referralCount / maxPerFo) * 100))}%` }}
              />
            </div>
            <div className="text-[10px] text-slate-500 mt-1 text-right font-mono">
              {Math.min(100, Math.round((selfFoQuota.referralCount / maxPerFo) * 100))}% used
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between">
            <div>
              <div className="text-xs text-slate-500 font-medium">Active Referral IDs</div>
              <div className="text-xl font-display font-bold text-[#0F2744] mt-0.5 tabular-nums">
                {referrals.length}
              </div>
              <div className="text-[11px] text-slate-500">Max {maxPerFo} per Field Officer</div>
            </div>
            <Users className="w-6 h-6 text-[#0F2744]/40" />
          </div>
          {fieldOfficers.slice(0, 3).map((fo) => (
            <div key={fo.id} className="bg-white border border-slate-200 rounded-xl p-4 space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-[#0F2744] truncate">{fo.fullName}</span>
                <span className="font-mono text-[11px] text-slate-500">{fo.employeeCode}</span>
              </div>
              <div
                className={`text-base font-display font-bold font-mono tabular-nums ${
                  fo.referralCount >= maxPerFo ? 'text-[#DC2626]' : 'text-[#15803D]'
                }`}
              >
                {fo.referralCount} / {maxPerFo} Referrals
              </div>
              <div className="text-[11px] text-slate-500 truncate">{fo.branchName || 'All Branches'}</div>
            </div>
          ))}
        </div>
      )}

      {/* Create Referral ID Form */}
      {showCreateForm && (
        <form onSubmit={handleCreateReferral} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-sm font-display font-bold text-[#0F2744] flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-[#EA580C]" />
                Create New Referral Partner ID
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {isFieldOfficer
                  ? `Automatically linked to your Field Officer ID (${user.fullName} · ${user.employeeCode}).`
                  : `Select the Field Officer (capacity limit: ${maxPerFo} Referrals per FO).`}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                Referral Partner Full Name *
              </label>
              <input
                type="text"
                required
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                placeholder="e.g. Suresh Gupta"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">Mobile Number</label>
              <input
                type="tel"
                value={form.mobile}
                onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                placeholder="10-digit mobile"
                className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
              />
            </div>

            {!isFieldOfficer ? (
              <div>
                <label className="block text-[11px] font-semibold text-[#0F2744] mb-1">
                  Assign Field Officer (max {maxPerFo}) *
                </label>
                <select
                  required
                  value={form.assignedFieldOfficerId}
                  onChange={(e) => setForm({ ...form, assignedFieldOfficerId: e.target.value })}
                  className="w-full px-3 py-2 text-xs border border-[#0F2744]/40 rounded-lg bg-white"
                >
                  <option value="">Select Field Officer...</option>
                  {fieldOfficers.map((fo) => {
                    const isFull = fo.referralCount >= maxPerFo;
                    return (
                      <option key={fo.id} value={fo.id} disabled={isFull}>
                        {fo.fullName} ({fo.employeeCode}) — {fo.referralCount}/{maxPerFo}
                        {fo.branchName ? ` · ${fo.branchName}` : ''}
                        {isFull ? ' [FULL]' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
            ) : (
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">Assigned Field Officer</label>
                <div className="px-3 py-2 text-xs font-semibold text-[#0F2744] bg-slate-50 border border-slate-200 rounded-lg">
                  {user.fullName} ({user.employeeCode})
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-semibold text-slate-700">Login ID (Optional Auto)</label>
                <span className="text-[10px] text-slate-400 inline-flex items-center gap-0.5">
                  <Sparkles className="w-3 h-3 text-[#EA580C]" />
                  Auto DSA###
                </span>
              </div>
              <input
                type="text"
                value={form.employeeCode}
                onChange={(e) => setForm({ ...form, employeeCode: e.target.value.toUpperCase() })}
                placeholder="Leave blank for Auto ID"
                className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-semibold text-slate-700">Login Password *</label>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, password: generateReferralPassword(8) })}
                  className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#0F2744] hover:underline"
                >
                  <KeyRound className="w-3 h-3" />
                  New Pass
                </button>
              </div>
              <input
                type="text"
                required
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">City / Area (Optional)</label>
              <input
                type="text"
                value={form.serviceCity}
                onChange={(e) => setForm({ ...form, serviceCity: e.target.value })}
                placeholder="e.g. Mumbai"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="submit"
              disabled={submitting || (isFieldOfficer && (selfFoQuota?.referralCount ?? 0) >= maxPerFo)}
              className="px-5 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
            >
              {submitting ? 'Creating Referral ID...' : 'Create Referral ID'}
            </button>
          </div>
        </form>
      )}

      {/* Newly Created Credentials Card */}
      {createdCreds.length > 0 && (
        <div className="bg-white border border-green-200 rounded-xl p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-bold text-[#15803D]">
              Created Referral Login Credentials ({createdCreds.length})
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={downloadCredsCsv}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 text-[11px] font-semibold text-[#0F2744] hover:bg-slate-50"
              >
                <Download className="w-3 h-3" />
                Download CSV
              </button>
              <button
                type="button"
                onClick={() => setCreatedCreds([])}
                className="text-[11px] font-semibold text-slate-500 hover:text-slate-800"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg bg-slate-50">
            {createdCreds.map((c, idx) => (
              <div key={`${c.employeeCode}-${idx}`} className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono font-bold text-[#0F2744]">ID: {c.employeeCode}</span>
                  <span className="font-mono font-semibold text-[#EA580C]">Pass: {c.password}</span>
                  <span className="font-medium text-slate-800">{c.fullName}</span>
                  <span className="font-mono text-[11px] text-slate-500">{c.referralCode}</span>
                  <span className="text-[11px] text-slate-600">
                    FO: {c.assignedFieldOfficerName} ({c.assignedFieldOfficerCode})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    copyText(
                      `Referral Login ID: ${c.employeeCode}\nPassword: ${c.password}\nReferral Code: ${c.referralCode}`,
                      c.employeeCode
                    )
                  }
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white border border-slate-300 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                >
                  {copiedKey === c.employeeCode ? <Check className="w-3 h-3 text-[#15803D]" /> : <Copy className="w-3 h-3" />}
                  {copiedKey === c.employeeCode ? 'Copied' : 'Copy'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Referral IDs Directory */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search Referral Name, ID, Code, Mobile, or FO..."
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            />
          </div>
          {!isFieldOfficer && (
            <select
              value={filterFoId}
              onChange={(e) => setFilterFoId(e.target.value)}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white text-slate-700"
            >
              <option value="ALL">All Field Officers ({referrals.length})</option>
              {fieldOfficers.map((fo) => (
                <option key={fo.id} value={fo.id}>
                  {fo.fullName} ({fo.employeeCode}) · {fo.referralCount}/{maxPerFo}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Login ID &amp; Ref Code</th>
                <th className="text-left px-4 py-3 font-semibold">Partner Name &amp; Mobile</th>
                <th className="text-left px-4 py-3 font-semibold">Assigned Field Officer</th>
                <th className="text-left px-4 py-3 font-semibold">Branch / City</th>
                <th className="text-left px-4 py-3 font-semibold">Created</th>
                {(permissions.canChangeFieldOfficer || permissions.canRemove) && (
                  <th className="text-right px-4 py-3 font-semibold">Back Office / Admin Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-xs text-slate-500">
                    Loading Referral IDs...
                  </td>
                </tr>
              )}
              {!loading &&
                filteredReferrals.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-mono font-bold text-[#0F2744]">{r.employeeCode}</div>
                      <div className="font-mono text-[11px] text-[#EA580C]">{r.referralCode}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{r.fullName}</div>
                      <div className="font-mono text-[11px] text-slate-500">{r.mobile || 'No mobile'}</div>
                    </td>
                    <td className="px-4 py-3">
                      {r.assignedFieldOfficerName ? (
                        <div>
                          <div className="font-semibold text-[#0F2744]">{r.assignedFieldOfficerName}</div>
                          <div className="font-mono text-[11px] text-slate-500">{r.assignedFieldOfficerCode}</div>
                        </div>
                      ) : (
                        <span className="text-amber-700 font-semibold">Unassigned</span>
                      )}

                      {permissions.canChangeFieldOfficer && editingFoId === r.id && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <select
                            value={selectedNewFoId}
                            onChange={(e) => setSelectedNewFoId(e.target.value)}
                            className="px-2 py-1 text-[11px] border border-slate-300 rounded bg-white"
                          >
                            <option value="">Select Field Officer...</option>
                            {fieldOfficers.map((fo) => {
                              const isCurrent = fo.id === r.assignedFieldOfficerId;
                              const isFull = !isCurrent && fo.referralCount >= maxPerFo;
                              return (
                                <option key={fo.id} value={fo.id} disabled={isFull}>
                                  {fo.fullName} ({fo.employeeCode}) — {fo.referralCount}/{maxPerFo}
                                  {isFull ? ' [FULL]' : ''}
                                </option>
                              );
                            })}
                          </select>
                          <button
                            type="button"
                            disabled={!selectedNewFoId || busyRowId === r.id}
                            onClick={() => handleChangeFieldOfficer(r.id)}
                            className="px-2.5 py-1 rounded bg-[#15803D] text-white text-[11px] font-semibold disabled:opacity-50"
                          >
                            Save FO
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingFoId(null);
                              setSelectedNewFoId('');
                            }}
                            className="px-2 py-1 rounded border border-slate-300 text-[11px] text-slate-600"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      <div>{r.branchName || '—'}</div>
                      {r.serviceCity && <div className="text-[11px] text-slate-500">{r.serviceCity}</div>}
                    </td>
                    <td className="px-4 py-3 text-[11px] text-slate-500 whitespace-nowrap">
                      {formatDateTime(r.createdAt)}
                    </td>
                    {(permissions.canChangeFieldOfficer || permissions.canRemove) && (
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {permissions.canChangeFieldOfficer && (
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmRemoveId(null);
                                setEditingFoId(r.id);
                                setSelectedNewFoId(r.assignedFieldOfficerId ? String(r.assignedFieldOfficerId) : '');
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 text-[11px] font-semibold text-[#0F2744]"
                            >
                              <UserCheck className="w-3 h-3 text-[#EA580C]" />
                              Change Field Officer
                            </button>
                          )}
                          {permissions.canRemove && (
                            confirmRemoveId === r.id ? (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={busyRowId === r.id}
                                  onClick={() => handleRemoveReferral(r)}
                                  className="px-2.5 py-1 rounded bg-[#DC2626] text-white text-[11px] font-semibold disabled:opacity-50"
                                >
                                  Confirm Remove
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmRemoveId(null)}
                                  className="px-2 py-1 rounded border border-slate-300 text-[11px] text-slate-600"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingFoId(null);
                                  setConfirmRemoveId(r.id);
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-red-200 bg-red-50 hover:bg-[#DC2626] hover:text-white text-[11px] font-semibold text-[#DC2626] transition-colors"
                              >
                                <Trash2 className="w-3 h-3" />
                                Remove
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              {!loading && filteredReferrals.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-xs text-slate-500">
                    No active Referral IDs found.
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
