import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload,
  UserPlus,
  Trash2,
  RotateCcw,
  Package,
  Download,
  Power,
  KeyRound,
  Copy,
  Check,
  Eye,
  EyeOff,
  Sparkles,
  Search,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  HIERARCHY_LIMITS,
  USER_ROLES,
  type AuthUser,
  type SystemSettings,
  type UserRole,
} from '../../shared/types';
import { apiFetch, formatDateTime, getStoredToken } from '../lib/api';

interface AdminSettingsProps {
  user: AuthUser;
  settings: SystemSettings;
  activeOption?: 'users' | 'rules' | 'org' | 'audit' | 'docs' | null;
  onSelectOption?: (opt: 'users' | 'rules' | 'org' | 'audit' | 'docs') => void;
  onSettingsUpdated: (next: SystemSettings) => void;
}

const ROLE_CODE_PREFIX: Record<UserRole, string> = {
  SUPER_ADMIN: 'ADM',
  BRANCH_MANAGER: 'BM',
  TEAM_LEADER: 'TL',
  LEAD_GENERATOR: 'BO',
  FIELD_OFFICER: 'FO',
  REFERRAL_PARTNER: 'DSA',
};

const ROLE_NAME_PREFIX: Record<UserRole, string> = {
  SUPER_ADMIN: 'Admin',
  BRANCH_MANAGER: 'Branch Manager',
  TEAM_LEADER: 'Team Leader',
  LEAD_GENERATOR: 'Back Office Staff',
  FIELD_OFFICER: 'Field Officer',
  REFERRAL_PARTNER: 'Referral Partner',
};

