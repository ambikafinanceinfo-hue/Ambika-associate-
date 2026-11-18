import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  CloudOff,
  Copy,
  Download,
  Eye,
  FileText,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  UserCheck,
  Clock,
  AlertTriangle,
  Award,
  X,
  Scale,
  Zap,
  Compass,
  Volume2,
  PhoneCall,
} from 'lucide-react';
import {
  CASE_STATUSES,
  DOCUMENT_CATEGORIES,
  LOST_LEAD_REASONS,
  PRODUCT_DOC_CHECKLIST,
  type AuthUser,
  type CaseStatus,
  type FollowupRecordingRecord,
  type LeadRecord,
  type LoadBalanceCandidate,
  type LoanProductConfig,
} from '../../shared/types';
import { ApiError, apiFetch, buildTelHref, formatDateTime, formatInr, getStoredToken } from '../lib/api';
import { t, type Lang } from '../lib/i18n';
import {
  attachDocsToQueuedLead,
  enqueueOfflineLead,
  getQueuedLeads,
  OFFLINE_QUEUE_EVENT,
  removeQueuedLead,
  syncOfflineLeadQueue,
  type QueuedLeadItem,
} from '../lib/offlineLeadQueue';
import {
  buildMissingDocReminder,
  buildQuoteText,
  computeMonthlyEmi,
  downloadQuoteCardPng,
  evaluateBankEligibility,
} from '../lib/salesEngine';
import { AdminCallRecordingsVault } from './AdminCallRecordingsVault';
import { DocumentScannerModal } from './DocumentScannerModal';
import { FollowupCallRecorder } from './FollowupCallRecorder';
import { LeadLoadBalancerPanel } from './LeadLoadBalancerPanel';
import { QuickCameraModal } from './QuickCameraModal';

interface LeadsModuleProps {
  user: AuthUser;
  lang: Lang;
  loanProducts: LoanProductConfig[];
  initialLeadId?: number | null;
  activeOption?: string | null;
  onSelectOption?: (opt: string | null, leadId?: number | null) => void;
  onBack?: () => void;
  prefillLead?: {
    customerName: string;
    customerMobile: string;
    panNumber: string;
    dob?: string;
    loanProduct: string;
    bankNbfc: string;
    remarks: string;
    scannedDocs?: {
      category: string;
      fileName: string;
      mimeType: string;
      dataBase64: string;
    }[];
  } | null;
  onClearPrefill?: () => void;
  onAlertsChanged: () => void;
}

const BANKS_NBFC = [
  'HDFC Bank',
  'ICICI Bank',
  'State Bank of India (SBI)',
  'Axis Bank',
  'Kotak Mahindra Bank',
  'Bajaj Finserv',
  'Tata Capital',
  'Aditya Birla Finance',
  'L&T Finance',
  'Cholamandalam Finance',
];

const OTHER_BANK_OPTION = 'Other';

