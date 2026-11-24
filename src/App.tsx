import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Award,
  Bell,
  Bike,
  Calculator,
  CalendarCheck2,
  Camera,
  ChevronRight,
  CloudOff,
  CopyCheck,
  FileBarChart2,
  HelpCircle,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  RefreshCw,
  Settings,
  ShieldAlert,
  TrendingUp,
  UserPlus,
  Users,
  X,
  Download,
  FileText,
  Pencil,
  Network,
} from 'lucide-react';
import type { AlertRecord, AuthUser, SystemSettings } from '../shared/types';
import { apiFetch, getStoredToken, setStoredToken } from './lib/api';
import { t, type Lang } from './lib/i18n';
import {
  getQueuedLeads,
  OFFLINE_QUEUE_EVENT,
  syncOfflineLeadQueue,
  type SyncOutcome,
} from './lib/offlineLeadQueue';
import { useOnlineStatus, usePWAInstall } from './lib/usePWAInstall';
import { BrandMark } from './components/BrandMark';
import { LoginView } from './components/LoginView';
import { DashboardView } from './components/DashboardView';
import { LeadsModule } from './components/LeadsModule';
import { DuplicateApprovalView, PenaltyRegisterView } from './components/DuplicatesAndPenalties';
import { EnquiriesModule } from './components/EnquiriesModule';
import { FieldOperationsModule } from './components/FieldOperationsModule';
import { AlertCentreView } from './components/AlertCentreView';
import { CalculatorModule } from './components/CalculatorModule';
import { ReportsModule } from './components/ReportsAndGuidesModule';
import { AdminSettingsModule } from './components/AdminSettingsModule';
import { SalesGrowthHubModule } from './components/SalesGrowthHubModule';
import { PublicReferralCaptureView } from './components/PublicReferralCaptureView';
import { RewardDashboard } from './components/RewardDashboard';
import { QuickCameraModal } from './components/QuickCameraModal';
import { AppInstallModal } from './components/AppInstallModal';
import { MobileAppPromptBanner } from './components/MobileAppPromptBanner';
import { ReferralConsoleModule } from './components/ReferralConsoleModule';
import { LegalTermsModal, type LegalTab } from './components/LegalTermsModal';
import { ProfileModal } from './components/ProfileModal';
import { AttendanceLeaveModule } from './components/AttendanceLeaveModule';
import { BmDownlinePanel } from './components/BmDownlinePanel';

export interface NavEntry {
  tab: string;
  leadId?: number | null;
  subOption?: string | null;
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [lang, setLang] = useState<Lang>('en');
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  const [activeSubOption, setActiveSubOption] = useState<string | null>(null);
  const [historyStack, setHistoryStack] = useState<NavEntry[]>([
    { tab: 'dashboard', leadId: null, subOption: null },
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const historyRef = useRef<{ stack: NavEntry[]; index: number }>({
    stack: [{ tab: 'dashboard', leadId: null, subOption: null }],
    index: 0,
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showQuickCamera, setShowQuickCamera] = useState(false);
  const [publicRefCode, setPublicRefCode] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    return ref ? ref.trim().toUpperCase() : null;
  });
  const [prefillLead, setPrefillLead] = useState<{
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
  } | null>(null);

  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const [settings, setSettings] = useState<SystemSettings>({
    petrolRatePerKm: 3.0,
    assignmentSlaMinutes: 10,
    followupSlaMinutes: 10,
    enquirySlaMinutes: 60,
    otpRequiredGlobal: false,
    defaultLanguage: 'en',
    companyLogoDataUrl: null,
    officeAddress: '1ST FLOR ANUPAM COMPLEX,PATERI ROAD,NEAR RELIANCE BAZAR,SATNA MP(485001)',
    referralBonusThreshold: 5,
    referralBonusPct: 0.15,
    loanProducts: [
      { id: 'home_loan', name: 'Home Loan', defaultRate: 8.65, minTenureMonths: 12, maxTenureMonths: 360, commissionPct: 0.45 },
      { id: 'lap', name: 'Loan Against Property (LAP)', defaultRate: 9.75, minTenureMonths: 12, maxTenureMonths: 240, commissionPct: 0.65 },
      { id: 'personal_loan', name: 'Personal Loan', defaultRate: 11.25, minTenureMonths: 12, maxTenureMonths: 72, commissionPct: 1.25 },
      { id: 'business_loan', name: 'Business Loan', defaultRate: 14.5, minTenureMonths: 12, maxTenureMonths: 60, commissionPct: 1.5 },
      { id: 'auto_loan', name: 'Auto / Commercial Vehicle Loan', defaultRate: 9.25, minTenureMonths: 12, maxTenureMonths: 84, commissionPct: 0.85 },
      { id: 'gold_loan', name: 'Gold / Working Capital', defaultRate: 10.5, minTenureMonths: 3, maxTenureMonths: 36, commissionPct: 0.5 },
    ],
  });

  const isOnline = useOnlineStatus();
  const { isInstallable, isInstalled, isIOS, isAndroid, install } = usePWAInstall();
  const [showAppInstallModal, setShowAppInstallModal] = useState(false);
  const [legalTab, setLegalTab] = useState<LegalTab | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [pendingOfflineCount, setPendingOfflineCount] = useState(0);
  const [syncingOffline, setSyncingOffline] = useState(false);
  const [syncBannerMsg, setSyncBannerMsg] = useState<string | null>(null);
  const [todayAttendanceMarked, setTodayAttendanceMarked] = useState(false);
  const configVersionRef = useRef<number>(0);
  const buildVersionRef = useRef<string | null>(null);

  const fetchAlerts = async () => {
    if (!getStoredToken()) return;
    try {
      const res = await apiFetch<{ alerts: AlertRecord[]; unreadCount: number }>('/alerts');
      setAlerts(res.alerts);
      setUnreadCount(res.unreadCount);
    } catch {
      // ignore transient network errors
    }
  };

  const fetchTodayAttendanceStatus = async (role?: string) => {
    if (!getStoredToken() || role === 'REFERRAL_PARTNER') {
      setTodayAttendanceMarked(false);
      return;
    }
    try {
      const att = await apiFetch<{ todayRecord?: any }>('/attendance');
      setTodayAttendanceMarked(Boolean(att.todayRecord));
    } catch {
      // ignore transient network errors
    }
  };

  const applyRemoteConfigSync = async (summary?: string | null, silent = false) => {
    try {
      const token = getStoredToken();
      if (token) {
        const [sRes, meRes] = await Promise.all([
          apiFetch<{ settings: SystemSettings }>('/admin/settings'),
          apiFetch<{ user: AuthUser }>('/auth/me'),
        ]);
        setSettings(sRes.settings);
        setUser(meRes.user);
        if (typeof sRes.settings.configVersion === 'number') {
          configVersionRef.current = sRes.settings.configVersion;
        }
        await Promise.all([fetchAlerts(), fetchTodayAttendanceStatus(meRes.user.role)]);
      } else {
        const brand = await apiFetch<any>('/public/branding');
        setSettings((prev) => ({
          ...prev,
          companyLogoDataUrl: brand.companyLogoDataUrl ?? null,
          officeAddress: brand.officeAddress ?? prev.officeAddress,
          loanProducts: brand.loanProducts ?? prev.loanProducts,
          seniorityInstructions: brand.seniorityInstructions ?? prev.seniorityInstructions,
          configVersion: brand.configVersion ?? prev.configVersion,
          appBuildVersion: brand.appBuildVersion ?? prev.appBuildVersion,
          lastSyncSummary: brand.lastSyncSummary ?? prev.lastSyncSummary,
          lastSyncUpdatedAt: brand.lastSyncUpdatedAt ?? prev.lastSyncUpdatedAt,
        }));
        if (typeof brand.configVersion === 'number') {
          configVersionRef.current = brand.configVersion;
        }
      }

      window.dispatchEvent(
        new CustomEvent('ambika:live-sync', {
          detail: { configVersion: configVersionRef.current, summary: summary || null },
        })
      );

      if (!silent && summary) {
        setSyncBannerMsg(`Admin update applied automatically: ${summary}`);
      }
    } catch {
      // ignore transient offline errors
    }
  };

  const applyRemoteBuildUpdate = async (remoteBuild: string) => {
    try {
      const appliedKey = 'ambika_applied_build_version';
      const lastApplied = localStorage.getItem(appliedKey);
      if (lastApplied === remoteBuild) return;
      localStorage.setItem(appliedKey, remoteBuild);

      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg?.active) {
          reg.active.postMessage({ type: 'CLEAR_STALE_CACHES' });
        }
        await reg?.update().catch(() => {});
        if (reg?.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      }
      window.location.reload();
    } catch {
      // ignore storage errors
    }
  };