function generateClientPassword(length = 8): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export const AdminSettingsModule: React.FC<AdminSettingsProps> = ({
  user,
  settings,
  activeOption,
  onSelectOption,
  onSettingsUpdated,
}) => {
  const [subTab, setSubTab] = useState<'users' | 'rules' | 'org' | 'audit' | 'docs'>(
    activeOption && ['users', 'rules', 'org', 'audit', 'docs'].includes(activeOption) ? activeOption : 'users'
  );

  useEffect(() => {
    if (activeOption && ['users', 'rules', 'org', 'audit', 'docs'].includes(activeOption)) {
      setSubTab(activeOption);
    } else if (activeOption === null) {
      setSubTab('users');
    }
  }, [activeOption]);

  const [users, setUsers] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Admin Console Employee ID & Password Studio
  const [showCreatePanel, setShowCreatePanel] = useState(true);
  const [createMode, setCreateMode] = useState<'single' | 'bulk'>('single');
  const [keepCreatingMore, setKeepCreatingMore] = useState(true);
  const [showPassword, setShowPassword] = useState(true);
  const [creatingUsers, setCreatingUsers] = useState(false);
  const employeeCodeInputRef = useRef<HTMLInputElement | null>(null);

  const [newUser, setNewUser] = useState({
    employeeCode: '',
    fullName: '',
    mobile: '',
    email: '',
    password: '',
    role: 'FIELD_OFFICER' as UserRole,
    branchId: '1',
    teamId: '',
    reportsToUserId: '',
    referralCode: '',
    serviceCity: '',
    servicePincodes: '',
    otpEnabled: false,
  });

  const [bulkForm, setBulkForm] = useState({
    prefix: 'FO',
    count: 5,
    role: 'FIELD_OFFICER' as UserRole,
    branchId: '1',
    reportsToUserId: '',
    namePrefix: 'Field Officer',
    passwordMode: 'random' as 'random' | 'custom',
    commonPassword: '',
  });

  const [generatedCredentials, setGeneratedCredentials] = useState<
    { employeeCode: string; password: string; fullName: string; role: string }[]
  >([]);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Search, filter, and password reset on Login ID directory
  const [userSearch, setUserSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ON' | 'OFF'>('ALL');
  const [resetPasswordUserId, setResetPasswordUserId] = useState<number | null>(null);
  const [resetPasswordDraft, setResetPasswordDraft] = useState('');
  const [togglingUserId, setTogglingUserId] = useState<number | null>(null);

  const [editingTerritoryId, setEditingTerritoryId] = useState<number | null>(null);
  const [territoryDraft, setTerritoryDraft] = useState({ serviceCity: '', servicePincodes: '' });

  // Rules state
  const [rules, setRules] = useState<SystemSettings>(settings);

  // Org forms
  const [newBranch, setNewBranch] = useState({ code: '', name: '', city: '', state: '' });
  const [newTeam, setNewTeam] = useState({ branchId: '1', name: '' });

  const isSuperAdmin = user.role === 'SUPER_ADMIN';

  const getParentCandidatesForRole = (role: UserRole, userList: any[]) => {
    if (role === 'TEAM_LEADER') {
      return userList.filter((u) => u.isActive && u.role === 'BRANCH_MANAGER');
    }
    if (role === 'FIELD_OFFICER') {
      return userList.filter((u) => u.isActive && u.role === 'TEAM_LEADER');
    }
    if (role === 'REFERRAL_PARTNER') {
      return userList.filter((u) => u.isActive && u.role === 'FIELD_OFFICER');
    }
    return [];
  };

  const getParentQuotaLabel = (role: UserRole): { title: string; max: number; unit: string } | null => {
    if (role === 'TEAM_LEADER') {
      return {
        title: 'Reporting Branch Manager (BM · max 10 TLs)',
        max: HIERARCHY_LIMITS.TEAM_LEADERS_PER_BM,
        unit: 'TLs',
      };
    }
    if (role === 'FIELD_OFFICER') {
      return {
        title: 'Reporting Team Leader (TL · max 10 FOs)',
        max: HIERARCHY_LIMITS.FIELD_OFFICERS_PER_TL,
        unit: 'FOs',
      };
    }
    if (role === 'REFERRAL_PARTNER') {
      return {
        title: 'Assigned Field Officer (FO · max 50 Referrals)',
        max: HIERARCHY_LIMITS.REFERRALS_PER_FO,
        unit: 'Refs',
      };
    }
    return null;
  };

  const pickDefaultParentId = (role: UserRole, userList: any[]): string => {
    const candidates = getParentCandidatesForRole(role, userList);
    const meta = getParentQuotaLabel(role);
    if (!meta || candidates.length === 0) return '';
    const available = candidates.find((p) => Number(p.childCount || 0) < meta.max) || candidates[0];
    return available ? String(available.id) : '';
  };

  const suggestNextEmployeeCode = (role: UserRole, currentUsers: any[], customPrefix?: string): string => {
    const prefix = (customPrefix || ROLE_CODE_PREFIX[role] || 'EMP').toUpperCase();
    let maxNum = 0;
    const regex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`, 'i');
    for (const u of currentUsers) {
      const m = String(u.employeeCode || '').match(regex);
      if (m && m[1]) {
        const n = Number.parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    }
    return `${prefix}${String(maxNum + 1).padStart(3, '0')}`;
  };

  const loadAll = async () => {
    const [uRes, dRes, aRes] = await Promise.all([
      apiFetch<{ users: any[] }>('/admin/users'),
      apiFetch<any>('/directory'),
      apiFetch<{ logs: any[] }>('/admin/audit-logs'),
    ]);
    setUsers(uRes.users);
    setBranches(dRes.branches || []);
    setTeams(dRes.teams || []);
    setAuditLogs(aRes.logs);
    setNewUser((prev) => ({
      ...prev,
      reportsToUserId: prev.reportsToUserId || pickDefaultParentId(prev.role, uRes.users),
    }));
    setBulkForm((prev) => ({
      ...prev,
      reportsToUserId: prev.reportsToUserId || pickDefaultParentId(prev.role, uRes.users),
    }));
    return uRes.users;
  };

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    setRules(settings);
  }, [settings]);

  const applyRolePreset = (targetRole: UserRole, mode: 'single' | 'bulk' = createMode) => {
    setSubTab('users');
    onSelectOption?.('users');
    setShowCreatePanel(true);
    setCreateMode(mode);
    setErrorMsg(null);
    const defaultParentId = pickDefaultParentId(targetRole, users);
    const parentObj = users.find((u) => String(u.id) === defaultParentId);

    if (mode === 'single') {
      setNewUser((prev) => ({
        ...prev,
        role: targetRole,
        employeeCode: suggestNextEmployeeCode(targetRole, users),
        password: prev.password || generateClientPassword(8),
        reportsToUserId: defaultParentId,
        branchId: parentObj?.branchId ? String(parentObj.branchId) : prev.branchId,
      }));
      window.requestAnimationFrame(() => employeeCodeInputRef.current?.focus());
    } else {
      setBulkForm((prev) => ({
        ...prev,
        role: targetRole,
        prefix: ROLE_CODE_PREFIX[targetRole] || 'EMP',
        namePrefix: ROLE_NAME_PREFIX[targetRole] || 'Staff',
        reportsToUserId: defaultParentId,
        branchId: parentObj?.branchId ? String(parentObj.branchId) : prev.branchId,
      }));
    }
  };

  const openUnlimitedCreator = () => {
    setSubTab('users');
    onSelectOption?.('users');
    setShowCreatePanel(true);
    setErrorMsg(null);
    if (!newUser.employeeCode) {
      setNewUser((prev) => ({
        ...prev,
        employeeCode: suggestNextEmployeeCode(prev.role, users),
        password: prev.password || generateClientPassword(8),
        reportsToUserId: prev.reportsToUserId || pickDefaultParentId(prev.role, users),
      }));
    }
    window.requestAnimationFrame(() => employeeCodeInputRef.current?.focus());
  };

  const handleCopyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCode(label);
      window.setTimeout(() => setCopiedCode((prev) => (prev === label ? null : prev)), 2000);
    } catch {
      // clipboard fallback ignored
    }
  };

  const handleDownloadCredentialsCsv = () => {
    if (generatedCredentials.length === 0) return;
    const rows = [
      ['Employee ID', 'Password', 'Staff Name', 'Role'],
      ...generatedCredentials.map((c) => [c.employeeCode, c.password, c.fullName, c.role]),
    ];
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ambika-employee-ids-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErrorMsg(null);
    const submittedCode = newUser.employeeCode.trim().replace(/\s+/g, '').toUpperCase();
    const submittedPass = newUser.password.trim();
    const submittedName = newUser.fullName.trim() || submittedCode;
    const submittedRole = newUser.role;

    if (!submittedCode || !submittedPass) {
      setErrorMsg('Employee Login ID and Password are required (spaces only are not allowed).');
      return;
    }

    setCreatingUsers(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        created?: { employeeCode: string; password?: string; fullName: string; role: string };
      }>('/admin/users', {
        method: 'POST',
        json: {
          ...newUser,
          employeeCode: submittedCode,
          password: submittedPass,
          fullName: submittedName,
          reportsToUserId: newUser.reportsToUserId ? Number(newUser.reportsToUserId) : null,
        },
      });
      const finalCode = res.created?.employeeCode || submittedCode;
      const finalPass = res.created?.password || submittedPass;
      const freshUsers = await loadAll();
      setGeneratedCredentials((prev) => [
        {
          employeeCode: finalCode,
          password: finalPass,
          fullName: submittedName,
          role: submittedRole,
        },
        ...prev,
      ]);
      setNewUser((prev) => ({
        ...prev,
        employeeCode: keepCreatingMore ? suggestNextEmployeeCode(prev.role, freshUsers) : '',
        fullName: '',
        mobile: '',
        email: '',
        password: keepCreatingMore ? generateClientPassword(8) : '',
        reportsToUserId: pickDefaultParentId(prev.role, freshUsers),
        referralCode: '',
      }));
      setMsg(`Employee Login ID "${finalCode}" created (Status: ON). Ready to sign in with password "${finalPass}".`);
      if (!keepCreatingMore) {
        setShowCreatePanel(false);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not create Employee ID & Password');
    } finally {
      setCreatingUsers(false);
    }
  };

  const handleBulkCreateUsers = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErrorMsg(null);
    setCreatingUsers(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        count: number;
        created: { employeeCode: string; password: string; fullName: string; role: string }[];
      }>('/admin/users/bulk', {
        method: 'POST',
        json: {
          ...bulkForm,
          reportsToUserId: bulkForm.reportsToUserId ? Number(bulkForm.reportsToUserId) : null,
        },
      });
      setGeneratedCredentials((prev) => [...res.created, ...prev]);
      setMsg(
        `Generated ${res.count} Employee Login ID${res.count > 1 ? 's' : ''} & Password${res.count > 1 ? 's' : ''} successfully.`
      );
      await loadAll();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not generate batch Employee IDs');
    } finally {
      setCreatingUsers(false);
    }
  };

  const saveUserTerritory = async (userId: number) => {
    setMsg(null);
    setErrorMsg(null);
    try {
      await apiFetch(`/admin/users/${userId}`, {
        method: 'PATCH',
        json: territoryDraft,
      });
      setEditingTerritoryId(null);
      setMsg('Officer geographical territory updated.');
      await loadAll();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not update territory');
    }
  };

  const toggleUserActive = async (target: any) => {
    if (!isSuperAdmin) return;
    setMsg(null);
    setErrorMsg(null);
    setTogglingUserId(target.id);
    const nextActive = !target.isActive;
    try {
      await apiFetch(`/admin/users/${target.id}`, {
        method: 'PATCH',
        json: { isActive: nextActive },
      });
      setMsg(
        nextActive
          ? `Login ID ${target.employeeCode} (${target.fullName}) turned ON — user can sign in.`
          : `Login ID ${target.employeeCode} (${target.fullName}) turned OFF — user logged out & blocked.`
      );
      await loadAll();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not update Login ID status');
    } finally {
      setTogglingUserId(null);
    }
  };

  const handleResetPassword = async (target: any) => {
    if (!isSuperAdmin) return;
    const cleanPass = resetPasswordDraft.trim();
    if (!cleanPass) {
      setErrorMsg('Please enter a new password.');
      return;
    }
    setMsg(null);
    setErrorMsg(null);
    try {
      await apiFetch(`/admin/users/${target.id}`, {
        method: 'PATCH',
        json: { newPassword: cleanPass },
      });
      setGeneratedCredentials((prev) => [
        {
          employeeCode: target.employeeCode,
          password: cleanPass,
          fullName: target.fullName,
          role: target.role,
        },
        ...prev,
      ]);
      setResetPasswordUserId(null);
      setResetPasswordDraft('');
      setMsg(`Password updated for Employee ID ${target.employeeCode}.`);
      await loadAll();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not reset password');
    }
  };

  const toggleUserOtp = async (target: any) => {
    if (!isSuperAdmin) return;
    setMsg(null);
    setErrorMsg(null);
    try {
      await apiFetch(`/admin/users/${target.id}`, {
        method: 'PATCH',
        json: { otpEnabled: !target.otpEnabled },
      });
      await loadAll();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not update OTP requirement');
    }
  };

  const activeLoginCount = useMemo(() => users.filter((u) => u.isActive).length, [users]);
  const offLoginCount = useMemo(() => users.filter((u) => !u.isActive).length, [users]);
  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter === 'ON' && !u.isActive) return false;
      if (statusFilter === 'OFF' && u.isActive) return false;
      if (!q) return true;
      return (
        String(u.employeeCode || '').toLowerCase().includes(q) ||
        String(u.fullName || '').toLowerCase().includes(q) ||
        String(u.mobile || '').toLowerCase().includes(q) ||
        String(u.role || '').toLowerCase().includes(q)
      );
    });
  }, [users, userSearch, statusFilter]);

  const saveRules = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const res = await apiFetch<{ settings: SystemSettings }>('/admin/settings', {
        method: 'PATCH',
        json: rules,
      });
      onSettingsUpdated(res.settings);
      setMsg(
        `Configuration saved & synced live (v${res.settings.configVersion ?? 1}) to all connected BM, Team Leader, Back Office & Field Officer apps.`
      );
    } catch (err: any) {
      setMsg(`Error: ${err.message || 'Could not save settings'}`);
    }
  };

  const handleLogoUpload = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const res = await apiFetch<{ settings: SystemSettings }>('/admin/settings', {
        method: 'PATCH',
        json: { companyLogoDataUrl: dataUrl },
      });
      onSettingsUpdated(res.settings);
      setMsg('Official AMBIKA ASSOCIATE logo updated.');
    };
    reader.readAsDataURL(file);
  };

  const handleApkUpload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.apk')) {
      setMsg('Error: Please select a valid .apk Android installer file.');
      return;
    }
    try {
      const token = getStoredToken();
      const resp = await fetch('/api/admin/upload-apk', {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/vnd.android.package-archive',
        },
        body: file,
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.error || 'APK upload failed');
      }
      onSettingsUpdated(data.settings);
      setMsg(`Hosted Android APK uploaded (${file.name}). Download APK buttons now serve this binary directly.`);
    } catch (err: any) {
      setMsg(`Error: ${err.message || 'APK upload failed'}`);
    }
  };

  const handleRemoveUploadedApk = async () => {
    try {
      const res = await apiFetch<{ ok: boolean; settings: SystemSettings }>('/admin/upload-apk', {
        method: 'DELETE',
      });
      onSettingsUpdated(res.settings);
      setMsg('Removed hosted APK file.');
    } catch (err: any) {
      setMsg(`Error: ${err.message || 'Could not remove APK'}`);
    }
  };

  const createBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/admin/branches', { method: 'POST', json: newBranch });
    setNewBranch({ code: '', name: '', city: '', state: '' });
    setMsg('Branch added.');
    await loadAll();
  };

  const createTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/admin/teams', { method: 'POST', json: newTeam });
    setNewTeam({ branchId: '1', name: '' });
    setMsg('Team created.');
    await loadAll();
  };

  const wipeTestData = async () => {
    await apiFetch('/admin/reset-test-data', { method: 'POST' });
    setMsg('All verification leads, enquiries, penalties, GPS logs, and alerts cleared for production.');
    await loadAll();
  };

  const reloadTestData = async () => {
    await apiFetch('/admin/seed-test-data', { method: 'POST' });
    setMsg('Verification dataset loaded.');
    await loadAll();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            Admin Console · Login ID Control, Users &amp; System Settings
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Create unlimited Employee IDs &amp; Passwords, turn Login IDs ON/OFF (Admin only), and configure SLA rules &amp; branding.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isSuperAdmin && (
            <>
              <button
                type="button"
                onClick={() => applyRolePreset('LEAD_GENERATOR', 'single')}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold shadow-xs whitespace-nowrap"
              >
                <UserPlus className="w-3.5 h-3.5 text-[#EA580C]" />
                Generate Back Office ID
              </button>
              <button
                type="button"
                onClick={openUnlimitedCreator}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold shadow-xs whitespace-nowrap"
              >
                <UserPlus className="w-3.5 h-3.5" />
                Create Unlimited Employee ID &amp; Password
              </button>
            </>
          )}

          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
            {[
              { id: 'users', label: 'Login IDs & Passwords' },
              { id: 'rules', label: 'Rules & Branding' },
              { id: 'org', label: 'Branches & Teams' },
              { id: 'audit', label: 'Audit Logs' },
              { id: 'docs', label: 'Schema, API & Guides' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setSubTab(t.id as any);
                  onSelectOption?.(t.id as any);
                }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  subTab === t.id ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-[#DC2626] flex items-center justify-between gap-2">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="text-[11px] font-bold underline">
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

      {subTab === 'users' && (
        <div className="space-y-5">
          {/* Login ID Access Control KPI Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between">
              <div>
                <div className="text-xs text-slate-500 font-medium">Total Employee Login IDs</div>
                <div className="text-xl font-display font-bold text-[#0F2744] mt-0.5 tabular-nums">
                  {users.length}
                </div>
                <div className="text-[11px] text-slate-500">Unlimited creation allowed</div>
              </div>
              <Users className="w-6 h-6 text-[#0F2744]/40" />
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between">
              <div>
                <div className="text-xs text-slate-500 font-medium">Login IDs ON (Active)</div>
                <div className="text-xl font-display font-bold text-[#15803D] mt-0.5 tabular-nums">
                  {activeLoginCount}
                </div>
                <div className="text-[11px] text-slate-500">Can sign in normally</div>
              </div>
              <ShieldCheck className="w-6 h-6 text-[#15803D]/50" />
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between">
              <div>
                <div className="text-xs text-slate-500 font-medium">Login IDs OFF (Blocked)</div>
                <div className="text-xl font-display font-bold text-[#DC2626] mt-0.5 tabular-nums">
                  {offLoginCount}
                </div>
                <div className="text-[11px] text-slate-500">Only Super Admin can toggle ON/OFF</div>
              </div>
              <Power className="w-6 h-6 text-[#DC2626]/50" />
            </div>
          </div>

          {!isSuperAdmin && (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
              <strong>Read-Only View:</strong> Only <strong>Super Admin</strong> can create Employee IDs &amp; Passwords or turn any Login ID ON/OFF.
            </div>
          )}

          {isSuperAdmin && showCreatePanel && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <div>
                  <h2 className="text-sm font-display font-bold text-[#0F2744] flex items-center gap-2">
                    <UserPlus className="w-4 h-4 text-[#EA580C]" />
                    ID Create Console · Hierarchy &amp; Back Office ID Generation
                  </h2>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Hierarchy Cap: <strong>1 Branch BM → max {HIERARCHY_LIMITS.TEAM_LEADERS_PER_BM} Team Leaders</strong> ·{' '}
                    <strong>1 TL → max {HIERARCHY_LIMITS.FIELD_OFFICERS_PER_TL} Field Officers</strong> ·{' '}
                    <strong>1 FO → max {HIERARCHY_LIMITS.REFERRALS_PER_FO} Referral IDs</strong>. Back Office &amp; Admin IDs: Unlimited.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex p-0.5 bg-slate-100 rounded-lg border border-slate-200">
                    <button
                      type="button"
                      onClick={() => setCreateMode('single')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md ${
                        createMode === 'single' ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      Single ID &amp; Password
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreateMode('bulk')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md ${
                        createMode === 'bulk' ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      Bulk Generate Unlimited IDs
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowCreatePanel(false)}
                    className="px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 hover:text-slate-800"
                  >
                    Hide
                  </button>
                </div>
              </div>

              {/* Quick Role Presets incl. Back Office ID Generation */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-slate-500 mr-1">Quick Role Preset:</span>
                {(
                  [
                    { role: 'LEAD_GENERATOR', label: '+ Back Office ID (Unlimited)' },
                    { role: 'BRANCH_MANAGER', label: '+ Branch BM ID' },
                    { role: 'TEAM_LEADER', label: '+ Team Leader ID (max 10/BM)' },
                    { role: 'FIELD_OFFICER', label: '+ Field Officer ID (max 10/TL)' },
                    { role: 'REFERRAL_PARTNER', label: '+ Referral ID (max 50/FO)' },
                  ] as const
                ).map((preset) => {
                  const activeRole = createMode === 'single' ? newUser.role : bulkForm.role;
                  const isActivePreset = activeRole === preset.role;
                  return (
                    <button
                      key={preset.role}
                      type="button"
                      onClick={() => applyRolePreset(preset.role, createMode)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors ${
                        isActivePreset
                          ? 'bg-[#0F2744] text-white border-[#0F2744]'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>

              {createMode === 'single' ? (
                <form onSubmit={handleCreateUser} className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[11px] font-semibold text-slate-700">Employee Login ID *</label>
                        <button
                          type="button"
                          onClick={() =>
                            setNewUser((prev) => ({
                              ...prev,
                              employeeCode: suggestNextEmployeeCode(prev.role, users),
                            }))
                          }
                          className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#EA580C] hover:underline"
                        >
                          <Sparkles className="w-3 h-3" />
                          Auto ID
                        </button>
                      </div>
                      <input
                        ref={employeeCodeInputRef}
                        type="text"
                        required
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        value={newUser.employeeCode}
                        onChange={(e) =>
                          setNewUser({
                            ...newUser,
                            employeeCode: e.target.value.replace(/\s+/g, '').toUpperCase(),
                          })
                        }
                        placeholder="e.g. FO004 or TLPALAKGUPTA"
                        className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[11px] font-semibold text-slate-700">Login Password *</label>
                        <button
                          type="button"
                          onClick={() =>
                            setNewUser((prev) => ({ ...prev, password: generateClientPassword(8) }))
                          }
                          className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#0F2744] hover:underline"
                        >
                          <KeyRound className="w-3 h-3" />
                          Generate
                        </button>
                      </div>
                      <div className="relative">
                        <input
                          type={showPassword ? 'text' : 'password'}
                          required
                          autoCapitalize="none"
                          autoCorrect="off"
                          autoComplete="new-password"
                          spellCheck={false}
                          value={newUser.password}
                          onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                          placeholder="Create password (no spaces)"
                          className="w-full px-3 py-2 pr-8 text-xs font-mono border border-slate-300 rounded-lg"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                        >
                          {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">Employee Name *</label>
                      <input
                        type="text"
                        required
                        value={newUser.fullName}
                        onChange={(e) => setNewUser({ ...newUser, fullName: e.target.value })}
                        placeholder="Full Name"
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">Role *</label>
                      <select
                        value={newUser.role}
                        onChange={(e) => {
                          const nextRole = e.target.value as UserRole;
                          const nextParentId = pickDefaultParentId(nextRole, users);
                          const parentObj = users.find((u) => String(u.id) === nextParentId);
                          setNewUser((prev) => ({
                            ...prev,
                            role: nextRole,
                            reportsToUserId: nextParentId,
                            branchId: parentObj?.branchId ? String(parentObj.branchId) : prev.branchId,
                            employeeCode:
                              !prev.employeeCode ||
                              Object.values(ROLE_CODE_PREFIX).some((p) =>
                                new RegExp(`^${p}\\d+$`, 'i').test(prev.employeeCode)
                              ) ||
                              /^LG\d+$/i.test(prev.employeeCode)
                                ? suggestNextEmployeeCode(nextRole, users)
                                : prev.employeeCode,
                          }));
                        }}
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        {USER_ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.labelEn}
                          </option>
                        ))}
                      </select>
                    </div>

                    {(() => {
                      const quotaMeta = getParentQuotaLabel(newUser.role);
                      if (!quotaMeta) return null;
                      const candidates = getParentCandidatesForRole(newUser.role, users);
                      return (
                        <div className="sm:col-span-2">
                          <label className="block text-[11px] font-semibold text-[#0F2744] mb-1">
                            {quotaMeta.title} *
                          </label>
                          <select
                            required
                            value={newUser.reportsToUserId}
                            onChange={(e) => {
                              const parentObj = candidates.find((p) => String(p.id) === e.target.value);
                              setNewUser((prev) => ({
                                ...prev,
                                reportsToUserId: e.target.value,
                                branchId: parentObj?.branchId ? String(parentObj.branchId) : prev.branchId,
                              }));
                            }}
                            className="w-full px-3 py-2 text-xs border border-[#0F2744]/40 rounded-lg bg-white"
                          >
                            <option value="">Select Reporting Parent...</option>
                            {candidates.map((p) => {
                              const used = Number(p.childCount || 0);
                              const isFull = used >= quotaMeta.max;
                              return (
                                <option key={p.id} value={p.id} disabled={isFull}>
                                  {p.fullName} ({p.employeeCode}) — {used}/{quotaMeta.max} {quotaMeta.unit}
                                  {p.branchName ? ` · ${p.branchName}` : ''}
                                  {isFull ? ' [FULL]' : ''}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                      );
                    })()}

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Mobile Number (Optional)
                      </label>
                      <input
                        type="tel"
                        value={newUser.mobile}
                        onChange={(e) => setNewUser({ ...newUser, mobile: e.target.value })}
                        placeholder="Optional mobile"
                        className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">Branch</label>
                      <select
                        value={newUser.branchId}
                        onChange={(e) => setNewUser({ ...newUser, branchId: e.target.value })}
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        {branches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Referral Code (if DSA)
                      </label>
                      <input
                        type="text"
                        value={newUser.referralCode}
                        onChange={(e) => setNewUser({ ...newUser, referralCode: e.target.value.toUpperCase() })}
                        placeholder="Optional DSA code"
                        className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Service City
                      </label>
                      <input
                        type="text"
                        value={newUser.serviceCity}
                        onChange={(e) => setNewUser({ ...newUser, serviceCity: e.target.value })}
                        placeholder="e.g. Mumbai"
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Service PINs / Areas (Optional)
                      </label>
                      <input
                        type="text"
                        value={newUser.servicePincodes}
                        onChange={(e) => setNewUser({ ...newUser, servicePincodes: e.target.value })}
                        placeholder="e.g. 400053, Andheri"
                        className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                      />
                    </div>

                    <div className="sm:col-span-2 flex flex-wrap items-end justify-between gap-3">
                      <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer pb-2">
                        <input
                          type="checkbox"
                          checked={keepCreatingMore}
                          onChange={(e) => setKeepCreatingMore(e.target.checked)}
                          className="rounded border-slate-300 accent-[#0F2744]"
                        />
                        Keep open &amp; auto-ready next ID
                      </label>
                      <button
                        type="submit"
                        disabled={creatingUsers}
                        className="px-5 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
                      >
                        {creatingUsers ? 'Creating...' : 'Create Employee ID & Password'}
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <form onSubmit={handleBulkCreateUsers} className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Employee ID Prefix *
                      </label>
                      <input
                        type="text"
                        required
                        value={bulkForm.prefix}
                        onChange={(e) =>
                          setBulkForm({ ...bulkForm, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })
                        }
                        placeholder="e.g. FO, LG, EMP"
                        className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Number of IDs to Create (Unlimited) *
                      </label>
                      <input
                        type="number"
                        required
                        min={1}
                        value={bulkForm.count}
                        onChange={(e) =>
                          setBulkForm({ ...bulkForm, count: Math.max(1, Number(e.target.value) || 1) })
                        }
                        className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">Role *</label>
                      <select
                        value={bulkForm.role}
                        onChange={(e) => {
                          const nextRole = e.target.value as UserRole;
                          const nextParentId = pickDefaultParentId(nextRole, users);
                          const parentObj = users.find((u) => String(u.id) === nextParentId);
                          setBulkForm({
                            ...bulkForm,
                            role: nextRole,
                            prefix: ROLE_CODE_PREFIX[nextRole] || 'EMP',
                            namePrefix: ROLE_NAME_PREFIX[nextRole] || 'Staff',
                            reportsToUserId: nextParentId,
                            branchId: parentObj?.branchId ? String(parentObj.branchId) : bulkForm.branchId,
                          });
                        }}
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        {USER_ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.labelEn}
                          </option>
                        ))}
                      </select>
                    </div>

                    {(() => {
                      const quotaMeta = getParentQuotaLabel(bulkForm.role);
                      if (!quotaMeta) return null;
                      const candidates = getParentCandidatesForRole(bulkForm.role, users);
                      return (
                        <div className="sm:col-span-2">
                          <label className="block text-[11px] font-semibold text-[#0F2744] mb-1">
                            {quotaMeta.title} *
                          </label>
                          <select
                            required
                            value={bulkForm.reportsToUserId}
                            onChange={(e) => {
                              const parentObj = candidates.find((p) => String(p.id) === e.target.value);
                              setBulkForm((prev) => ({
                                ...prev,
                                reportsToUserId: e.target.value,
                                branchId: parentObj?.branchId ? String(parentObj.branchId) : prev.branchId,
                              }));
                            }}
                            className="w-full px-3 py-2 text-xs border border-[#0F2744]/40 rounded-lg bg-white"
                          >
                            <option value="">Select Reporting Parent...</option>
                            {candidates.map((p) => {
                              const used = Number(p.childCount || 0);
                              const isFull = used >= quotaMeta.max;
                              return (
                                <option key={p.id} value={p.id} disabled={isFull}>
                                  {p.fullName} ({p.employeeCode}) — {used}/{quotaMeta.max} {quotaMeta.unit}
                                  {p.branchName ? ` · ${p.branchName}` : ''}
                                  {isFull ? ' [FULL]' : ''}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                      );
                    })()}

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">Branch</label>
                      <select
                        value={bulkForm.branchId}
                        onChange={(e) => setBulkForm({ ...bulkForm, branchId: e.target.value })}
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        {branches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">Staff Name Prefix</label>
                      <input
                        type="text"
                        value={bulkForm.namePrefix}
                        onChange={(e) => setBulkForm({ ...bulkForm, namePrefix: e.target.value })}
                        placeholder="e.g. Field Officer"
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">Password Mode</label>
                      <select
                        value={bulkForm.passwordMode}
                        onChange={(e) =>
                          setBulkForm({ ...bulkForm, passwordMode: e.target.value as 'random' | 'custom' })
                        }
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        <option value="random">Auto-Generate Unique Password per ID</option>
                        <option value="custom">Use Custom Shared Initial Password</option>
                      </select>
                    </div>

                    {bulkForm.passwordMode === 'custom' && (
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Shared Initial Password *
                        </label>
                        <input
                          type="text"
                          required
                          autoCapitalize="none"
                          autoCorrect="off"
                          autoComplete="new-password"
                          spellCheck={false}
                          value={bulkForm.commonPassword}
                          onChange={(e) => setBulkForm({ ...bulkForm, commonPassword: e.target.value })}
                          placeholder="Initial password for all IDs"
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                        />
                      </div>
                    )}

                    <div className="flex items-end">
                      <button
                        type="submit"
                        disabled={creatingUsers}
                        className="w-full px-4 py-2 rounded-lg bg-[#0F2744] hover:bg-[#16365D] disabled:opacity-50 text-white text-xs font-semibold"
                      >
                        {creatingUsers
                          ? 'Generating...'
                          : `Generate ${bulkForm.count} Employee ID${bulkForm.count > 1 ? 's' : ''} & Passwords`}
                      </button>
                    </div>
                  </div>
                </form>
              )}

              {generatedCredentials.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-200 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-bold text-[#15803D]">
                      Created / Updated Login Credentials ({generatedCredentials.length})
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          handleCopyText(
                            generatedCredentials
                              .map((c) => `${c.employeeCode} | Password: ${c.password} | ${c.fullName} (${c.role})`)
                              .join('\n'),
                            'ALL'
                          )
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 text-[11px] font-semibold text-[#0F2744] hover:bg-slate-50"
                      >
                        {copiedCode === 'ALL' ? <Check className="w-3 h-3 text-[#15803D]" /> : <Copy className="w-3 h-3" />}
                        {copiedCode === 'ALL' ? 'Copied All' : 'Copy All'}
                      </button>
                      <button
                        type="button"
                        onClick={handleDownloadCredentialsCsv}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 text-[11px] font-semibold text-[#0F2744] hover:bg-slate-50"
                      >
                        <Download className="w-3 h-3" />
                        Download CSV
                      </button>
                      <button
                        type="button"
                        onClick={() => setGeneratedCredentials([])}
                        className="text-[11px] font-semibold text-slate-500 hover:text-slate-800"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100 bg-slate-50">
                    {generatedCredentials.map((cred, idx) => (
                      <div
                        key={`${cred.employeeCode}-${idx}`}
                        className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="font-mono font-bold text-[#0F2744]">ID: {cred.employeeCode}</span>
                          <span className="font-mono text-[#EA580C] font-semibold">Pass: {cred.password}</span>
                          <span className="text-slate-600">{cred.fullName}</span>
                          <span className="text-[11px] text-slate-500">{cred.role.replace('_', ' ')}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopyText(`Employee ID: ${cred.employeeCode}\nPassword: ${cred.password}`, cred.employeeCode)
                          }
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white border border-slate-300 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                        >
                          {copiedCode === cred.employeeCode ? (
                            <Check className="w-3 h-3 text-[#15803D]" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                          {copiedCode === cred.employeeCode ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {isSuperAdmin && !showCreatePanel && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={openUnlimitedCreator}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold"
              >
                <UserPlus className="w-3.5 h-3.5" />
                Open Employee ID &amp; Password Creator
              </button>
            </div>
          )}

          {/* Directory Search & Login ID ON/OFF Filter */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Search Employee ID, Name, Mobile, Role..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div className="flex items-center gap-1 p-0.5 bg-slate-200/70 rounded-lg">
                {[
                  { id: 'ALL', label: `All (${users.length})` },
                  { id: 'ON', label: `ON (${activeLoginCount})` },
                  { id: 'OFF', label: `OFF (${offLoginCount})` },
                ].map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setStatusFilter(f.id as any)}
                    className={`px-2.5 py-1 text-[11px] font-semibold rounded-md ${
                      statusFilter === f.id ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
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
                    <th className="text-left px-4 py-3 font-semibold">Employee ID</th>
                    <th className="text-left px-4 py-3 font-semibold">Name &amp; Mobile</th>
                    <th className="text-left px-4 py-3 font-semibold">Role</th>
                    <th className="text-left px-4 py-3 font-semibold">Hierarchy &amp; Quota</th>
                    <th className="text-left px-4 py-3 font-semibold">Branch &amp; Territory</th>
                    <th className="text-left px-4 py-3 font-semibold">OTP Login</th>
                    <th className="text-left px-4 py-3 font-semibold">Login Status</th>
                    {isSuperAdmin && <th className="text-right px-4 py-3 font-semibold">Admin Controls (ON/OFF &amp; Password)</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredUsers.map((u) => {
                    const isSelf = u.id === user.id;
                    const quotaUnit =
                      u.role === 'BRANCH_MANAGER'
                        ? 'TLs'
                        : u.role === 'TEAM_LEADER'
                          ? 'FOs'
                          : u.role === 'FIELD_OFFICER'
                            ? 'Refs'
                            : '';
                    const roleLabel =
                      u.role === 'LEAD_GENERATOR' ? 'Back Office Team' : u.role.replace('_', ' ');
                    return (
                      <tr key={u.id} className={!u.isActive ? 'bg-red-50/30' : undefined}>
                        <td className="px-4 py-3 font-mono font-semibold text-[#0F2744]">{u.employeeCode}</td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-slate-900">{u.fullName}</div>
                          <div className="font-mono text-[11px] text-slate-500">{u.mobile || 'No mobile set'}</div>
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-800">{roleLabel}</td>
                        <td className="px-4 py-3 text-[11px]">
                          {u.reportsToName ? (
                            <div className="text-slate-700">
                              Under: <span className="font-semibold">{u.reportsToName}</span>{' '}
                              <span className="font-mono text-slate-500">({u.reportsToCode})</span>
                            </div>
                          ) : (
                            <div className="text-slate-400">Top / Independent</div>
                          )}
                          {u.quotaMax ? (
                            <div
                              className={`font-mono font-semibold mt-0.5 ${
                                Number(u.childCount || 0) >= Number(u.quotaMax)
                                  ? 'text-[#DC2626]'
                                  : 'text-[#15803D]'
                              }`}
                            >
                              {u.childCount ?? 0} / {u.quotaMax} {quotaUnit}
                            </div>
                          ) : (
                            <div className="text-[10px] text-slate-400">Unlimited quota</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div>{u.branchName || '—'}</div>
                          {editingTerritoryId === u.id ? (
                            <div className="mt-1.5 space-y-1">
                              <input
                                type="text"
                                value={territoryDraft.serviceCity}
                                onChange={(e) => setTerritoryDraft({ ...territoryDraft, serviceCity: e.target.value })}
                                placeholder="City"
                                className="w-full px-2 py-1 text-[11px] border border-slate-300 rounded"
                              />
                              <input
                                type="text"
                                value={territoryDraft.servicePincodes}
                                onChange={(e) => setTerritoryDraft({ ...territoryDraft, servicePincodes: e.target.value })}
                                placeholder="PINs / Areas (comma-separated)"
                                className="w-full px-2 py-1 text-[11px] font-mono border border-slate-300 rounded"
                              />
                              <div className="flex gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => saveUserTerritory(u.id)}
                                  className="px-2 py-0.5 rounded bg-[#15803D] text-white text-[10px] font-semibold"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingTerritoryId(null)}
                                  className="px-2 py-0.5 rounded border border-slate-300 text-[10px]"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            (u.serviceCity || u.servicePincodes) && (
                              <div className="text-[10px] text-slate-500 font-mono truncate max-w-[200px]" title={u.servicePincodes || ''}>
                                {u.serviceCity ? `${u.serviceCity}: ` : ''}{u.servicePincodes || ''}
                              </div>
                            )
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {isSuperAdmin ? (
                            <button
                              type="button"
                              onClick={() => toggleUserOtp(u)}
                              className={`text-xs font-semibold underline ${
                                u.otpEnabled ? 'text-[#15803D]' : 'text-slate-500'
                              }`}
                            >
                              {u.otpEnabled ? 'OTP Required' : 'Password Only'}
                            </button>
                          ) : (
                            <span>{u.otpEnabled ? 'OTP Required' : 'Password Only'}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-semibold">
                          <span className={u.isActive ? 'text-[#15803D]' : 'text-[#DC2626]'}>
                            {u.isActive ? 'ON (Active)' : 'OFF (Blocked)'}
                          </span>
                        </td>
                        {isSuperAdmin && (
                          <td className="px-4 py-3 text-right space-y-1.5 whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5">
                              {['FIELD_OFFICER', 'TEAM_LEADER'].includes(u.role) && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingTerritoryId(u.id);
                                    setTerritoryDraft({
                                      serviceCity: u.serviceCity || '',
                                      servicePincodes: u.servicePincodes || '',
                                    });
                                  }}
                                  className="px-2.5 py-1 rounded border border-slate-300 text-[11px] font-semibold text-[#0F2744] hover:bg-slate-50"
                                >
                                  Territory
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setResetPasswordUserId(u.id);
                                  setResetPasswordDraft(generateClientPassword(8));
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 text-[11px] font-semibold text-[#0F2744] hover:bg-slate-50"
                              >
                                <KeyRound className="w-3 h-3" />
                                Password
                              </button>
                              <button
                                type="button"
                                disabled={isSelf || togglingUserId === u.id}
                                title={isSelf ? 'You cannot turn OFF your own active Super Admin Login ID' : u.isActive ? 'Turn OFF this Login ID' : 'Turn ON this Login ID'}
                                onClick={() => toggleUserActive(u)}
                                className={`inline-flex items-center gap-1 px-3 py-1 rounded text-[11px] font-semibold border transition-colors disabled:opacity-45 ${
                                  u.isActive
                                    ? 'border-[#DC2626] text-[#DC2626] bg-red-50 hover:bg-[#DC2626] hover:text-white'
                                    : 'border-[#15803D] text-[#15803D] bg-green-50 hover:bg-[#15803D] hover:text-white'
                                }`}
                              >
                                <Power className="w-3 h-3" />
                                {isSelf ? 'Current Admin' : u.isActive ? 'Turn OFF ID' : 'Turn ON ID'}
                              </button>
                            </div>
                            {resetPasswordUserId === u.id && (
                              <div className="flex items-center justify-end gap-1.5 pt-1">
                                <input
                                  type="text"
                                  autoCapitalize="none"
                                  autoCorrect="off"
                                  autoComplete="new-password"
                                  spellCheck={false}
                                  value={resetPasswordDraft}
                                  onChange={(e) => setResetPasswordDraft(e.target.value)}
                                  placeholder="New password"
                                  className="w-32 px-2 py-1 text-[11px] font-mono border border-slate-300 rounded bg-white"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleResetPassword(u)}
                                  className="px-2 py-1 rounded bg-[#0F2744] text-white text-[10px] font-semibold"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setResetPasswordUserId(null);
                                    setResetPasswordDraft('');
                                  }}
                                  className="px-2 py-1 rounded border border-slate-300 text-[10px] text-slate-600"
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {filteredUsers.length === 0 && (
                    <tr>
                      <td colSpan={isSuperAdmin ? 8 : 7} className="px-4 py-6 text-center text-xs text-slate-500">
                        No matching Login IDs found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {subTab === 'rules' && isSuperAdmin && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <form onSubmit={saveRules} className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <h2 className="text-sm font-display font-bold text-[#0F2744]">
              Penalty SLA, Petrol Rate &amp; Security Configuration
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Petrol Incentive Rate (₹ per KM)
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={rules.petrolRatePerKm}
                  onChange={(e) => setRules({ ...rules, petrolRatePerKm: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Lead Assignment SLA (Minutes)
                </label>
                <input
                  type="number"
                  min={1}
                  value={rules.assignmentSlaMinutes}
                  onChange={(e) => setRules({ ...rules, assignmentSlaMinutes: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Follow-up Reminder SLA (Minutes)
                </label>
                <input
                  type="number"
                  min={1}
                  value={rules.followupSlaMinutes}
                  onChange={(e) => setRules({ ...rules, followupSlaMinutes: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Referral Enquiry Resolution SLA (Minutes)
                </label>
                <input
                  type="number"
                  min={5}
                  value={rules.enquirySlaMinutes}
                  onChange={(e) => setRules({ ...rules, enquirySlaMinutes: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Monthly DSA Bonus Threshold (Disbursals)
                </label>
                <input
                  type="number"
                  min={1}
                  value={rules.referralBonusThreshold ?? 5}
                  onChange={(e) =>
                    setRules({ ...rules, referralBonusThreshold: Math.max(1, Number(e.target.value)) })
                  }
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Monthly DSA Extra Bonus (%)
                </label>
                <input
                  type="number"
                  step="0.05"
                  min={0}
                  value={rules.referralBonusPct ?? 0.15}
                  onChange={(e) =>
                    setRules({ ...rules, referralBonusPct: Math.max(0, Number(e.target.value)) })
                  }
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100 space-y-2">
              <div className="text-xs font-semibold text-[#0F2744]">
                DSA Referral Commission Slab (% of Disbursed Amount) &amp; Default ROI
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {rules.loanProducts.map((prod, idx) => (
                  <div
                    key={prod.id}
                    className="p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-800 truncate">{prod.name}</div>
                      <div className="text-[10px] text-slate-500 font-mono tabular-nums">
                        ROI {prod.defaultRate}%
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={10}
                        value={prod.commissionPct ?? 0.5}
                        onChange={(e) => {
                          const nextVal = Math.max(0, Number(e.target.value));
                          const nextProducts = rules.loanProducts.map((item, i) =>
                            i === idx ? { ...item, commissionPct: nextVal } : item
                          );
                          setRules({ ...rules, loanProducts: nextProducts });
                        }}
                        aria-label={`${prod.name} commission percentage`}
                        className="w-20 px-2 py-1 text-xs font-mono border border-slate-300 rounded bg-white text-right tabular-nums"
                      />
                      <span className="text-xs font-semibold text-slate-600">%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 space-y-2.5">
              <div className="text-xs font-semibold text-[#0F2744]">
                Automated Lead Assignment Load-Balancing Algorithm
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <label className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rules.autoAssignIncomingLeads ?? true}
                    onChange={(e) => setRules({ ...rules, autoAssignIncomingLeads: e.target.checked })}
                    className="rounded border-slate-300 accent-[#15803D]"
                  />
                  Auto-Distribute Incoming Leads
                </label>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Soft Max Active Leads Cap per FO
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={rules.autoAssignMaxActiveLeads ?? 25}
                    onChange={(e) =>
                      setRules({ ...rules, autoAssignMaxActiveLeads: Math.max(1, Number(e.target.value)) })
                    }
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Geo Weight {rules.autoAssignGeoWeight ?? 60}% · Load{' '}
                    {100 - (rules.autoAssignGeoWeight ?? 60)}%
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={rules.autoAssignGeoWeight ?? 60}
                    onChange={(e) => setRules({ ...rules, autoAssignGeoWeight: Number(e.target.value) })}
                    className="w-full accent-[#0F2744]"
                  />
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 space-y-2.5">
              <div className="text-xs font-semibold text-[#0F2744]">
                Staff Reward Points &amp; Wrong-Lead Minus Penalty (Field Officer &amp; Lead Generator Staff Only)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Docs + Login Reward (Field Officer Pts)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={rules.loginRewardOfficerPts ?? 50}
                    onChange={(e) => setRules({ ...rules, loginRewardOfficerPts: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Docs + Login Reward (Lead Gen Staff Pts)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={rules.loginRewardGeneratorPts ?? 30}
                    onChange={(e) => setRules({ ...rules, loginRewardGeneratorPts: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Disbursement Reward (Field Officer Pts)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={rules.disbursementRewardOfficerPts ?? 150}
                    onChange={(e) =>
                      setRules({ ...rules, disbursementRewardOfficerPts: Math.max(0, Number(e.target.value)) })
                    }
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Disbursement Reward (Lead Gen Staff Pts)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={rules.disbursementRewardGeneratorPts ?? 100}
                    onChange={(e) =>
                      setRules({ ...rules, disbursementRewardGeneratorPts: Math.max(0, Number(e.target.value)) })
                    }
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Wrong Lead Penalty Min (₹)
                  </label>
                  <input
                    type="number"
                    min={10}
                    max={100}
                    value={rules.wrongLeadPenaltyMin ?? 10}
                    onChange={(e) => setRules({ ...rules, wrongLeadPenaltyMin: Math.max(10, Number(e.target.value)) })}
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Wrong Lead Penalty Max (₹)
                  </label>
                  <input
                    type="number"
                    min={10}
                    max={100}
                    value={rules.wrongLeadPenaltyMax ?? 100}
                    onChange={(e) => setRules({ ...rules, wrongLeadPenaltyMax: Math.min(100, Number(e.target.value)) })}
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 space-y-3">
              <div className="text-xs font-semibold text-[#0F2744]">
                Daily Self-Attendance (Ambika Office GPS Geofence) &amp; Leave Penalties
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Ambika Office Name
                  </label>
                  <input
                    type="text"
                    value={rules.officeName || 'AMBIKA ASSOCIATE Head Office'}
                    onChange={(e) => setRules({ ...rules, officeName: e.target.value })}
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Allowed Radius (Meters)
                  </label>
                  <input
                    type="number"
                    min={50}
                    value={rules.officeRadiusMeters ?? 500}
                    onChange={(e) => setRules({ ...rules, officeRadiusMeters: Math.max(50, Number(e.target.value)) })}
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div className="sm:col-span-3">
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Ambika Office Address
                  </label>
                  <input
                    type="text"
                    value={
                      rules.officeAddress ||
                      '1ST FLOR ANUPAM COMPLEX,PATERI ROAD,NEAR RELIANCE BAZAR,SATNA MP(485001)'
                    }
                    onChange={(e) => setRules({ ...rules, officeAddress: e.target.value })}
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Office Latitude
                  </label>
                  <input
                    type="number"
                    step="0.00001"
                    value={rules.officeLatitude ?? 24.5819}
                    onChange={(e) => setRules({ ...rules, officeLatitude: Number(e.target.value) })}
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Office Longitude
                  </label>
                  <input
                    type="number"
                    step="0.00001"
                    value={rules.officeLongitude ?? 80.7921}
                    onChange={(e) => setRules({ ...rules, officeLongitude: Number(e.target.value) })}
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Cutoff Time (IST 24h)
                  </label>
                  <input
                    type="time"
                    value={rules.attendanceCutoffTime || '10:00'}
                    onChange={(e) => setRules({ ...rules, attendanceCutoffTime: e.target.value })}
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Late Attendance Penalty (₹/day)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={rules.attendanceLatePenaltyInr ?? 20}
                    onChange={(e) => setRules({ ...rules, attendanceLatePenaltyInr: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Unapproved Leave Penalty (₹/leave)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={rules.unapprovedLeavePenaltyInr ?? 100}
                    onChange={(e) => setRules({ ...rules, unapprovedLeavePenaltyInr: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg tabular-nums"
                  />
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 space-y-3">
              <div className="text-xs font-semibold text-[#0F2744]">
                Mobile App Distribution (Google Play Store &amp; Direct Signed APK)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Google Play Store App URL (Optional)
                  </label>
                  <input
                    type="url"
                    value={rules.playStoreUrl || ''}
                    onChange={(e) => setRules({ ...rules, playStoreUrl: e.target.value || null })}
                    placeholder="https://play.google.com/store/apps/details?id=in.ambikaassociate.crm"
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Direct Signed Android APK URL (Optional)
                  </label>
                  <input
                    type="url"
                    value={rules.apkDownloadUrl || ''}
                    onChange={(e) => setRules({ ...rules, apkDownloadUrl: e.target.value || null })}
                    placeholder="https://downloads.ambikaassociate.in/ambika-crm.apk"
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                  />
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs font-semibold text-[#0F2744]">
                  Seniority-Wise Instructions &amp; Live Broadcast Notice (Applies Automatically to All Apps)
                </label>
                <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                  Sync v{settings.configVersion ?? 1}
                </span>
              </div>
              <textarea
                rows={3}
                value={rules.seniorityInstructions || ''}
                onChange={(e) => setRules({ ...rules, seniorityInstructions: e.target.value })}
                placeholder="Enter seniority instructions, attendance rules, petrol rules, or notices to broadcast immediately to BM, Team Leader, Back Office & Field Officer apps..."
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg leading-relaxed"
              />
              <p className="text-[11px] text-slate-500">
                Saving broadcasts this instruction immediately to all connected mobile &amp; desktop apps (BM, Team Leader, Back Office Lead Staff, and Field Officers) and sends an alert.
              </p>
            </div>

            <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer pt-2">
              <input
                type="checkbox"
                checked={rules.otpRequiredGlobal}
                onChange={(e) => setRules({ ...rules, otpRequiredGlobal: e.target.checked })}
                className="rounded border-slate-300 accent-[#0F2744]"
              />
              <span>Require OTP Mobile Verification for All Logins</span>
            </label>

            <div className="pt-2">
              <button
                type="submit"
                className="px-5 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold"
              >
                Save &amp; Sync Live to All Connected Apps
              </button>
            </div>
          </form>

          <div className="lg:col-span-5 space-y-5">
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">
                Official AMBIKA ASSOCIATE Mobile App Icon &amp; Logo
              </h2>
              <div className="flex items-center gap-3.5 p-3 rounded-lg bg-slate-50 border border-slate-200">
                <img
                  src={settings.companyLogoDataUrl || '/pwa-512x512.png?v=20261120'}
                  alt="AMBIKA ASSOCIATE Mobile App Icon"
                  className="w-14 h-14 rounded-xl border border-yellow-400/50 object-cover shrink-0 bg-[#068220]"
                />
                <div className="text-xs text-slate-600 space-y-0.5 min-w-0">
                  <div className="font-semibold text-[#0F2744]">Mobile App Launcher Icon Ready</div>
                  <div>Active across Android Home Screen, iOS Safari, Play Store Kit, and all connected staff apps.</div>
                </div>
              </div>
              <p className="text-xs text-slate-600">
                Optionally upload an alternate custom PNG/SVG logo to override the portal header emblem.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold cursor-pointer">
                  <Upload className="w-4 h-4" />
                  Upload Official Logo
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml"
                    className="hidden"
                    onChange={(e) => handleLogoUpload(e.target.files?.[0])}
                  />
                </label>
                <a
                  href={`/api/public/android-app-kit?origin=${encodeURIComponent(window.location.origin)}`}
                  download="ambika-associate-android-studio-kit.tar.gz"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg border border-slate-300 text-xs font-semibold text-[#0F2744] hover:bg-slate-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Android APK Kit
                </a>
              </div>

              <div className="pt-3 border-t border-slate-100 space-y-2">
                <div className="text-xs font-semibold text-[#0F2744] flex items-center gap-1.5">
                  <Package className="w-4 h-4 text-[#EA580C]" />
                  Direct Hosted Android APK (.apk Binary)
                </div>
                {settings.hasUploadedApk ? (
                  <div className="p-2.5 rounded-lg bg-green-50 border border-green-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-[#15803D]">
                      {settings.apkFileName} ({settings.apkFileSize ? `${(settings.apkFileSize / (1024 * 1024)).toFixed(1)} MB` : 'Ready'})
                    </span>
                    <div className="flex items-center gap-2">
                      <a
                        href="/api/public/download-apk"
                        download="ambika-associate-crm.apk"
                        className="text-[#0F2744] font-semibold hover:underline"
                      >
                        Test Download
                      </a>
                      <button
                        type="button"
                        onClick={handleRemoveUploadedApk}
                        className="text-[#DC2626] font-semibold hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-500">
                    Upload a compiled release <span className="font-mono">.apk</span> here so the &quot;Download APK&quot; button in prompts serves the Android installer directly.
                  </p>
                )}
                <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  {settings.hasUploadedApk ? 'Replace Hosted .apk File' : 'Upload Compiled .apk File'}
                  <input
                    type="file"
                    accept=".apk,application/vnd.android.package-archive"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      void handleApkUpload(f);
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">
                Database Verification Controls
              </h2>
              <p className="text-xs text-slate-600">
                Clear all verification sample leads/records before production go-live, or reload the verification suite for testing.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={wipeTestData}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#DC2626] text-white text-xs font-semibold"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear Test Data (Production Wipe)
                </button>
                <button
                  type="button"
                  onClick={reloadTestData}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Load Verification Dataset
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {subTab === 'org' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-display font-bold text-[#0F2744]">Branches</h2>
            {isSuperAdmin && (
              <form onSubmit={createBranch} className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  required
                  value={newBranch.code}
                  onChange={(e) => setNewBranch({ ...newBranch, code: e.target.value.toUpperCase() })}
                  placeholder="Code (BR-NGP)"
                  className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                />
                <input
                  type="text"
                  required
                  value={newBranch.name}
                  onChange={(e) => setNewBranch({ ...newBranch, name: e.target.value })}
                  placeholder="Branch Name"
                  className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
                <input
                  type="text"
                  required
                  value={newBranch.city}
                  onChange={(e) => setNewBranch({ ...newBranch, city: e.target.value })}
                  placeholder="City"
                  className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
                <div className="flex gap-2">
                  <input
                    type="text"
                    required
                    value={newBranch.state}
                    onChange={(e) => setNewBranch({ ...newBranch, state: e.target.value })}
                    placeholder="State"
                    className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                  <button type="submit" className="px-3 py-2 rounded-lg bg-[#0F2744] text-white text-xs font-semibold">
                    Add
                  </button>
                </div>
              </form>
            )}
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {branches.map((b) => (
                <div key={b.id} className="px-4 py-2.5 flex justify-between text-xs">
                  <div>
                    <span className="font-mono font-bold text-[#0F2744]">{b.code}</span> ·{' '}
                    <span className="font-semibold">{b.name}</span>
                  </div>
                  <span className="text-slate-500">
                    {b.city}, {b.state}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-display font-bold text-[#0F2744]">Teams</h2>
            {isSuperAdmin && (
              <form onSubmit={createTeam} className="flex gap-2">
                <select
                  value={newTeam.branchId}
                  onChange={(e) => setNewTeam({ ...newTeam, branchId: e.target.value })}
                  className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  required
                  value={newTeam.name}
                  onChange={(e) => setNewTeam({ ...newTeam, name: e.target.value })}
                  placeholder="Team Name"
                  className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
                <button type="submit" className="px-4 py-2 rounded-lg bg-[#0F2744] text-white text-xs font-semibold">
                  Add
                </button>
              </form>
            )}
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {teams.map((t) => (
                <div key={t.id} className="px-4 py-2.5 text-xs font-medium text-slate-800">
                  {t.name}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {subTab === 'audit' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 text-sm font-display font-bold text-[#0F2744]">
            System Audit Trail (Last 300 Events)
          </div>
          <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500 sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2.5 font-semibold">Time</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Actor</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Action</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Entity</th>
                  <th className="text-left px-4 py-2.5 font-semibold">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                      {formatDateTime(log.createdAt)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="font-semibold text-slate-800">{log.userName}</span> ·{' '}
                      <span className="text-slate-500">{log.userRole}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono font-semibold text-[#0F2744] whitespace-nowrap">
                      {log.action}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-600 whitespace-nowrap">
                      {log.entityType} {log.entityId || ''}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{log.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'docs' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 text-xs text-slate-700">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
            <h3 className="text-sm font-display font-bold text-[#0F2744]">Database Schema (SQLite WAL)</h3>
            <p className="text-slate-600">
              17 normalized tables in <code className="font-mono">data/ambika_crm.db</code> with AES-256-GCM PII encryption:
            </p>
            <ul className="list-disc pl-5 space-y-1 font-mono text-[11px]">
              <li>branches, teams, users, otp_challenges, sessions</li>
              <li>leads (encrypted mobile/PAN/address + HMAC lookup hashes)</li>
              <li>duplicate_requests, case_history, documents, followup_reminders</li>
              <li>penalties, enquiries, gps_logs, bike_runs, alerts, settings, audit_logs</li>
            </ul>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
            <h3 className="text-sm font-display font-bold text-[#0F2744]">REST API Endpoints</h3>
            <ul className="list-disc pl-5 space-y-1 font-mono text-[11px]">
              <li>POST /api/auth/login · POST /api/auth/verify-otp · GET /api/auth/me</li>
              <li>GET /api/dashboard · GET/POST /api/leads · GET /api/leads/:id</li>
              <li>PATCH /api/leads/:id/assign · PATCH /api/leads/:id/status · POST /api/leads/:id/reminders</li>
              <li>GET /api/duplicates · POST /api/duplicates/:id/approve|reject</li>
              <li>GET /api/penalties · PATCH /api/penalties/:id/decision</li>
              <li>GET/POST /api/enquiries · PATCH /api/enquiries/:id/respond</li>
              <li>GET/POST /api/gps · GET /api/bike-runs · POST /api/bike-runs/start|stop</li>
              <li>GET /api/alerts · PATCH /api/alerts/:id/read · GET /api/reports/:type</li>
            </ul>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
            <h3 className="text-sm font-display font-bold text-[#0F2744]">Android Companion &amp; APK Build Guide</h3>
            <p>
              Native Kotlin Android source is located in <code className="font-mono">/android-app/</code> with{' '}
              <code className="font-mono">MainActivity.kt</code> (WebView + Camera + JS Bridge) and{' '}
              <code className="font-mono">GpsForegroundService.kt</code> (FusedLocationProvider background sync).
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Open <code className="font-mono">android-app/</code> in Android Studio Ladybug+.</li>
              <li>Update <code className="font-mono">CRM_BASE_URL</code> in <code className="font-mono">app/build.gradle.kts</code> to your HTTPS server URL.</li>
              <li>Run <code className="font-mono">./gradlew assembleRelease</code> or <code className="font-mono">bundleRelease</code> to generate signed APK/AAB.</li>
              <li>Employees can also install directly from Chrome mobile using the in-app <strong>Install App (PWA)</strong> button.</li>
            </ol>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
            <h3 className="text-sm font-display font-bold text-[#0F2744]">Admin &amp; Employee User Guide</h3>
            <p>
              <strong>Admin:</strong> Review pending duplicates under Duplicate Approval, approve/waive 10-min &amp; 1-hr SLA penalties, configure Petrol ₹/KM rate in Rules &amp; Branding, and export PDF/Excel reports.
            </p>
            <p>
              <strong>Field Officer:</strong> Respond to newly assigned leads within 10 minutes, upload KYC photos via Camera, log consent-based visits, and run Bike Runs with opening/closing odometer.
            </p>
            <p>
              <strong>Referral Partner:</strong> Submit leads (duplicates auto-held for Admin), track lead status &amp; assigned officer contact, and raise 1-hour SLA enquiries.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