export const LeadsModule: React.FC<LeadsModuleProps> = ({
  user,
  lang,
  loanProducts,
  initialLeadId,
  activeOption,
  onSelectOption,
  onBack,
  prefillLead,
  onClearPrefill,
  onAlertsChanged,
}) => {
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [sourceFilter, setSourceFilter] = useState<
    'ALL' | 'REFERRAL' | 'REFERRAL_TODAY' | 'FIELD_OFFICER' | 'FO_TODAY' | 'BACK_OFFICE' | 'UNASSIGNED'
  >('ALL');
  const [directory, setDirectory] = useState<{
    branches: any[];
    teams?: any[];
    branchManagers: any[];
    teamLeaders: any[];
    fieldOfficers: any[];
    referrals: any[];
  }>({ branches: [], teams: [], branchManagers: [], teamLeaders: [], fieldOfficers: [], referrals: [] });

  const [showCreateForm, setShowCreateForm] = useState(activeOption === 'new-lead');
  const [showLoadBalancer, setShowLoadBalancer] = useState(activeOption === 'load-balancer');
  const [showCallVault, setShowCallVault] = useState(
    activeOption === 'call-vault' && user.role === 'SUPER_ADMIN'
  );
  const defaultCreateMode: 'AUTO' | 'MANUAL' | 'UNASSIGNED' | 'BM' | 'TL' =
    user.role === 'LEAD_GENERATOR'
      ? 'BM'
      : user.role === 'BRANCH_MANAGER'
        ? 'TL'
        : user.role === 'TEAM_LEADER'
          ? 'MANUAL'
          : 'AUTO';
  const [createAssignmentMode, setCreateAssignmentMode] = useState<'AUTO' | 'MANUAL' | 'UNASSIGNED' | 'BM' | 'TL'>(
    defaultCreateMode
  );
  const [createAutoPreview, setCreateAutoPreview] = useState<LoadBalanceCandidate | null>(null);
  const [detailCandidates, setDetailCandidates] = useState<LoadBalanceCandidate[] | null>(null);
  const [autoAssigningDetail, setAutoAssigningDetail] = useState(false);
  const [duplicateNotice, setDuplicateNotice] = useState<{
    requestCode: string;
    existingLeadCode: string;
    matchedFields: string[];
  } | null>(null);
  const [offlineSavedNotice, setOfflineSavedNotice] = useState<{ queueId: string; customerName: string } | null>(null);
  const [queuedLeads, setQueuedLeads] = useState<QueuedLeadItem[]>([]);
  const [syncingQueue, setSyncingQueue] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [manualBankMode, setManualBankMode] = useState(false);
  const customBankInputRef = useRef<HTMLInputElement | null>(null);

  // New Lead Form state
  const [form, setForm] = useState({
    customerName: '',
    customerMobile: '',
    alternateMobile: '',
    panNumber: '',
    dob: '',
    address: '',
    city: '',
    state: '',
    pinCode: '',
    loanProduct: loanProducts[0]?.name || 'Home Loan',
    loanAmount: '',
    employmentType: 'Salaried',
    employmentDetails: '',
    monthlyIncome: '',
    existingEmi: '',
    bankNbfc: 'HDFC Bank',
    referralId: user.referralCode || '',
    referralName: user.role === 'REFERRAL_PARTNER' ? user.fullName : '',
    assignedBmId: '',
    assignedTlId: '',
    assignedOfficerId: '',
    assignedOfficerEmployeeCode: '',
    branchId: user.branchId ? String(user.branchId) : '1',
    remarks: '',
    customerConsent: false,
  });

  // Selected lead detail state
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(initialLeadId ?? null);
  const [detail, setDetail] = useState<{
    lead: LeadRecord;
    history: any[];
    documents: any[];
    reminders: any[];
    leadRewards?: any[];
    docCompletion?: { docsComplete: boolean; uploadedCount: number; requiredCount: number; missingDocs: string[] } | null;
    followupRecordings?: FollowupRecordingRecord[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Action states inside detail view
  const [newStatus, setNewStatus] = useState<CaseStatus>('Customer Contacted');
  const [lostReason, setLostReason] = useState<string>(LOST_LEAD_REASONS[0]);
  const [statusRemarks, setStatusRemarks] = useState('');
  const [applyWrongLeadPenalty, setApplyWrongLeadPenalty] = useState(false);
  const [wrongLeadAmount, setWrongLeadAmount] = useState(50);
  const [assignBmId, setAssignBmId] = useState('');
  const [assignTlId, setAssignTlId] = useState('');
  const [assignOfficerId, setAssignOfficerId] = useState('');
  const [assignOfficerCodeQuery, setAssignOfficerCodeQuery] = useState('');
  const [createOfficerQuery, setCreateOfficerQuery] = useState('');
  const [assignRemarks, setAssignRemarks] = useState('');
  const [reminderNote, setReminderNote] = useState('');
  const [reminderDueMins, setReminderDueMins] = useState(0);
  const [docCategory, setDocCategory] = useState<string>(DOCUMENT_CATEGORIES[0]);
  const [showScanner, setShowScanner] = useState(false);
  const [showQuickPanOcr, setShowQuickPanOcr] = useState(false);
  const [scannerTarget, setScannerTarget] = useState<'detail' | 'create'>('detail');
  const [pendingScannedDocs, setPendingScannedDocs] = useState<
    { category: string; fileName: string; mimeType: string; dataBase64: string }[]
  >([]);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; name: string; mime: string } | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [panOcrMsg, setPanOcrMsg] = useState<string | null>(null);

  const isReferral = user.role === 'REFERRAL_PARTNER';
  const isAdmin = user.role === 'SUPER_ADMIN';
  const isBackOffice = user.role === 'LEAD_GENERATOR';
  const isBranchManager = user.role === 'BRANCH_MANAGER';
  const isTeamLeader = user.role === 'TEAM_LEADER';
  const canAssign = ['SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER', 'LEAD_GENERATOR'].includes(user.role);

  const scopedTeamLeaders = useMemo(() => {
    const allTls = directory.teamLeaders || [];
    if (isBranchManager) {
      return allTls.filter(
        (tl) => tl.reportsToUserId === user.id || (user.branchId && tl.branchId === user.branchId)
      );
    }
    return allTls;
  }, [directory.teamLeaders, isBranchManager, user.id, user.branchId]);

  const scopedOfficers = useMemo(() => {
    const allFos = directory.fieldOfficers || [];
    if (isTeamLeader) {
      return allFos.filter(
        (fo) =>
          fo.id === user.id ||
          fo.reportsToUserId === user.id ||
          (user.teamId && fo.teamId === user.teamId)
      );
    }
    if (isBranchManager) {
      const bmTlIds = new Set(scopedTeamLeaders.map((t) => t.id));
      return allFos.filter(
        (fo) => (user.branchId && fo.branchId === user.branchId) || (fo.reportsToUserId && bmTlIds.has(fo.reportsToUserId))
      );
    }
    return allFos;
  }, [directory.fieldOfficers, isTeamLeader, isBranchManager, scopedTeamLeaders, user.id, user.teamId, user.branchId]);

  const filteredCreateOfficers = useMemo(() => {
    const q = createOfficerQuery.trim().toLowerCase();
    if (!q) return scopedOfficers;
    return scopedOfficers.filter(
      (fo) =>
        fo.fullName?.toLowerCase().includes(q) ||
        fo.employeeCode?.toLowerCase().includes(q) ||
        fo.branchName?.toLowerCase().includes(q)
    );
  }, [scopedOfficers, createOfficerQuery]);

  const filteredAssignOfficers = useMemo(() => {
    const q = assignOfficerCodeQuery.trim().toLowerCase();
    if (!q) return scopedOfficers;
    return scopedOfficers.filter(
      (fo) =>
        fo.fullName?.toLowerCase().includes(q) ||
        fo.employeeCode?.toLowerCase().includes(q) ||
        fo.branchName?.toLowerCase().includes(q)
    );
  }, [scopedOfficers, assignOfficerCodeQuery]);

  const loadLeads = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (sourceFilter !== 'ALL') params.set('source', sourceFilter);
      if (search.trim()) params.set('search', search.trim());
      const res = await apiFetch<{ leads: LeadRecord[] }>(`/leads?${params.toString()}`);
      setLeads(res.leads);
    } finally {
      setLoading(false);
    }
  };

  const loadDirectory = async () => {
    const res = await apiFetch<any>('/directory');
    setDirectory({
      branches: res.branches || [],
      teams: res.teams || [],
      branchManagers: res.branchManagers || [],
      teamLeaders: res.teamLeaders || [],
      fieldOfficers: res.fieldOfficers || [],
      referrals: res.referrals || [],
    });
  };

  const loadLeadDetail = async (id: number) => {
    setSelectedLeadId(id);
    setDetailLoading(true);
    setActionMsg(null);
    try {
      const res = await apiFetch<any>(`/leads/${id}`);
      setDetail(res);
      setNewStatus(res.lead.status);
      setAssignBmId(res.lead.assignedBmId ? String(res.lead.assignedBmId) : '');
      setAssignTlId(res.lead.assignedTlId ? String(res.lead.assignedTlId) : '');
      setAssignOfficerId(res.lead.assignedOfficerId ? String(res.lead.assignedOfficerId) : '');
      setAssignOfficerCodeQuery('');
    } finally {
      setDetailLoading(false);
    }
  };

  const loadQueuedLeads = async () => {
    try {
      const items = await getQueuedLeads();
      setQueuedLeads(items.filter((i) => i.endpoint === '/api/leads'));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadDirectory();
    loadQueuedLeads();

    const handleQueueEvt = () => {
      loadQueuedLeads();
    };
    const handleSwMsg = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === 'OFFLINE_LEADS_SYNCED') {
        loadQueuedLeads();
        loadLeads();
        onAlertsChanged();
      } else if (msg?.type === 'LEAD_QUEUED_OFFLINE') {
        loadQueuedLeads();
      }
    };
    window.addEventListener(OFFLINE_QUEUE_EVENT, handleQueueEvt);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSwMsg);
    }
    return () => {
      window.removeEventListener(OFFLINE_QUEUE_EVENT, handleQueueEvt);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleSwMsg);
      }
    };
  }, []);

  useEffect(() => {
    loadLeads();
  }, [statusFilter, sourceFilter, search]);

  useEffect(() => {
    if (initialLeadId) {
      if (selectedLeadId !== initialLeadId || !detail || detail.lead.id !== initialLeadId) {
        loadLeadDetail(initialLeadId);
      }
    } else if (initialLeadId === null && selectedLeadId !== null) {
      setSelectedLeadId(null);
      setDetail(null);
    }
  }, [initialLeadId]);

  useEffect(() => {
    if (activeOption === 'new-lead') {
      setShowCreateForm(true);
      setShowLoadBalancer(false);
      setShowCallVault(false);
    } else if (activeOption === 'load-balancer' && canAssign) {
      setShowCreateForm(false);
      setShowLoadBalancer(true);
      setShowCallVault(false);
    } else if (activeOption === 'call-vault' && isAdmin) {
      setShowCreateForm(false);
      setShowLoadBalancer(false);
      setShowCallVault(true);
    } else {
      setShowCreateForm(false);
      setShowLoadBalancer(false);
      setShowCallVault(false);
      if (
        activeOption &&
        ['ALL', 'REFERRAL', 'REFERRAL_TODAY', 'FIELD_OFFICER', 'FO_TODAY', 'BACK_OFFICE', 'UNASSIGNED'].includes(
          activeOption
        )
      ) {
        setSourceFilter(activeOption as any);
      } else if (activeOption === null) {
        setSourceFilter('ALL');
      }
    }
  }, [activeOption, canAssign, isAdmin]);

  // Live preview of best Field Officer inside Create Lead Form when Auto-Balance mode is active
  useEffect(() => {
    if (!showCreateForm || !canAssign || createAssignmentMode !== 'AUTO') {
      setCreateAutoPreview(null);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch<{ best: LoadBalanceCandidate | null }>('/leads/load-balance/preview', {
          method: 'POST',
          json: {
            city: form.city.trim() || null,
            state: form.state.trim() || null,
            pinCode: form.pinCode.trim() || null,
            address: form.address.trim() || null,
            branchId: form.branchId ? Number(form.branchId) : null,
          },
        });
        setCreateAutoPreview(res.best);
      } catch {
        // ignore preview failure offline
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [showCreateForm, canAssign, createAssignmentMode, form.city, form.state, form.pinCode, form.address, form.branchId]);

  useEffect(() => {
    if (prefillLead) {
      setShowCreateForm(true);
      if (prefillLead.bankNbfc) {
        setManualBankMode(!BANKS_NBFC.includes(prefillLead.bankNbfc.trim()));
      }
      setForm((prev) => ({
        ...prev,
        customerName: prefillLead.customerName || prev.customerName,
        customerMobile: prefillLead.customerMobile || prev.customerMobile,
        panNumber: prefillLead.panNumber || prev.panNumber,
        dob: prefillLead.dob || prev.dob,
        loanProduct: prefillLead.loanProduct || prev.loanProduct,
        bankNbfc: prefillLead.bankNbfc || prev.bankNbfc,
        remarks: prefillLead.remarks || prev.remarks,
      }));
      if (prefillLead.scannedDocs && prefillLead.scannedDocs.length > 0 && !isReferral) {
        setPendingScannedDocs((prev) => {
          const existing = new Set(prev.map((d) => d.fileName));
          const added = prefillLead.scannedDocs!.filter((d) => !existing.has(d.fileName));
          return [...prev, ...added];
        });
      }
      if (prefillLead.panNumber || prefillLead.customerName) {
        setPanOcrMsg(
          `Auto-filled from PAN OCR: ${[prefillLead.customerName, prefillLead.panNumber].filter(Boolean).join(' · ')}`
        );
      }
      onClearPrefill?.();
    }
  }, [prefillLead, isReferral]);

  const formEligibility = useMemo(() => {
    const reqAmt = Number(form.loanAmount || 0);
    const inc = Number(form.monthlyIncome || 0);
    if (reqAmt <= 0 && inc <= 0) return null;
    const prod = loanProducts.find((p) => p.name === form.loanProduct);
    return evaluateBankEligibility({
      loanProduct: form.loanProduct,
      requestedAmount: reqAmt,
      monthlyIncome: inc,
      existingEmi: Number(form.existingEmi || 0),
      employmentType: form.employmentType,
      baseRatePct: prod?.defaultRate,
    });
  }, [form.loanProduct, form.loanAmount, form.monthlyIncome, form.existingEmi, form.employmentType, loanProducts]);

  const resetLeadForm = () => {
    setPendingScannedDocs([]);
    setShowCreateForm(false);
    setCreateOfficerQuery('');
    setManualBankMode(false);
    setForm((prev) => ({
      ...prev,
      customerName: '',
      customerMobile: '',
      alternateMobile: '',
      panNumber: '',
      dob: '',
      address: '',
      city: '',
      state: '',
      pinCode: '',
      loanAmount: '',
      employmentDetails: '',
      monthlyIncome: '',
      existingEmi: '',
      bankNbfc: 'HDFC Bank',
      assignedOfficerId: '',
      assignedOfficerEmployeeCode: '',
      remarks: '',
      customerConsent: false,
    }));
  };

  const handleManualSyncQueue = async () => {
    setSyncingQueue(true);
    try {
      const outcomes = await syncOfflineLeadQueue(getStoredToken());
      await loadQueuedLeads();
      if (outcomes.some((o) => o.ok)) {
        await loadLeads();
        onAlertsChanged();
      }
    } finally {
      setSyncingQueue(false);
    }
  };

  const handleCreateLead = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setDuplicateNotice(null);
    setOfflineSavedNotice(null);

    const effectiveBankNbfc = form.bankNbfc.trim();
    if (!effectiveBankNbfc || effectiveBankNbfc.toLowerCase() === 'other') {
      setManualBankMode(true);
      setFormError('Please enter the Finance Company / Bank / NBFC name manually.');
      customBankInputRef.current?.focus();
      return;
    }

    setSubmitting(true);

    const leadPayload = {
      ...form,
      bankNbfc: effectiveBankNbfc,
      loanAmount: Number(form.loanAmount || 0),
      monthlyIncome: form.monthlyIncome ? Number(form.monthlyIncome) : null,
      existingEmi: form.existingEmi ? Number(form.existingEmi) : 0,
      assignmentMode: canAssign ? createAssignmentMode : undefined,
      assignedBmId:
        canAssign && createAssignmentMode === 'BM' && form.assignedBmId
          ? Number(form.assignedBmId)
          : null,
      assignedTlId:
        canAssign && createAssignmentMode === 'TL' && form.assignedTlId
          ? Number(form.assignedTlId)
          : null,
      assignedOfficerId:
        canAssign && createAssignmentMode === 'MANUAL' && form.assignedOfficerId
          ? Number(form.assignedOfficerId)
          : null,
      assignedOfficerEmployeeCode:
        canAssign && createAssignmentMode === 'MANUAL'
          ? form.assignedOfficerEmployeeCode.trim() || undefined
          : undefined,
      branchId: form.branchId ? Number(form.branchId) : null,
    };

    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const queued = await enqueueOfflineLead({
          endpoint: '/api/leads',
          payload: leadPayload,
          pendingDocs: !isReferral ? [...pendingScannedDocs] : [],
          authToken: getStoredToken(),
          customerName: form.customerName.trim(),
          loanProduct: form.loanProduct,
          loanAmount: Number(form.loanAmount || 0),
          bankNbfc: effectiveBankNbfc,
        });
        setOfflineSavedNotice({ queueId: queued.queueId, customerName: queued.customerName });
        resetLeadForm();
        await loadQueuedLeads();
        return;
      }

      const res = await apiFetch<any>('/leads', {
        method: 'POST',
        json: leadPayload,
      });

      if (res.queuedOffline) {
        if (!isReferral && pendingScannedDocs.length > 0 && res.queueId) {
          await attachDocsToQueuedLead(res.queueId, [...pendingScannedDocs]);
        }
        setOfflineSavedNotice({
          queueId: res.queueId || 'OFFLINE-QUEUED',
          customerName: form.customerName.trim(),
        });
        resetLeadForm();
        await loadQueuedLeads();
        return;
      }

      if (res.duplicateDetected) {
        setDuplicateNotice({
          requestCode: res.requestCode,
          existingLeadCode: res.existingLeadCode,
          matchedFields: res.matchedFields,
        });
        onAlertsChanged();
      } else {
        if (res.lead?.id && pendingScannedDocs.length > 0 && !isReferral) {
          for (const doc of pendingScannedDocs) {
            await apiFetch(`/leads/${res.lead.id}/documents`, {
              method: 'POST',
              json: doc,
            });
          }
        }
        resetLeadForm();
        await loadLeads();
        onAlertsChanged();
        if (res.lead?.id) loadLeadDetail(res.lead.id);
      }
    } catch (err: any) {
      if (!(err instanceof ApiError)) {
        // Network disconnection during submission -> store offline & queue Background Sync
        const queued = await enqueueOfflineLead({
          endpoint: '/api/leads',
          payload: leadPayload,
          pendingDocs: !isReferral ? [...pendingScannedDocs] : [],
          authToken: getStoredToken(),
          customerName: form.customerName.trim(),
          loanProduct: form.loanProduct,
          loanAmount: Number(form.loanAmount || 0),
          bankNbfc: effectiveBankNbfc,
        });
        setOfflineSavedNotice({ queueId: queued.queueId, customerName: queued.customerName });
        resetLeadForm();
        await loadQueuedLeads();
      } else {
        setFormError(err.message || 'Could not save lead');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleAssignToBm = async () => {
    if (!detail || !assignBmId) return;
    setActionMsg(null);
    try {
      await apiFetch(`/leads/${detail.lead.id}/assign`, {
        method: 'PATCH',
        json: {
          assignedBmId: Number(assignBmId),
          remarks: assignRemarks,
        },
      });
      setAssignRemarks('');
      setActionMsg('Lead routed to Branch Manager for Team Leader assignment.');
      await loadLeads();
      await loadLeadDetail(detail.lead.id);
      onAlertsChanged();
    } catch (err: any) {
      setActionMsg(err.message);
    }
  };

  const handleAssignToTl = async () => {
    if (!detail || !assignTlId) return;
    setActionMsg(null);
    try {
      await apiFetch(`/leads/${detail.lead.id}/assign`, {
        method: 'PATCH',
        json: {
          assignedTlId: Number(assignTlId),
          remarks: assignRemarks,
        },
      });
      setAssignRemarks('');
      setActionMsg('Lead routed to Team Leader to select a Field Officer.');
      await loadLeads();
      await loadLeadDetail(detail.lead.id);
      onAlertsChanged();
    } catch (err: any) {
      setActionMsg(err.message);
    }
  };

  const handleAssignLead = async () => {
    if (!detail) return;
    const trimmedQuery = assignOfficerCodeQuery.trim();
    const matchedByCode = trimmedQuery
      ? scopedOfficers.find(
          (fo) => fo.employeeCode?.toLowerCase() === trimmedQuery.toLowerCase()
        )
      : null;
    const effectiveOfficerId = assignOfficerId ? Number(assignOfficerId) : matchedByCode?.id;
    const effectiveCode = matchedByCode?.employeeCode || (!assignOfficerId && trimmedQuery ? trimmedQuery.toUpperCase() : undefined);

    if (!effectiveOfficerId && !effectiveCode) return;
    setActionMsg(null);
    try {
      await apiFetch(`/leads/${detail.lead.id}/assign`, {
        method: 'PATCH',
        json: {
          assignedOfficerId: effectiveOfficerId,
          assignedOfficerEmployeeCode: effectiveCode,
          remarks: assignRemarks,
        },
      });
      setAssignRemarks('');
      setAssignOfficerCodeQuery('');
      setDetailCandidates(null);
      setActionMsg('Lead assigned to Field Officer and 10-minute SLA timer started.');
      await loadLeads();
      await loadLeadDetail(detail.lead.id);
      onAlertsChanged();
    } catch (err: any) {
      setActionMsg(err.message);
    }
  };

  const handleLoadDetailCandidates = async () => {
    if (!detail) return;
    try {
      const res = await apiFetch<{ candidates: LoadBalanceCandidate[] }>('/leads/load-balance/preview', {
        method: 'POST',
        json: { leadId: detail.lead.id },
      });
      setDetailCandidates(res.candidates);
    } catch (err: any) {
      setActionMsg(err.message);
    }
  };

  const handleSmartAutoAssignDetail = async () => {
    if (!detail) return;
    setAutoAssigningDetail(true);
    setActionMsg(null);
    try {
      const res = await apiFetch<{ decision: LoadBalanceCandidate }>(`/leads/${detail.lead.id}/auto-assign`, {
        method: 'POST',
        json: { remarks: assignRemarks.trim() || undefined },
      });
      setAssignRemarks('');
      setDetailCandidates(null);
      setActionMsg(
        `Auto Load-Balanced to ${res.decision.officer.fullName} (${res.decision.officer.employeeCode}) · Score ${res.decision.compositeScore} (${res.decision.geoMatchReasons[0] || 'Workload Balanced'}).`
      );
      await loadLeads();
      await loadLeadDetail(detail.lead.id);
      onAlertsChanged();
    } catch (err: any) {
      setActionMsg(err.message);
    } finally {
      setAutoAssigningDetail(false);
    }
  };

  const handleStatusUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setActionMsg(null);
    const isLost = newStatus === 'Rejected' || newStatus === 'Closed';
    try {
      const res = await apiFetch<any>(`/leads/${detail.lead.id}/status`, {
        method: 'PATCH',
        json: {
          status: newStatus,
          remarks: statusRemarks,
          lostReason: isLost ? lostReason : undefined,
          wrongLeadPenalty:
            isLost && applyWrongLeadPenalty && canAssign
              ? { amount: wrongLeadAmount, reason: statusRemarks || lostReason }
              : undefined,
        },
      });
      setStatusRemarks('');
      setApplyWrongLeadPenalty(false);
      const awardedCount = res.rewardEval?.awardedEntries?.length || 0;
      const penNote = res.wrongLeadPenaltyApplied
        ? ` Wrong-lead penalty -₹${res.wrongLeadPenaltyApplied.amount} applied.`
        : '';
      const rewardNote =
        awardedCount > 0
          ? ` Staff reward points credited (${res.rewardEval.awardedEntries.map((r: any) => `+${r.points}`).join(', ')}).`
          : '';
      setActionMsg(`Case status updated to ${newStatus}.${rewardNote}${penNote}`);
      await loadLeads();
      await loadLeadDetail(detail.lead.id);
      onAlertsChanged();
    } catch (err: any) {
      setActionMsg(err.message);
    }
  };

  const handleCopyDetailQuote = async () => {
    if (!detail || isReferral) return;
    const prod = loanProducts.find((p) => p.name === detail.lead.loanProduct);
    const rate = prod?.defaultRate || 9.5;
    const tenure = detail.lead.loanProduct.includes('Home') ? 240 : detail.lead.loanProduct.includes('LAP') ? 180 : 60;
    const amt = Number(detail.lead.loanAmount || 0);
    const emi = computeMonthlyEmi(amt, rate, tenure);
    const text = buildQuoteText({
      lang,
      customerName: detail.lead.customerName,
      loanProduct: detail.lead.loanProduct,
      bankNbfc: detail.lead.bankNbfc,
      loanAmount: amt,
      ratePct: rate,
      tenureMonths: tenure,
      emi,
      leadCode: detail.lead.leadCode,
    });
    try {
      await navigator.clipboard.writeText(text);
      setActionMsg('Loan quote copied to clipboard.');
    } catch {
      // ignore
    }
  };

  const handleLogMissingDocReminder = async (missingDocs: string[]) => {
    if (!detail) return;
    await apiFetch(`/leads/${detail.lead.id}/doc-reminder`, {
      method: 'POST',
      json: { missingDocs },
    });
    setActionMsg(`Missing-document follow-up logged (${missingDocs.length} pending).`);
    await loadLeadDetail(detail.lead.id);
    onAlertsChanged();
  };

  const handleCreateReminder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    try {
      await apiFetch(`/leads/${detail.lead.id}/reminders`, {
        method: 'POST',
        json: { note: reminderNote || 'Follow-up call scheduled', dueInMinutes: reminderDueMins },
      });
      setReminderNote('');
      setActionMsg('Follow-up reminder scheduled with 10-minute SLA tracking.');
      await loadLeadDetail(detail.lead.id);
      onAlertsChanged();
    } catch (err: any) {
      setActionMsg(err.message);
    }
  };

  const handleDocumentUpload = async (file: File | undefined) => {
    if (!file || !detail) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await apiFetch(`/leads/${detail.lead.id}/documents`, {
          method: 'POST',
          json: {
            category: docCategory,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataBase64: reader.result as string,
          },
        });
        setActionMsg(`Uploaded ${docCategory}: ${file.name}`);
        await loadLeadDetail(detail.lead.id);
      } catch (err: any) {
        setActionMsg(err.message);
      }
    };
    reader.readAsDataURL(file);
  };

  const openDocPreview = (doc: any) => {
    const token = getStoredToken();
    setPreviewDoc({
      url: `/api/documents/${doc.id}/file?token=${encodeURIComponent(token || '')}`,
      name: doc.fileName,
      mime: doc.mimeType,
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            {t(lang, 'navLeads')}
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {isReferral
              ? 'View your submitted leads, current case status, and assigned Field Officer contact.'
              : 'Lead Generation, Duplicate Detection, Case Status Tracking, Follow-ups, and KYC Documents.'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            const nextOpen = !showCreateForm;
            setShowCreateForm(nextOpen);
            setDuplicateNotice(null);
            setFormError(null);
            onSelectOption?.(nextOpen ? 'new-lead' : sourceFilter === 'ALL' ? null : sourceFilter, selectedLeadId);
          }}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold whitespace-nowrap"
        >
          {showCreateForm ? <ArrowLeft className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showCreateForm ? `${t(lang, 'navBack')} to Leads` : t(lang, 'newLead')}
        </button>
      </div>

      {/* Offline Saved Confirmation Banner */}
      {offlineSavedNotice && (
        <div className="p-4 rounded-xl bg-blue-50 border border-blue-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs text-[#0F2744]">
            <CloudOff className="w-4 h-4 text-[#EA580C] shrink-0" />
            <span>
              <strong>{offlineSavedNotice.customerName}</strong> saved offline on this device (
              <span className="font-mono font-semibold">{offlineSavedNotice.queueId}</span>). It will automatically
              sync to the CRM server as soon as internet connectivity is restored.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setOfflineSavedNotice(null)}
            className="text-slate-400 hover:text-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Pending Offline Sync Queue */}
      {queuedLeads.length > 0 && (
        <div className="bg-white border border-amber-300 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-display font-bold text-[#0F2744]">
              <CloudOff className="w-4 h-4 text-[#EA580C]" />
              <span>Pending Offline Lead Submissions ({queuedLeads.length})</span>
            </div>
            <button
              type="button"
              disabled={syncingQueue}
              onClick={handleManualSyncQueue}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncingQueue ? 'animate-spin' : ''}`} />
              {syncingQueue ? 'Syncing...' : 'Sync Queued Leads'}
            </button>
          </div>
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
            {queuedLeads.map((q) => (
              <div key={q.queueId} className="px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <div className="font-semibold text-[#0F2744]">
                    {q.customerName} · <span className="font-mono text-[11px] text-slate-500">{q.queueId}</span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {q.loanProduct} · {q.bankNbfc} · {formatInr(q.loanAmount)}
                    {q.pendingDocs && q.pendingDocs.length > 0 ? ` · ${q.pendingDocs.length} scanned doc(s)` : ''}
                  </div>
                  {q.lastError && <div className="text-[11px] text-[#DC2626] mt-0.5">{q.lastError}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[11px] font-semibold ${
                      q.status === 'FAILED' ? 'text-[#DC2626]' : 'text-[#D97706]'
                    }`}
                  >
                    {q.status === 'FAILED' ? 'Sync Error' : q.status === 'SYNCING' ? 'Syncing...' : 'Waiting for Network'}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      await removeQueuedLead(q.queueId);
                      await loadQueuedLeads();
                    }}
                    title="Discard queued entry"
                    className="p-1 text-slate-400 hover:text-[#DC2626]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Duplicate Detection Alert Banner */}
      {duplicateNotice && (
        <div className="p-5 rounded-xl bg-amber-50 border border-amber-300 space-y-2">
          <div className="flex items-center gap-2 text-amber-900 font-display font-bold text-base">
            <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0" />
            <span>{t(lang, 'duplicateBannerTitle')}</span>
          </div>
          <p className="text-sm text-amber-900">
            This lead was NOT created directly. It has been held as request{' '}
            <span className="font-mono font-bold">{duplicateNotice.requestCode}</span> and sent to the Admin Duplicate
            Verification &amp; Approval queue.
          </p>
          <div className="text-xs text-amber-800 flex flex-wrap gap-4 pt-1">
            <span>
              Existing Lead ID: <strong className="font-mono">{duplicateNotice.existingLeadCode}</strong>
            </span>
            <span>
              Matched Fields: <strong>{duplicateNotice.matchedFields.join(', ')}</strong>
            </span>
          </div>
        </div>
      )}

      {/* New Lead Generation Form */}
      {showCreateForm && (
        <form
          onSubmit={handleCreateLead}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
        >
          <div className="flex items-center justify-between pb-3 border-b border-slate-200 gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => {
                  if (onBack) onBack();
                  else {
                    setShowCreateForm(false);
                    onSelectOption?.(sourceFilter === 'ALL' ? null : sourceFilter, selectedLeadId);
                  }
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-[#0F2744] shrink-0"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {t(lang, 'navBack')}
              </button>
              <div className="min-w-0">
                <h2 className="text-base font-display font-bold text-[#0F2744] truncate">
                  Generate New Customer Lead
                </h2>
                <p className="text-xs text-slate-500 truncate">
                  Lead ID (AMB-YYYY-XXXX) is auto-generated. Duplicate checks run on Name, Mobile, PAN &amp; Referral.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowCreateForm(false);
                onSelectOption?.(sourceFilter === 'ALL' ? null : sourceFilter, selectedLeadId);
              }}
              className="p-1.5 text-slate-400 hover:text-slate-700 shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {formError && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
              {formError}
            </div>
          )}

          {/* Quick PAN Card OCR Auto-Fill Banner */}
          <div className="p-3.5 rounded-lg bg-emerald-50/80 border border-emerald-200 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-bold text-[#0F2744] flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-[#15803D] shrink-0" />
                  PAN Card Camera OCR Auto-Fill
                </div>
                <div className="text-[11px] text-slate-600">
                  Capture or upload a PAN card to automatically extract Customer Name, PAN Number &amp; DOB into this form.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowQuickPanOcr(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold whitespace-nowrap shrink-0 shadow-xs"
              >
                <Camera className="w-3.5 h-3.5" />
                Scan PAN Card (OCR)
              </button>
            </div>
            {panOcrMsg && (
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-white border border-emerald-300 text-[11px] font-medium text-[#15803D]">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  {panOcrMsg}
                </span>
                <button
                  type="button"
                  onClick={() => setPanOcrMsg(null)}
                  className="text-slate-400 hover:text-slate-700"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Customer Full Name *</label>
              <input
                type="text"
                required
                value={form.customerName}
                onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Customer Mobile *</label>
              <input
                type="tel"
                required
                value={form.customerMobile}
                onChange={(e) => setForm({ ...form, customerMobile: e.target.value })}
                placeholder="10-digit mobile"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Alternate Mobile</label>
              <input
                type="tel"
                value={form.alternateMobile}
                onChange={(e) => setForm({ ...form, alternateMobile: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">PAN Card Number</label>
              <input
                type="text"
                maxLength={10}
                value={form.panNumber}
                onChange={(e) => setForm({ ...form, panNumber: e.target.value.toUpperCase() })}
                placeholder="ABCDE1234F"
                className="w-full px-3 py-2 text-sm font-mono uppercase border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Date of Birth</label>
              <input
                type="date"
                value={form.dob}
                onChange={(e) => setForm({ ...form, dob: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Loan Product *</label>
              <select
                value={form.loanProduct}
                onChange={(e) => setForm({ ...form, loanProduct: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {loanProducts.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Loan Amount Required (₹) *</label>
              <input
                type="number"
                required
                min={10000}
                value={form.loanAmount}
                onChange={(e) => setForm({ ...form, loanAmount: e.target.value })}
                placeholder="e.g. 2500000"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              {(() => {
                const isCustomBank =
                  manualBankMode || (Boolean(form.bankNbfc) && !BANKS_NBFC.includes(form.bankNbfc));
                return (
                  <>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="block text-xs font-semibold text-slate-700">
                        Bank / NBFC / Finance Company *
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          if (isCustomBank) {
                            setManualBankMode(false);
                            setForm((prev) => ({
                              ...prev,
                              bankNbfc: BANKS_NBFC.includes(prev.bankNbfc)
                                ? prev.bankNbfc
                                : BANKS_NBFC[0] || 'HDFC Bank',
                            }));
                          } else {
                            setManualBankMode(true);
                            setForm((prev) => ({
                              ...prev,
                              bankNbfc: BANKS_NBFC.includes(prev.bankNbfc) ? '' : prev.bankNbfc,
                            }));
                            window.requestAnimationFrame(() => customBankInputRef.current?.focus());
                          }
                        }}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0F2744] hover:text-[#EA580C]"
                      >
                        <Pencil className="w-3 h-3" />
                        {isCustomBank ? 'Select from List' : 'Type Manually'}
                      </button>
                    </div>
                    <select
                      value={isCustomBank ? OTHER_BANK_OPTION : form.bankNbfc}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === OTHER_BANK_OPTION) {
                          setManualBankMode(true);
                          setForm((prev) => ({
                            ...prev,
                            bankNbfc: BANKS_NBFC.includes(prev.bankNbfc) ? '' : prev.bankNbfc,
                          }));
                          window.requestAnimationFrame(() => customBankInputRef.current?.focus());
                        } else {
                          setManualBankMode(false);
                          setForm((prev) => ({ ...prev, bankNbfc: val }));
                        }
                      }}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      {BANKS_NBFC.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                      <option value={OTHER_BANK_OPTION}>Other (Type Custom Bank / NBFC)</option>
                    </select>
                    {isCustomBank && (
                      <div className="mt-2">
                        <input
                          ref={customBankInputRef}
                          type="text"
                          required
                          value={form.bankNbfc}
                          onChange={(e) => setForm((prev) => ({ ...prev, bankNbfc: e.target.value }))}
                          placeholder="Enter Finance Company / Bank / NBFC name (e.g. PNB Housing, Piramal)"
                          className="w-full px-3 py-2 text-sm border border-[#0F2744]/40 rounded-lg bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0F2744]/20"
                        />
                        <p className="text-[11px] text-slate-500 mt-1">
                          Enter the custom Bank, NBFC, or Finance Company name not listed above.
                        </p>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Monthly Income (₹)</label>
              <input
                type="number"
                value={form.monthlyIncome}
                onChange={(e) => setForm({ ...form, monthlyIncome: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Existing Monthly EMIs (₹)</label>
              <input
                type="number"
                min={0}
                value={form.existingEmi}
                onChange={(e) => setForm({ ...form, existingEmi: e.target.value })}
                placeholder="0"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Employment Profile</label>
              <select
                value={form.employmentType}
                onChange={(e) => setForm({ ...form, employmentType: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="Salaried">Salaried</option>
                <option value="Self-Employed">Self-Employed / Professional</option>
                <option value="Business">Business Owner</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Residential / Business Address</label>
              <input
                type="text"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">City</label>
              <input
                type="text"
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">State</label>
              <input
                type="text"
                value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Pin Code</label>
              <input
                type="text"
                maxLength={6}
                value={form.pinCode}
                onChange={(e) => setForm({ ...form, pinCode: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Employment / Business Details</label>
              <input
                type="text"
                value={form.employmentDetails}
                onChange={(e) => setForm({ ...form, employmentDetails: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Referral ID</label>
              <input
                type="text"
                readOnly={isReferral}
                value={form.referralId}
                onChange={(e) => setForm({ ...form, referralId: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg bg-slate-50/50"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Referral Name</label>
              <input
                type="text"
                readOnly={isReferral}
                value={form.referralName}
                onChange={(e) => setForm({ ...form, referralName: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-slate-50/50"
              />
            </div>
            {canAssign && (
              <div className="sm:col-span-2 lg:col-span-3 p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-[#0F2744] flex items-center gap-1.5">
                    <UserCheck className="w-4 h-4 text-[#EA580C]" />
                    Hierarchical Lead Routing (Back Office → BM → TL → Field Officer)
                  </label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(
                      [
                        ...(isAdmin || isBackOffice
                          ? [{ id: 'BM', label: 'Assign Branch BM' }]
                          : []),
                        ...(isAdmin || isBranchManager
                          ? [{ id: 'TL', label: 'Assign Team Leader' }]
                          : []),
                        ...(isAdmin || isTeamLeader || isBranchManager
                          ? [
                              { id: 'MANUAL', label: 'Pick Field Officer' },
                              { id: 'AUTO', label: 'Auto Load-Balance' },
                            ]
                          : []),
                        { id: 'UNASSIGNED', label: 'Leave Unassigned' },
                      ] as const
                    ).map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => setCreateAssignmentMode(mode.id as any)}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors ${
                          createAssignmentMode === mode.id
                            ? 'bg-[#0F2744] text-white border-[#0F2744]'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                        }`}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                </div>

                {createAssignmentMode === 'BM' && (
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Select Branch Manager (BM) for this Branch
                    </label>
                    <select
                      value={form.assignedBmId}
                      onChange={(e) => {
                        const bm = (directory.branchManagers || []).find((b) => String(b.id) === e.target.value);
                        setForm((prev) => ({
                          ...prev,
                          assignedBmId: e.target.value,
                          branchId: bm?.branchId ? String(bm.branchId) : prev.branchId,
                        }));
                      }}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Select Branch Manager (Name · Employee ID · Branch)...</option>
                      {(directory.branchManagers || []).map((bm) => (
                        <option key={bm.id} value={bm.id}>
                          {bm.fullName} ({bm.employeeCode}){bm.branchName ? ` — ${bm.branchName}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {createAssignmentMode === 'TL' && (
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Select Team Leader (TL)
                    </label>
                    <select
                      value={form.assignedTlId}
                      onChange={(e) => setForm((prev) => ({ ...prev, assignedTlId: e.target.value }))}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Select Team Leader...</option>
                      {scopedTeamLeaders.map((tl) => (
                        <option key={tl.id} value={tl.id}>
                          {tl.fullName} ({tl.employeeCode}){tl.branchName ? ` — ${tl.branchName}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {createAssignmentMode === 'AUTO' && (
                  <div className="p-3 rounded-lg bg-emerald-50/80 border border-emerald-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 text-[#0F2744]">
                      <Zap className="w-4 h-4 text-[#15803D] shrink-0" />
                      {createAutoPreview ? (
                        <span>
                          Auto-Balance Preview:{' '}
                          <strong className="text-[#15803D]">
                            {createAutoPreview.officer.fullName} ({createAutoPreview.officer.employeeCode})
                          </strong>{' '}
                          · {createAutoPreview.geoMatchReasons[0]} ·{' '}
                          <span className="font-mono">
                            Active Load: {createAutoPreview.officer.activeLeadCount} · Score{' '}
                            {createAutoPreview.compositeScore}
                          </span>
                        </span>
                      ) : (
                        <span>
                          Will automatically route this lead to the best active Field Officer based on City/PIN code &amp;
                          lowest current workload.
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {createAssignmentMode === 'MANUAL' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Search Name / Enter Employee ID
                      </label>
                      <input
                        type="text"
                        value={createOfficerQuery}
                        onChange={(e) => {
                          const val = e.target.value;
                          setCreateOfficerQuery(val);
                          const exact = scopedOfficers.find(
                            (fo) => fo.employeeCode?.toLowerCase() === val.trim().toLowerCase()
                          );
                          if (exact) {
                            setForm((prev) => ({
                              ...prev,
                              assignedOfficerId: String(exact.id),
                              assignedOfficerEmployeeCode: exact.employeeCode,
                            }));
                          } else if (!val.trim()) {
                            setForm((prev) => ({ ...prev, assignedOfficerEmployeeCode: '' }));
                          }
                        }}
                        placeholder="Type FO001 or officer name..."
                        className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Field Officer Name · Employee ID
                      </label>
                      <select
                        value={form.assignedOfficerId}
                        onChange={(e) => {
                          const selected = scopedOfficers.find((fo) => String(fo.id) === e.target.value);
                          setForm({
                            ...form,
                            assignedOfficerId: e.target.value,
                            assignedOfficerEmployeeCode: selected?.employeeCode || '',
                          });
                        }}
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        <option value="">Select Field Officer...</option>
                        {filteredCreateOfficers.map((fo) => (
                          <option key={fo.id} value={fo.id}>
                            {fo.fullName} — {fo.employeeCode}
                            {fo.serviceCity || fo.branchName ? ` (${fo.serviceCity || fo.branchName})` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Remarks</label>
              <input
                type="text"
                value={form.remarks}
                onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {/* Instant Pre-Eligibility & Top 3 Bank Matcher */}
          {formEligibility && (
            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="font-semibold text-[#0F2744] flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-[#EA580C]" />
                  Instant Bank Pre-Eligibility &amp; Matcher
                </div>
                <div className="font-mono tabular-nums text-slate-700">
                  Max Eligible: <strong className="text-[#15803D]">{formatInr(formEligibility.maxEligibleAmount)}</strong> · FOIR:{' '}
                  <strong>{formEligibility.totalFoirPct}%</strong> · Odds:{' '}
                  <strong
                    className={
                      formEligibility.overallOdds === 'HIGH'
                        ? 'text-[#15803D]'
                        : formEligibility.overallOdds === 'MODERATE'
                        ? 'text-[#D97706]'
                        : 'text-[#DC2626]'
                    }
                  >
                    {formEligibility.overallOdds}
                  </strong>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {formEligibility.recommendations.map((rec) => (
                  <div key={rec.bank} className="p-2.5 rounded-lg bg-white border border-slate-200 text-xs flex flex-col justify-between gap-2">
                    <div>
                      <div className="font-semibold text-[#0F2744] flex justify-between">
                        <span>{rec.bank}</span>
                        <span className="font-mono text-[#EA580C]">{rec.indicativeRate}%</span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">{rec.reason}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setManualBankMode(!BANKS_NBFC.includes(rec.bank));
                        setForm((prev) => ({ ...prev, bankNbfc: rec.bank }));
                      }}
                      className={`w-full py-1 rounded text-[11px] font-semibold border ${
                        form.bankNbfc === rec.bank
                          ? 'bg-[#0F2744] text-white border-[#0F2744]'
                          : 'border-slate-300 text-[#0F2744] hover:bg-slate-50'
                      }`}
                    >
                      {form.bankNbfc === rec.bank ? 'Selected Bank' : 'Select Bank'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!isReferral && (
            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-[#0F2744]">
                    Scan &amp; Attach KYC Documents (Optional)
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Capture with real-time perspective correction &amp; grayscale enhancement before submitting.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setScannerTarget('create');
                    setShowScanner(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                >
                  <Camera className="w-3.5 h-3.5" />
                  Start Camera Scan
                </button>
              </div>
              {pendingScannedDocs.length > 0 && (
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-white">
                  {pendingScannedDocs.map((doc, idx) => (
                    <div key={idx} className="px-3 py-2 flex items-center justify-between text-xs">
                      <span>
                        <strong>{doc.category}</strong> · <span className="font-mono">{doc.fileName}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setPendingScannedDocs((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-[#DC2626] font-semibold hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              required
              checked={form.customerConsent}
              onChange={(e) => setForm({ ...form, customerConsent: e.target.checked })}
              className="mt-0.5 rounded border-slate-300 accent-[#15803D]"
            />
            <span>
              I confirm that the customer has provided explicit consent to share their details with AMBIKA ASSOCIATE
              and partner Banks/NBFCs for loan processing.
            </span>
          </label>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="px-4 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold disabled:opacity-50"
            >
              {submitting ? 'Checking Duplicates & Saving...' : t(lang, 'submitLead')}
            </button>
          </div>
        </form>
      )}

      {/* Lead Origin / Distribution Queue Filter Tabs + Auto Load-Balancer (Internal Staff) */}
      {!isReferral && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {(isAdmin || isBackOffice
              ? [
                  { id: 'ALL', label: 'All Leads' },
                  { id: 'REFERRAL_TODAY', label: "Today's Referral Leads" },
                  { id: 'REFERRAL', label: 'All Referral Leads (Assign BM)' },
                  { id: 'FO_TODAY', label: "Today's FO Leads" },
                  { id: 'FIELD_OFFICER', label: 'Field Officer Generated' },
                  { id: 'BACK_OFFICE', label: 'Back Office Generated' },
                  { id: 'UNASSIGNED', label: 'Unassigned Pool' },
                ]
              : canAssign
                ? [
                    { id: 'ALL', label: 'All Branch / Team Leads' },
                    { id: 'FO_TODAY', label: "Today's FO Leads" },
                    { id: 'FIELD_OFFICER', label: 'Field Officer Generated' },
                    { id: 'UNASSIGNED', label: 'Awaiting Next Assignment' },
                  ]
                : [
                    { id: 'ALL', label: 'All My Leads' },
                    { id: 'FO_TODAY', label: "Today's Self Leads" },
                    { id: 'FIELD_OFFICER', label: 'Self-Generated Leads' },
                  ]
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setShowLoadBalancer(false);
                  setShowCallVault(false);
                  setSourceFilter(tab.id as any);
                  onSelectOption?.(tab.id === 'ALL' ? null : tab.id, selectedLeadId);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
                  !showLoadBalancer && !showCallVault && sourceFilter === tab.id
                    ? 'bg-[#0F2744] text-white border-[#0F2744]'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  const next = !showCallVault;
                  setShowCallVault(next);
                  setShowLoadBalancer(false);
                  setShowCreateForm(false);
                  onSelectOption?.(next ? 'call-vault' : sourceFilter === 'ALL' ? null : sourceFilter, selectedLeadId);
                }}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
                  showCallVault
                    ? 'bg-[#0F2744] text-white border-[#0F2744]'
                    : 'bg-orange-50 text-[#EA580C] border-orange-300 hover:bg-orange-100'
                }`}
              >
                <Volume2 className="w-3.5 h-3.5" />
                Call Recordings (7d)
              </button>
            )}

            {canAssign && (
              <button
                type="button"
                onClick={() => {
                  const next = !showLoadBalancer;
                  setShowLoadBalancer(next);
                  setShowCallVault(false);
                  setShowCreateForm(false);
                  onSelectOption?.(next ? 'load-balancer' : sourceFilter === 'ALL' ? null : sourceFilter, selectedLeadId);
                }}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
                  showLoadBalancer
                    ? 'bg-[#EA580C] text-white border-[#EA580C]'
                    : 'bg-emerald-50 text-[#15803D] border-emerald-300 hover:bg-emerald-100'
                }`}
              >
                <Scale className="w-3.5 h-3.5" />
                Auto Load-Balancer
              </button>
            )}
          </div>
        </div>
      )}

      {showCallVault && isAdmin ? (
        <AdminCallRecordingsVault
          onOpenLead={(leadId) => {
            setShowCallVault(false);
            onSelectOption?.(sourceFilter === 'ALL' ? null : sourceFilter, leadId);
            loadLeadDetail(leadId);
          }}
        />
      ) : showLoadBalancer && canAssign ? (
        <LeadLoadBalancerPanel
          user={user}
          branches={directory.branches}
          onDistributed={() => {
            loadLeads();
            onAlertsChanged();
          }}
          onOpenLead={(leadId) => {
            setShowLoadBalancer(false);
            onSelectOption?.(sourceFilter === 'ALL' ? null : sourceFilter, leadId);
            loadLeadDetail(leadId);
          }}
        />
      ) : (
        <>
          {/* Search & Filter Toolbar */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t(lang, 'searchLeadsPlaceholder')}
                className="w-full pl-9 pr-4 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:border-[#0F2744]"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700"
            >
              <option value="ALL">All Case Statuses ({leads.length})</option>
              {CASE_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </div>

          {/* Main Split: Leads Table + Detail Panel */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        <div className={`${selectedLeadId ? 'xl:col-span-7' : 'xl:col-span-12'} bg-white border border-slate-200 rounded-xl overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="text-left font-semibold px-4 py-3">Lead ID</th>
                  <th className="text-left font-semibold px-4 py-3">Customer</th>
                  <th className="text-left font-semibold px-4 py-3">Product · Bank</th>
                  {!isReferral && <th className="text-right font-semibold px-4 py-3">Amount</th>}
                  <th className="text-left font-semibold px-4 py-3">Routing Chain (BM → TL → FO)</th>
                  <th className="text-left font-semibold px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-xs text-slate-500">
                      Loading leads...
                    </td>
                  </tr>
                )}
                {!loading &&
                  leads.map((lead) => (
                    <tr
                      key={lead.id}
                      onClick={() => {
                        loadLeadDetail(lead.id);
                        onSelectOption?.(sourceFilter === 'ALL' ? null : sourceFilter, lead.id);
                      }}
                      className={`cursor-pointer transition-colors hover:bg-slate-50 ${
                        selectedLeadId === lead.id ? 'bg-orange-50/60' : ''
                      }`}
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-mono text-xs font-semibold text-[#0F2744]">{lead.leadCode}</div>
                        {!isReferral && lead.createdByName && (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            By {lead.createdByName} ({lead.createdByCode || lead.createdByRole?.replace('_', ' ')})
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">{lead.customerName}</div>
                        <div className="text-xs font-mono mt-0.5">
                          {lead.redactedForReferral ? (
                            <span className="text-slate-500">Protected Contact</span>
                          ) : lead.customerMobile ? (
                            <a
                              href={buildTelHref(lead.customerMobile)}
                              onClick={(e) => e.stopPropagation()}
                              title={`Call ${lead.customerName} (${lead.customerMobile})`}
                              className="inline-flex items-center gap-1 font-semibold text-[#15803D] hover:text-green-800 hover:underline"
                            >
                              <PhoneCall className="w-3 h-3 shrink-0" />
                              <span>{lead.customerMobile}</span>
                            </a>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-slate-800 text-xs font-medium">{lead.loanProduct}</div>
                        <div className="text-xs text-slate-500">{lead.bankNbfc}</div>
                      </td>
                      {!isReferral && (
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-xs font-semibold text-slate-800 whitespace-nowrap">
                          {formatInr(lead.loanAmount)}
                        </td>
                      )}
                      <td className="px-4 py-3 text-xs">
                        {!isReferral && (lead.assignedBmName || lead.assignedTlName) && (
                          <div className="text-[10px] text-slate-500 mb-0.5">
                            {lead.assignedBmName ? `BM: ${lead.assignedBmName}` : 'No BM'}
                            {lead.assignedTlName ? ` → TL: ${lead.assignedTlName}` : ''}
                          </div>
                        )}
                        {lead.assignedOfficerName ? (
                          <div>
                            <div className="font-medium text-slate-800">
                              FO: {lead.assignedOfficerName}{' '}
                              {lead.assignedOfficerCode && (
                                <span className="font-mono text-[11px] text-[#0F2744]">({lead.assignedOfficerCode})</span>
                              )}
                            </div>
                            {lead.assignedOfficerMobile && (
                              <a
                                href={buildTelHref(lead.assignedOfficerMobile)}
                                onClick={(e) => e.stopPropagation()}
                                title={`Call ${lead.assignedOfficerName}`}
                                className="inline-flex items-center gap-1 font-mono text-[#0F2744] hover:text-[#EA580C] hover:underline"
                              >
                                <PhoneCall className="w-3 h-3 shrink-0" />
                                <span>{lead.assignedOfficerMobile}</span>
                              </a>
                            )}
                          </div>
                        ) : lead.assignedTlName ? (
                          <span className="text-[#EA580C] font-semibold">With TL · Assign Field Officer</span>
                        ) : lead.assignedBmName ? (
                          <span className="text-[#D97706] font-semibold">With BM · Assign Team Leader</span>
                        ) : (
                          <span className="text-[#D97706] font-semibold">Back Office Queue · Assign BM</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs font-semibold whitespace-nowrap">
                        <span
                          className={
                            lead.status === 'Disbursed' || lead.status === 'Approved'
                              ? 'text-[#15803D]'
                              : lead.status === 'Rejected'
                              ? 'text-[#DC2626]'
                              : 'text-[#0F2744]'
                          }
                        >
                          {lead.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                {!loading && leads.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-xs text-slate-500">
                      No leads found matching your criteria.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Lead Detail Drawer */}
        {selectedLeadId && (
          <div className="xl:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
            {detailLoading || !detail ? (
              <div className="py-10 text-center text-xs text-slate-500">Loading case file...</div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200">
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        if (onBack) onBack();
                        else {
                          setSelectedLeadId(null);
                          setDetail(null);
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 mb-2 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-[11px] font-semibold text-[#0F2744]"
                    >
                      <ArrowLeft className="w-3 h-3" />
                      {t(lang, 'navBack')} to List
                    </button>
                    <div className="text-xs font-mono font-semibold text-[#EA580C]">
                      {detail.lead.leadCode} · {detail.lead.status}
                    </div>
                    <h2 className="text-lg font-display font-bold text-[#0F2744] mt-0.5">
                      {detail.lead.customerName}
                    </h2>
                    <div className="text-xs text-slate-500 mt-1">
                      {detail.lead.loanProduct} · {detail.lead.bankNbfc}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedLeadId(null);
                      setDetail(null);
                      onSelectOption?.(sourceFilter === 'ALL' ? null : sourceFilter, null);
                    }}
                    className="p-1.5 text-slate-400 hover:text-slate-700"
                    aria-label="Close lead detail"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {actionMsg && (
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs font-medium text-[#0F2744]">
                    {actionMsg}
                  </div>
                )}

                {/* Customer & Assigned FO Details */}
                {detail.lead.redactedForReferral ? (
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-2">
                    <div className="font-semibold text-[#0F2744]">Referral Partner Permitted View</div>
                    <div>
                      Assigned Field Officer:{' '}
                      <strong>{detail.lead.assignedOfficerName || 'Pending Assignment'}</strong>
                      {detail.lead.assignedOfficerMobile && (
                        <>
                          {' · '}
                          <a
                            href={buildTelHref(detail.lead.assignedOfficerMobile)}
                            className="inline-flex items-center gap-1 font-mono font-semibold text-[#15803D] hover:underline"
                          >
                            <PhoneCall className="w-3 h-3" />
                            <span>{detail.lead.assignedOfficerMobile}</span>
                          </a>
                        </>
                      )}
                    </div>
                    <div className="text-slate-500">
                      Customer mobile, address, PAN, loan amount, KYC documents, and internal remarks are restricted
                      by company privacy policy.
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 text-xs bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                    <div className="col-span-2 sm:col-span-1">
                      <span className="text-slate-500">Mobile:</span>{' '}
                      {detail.lead.customerMobile ? (
                        <a
                          href={buildTelHref(detail.lead.customerMobile)}
                          title={`Call ${detail.lead.customerName}`}
                          className="inline-flex items-center gap-1.5 font-mono font-bold text-[#15803D] hover:text-green-800 hover:underline"
                        >
                          <PhoneCall className="w-3.5 h-3.5 shrink-0" />
                          <span>{detail.lead.customerMobile}</span>
                          <span className="px-1.5 py-0.5 rounded bg-green-100 text-[10px] font-sans font-semibold text-[#15803D]">
                            Call
                          </span>
                        </a>
                      ) : (
                        <span className="font-mono font-semibold text-slate-800">—</span>
                      )}
                      {detail.lead.alternateMobile && (
                        <div className="mt-1">
                          <span className="text-slate-500">Alt Mobile:</span>{' '}
                          <a
                            href={buildTelHref(detail.lead.alternateMobile)}
                            title={`Call Alternate Number (${detail.lead.alternateMobile})`}
                            className="inline-flex items-center gap-1 font-mono font-semibold text-[#0F2744] hover:text-[#EA580C] hover:underline"
                          >
                            <PhoneCall className="w-3 h-3 shrink-0" />
                            <span>{detail.lead.alternateMobile}</span>
                          </a>
                        </div>
                      )}
                    </div>
                    <div>
                      <span className="text-slate-500">PAN:</span>{' '}
                      <span className="font-mono font-semibold text-slate-800">{detail.lead.panNumber || '—'}</span>
                    </div>
                    <div>
                      <span className="text-slate-500">Loan Amount:</span>{' '}
                      <span className="font-mono font-semibold text-[#15803D]">
                        {formatInr(detail.lead.loanAmount)}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">Monthly Income:</span>{' '}
                      <span className="font-mono font-semibold text-slate-800">
                        {formatInr(detail.lead.monthlyIncome)}
                      </span>
                    </div>
                    <div className="col-span-2">
                      <span className="text-slate-500">Address:</span>{' '}
                      <span className="text-slate-800">
                        {[detail.lead.address, detail.lead.city, detail.lead.state, detail.lead.pinCode]
                          .filter(Boolean)
                          .join(', ') || '—'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">Generated By:</span>{' '}
                      <span className="font-semibold text-slate-800">
                        {detail.lead.createdByName || '—'}{' '}
                        {detail.lead.createdByCode && <span className="font-mono">({detail.lead.createdByCode})</span>}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">Assigned Officer:</span>{' '}
                      <span className="font-semibold text-[#0F2744]">
                        {detail.lead.assignedOfficerName
                          ? `${detail.lead.assignedOfficerName}${detail.lead.assignedOfficerCode ? ` (${detail.lead.assignedOfficerCode})` : ''}`
                          : 'Unassigned'}
                      </span>
                      {detail.lead.assignedOfficerMobile && (
                        <div className="mt-0.5">
                          <a
                            href={buildTelHref(detail.lead.assignedOfficerMobile)}
                            className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-[#0F2744] hover:text-[#EA580C] hover:underline"
                          >
                            <PhoneCall className="w-3 h-3 shrink-0" />
                            <span>{detail.lead.assignedOfficerMobile}</span>
                          </a>
                        </div>
                      )}
                    </div>
                    <div className="col-span-2 pt-1 border-t border-slate-200/80 flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="text-slate-500">Hierarchy Route:</span>
                      <span className="px-2 py-0.5 rounded bg-white border border-slate-200 font-semibold text-[#0F2744]">
                        BM: {detail.lead.assignedBmName ? `${detail.lead.assignedBmName} (${detail.lead.assignedBmCode})` : 'Pending'}
                      </span>
                      <span className="text-slate-400">→</span>
                      <span className="px-2 py-0.5 rounded bg-white border border-slate-200 font-semibold text-[#0F2744]">
                        TL: {detail.lead.assignedTlName ? `${detail.lead.assignedTlName} (${detail.lead.assignedTlCode})` : 'Pending'}
                      </span>
                      <span className="text-slate-400">→</span>
                      <span className="px-2 py-0.5 rounded bg-white border border-slate-200 font-semibold text-[#15803D]">
                        FO: {detail.lead.assignedOfficerName ? `${detail.lead.assignedOfficerName} (${detail.lead.assignedOfficerCode})` : 'Pending'}
                      </span>
                    </div>
                    {detail.lead.remarks && (
                      <div className="col-span-2">
                        <span className="text-slate-500">Remarks:</span>{' '}
                        <span className="text-slate-800">{detail.lead.remarks}</span>
                      </div>
                    )}
                    {detail.lead.lostReason && (
                      <div className="col-span-2">
                        <span className="text-slate-500">Lost / Rejection Reason:</span>{' '}
                        <span className="font-semibold text-[#DC2626]">{detail.lead.lostReason}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* One-Tap Customer Loan Quote Share (Non-Referral) */}
                {!isReferral && Number(detail.lead.loanAmount || 0) > 0 && (() => {
                  const prod = loanProducts.find((p) => p.name === detail.lead.loanProduct);
                  const rate = prod?.defaultRate || 9.5;
                  const tenure = detail.lead.loanProduct.includes('Home') ? 240 : detail.lead.loanProduct.includes('LAP') ? 180 : 60;
                  const amt = Number(detail.lead.loanAmount || 0);
                  const emi = computeMonthlyEmi(amt, rate, tenure);
                  const quoteTxt = buildQuoteText({
                    lang,
                    customerName: detail.lead.customerName,
                    loanProduct: detail.lead.loanProduct,
                    bankNbfc: detail.lead.bankNbfc,
                    loanAmount: amt,
                    ratePct: rate,
                    tenureMonths: tenure,
                    emi,
                    leadCode: detail.lead.leadCode,
                  });
                  return (
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div>
                        <span className="font-semibold text-[#0F2744]">Est. EMI: </span>
                        <span className="font-mono font-bold text-[#EA580C]">{formatInr(Math.round(emi))}/mo</span>
                        <span className="text-slate-500 ml-1">({rate}% · {tenure}m)</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <a
                          href={`https://wa.me/${detail.lead.customerMobile ? `91${detail.lead.customerMobile.replace(/\D/g, '').slice(-10)}` : ''}?text=${encodeURIComponent(quoteTxt)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#15803D] text-white font-semibold whitespace-nowrap"
                        >
                          <MessageCircle className="w-3 h-3" />
                          WhatsApp
                        </a>
                        <button
                          type="button"
                          onClick={handleCopyDetailQuote}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white text-[#0F2744] font-semibold whitespace-nowrap"
                        >
                          <Copy className="w-3 h-3" />
                          Copy Quote
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            downloadQuoteCardPng({
                              customerName: detail.lead.customerName,
                              loanProduct: detail.lead.loanProduct,
                              bankNbfc: detail.lead.bankNbfc,
                              loanAmount: amt,
                              ratePct: rate,
                              tenureMonths: tenure,
                              emi,
                              totalInterest: Math.max(0, emi * tenure - amt),
                            })
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#0F2744] text-white font-semibold whitespace-nowrap"
                        >
                          <Download className="w-3 h-3" />
                          Card PNG
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* 3-Stage Hierarchical Assignment (Back Office -> BM -> TL -> Field Officer) */}
                {canAssign && (
                  <div className="pt-3 border-t border-slate-200 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-[#0F2744] flex items-center gap-1.5">
                        <UserCheck className="w-4 h-4 text-[#EA580C]" />
                        Lead Routing Chain (Back Office → BM → TL → Field Officer)
                      </div>
                      {(isAdmin || isTeamLeader || isBranchManager) && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={handleLoadDetailCandidates}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 text-[11px] font-semibold text-[#0F2744]"
                          >
                            <Compass className="w-3 h-3 text-[#EA580C]" />
                            Score Matches
                          </button>
                          <button
                            type="button"
                            disabled={autoAssigningDetail}
                            onClick={handleSmartAutoAssignDetail}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#15803D] hover:bg-green-800 disabled:opacity-50 text-white text-[11px] font-semibold"
                          >
                            <Zap className="w-3 h-3" />
                            {autoAssigningDetail ? 'Balancing...' : 'Smart Auto-Assign'}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Stage 1: Back Office Team / Super Admin routes to Branch Manager */}
                    {(isBackOffice || isAdmin) && (
                      <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                        <div className="text-[11px] font-semibold text-[#0F2744]">
                          Stage 1 · Back Office → Assign Branch Manager (Branch-wise)
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <select
                            value={assignBmId}
                            onChange={(e) => setAssignBmId(e.target.value)}
                            className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="">Select Branch Manager (BM)...</option>
                            {(directory.branchManagers || []).map((bm) => (
                              <option key={bm.id} value={bm.id}>
                                {bm.fullName} — {bm.employeeCode}{bm.branchName ? ` (${bm.branchName})` : ''}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={!assignBmId}
                            onClick={handleAssignToBm}
                            className="px-3.5 py-2 rounded-lg bg-[#0F2744] hover:bg-[#16365D] disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
                          >
                            Assign to BM
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Stage 2: Branch Manager / Super Admin routes to Team Leader */}
                    {(isBranchManager || isAdmin) && (
                      <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                        <div className="text-[11px] font-semibold text-[#0F2744]">
                          Stage 2 · Branch Manager → Assign Team Leader
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <select
                            value={assignTlId}
                            onChange={(e) => setAssignTlId(e.target.value)}
                            className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="">Select Team Leader (TL)...</option>
                            {scopedTeamLeaders.map((tl) => (
                              <option key={tl.id} value={tl.id}>
                                {tl.fullName} — {tl.employeeCode}{tl.branchName ? ` (${tl.branchName})` : ''}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={!assignTlId}
                            onClick={handleAssignToTl}
                            className="px-3.5 py-2 rounded-lg bg-[#0F2744] hover:bg-[#16365D] disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap"
                          >
                            Assign to TL
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Stage 3: Team Leader (or Super Admin / BM) assigns to Field Officer */}
                    {(isTeamLeader || isAdmin || isBranchManager) && (
                      <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                        <div className="text-[11px] font-semibold text-[#0F2744]">
                          Stage 3 · Team Leader → Assign Field Officer (10-min SLA)
                        </div>

                        {detailCandidates && detailCandidates.length > 0 && (
                          <div className="p-2 rounded-lg bg-white border border-slate-200 space-y-1.5">
                            <div className="text-[11px] font-semibold text-slate-600">
                              Ranked Field Officers (Geography + Active Workload):
                            </div>
                            {detailCandidates.slice(0, 4).map((cand, idx) => (
                              <button
                                key={cand.officer.id}
                                type="button"
                                onClick={() => {
                                  setAssignOfficerId(String(cand.officer.id));
                                  setAssignOfficerCodeQuery(cand.officer.employeeCode);
                                }}
                                className={`w-full text-left px-2.5 py-1.5 rounded border text-[11px] flex items-center justify-between gap-2 ${
                                  idx === 0
                                    ? 'bg-emerald-50 border-emerald-300 text-[#0F2744]'
                                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                                }`}
                              >
                                <span className="truncate">
                                  <strong>#{idx + 1} {cand.officer.fullName}</strong> ({cand.officer.employeeCode}) ·{' '}
                                  {cand.geoMatchReasons[0]}
                                </span>
                                <span className="font-mono shrink-0">
                                  Load {cand.officer.activeLeadCount} · Score {cand.compositeScore}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}

                        <input
                          type="text"
                          value={assignOfficerCodeQuery}
                          onChange={(e) => {
                            const val = e.target.value;
                            setAssignOfficerCodeQuery(val);
                            const exact = scopedOfficers.find(
                              (fo) => fo.employeeCode?.toLowerCase() === val.trim().toLowerCase()
                            );
                            if (exact) setAssignOfficerId(String(exact.id));
                          }}
                          placeholder="Filter by Officer Name or enter Employee ID (e.g. FO001)"
                          className="w-full px-3 py-1.5 text-xs font-mono border border-slate-200 rounded-lg bg-white"
                        />
                        <div className="flex flex-col sm:flex-row gap-2">
                          <select
                            value={assignOfficerId}
                            onChange={(e) => setAssignOfficerId(e.target.value)}
                            className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                          >
                            <option value="">Select Field Officer (Name · Employee ID)...</option>
                            {filteredAssignOfficers.map((fo) => (
                              <option key={fo.id} value={fo.id}>
                                {fo.fullName} — {fo.employeeCode}{fo.branchName ? ` (${fo.branchName})` : ''}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={handleAssignLead}
                            className="px-4 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold whitespace-nowrap"
                          >
                            Assign Field Officer
                          </button>
                        </div>
                      </div>
                    )}

                    <input
                      type="text"
                      value={assignRemarks}
                      onChange={(e) => setAssignRemarks(e.target.value)}
                      placeholder="Assignment audit note (optional)"
                      className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-lg"
                    />
                  </div>
                )}

                {/* Case Status Update (Blocked for Referral Partners) */}
                {!isReferral && (
                  <form onSubmit={handleStatusUpdate} className="pt-3 border-t border-slate-200 space-y-2.5">
                    <div className="text-xs font-semibold text-[#0F2744]">Update Case Status</div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <select
                        value={newStatus}
                        onChange={(e) => setNewStatus(e.target.value as CaseStatus)}
                        className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        {CASE_STATUSES.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        className="px-4 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold whitespace-nowrap"
                      >
                        Update Status
                      </button>
                    </div>
                    {(newStatus === 'Rejected' || newStatus === 'Closed') && (
                      <div className="space-y-2">
                        <div>
                          <label className="block text-[11px] font-semibold text-[#DC2626] mb-1">
                            Lost / Rejection Reason (Tracked in Sales Analytics) *
                          </label>
                          <select
                            value={lostReason}
                            onChange={(e) => setLostReason(e.target.value)}
                            className="w-full px-3 py-1.5 text-xs border border-red-300 rounded-lg bg-red-50/40 text-slate-800"
                          >
                            {LOST_LEAD_REASONS.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </div>

                        {canAssign && (
                          <div className="p-2.5 rounded-lg border border-red-200 bg-red-50/50 space-y-2">
                            <label className="flex items-center gap-2 text-xs font-semibold text-[#DC2626] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={applyWrongLeadPenalty}
                                onChange={(e) => setApplyWrongLeadPenalty(e.target.checked)}
                                className="rounded border-red-300 accent-[#DC2626]"
                              />
                              <span>Wrong Lead Captured — Minus Staff Reward (₹10 to ₹100)</span>
                            </label>
                            {applyWrongLeadPenalty && (
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[11px] font-mono font-bold text-[#DC2626]">Deduct -₹</span>
                                <input
                                  type="number"
                                  min={10}
                                  max={100}
                                  value={wrongLeadAmount}
                                  onChange={(e) => setWrongLeadAmount(Math.min(100, Math.max(10, Number(e.target.value))))}
                                  className="w-20 px-2 py-1 text-xs font-mono border border-red-300 rounded bg-white tabular-nums"
                                />
                                {[10, 25, 50, 100].map((amt) => (
                                  <button
                                    key={amt}
                                    type="button"
                                    onClick={() => setWrongLeadAmount(amt)}
                                    className={`px-2 py-0.5 rounded text-[11px] font-mono font-semibold border ${
                                      wrongLeadAmount === amt
                                        ? 'bg-[#DC2626] text-white border-[#DC2626]'
                                        : 'bg-white text-slate-700 border-slate-300'
                                    }`}
                                  >
                                    ₹{amt}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <input
                      type="text"
                      value={statusRemarks}
                      onChange={(e) => setStatusRemarks(e.target.value)}
                      placeholder="Status update remarks (saved to audit history)"
                      className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-lg"
                    />
                  </form>
                )}

                {/* Staff Reward Points Status (Field Officer & Lead Generator Staff Only) */}
                {!isReferral && (
                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-[#0F2744] flex items-center gap-1.5">
                        <Award className="w-4 h-4 text-[#EA580C]" />
                        Staff Reward Points (Field Officer / Lead Generator)
                      </div>
                      <span className="text-[11px] font-semibold text-slate-500">
                        {detail.docCompletion?.docsComplete ? 'Docs Complete' : `${detail.docCompletion?.missingDocs.length || 0} Docs Pending`}
                      </span>
                    </div>
                    {detail.leadRewards && detail.leadRewards.length > 0 ? (
                      <div className="space-y-1.5">
                        {detail.leadRewards.map((rw: any) => (
                          <div
                            key={rw.id}
                            className="px-3 py-2 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-between gap-2 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-800 truncate">
                                {rw.employeeName} ({rw.staffBucket === 'FIELD_OFFICER' ? 'Field Officer' : 'Lead Generator'})
                              </div>
                              <div className="text-[11px] text-slate-500 truncate">{rw.reason}</div>
                            </div>
                            <span
                              className={`font-mono font-bold tabular-nums shrink-0 ${
                                rw.pointsDelta >= 0 ? 'text-[#15803D]' : 'text-[#DC2626]'
                              }`}
                            >
                              {rw.pointsDelta >= 0 ? `+${rw.pointsDelta} pts` : `-₹${Math.abs(rw.pointsDelta)}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        Upload all required KYC documents and move status to <strong>Case Logged In</strong> to auto-credit Docs+Login reward points. Disbursement reward credits separately on <strong>Disbursed</strong>.
                      </div>
                    )}
                  </div>
                )}

                {/* Follow-up Reminder Scheduler */}
                {!isReferral && (
                  <form onSubmit={handleCreateReminder} className="pt-3 border-t border-slate-200 space-y-2">
                    <div className="text-xs font-semibold text-[#0F2744] flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-[#D97706]" />
                      Schedule Follow-up Reminder (10-min SLA)
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        required
                        value={reminderNote}
                        onChange={(e) => setReminderNote(e.target.value)}
                        placeholder="e.g. Collect bank statement"
                        className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                      />
                      <select
                        value={reminderDueMins}
                        onChange={(e) => setReminderDueMins(Number(e.target.value))}
                        className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        <option value={0}>Due Immediately</option>
                        <option value={15}>In 15 mins</option>
                        <option value={60}>In 1 hour</option>
                        <option value={1440}>Tomorrow</option>
                      </select>
                      <button
                        type="submit"
                        className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-[#0F2744] whitespace-nowrap"
                      >
                        Set Reminder
                      </button>
                    </div>
                  </form>
                )}

                {/* Follow-up Customer Call Recording (FO/Lead Gen record, Admin-only listen/share, 7-day auto-delete) */}
                {!isReferral && (
                  <FollowupCallRecorder
                    leadId={detail.lead.id}
                    leadCode={detail.lead.leadCode}
                    customerName={detail.lead.customerName}
                    user={user}
                    recordings={detail.followupRecordings || []}
                    onRecordingSaved={async () => {
                      await loadLeadDetail(detail.lead.id);
                      onAlertsChanged();
                    }}
                  />
                )}

                {/* Camera & Document Upload + KYC Checklist (Hidden from Referral Partners) */}
                {!isReferral && (() => {
                  const requiredCats = PRODUCT_DOC_CHECKLIST[detail.lead.loanProduct] || [
                    'PAN Card',
                    'Aadhaar Card',
                    'Photograph',
                    'Bank Statement',
                  ];
                  const uploadedCats = new Set(detail.documents.map((d: any) => d.category));
                  const collectedCount = requiredCats.filter((c) => uploadedCats.has(c)).length;
                  const missingDocs = requiredCats.filter((c) => !uploadedCats.has(c));
                  const checklistPct = Math.round((collectedCount / requiredCats.length) * 100);
                  const missingReminderTxt = buildMissingDocReminder({
                    lang,
                    customerName: detail.lead.customerName,
                    leadCode: detail.lead.leadCode,
                    loanProduct: detail.lead.loanProduct,
                    missingDocs,
                  });

                  return (
                  <div className="pt-3 border-t border-slate-200 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-[#0F2744] flex items-center gap-1.5">
                        <FileText className="w-4 h-4 text-[#15803D]" />
                        KYC Checklist &amp; Camera Upload
                      </div>
                      <span className="text-[11px] font-mono font-bold text-[#15803D]">
                        {collectedCount}/{requiredCats.length} Collected ({checklistPct}%)
                      </span>
                    </div>

                    <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full bg-[#15803D]" style={{ width: `${checklistPct}%` }} />
                    </div>

                    <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                      {requiredCats.map((cat) => {
                        const done = uploadedCats.has(cat);
                        return (
                          <div
                            key={cat}
                            className={`px-2.5 py-1.5 rounded border flex items-center justify-between gap-1 ${
                              done ? 'bg-green-50/70 border-green-200 text-[#15803D]' : 'bg-slate-50 border-slate-200 text-slate-700'
                            }`}
                          >
                            <span className="inline-flex items-center gap-1 truncate font-medium">
                              <CheckCircle2 className={`w-3 h-3 shrink-0 ${done ? 'text-[#15803D]' : 'text-slate-300'}`} />
                              <span className="truncate">{cat}</span>
                            </span>
                            {!done && (
                              <button
                                type="button"
                                onClick={() => {
                                  setDocCategory(cat);
                                  setScannerTarget('detail');
                                  setShowScanner(true);
                                }}
                                className="text-[10px] font-bold text-[#EA580C] hover:underline shrink-0"
                              >
                                Scan
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {missingDocs.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <a
                          href={`https://wa.me/${detail.lead.customerMobile ? `91${detail.lead.customerMobile.replace(/\D/g, '').slice(-10)}` : ''}?text=${encodeURIComponent(missingReminderTxt)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#15803D] text-white font-semibold whitespace-nowrap"
                        >
                          <MessageCircle className="w-3 h-3" />
                          WhatsApp Doc Reminder
                        </a>
                        <button
                          type="button"
                          onClick={() => handleLogMissingDocReminder(missingDocs)}
                          className="px-2.5 py-1 rounded border border-slate-300 text-[#0F2744] font-semibold hover:bg-slate-50 whitespace-nowrap"
                        >
                          Log Reminder (10m SLA)
                        </button>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={docCategory}
                        onChange={(e) => setDocCategory(e.target.value)}
                        className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        {DOCUMENT_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          setScannerTarget('detail');
                          setShowScanner(true);
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                      >
                        <Camera className="w-3.5 h-3.5" />
                        Start Camera Scan
                      </button>
                      <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0">
                        <Upload className="w-3.5 h-3.5" />
                        Gallery / PDF
                        <input
                          type="file"
                          accept="image/*,application/pdf"
                          className="hidden"
                          onChange={(e) => handleDocumentUpload(e.target.files?.[0])}
                        />
                      </label>
                    </div>

                    {detail.documents.length > 0 && (
                      <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                        {detail.documents.map((doc: any) => (
                          <div key={doc.id} className="px-3 py-2 flex items-center justify-between gap-2 text-xs">
                            <div className="min-w-0">
                              <div className="font-medium text-slate-800 truncate">{doc.category}</div>
                              <div className="text-[11px] text-slate-500 truncate">
                                {doc.fileName} · {doc.uploadedByName}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => openDocPreview(doc)}
                              className="inline-flex items-center gap-1 text-[#0F2744] font-semibold hover:underline shrink-0"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              Preview
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  );
                })()}

                {/* Case Tracking History */}
                <div className="pt-3 border-t border-slate-200 space-y-2.5">
                  <div className="text-xs font-semibold text-[#0F2744]">Case Tracking History</div>
                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {detail.history.map((h: any) => (
                      <div key={h.id} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 text-xs">
                        <div className="flex items-center justify-between gap-2 font-semibold text-[#0F2744]">
                          <span>
                            {h.prevStatus ? `${h.prevStatus} → ` : ''}
                            {h.newStatus}
                          </span>
                          <span className="font-mono text-[11px] font-normal text-slate-500">
                            {formatDateTime(h.createdAt)}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          By {h.updatedByName} ({h.updatedByRole.replace('_', ' ')})
                        </div>
                        {h.remarks && <div className="text-slate-700 mt-1">{h.remarks}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
        </>
      )}

      {/* Document Preview Modal */}
      {previewDoc && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-2xl w-full p-4 space-y-3">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-2">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => setPreviewDoc(null)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-[#0F2744] shrink-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  {t(lang, 'navBack')}
                </button>
                <div className="text-sm font-semibold text-[#0F2744] truncate">{previewDoc.name}</div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewDoc(null)}
                className="p-1 text-slate-500 hover:text-slate-800 shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {previewDoc.mime.startsWith('image/') ? (
              <img
                src={previewDoc.url}
                alt={previewDoc.name}
                referrerPolicy="no-referrer"
                className="max-h-[70vh] w-full object-contain rounded-lg bg-slate-50"
              />
            ) : (
              <iframe src={previewDoc.url} title={previewDoc.name} className="w-full h-[70vh] rounded-lg border" />
            )}
          </div>
        </div>
      )}
      {/* Document Scanner with Camera, Perspective Correction & PAN OCR */}
      {showScanner && !isReferral && (scannerTarget === 'create' || detail) && (
        <DocumentScannerModal
          leadCode={scannerTarget === 'create' ? 'NEW-LEAD' : detail!.lead.leadCode}
          initialCategory={docCategory}
          onClose={() => setShowScanner(false)}
          onUploadScanned={async (payload) => {
            if (scannerTarget === 'create') {
              setPendingScannedDocs((prev) => [...prev, payload]);
              return;
            }
            if (!detail) return;
            await apiFetch(`/leads/${detail.lead.id}/documents`, {
              method: 'POST',
              json: payload,
            });
            setActionMsg(`Scanned & uploaded ${payload.category}: ${payload.fileName}`);
            await loadLeadDetail(detail.lead.id);
          }}
          onPrefillLead={
            scannerTarget === 'create'
              ? (ocrData) => {
                  setForm((prev) => ({
                    ...prev,
                    customerName: ocrData.customerName || prev.customerName,
                    panNumber: ocrData.panNumber || prev.panNumber,
                    dob: ocrData.dob || prev.dob,
                  }));
                  setPendingScannedDocs((prev) => {
                    if (prev.some((d) => d.fileName === ocrData.scannedDoc.fileName)) return prev;
                    return [...prev, ocrData.scannedDoc];
                  });
                  setPanOcrMsg(
                    `PAN OCR pre-filled ${[ocrData.customerName, ocrData.panNumber].filter(Boolean).join(' · ')}`
                  );
                  setShowScanner(false);
                }
              : undefined
          }
        />
      )}

      {/* QuickCameraModal in PAN OCR Mode triggered directly from the New Lead form */}
      {showQuickPanOcr && (
        <QuickCameraModal
          user={user}
          initialMode="document"
          initialDocCategory="PAN Card"
          onClose={() => setShowQuickPanOcr(false)}
          onActivitySaved={onAlertsChanged}
          onPrefillLeadFromOcr={(ocrData) => {
            setForm((prev) => ({
              ...prev,
              customerName: ocrData.customerName || prev.customerName,
              panNumber: ocrData.panNumber || prev.panNumber,
              dob: ocrData.dob || prev.dob,
            }));
            if (!isReferral) {
              setPendingScannedDocs((prev) => {
                if (prev.some((d) => d.fileName === ocrData.scannedDoc.fileName)) return prev;
                return [...prev, ocrData.scannedDoc];
              });
            }
            setPanOcrMsg(
              `PAN OCR pre-filled ${[ocrData.customerName, ocrData.panNumber].filter(Boolean).join(' · ')}`
            );
            setShowQuickPanOcr(false);
          }}
        />
      )}
    </div>
  );
};