  const checkLiveSyncVersion = async () => {
    if (!navigator.onLine) return;
    try {
      const probe = await apiFetch<{
        appBuildVersion?: string;
        configVersion?: number;
        lastSyncSummary?: string | null;
      }>('/public/sync-version');

      if (probe.appBuildVersion) {
        if (!buildVersionRef.current) {
          buildVersionRef.current = probe.appBuildVersion;
          try {
            localStorage.setItem('ambika_applied_build_version', probe.appBuildVersion);
          } catch {
            // ignore
          }
        } else if (probe.appBuildVersion !== buildVersionRef.current) {
          buildVersionRef.current = probe.appBuildVersion;
          await applyRemoteBuildUpdate(probe.appBuildVersion);
          return;
        }
      }

      if (typeof probe.configVersion === 'number') {
        if (configVersionRef.current === 0) {
          configVersionRef.current = probe.configVersion;
        } else if (probe.configVersion > configVersionRef.current) {
          configVersionRef.current = probe.configVersion;
          await applyRemoteConfigSync(probe.lastSyncSummary || 'Latest Admin settings & seniority rules');
        }
      }
    } catch {
      // ignore transient network errors
    }
  };

  useEffect(() => {
    const boot = async () => {
      try {
        const brand = await apiFetch<any>('/public/branding');
        if (typeof brand.configVersion === 'number') {
          configVersionRef.current = brand.configVersion;
        }
        if (brand.appBuildVersion) {
          buildVersionRef.current = brand.appBuildVersion;
          try {
            localStorage.setItem('ambika_applied_build_version', brand.appBuildVersion);
          } catch {
            // ignore
          }
        }
        setSettings((prev) => ({
          ...prev,
          companyLogoDataUrl: brand.companyLogoDataUrl ?? null,
          officeAddress: brand.officeAddress ?? prev.officeAddress,
          loanProducts: brand.loanProducts ?? prev.loanProducts,
          defaultLanguage: brand.defaultLanguage ?? 'en',
          playStoreUrl: brand.playStoreUrl ?? null,
          apkDownloadUrl: brand.apkDownloadUrl ?? null,
          hasUploadedApk: brand.hasUploadedApk ?? false,
          apkFileName: brand.apkFileName ?? null,
          apkFileSize: brand.apkFileSize ?? null,
          hasUploadedAab: brand.hasUploadedAab ?? false,
          aabFileName: brand.aabFileName ?? null,
          aabFileSize: brand.aabFileSize ?? null,
          seniorityInstructions: brand.seniorityInstructions ?? prev.seniorityInstructions,
          configVersion: brand.configVersion ?? prev.configVersion,
          appBuildVersion: brand.appBuildVersion ?? prev.appBuildVersion,
          lastSyncSummary: brand.lastSyncSummary ?? prev.lastSyncSummary,
          lastSyncUpdatedAt: brand.lastSyncUpdatedAt ?? prev.lastSyncUpdatedAt,
        }));

        if (getStoredToken()) {
          const me = await apiFetch<{ user: AuthUser }>('/auth/me');
          setUser(me.user);
          setLang(me.user.preferredLang);
          const sRes = await apiFetch<{ settings: SystemSettings }>('/admin/settings');
          setSettings(sRes.settings);
          if (typeof sRes.settings.configVersion === 'number') {
            configVersionRef.current = sRes.settings.configVersion;
          }
          await Promise.all([fetchAlerts(), fetchTodayAttendanceStatus(me.user.role)]);
        }
      } catch {
        setStoredToken(null);
        setUser(null);
      } finally {
        setBootLoading(false);
      }
    };
    boot();
  }, []);

