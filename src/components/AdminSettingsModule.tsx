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
  Pencil,
  Cloud,
  CloudOff,
  RefreshCw,
  LogOut,
  CheckCircle2,
  ArrowRightLeft,
  UserCog,
  X,
  AlertTriangle,
} from 'lucide-react';
import type { User as FirebaseUser } from 'firebase/auth';
import {
  HIERARCHY_LIMITS,
  USER_ROLES,
  type AuthUser,
  type SystemSettings,
  type UserRole,
} from '../../shared/types';
import { apiFetch, formatDateTime, getStoredToken } from '../lib/api';
import {
  subscribeCloudAuth,
  signInCloudAdmin,
  signOutCloudAdmin,
  ensureAdminProfile,
  fetchCloudSnapshot,
  pushFullSnapshotToCloud,
  deleteEmployeeFromCloud,
  isAuthorizedAdminEmail,
  type CloudSnapshot,
} from '../lib/firebase';
import { CloudErrorBoundary } from './CloudErrorBoundary';

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

const AdminSettingsInner: React.FC<AdminSettingsProps> = ({
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
  const [autoGenerateCreds, setAutoGenerateCreds] = useState(true);
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
  >(() => {
    try {
      const saved = window.localStorage.getItem('ambika_admin_recent_creds_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore localStorage read errors
    }
    return [];
  });
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [revealedPasswordIds, setRevealedPasswordIds] = useState<Record<number, boolean>>({});

  useEffect(() => {
    try {
      window.localStorage.setItem('ambika_admin_recent_creds_v1', JSON.stringify(generatedCredentials.slice(0, 100)));
    } catch {
      // ignore localStorage quota errors
    }
  }, [generatedCredentials]);

  // Search, filter, and password reset on Login ID directory
  const [userSearch, setUserSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ON' | 'OFF'>('ALL');
  const [resetPasswordUserId, setResetPasswordUserId] = useState<number | null>(null);
  const [resetPasswordDraft, setResetPasswordDraft] = useState('');
  const [renamingUserId, setRenamingUserId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState({ employeeCode: '', referralCode: '' });
  const [savingRename, setSavingRename] = useState(false);
  const [togglingUserId, setTogglingUserId] = useState<number | null>(null);

  const [editingTerritoryId, setEditingTerritoryId] = useState<number | null>(null);
  const [territoryDraft, setTerritoryDraft] = useState({ serviceCity: '', servicePincodes: '' });

  // Designation / Role Change + Reporting Senior Modal
  const [roleModalUser, setRoleModalUser] = useState<any | null>(null);
  const [roleModalDraft, setRoleModalDraft] = useState({
    role: 'FIELD_OFFICER' as UserRole,
    reportsToUserId: '',
    branchId: '',
    transferExistingDownlineToUserId: '',
  });
  const [savingRoleChange, setSavingRoleChange] = useState(false);

  // Bulk Downline Transfer Modal (BM->BM, TL->TL, FO->FO)
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [transferLevel, setTransferLevel] = useState<'TEAM_LEADER' | 'FIELD_OFFICER' | 'REFERRAL_PARTNER'>('FIELD_OFFICER');
  const [transferSourceSeniorId, setTransferSourceSeniorId] = useState<string>('ALL');
  const [transferTargetSeniorId, setTransferTargetSeniorId] = useState<string>('');
  const [transferSelectedIds, setTransferSelectedIds] = useState<number[]>([]);
  const [savingTransfer, setSavingTransfer] = useState(false);

  // Permanent Delete Employee ID Modal
  const [deleteModalUser, setDeleteModalUser] = useState<any | null>(null);
  const [deleteTransferToId, setDeleteTransferToId] = useState<string>('');
  const [deletingUser, setDeletingUser] = useState(false);

  // Rules state
  const [rules, setRules] = useState<SystemSettings>(settings);

  // Org forms
  const [newBranch, setNewBranch] = useState({ code: '', name: '', city: '', state: '' });
  const [newTeam, setNewTeam] = useState({ branchId: '1', name: '' });

  // Permanent Firebase Cloud Database Sync state (Super Admin)
  const [cloudUser, setCloudUser] = useState<FirebaseUser | null>(null);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [cloudEmployeeCount, setCloudEmployeeCount] = useState<number | null>(null);
  const [lastCloudSyncAt, setLastCloudSyncAt] = useState<string | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const initialCloudSyncDoneRef = useRef(false);

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
    setNewUser((prev) => {
      const nextCode =
        autoGenerateCreds && !prev.employeeCode
          ? suggestNextEmployeeCode(prev.role, uRes.users)
          : prev.employeeCode;
      const nextPass =
        autoGenerateCreds && !prev.password ? generateClientPassword(8) : prev.password;
      return {
        ...prev,
        employeeCode: nextCode,
        password: nextPass,
        referralCode:
          autoGenerateCreds && prev.role === 'REFERRAL_PARTNER' && !prev.referralCode && nextCode
            ? `DSA-${nextCode}`
            : prev.referralCode,
        reportsToUserId: prev.reportsToUserId || pickDefaultParentId(prev.role, uRes.users),
      };
    });
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

  const formatCloudError = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err || 'Cloud sync failed');
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.error === 'string') {
        return `Cloud sync (${parsed.operationType || 'write'} · ${parsed.path || 'firestore'}): ${parsed.error}`;
      }
    } catch {
      // plain error string
    }
    return raw;
  };

  const runBiDirectionalCloudSync = async (
    fbUser: FirebaseUser,
    options: { showToast?: boolean } = {}
  ) => {
    if (!isSuperAdmin) return;
    setCloudSyncing(true);
    setCloudError(null);
    try {
      await ensureAdminProfile(fbUser);

      // 1. Pull any existing Employee IDs & Branches from Google Cloud Firestore
      const cloudSnap = await fetchCloudSnapshot();
      let restoredEmployees = 0;
      let restoredBranches = 0;
      if (cloudSnap.employees.length > 0 || cloudSnap.branches.length > 0) {
        const restoreRes = await apiFetch<{
          ok: boolean;
          restoredEmployees: number;
          restoredBranches: number;
          totalUsers: number;
        }>('/admin/cloud-sync/restore', {
          method: 'POST',
          json: cloudSnap,
        });
        restoredEmployees = restoreRes.restoredEmployees || 0;
        restoredBranches = restoreRes.restoredBranches || 0;
      }

      // 2. Push the complete merged SQLite directory (all manual/auto IDs + encrypted passwords) back to Firestore
      const localExport = await apiFetch<CloudSnapshot>('/admin/cloud-sync/export');
      const pushRes = await pushFullSnapshotToCloud(localExport);

      setCloudEmployeeCount(pushRes.syncedEmployees);
      setLastCloudSyncAt(new Date().toISOString());

      if (restoredEmployees > 0 || restoredBranches > 0) {
        await loadAll();
      }
      if (options.showToast) {
        setMsg(
          restoredEmployees > 0
            ? `Cloud Database synced: restored ${restoredEmployees} Employee ID(s) from Google Cloud and backed up all ${pushRes.syncedEmployees} IDs permanently.`
            : `Cloud Database synced permanently: all ${pushRes.syncedEmployees} Employee IDs & Passwords saved safely in Google Firestore.`
        );
      }
    } catch (err) {
      setCloudError(formatCloudError(err));
    } finally {
      setCloudSyncing(false);
    }
  };

  const mirrorChangesToCloud = async (deletedOldEmployeeCode?: string) => {
    if (!isSuperAdmin || !cloudUser) return;
    setCloudSyncing(true);
    setCloudError(null);
    try {
      if (deletedOldEmployeeCode) {
        await deleteEmployeeFromCloud(deletedOldEmployeeCode);
      }
      const localExport = await apiFetch<CloudSnapshot>('/admin/cloud-sync/export');
      const pushRes = await pushFullSnapshotToCloud(localExport);
      setCloudEmployeeCount(pushRes.syncedEmployees);
      setLastCloudSyncAt(new Date().toISOString());
    } catch (err) {
      setCloudError(formatCloudError(err));
    } finally {
      setCloudSyncing(false);
    }
  };

  useEffect(() => {
    if (!isSuperAdmin) return;
    const unsubscribe = subscribeCloudAuth((fbUser) => {
      setCloudUser(fbUser);
      if (fbUser && isAuthorizedAdminEmail(fbUser.email) && !initialCloudSyncDoneRef.current) {
        initialCloudSyncDoneRef.current = true;
        void runBiDirectionalCloudSync(fbUser, { showToast: false });
      }
      if (!fbUser) {
        initialCloudSyncDoneRef.current = false;
      }
    });
    return () => unsubscribe();
  }, [isSuperAdmin]);

  const handleConnectCloudDatabase = async () => {
    setCloudError(null);
    setMsg(null);
    setCloudSyncing(true);
    try {
      const fbUser = await signInCloudAdmin();
      setCloudUser(fbUser);
      initialCloudSyncDoneRef.current = true;
      await runBiDirectionalCloudSync(fbUser, { showToast: true });
    } catch (err) {
      setCloudError(formatCloudError(err));
      setCloudSyncing(false);
    }
  };

  const handleDisconnectCloudDatabase = async () => {
    setCloudError(null);
    try {
      await signOutCloudAdmin();
      setCloudUser(null);
      setCloudEmployeeCount(null);
      setLastCloudSyncAt(null);
      setMsg('Disconnected Google Cloud sync session on this browser.');
    } catch (err) {
      setCloudError(formatCloudError(err));
    }
  };

  const handleToggleAutoGenerateCreds = (nextAuto: boolean) => {
    setAutoGenerateCreds(nextAuto);
    setErrorMsg(null);
    if (nextAuto) {
      setNewUser((prev) => {
        const generatedCode = suggestNextEmployeeCode(prev.role, users);
        return {
          ...prev,
          employeeCode: generatedCode,
          password: generateClientPassword(8),
          referralCode:
            prev.role === 'REFERRAL_PARTNER' ? `DSA-${generatedCode}` : prev.referralCode,
        };
      });
    } else {
      setNewUser((prev) => ({
        ...prev,
        employeeCode: '',
        password: '',
        referralCode: prev.role === 'REFERRAL_PARTNER' ? '' : prev.referralCode,
      }));
      window.requestAnimationFrame(() => employeeCodeInputRef.current?.focus());
    }
  };

  const applyRolePreset = (targetRole: UserRole, mode: 'single' | 'bulk' = createMode) => {
    setSubTab('users');
    onSelectOption?.('users');
    setShowCreatePanel(true);
    setCreateMode(mode);
    setErrorMsg(null);
    const defaultParentId = pickDefaultParentId(targetRole, users);
    const parentObj = users.find((u) => String(u.id) === defaultParentId);

    if (mode === 'single') {
      setNewUser((prev) => {
        const autoCode = autoGenerateCreds ? suggestNextEmployeeCode(targetRole, users) : prev.employeeCode;
        return {
          ...prev,
          role: targetRole,
          employeeCode: autoCode,
          password: autoGenerateCreds ? prev.password || generateClientPassword(8) : prev.password,
          referralCode:
            autoGenerateCreds && targetRole === 'REFERRAL_PARTNER'
              ? `DSA-${autoCode}`
              : prev.referralCode,
          reportsToUserId: defaultParentId,
          branchId: parentObj?.branchId ? String(parentObj.branchId) : prev.branchId,
        };
      });
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
    if (autoGenerateCreds && !newUser.employeeCode) {
      setNewUser((prev) => {
        const autoCode = suggestNextEmployeeCode(prev.role, users);
        return {
          ...prev,
          employeeCode: autoCode,
          password: prev.password || generateClientPassword(8),
          referralCode:
            prev.role === 'REFERRAL_PARTNER' && !prev.referralCode ? `DSA-${autoCode}` : prev.referralCode,
          reportsToUserId: prev.reportsToUserId || pickDefaultParentId(prev.role, users),
        };
      });
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
      setNewUser((prev) => {
        const nextAutoCode =
          keepCreatingMore && autoGenerateCreds
            ? suggestNextEmployeeCode(prev.role, freshUsers)
            : '';
        return {
          ...prev,
          employeeCode: nextAutoCode,
          fullName: '',
          mobile: '',
          email: '',
          password: keepCreatingMore && autoGenerateCreds ? generateClientPassword(8) : '',
          reportsToUserId: pickDefaultParentId(prev.role, freshUsers),
          referralCode:
            keepCreatingMore && autoGenerateCreds && prev.role === 'REFERRAL_PARTNER' && nextAutoCode
              ? `DSA-${nextAutoCode}`
              : '',
        };
      });
      setUserSearch('');
      setStatusFilter('ALL');
      setMsg(
        `Employee Login ID "${finalCode}" permanently saved (Status: ON)${
          cloudUser ? ' & synced to Google Cloud' : ''
        }. Ready to sign in with password "${finalPass}".`
      );
      void mirrorChangesToCloud();
      if (!keepCreatingMore) {
        setShowCreatePanel(false);
      } else if (!autoGenerateCreds) {
        window.requestAnimationFrame(() => employeeCodeInputRef.current?.focus());
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
        `Generated ${res.count} Employee Login ID${res.count > 1 ? 's' : ''} & Password${res.count > 1 ? 's' : ''} successfully${
          cloudUser ? ' and synced to Google Cloud' : ''
        }.`
      );
      await loadAll();
      void mirrorChangesToCloud();
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
      void mirrorChangesToCloud();
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
      void mirrorChangesToCloud();
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
      void mirrorChangesToCloud();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not reset password');
    }
  };

  const handleRenameUserId = async (target: any) => {
    if (!isSuperAdmin) return;
    const cleanCode = renameDraft.employeeCode.trim().replace(/\s+/g, '').toUpperCase();
    const cleanRef = renameDraft.referralCode.trim().replace(/\s+/g, '').toUpperCase();
    if (!cleanCode || cleanCode.length < 2) {
      setErrorMsg('Please enter a valid Employee ID (at least 2 characters, no spaces).');
      return;
    }
    setMsg(null);
    setErrorMsg(null);
    setSavingRename(true);
    try {
      const payload: Record<string, any> = { employeeCode: cleanCode };
      if (target.role === 'REFERRAL_PARTNER' || target.referralCode || cleanRef) {
        payload.referralCode = cleanRef;
      }
      await apiFetch(`/admin/users/${target.id}`, {
        method: 'PATCH',
        json: payload,
      });
      setRenamingUserId(null);
      setRenameDraft({ employeeCode: '', referralCode: '' });
      setMsg(
        `ID renamed successfully: ${target.employeeCode} → ${cleanCode}${
          payload.referralCode ? ` (Referral Code: ${payload.referralCode})` : ''
        }.`
      );
      await loadAll();
      const oldCode = String(target.employeeCode || '').trim().toUpperCase();
      void mirrorChangesToCloud(oldCode && oldCode !== cleanCode ? oldCode : undefined);
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not rename Employee / Referral ID');
    } finally {
      setSavingRename(false);
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
      void mirrorChangesToCloud();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not update OTP requirement');
    }
  };

  const openRoleAndTransferModal = (target: any) => {
    setErrorMsg(null);
    setRoleModalUser(target);
    setRoleModalDraft({
      role: target.role as UserRole,
      reportsToUserId: target.reportsToUserId ? String(target.reportsToUserId) : '',
      branchId: target.branchId ? String(target.branchId) : branches[0]?.id ? String(branches[0].id) : '',
      transferExistingDownlineToUserId: '',
    });
  };

  const handleSaveRoleAndSenior = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || !roleModalUser) return;
    setMsg(null);
    setErrorMsg(null);
    setSavingRoleChange(true);
    try {
      const needsParent = ['TEAM_LEADER', 'FIELD_OFFICER', 'REFERRAL_PARTNER'].includes(roleModalDraft.role);
      const res = await apiFetch<{
        ok: boolean;
        role?: UserRole;
        transferredChildCount?: number;
      }>(`/admin/users/${roleModalUser.id}`, {
        method: 'PATCH',
        json: {
          role: roleModalDraft.role,
          reportsToUserId: needsParent ? (roleModalDraft.reportsToUserId ? Number(roleModalDraft.reportsToUserId) : null) : null,
          branchId: roleModalDraft.branchId ? Number(roleModalDraft.branchId) : null,
          transferExistingDownlineToUserId: roleModalDraft.transferExistingDownlineToUserId
            ? Number(roleModalDraft.transferExistingDownlineToUserId)
            : null,
        },
      });
      const roleTitle =
        roleModalDraft.role === 'LEAD_GENERATOR' ? 'Back Office Team' : roleModalDraft.role.replace(/_/g, ' ');
      setMsg(
        `Updated ${roleModalUser.fullName} (${roleModalUser.employeeCode}) → ${roleTitle}${
          res.transferredChildCount ? ` and transferred ${res.transferredChildCount} downline member(s)` : ''
        }${cloudUser ? ' · synced to Google Cloud' : ''}.`
      );
      setRoleModalUser(null);
      await loadAll();
      void mirrorChangesToCloud();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not update designation or reporting senior');
    } finally {
      setSavingRoleChange(false);
    }
  };

  const openBulkTransferModal = (presetSenior?: any) => {
    setErrorMsg(null);
    if (presetSenior) {
      const level =
        presetSenior.role === 'BRANCH_MANAGER'
          ? 'TEAM_LEADER'
          : presetSenior.role === 'TEAM_LEADER'
          ? 'FIELD_OFFICER'
          : 'REFERRAL_PARTNER';
      setTransferLevel(level);
      setTransferSourceSeniorId(String(presetSenior.id));
      const directKids = users
        .filter((u) => u.role === level && Number(u.reportsToUserId || 0) === Number(presetSenior.id))
        .map((u) => Number(u.id));
      setTransferSelectedIds(directKids);
      setTransferTargetSeniorId('');
    } else {
      setTransferLevel('FIELD_OFFICER');
      setTransferSourceSeniorId('ALL');
      setTransferSelectedIds([]);
      setTransferTargetSeniorId('');
    }
    setTransferModalOpen(true);
  };

  const handleConfirmBulkTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin) return;
    if (transferSelectedIds.length === 0) {
      setErrorMsg('Please select at least one downline employee to transfer.');
      return;
    }
    if (!transferTargetSeniorId) {
      setErrorMsg('Please choose a destination senior.');
      return;
    }
    setMsg(null);
    setErrorMsg(null);
    setSavingTransfer(true);
    try {
      const res = await apiFetch<{
        ok: boolean;
        transferredCount: number;
        targetSenior?: { employeeCode: string; fullName: string };
      }>('/admin/users/transfer-downline', {
        method: 'POST',
        json: {
          employeeIds: transferSelectedIds,
          targetSeniorId: Number(transferTargetSeniorId),
        },
      });
      setMsg(
        `Transferred ${res.transferredCount} downline employee(s) under ${res.targetSenior?.fullName || 'new senior'} (${
          res.targetSenior?.employeeCode || ''
        })${cloudUser ? ' & synced to Google Cloud' : ''}.`
      );
      setTransferModalOpen(false);
      setTransferSelectedIds([]);
      await loadAll();
      void mirrorChangesToCloud();
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not transfer downline employees');
    } finally {
      setSavingTransfer(false);
    }
  };

  const handleConfirmDeleteUser = async () => {
    if (!isSuperAdmin || !deleteModalUser) return;
    setMsg(null);
    setErrorMsg(null);
    setDeletingUser(true);
    try {
      const deletedCode = String(deleteModalUser.employeeCode || '').trim().toUpperCase();
      const res = await apiFetch<{
        ok: boolean;
        deletedEmployeeCode: string;
        deletedFullName: string;
        transferredDownlineCount: number;
      }>(`/admin/users/${deleteModalUser.id}`, {
        method: 'DELETE',
        json: {
          transferDownlineToUserId: deleteTransferToId ? Number(deleteTransferToId) : null,
        },
      });
      setGeneratedCredentials((prev) =>
        prev.filter((c) => String(c.employeeCode || '').trim().toUpperCase() !== deletedCode)
      );
      setMsg(
        `Permanently deleted Employee ID ${res.deletedEmployeeCode} (${res.deletedFullName})${
          res.transferredDownlineCount > 0
            ? ` and transferred ${res.transferredDownlineCount} downline member(s)`
            : ''
        }${cloudUser ? ' · removed from Google Cloud' : ''}.`
      );
      setDeleteModalUser(null);
      setDeleteTransferToId('');
      await loadAll();
      void mirrorChangesToCloud(deletedCode);
    } catch (err: any) {
      setErrorMsg(err.message || 'Could not delete Employee ID');
    } finally {
      setDeletingUser(false);
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
      void mirrorChangesToCloud();
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
    void mirrorChangesToCloud();
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
          {/* Permanent Google Cloud Firestore Sync Panel (Super Admin Only) */}
          {isSuperAdmin && (
            <div
              className={`rounded-xl border p-4 transition-colors ${
                cloudUser
                  ? 'bg-emerald-50/70 border-emerald-200'
                  : 'bg-[#0F2744] text-white border-[#0F2744]'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                      cloudUser ? 'bg-emerald-600 text-white' : 'bg-[#EA580C] text-white'
                    }`}
                  >
                    {cloudUser ? <Cloud className="w-4 h-4" /> : <CloudOff className="w-4 h-4" />}
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2
                        className={`text-sm font-display font-bold ${
                          cloudUser ? 'text-[#0F2744]' : 'text-white'
                        }`}
                      >
                        Permanent Cloud Database (Google Firestore)
                      </h2>
                      {cloudUser && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[11px] font-semibold">
                          <CheckCircle2 className="w-3 h-3" />
                          Connected &amp; Auto-Syncing
                        </span>
                      )}
                    </div>
                    {cloudUser ? (
                      <p className="text-xs text-slate-700 mt-0.5">
                        Signed in as <strong>{cloudUser.email}</strong>
                        {cloudEmployeeCount !== null ? ` · ${cloudEmployeeCount} Employee IDs saved in Cloud` : ''}
                        {lastCloudSyncAt ? ` · Last synced ${formatDateTime(lastCloudSyncAt)}` : ''}
                      </p>
                    ) : (
                      <p className="text-xs text-slate-200 mt-0.5 max-w-2xl">
                        Sign in once with your Admin Google Account (<strong>rajadineshgupta0@gmail.com</strong> or{' '}
                        <strong>ambikafinance.info@gmail.com</strong>) so every manual/auto Employee ID &amp; Password stays
                        permanently saved in Google Cloud and auto-restores across restarts &amp; republishes.
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {cloudUser ? (
                    <>
                      <button
                        type="button"
                        disabled={cloudSyncing}
                        onClick={() => void runBiDirectionalCloudSync(cloudUser, { showToast: true })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] disabled:opacity-60 text-white text-xs font-semibold"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${cloudSyncing ? 'animate-spin' : ''}`} />
                        {cloudSyncing ? 'Syncing…' : 'Sync & Restore Now'}
                      </button>
                      <button
                        type="button"
                        disabled={cloudSyncing}
                        onClick={() => void handleDisconnectCloudDatabase()}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 text-xs font-semibold"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={cloudSyncing}
                      onClick={() => void handleConnectCloudDatabase()}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] disabled:opacity-60 text-white text-xs font-bold shadow-xs"
                    >
                      <Cloud className="w-4 h-4" />
                      {cloudSyncing ? 'Connecting…' : 'Connect Cloud Database (Google Sign-In)'}
                    </button>
                  )}
                </div>
              </div>

              {cloudError && (
                <div className="mt-3 p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-center justify-between gap-2">
                  <span className="break-words">{cloudError}</span>
                  <button
                    type="button"
                    onClick={() => setCloudError(null)}
                    className="text-[11px] font-bold underline shrink-0"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          )}

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
                  {/* Auto Generate Employee Login ID & Password ON / OFF Switch Bar */}
                  <div
                    className={`rounded-xl border px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3 transition-colors ${
                      autoGenerateCreds
                        ? 'bg-emerald-50/70 border-emerald-200'
                        : 'bg-slate-50 border-[#0F2744]/25'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs font-display font-bold text-[#0F2744]">
                        {autoGenerateCreds ? (
                          <Sparkles className="w-3.5 h-3.5 text-[#15803D] shrink-0" />
                        ) : (
                          <Pencil className="w-3.5 h-3.5 text-[#EA580C] shrink-0" />
                        )}
                        <span>
                          Auto Employee Login ID &amp; Password Generate:{' '}
                          <span className={autoGenerateCreds ? 'text-[#15803D]' : 'text-[#EA580C]'}>
                            {autoGenerateCreds ? 'ON' : 'OFF (Manual Mode)'}
                          </span>
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600 mt-0.5">
                        {autoGenerateCreds
                          ? 'Auto Mode ON — Employee Login ID & Password are auto-generated for the selected role. Turn OFF anytime to type a custom manual ID & Password.'
                          : 'Manual Mode Active — Enter any custom Employee Login ID & custom Password manually for any employee or partner role.'}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {autoGenerateCreds && (
                        <button
                          type="button"
                          onClick={() =>
                            setNewUser((prev) => {
                              const nextCode = suggestNextEmployeeCode(prev.role, users);
                              return {
                                ...prev,
                                employeeCode: nextCode,
                                password: generateClientPassword(8),
                                referralCode:
                                  prev.role === 'REFERRAL_PARTNER' ? `DSA-${nextCode}` : prev.referralCode,
                              };
                            })
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white border border-emerald-300 text-[#15803D] hover:bg-emerald-50 text-[11px] font-semibold"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Re-Generate Both
                        </button>
                      )}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={autoGenerateCreds}
                        onClick={() => handleToggleAutoGenerateCreds(!autoGenerateCreds)}
                        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors shadow-xs ${
                          autoGenerateCreds
                            ? 'bg-[#15803D] hover:bg-green-800 text-white'
                            : 'bg-[#0F2744] hover:bg-[#16365D] text-white'
                        }`}
                      >
                        <span
                          className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                            autoGenerateCreds ? 'bg-white/30' : 'bg-white/20'
                          }`}
                        >
                          <span
                            className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                              autoGenerateCreds ? 'translate-x-3.5' : 'translate-x-0.5'
                            }`}
                          />
                        </span>
                        <span>{autoGenerateCreds ? 'Auto Generate: ON' : 'Auto Generate: OFF'}</span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <label className="text-[11px] font-semibold text-slate-700">
                          {autoGenerateCreds ? 'Employee Login ID (Auto / Editable) *' : 'Manual Employee Login ID *'}
                        </label>
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setAutoGenerateCreds(false);
                              setNewUser((prev) => ({ ...prev, employeeCode: '' }));
                              window.requestAnimationFrame(() => employeeCodeInputRef.current?.focus());
                            }}
                            className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-[#0F2744] hover:underline"
                          >
                            <Pencil className="w-2.5 h-2.5" />
                            Manual
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setNewUser((prev) => ({
                                ...prev,
                                employeeCode: suggestNextEmployeeCode(prev.role, users),
                              }))
                            }
                            className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-[#EA580C] hover:underline"
                          >
                            <Sparkles className="w-3 h-3" />
                            Auto ID
                          </button>
                        </div>
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
                        placeholder={
                          autoGenerateCreds
                            ? 'Auto-generated ID (editable)'
                            : 'Type manual ID (e.g. SATNA-FO01, TLPALAK)'
                        }
                        className={`w-full px-3 py-2 text-xs font-mono border rounded-lg ${
                          autoGenerateCreds
                            ? 'border-emerald-300 bg-emerald-50/30'
                            : 'border-[#0F2744]/40 bg-white'
                        }`}
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <label className="text-[11px] font-semibold text-slate-700">
                          {autoGenerateCreds ? 'Login Password (Auto / Editable) *' : 'Manual Login Password *'}
                        </label>
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setAutoGenerateCreds(false);
                              setNewUser((prev) => ({ ...prev, password: '' }));
                            }}
                            className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-[#0F2744] hover:underline"
                          >
                            <Pencil className="w-2.5 h-2.5" />
                            Manual
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setNewUser((prev) => ({ ...prev, password: generateClientPassword(8) }))
                            }
                            className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-[#EA580C] hover:underline"
                          >
                            <KeyRound className="w-3 h-3" />
                            Auto Pass
                          </button>
                        </div>
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
                          placeholder={
                            autoGenerateCreds
                              ? 'Auto password (editable)'
                              : 'Type manual password (no spaces)'
                          }
                          className={`w-full px-3 py-2 pr-8 text-xs font-mono border rounded-lg ${
                            autoGenerateCreds
                              ? 'border-emerald-300 bg-emerald-50/30'
                              : 'border-[#0F2744]/40 bg-white'
                          }`}
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
                          setNewUser((prev) => {
                            const shouldAutoUpdateCode =
                              autoGenerateCreds &&
                              (!prev.employeeCode ||
                                Object.values(ROLE_CODE_PREFIX).some((p) =>
                                  new RegExp(`^${p}\\d+$`, 'i').test(prev.employeeCode)
                                ) ||
                                /^LG\d+$/i.test(prev.employeeCode));
                            const nextCode = shouldAutoUpdateCode
                              ? suggestNextEmployeeCode(nextRole, users)
                              : prev.employeeCode;
                            return {
                              ...prev,
                              role: nextRole,
                              reportsToUserId: nextParentId,
                              branchId: parentObj?.branchId ? String(parentObj.branchId) : prev.branchId,
                              employeeCode: nextCode,
                              password: autoGenerateCreds ? prev.password || generateClientPassword(8) : prev.password,
                              referralCode:
                                autoGenerateCreds && nextRole === 'REFERRAL_PARTNER' && nextCode
                                  ? `DSA-${nextCode}`
                                  : prev.referralCode,
                            };
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
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <label className="text-[11px] font-semibold text-slate-700">
                          Referral Code (Manual / Auto)
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            const base = newUser.employeeCode.trim().replace(/\s+/g, '').toUpperCase() || suggestNextEmployeeCode('REFERRAL_PARTNER', users);
                            setNewUser((prev) => ({ ...prev, referralCode: `DSA-${base}` }));
                          }}
                          className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-[#EA580C] hover:underline"
                        >
                          <Sparkles className="w-3 h-3" />
                          Auto Ref
                        </button>
                      </div>
                      <input
                        type="text"
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        value={newUser.referralCode}
                        onChange={(e) =>
                          setNewUser({
                            ...newUser,
                            referralCode: e.target.value.replace(/\s+/g, '').toUpperCase(),
                          })
                        }
                        placeholder="Manual code (e.g. DSA-SATNA01)"
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
                        {autoGenerateCreds
                          ? 'Keep open & auto-generate next ID & Password'
                          : 'Keep open for next manual ID & Password'}
                      </label>
                      <button
                        type="submit"
                        disabled={creatingUsers}
                        className="px-5 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
                      >
                        {creatingUsers
                          ? 'Creating...'
                          : autoGenerateCreds
                            ? 'Create Auto Employee ID & Password'
                            : 'Create Manual Employee ID & Password'}
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
              <div className="flex flex-wrap items-center gap-2">
                {isSuperAdmin && (
                  <button
                    type="button"
                    onClick={() => openBulkTransferModal()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-[11px] font-semibold whitespace-nowrap shrink-0"
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5 text-[#EA580C]" />
                    Transfer Downline Team
                  </button>
                )}
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
                    {isSuperAdmin && <th className="text-right px-4 py-3 font-semibold">Admin Controls (Role · Transfer · Delete · ON/OFF)</th>}
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
                        <td className="px-4 py-3 font-mono font-semibold text-[#0F2744]">
                          <div>{u.employeeCode}</div>
                          {u.referralCode && (
                            <div className="text-[10px] font-mono font-semibold text-[#EA580C] mt-0.5">
                              Ref: {u.referralCode}
                            </div>
                          )}
                          {isSuperAdmin && u.savedPassword && (
                            <div className="mt-1 flex items-center gap-1 text-[10px] font-mono text-slate-600">
                              <span className="text-slate-400">Pass:</span>
                              <span className="text-[#EA580C] font-semibold">
                                {revealedPasswordIds[u.id] ? u.savedPassword : '••••••••'}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setRevealedPasswordIds((prev) => ({ ...prev, [u.id]: !prev[u.id] }))
                                }
                                title={revealedPasswordIds[u.id] ? 'Hide password' : 'Show saved password'}
                                className="p-0.5 text-slate-400 hover:text-[#0F2744]"
                              >
                                {revealedPasswordIds[u.id] ? (
                                  <EyeOff className="w-3 h-3" />
                                ) : (
                                  <Eye className="w-3 h-3" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopyText(
                                    `Employee ID: ${u.employeeCode}\nPassword: ${u.savedPassword}`,
                                    `ROW-${u.id}`
                                  )
                                }
                                title="Copy ID & Password"
                                className="p-0.5 text-slate-400 hover:text-[#15803D]"
                              >
                                {copiedCode === `ROW-${u.id}` ? (
                                  <Check className="w-3 h-3 text-[#15803D]" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                              </button>
                            </div>
                          )}
                        </td>
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
                            <div className="flex flex-wrap items-center justify-end gap-1.5">
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
                                  className="px-2 py-1 rounded border border-slate-300 text-[11px] font-semibold text-[#0F2744] hover:bg-slate-50"
                                >
                                  Territory
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={isSelf}
                                title={
                                  isSelf
                                    ? 'You cannot change your own Super Admin designation'
                                    : 'Change Designation / Role or Transfer to Another Senior'
                                }
                                onClick={() => openRoleAndTransferModal(u)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-blue-300 bg-blue-50/70 text-[11px] font-semibold text-[#0F2744] hover:bg-[#0F2744] hover:text-white transition-colors disabled:opacity-45"
                              >
                                <UserCog className="w-3 h-3" />
                                Role / Transfer
                              </button>
                              {Number(u.childCount || 0) > 0 && (
                                <button
                                  type="button"
                                  title={`Transfer ${u.fullName}'s ${u.childCount} downline staff to another senior`}
                                  onClick={() => openBulkTransferModal(u)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 bg-slate-50 text-[11px] font-semibold text-[#0F2744] hover:bg-slate-200 transition-colors"
                                >
                                  <ArrowRightLeft className="w-3 h-3 text-[#EA580C]" />
                                  Shift Team ({u.childCount})
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setResetPasswordUserId(null);
                                  setRenamingUserId(u.id);
                                  setRenameDraft({
                                    employeeCode: u.employeeCode || '',
                                    referralCode: u.referralCode || '',
                                  });
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-orange-300 bg-orange-50/70 text-[11px] font-semibold text-[#C2410C] hover:bg-[#EA580C] hover:text-white transition-colors"
                              >
                                <Pencil className="w-3 h-3" />
                                Rename ID
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setRenamingUserId(null);
                                  setResetPasswordUserId(u.id);
                                  setResetPasswordDraft(generateClientPassword(8));
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 text-[11px] font-semibold text-[#0F2744] hover:bg-slate-50"
                              >
                                <KeyRound className="w-3 h-3" />
                                Password
                              </button>
                              <button
                                type="button"
                                disabled={isSelf || togglingUserId === u.id}
                                title={isSelf ? 'You cannot turn OFF your own active Super Admin Login ID' : u.isActive ? 'Turn OFF this Login ID' : 'Turn ON this Login ID'}
                                onClick={() => toggleUserActive(u)}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold border transition-colors disabled:opacity-45 ${
                                  u.isActive
                                    ? 'border-[#D97706] text-[#B45309] bg-amber-50 hover:bg-[#D97706] hover:text-white'
                                    : 'border-[#15803D] text-[#15803D] bg-green-50 hover:bg-[#15803D] hover:text-white'
                                }`}
                              >
                                <Power className="w-3 h-3" />
                                {isSelf ? 'Current Admin' : u.isActive ? 'Turn OFF' : 'Turn ON'}
                              </button>
                              {!isSelf && (
                                <button
                                  type="button"
                                  title={`Permanently delete Employee ID ${u.employeeCode}`}
                                  onClick={() => {
                                    setErrorMsg(null);
                                    setDeleteModalUser(u);
                                    setDeleteTransferToId('');
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[#DC2626] text-[#DC2626] bg-red-50 hover:bg-[#DC2626] hover:text-white text-[11px] font-semibold transition-colors"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  Delete
                                </button>
                              )}
                            </div>
                            {renamingUserId === u.id && (
                              <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1">
                                <input
                                  type="text"
                                  autoCapitalize="characters"
                                  autoCorrect="off"
                                  spellCheck={false}
                                  value={renameDraft.employeeCode}
                                  onChange={(e) =>
                                    setRenameDraft((prev) => ({
                                      ...prev,
                                      employeeCode: e.target.value.replace(/\s+/g, '').toUpperCase(),
                                    }))
                                  }
                                  placeholder="New Employee ID"
                                  className="w-36 px-2 py-1 text-[11px] font-mono border border-orange-300 rounded bg-white"
                                />
                                {(u.role === 'REFERRAL_PARTNER' || u.referralCode) && (
                                  <input
                                    type="text"
                                    autoCapitalize="characters"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    value={renameDraft.referralCode}
                                    onChange={(e) =>
                                      setRenameDraft((prev) => ({
                                        ...prev,
                                        referralCode: e.target.value.replace(/\s+/g, '').toUpperCase(),
                                      }))
                                    }
                                    placeholder="New Referral Code"
                                    className="w-36 px-2 py-1 text-[11px] font-mono border border-orange-300 rounded bg-white"
                                  />
                                )}
                                <button
                                  type="button"
                                  disabled={savingRename}
                                  onClick={() => handleRenameUserId(u)}
                                  className="px-2.5 py-1 rounded bg-[#EA580C] text-white text-[10px] font-semibold disabled:opacity-50"
                                >
                                  {savingRename ? 'Saving...' : 'Save ID'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRenamingUserId(null);
                                    setRenameDraft({ employeeCode: '', referralCode: '' });
                                  }}
                                  className="px-2 py-1 rounded border border-slate-300 text-[10px] text-slate-600"
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
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

      {/* =================================================================== */}
      {/* MODAL 1: CHANGE DESIGNATION / ROLE & REPORTING SENIOR               */}
      {/* =================================================================== */}
      {isSuperAdmin && roleModalUser && (() => {
        const nextParentMeta = getParentQuotaLabel(roleModalDraft.role);
        const nextParentCandidates = getParentCandidatesForRole(roleModalDraft.role, users).filter(
          (p) => p.id !== roleModalUser.id
        );
        const roleChanged = roleModalDraft.role !== roleModalUser.role;
        const directDownline = users.filter(
          (c) => Number(c.reportsToUserId || 0) === Number(roleModalUser.id)
        );
        const replacementSeniors =
          roleChanged && directDownline.length > 0
            ? users.filter(
                (s) => s.isActive && s.role === roleModalUser.role && s.id !== roleModalUser.id
              )
            : [];

        return (
          <div
            className="fixed inset-0 z-50 bg-slate-900/55 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="role-transfer-modal-title"
          >
            <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg shadow-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
                <div>
                  <h3 id="role-transfer-modal-title" className="text-sm font-display font-bold text-[#0F2744]">
                    Change Designation &amp; Reporting Senior
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {roleModalUser.fullName} · <span className="font-mono">{roleModalUser.employeeCode}</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRoleModalUser(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                  aria-label="Close modal"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleSaveRoleAndSenior} className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Designation / Role
                  </label>
                  <select
                    value={roleModalDraft.role}
                    onChange={(e) => {
                      const nextRole = e.target.value as UserRole;
                      const candidates = getParentCandidatesForRole(nextRole, users).filter(
                        (p) => p.id !== roleModalUser.id
                      );
                      setRoleModalDraft((prev) => ({
                        ...prev,
                        role: nextRole,
                        reportsToUserId: candidates[0] ? String(candidates[0].id) : '',
                        transferExistingDownlineToUserId: '',
                      }));
                    }}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white text-slate-900"
                  >
                    {USER_ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.labelEn}
                      </option>
                    ))}
                  </select>
                </div>

                {nextParentMeta ? (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      {nextParentMeta.title}
                    </label>
                    <select
                      required
                      value={roleModalDraft.reportsToUserId}
                      onChange={(e) => {
                        const chosen = nextParentCandidates.find((p) => String(p.id) === e.target.value);
                        setRoleModalDraft((prev) => ({
                          ...prev,
                          reportsToUserId: e.target.value,
                          branchId: chosen?.branchId ? String(chosen.branchId) : prev.branchId,
                        }));
                      }}
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white text-slate-900"
                    >
                      <option value="">-- Select Reporting Senior --</option>
                      {nextParentCandidates.map((p) => {
                        const used = Number(p.childCount || 0);
                        const isCurrentParent = Number(p.id) === Number(roleModalUser.reportsToUserId || 0);
                        const isFull = !isCurrentParent && used >= nextParentMeta.max;
                        return (
                          <option key={p.id} value={String(p.id)} disabled={isFull}>
                            {p.fullName} ({p.employeeCode}) — {used}/{nextParentMeta.max} {nextParentMeta.unit}
                            {isCurrentParent ? ' [Current]' : isFull ? ' [FULL]' : ''}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Branch Office
                    </label>
                    <select
                      value={roleModalDraft.branchId}
                      onChange={(e) => setRoleModalDraft((prev) => ({ ...prev, branchId: e.target.value }))}
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white text-slate-900"
                    >
                      {branches.map((b) => (
                        <option key={b.id} value={String(b.id)}>
                          {b.name} ({b.code})
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Top-level role — no reporting senior required.
                    </p>
                  </div>
                )}

                {roleChanged && directDownline.length > 0 && (
                  <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 space-y-2">
                    <div className="text-xs font-semibold text-amber-900">
                      Existing Downline Detected ({directDownline.length} mapped staff)
                    </div>
                    <p className="text-[11px] text-amber-800">
                      Because {roleModalUser.fullName}&apos;s designation is changing from{' '}
                      <strong>{String(roleModalUser.role).replace(/_/g, ' ')}</strong>, choose another senior to take over
                      their {directDownline.length} downline staff (or leave unlinked to reassign later):
                    </p>
                    <select
                      value={roleModalDraft.transferExistingDownlineToUserId}
                      onChange={(e) =>
                        setRoleModalDraft((prev) => ({
                          ...prev,
                          transferExistingDownlineToUserId: e.target.value,
                        }))
                      }
                      className="w-full px-3 py-2 text-xs rounded-lg border border-amber-300 bg-white text-slate-900"
                    >
                      <option value="">Leave downline unlinked (reassign later)</option>
                      {replacementSeniors.map((s) => (
                        <option key={s.id} value={String(s.id)}>
                          Transfer all {directDownline.length} staff → {s.fullName} ({s.employeeCode}) [{s.childCount ?? 0}
                          {s.quotaMax ? `/${s.quotaMax}` : ''}]
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setRoleModalUser(null)}
                    className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingRoleChange}
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#0F2744] hover:bg-[#16365D] disabled:opacity-60 text-white"
                  >
                    {savingRoleChange ? 'Saving…' : 'Save Designation & Senior'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {/* =================================================================== */}
      {/* MODAL 2: BULK / TEAM DOWNLINE TRANSFER TO ANOTHER SENIOR            */}
      {/* =================================================================== */}
      {isSuperAdmin && transferModalOpen && (() => {
        const parentRole: UserRole =
          transferLevel === 'TEAM_LEADER'
            ? 'BRANCH_MANAGER'
            : transferLevel === 'FIELD_OFFICER'
            ? 'TEAM_LEADER'
            : 'FIELD_OFFICER';
        const quotaMax =
          transferLevel === 'TEAM_LEADER'
            ? HIERARCHY_LIMITS.TEAM_LEADERS_PER_BM
            : transferLevel === 'FIELD_OFFICER'
            ? HIERARCHY_LIMITS.FIELD_OFFICERS_PER_TL
            : HIERARCHY_LIMITS.REFERRALS_PER_FO;
        const seniorOptions = users.filter((u) => u.isActive && u.role === parentRole);
        const allLevelStaff = users.filter((u) => u.role === transferLevel);
        const visibleStaff = allLevelStaff.filter((emp) => {
          if (transferSourceSeniorId === 'ALL') return true;
          if (transferSourceSeniorId === 'UNASSIGNED') return !emp.reportsToUserId;
          return Number(emp.reportsToUserId || 0) === Number(transferSourceSeniorId);
        });

        const toggleSelectId = (id: number) => {
          setTransferSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
          );
        };

        return (
          <div
            className="fixed inset-0 z-50 bg-slate-900/55 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-transfer-modal-title"
          >
            <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
                <div>
                  <h3 id="bulk-transfer-modal-title" className="text-sm font-display font-bold text-[#0F2744]">
                    Transfer Downline Employees to Another Senior
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Move one or multiple Team Leaders, Field Officers, or Referrals to a different Senior with live quota checks
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setTransferModalOpen(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                  aria-label="Close transfer modal"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleConfirmBulkTransfer} className="p-5 space-y-4 overflow-y-auto">
                {/* Level Segmented Tabs */}
                <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {(
                    [
                      { id: 'TEAM_LEADER', label: 'Team Leaders (BM → BM)' },
                      { id: 'FIELD_OFFICER', label: 'Field Officers (TL → TL)' },
                      { id: 'REFERRAL_PARTNER', label: 'Referrals (FO → FO)' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => {
                        setTransferLevel(tab.id);
                        setTransferSourceSeniorId('ALL');
                        setTransferTargetSeniorId('');
                        setTransferSelectedIds([]);
                      }}
                      className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        transferLevel === tab.id ? 'bg-white text-[#0F2744] shadow-xs' : 'text-slate-600'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      1. Filter Current Senior (Source)
                    </label>
                    <select
                      value={transferSourceSeniorId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setTransferSourceSeniorId(val);
                        setTransferSelectedIds([]);
                      }}
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white text-slate-900"
                    >
                      <option value="ALL">All ({allLevelStaff.length})</option>
                      <option value="UNASSIGNED">
                        Unassigned / No Senior ({allLevelStaff.filter((x) => !x.reportsToUserId).length})
                      </option>
                      {seniorOptions.map((s) => (
                        <option key={s.id} value={String(s.id)}>
                          {s.fullName} ({s.employeeCode}) — {s.childCount ?? 0}/{quotaMax}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      2. Transfer To Destination Senior
                    </label>
                    <select
                      required
                      value={transferTargetSeniorId}
                      onChange={(e) => setTransferTargetSeniorId(e.target.value)}
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white text-slate-900"
                    >
                      <option value="">-- Choose Destination Senior --</option>
                      {seniorOptions
                        .filter((s) => String(s.id) !== transferSourceSeniorId)
                        .map((s) => {
                          const used = Number(s.childCount || 0);
                          const rem = Math.max(0, quotaMax - used);
                          return (
                            <option key={s.id} value={String(s.id)} disabled={rem === 0}>
                              {s.fullName} ({s.employeeCode}) — {used}/{quotaMax} ({rem} slots free)
                            </option>
                          );
                        })}
                    </select>
                  </div>
                </div>

                {/* Selectable Employee List */}
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-[#0F2744]">
                      3. Select Downline Staff ({transferSelectedIds.length} of {visibleStaff.length} selected)
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setTransferSelectedIds(visibleStaff.map((s) => Number(s.id)))}
                        className="text-[11px] font-semibold text-[#0F2744] underline"
                      >
                        Select All
                      </button>
                      <button
                        type="button"
                        onClick={() => setTransferSelectedIds([])}
                        className="text-[11px] font-semibold text-slate-500 underline"
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  <div className="max-h-56 overflow-y-auto divide-y divide-slate-100">
                    {visibleStaff.length === 0 ? (
                      <div className="p-6 text-center text-xs text-slate-500">
                        No downline staff found under this filter.
                      </div>
                    ) : (
                      visibleStaff.map((emp) => {
                        const checked = transferSelectedIds.includes(Number(emp.id));
                        return (
                          <label
                            key={emp.id}
                            className={`flex items-center justify-between gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-slate-50 ${
                              checked ? 'bg-blue-50/50' : ''
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSelectId(Number(emp.id))}
                                className="rounded border-slate-300"
                              />
                              <div className="min-w-0">
                                <div className="font-semibold text-[#0F2744] truncate">
                                  {emp.fullName}{' '}
                                  <span className="font-mono font-normal text-slate-500">({emp.employeeCode})</span>
                                </div>
                                <div className="text-[11px] text-slate-500">
                                  Current Senior: {emp.reportsToName ? `${emp.reportsToName} (${emp.reportsToCode})` : 'Unassigned'}
                                </div>
                              </div>
                            </div>
                            <span
                              className={`text-[11px] font-semibold shrink-0 ${
                                emp.isActive ? 'text-[#15803D]' : 'text-[#DC2626]'
                              }`}
                            >
                              {emp.isActive ? 'ON' : 'OFF'}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setTransferModalOpen(false)}
                    className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingTransfer || transferSelectedIds.length === 0 || !transferTargetSeniorId}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-[#EA580C] hover:bg-[#C2410C] disabled:opacity-50 text-white"
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5" />
                    {savingTransfer
                      ? 'Transferring…'
                      : `Transfer ${transferSelectedIds.length} Member${transferSelectedIds.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {/* =================================================================== */}
      {/* MODAL 3: PERMANENT DELETE EMPLOYEE ID (WITH SAFE DOWNLINE TRANSFER) */}
      {/* =================================================================== */}
      {isSuperAdmin && deleteModalUser && (() => {
        const directDownline = users.filter(
          (c) => Number(c.reportsToUserId || 0) === Number(deleteModalUser.id)
        );
        const replacementSeniors =
          directDownline.length > 0
            ? users.filter(
                (s) => s.isActive && s.role === deleteModalUser.role && s.id !== deleteModalUser.id
              )
            : [];

        return (
          <div
            className="fixed inset-0 z-50 bg-slate-900/55 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-user-modal-title"
          >
            <div className="bg-white border border-red-200 rounded-xl w-full max-w-md shadow-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-red-100 bg-red-50/70 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-[#DC2626] shrink-0" />
                  <h3 id="delete-user-modal-title" className="text-sm font-display font-bold text-[#991B1B]">
                    Delete Employee ID Permanently
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setDeleteModalUser(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-white/70"
                  aria-label="Close delete confirmation"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
                  <div className="font-semibold text-[#0F2744]">
                    {deleteModalUser.fullName}{' '}
                    <span className="font-mono text-[#EA580C]">({deleteModalUser.employeeCode})</span>
                  </div>
                  <div className="text-slate-500">
                    Designation: {deleteModalUser.role === 'LEAD_GENERATOR' ? 'Back Office Team' : String(deleteModalUser.role).replace(/_/g, ' ')}
                    {deleteModalUser.mobile ? ` · ${deleteModalUser.mobile}` : ''}
                  </div>
                </div>

                {directDownline.length > 0 && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 space-y-2">
                    <div className="text-xs font-semibold text-amber-900">
                      This ID has {directDownline.length} downline employee(s) mapped under it
                    </div>
                    <p className="text-[11px] text-amber-800">
                      Optionally transfer all {directDownline.length} downline employee(s) to another active senior before
                      deleting this ID:
                    </p>
                    <select
                      value={deleteTransferToId}
                      onChange={(e) => setDeleteTransferToId(e.target.value)}
                      className="w-full px-3 py-2 text-xs rounded-lg border border-amber-300 bg-white text-slate-900"
                    >
                      <option value="">Unlink downline staff (reassign later)</option>
                      {replacementSeniors.map((s) => (
                        <option key={s.id} value={String(s.id)}>
                          Transfer {directDownline.length} staff → {s.fullName} ({s.employeeCode}) [{s.childCount ?? 0}
                          {s.quotaMax ? `/${s.quotaMax}` : ''}]
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <p className="text-xs text-slate-600 leading-relaxed">
                  Deleting this ID permanently removes their login access, saved password, and Google Cloud backup record.
                  All historical customer leads and uploaded documents remain safely preserved under Admin/Replacement ownership.
                </p>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setDeleteModalUser(null)}
                    className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={deletingUser}
                    onClick={() => void handleConfirmDeleteUser()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-[#DC2626] hover:bg-red-700 disabled:opacity-60 text-white"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {deletingUser ? 'Deleting…' : 'Delete Employee ID'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export const AdminSettingsModule: React.FC<AdminSettingsProps> = (props) => (
  <CloudErrorBoundary>
    <AdminSettingsInner {...props} />
  </CloudErrorBoundary>
);