  // Real-time SSE connection + resume/polling fallback connecting all downloaded role apps to Admin Panel updates
  useEffect(() => {
    const handleResumeCheck = () => {
      if (document.visibilityState === 'visible') {
        void checkLiveSyncVersion();
      }
    };
    const handleImmediateCheck = () => {
      void checkLiveSyncVersion();
    };

    const pollTimer = window.setInterval(checkLiveSyncVersion, 15000);
    document.addEventListener('visibilitychange', handleResumeCheck);
    window.addEventListener('focus', handleImmediateCheck);
    window.addEventListener('online', handleImmediateCheck);
    window.addEventListener('ambika-app-resume', handleImmediateCheck);

    let es: EventSource | null = null;
    const token = getStoredToken();
    if (user && token && typeof EventSource !== 'undefined') {
      es = new EventSource(`/api/live-sync?token=${encodeURIComponent(token)}`);
      es.addEventListener('connected', (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data || '{}');
          if (payload.appBuildVersion && buildVersionRef.current && payload.appBuildVersion !== buildVersionRef.current) {
            void applyRemoteBuildUpdate(payload.appBuildVersion);
            return;
          }
          if (typeof payload.configVersion === 'number' && payload.configVersion > configVersionRef.current) {
            configVersionRef.current = payload.configVersion;
            void applyRemoteConfigSync(payload.lastSyncSummary || 'Admin settings updated');
          }
        } catch {
          // ignore malformed event
        }
      });
      es.addEventListener('sync', (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data || '{}');
          if (typeof payload.configVersion === 'number') {
            configVersionRef.current = payload.configVersion;
          }
          void applyRemoteConfigSync(payload.summary || 'Admin update synced');
        } catch {
          void applyRemoteConfigSync('Admin update synced');
        }
      });
      es.addEventListener('attendance', (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data || '{}');
          if (payload.employeeId === user.id) {
            setTodayAttendanceMarked(true);
          }
          window.dispatchEvent(new CustomEvent('ambika:live-sync', { detail: { scope: 'ATTENDANCE' } }));
        } catch {
          // ignore
        }
      });
    }

    return () => {
      window.clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', handleResumeCheck);
      window.removeEventListener('focus', handleImmediateCheck);
      window.removeEventListener('online', handleImmediateCheck);
      window.removeEventListener('ambika-app-resume', handleImmediateCheck);
      es?.close();
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    const timer = setInterval(fetchAlerts, 15000);
    return () => clearInterval(timer);
  }, [user?.id]);

  // Offline Lead Queue tracking + Automatic Sync when connectivity is restored
  const refreshOfflineCount = async () => {
    try {
      const items = await getQueuedLeads();
      setPendingOfflineCount(items.length);
    } catch {
      // ignore IndexedDB errors
    }
  };

  const announceSyncOutcomes = (outcomes: SyncOutcome[]) => {
    const okOnes = outcomes.filter((o) => o.ok);
    if (okOnes.length > 0) {
      const codes = okOnes.map((o) => (o.duplicateDetected ? o.requestCode : o.leadCode)).filter(Boolean);
      setSyncBannerMsg(
        `Auto-synced ${okOnes.length} offline lead${okOnes.length > 1 ? 's' : ''}${codes.length ? ` (${codes.join(', ')})` : ''}.`
      );
      fetchAlerts();
    }
  };

  const runOfflineSyncNow = async () => {
    if (!navigator.onLine) return;
    setSyncingOffline(true);
    try {
      const outcomes = await syncOfflineLeadQueue(getStoredToken());
      announceSyncOutcomes(outcomes);
    } finally {
      setSyncingOffline(false);
      await refreshOfflineCount();
    }
  };

  useEffect(() => {
    refreshOfflineCount();

    const handleQueueChange = () => {
      refreshOfflineCount();
    };
    const handleSwMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'LEAD_QUEUED_OFFLINE') {
        refreshOfflineCount();
      } else if (msg.type === 'OFFLINE_LEADS_SYNCED') {
        refreshOfflineCount();
        if (Array.isArray(msg.outcomes)) {
          announceSyncOutcomes(msg.outcomes);
        }
      }
    };

    window.addEventListener(OFFLINE_QUEUE_EVENT, handleQueueChange);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSwMessage);
    }
    return () => {
      window.removeEventListener(OFFLINE_QUEUE_EVENT, handleQueueChange);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleSwMessage);
      }
    };
  }, []);

  useEffect(() => {
    if (isOnline) {
      runOfflineSyncNow();
    }
  }, [isOnline, user?.id]);

  const applyHistoryIndex = (targetIdx: number, syncBrowser = false) => {
    const stack = historyRef.current.stack;
    const prevIdx = historyRef.current.index;
    const clamped = Math.max(0, Math.min(targetIdx, stack.length - 1));
    const target = stack[clamped];
    if (!target) return;

    historyRef.current = { stack, index: clamped };
    setHistoryIndex(clamped);
    setActiveTab(target.tab);
    setSelectedLeadId(target.leadId ?? null);
    setActiveSubOption(target.subOption ?? null);
    setMobileMenuOpen(false);

    if (syncBrowser && typeof window !== 'undefined') {
      const currentBrowserIdx = window.history.state?.ambikaNavIdx;
      if (clamped < prevIdx && currentBrowserIdx === prevIdx) {
        window.history.back();
      } else if (clamped > prevIdx && currentBrowserIdx === prevIdx) {
        window.history.forward();
      }
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.history.state || typeof window.history.state.ambikaNavIdx !== 'number') {
      window.history.replaceState({ ambikaNavIdx: 0 }, '', window.location.pathname + window.location.search);
    }
    const handlePopState = (event: PopStateEvent) => {
      const idx = event.state?.ambikaNavIdx;
      if (typeof idx === 'number' && idx !== historyRef.current.index) {
        if (idx >= 0 && idx < historyRef.current.stack.length) {
          applyHistoryIndex(idx, false);
        }
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!user) return;
    const handleKeyNav = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        if (historyRef.current.index > 0) applyHistoryIndex(historyRef.current.index - 1, true);
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        if (historyRef.current.index < historyRef.current.stack.length - 1) {
          applyHistoryIndex(historyRef.current.index + 1, true);
        }
      }
    };
    window.addEventListener('keydown', handleKeyNav);
    return () => window.removeEventListener('keydown', handleKeyNav);
  }, [user?.id]);

  const handleAuthenticated = async (authedUser: AuthUser) => {
    setUser(authedUser);
    setLang(authedUser.preferredLang);
    const initialEntry: NavEntry = { tab: 'dashboard', leadId: null, subOption: null };
    historyRef.current = { stack: [initialEntry], index: 0 };
    setHistoryStack([initialEntry]);
    setHistoryIndex(0);
    setActiveTab('dashboard');
    setSelectedLeadId(null);
    setActiveSubOption(null);
    if (typeof window !== 'undefined') {
      window.history.replaceState({ ambikaNavIdx: 0 }, '', '#dashboard');
    }
    try {
      const sRes = await apiFetch<{ settings: SystemSettings }>('/admin/settings');
      setSettings(sRes.settings);
      if (typeof sRes.settings.configVersion === 'number') {
        configVersionRef.current = sRes.settings.configVersion;
      }
    } catch {
      // use public branding fallback
    }
    await Promise.all([fetchAlerts(), fetchTodayAttendanceStatus(authedUser.role)]);
  };

  const handleToggleLang = async () => {
    const next: Lang = lang === 'en' ? 'hi' : 'en';
    setLang(next);
    if (user) {
      try {
        await apiFetch('/auth/preferences', { method: 'PATCH', json: { preferredLang: next } });
      } catch {
        // local preference still applies
      }
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setStoredToken(null);
    setUser(null);
    setAlerts([]);
    setUnreadCount(0);
  };

  if (bootLoading) {
    return (
      <div className="min-h-screen bg-[#0F2744] flex items-center justify-center text-white text-sm font-display">
        Loading AMBIKA ASSOCIATE CRM...
      </div>
    );
  }

  if (publicRefCode) {
    return (
      <PublicReferralCaptureView
        referralCode={publicRefCode}
        logoDataUrl={settings.companyLogoDataUrl}
        lang={lang}
        onToggleLang={handleToggleLang}
        onExitToLogin={() => {
          setPublicRefCode(null);
          if (window.location.search.includes('ref=')) {
            window.history.replaceState({}, '', window.location.pathname);
          }
        }}
      />
    );
  }

  if (!user) {
    return (
      <LoginView
        logoDataUrl={settings.companyLogoDataUrl}
        playStoreUrl={settings.playStoreUrl}
        apkDownloadUrl={settings.apkDownloadUrl}
        hasUploadedApk={settings.hasUploadedApk}
        apkFileSize={settings.apkFileSize}
        hasUploadedAab={settings.hasUploadedAab}
        aabFileSize={settings.aabFileSize}
        lang={lang}
        onToggleLang={handleToggleLang}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  const isReferral = user.role === 'REFERRAL_PARTNER';
  const isSuperAdmin = user.role === 'SUPER_ADMIN';
  const isManager = ['SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER'].includes(user.role);
  const canAccessReferralConsole = ['SUPER_ADMIN', 'LEAD_GENERATOR', 'FIELD_OFFICER'].includes(user.role);
  const userInitials = (user.fullName || 'AA')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  const navItems = [
    { id: 'dashboard', label: t(lang, 'navDashboard'), icon: LayoutDashboard, visible: true },
    {
      id: 'bm-downline',
      label: user.role === 'TEAM_LEADER' ? t(lang, 'navTlDownline') : t(lang, 'navBmDownline'),
      icon: Network,
      visible: isManager,
    },
    { id: 'leads', label: t(lang, 'navLeads'), icon: Users, visible: true },
    {
      id: 'referrals',
      label: user.role === 'FIELD_OFFICER' ? t(lang, 'navCreateReferral') : t(lang, 'navReferrals'),
      icon: UserPlus,
      visible: canAccessReferralConsole,
    },
    { id: 'sales-hub', label: t(lang, 'navSalesHub'), icon: TrendingUp, visible: true },
    { id: 'rewards', label: t(lang, 'navRewards'), icon: Award, visible: !isReferral },
    { id: 'duplicates', label: t(lang, 'navDuplicates'), icon: CopyCheck, visible: isSuperAdmin },
    { id: 'penalties', label: t(lang, 'navPenalties'), icon: ShieldAlert, visible: !isReferral },
    { id: 'enquiries', label: t(lang, 'navEnquiries'), icon: HelpCircle, visible: true },
    { id: 'field-ops', label: t(lang, 'navFieldOps'), icon: Bike, visible: !isReferral },
    { id: 'attendance', label: t(lang, 'navAttendance'), icon: CalendarCheck2, visible: !isReferral },
    { id: 'alerts', label: t(lang, 'navAlerts'), icon: Bell, visible: true },
    { id: 'calculator', label: t(lang, 'navCalculator'), icon: Calculator, visible: true },
    { id: 'reports', label: t(lang, 'navReports'), icon: FileBarChart2, visible: true },
    { id: 'admin', label: t(lang, 'navAdmin'), icon: Settings, visible: isManager },
  ].filter((n) => n.visible);

  const activeLabel = navItems.find((n) => n.id === activeTab)?.label || t(lang, 'navDashboard');
  const getTabLabel = (tabId: string) => navItems.find((n) => n.id === tabId)?.label || tabId;

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < historyStack.length - 1;
  const prevEntry = canGoBack ? historyStack[historyIndex - 1] : null;
  const nextEntry = canGoForward ? historyStack[historyIndex + 1] : null;

  const navigateTo = (tab: string, leadId: number | null = null, subOption: string | null = null) => {
    const curr = historyRef.current.stack[historyRef.current.index];
    if (
      curr &&
      curr.tab === tab &&
      (curr.leadId ?? null) === leadId &&
      (curr.subOption ?? null) === subOption
    ) {
      setMobileMenuOpen(false);
      return;
    }

    const nextEntryObj: NavEntry = { tab, leadId, subOption };
    const nextStack = [...historyRef.current.stack.slice(0, historyRef.current.index + 1), nextEntryObj];
    const nextIdx = nextStack.length - 1;
    historyRef.current = { stack: nextStack, index: nextIdx };
    setHistoryStack(nextStack);
    setHistoryIndex(nextIdx);
    setSelectedLeadId(leadId);
    setActiveSubOption(subOption);
    setActiveTab(tab);
    setMobileMenuOpen(false);

    if (typeof window !== 'undefined') {
      const hashParts = [tab, subOption || '', leadId ? `lead-${leadId}` : ''].filter(Boolean).join('/');
      window.history.pushState({ ambikaNavIdx: nextIdx }, '', `#${hashParts}`);
    }
  };

  const goBack = () => {
    if (historyRef.current.index > 0) {
      applyHistoryIndex(historyRef.current.index - 1, true);
    }
  };

  const goForward = () => {
    if (historyRef.current.index < historyRef.current.stack.length - 1) {
      applyHistoryIndex(historyRef.current.index + 1, true);
    }
  };

  const selectSubOption = (subOption: string | null) => {
    navigateTo(activeTab, activeTab === 'leads' ? selectedLeadId : null, subOption);
  };

  const formatSubOptionLabel = (opt: string | null | undefined) => {
    if (!opt) return null;
    const map: Record<string, string> = {
      'new-lead': 'New Lead Form',
      'load-balancer': 'Auto Load-Balancer',
      'call-vault': 'Call Recordings Vault (7d)',
      ALL: 'All View',
      REFERRAL: 'Referral Leads',
      REFERRAL_TODAY: "Referral Today's Leads",
      FO_TODAY: "FO Today's Leads",
      FIELD_OFFICER: 'Field Officer Leads',
      BACK_OFFICE: 'Back Office Leads',
      UNASSIGNED: 'Unassigned Pool',
      priority: 'Priority & Targets',
      analytics: 'Funnel & Banks',
      referral: 'Referral Payouts & QR',
      my: 'My Rewards',
      team: 'Team Ledger & Penalties',
      gps: 'GPS Location & Visits',
      timeline: 'Check-In / Out Timeline',
      bike: 'Bike Run & Petrol',
      attendance: 'Daily Self Attendance',
      leave: 'Leave & Seniority Approval',
      users: 'Users & Roles',
      rules: 'Rules & Branding',
      org: 'Branches & Teams',
      audit: 'Audit Logs',
      docs: 'Schema, API & Guides',
      PENDING: 'Pending Queue',
      APPROVED: 'Approved Queue',
      REJECTED: 'Rejected Queue',
      new: 'Create Enquiry',
      UNREAD: 'Unread Alerts',
      READ: 'Read History',
    };
    return map[opt] || opt.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col bg-[#0F2744] text-white shrink-0 border-r border-white/10">
        <div className="px-5 py-4 border-b border-white/10">
          <BrandMark logoDataUrl={settings.companyLogoDataUrl} cacheKey={settings.configVersion} darkSurface />
        </div>

        {/* Back / Forward Navigation Controls inside Sidebar Menu */}
        <div className="px-3 pt-3 pb-2 border-b border-white/10">
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              disabled={!canGoBack}
              onClick={goBack}
              title={prevEntry ? `${t(lang, 'navBack')}: ${getTabLabel(prevEntry.tab)}` : t(lang, 'navBack')}
              className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-35 disabled:hover:bg-white/10 text-[11px] font-semibold text-white transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{t(lang, 'navBack')}</span>
            </button>
            <button
              type="button"
              disabled={!canGoForward}
              onClick={goForward}
              title={nextEntry ? `${t(lang, 'navForward')}: ${getTabLabel(nextEntry.tab)}` : t(lang, 'navForward')}
              className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-35 disabled:hover:bg-white/10 text-[11px] font-semibold text-white transition-colors"
            >
              <span className="truncate">{t(lang, 'navForward')}</span>
              <ArrowRight className="w-3.5 h-3.5 shrink-0" />
            </button>
            <button
              type="button"
              disabled={activeTab === 'dashboard' && !selectedLeadId && !activeSubOption}
              onClick={() => navigateTo('dashboard')}
              title={t(lang, 'navHome')}
              className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-35 disabled:hover:bg-white/10 text-[11px] font-semibold text-white transition-colors"
            >
              <Home className="w-3.5 h-3.5 shrink-0" />
            </button>
          </div>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`w-full flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-[#EA580C] text-white font-semibold'
                    : 'text-slate-200 hover:bg-white/10 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0 truncate">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.id === 'alerts' && unreadCount > 0 && (
                  <span className="font-mono text-[11px] font-bold text-yellow-300 tabular-nums">
                    {unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/10 space-y-2.5">
          {!isInstalled && (
            <button
              type="button"
              onClick={() => setShowAppInstallModal(true)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[#15803D] hover:bg-green-700 text-xs font-semibold text-white transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              {t(lang, 'downloadApp')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowProfileModal(true)}
            className="w-full flex items-center gap-2.5 p-2 rounded-xl bg-white/10 hover:bg-white/15 transition-colors text-left"
          >
            <div className="w-9 h-9 rounded-full overflow-hidden bg-[#EA580C] text-white flex items-center justify-center text-xs font-bold shrink-0 border border-white/20">
              {user.profilePhotoDataUrl ? (
                <img src={user.profilePhotoDataUrl} alt={user.fullName} className="w-full h-full object-cover" />
              ) : (
                <span>{userInitials}</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-white truncate">{user.fullName}</div>
              <div className="text-slate-300 text-[10px] font-mono truncate">
                {user.employeeCode} · {user.role.replace('_', ' ')}
              </div>
              <div className="text-[10px] font-semibold text-yellow-300 mt-0.5 inline-flex items-center gap-1">
                <Pencil className="w-2.5 h-2.5" />
                {lang === 'hi' ? 'प्रोफ़ाइल संपादित करें' : 'Edit Profile'}
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setLegalTab('terms')}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] font-medium text-slate-200 transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            {lang === 'hi' ? 'नियम व गोपनीयता नीति' : 'Terms & Privacy Policy'}
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold text-white transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            {t(lang, 'signOut')}
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/50" onClick={() => setMobileMenuOpen(false)} />
          <aside className="relative w-72 max-w-[85vw] bg-[#0F2744] text-white flex flex-col h-full z-10">
            <div className="px-4 py-4 border-b border-white/10 flex items-center justify-between">
              <BrandMark logoDataUrl={settings.companyLogoDataUrl} cacheKey={settings.configVersion} darkSurface />
              <button type="button" onClick={() => setMobileMenuOpen(false)} className="p-1 text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            {/* Back / Forward Navigation Controls inside Mobile Drawer Menu */}
            <div className="px-3 pt-3 pb-2 border-b border-white/10 grid grid-cols-3 gap-1.5">
              <button
                type="button"
                disabled={!canGoBack}
                onClick={goBack}
                className="flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-35 text-xs font-semibold text-white"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {t(lang, 'navBack')}
              </button>
              <button
                type="button"
                disabled={!canGoForward}
                onClick={goForward}
                className="flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-35 text-xs font-semibold text-white"
              >
                {t(lang, 'navForward')}
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                disabled={activeTab === 'dashboard' && !selectedLeadId && !activeSubOption}
                onClick={() => navigateTo('dashboard')}
                className="flex items-center justify-center gap-1 px-2 py-2 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-35 text-xs font-semibold text-white"
              >
                <Home className="w-3.5 h-3.5" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigateTo(item.id)}
                    className={`w-full flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg text-sm font-medium ${
                      active ? 'bg-[#EA580C] text-white' : 'text-slate-200 hover:bg-white/10'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <Icon className="w-4 h-4" />
                      {item.label}
                    </span>
                    {item.id === 'alerts' && unreadCount > 0 && (
                      <span className="font-mono text-xs font-bold text-yellow-300">{unreadCount}</span>
                    )}
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-white/10 space-y-2">
              {!isInstalled && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setShowAppInstallModal(true);
                  }}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-[#15803D] text-xs font-semibold text-white"
                >
                  <Download className="w-4 h-4" />
                  {t(lang, 'downloadApp')}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setShowProfileModal(true);
                }}
                className="w-full flex items-center gap-2.5 p-2 rounded-xl bg-white/10 hover:bg-white/15 text-left"
              >
                <div className="w-9 h-9 rounded-full overflow-hidden bg-[#EA580C] text-white flex items-center justify-center text-xs font-bold shrink-0 border border-white/20">
                  {user.profilePhotoDataUrl ? (
                    <img src={user.profilePhotoDataUrl} alt={user.fullName} className="w-full h-full object-cover" />
                  ) : (
                    <span>{userInitials}</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white truncate">{user.fullName}</div>
                  <div className="text-[10px] font-semibold text-yellow-300 inline-flex items-center gap-1">
                    <Pencil className="w-2.5 h-2.5" />
                    {lang === 'hi' ? 'मेरी प्रोफ़ाइल संपादित करें' : 'Edit Profile / Photo'}
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setLegalTab('terms');
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white/5 text-xs font-medium text-slate-200"
              >
                <FileText className="w-3.5 h-3.5" />
                {lang === 'hi' ? 'नियम व गोपनीयता नीति' : 'Terms & Privacy Policy'}
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-white/10 text-xs font-semibold"
              >
                <LogOut className="w-4 h-4" />
                {t(lang, 'signOut')}
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header Bar */}
        <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-3 sm:px-6 py-2.5 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            {/* Header Back & Forward Buttons */}
            <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5 shrink-0">
              <button
                type="button"
                disabled={!canGoBack}
                onClick={goBack}
                title={prevEntry ? `${t(lang, 'navBack')}: ${getTabLabel(prevEntry.tab)}` : t(lang, 'navBack')}
                aria-label="Go Back"
                className="inline-flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-md text-xs font-semibold text-[#0F2744] hover:bg-white disabled:opacity-35 disabled:hover:bg-transparent transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span className="hidden md:inline">{t(lang, 'navBack')}</span>
              </button>
              <div className="w-px h-4 bg-slate-200" />
              <button
                type="button"
                disabled={!canGoForward}
                onClick={goForward}
                title={nextEntry ? `${t(lang, 'navForward')}: ${getTabLabel(nextEntry.tab)}` : t(lang, 'navForward')}
                aria-label="Go Forward"
                className="inline-flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-md text-xs font-semibold text-[#0F2744] hover:bg-white disabled:opacity-35 disabled:hover:bg-transparent transition-colors"
              >
                <span className="hidden md:inline">{t(lang, 'navForward')}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-display font-bold text-[#0F2744] truncate">{activeLabel}</div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {!isInstalled && isInstallable && (
              <button
                type="button"
                onClick={install}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t(lang, 'installApp')}</span>
              </button>
            )}
            {!isInstalled && (
              <button
                type="button"
                onClick={() => setShowAppInstallModal(true)}
                title={t(lang, 'downloadApp')}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-[#0F2744] whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5 text-[#EA580C]" />
                <span className="hidden md:inline">
                  {lang === 'hi' ? 'ऐप / APK' : 'Get App / APK'}
                </span>
              </button>
            )}

            {!isReferral && (
              <button
                type="button"
                onClick={() => navigateTo('attendance', null, 'attendance')}
                aria-label="Open Daily Attendance"
                title={
                  todayAttendanceMarked
                    ? 'Today Attendance Marked — View Register & Leave'
                    : 'Mark Daily Attendance inside Ambika Office GPS'
                }
                className={`inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  todayAttendanceMarked
                    ? 'bg-green-50 border border-green-300 text-[#15803D] hover:bg-green-100'
                    : 'bg-[#15803D] hover:bg-green-800 text-white'
                }`}
              >
                <CalendarCheck2 className="w-4 h-4 shrink-0" />
                <span>
                  {todayAttendanceMarked
                    ? lang === 'hi'
                      ? 'हाज़िरी ✓'
                      : 'Marked'
                    : lang === 'hi'
                    ? 'हाज़िरी'
                    : 'Attendance'}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowProfileModal(true)}
              title={lang === 'hi' ? 'प्रोफ़ाइल संपादित करें' : 'Edit Profile (Photo, Name, Mobile, Email)'}
              className="inline-flex items-center gap-2 pl-1.5 pr-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-[#0F2744] whitespace-nowrap shrink-0"
            >
              <span className="w-6 h-6 rounded-full overflow-hidden bg-[#0F2744] text-white flex items-center justify-center text-[10px] font-bold shrink-0">
                {user.profilePhotoDataUrl ? (
                  <img src={user.profilePhotoDataUrl} alt={user.fullName} className="w-full h-full object-cover" />
                ) : (
                  <span>{userInitials}</span>
                )}
              </span>
              <span className="hidden sm:inline max-w-[120px] truncate">{user.fullName}</span>
            </button>

            {/* TOP HEADER BELL ICON: Red with unread count when > 0, Green when 0 */}
            <button
              type="button"
              onClick={() => navigateTo('alerts')}
              aria-label="Open Alert Centre"
              title={unreadCount > 0 ? `${unreadCount} unread alerts` : 'All alerts read'}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                unreadCount > 0
                  ? 'bg-red-50 border-red-300 text-[#DC2626] hover:bg-red-100'
                  : 'bg-green-50 border-green-300 text-[#15803D] hover:bg-green-100'
              }`}
            >
              <Bell className="w-4 h-4" />
              <span className="font-mono tabular-nums">{unreadCount}</span>
            </button>
          </div>
        </header>

        {!isOnline && (
          <div className="bg-amber-500 text-white px-4 py-2 text-xs font-semibold flex flex-wrap items-center justify-center gap-2">
            <CloudOff className="w-3.5 h-3.5 shrink-0" />
            <span>
              {t(lang, 'offlineBanner')}
              {pendingOfflineCount > 0 ? ` · ${pendingOfflineCount} lead(s) queued locally for auto-sync.` : ''}
            </span>
          </div>
        )}

        {isOnline && pendingOfflineCount > 0 && (
          <div className="bg-[#0F2744] text-white px-4 py-2 text-xs font-semibold flex flex-wrap items-center justify-center gap-3 border-b border-white/10">
            <span>{pendingOfflineCount} offline lead(s) ready to sync to server.</span>
            <button
              type="button"
              disabled={syncingOffline}
              onClick={runOfflineSyncNow}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#EA580C] hover:bg-[#C2410C] text-white text-[11px] font-semibold disabled:opacity-60"
            >
              <RefreshCw className={`w-3 h-3 ${syncingOffline ? 'animate-spin' : ''}`} />
              {syncingOffline ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        )}

        {syncBannerMsg && (
          <div className="bg-[#15803D] text-white px-4 py-2 text-xs font-semibold flex items-center justify-between gap-3">
            <span>{syncBannerMsg}</span>
            <button
              type="button"
              onClick={() => setSyncBannerMsg(null)}
              className="text-white/80 hover:text-white"
              aria-label="Dismiss sync notice"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <main className="flex-1 p-4 pb-24 sm:p-6 lg:pb-6 max-w-7xl w-full mx-auto space-y-4">
          <MobileAppPromptBanner
            lang={lang}
            isInstalled={isInstalled}
            isInstallable={isInstallable}
            isIOS={isIOS}
            hasUploadedApk={settings.hasUploadedApk}
            apkDownloadUrl={settings.apkDownloadUrl}
            onInstallPWA={install}
            onOpenInstallModal={() => setShowAppInstallModal(true)}
          />

          {/* Universal Per-Page & Sub-Option Back/Forward Navigation Strip */}
          <div className="bg-white border border-slate-200 rounded-xl px-3.5 py-2 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <button
                type="button"
                disabled={!canGoBack}
                onClick={goBack}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-slate-50 text-xs font-semibold text-[#0F2744] transition-colors whitespace-nowrap"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>{t(lang, 'navBack')}</span>
                {prevEntry && (
                  <span className="hidden sm:inline text-[11px] font-normal text-slate-500">
                    ({getTabLabel(prevEntry.tab)})
                  </span>
                )}
              </button>
              <button
                type="button"
                disabled={!canGoForward}
                onClick={goForward}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-slate-50 text-xs font-semibold text-[#0F2744] transition-colors whitespace-nowrap"
              >
                <span>{t(lang, 'navForward')}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>

              <div className="h-4 w-px bg-slate-200 hidden sm:block" />

              <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-slate-600 min-w-0">
                <button
                  type="button"
                  onClick={() => navigateTo('dashboard')}
                  className="inline-flex items-center gap-1 font-medium hover:text-[#0F2744] whitespace-nowrap"
                >
                  <Home className="w-3.5 h-3.5 text-slate-400" />
                  <span>{t(lang, 'navHome')}</span>
                </button>
                {activeTab !== 'dashboard' && (
                  <>
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <button
                      type="button"
                      onClick={() => navigateTo(activeTab)}
                      className={`truncate max-w-[180px] ${
                        !activeSubOption && !selectedLeadId
                          ? 'font-bold text-[#0F2744]'
                          : 'font-medium hover:text-[#0F2744]'
                      }`}
                    >
                      {activeLabel}
                    </button>
                  </>
                )}
                {activeSubOption && (
                  <>
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="font-bold text-[#EA580C] truncate">
                      {formatSubOptionLabel(activeSubOption)}
                    </span>
                  </>
                )}
                {activeTab === 'leads' && selectedLeadId && (
                  <>
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="font-mono font-bold text-[#EA580C]">Case #{selectedLeadId}</span>
                  </>
                )}
              </nav>
            </div>

            {activeTab !== 'dashboard' && (
              <button
                type="button"
                onClick={() => navigateTo('dashboard')}
                className="text-[11px] font-semibold text-[#0F2744] hover:text-[#EA580C] whitespace-nowrap"
              >
                ← {t(lang, 'navHome')}
              </button>
            )}
          </div>

          {activeTab === 'dashboard' && (
            <DashboardView
              user={user}
              lang={lang}
              logoDataUrl={settings.companyLogoDataUrl}
              onNavigate={(tab, subOption) => navigateTo(tab, null, subOption ?? null)}
              onOpenLead={(leadId) => navigateTo('leads', leadId)}
            />
          )}
          {activeTab === 'bm-downline' && isManager && (
            <BmDownlinePanel
              user={user}
              lang={lang}
              onOpenLead={(leadId) => navigateTo('leads', leadId)}
            />
          )}
          {activeTab === 'leads' && (
            <LeadsModule
              user={user}
              lang={lang}
              loanProducts={settings.loanProducts}
              initialLeadId={selectedLeadId}
              activeOption={activeSubOption}
              onSelectOption={(opt, leadId = null) => navigateTo('leads', leadId, opt)}
              onBack={canGoBack ? goBack : undefined}
              prefillLead={prefillLead}
              onClearPrefill={() => setPrefillLead(null)}
              onAlertsChanged={fetchAlerts}
            />
          )}
          {activeTab === 'sales-hub' && (
            <SalesGrowthHubModule
              user={user}
              activeOption={activeSubOption as any}
              onSelectOption={(opt) => selectSubOption(opt)}
              onOpenLead={(leadId) => navigateTo('leads', leadId)}
              onCreateCrossSell={(seed) => {
                setPrefillLead(seed);
                navigateTo('leads', null, 'new-lead');
              }}
              onPreviewPublicReferral={(code) => setPublicRefCode(code)}
            />
          )}
          {activeTab === 'rewards' && !isReferral && (
            <RewardDashboard
              user={user}
              activeOption={activeSubOption as any}
              onSelectOption={(opt) => selectSubOption(opt)}
              onOpenLead={(leadId) => navigateTo('leads', leadId)}
              onAlertsChanged={fetchAlerts}
            />
          )}
          {activeTab === 'duplicates' && isSuperAdmin && (
            <DuplicateApprovalView
              activeOption={activeSubOption as any}
              onSelectOption={(opt) => selectSubOption(opt)}
              onChanged={fetchAlerts}
            />
          )}
          {activeTab === 'penalties' && !isReferral && (
            <PenaltyRegisterView user={user} onChanged={fetchAlerts} />
          )}
          {activeTab === 'enquiries' && (
            <EnquiriesModule
              user={user}
              activeOption={activeSubOption}
              onSelectOption={(opt) => selectSubOption(opt)}
              onAlertsChanged={fetchAlerts}
            />
          )}
          {activeTab === 'field-ops' && !isReferral && (
            <FieldOperationsModule
              user={user}
              activeOption={activeSubOption as any}
              onSelectOption={(opt) => selectSubOption(opt)}
              onAlertsChanged={fetchAlerts}
            />
          )}
          {activeTab === 'attendance' && !isReferral && (
            <AttendanceLeaveModule
              user={user}
              activeOption={activeSubOption as any}
              onSelectOption={(opt) => selectSubOption(opt)}
              onAlertsChanged={fetchAlerts}
              onAttendanceMarked={() => setTodayAttendanceMarked(true)}
            />
          )}
          {activeTab === 'alerts' && (
            <AlertCentreView
              alerts={alerts}
              lang={lang}
              activeOption={activeSubOption as any}
              onSelectOption={(opt) => selectSubOption(opt)}
              onRefresh={fetchAlerts}
              onOpenRelated={(alert) => {
                if (alert.leadId) navigateTo('leads', alert.leadId);
                else if (alert.enquiryId) navigateTo('enquiries');
              }}
            />
          )}
          {activeTab === 'calculator' && (
            <CalculatorModule
              loanProducts={settings.loanProducts}
              userRole={user.role}
              lang={lang}
              activeOption={activeSubOption}
              onSelectOption={(opt) => selectSubOption(opt)}
            />
          )}
          {activeTab === 'reports' && (
            <ReportsModule
              user={user}
              activeOption={activeSubOption}
              onSelectOption={(opt) => selectSubOption(opt)}
            />
          )}
          {activeTab === 'admin' && isManager && (
            <AdminSettingsModule
              user={user}
              settings={settings}
              activeOption={activeSubOption as any}
              onSelectOption={(opt) => selectSubOption(opt)}
              onSettingsUpdated={(next) => setSettings(next)}
            />
          )}
          {activeTab === 'referrals' && canAccessReferralConsole && (
            <ReferralConsoleModule user={user} lang={lang} />
          )}
        </main>
      </div>

      {/* Native-Style Mobile App Bottom Bar (Android, iPhone, iPod Touch & iPad Full Version) */}
      <nav
        aria-label="Mobile Bottom Navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-slate-200 px-2 pt-1.5 pb-[max(0.4rem,env(safe-area-inset-bottom))] grid grid-cols-5 items-center shadow-lg"
      >
        <button
          type="button"
          onClick={() => navigateTo('dashboard')}
          className={`flex flex-col items-center justify-center gap-0.5 py-1 rounded-lg text-[10px] font-semibold ${
            activeTab === 'dashboard' ? 'text-[#EA580C]' : 'text-slate-500'
          }`}
        >
          <LayoutDashboard className="w-4 h-4" />
          <span>Home</span>
        </button>

        <button
          type="button"
          onClick={() => navigateTo('leads')}
          className={`flex flex-col items-center justify-center gap-0.5 py-1 rounded-lg text-[10px] font-semibold ${
            activeTab === 'leads' ? 'text-[#EA580C]' : 'text-slate-500'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>Leads</span>
        </button>

        <button
          type="button"
          onClick={() => setShowQuickCamera(true)}
          aria-label="Open Mobile Camera"
          className="flex flex-col items-center justify-center -mt-4"
        >
          <span className="w-11 h-11 rounded-full bg-[#EA580C] text-white shadow-md flex items-center justify-center border-2 border-white">
            <Camera className="w-5 h-5" />
          </span>
          <span className="text-[10px] font-bold text-[#0F2744] mt-0.5">Camera</span>
        </button>

        <button
          type="button"
          onClick={() => navigateTo(isReferral ? 'enquiries' : 'attendance', null, isReferral ? null : 'attendance')}
          className={`flex flex-col items-center justify-center gap-0.5 py-1 rounded-lg text-[10px] font-semibold ${
            activeTab === (isReferral ? 'enquiries' : 'attendance')
              ? 'text-[#EA580C]'
              : !isReferral && todayAttendanceMarked
              ? 'text-[#15803D]'
              : 'text-slate-600'
          }`}
        >
          {isReferral ? <HelpCircle className="w-4 h-4" /> : <CalendarCheck2 className="w-4 h-4" />}
          <span>{isReferral ? 'Enquiry' : todayAttendanceMarked ? 'Marked ✓' : 'Attendance'}</span>
        </button>

        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className="flex flex-col items-center justify-center gap-0.5 py-1 rounded-lg text-[10px] font-semibold text-slate-600"
        >
          <Menu className="w-4 h-4" />
          <span>Menu</span>
        </button>
      </nav>

      {/* Unified App Download / Install Modal (PWA, Play Store, Android APK, APK Build Kit, iPhone/iPod) */}
      {showAppInstallModal && (
        <AppInstallModal
          lang={lang}
          logoDataUrl={settings.companyLogoDataUrl}
          isInstallable={isInstallable}
          isInstalled={isInstalled}
          isIOS={isIOS}
          isAndroid={isAndroid}
          onInstallPWA={install}
          playStoreUrl={settings.playStoreUrl}
          apkDownloadUrl={settings.apkDownloadUrl}
          hasUploadedApk={settings.hasUploadedApk}
          apkFileSize={settings.apkFileSize}
          hasUploadedAab={settings.hasUploadedAab}
          aabFileSize={settings.aabFileSize}
          onClose={() => setShowAppInstallModal(false)}
        />
      )}

      {legalTab && (
        <LegalTermsModal
          lang={lang}
          initialTab={legalTab}
          onClose={() => setLegalTab(null)}
        />
      )}

      {showProfileModal && (
        <ProfileModal
          user={user}
          lang={lang}
          officeAddress={settings.officeAddress}
          onProfileUpdated={(updated) => setUser(updated)}
          onOfficeAddressUpdated={(nextAddress) =>
            setSettings((prev) => ({ ...prev, officeAddress: nextAddress }))
          }
          onClose={() => setShowProfileModal(false)}
        />
      )}

      {/* Full-Featured Quick Camera Studio (Visit Selfie with Geo+Time or Clean Document Scan + PAN OCR) */}
      {showQuickCamera && (
        <QuickCameraModal
          user={user}
          onClose={() => setShowQuickCamera(false)}
          onActivitySaved={fetchAlerts}
          onPrefillLeadFromOcr={(ocrData) => {
            setPrefillLead({
              customerName: ocrData.customerName,
              customerMobile: '',
              panNumber: ocrData.panNumber,
              dob: ocrData.dob || '',
              loanProduct: settings.loanProducts[0]?.name || 'Home Loan',
              bankNbfc: 'HDFC Bank',
              remarks: ocrData.panNumber
                ? `Pre-filled via PAN Card OCR (${ocrData.panNumber})`
                : 'Pre-filled via PAN Card OCR',
              scannedDocs: isReferral ? undefined : [ocrData.scannedDoc],
            });
            setShowQuickCamera(false);
            navigateTo('leads', null, 'new-lead');
          }}
        />
      )}
    </div>
  );
}
