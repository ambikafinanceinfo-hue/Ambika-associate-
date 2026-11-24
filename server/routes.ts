import { spawn } from 'child_process';
import crypto from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';
import bcrypt from 'bcryptjs';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  CASE_STATUSES,
  ENQUIRY_STATUSES,
  HIERARCHY_LIMITS,
  PRODUCT_DOC_CHECKLIST,
  type AuthUser,
  type CaseStatus,
  type LeadRecord,
  type UserRole,
} from '../shared/types.ts';
import { decryptPii, encryptPii, generateSessionToken, hashLookup } from './crypto.ts';
import {
  APP_BUILD_VERSION,
  bumpConfigVersion,
  clearTestData,
  createAlert,
  db,
  getSettings,
  getSuperAdminIds,
  logAudit,
  seedSalesExtensionsIfNeeded,
  seedVerificationDatasetInternal,
  syncUsersBackupToDisk,
  updateSetting,
  UPLOADS_PATH,
} from './db.ts';
import { getOfficerWorkloadSnapshots, scoreOfficersForLead } from './loadBalancer.ts';
import { processSlaTimers, purgeExpiredFollowupRecordings } from './slaEngine.ts';

interface AuthedRequest extends Request {
  user?: AuthUser;
  sessionToken?: string;
}

interface LiveSyncClient {
  res: Response;
  userId: number;
  role: UserRole;
}

const liveSyncClients = new Set<LiveSyncClient>();

function pushSseEvent(eventName: string, payload: Record<string, any>) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of Array.from(liveSyncClients)) {
    try {
      client.res.write(frame);
    } catch {
      liveSyncClients.delete(client);
    }
  }
}

function broadcastLiveSync(scope: string, summary: string, actor?: AuthUser | null) {
  const { configVersion, updatedAt } = bumpConfigVersion(summary, actor?.id ?? null);
  pushSseEvent('sync', {
    scope,
    summary,
    configVersion,
    appBuildVersion: APP_BUILD_VERSION,
    updatedAt,
    updatedBy: actor?.fullName || 'Super Admin',
    updatedByRole: actor?.role || 'SUPER_ADMIN',
  });
}

function nowSql(offsetMinutes = 0): string {
  return new Date(Date.now() + offsetMinutes * 60000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function loadUserById(userId: number): AuthUser | null {
  const row = db
    .prepare(`
      SELECT u.*, b.name as branch_name, t.name as team_name,
        rep.full_name as reports_to_name, rep.employee_code as reports_to_code
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      LEFT JOIN teams t ON t.id = u.team_id
      LEFT JOIN users rep ON rep.id = u.reports_to_user_id
      WHERE u.id = ?
    `)
    .get(userId) as any;
  if (!row) return null;
  return {
    id: row.id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    mobile: row.mobile,
    email: row.email,
    role: row.role as UserRole,
    branchId: row.branch_id,
    branchName: row.branch_name ?? null,
    teamId: row.team_id,
    teamName: row.team_name ?? null,
    referralCode: row.referral_code ?? null,
    reportsToUserId: row.reports_to_user_id ?? null,
    reportsToName: row.reports_to_name ?? null,
    reportsToCode: row.reports_to_code ?? null,
    isActive: Boolean(row.is_active),
    otpEnabled: Boolean(row.otp_enabled),
    gpsConsent: Boolean(row.gps_consent),
    cameraConsent: Boolean(row.camera_consent),
    preferredLang: row.preferred_lang === 'hi' ? 'hi' : 'en',
    profilePhotoDataUrl: row.profile_photo_data_url ?? null,
  };
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : queryToken;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const session = db
    .prepare(`SELECT user_id, expires_at FROM sessions WHERE token = ?`)
    .get(token) as { user_id: number; expires_at: string } | undefined;

  if (!session || session.expires_at < nowSql()) {
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  const user = loadUserById(session.user_id);
  if (!user || !user.isActive) {
    res.status(403).json({ error: 'Account inactive or not found' });
    return;
  }

  req.user = user;
  req.sessionToken = token;
  next();
}

function requireRoles(...allowed: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient role permissions for this operation' });
      return;
    }
    next();
  };
}

function resolveLeadClosureSeniority(row: any): {
  actorRole: UserRole;
  expectedApproverRole: 'TEAM_LEADER' | 'BRANCH_MANAGER' | 'SUPER_ADMIN';
  expectedApproverLabel: string;
} {
  const actorRole: UserRole =
    (row.rejected_by_role as UserRole) ||
    (row.assigned_officer_id
      ? 'FIELD_OFFICER'
      : row.assigned_tl_id
        ? 'TEAM_LEADER'
        : row.assigned_bm_id
          ? 'BRANCH_MANAGER'
          : (row.created_by_role as UserRole) || 'BRANCH_MANAGER');

  if (actorRole === 'FIELD_OFFICER') {
    return {
      actorRole,
      expectedApproverRole: 'TEAM_LEADER',
      expectedApproverLabel: 'Team Leader (TL)',
    };
  }
  if (actorRole === 'TEAM_LEADER' || actorRole === 'LEAD_GENERATOR') {
    return {
      actorRole,
      expectedApproverRole: 'BRANCH_MANAGER',
      expectedApproverLabel: 'Branch Manager (BM)',
    };
  }
  return {
    actorRole,
    expectedApproverRole: 'SUPER_ADMIN',
    expectedApproverLabel: 'Super Admin',
  };
}

function serializeLeadForUser(row: any, user: AuthUser): LeadRecord {
  const isReferral = user.role === 'REFERRAL_PARTNER';
  if (isReferral) {
    return {
      id: row.id,
      leadCode: row.lead_code,
      customerName: row.customer_name,
      customerMobile: null,
      alternateMobile: null,
      panNumber: null,
      dob: null,
      address: null,
      city: null,
      state: null,
      pinCode: null,
      loanProduct: row.loan_product,
      loanAmount: null,
      employmentDetails: null,
      monthlyIncome: null,
      bankNbfc: row.bank_nbfc,
      referralId: row.referral_id,
      referralName: row.referral_name,
      createdBy: row.created_by,
      createdByName: row.created_by_name,
      createdByRole: null,
      createdByCode: null,
      assignedOfficerId: row.assigned_officer_id,
      assignedOfficerName: row.assigned_officer_name ?? null,
      assignedOfficerCode: null,
      assignedOfficerMobile: row.assigned_officer_mobile ?? null,
      assignedAt: row.assigned_at,
      assignmentDeadlineAt: null,
      branchId: row.branch_id,
      branchName: row.branch_name ?? null,
      status: row.status as CaseStatus,
      lostReason: null,
      rejectedBy: null,
      rejectedByName: null,
      rejectedByCode: null,
      rejectedByRole: null,
      rejectedAt: null,
      closureStatus: null,
      closureRequestedBy: null,
      closureRequestedByName: null,
      closureRequestedAt: null,
      closureApprovedBy: null,
      closureApprovedByName: null,
      closureApprovedAt: null,
      closureRemarks: null,
      expectedClosureApproverRole: null,
      expectedClosureApproverLabel: null,
      canApproveClosure: false,
      existingEmi: null,
      employmentType: null,
      lastStatusAt: row.last_status_at,
      remarks: null,
      customerConsent: Boolean(row.customer_consent),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      redactedForReferral: true,
    };
  }

  const closureSeniority = resolveLeadClosureSeniority(row);
  const effectiveClosureStatus =
    (row.closure_status as LeadRecord['closureStatus']) ||
    (row.status === 'Rejected' ? 'PENDING_APPROVAL' : row.status === 'Closed' ? 'APPROVED' : 'NONE');
  const canApproveClosure =
    row.status === 'Rejected' &&
    effectiveClosureStatus === 'PENDING_APPROVAL' &&
    user.role === closureSeniority.expectedApproverRole &&
    canUserAccessLead(row, user);

  return {
    id: row.id,
    leadCode: row.lead_code,
    customerName: row.customer_name,
    customerMobile: decryptPii(row.customer_mobile_enc),
    alternateMobile: decryptPii(row.alternate_mobile_enc),
    panNumber: decryptPii(row.pan_enc),
    dob: row.dob ?? null,
    address: decryptPii(row.address_enc),
    city: row.city ?? null,
    state: row.state ?? null,
    pinCode: row.pin_code ?? null,
    loanProduct: row.loan_product,
    loanAmount: Number(row.loan_amount ?? 0),
    employmentDetails: row.employment_details ?? null,
    monthlyIncome: row.monthly_income !== null ? Number(row.monthly_income) : null,
    bankNbfc: row.bank_nbfc,
    referralId: row.referral_id ?? null,
    referralName: row.referral_name ?? null,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdByRole: (row.created_by_role as UserRole) ?? null,
    createdByCode: row.created_by_code ?? null,
    assignedBmId: row.assigned_bm_id ?? null,
    assignedBmName: row.assigned_bm_name ?? null,
    assignedBmCode: row.assigned_bm_code ?? null,
    assignedTlId: row.assigned_tl_id ?? null,
    assignedTlName: row.assigned_tl_name ?? null,
    assignedTlCode: row.assigned_tl_code ?? null,
    assignedOfficerId: row.assigned_officer_id ?? null,
    assignedOfficerName: row.assigned_officer_name ?? null,
    assignedOfficerCode: row.assigned_officer_code ?? null,
    assignedOfficerMobile: row.assigned_officer_mobile ?? null,
    assignedAt: row.assigned_at ?? null,
    assignmentDeadlineAt: row.assignment_deadline_at ?? null,
    branchId: row.branch_id ?? null,
    branchName: row.branch_name ?? null,
    status: row.status as CaseStatus,
    lostReason: row.lost_reason ?? null,
    rejectedBy: row.rejected_by ?? null,
    rejectedByName: row.rejected_by_name ?? null,
    rejectedByCode: row.rejected_by_code ?? null,
    rejectedByRole: (row.rejected_by_role as UserRole) ?? null,
    rejectedAt: row.rejected_at ?? null,
    closureStatus: effectiveClosureStatus,
    closureRequestedBy: row.closure_requested_by ?? null,
    closureRequestedByName: row.closure_requested_by_name ?? null,
    closureRequestedAt: row.closure_requested_at ?? null,
    closureApprovedBy: row.closure_approved_by ?? null,
    closureApprovedByName: row.closure_approved_by_name ?? null,
    closureApprovedAt: row.closure_approved_at ?? null,
    closureRemarks: row.closure_remarks ?? null,
    expectedClosureApproverRole:
      row.status === 'Rejected' || effectiveClosureStatus !== 'NONE' ? closureSeniority.expectedApproverRole : null,
    expectedClosureApproverLabel:
      row.status === 'Rejected' || effectiveClosureStatus !== 'NONE' ? closureSeniority.expectedApproverLabel : null,
    canApproveClosure,
    existingEmi: row.existing_emi !== undefined && row.existing_emi !== null ? Number(row.existing_emi) : 0,
    employmentType: row.employment_type ?? 'Salaried',
    lastStatusAt: row.last_status_at ?? null,
    remarks: row.remarks ?? null,
    customerConsent: Boolean(row.customer_consent),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    redactedForReferral: false,
  };
}

function buildLeadScopeFilter(user: AuthUser): { sql: string; params: unknown[] } {
  switch (user.role) {
    case 'SUPER_ADMIN':
    case 'LEAD_GENERATOR':
      // Back Office Team & Super Admin see all Referral leads (to assign BM-wise), Back Office leads, and FO daily leads
      return { sql: '1 = 1', params: [] };
    case 'BRANCH_MANAGER':
      // Branch Manager sees leads explicitly routed to them by Back Office, leads they created, or FO/TL leads in their branch
      // (Never unrouted Referral Partner leads where assigned_bm_id IS NULL)
      return {
        sql: `(
          l.assigned_bm_id = ?
          OR l.created_by = ?
          OR (
            l.branch_id = ?
            AND l.created_by IN (SELECT id FROM users WHERE role IN ('FIELD_OFFICER', 'TEAM_LEADER', 'BRANCH_MANAGER'))
          )
        )`,
        params: [user.id, user.id, user.branchId ?? -1],
      };
    case 'TEAM_LEADER':
      // Team Leader sees leads assigned to them by BM, leads they created, or leads generated/assigned to their Field Officers
      return {
        sql: `(
          l.assigned_tl_id = ?
          OR l.created_by = ?
          OR l.created_by IN (
            SELECT id FROM users WHERE role = 'FIELD_OFFICER' AND (reports_to_user_id = ? OR (? IS NOT NULL AND team_id = ?))
          )
          OR l.assigned_officer_id IN (
            SELECT id FROM users WHERE reports_to_user_id = ? OR (? IS NOT NULL AND team_id = ?)
          )
        )`,
        params: [
          user.id,
          user.id,
          user.id,
          user.teamId ?? null,
          user.teamId ?? -1,
          user.id,
          user.teamId ?? null,
          user.teamId ?? -1,
        ],
      };
    case 'FIELD_OFFICER':
      return {
        sql: '(l.assigned_officer_id = ? OR l.created_by = ?)',
        params: [user.id, user.id],
      };
    case 'REFERRAL_PARTNER':
      return {
        sql: '(l.created_by = ? OR (l.referral_id IS NOT NULL AND UPPER(l.referral_id) = UPPER(?)))',
        params: [user.id, user.referralCode ?? '__NONE__'],
      };
  }
}

const LOGGED_IN_OR_BEYOND_STATUSES = new Set<string>([
  'Case Logged In',
  'Under Process',
  'Query Raised',
  'Approved',
  'Disbursement Pending',
  'Disbursed',
]);

function getLeadDocumentCompletion(leadId: number, loanProduct: string): {
  docsComplete: boolean;
  uploadedCount: number;
  requiredCount: number;
  missingDocs: string[];
} {
  const requiredCats = PRODUCT_DOC_CHECKLIST[loanProduct] || [
    'PAN Card',
    'Aadhaar Card',
    'Photograph',
    'Bank Statement',
  ];
  const uploadedRows = db
    .prepare(`SELECT DISTINCT category FROM documents WHERE lead_id = ?`)
    .all(leadId) as { category: string }[];
  const uploadedSet = new Set(uploadedRows.map((r) => r.category));
  const missingDocs = requiredCats.filter((c) => !uploadedSet.has(c));
  return {
    docsComplete: missingDocs.length === 0,
    uploadedCount: requiredCats.length - missingDocs.length,
    requiredCount: requiredCats.length,
    missingDocs,
  };
}

function evaluateAndAwardLeadRewards(
  leadId: number,
  actorUserId: number,
  forceDocsComplete = false
): {
  docsComplete: boolean;
  missingDocs: string[];
  awardedEntries: { employeeId: number; staffBucket: string; entryType: string; points: number }[];
} {
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(leadId) as any;
  if (!lead) {
    return { docsComplete: false, missingDocs: [], awardedEntries: [] };
  }
  const completion = getLeadDocumentCompletion(leadId, lead.loan_product);
  const docsComplete = completion.docsComplete || forceDocsComplete;
  const settings = getSettings();
  const awardedEntries: { employeeId: number; staffBucket: string; entryType: string; points: number }[] = [];

  const officerUser = lead.assigned_officer_id
    ? (db.prepare(`SELECT id, role, is_active FROM users WHERE id = ?`).get(lead.assigned_officer_id) as any)
    : null;
  const generatorUser = lead.created_by
    ? (db.prepare(`SELECT id, role, is_active FROM users WHERE id = ?`).get(lead.created_by) as any)
    : null;

  const isOfficerEligible = Boolean(officerUser && officerUser.role !== 'REFERRAL_PARTNER');
  const isGeneratorEligible = Boolean(
    generatorUser &&
      generatorUser.role !== 'REFERRAL_PARTNER' &&
      (!isOfficerEligible || generatorUser.id !== officerUser.id)
  );

  const insertReward = (
    employeeId: number,
    staffBucket: 'FIELD_OFFICER' | 'LEAD_GENERATOR',
    entryType: 'DOC_LOGIN_REWARD' | 'DISBURSEMENT_REWARD',
    points: number,
    reason: string,
    titleEn: string,
    titleHi: string,
    messageEn: string,
    messageHi: string
  ) => {
    if (points <= 0) return;
    const rewardCode = `RWD-${entryType === 'DOC_LOGIN_REWARD' ? 'LGN' : 'DSB'}-${staffBucket === 'FIELD_OFFICER' ? 'FO' : 'GN'}-${leadId}-${employeeId}`;
    const info = db
      .prepare(`
        INSERT OR IGNORE INTO staff_rewards
          (reward_code, employee_id, staff_bucket, lead_id, entry_type, points_delta, amount_inr, status, reason, awarded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      `)
      .run(rewardCode, employeeId, staffBucket, leadId, entryType, points, points, reason, actorUserId);

    if (info.changes > 0) {
      awardedEntries.push({ employeeId, staffBucket, entryType, points });
      createAlert({
        userId: employeeId,
        leadId,
        category: 'Lead Follow-up Alert',
        titleEn,
        titleHi,
        messageEn,
        messageHi,
      });
    }
  };

  // 1. Separate Reward for Document Complete + Finance Company Login
  if (docsComplete && LOGGED_IN_OR_BEYOND_STATUSES.has(lead.status)) {
    const foPts = Number(settings.loginRewardOfficerPts ?? 50);
    const genPts = Number(settings.loginRewardGeneratorPts ?? 30);

    if (isOfficerEligible) {
      insertReward(
        officerUser.id,
        'FIELD_OFFICER',
        'DOC_LOGIN_REWARD',
        foPts,
        `Documents complete & logged in with ${lead.bank_nbfc} (${lead.lead_code})`,
        `+${foPts} Login Reward Points: ${lead.lead_code}`,
        `+${foPts} लॉगिन रिवॉर्ड पॉइंट्स: ${lead.lead_code}`,
        `Earned +${foPts} pts (₹${foPts}) — KYC documents completed and case logged in to ${lead.bank_nbfc}.`,
        `${lead.bank_nbfc} में पूर्ण दस्तावेजों के साथ लॉगिन पर +${foPts} रिवॉर्ड पॉइंट्स मिले।`
      );
    }
    if (isGeneratorEligible) {
      insertReward(
        generatorUser.id,
        'LEAD_GENERATOR',
        'DOC_LOGIN_REWARD',
        genPts,
        `Lead generator reward: Documents complete & logged in (${lead.lead_code})`,
        `+${genPts} Generator Login Reward: ${lead.lead_code}`,
        `+${genPts} लीड जनरेटर लॉगिन रिवॉर्ड: ${lead.lead_code}`,
        `Earned +${genPts} pts (₹${genPts}) as Lead Generator — ${lead.lead_code} documents completed and logged in.`,
        `लीड जनरेटर के रूप में ${lead.lead_code} लॉगिन पर +${genPts} पॉइंट्स मिले।`
      );
    }
  }

  // 2. Separate Reward for Loan Disbursement
  if (lead.status === 'Disbursed') {
    const foDisbPts = Number(settings.disbursementRewardOfficerPts ?? 150);
    const genDisbPts = Number(settings.disbursementRewardGeneratorPts ?? 100);

    if (isOfficerEligible) {
      insertReward(
        officerUser.id,
        'FIELD_OFFICER',
        'DISBURSEMENT_REWARD',
        foDisbPts,
        `Loan disbursement reward for ${lead.lead_code} (${lead.bank_nbfc})`,
        `+${foDisbPts} Disbursement Reward Points: ${lead.lead_code}`,
        `+${foDisbPts} वितरण रिवॉर्ड पॉइंट्स: ${lead.lead_code}`,
        `Earned +${foDisbPts} pts (₹${foDisbPts}) on Disbursement of ${lead.lead_code}.`,
        `${lead.lead_code} के ऋण वितरण पर +${foDisbPts} रिवॉर्ड पॉइंट्स मिले।`
      );
    }
    if (isGeneratorEligible) {
      insertReward(
        generatorUser.id,
        'LEAD_GENERATOR',
        'DISBURSEMENT_REWARD',
        genDisbPts,
        `Lead generator disbursement reward for ${lead.lead_code}`,
        `+${genDisbPts} Generator Disbursement Reward: ${lead.lead_code}`,
        `+${genDisbPts} जनरेटर वितरण रिवॉर्ड: ${lead.lead_code}`,
        `Earned +${genDisbPts} pts (₹${genDisbPts}) as Lead Generator — ${lead.lead_code} disbursed.`,
        `${lead.lead_code} के वितरण पर लीड जनरेटर +${genDisbPts} पॉइंट्स मिले।`
      );
    }
  }

  return {
    docsComplete,
    missingDocs: completion.missingDocs,
    awardedEntries,
  };
}

function canUserAccessLead(row: any, user: AuthUser): boolean {
  if (user.role === 'SUPER_ADMIN' || user.role === 'LEAD_GENERATOR') return true;
  if (user.role === 'BRANCH_MANAGER') {
    if (row.assigned_bm_id === user.id || row.created_by === user.id) return true;
    const creatorRole =
      row.created_by_role ??
      (db.prepare('SELECT role FROM users WHERE id = ?').get(row.created_by) as { role: string } | undefined)?.role;
    return (
      row.branch_id === user.branchId &&
      ['FIELD_OFFICER', 'TEAM_LEADER', 'BRANCH_MANAGER'].includes(String(creatorRole || ''))
    );
  }
  if (user.role === 'TEAM_LEADER') {
    if (row.assigned_tl_id === user.id || row.created_by === user.id) return true;
    const creator = db
      .prepare('SELECT role, reports_to_user_id, team_id FROM users WHERE id = ?')
      .get(row.created_by) as { role: string; reports_to_user_id: number | null; team_id: number | null } | undefined;
    if (
      creator?.role === 'FIELD_OFFICER' &&
      (creator.reports_to_user_id === user.id || (user.teamId && creator.team_id === user.teamId))
    ) {
      return true;
    }
    if (row.assigned_officer_id) {
      const officer = db
        .prepare('SELECT reports_to_user_id, team_id FROM users WHERE id = ?')
        .get(row.assigned_officer_id) as { reports_to_user_id: number | null; team_id: number | null } | undefined;
      if (officer && (officer.reports_to_user_id === user.id || (user.teamId && officer.team_id === user.teamId))) {
        return true;
      }
    }
    return false;
  }
  if (user.role === 'FIELD_OFFICER') {
    return row.assigned_officer_id === user.id || row.created_by === user.id;
  }
  if (user.role === 'REFERRAL_PARTNER') {
    if (row.created_by === user.id) return true;
    if (user.referralCode && row.referral_id && String(row.referral_id).toUpperCase() === user.referralCode.toUpperCase()) {
      return true;
    }
    return false;
  }
  return false;
}

function getScopedOfficerIdsForUser(user: AuthUser): number[] | undefined {
  if (user.role === 'TEAM_LEADER') {
    const rows = db
      .prepare(`
        SELECT id FROM users
        WHERE is_active = 1 AND role = 'FIELD_OFFICER'
          AND (reports_to_user_id = ? OR (? IS NOT NULL AND team_id = ?))
      `)
      .all(user.id, user.teamId ?? null, user.teamId ?? -1) as { id: number }[];
    return rows.map((r) => Number(r.id));
  }
  if (user.role === 'BRANCH_MANAGER') {
    const rows = db
      .prepare(`
        SELECT id FROM users
        WHERE is_active = 1 AND role IN ('FIELD_OFFICER', 'TEAM_LEADER')
          AND (
            (? IS NOT NULL AND branch_id = ?)
            OR reports_to_user_id IN (SELECT id FROM users WHERE reports_to_user_id = ?)
            OR reports_to_user_id = ?
          )
      `)
      .all(user.branchId ?? null, user.branchId ?? -1, user.id, user.id) as { id: number }[];
    return rows.map((r) => Number(r.id));
  }
  return undefined;
}

function resolveOfficerHierarchy(officerId: number): {
  bmId: number | null;
  tlId: number | null;
  branchId: number | null;
} {
  const officer = db
    .prepare(`SELECT id, role, branch_id, team_id, reports_to_user_id FROM users WHERE id = ?`)
    .get(officerId) as any;
  if (!officer) return { bmId: null, tlId: null, branchId: null };
  let tlId: number | null =
    officer.role === 'TEAM_LEADER'
      ? Number(officer.id)
      : officer.reports_to_user_id
        ? Number(officer.reports_to_user_id)
        : null;
  if (!tlId && officer.team_id) {
    const teamRow = db.prepare(`SELECT leader_user_id FROM teams WHERE id = ?`).get(officer.team_id) as
      | { leader_user_id: number | null }
      | undefined;
    if (teamRow?.leader_user_id) tlId = Number(teamRow.leader_user_id);
  }
  let bmId: number | null = null;
  if (tlId) {
    const tlRow = db.prepare(`SELECT reports_to_user_id FROM users WHERE id = ?`).get(tlId) as
      | { reports_to_user_id: number | null }
      | undefined;
    if (tlRow?.reports_to_user_id) bmId = Number(tlRow.reports_to_user_id);
  }
  if (!bmId && officer.branch_id) {
    const bmRow = db
      .prepare(`SELECT id FROM users WHERE role = 'BRANCH_MANAGER' AND branch_id = ? AND is_active = 1 LIMIT 1`)
      .get(officer.branch_id) as { id: number } | undefined;
    if (bmRow?.id) bmId = Number(bmRow.id);
  }
  return {
    bmId,
    tlId,
    branchId: officer.branch_id ? Number(officer.branch_id) : null,
  };
}

function generateLeadCode(): string {
  const year = new Date().getFullYear();
  const row = db.prepare('SELECT MAX(id) as maxId FROM leads').get() as { maxId: number | null };
  const next = (row?.maxId ?? 0) + 1;
  return `AMB-${year}-${String(next).padStart(4, '0')}`;
}

export function createApiRouter() {
  const router = express.Router();

  const resolvePublicOrigin = (req: Request): string => {
    const queryOrigin = typeof req.query.origin === 'string' ? req.query.origin.trim() : '';
    let resolved = '';
    if (/^https?:\/\/[a-zA-Z0-9._:-]+$/.test(queryOrigin)) {
      resolved = queryOrigin.replace(/\/+$/, '');
    } else {
      const xfProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
      const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
      if (host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
        resolved = `${xfProto}://${host}`;
      }
    }
    if (!resolved || resolved.includes('localhost') || resolved.includes('127.0.0.1')) {
      return 'https://ais-pre-qjijuhugfbwl3m7542cfsq-916287731082.asia-southeast1.run.app';
    }
    return resolved.replace('ais-dev-', 'ais-pre-');
  };

  // Raw Binary APK Upload / Delete (Super Admin Only — mounted BEFORE express.json)
  router.post(
    '/admin/upload-apk',
    requireAuth,
    requireRoles('SUPER_ADMIN'),
    express.raw({ type: ['application/vnd.android.package-archive', 'application/octet-stream'], limit: '80mb' }),
    (req: AuthedRequest, res) => {
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length < 100) {
        res.status(400).json({ error: 'Valid Android .apk binary file is required' });
        return;
      }
      // Verify standard APK/ZIP signature ("PK")
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
        res.status(400).json({ error: 'Invalid APK package format (missing ZIP/APK PK header)' });
        return;
      }
      const apkPath = path.join(UPLOADS_PATH, 'ambika-associate-crm.apk');
      fs.writeFileSync(apkPath, buf);
      logAudit(
        req.user!,
        'ANDROID_APK_UPLOADED',
        'SETTINGS',
        'APK',
        `Uploaded signed Android APK (${Math.round(buf.length / 1024)} KB) for direct download`
      );
      broadcastLiveSync('APP_BINARY_UPDATED', 'New Android APK build uploaded by Admin', req.user!);
      res.json({ ok: true, settings: getSettings() });
    }
  );

  router.delete('/admin/upload-apk', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const apkPath = path.join(UPLOADS_PATH, 'ambika-associate-crm.apk');
    if (fs.existsSync(apkPath)) {
      fs.unlinkSync(apkPath);
      logAudit(req.user!, 'ANDROID_APK_REMOVED', 'SETTINGS', 'APK', 'Removed hosted Android APK file');
    }
    res.json({ ok: true, settings: getSettings() });
  });

  // Raw Binary Play Store AAB Upload / Delete (Super Admin Only — mounted BEFORE express.json)
  router.post(
    '/admin/upload-aab',
    requireAuth,
    requireRoles('SUPER_ADMIN'),
    express.raw({ type: ['application/octet-stream', 'application/x-authorware-bin'], limit: '100mb' }),
    (req: AuthedRequest, res) => {
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length < 100) {
        res.status(400).json({ error: 'Valid Android App Bundle (.aab) file is required' });
        return;
      }
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
        res.status(400).json({ error: 'Invalid AAB bundle format (missing ZIP PK header)' });
        return;
      }
      const aabPath = path.join(UPLOADS_PATH, 'ambika-associate-crm.aab');
      fs.writeFileSync(aabPath, buf);
      logAudit(
        req.user!,
        'ANDROID_AAB_UPLOADED',
        'SETTINGS',
        'AAB',
        `Uploaded signed Play Store AAB (${Math.round(buf.length / 1024)} KB)`
      );
      broadcastLiveSync('APP_BINARY_UPDATED', 'New Play Store AAB build uploaded by Admin', req.user!);
      res.json({ ok: true, settings: getSettings() });
    }
  );

  router.delete('/admin/upload-aab', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const aabPath = path.join(UPLOADS_PATH, 'ambika-associate-crm.aab');
    if (fs.existsSync(aabPath)) {
      fs.unlinkSync(aabPath);
      logAudit(req.user!, 'ANDROID_AAB_REMOVED', 'SETTINGS', 'AAB', 'Removed hosted Play Store AAB file');
    }
    res.json({ ok: true, settings: getSettings() });
  });

  router.use(express.json({ limit: '20mb' }));

  // Public health & branding settings (logo + default language + app download links + live sync metadata)
  router.get('/public/branding', (_req, res) => {
    const settings = getSettings();
    res.json({
      companyName: 'AMBIKA ASSOCIATE',
      tagline: 'SMART FINANCE SMART SAVING',
      officeAddress: settings.officeAddress,
      companyLogoDataUrl: settings.companyLogoDataUrl,
      defaultLanguage: settings.defaultLanguage,
      otpRequiredGlobal: settings.otpRequiredGlobal,
      loanProducts: settings.loanProducts,
      playStoreUrl: settings.playStoreUrl ?? null,
      apkDownloadUrl: settings.apkDownloadUrl ?? null,
      hasUploadedApk: settings.hasUploadedApk ?? false,
      apkFileName: settings.apkFileName ?? null,
      apkFileSize: settings.apkFileSize ?? null,
      hasUploadedAab: settings.hasUploadedAab ?? false,
      aabFileName: settings.aabFileName ?? null,
      aabFileSize: settings.aabFileSize ?? null,
      seniorityInstructions: settings.seniorityInstructions,
      configVersion: settings.configVersion,
      appBuildVersion: settings.appBuildVersion,
      lastSyncSummary: settings.lastSyncSummary,
      lastSyncUpdatedAt: settings.lastSyncUpdatedAt,
    });
  });

  // Lightweight live sync version probe (used by downloaded mobile & desktop apps on resume/poll)
  router.get('/public/sync-version', (_req, res) => {
    const settings = getSettings();
    res.json({
      appBuildVersion: APP_BUILD_VERSION,
      configVersion: settings.configVersion,
      lastSyncSummary: settings.lastSyncSummary,
      lastSyncUpdatedAt: settings.lastSyncUpdatedAt,
      companyLogoDataUrl: settings.companyLogoDataUrl,
      officeAddress: settings.officeAddress,
      seniorityInstructions: settings.seniorityInstructions,
    });
  });

  // Real-time Server-Sent Events stream connecting all downloaded BM/TL/Back Office/Field Officer apps
  router.get('/live-sync', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const client: LiveSyncClient = { res, userId: user.id, role: user.role };
    liveSyncClients.add(client);

    const settings = getSettings();
    res.write(
      `event: connected\ndata: ${JSON.stringify({
        configVersion: settings.configVersion,
        appBuildVersion: APP_BUILD_VERSION,
        lastSyncSummary: settings.lastSyncSummary,
        lastSyncUpdatedAt: settings.lastSyncUpdatedAt,
        role: user.role,
      })}\n\n`
    );

    const heartbeat = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        liveSyncClients.delete(client);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      liveSyncClients.delete(client);
    });
  });

  const streamPatchedAndroidKit = (req: Request, res: Response) => {
    const androidDir = path.join(process.cwd(), 'android-app');
    if (!fs.existsSync(androidDir)) {
      res.status(404).json({ error: 'Android companion source directory not found' });
      return;
    }

    const liveOrigin = resolvePublicOrigin(req);
    const escapedOrigin = liveOrigin.replace(/"/g, '\\"');
    const tmpParent = fs.mkdtempSync(path.join(UPLOADS_PATH, 'kit-'));
    const stagedDir = path.join(tmpParent, 'android-app');
    fs.cpSync(androidDir, stagedDir, { recursive: true });

    const gradleFile = path.join(stagedDir, 'app', 'build.gradle.kts');
    if (fs.existsSync(gradleFile)) {
      const original = fs.readFileSync(gradleFile, 'utf-8');
      const patched = original.replace(
        /("CRM_BASE_URL",\s*\r?\n?\s*)"\\"https?:\/\/[^"]+\\""/,
        `$1"\\"${escapedOrigin}\\""`
      );
      fs.writeFileSync(gradleFile, patched, 'utf-8');
    }

    const checklistFile = path.join(stagedDir, 'PLAY_STORE_CHECKLIST.md');
    if (fs.existsSync(checklistFile)) {
      const checklistOriginal = fs.readFileSync(checklistFile, 'utf-8');
      fs.writeFileSync(
        checklistFile,
        checklistOriginal.replace(
          /https:\/\/ais-pre-[^/]+/g,
          liveOrigin
        ),
        'utf-8'
      );
    }

    fs.writeFileSync(
      path.join(stagedDir, 'BUILD_APK_INSTRUCTIONS.txt'),
      [
        'AMBIKA ASSOCIATE CRM — Google Play Store (.aab) & Direct APK Build Instructions',
        `Configured CRM Server URL: ${liveOrigin}`,
        `Play Store Privacy Policy URL: ${liveOrigin}/privacy-policy`,
        `Play Store Terms & Conditions URL: ${liveOrigin}/terms-and-conditions`,
        `Play Store Account Deletion URL: ${liveOrigin}/account-deletion`,
        '',
        '1. Open this android-app folder in Android Studio (Koala or newer), OR push to GitHub to run .github/workflows/build-android.yml.',
        '2. Build Debug APK:      ./gradlew assembleDebug    -> app/build/outputs/apk/debug/app-debug.apk',
        '3. Build Release APK:    ./gradlew assembleRelease  -> app/build/outputs/apk/release/app-release.apk',
        '4. Build Play Store AAB: ./gradlew bundleRelease    -> app/build/outputs/bundle/release/app-release.aab',
        '5. Upload the compiled .apk in CRM Admin Settings -> Rules & Branding -> Upload Signed APK',
        '   so staff clicking "Download APK" install the compiled APK directly with one tap!',
      ].join('\n'),
      'utf-8'
    );

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="ambika-associate-android-studio-kit.tar.gz"'
    );

    const tar = spawn('tar', ['-czf', '-', 'android-app'], { cwd: tmpParent });
    tar.stdout.pipe(res);
    tar.stderr.on('data', (chunk) => {
      console.error('tar stderr:', chunk.toString());
    });
    const cleanup = () => {
      try {
        fs.rmSync(tmpParent, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    };
    tar.on('close', cleanup);
    tar.on('error', (err) => {
      cleanup();
      console.error('Failed to package Android Studio kit:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to generate Android Studio build kit' });
      } else {
        res.end();
      }
    });
  };

  // Download Direct Android APK (serves Admin-uploaded or bundled .apk, external apkDownloadUrl, or live-configured APK Build Kit)
  router.get('/public/download-apk', (req, res) => {
    const uploadedApkPath = path.join(UPLOADS_PATH, 'ambika-associate-crm.apk');
    const bundledApkPath = path.join(process.cwd(), 'public', 'ambika-associate-crm.apk');
    const apkPath = fs.existsSync(uploadedApkPath)
      ? uploadedApkPath
      : fs.existsSync(bundledApkPath)
        ? bundledApkPath
        : null;
    if (apkPath) {
      const stat = fs.statSync(apkPath);
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', 'attachment; filename="ambika-associate-crm.apk"');
      fs.createReadStream(apkPath).pipe(res);
      return;
    }

    const settings = getSettings();
    if (settings.apkDownloadUrl) {
      res.redirect(302, settings.apkDownloadUrl);
      return;
    }

    streamPatchedAndroidKit(req, res);
  });

  // Downloadable Android Studio Kotlin + Play Store AAB/APK Build Kit (live origin injected)
  router.get('/public/android-app-kit', streamPatchedAndroidKit);

  // Download Play Store .aab bundle (if uploaded or bundled), otherwise streams Play Store Build Kit
  router.get('/public/download-aab', (req, res) => {
    const uploadedAabPath = path.join(UPLOADS_PATH, 'ambika-associate-crm.aab');
    const bundledAabPath = path.join(process.cwd(), 'public', 'ambika-associate-crm.aab');
    const aabPath = fs.existsSync(uploadedAabPath)
      ? uploadedAabPath
      : fs.existsSync(bundledAabPath)
        ? bundledAabPath
        : null;
    if (aabPath) {
      const stat = fs.statSync(aabPath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', 'attachment; filename="ambika-associate-crm.aab"');
      fs.createReadStream(aabPath).pipe(res);
      return;
    }
    streamPatchedAndroidKit(req, res);
  });

  // Apple iOS / iPhone / iPod Touch / iPad Full-Screen WebClip Profile (.mobileconfig)
  router.get('/public/ios-app-profile', (req, res) => {
    const liveOrigin = resolvePublicOrigin(req);
    const iconCandidates = [
      path.join(process.cwd(), 'public', 'apple-touch-icon.png'),
      path.join(process.cwd(), 'public', 'pwa-512x512.png'),
      path.join(process.cwd(), 'public', 'pwa-192x192.png'),
    ];
    let iconBase64 = '';
    for (const candidate of iconCandidates) {
      if (fs.existsSync(candidate)) {
        iconBase64 = fs.readFileSync(candidate).toString('base64');
        break;
      }
    }

    const escapeXml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const iconXml = iconBase64
      ? `\t\t\t<key>Icon</key>\n\t\t\t<data>\n${iconBase64}\n\t\t\t</data>\n`
      : '';

    const mobileconfig = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
\t\t<dict>
\t\t\t<key>FullScreen</key>
\t\t\t<true/>
${iconXml}\t\t\t<key>IgnoreManifestScope</key>
\t\t\t<false/>
\t\t\t<key>IsRemovable</key>
\t\t\t<true/>
\t\t\t<key>Label</key>
\t\t\t<string>Ambika CRM</string>
\t\t\t<key>PayloadDescription</key>
\t\t\t<string>Installs AMBIKA ASSOCIATE CRM Full Mobile Version for iPhone, iPod Touch &amp; iPad.</string>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>AMBIKA ASSOCIATE CRM</string>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>in.ambikaassociate.crm.webclip</string>
\t\t\t<key>PayloadType</key>
\t\t\t<string>com.apple.webClip.managed</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>9A6D4C21-73B8-4F9E-A82C-10E5D3B4A701</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t\t<key>Precomposed</key>
\t\t\t<true/>
\t\t\t<key>URL</key>
\t\t\t<string>${escapeXml(liveOrigin)}</string>
\t\t</dict>
\t</array>
\t<key>PayloadDescription</key>
\t<string>Official AMBIKA ASSOCIATE Mobile App profile for iPhone, iPod Touch, and iPad.</string>
\t<key>PayloadDisplayName</key>
\t<string>AMBIKA ASSOCIATE CRM App</string>
\t<key>PayloadIdentifier</key>
\t<string>in.ambikaassociate.crm.profile</string>
\t<key>PayloadOrganization</key>
\t<string>AMBIKA ASSOCIATE</string>
\t<key>PayloadRemovalDisallowed</key>
\t<false/>
\t<key>PayloadType</key>
\t<string>Configuration</string>
\t<key>PayloadUUID</key>
\t<string>9A6D4C21-73B8-4F9E-A82C-10E5D3B4A700</string>
\t<key>PayloadVersion</key>
\t<integer>1</integer>
</dict>
</plist>`;

    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.setHeader('Content-Disposition', 'attachment; filename="ambika-associate-crm.mobileconfig"');
    res.send(mobileconfig);
  });

  // Public Referral QR Link Info & Customer Lead Capture
  router.get('/public/referral/:code', (req, res) => {
    const refCode = String(req.params.code || '').trim().toUpperCase();
    const partner = db
      .prepare(`
        SELECT u.id, u.full_name as fullName, u.referral_code as referralCode, b.name as branchName, b.city as branchCity
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        WHERE UPPER(u.referral_code) = ? AND u.role = 'REFERRAL_PARTNER' AND u.is_active = 1
      `)
      .get(refCode) as any;

    if (!partner) {
      res.status(404).json({ error: 'Referral partner code not found or inactive' });
      return;
    }

    const settings = getSettings();
    res.json({
      referralCode: partner.referralCode,
      partnerName: partner.fullName,
      branchName: partner.branchName || 'AMBIKA ASSOCIATE',
      branchCity: partner.branchCity || '',
      loanProducts: settings.loanProducts,
      companyLogoDataUrl: settings.companyLogoDataUrl,
    });
  });

  router.post('/public/referral-lead', (req, res) => {
    const {
      referralCode,
      customerName,
      customerMobile,
      panNumber,
      city,
      loanProduct,
      loanAmount,
      monthlyIncome,
      employmentType,
      customerConsent,
      remarks,
    } = req.body as Record<string, any>;

    const cleanCode = String(referralCode || '').trim().toUpperCase();
    const partner = db
      .prepare(`SELECT * FROM users WHERE UPPER(referral_code) = ? AND role = 'REFERRAL_PARTNER' AND is_active = 1`)
      .get(cleanCode) as any;
    if (!partner) {
      res.status(404).json({ error: 'Invalid or inactive Referral Code' });
      return;
    }

    const cleanName = String(customerName || '').trim();
    const cleanMobile = String(customerMobile || '').trim();
    const cleanPan = String(panNumber || '').trim().toUpperCase();
    const cleanProduct = String(loanProduct || 'Home Loan').trim();
    if (!cleanName || cleanMobile.length < 10 || !customerConsent) {
      res.status(400).json({ error: 'Customer name, 10-digit mobile, and consent are required' });
      return;
    }

    const nameNorm = cleanName.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const mobileHash = hashLookup(cleanMobile);
    const panHash = cleanPan ? hashLookup(cleanPan) : null;

    const candidates = db
      .prepare(`
        SELECT id, lead_code, customer_name_norm, customer_mobile_hash, pan_hash, referral_id, referral_name
        FROM leads
        WHERE customer_name_norm = ? OR customer_mobile_hash = ? OR (? IS NOT NULL AND pan_hash = ?)
      `)
      .all(nameNorm, mobileHash, panHash, panHash) as any[];

    if (candidates.length > 0) {
      const existing = candidates[0];
      const matchedFields: string[] = [];
      if (existing.customer_name_norm === nameNorm) matchedFields.push('Customer Name');
      if (existing.customer_mobile_hash === mobileHash) matchedFields.push('Mobile Number');
      if (panHash && existing.pan_hash === panHash) matchedFields.push('PAN Card Number');
      if (existing.referral_id && existing.referral_id.toUpperCase() === cleanCode) matchedFields.push('Referral ID');

      const reqCode = `DUP-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      db.prepare(`
        INSERT INTO duplicate_requests (request_code, existing_lead_id, matched_fields_json, submitted_payload_json, submitted_by, status)
        VALUES (?, ?, ?, ?, ?, 'PENDING')
      `).run(
        reqCode,
        existing.id,
        JSON.stringify(matchedFields),
        JSON.stringify({
          customerName: cleanName,
          customerMobile: cleanMobile,
          panNumber: cleanPan,
          loanProduct: cleanProduct,
          loanAmount: Number(loanAmount || 0),
          bankNbfc: 'HDFC Bank',
          city: city || '',
          referralId: partner.referral_code,
          referralName: partner.full_name,
          remarks: `Submitted via QR Referral Link (${partner.referral_code})`,
        }),
        partner.id
      );

      for (const adminId of getSuperAdminIds()) {
        createAlert({
          userId: adminId,
          leadId: existing.id,
          category: 'Duplicate Lead Verification Alert',
          titleEn: `QR Duplicate Request ${reqCode}`,
          titleHi: `QR डुप्लिकेट अनुरोध ${reqCode}`,
          messageEn: `Customer enquiry via ${partner.referral_code} matched ${existing.lead_code}. Pending Admin approval.`,
          messageHi: `${partner.referral_code} लिंक से प्राप्त लीड ${existing.lead_code} से मेल खाती है।`,
        });
      }

      res.status(202).json({
        duplicateDetected: true,
        message: 'DUPLICATE RECORD FOUND',
        requestCode: reqCode,
      });
      return;
    }

    // Referral QR leads go ONLY to Back Office Team & Admin queue (branch-BM routing happens there)
    const leadCode = generateLeadCode();
    const initialStatus: CaseStatus = 'Lead Generated';

    const inserted = db
      .prepare(`
        INSERT INTO leads (
          lead_code, customer_name, customer_name_norm, customer_mobile_enc, customer_mobile_hash,
          pan_enc, pan_hash, city, loan_product, loan_amount, employment_type, monthly_income,
          bank_nbfc, referral_id, referral_name, created_by, assigned_bm_id, assigned_tl_id,
          assigned_officer_id, assigned_at, assignment_deadline_at, branch_id, status, last_status_at, remarks, customer_consent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HDFC Bank', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 1)
      `)
      .run(
        leadCode,
        cleanName,
        nameNorm,
        encryptPii(cleanMobile),
        mobileHash,
        encryptPii(cleanPan || null),
        panHash,
        city ? String(city).trim() : null,
        cleanProduct,
        Number(loanAmount || 0),
        employmentType || 'Salaried',
        monthlyIncome ? Number(monthlyIncome) : null,
        partner.referral_code,
        partner.full_name,
        partner.id,
        partner.branch_id ?? 1,
        initialStatus,
        nowSql(),
        remarks ? String(remarks).trim() : `QR Lead Capture via ${partner.referral_code}`
      );

    const leadId = inserted.lastInsertRowid as number;
    const historyReason = `Captured via QR referral link ${partner.referral_code} — awaiting Back Office branch/BM routing`;

    db.prepare(`
      INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks)
      VALUES (?, NULL, ?, ?, ?)
    `).run(leadId, initialStatus, partner.id, historyReason);

    const staffToNotify = db
      .prepare(`SELECT id FROM users WHERE role IN ('SUPER_ADMIN', 'LEAD_GENERATOR') AND is_active = 1`)
      .all() as { id: number }[];
    for (const s of staffToNotify) {
      createAlert({
        userId: s.id,
        leadId,
        category: 'Lead Follow-up Alert',
        titleEn: `New QR Referral Lead (Assign Branch BM): ${leadCode}`,
        titleHi: `नई QR रेफरल लीड (BM को असाइन करें): ${leadCode}`,
        messageEn: `Referral lead ${leadCode} from ${partner.full_name} (${partner.referral_code}) is ready for Branch Manager assignment.`,
        messageHi: `${partner.full_name} (${partner.referral_code}) की QR लीड ${leadCode} को ब्रांच मैनेजर (BM) के अनुसार असाइन करें।`,
      });
    }

    logAudit(
      { id: partner.id, fullName: partner.full_name, role: 'REFERRAL_PARTNER' },
      'QR_REFERRAL_LEAD_CREATED',
      'LEAD',
      leadCode,
      `Customer submitted lead ${leadCode} via public QR link ${partner.referral_code} (Back Office / Admin queue)`
    );

    res.status(201).json({
      duplicateDetected: false,
      leadCode,
      autoAssignedOfficer: null,
    });
  });

  // Authentication
  router.post('/auth/login', (req, res) => {
    const { identifier, password } = req.body as { identifier?: string; password?: string };
    const cleanId = String(identifier || '').trim();
    const compactId = cleanId.replace(/\s+/g, '');
    const rawPass = String(password ?? '');
    const trimmedPass = rawPass.trim();

    if (!cleanId || !trimmedPass) {
      res.status(400).json({ error: 'Employee Code / Mobile and Password are required' });
      return;
    }

    let row = db
      .prepare(`SELECT * FROM users WHERE UPPER(REPLACE(employee_code, ' ', '')) = UPPER(?) LIMIT 1`)
      .get(compactId) as any;

    if (!row && cleanId) {
      const compactDigits = cleanId.replace(/[\s-]/g, '');
      row = db
        .prepare(
          `SELECT * FROM users WHERE (mobile != '' AND (mobile = ? OR REPLACE(REPLACE(mobile, ' ', ''), '-', '') = ?)) OR LOWER(email) = LOWER(?) LIMIT 1`
        )
        .get(cleanId, compactDigits, cleanId) as any;
    }

    if (!row) {
      res.status(401).json({
        error: `Employee ID "${cleanId}" not found. Check spelling or ask Super Admin to verify this ID in Admin Console.`,
      });
      return;
    }

    let passwordMatched =
      bcrypt.compareSync(rawPass, row.password_hash) ||
      (trimmedPass !== rawPass && bcrypt.compareSync(trimmedPass, row.password_hash));

    // Self-heal any legacy password accidentally saved with leading/trailing whitespace
    if (!passwordMatched) {
      const legacySpaceVariants = [` ${trimmedPass}`, `${trimmedPass} `, ` ${trimmedPass} `];
      for (const variant of legacySpaceVariants) {
        if (bcrypt.compareSync(variant, row.password_hash)) {
          passwordMatched = true;
          const healedHash = bcrypt.hashSync(trimmedPass, 10);
          db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(healedHash, row.id);
          break;
        }
      }
    }

    if (!passwordMatched) {
      res.status(401).json({
        error: 'Incorrect password for this Employee ID. Check spelling & uppercase/lowercase letters, or ask Super Admin to reset password.',
      });
      return;
    }
    if (!row.is_active) {
      res.status(403).json({ error: 'This Login ID is turned OFF. Contact Super Admin to turn it ON.' });
      return;
    }

    const settings = getSettings();
    if (row.otp_enabled || settings.otpRequiredGlobal) {
      const otpCode = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = nowSql(10);
      const challenge = db
        .prepare(`INSERT INTO otp_challenges (user_id, mobile, otp_code, expires_at) VALUES (?, ?, ?, ?)`)
        .run(row.id, row.mobile || '', otpCode, expiresAt);

      logAudit(
        { id: row.id, fullName: row.full_name, role: row.role },
        'OTP_CHALLENGE_ISSUED',
        'AUTH',
        row.employee_code,
        `OTP verification required for ${row.employee_code}`
      );
      res.json({
        requiresOtp: true,
        challengeId: challenge.lastInsertRowid,
        maskedMobile: (row.mobile || '').replace(/(\d{2})\d{5}(\d{3})/, '$1*****$2'),
        verificationOtpPreview: otpCode, // Shown in sandbox/verification mode because SMS gateway is external
      });
      return;
    }

    const token = generateSessionToken();
    const expiresAt = nowSql(60 * 24 * 7); // 7 days
    db.prepare(`INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)`).run(
      token,
      row.id,
      expiresAt,
      req.headers['user-agent'] ?? ''
    );

    const user = loadUserById(row.id)!;
    logAudit(user, 'LOGIN_SUCCESS', 'AUTH', user.employeeCode, `User ${user.fullName} (${user.role}) logged in.`);
    res.json({ token, user });
  });

  router.post('/auth/verify-otp', (req, res) => {
    const { challengeId, otpCode } = req.body as { challengeId?: number; otpCode?: string };
    if (!challengeId || !otpCode) {
      res.status(400).json({ error: 'Challenge ID and OTP are required' });
      return;
    }
    const ch = db
      .prepare(`SELECT * FROM otp_challenges WHERE id = ? AND verified = 0`)
      .get(challengeId) as any;

    if (!ch || ch.expires_at < nowSql() || ch.otp_code !== String(otpCode).trim()) {
      res.status(401).json({ error: 'Invalid or expired OTP' });
      return;
    }

    const user = loadUserById(ch.user_id);
    if (!user || !user.isActive) {
      res.status(403).json({ error: 'This Login ID is turned OFF. Contact Super Admin to turn it ON.' });
      return;
    }

    db.prepare(`UPDATE otp_challenges SET verified = 1 WHERE id = ?`).run(challengeId);
    const token = generateSessionToken();
    db.prepare(`INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)`).run(
      token,
      ch.user_id,
      nowSql(60 * 24 * 7),
      req.headers['user-agent'] ?? ''
    );
    logAudit(user, 'LOGIN_OTP_VERIFIED', 'AUTH', user.employeeCode, `OTP verified login for ${user.fullName}`);
    res.json({ token, user });
  });

  router.post('/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    if (req.sessionToken) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    }
    logAudit(req.user!, 'LOGOUT', 'AUTH', req.user!.employeeCode, 'Session terminated');
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.user });
  });

  router.patch('/auth/preferences', requireAuth, (req: AuthedRequest, res) => {
    const { preferredLang, gpsConsent, cameraConsent } = req.body as {
      preferredLang?: 'en' | 'hi';
      gpsConsent?: boolean;
      cameraConsent?: boolean;
    };
    if (preferredLang) {
      db.prepare('UPDATE users SET preferred_lang = ? WHERE id = ?').run(
        preferredLang === 'hi' ? 'hi' : 'en',
        req.user!.id
      );
    }
    if (typeof gpsConsent === 'boolean') {
      db.prepare('UPDATE users SET gps_consent = ? WHERE id = ?').run(gpsConsent ? 1 : 0, req.user!.id);
      logAudit(req.user!, 'GPS_CONSENT_UPDATED', 'USER', req.user!.employeeCode, `GPS consent set to ${gpsConsent}`);
    }
    if (typeof cameraConsent === 'boolean') {
      db.prepare('UPDATE users SET camera_consent = ? WHERE id = ?').run(cameraConsent ? 1 : 0, req.user!.id);
    }
    res.json({ user: loadUserById(req.user!.id) });
  });

  // Self-service Profile Edit & Update (All roles: Super Admin, BM, TL, Back Office, Field Officer, Referral)
  router.patch('/auth/profile', requireAuth, (req: AuthedRequest, res) => {
    const { fullName, mobile, email, profilePhotoDataUrl } = req.body as {
      fullName?: string;
      mobile?: string;
      email?: string;
      profilePhotoDataUrl?: string | null;
    };

    const existing = loadUserById(req.user!.id);
    if (!existing) {
      res.status(404).json({ error: 'User profile not found' });
      return;
    }

    const nextName = typeof fullName === 'string' ? fullName.trim() : existing.fullName;
    if (nextName.length < 2 || nextName.length > 100) {
      res.status(400).json({ error: 'Full Name must be between 2 and 100 characters' });
      return;
    }

    let nextMobile = existing.mobile;
    if (typeof mobile === 'string') {
      const cleanedMobile = mobile.replace(/[^0-9+]/g, '').trim();
      const digitsOnly = cleanedMobile.replace(/\D/g, '');
      if (digitsOnly.length < 10 || digitsOnly.length > 15) {
        res.status(400).json({ error: 'Please enter a valid 10 to 15 digit Mobile Number' });
        return;
      }
      nextMobile = digitsOnly.length === 12 && digitsOnly.startsWith('91') ? digitsOnly.slice(2) : digitsOnly;
    }

    let nextEmail = existing.email;
    if (typeof email === 'string') {
      const cleanedEmail = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanedEmail)) {
        res.status(400).json({ error: 'Please enter a valid Email ID' });
        return;
      }
      nextEmail = cleanedEmail;
    }

    let nextPhoto: string | null = existing.profilePhotoDataUrl ?? null;
    if (profilePhotoDataUrl === null) {
      nextPhoto = null;
    } else if (typeof profilePhotoDataUrl === 'string') {
      const trimmedPhoto = profilePhotoDataUrl.trim();
      if (!trimmedPhoto) {
        nextPhoto = null;
      } else {
        if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i.test(trimmedPhoto)) {
          res.status(400).json({ error: 'Profile photo must be a valid PNG, JPEG, or WebP image' });
          return;
        }
        if (trimmedPhoto.length > 2_500_000) {
          res.status(400).json({ error: 'Profile photo is too large (max ~1.8 MB)' });
          return;
        }
        nextPhoto = trimmedPhoto;
      }
    }

    db.prepare(`
      UPDATE users
      SET full_name = ?, mobile = ?, email = ?, profile_photo_data_url = ?
      WHERE id = ?
    `).run(nextName, nextMobile, nextEmail, nextPhoto, req.user!.id);

    const updated = loadUserById(req.user!.id)!;
    logAudit(
      updated,
      'PROFILE_UPDATED',
      'USER',
      updated.employeeCode,
      `Updated own profile (${updated.fullName}, ${updated.mobile}, ${updated.email})`
    );
    res.json({ user: updated });
  });

  // Organization Directory (Branch Managers -> Team Leaders -> Field Officers -> Referrals)
  router.get('/directory', requireAuth, (req: AuthedRequest, res) => {
    const branches = db.prepare('SELECT id, code, name, city, state, is_active FROM branches ORDER BY name').all();
    const teams = db.prepare('SELECT id, branch_id as branchId, name, leader_user_id as leaderUserId FROM teams ORDER BY name').all();
    const branchManagers = db
      .prepare(`
        SELECT u.id, u.employee_code as employeeCode, u.full_name as fullName, u.mobile, u.role,
          u.branch_id as branchId, b.name as branchName, b.city as branchCity, b.state as branchState
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        WHERE u.role = 'BRANCH_MANAGER' AND u.is_active = 1
        ORDER BY u.full_name
      `)
      .all();
    const teamLeaders = db
      .prepare(`
        SELECT u.id, u.employee_code as employeeCode, u.full_name as fullName, u.mobile, u.role,
          u.branch_id as branchId, b.name as branchName, u.team_id as teamId, u.reports_to_user_id as reportsToUserId
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        WHERE u.role = 'TEAM_LEADER' AND u.is_active = 1
        ORDER BY u.full_name
      `)
      .all();
    const fieldOfficers = db
      .prepare(`
        SELECT u.id, u.employee_code as employeeCode, u.full_name as fullName, u.mobile, u.role,
          u.branch_id as branchId, b.name as branchName, b.city as branchCity, b.state as branchState,
          u.team_id as teamId, t.name as teamName, u.reports_to_user_id as reportsToUserId,
          u.service_city as serviceCity, u.service_pincodes as servicePincodes,
          tl.id as teamLeaderId, tl.full_name as teamLeaderName, tl.employee_code as teamLeaderCode,
          bm.id as branchManagerId, bm.full_name as branchManagerName, bm.employee_code as branchManagerCode
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN teams t ON t.id = u.team_id
        LEFT JOIN users tl ON tl.id = COALESCE(
          CASE WHEN u.role = 'TEAM_LEADER' THEN u.id ELSE u.reports_to_user_id END,
          t.leader_user_id
        )
        LEFT JOIN users bm ON bm.id = COALESCE(
          tl.reports_to_user_id,
          (SELECT bmu.id FROM users bmu WHERE bmu.role = 'BRANCH_MANAGER' AND bmu.branch_id = u.branch_id AND bmu.is_active = 1 LIMIT 1)
        )
        WHERE u.role IN ('FIELD_OFFICER', 'TEAM_LEADER') AND u.is_active = 1
        ORDER BY CASE WHEN u.role = 'FIELD_OFFICER' THEN 0 ELSE 1 END, u.full_name
      `)
      .all()
      .map((fo: any) => ({
        ...fo,
        workingLocation: [
          fo.serviceCity || fo.branchCity,
          fo.branchName,
          fo.servicePincodes ? `Zones: ${fo.servicePincodes}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }));
    const referrals =
      req.user!.role === 'REFERRAL_PARTNER'
        ? []
        : db
            .prepare(`
              SELECT id, employee_code as employeeCode, full_name as fullName, referral_code as referralCode,
                reports_to_user_id as reportsToUserId
              FROM users
              WHERE role = 'REFERRAL_PARTNER' AND is_active = 1
              ORDER BY full_name
            `)
            .all();
    res.json({ branches, teams, branchManagers, teamLeaders, fieldOfficers, referrals });
  });

  // Dashboard Metrics (role-filtered)
  router.get('/dashboard', requireAuth, (req: AuthedRequest, res) => {
    processSlaTimers();
    const user = req.user!;
    const scope = buildLeadScopeFilter(user);
    const leads = db
      .prepare(`
        SELECT l.*, u.full_name as officer_name
        FROM leads l
        LEFT JOIN users u ON u.id = l.assigned_officer_id
        WHERE ${scope.sql}
      `)
      .all(...scope.params) as any[];

    const todayStr = new Date().toISOString().slice(0, 10);
    const totalLeads = leads.length;
    const todaysLeads = leads.filter((l) => String(l.created_at).startsWith(todayStr)).length;
    const pendingLeads = leads.filter((l) => ['Lead Generated', 'Lead Assigned', 'Follow-up Pending'].includes(l.status)).length;
    const docsPending = leads.filter((l) => l.status === 'Documents Pending').length;
    const casesLoggedIn = leads.filter((l) => l.status === 'Case Logged In').length;
    const underProcess = leads.filter((l) => ['Under Process', 'Query Raised'].includes(l.status)).length;
    const approvedCases = leads.filter((l) => ['Approved', 'Disbursement Pending'].includes(l.status)).length;
    const rejectedCases = leads.filter((l) => l.status === 'Rejected').length;
    const disbursedCases = leads.filter((l) => l.status === 'Disbursed').length;
    const closedCases = leads.filter((l) => l.status === 'Closed').length;

    const statusCountsMap = new Map<string, number>();
    for (const st of CASE_STATUSES) {
      statusCountsMap.set(st, 0);
    }
    for (const l of leads) {
      const st = String(l.status || 'Lead Generated');
      statusCountsMap.set(st, (statusCountsMap.get(st) ?? 0) + 1);
    }
    const stageGroupFor = (status: string): 'New' | 'In-Progress' | 'Approved' | 'Disbursed' | 'Rejected' | 'Closed' => {
      if (status === 'Lead Generated' || status === 'Lead Assigned') return 'New';
      if (status === 'Approved' || status === 'Disbursement Pending') return 'Approved';
      if (status === 'Disbursed') return 'Disbursed';
      if (status === 'Rejected') return 'Rejected';
      if (status === 'Closed') return 'Closed';
      return 'In-Progress';
    };
    const statusDistribution = CASE_STATUSES.map((st) => ({
      status: st,
      stageGroup: stageGroupFor(st),
      count: statusCountsMap.get(st) ?? 0,
    }));

    const totalDisbursementAmount =
      user.role === 'REFERRAL_PARTNER'
        ? null // Referral partners cannot view loan amounts
        : leads
            .filter((l) => l.status === 'Disbursed')
            .reduce((sum, l) => sum + Number(l.loan_amount || 0), 0);

    // Follow-up due count (scoped to user's visible leads)
    let followupDue = 0;
    if (user.role !== 'REFERRAL_PARTNER') {
      const remQuery = db
        .prepare(`
          SELECT COUNT(*) as c
          FROM followup_reminders fr
          JOIN leads l ON l.id = fr.lead_id
          WHERE ${scope.sql} AND fr.completed_at IS NULL
        `)
        .get(...scope.params);
      followupDue = (remQuery as { c: number }).c;
    }

    // Enquiries pending
    let pendingEnquiries = 0;
    if (user.role === 'REFERRAL_PARTNER') {
      pendingEnquiries = (
        db
          .prepare(`SELECT COUNT(*) as c FROM enquiries WHERE referral_user_id = ? AND status NOT IN ('Resolved','Closed')`)
          .get(user.id) as { c: number }
      ).c;
    } else if (user.role === 'FIELD_OFFICER') {
      pendingEnquiries = (
        db
          .prepare(`SELECT COUNT(*) as c FROM enquiries WHERE assigned_officer_id = ? AND status NOT IN ('Resolved','Closed')`)
          .get(user.id) as { c: number }
      ).c;
    } else {
      pendingEnquiries = (
        db
          .prepare(`SELECT COUNT(*) as c FROM enquiries WHERE status NOT IN ('Resolved','Closed')`)
          .get() as { c: number }
      ).c;
    }

    const pendingDuplicates =
      user.role === 'SUPER_ADMIN'
        ? (db.prepare(`SELECT COUNT(*) as c FROM duplicate_requests WHERE status = 'PENDING'`).get() as { c: number }).c
        : 0;

    // Penalties summary
    const penaltyFilter =
      user.role === 'FIELD_OFFICER'
        ? 'WHERE employee_id = ?'
        : user.role === 'REFERRAL_PARTNER'
        ? 'WHERE 1 = 0'
        : '';
    const penaltyParams = user.role === 'FIELD_OFFICER' ? [user.id] : [];
    const penaltyStats = db
      .prepare(`
        SELECT
          COUNT(*) as totalCount,
          COALESCE(SUM(CASE WHEN approval_status = 'PENDING' THEN amount ELSE 0 END), 0) as pendingAmount,
          COALESCE(SUM(CASE WHEN approval_status = 'APPROVED' THEN amount ELSE 0 END), 0) as approvedAmount,
          COALESCE(SUM(CASE WHEN approval_status = 'PENDING' THEN 1 ELSE 0 END), 0) as pendingCount
        FROM penalties ${penaltyFilter}
      `)
      .get(...penaltyParams) as any;

    // Petrol incentive summary (role & hierarchy scoped)
    let bikeFilter = `WHERE br.status = 'COMPLETED'`;
    const bikeParams: any[] = [];
    if (user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR') {
      bikeFilter += ` AND br.employee_id = ?`;
      bikeParams.push(user.id);
    } else if (user.role === 'TEAM_LEADER') {
      bikeFilter += ` AND (br.employee_id = ? OR (u.role = 'FIELD_OFFICER' AND (u.reports_to_user_id = ? OR (u.reports_to_user_id IS NULL AND u.team_id = ?))))`;
      bikeParams.push(user.id, user.id, user.teamId || -1);
    } else if (user.role === 'BRANCH_MANAGER') {
      bikeFilter += ` AND (br.employee_id = ? OR u.reports_to_user_id = ? OR (u.branch_id = ? AND u.role IN ('TEAM_LEADER','FIELD_OFFICER')))`;
      bikeParams.push(user.id, user.id, user.branchId || -1);
    } else if (user.role === 'REFERRAL_PARTNER') {
      bikeFilter = 'WHERE 1 = 0';
    }
    const petrolStats = db
      .prepare(`
        SELECT
          COUNT(*) as totalRuns,
          COALESCE(SUM(br.eligible_km), 0) as totalKm,
          COALESCE(SUM(CASE WHEN br.approval_status IN ('APPROVED','DEDUCTED') THEN br.incentive_amount ELSE 0 END), 0) as approvedIncentive,
          COALESCE(SUM(CASE WHEN br.approval_status = 'PENDING' THEN br.incentive_amount ELSE 0 END), 0) as pendingIncentive
        FROM bike_runs br
        JOIN users u ON u.id = br.employee_id
        ${bikeFilter}
      `)
      .get(...bikeParams) as any;

    // Employee-wise & Referral-wise performance (hidden from Referral Partner)
    let employeePerformance: any[] = [];
    let referralPerformance: any[] = [];
    if (user.role !== 'REFERRAL_PARTNER') {
      const isFieldOfficer = user.role === 'FIELD_OFFICER';
      employeePerformance = db
        .prepare(`
          SELECT
            u.id, u.full_name as name, u.employee_code as code,
            COUNT(l.id) as totalLeads,
            SUM(CASE WHEN l.status = 'Disbursed' THEN 1 ELSE 0 END) as disbursedCount,
            COALESCE(SUM(CASE WHEN l.status = 'Disbursed' THEN l.loan_amount ELSE 0 END), 0) as disbursedAmount
          FROM users u
          LEFT JOIN leads l ON l.assigned_officer_id = u.id
          WHERE u.role = 'FIELD_OFFICER' AND u.is_active = 1 ${isFieldOfficer ? 'AND u.id = ?' : ''}
          GROUP BY u.id
          ORDER BY totalLeads DESC
        `)
        .all(...(isFieldOfficer ? [user.id] : []));

      referralPerformance = db
        .prepare(`
          SELECT
            u.id, u.full_name as name, u.referral_code as code,
            COUNT(l.id) as totalLeads,
            SUM(CASE WHEN l.status = 'Disbursed' THEN 1 ELSE 0 END) as disbursedCount,
            COALESCE(SUM(CASE WHEN l.status = 'Disbursed' THEN l.loan_amount ELSE 0 END), 0) as disbursedAmount
          FROM users u
          LEFT JOIN leads l ON (l.created_by = u.id OR l.referral_id = u.referral_code)
          WHERE u.role = 'REFERRAL_PARTNER' AND u.is_active = 1
          GROUP BY u.id
          ORDER BY totalLeads DESC
        `)
        .all();
    }

      // Staff reward points summary (strictly hidden from Referral Partners)
      let rewardSummary: {
        loginRewardPts: number;
        loginRewardCount: number;
        disbursementRewardPts: number;
        disbursementRewardCount: number;
        wrongLeadPenaltyPts: number;
        wrongLeadCount: number;
        netRewardPts: number;
      } | null = null;

      if (user.role !== 'REFERRAL_PARTNER') {
        const rewardFilter =
          user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR'
            ? `WHERE sr.status = 'ACTIVE' AND sr.employee_id = ?`
            : user.role === 'TEAM_LEADER'
            ? `WHERE sr.status = 'ACTIVE' AND (sr.employee_id = ? OR u.team_id = ?)`
            : user.role === 'BRANCH_MANAGER'
            ? `WHERE sr.status = 'ACTIVE' AND u.branch_id = ?`
            : `WHERE sr.status = 'ACTIVE'`;
        const rewardParams =
          user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR'
            ? [user.id]
            : user.role === 'TEAM_LEADER'
            ? [user.id, user.teamId ?? -1]
            : user.role === 'BRANCH_MANAGER'
            ? [user.branchId ?? -1]
            : [];

        const rRow = db
          .prepare(`
            SELECT
              COALESCE(SUM(CASE WHEN sr.entry_type = 'DOC_LOGIN_REWARD' THEN sr.points_delta ELSE 0 END), 0) as loginRewardPts,
              COALESCE(SUM(CASE WHEN sr.entry_type = 'DOC_LOGIN_REWARD' THEN 1 ELSE 0 END), 0) as loginRewardCount,
              COALESCE(SUM(CASE WHEN sr.entry_type = 'DISBURSEMENT_REWARD' THEN sr.points_delta ELSE 0 END), 0) as disbursementRewardPts,
              COALESCE(SUM(CASE WHEN sr.entry_type = 'DISBURSEMENT_REWARD' THEN 1 ELSE 0 END), 0) as disbursementRewardCount,
              COALESCE(SUM(CASE WHEN sr.entry_type = 'WRONG_LEAD_PENALTY' THEN ABS(sr.points_delta) ELSE 0 END), 0) as wrongLeadPenaltyPts,
              COALESCE(SUM(CASE WHEN sr.entry_type = 'WRONG_LEAD_PENALTY' THEN 1 ELSE 0 END), 0) as wrongLeadCount,
              COALESCE(SUM(sr.points_delta), 0) as netRewardPts
            FROM staff_rewards sr
            JOIN users u ON u.id = sr.employee_id
            ${rewardFilter}
          `)
          .get(...rewardParams) as any;

        rewardSummary = {
          loginRewardPts: Number(rRow?.loginRewardPts ?? 0),
          loginRewardCount: Number(rRow?.loginRewardCount ?? 0),
          disbursementRewardPts: Number(rRow?.disbursementRewardPts ?? 0),
          disbursementRewardCount: Number(rRow?.disbursementRewardCount ?? 0),
          wrongLeadPenaltyPts: Number(rRow?.wrongLeadPenaltyPts ?? 0),
          wrongLeadCount: Number(rRow?.wrongLeadCount ?? 0),
          netRewardPts: Number(rRow?.netRewardPts ?? 0),
        };
      }

      let todayAttendance: {
        marked: boolean;
        status: string | null;
        markedTimeIst: string | null;
        attendanceCode: string | null;
        delayPenaltyAmount: number;
      } | null = null;
      if (user.role !== 'REFERRAL_PARTNER') {
        const ist = getIstDateTimeParts();
        const attRow = db
          .prepare(`
            SELECT attendance_code as attendanceCode, status, marked_time_ist as markedTimeIst,
              delay_penalty_amount as delayPenaltyAmount
            FROM attendance_logs
            WHERE employee_id = ? AND attendance_date = ?
          `)
          .get(user.id, ist.istDate) as any;
        todayAttendance = attRow
          ? {
              marked: true,
              status: attRow.status,
              markedTimeIst: attRow.markedTimeIst,
              attendanceCode: attRow.attendanceCode,
              delayPenaltyAmount: Number(attRow.delayPenaltyAmount || 0),
            }
          : {
              marked: false,
              status: null,
              markedTimeIst: null,
              attendanceCode: null,
              delayPenaltyAmount: 0,
            };
      }

      res.json({
      kpis: {
        totalLeads,
        todaysLeads,
        pendingLeads,
        followupDue,
        docsPending,
        casesLoggedIn,
        underProcess,
        approvedCases,
        rejectedCases,
        disbursedCases,
        closedCases,
        totalDisbursementAmount,
        pendingEnquiries,
        pendingDuplicates,
      },
      statusDistribution,
      penaltySummary: penaltyStats,
      petrolSummary: petrolStats,
      rewardSummary,
      todayAttendance,
      employeePerformance,
      referralPerformance,
      settings: getSettings(),
    });
  });

  // Leads List (server-side RBAC + Referral field redaction)
  router.get('/leads', requireAuth, (req: AuthedRequest, res) => {
    processSlaTimers();
    const user = req.user!;
    const scope = buildLeadScopeFilter(user);
    const { status, search, source } = req.query as { status?: string; search?: string; source?: string };

    const rows = db
      .prepare(`
        SELECT l.*,
          cb.full_name as created_by_name,
          cb.role as created_by_role,
          cb.employee_code as created_by_code,
          bm.full_name as assigned_bm_name,
          bm.employee_code as assigned_bm_code,
          tl.full_name as assigned_tl_name,
          tl.employee_code as assigned_tl_code,
          ao.full_name as assigned_officer_name,
          ao.employee_code as assigned_officer_code,
          ao.mobile as assigned_officer_mobile,
          rb.full_name as rejected_by_name,
          rb.employee_code as rejected_by_code,
          crb.full_name as closure_requested_by_name,
          cab.full_name as closure_approved_by_name,
          b.name as branch_name
        FROM leads l
        JOIN users cb ON cb.id = l.created_by
        LEFT JOIN users bm ON bm.id = l.assigned_bm_id
        LEFT JOIN users tl ON tl.id = l.assigned_tl_id
        LEFT JOIN users ao ON ao.id = l.assigned_officer_id
        LEFT JOIN users rb ON rb.id = l.rejected_by
        LEFT JOIN users crb ON crb.id = l.closure_requested_by
        LEFT JOIN users cab ON cab.id = l.closure_approved_by
        LEFT JOIN branches b ON b.id = l.branch_id
        WHERE ${scope.sql}
        ORDER BY l.created_at DESC, l.id DESC
      `)
      .all(...scope.params) as any[];

    let serialized = rows.map((r) => serializeLeadForUser(r, user));
    const todayStr = nowSql().slice(0, 10);

    if (status && status !== 'ALL') {
      serialized = serialized.filter((l) => l.status === status);
    }
    if (source && source !== 'ALL' && user.role !== 'REFERRAL_PARTNER') {
      if (source === 'REFERRAL') {
        serialized = serialized.filter((l) => l.createdByRole === 'REFERRAL_PARTNER' || Boolean(l.referralId));
      } else if (source === 'REFERRAL_TODAY') {
        serialized = serialized.filter(
          (l) => (l.createdByRole === 'REFERRAL_PARTNER' || Boolean(l.referralId)) && String(l.createdAt).startsWith(todayStr)
        );
      } else if (source === 'FIELD_OFFICER') {
        serialized = serialized.filter((l) => l.createdByRole === 'FIELD_OFFICER');
      } else if (source === 'FO_TODAY') {
        serialized = serialized.filter(
          (l) => l.createdByRole === 'FIELD_OFFICER' && String(l.createdAt).startsWith(todayStr)
        );
      } else if (source === 'BACK_OFFICE') {
        serialized = serialized.filter((l) =>
          ['LEAD_GENERATOR', 'SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER'].includes(l.createdByRole || '')
        );
      } else if (source === 'UNASSIGNED') {
        serialized = serialized.filter((l) => !l.assignedOfficerId);
      } else if (source === 'PENDING_CLOSURE') {
        serialized = serialized.filter((l) => l.status === 'Rejected' || l.closureStatus === 'PENDING_APPROVAL');
      }
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      serialized = serialized.filter(
        (l) =>
          l.leadCode.toLowerCase().includes(q) ||
          l.customerName.toLowerCase().includes(q) ||
          (l.customerMobile && l.customerMobile.includes(q)) ||
          (l.panNumber && l.panNumber.toLowerCase().includes(q)) ||
          l.loanProduct.toLowerCase().includes(q) ||
          l.bankNbfc.toLowerCase().includes(q) ||
          (l.assignedBmName && l.assignedBmName.toLowerCase().includes(q)) ||
          (l.assignedTlName && l.assignedTlName.toLowerCase().includes(q)) ||
          (l.assignedOfficerName && l.assignedOfficerName.toLowerCase().includes(q)) ||
          (l.assignedOfficerCode && l.assignedOfficerCode.toLowerCase().includes(q)) ||
          (l.createdByName && l.createdByName.toLowerCase().includes(q))
      );
    }

    res.json({ leads: serialized });
  });

  // Lead Creation with Server-Side Duplicate Detection
  router.post('/leads', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const payload = req.body as Record<string, any>;
    const customerName = String(payload.customerName || '').trim();
    const customerMobile = String(payload.customerMobile || '').trim();
    const panNumber = String(payload.panNumber || '').trim().toUpperCase();
    const loanProduct = String(payload.loanProduct || '').trim();
    const bankNbfc = String(payload.bankNbfc || '').trim();

    if (!customerName || !customerMobile || !loanProduct || !bankNbfc) {
      res.status(400).json({ error: 'Customer Name, Mobile Number, Loan Product, and Bank/NBFC are required' });
      return;
    }
    if (!payload.customerConsent) {
      res.status(400).json({ error: 'Customer consent must be confirmed before lead submission' });
      return;
    }

    const referralId =
      user.role === 'REFERRAL_PARTNER'
        ? user.referralCode
        : payload.referralId
        ? String(payload.referralId).trim()
        : null;
    const referralName =
      user.role === 'REFERRAL_PARTNER'
        ? user.fullName
        : payload.referralName
        ? String(payload.referralName).trim()
        : null;

    // Duplicate Detection across 5 dimensions
    const nameNorm = customerName.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const mobileHash = hashLookup(customerMobile);
    const panHash = panNumber ? hashLookup(panNumber) : null;

    const candidates = db
      .prepare(`
        SELECT id, lead_code, customer_name, customer_name_norm, customer_mobile_hash, pan_hash, referral_id, referral_name
        FROM leads
        WHERE customer_name_norm = ?
           OR customer_mobile_hash = ?
           OR (? IS NOT NULL AND pan_hash = ?)
      `)
      .all(nameNorm, mobileHash, panHash, panHash) as any[];

    if (candidates.length > 0) {
      const existing = candidates[0];
      const matchedFields: string[] = [];
      if (existing.customer_name_norm === nameNorm) matchedFields.push('Customer Name');
      if (existing.customer_mobile_hash === mobileHash) matchedFields.push('Mobile Number');
      if (panHash && existing.pan_hash === panHash) matchedFields.push('PAN Card Number');
      if (referralId && existing.referral_id && existing.referral_id.toUpperCase() === referralId.toUpperCase()) {
        matchedFields.push('Referral ID');
      }
      if (
        referralName &&
        existing.referral_name &&
        existing.referral_name.trim().toLowerCase() === referralName.trim().toLowerCase()
      ) {
        matchedFields.push('Referral Name / Details');
      }

      const reqCode = `DUP-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      const dupInsert = db
        .prepare(`
          INSERT INTO duplicate_requests (request_code, existing_lead_id, matched_fields_json, submitted_payload_json, submitted_by, status)
          VALUES (?, ?, ?, ?, ?, 'PENDING')
        `)
        .run(
          reqCode,
          existing.id,
          JSON.stringify(matchedFields),
          JSON.stringify({ ...payload, referralId, referralName }),
          user.id
        );

      for (const adminId of getSuperAdminIds()) {
        createAlert({
          userId: adminId,
          leadId: existing.id,
          category: 'Duplicate Lead Verification Alert',
          titleEn: `Duplicate Lead Request ${reqCode}`,
          titleHi: `डुप्लिकेट लीड अनुरोध ${reqCode}`,
          messageEn: `${user.fullName} submitted a lead matching ${existing.lead_code} (${matchedFields.join(', ')}). Awaiting Admin verification.`,
          messageHi: `${user.fullName} द्वारा दर्ज लीड ${existing.lead_code} (${matchedFields.join(', ')}) से मेल खाती है। एडमिन सत्यापन लंबित।`,
        });
      }

      logAudit(
        user,
        'DUPLICATE_LEAD_HELD',
        'DUPLICATE_REQUEST',
        reqCode,
        `Held duplicate lead for ${customerName}; matched ${existing.lead_code} on [${matchedFields.join(', ')}]`
      );

      res.status(202).json({
        duplicateDetected: true,
        message: 'DUPLICATE RECORD FOUND',
        requestCode: reqCode,
        duplicateRequestId: dupInsert.lastInsertRowid,
        existingLeadCode: existing.lead_code,
        matchedFields,
      });
      return;
    }

    // Create new lead:
    // - REFERRAL_PARTNER: kept unrouted (assigned_bm_id/tl/fo = NULL) for Back Office & Admin ONLY
    // - FIELD_OFFICER: auto-linked to self + parent TL + parent BM so TL/BM/Back Office/Admin see daily leads immediately
    // - LEAD_GENERATOR (Back Office): can route directly to a Branch Manager (assignedBmId), or leave unassigned
    // - BRANCH_MANAGER / TEAM_LEADER / SUPER_ADMIN: supports 3-stage BM -> TL -> FO routing or Auto-Balance
    const settings = getSettings();
    const leadCode = generateLeadCode();
    const canAssignOnCreate = ['SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER', 'LEAD_GENERATOR'].includes(user.role);
    let branchId = payload.branchId ? Number(payload.branchId) : user.branchId ?? 1;
    const requestedMode = payload.assignmentMode ? String(payload.assignmentMode).toUpperCase() : '';

    let resolvedBmId: number | null = user.role === 'BRANCH_MANAGER' ? user.id : null;
    let resolvedTlId: number | null = user.role === 'TEAM_LEADER' ? user.id : null;
    let resolvedOfficerId: number | null = null;
    let autoAssignDecision: ReturnType<typeof scoreOfficersForLead>['best'] = null;

    if (canAssignOnCreate) {
      if (payload.assignedBmId) {
        const bmRow = db
          .prepare(`SELECT id, branch_id FROM users WHERE id = ? AND is_active = 1 AND role = 'BRANCH_MANAGER'`)
          .get(Number(payload.assignedBmId)) as { id: number; branch_id: number | null } | undefined;
        if (!bmRow) {
          res.status(400).json({ error: 'Selected Branch Manager not found or inactive' });
          return;
        }
        resolvedBmId = bmRow.id;
        if (bmRow.branch_id) branchId = bmRow.branch_id;
      }

      if (payload.assignedTlId) {
        const tlRow = db
          .prepare(`SELECT id, branch_id, reports_to_user_id FROM users WHERE id = ? AND is_active = 1 AND role = 'TEAM_LEADER'`)
          .get(Number(payload.assignedTlId)) as
          | { id: number; branch_id: number | null; reports_to_user_id: number | null }
          | undefined;
        if (!tlRow) {
          res.status(400).json({ error: 'Selected Team Leader not found or inactive' });
          return;
        }
        resolvedTlId = tlRow.id;
        if (tlRow.reports_to_user_id) resolvedBmId = tlRow.reports_to_user_id;
        if (tlRow.branch_id) branchId = tlRow.branch_id;
      }

      if (user.role === 'TEAM_LEADER' && !resolvedBmId) {
        const selfTl = db.prepare(`SELECT reports_to_user_id FROM users WHERE id = ?`).get(user.id) as
          | { reports_to_user_id: number | null }
          | undefined;
        if (selfTl?.reports_to_user_id) resolvedBmId = selfTl.reports_to_user_id;
      }

      if (requestedMode !== 'AUTO' && requestedMode !== 'UNASSIGNED' && requestedMode !== 'BM' && requestedMode !== 'TL' && payload.assignedOfficerId) {
        const foById = db
          .prepare(`SELECT id, role, branch_id, team_id, reports_to_user_id FROM users WHERE id = ? AND is_active = 1 AND role IN ('FIELD_OFFICER', 'TEAM_LEADER')`)
          .get(Number(payload.assignedOfficerId)) as any;
        if (foById) {
          resolvedOfficerId = foById.id;
          if (foById.branch_id) branchId = foById.branch_id;
          if (foById.role === 'FIELD_OFFICER' && foById.reports_to_user_id) {
            resolvedTlId = foById.reports_to_user_id;
          } else if (foById.role === 'TEAM_LEADER') {
            resolvedTlId = foById.id;
          }
        }
      } else if (
        requestedMode !== 'AUTO' &&
        requestedMode !== 'UNASSIGNED' &&
        requestedMode !== 'BM' &&
        requestedMode !== 'TL' &&
        payload.assignedOfficerEmployeeCode &&
        String(payload.assignedOfficerEmployeeCode).trim()
      ) {
        const foByCode = db
          .prepare(`SELECT id, role, branch_id, team_id, reports_to_user_id FROM users WHERE UPPER(employee_code) = UPPER(?) AND is_active = 1 AND role IN ('FIELD_OFFICER', 'TEAM_LEADER')`)
          .get(String(payload.assignedOfficerEmployeeCode).trim()) as any;
        if (!foByCode) {
          res.status(400).json({ error: `Field Officer Employee ID '${String(payload.assignedOfficerEmployeeCode).trim()}' not found` });
          return;
        }
        resolvedOfficerId = foByCode.id;
        if (foByCode.branch_id) branchId = foByCode.branch_id;
        if (foByCode.role === 'FIELD_OFFICER' && foByCode.reports_to_user_id) {
          resolvedTlId = foByCode.reports_to_user_id;
        } else if (foByCode.role === 'TEAM_LEADER') {
          resolvedTlId = foByCode.id;
        }
      } else if (
        requestedMode === 'AUTO' ||
        (user.role !== 'LEAD_GENERATOR' &&
          requestedMode !== 'UNASSIGNED' &&
          requestedMode !== 'BM' &&
          requestedMode !== 'TL' &&
          !resolvedBmId &&
          !resolvedTlId &&
          settings.autoAssignIncomingLeads !== false)
      ) {
        autoAssignDecision = scoreOfficersForLead(
          {
            city: payload.city ? String(payload.city).trim() : null,
            state: payload.state ? String(payload.state).trim() : null,
            pinCode: payload.pinCode ? String(payload.pinCode).trim() : null,
            address: payload.address ? String(payload.address).trim() : null,
            branchId,
          },
          { allowedOfficerIds: getScopedOfficerIdsForUser(user) }
        ).best;
        if (autoAssignDecision) {
          resolvedOfficerId = autoAssignDecision.officer.id;
        }
      }

      if (resolvedTlId && !resolvedBmId) {
        const tlParent = db.prepare(`SELECT reports_to_user_id FROM users WHERE id = ?`).get(resolvedTlId) as
          | { reports_to_user_id: number | null }
          | undefined;
        if (tlParent?.reports_to_user_id) resolvedBmId = tlParent.reports_to_user_id;
      }
      if (resolvedOfficerId && !resolvedTlId) {
        const foParent = db.prepare(`SELECT reports_to_user_id, branch_id FROM users WHERE id = ?`).get(resolvedOfficerId) as
          | { reports_to_user_id: number | null; branch_id: number | null }
          | undefined;
        if (foParent?.reports_to_user_id) resolvedTlId = foParent.reports_to_user_id;
        if (resolvedTlId && !resolvedBmId) {
          const tlParent = db.prepare(`SELECT reports_to_user_id FROM users WHERE id = ?`).get(resolvedTlId) as
            | { reports_to_user_id: number | null }
            | undefined;
          if (tlParent?.reports_to_user_id) resolvedBmId = tlParent.reports_to_user_id;
        }
      }
    } else if (user.role === 'FIELD_OFFICER') {
      resolvedOfficerId = user.id;
      const foRow = db
        .prepare(`SELECT reports_to_user_id, team_id, branch_id FROM users WHERE id = ?`)
        .get(user.id) as { reports_to_user_id: number | null; team_id: number | null; branch_id: number | null } | undefined;
      if (foRow?.branch_id) branchId = foRow.branch_id;
      if (foRow?.reports_to_user_id) {
        resolvedTlId = foRow.reports_to_user_id;
      } else if (foRow?.team_id) {
        const tRow = db.prepare(`SELECT leader_user_id FROM teams WHERE id = ?`).get(foRow.team_id) as
          | { leader_user_id: number | null }
          | undefined;
        resolvedTlId = tRow?.leader_user_id ?? null;
      }
      if (resolvedTlId) {
        const tlRow = db.prepare(`SELECT reports_to_user_id FROM users WHERE id = ?`).get(resolvedTlId) as
          | { reports_to_user_id: number | null }
          | undefined;
        resolvedBmId = tlRow?.reports_to_user_id ?? null;
      }
      if (!resolvedBmId && branchId) {
        const bmInBranch = db
          .prepare(`SELECT id FROM users WHERE role = 'BRANCH_MANAGER' AND branch_id = ? AND is_active = 1 LIMIT 1`)
          .get(branchId) as { id: number } | undefined;
        resolvedBmId = bmInBranch?.id ?? null;
      }
    } else if (user.role === 'REFERRAL_PARTNER') {
      // Referral leads stay ONLY in Back Office & Super Admin queue until Back Office assigns Branch BM
      resolvedBmId = null;
      resolvedTlId = null;
      resolvedOfficerId = null;
    }

    const assignedOfficerId = resolvedOfficerId;
    const assignedAt = assignedOfficerId || resolvedBmId || resolvedTlId ? nowSql() : null;
    const deadlineAt = assignedOfficerId ? nowSql(settings.assignmentSlaMinutes) : null;
    const initialStatus: CaseStatus = assignedOfficerId ? 'Lead Assigned' : 'Lead Generated';

    const result = db
      .prepare(`
        INSERT INTO leads (
          lead_code, customer_name, customer_name_norm, customer_mobile_enc, customer_mobile_hash,
          alternate_mobile_enc, pan_enc, pan_hash, dob, address_enc, city, state, pin_code,
          loan_product, loan_amount, employment_details, employment_type, existing_emi, monthly_income, bank_nbfc,
          referral_id, referral_name, created_by, assigned_bm_id, assigned_tl_id, assigned_officer_id, assigned_at,
          assignment_deadline_at, branch_id, status, last_status_at, remarks, customer_consent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `)
      .run(
        leadCode,
        customerName,
        nameNorm,
        encryptPii(customerMobile),
        mobileHash,
        encryptPii(payload.alternateMobile ? String(payload.alternateMobile).trim() : null),
        encryptPii(panNumber || null),
        panHash,
        payload.dob ? String(payload.dob) : null,
        encryptPii(payload.address ? String(payload.address).trim() : null),
        payload.city ? String(payload.city).trim() : null,
        payload.state ? String(payload.state).trim() : null,
        payload.pinCode ? String(payload.pinCode).trim() : null,
        loanProduct,
        Number(payload.loanAmount || 0),
        payload.employmentDetails ? String(payload.employmentDetails).trim() : null,
        payload.employmentType ? String(payload.employmentType).trim() : 'Salaried',
        payload.existingEmi ? Number(payload.existingEmi) : 0,
        payload.monthlyIncome ? Number(payload.monthlyIncome) : null,
        bankNbfc,
        referralId,
        referralName,
        user.id,
        resolvedBmId,
        resolvedTlId,
        assignedOfficerId,
        assignedAt,
        deadlineAt,
        branchId,
        initialStatus,
        nowSql(),
        payload.remarks ? String(payload.remarks).trim() : null
      );

    const leadId = result.lastInsertRowid as number;
    const createHistoryNote = autoAssignDecision
      ? `${payload.remarks ? `${String(payload.remarks).trim()} · ` : ''}Auto Load-Balanced to ${autoAssignDecision.officer.fullName} (${autoAssignDecision.officer.employeeCode}) [${autoAssignDecision.geoMatchReasons.join(', ')} | Active Workload: ${autoAssignDecision.officer.activeLeadCount} | Score: ${autoAssignDecision.compositeScore}]`
      : resolvedBmId && !resolvedTlId && !assignedOfficerId
        ? `${payload.remarks ? `${String(payload.remarks).trim()} · ` : ''}Routed to Branch Manager for Team Leader assignment`
        : resolvedTlId && !assignedOfficerId
          ? `${payload.remarks ? `${String(payload.remarks).trim()} · ` : ''}Routed to Team Leader for Field Officer assignment`
          : payload.remarks
            ? String(payload.remarks)
            : 'Lead created';

    db.prepare(`
      INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks)
      VALUES (?, NULL, ?, ?, ?)
    `).run(leadId, initialStatus, user.id, createHistoryNote);

    if (resolvedBmId && resolvedBmId !== user.id && !assignedOfficerId && !resolvedTlId) {
      createAlert({
        userId: resolvedBmId,
        leadId,
        category: 'Lead Follow-up Alert',
        titleEn: `Branch Lead Assigned to You: ${leadCode}`,
        titleHi: `ब्रांच लीड आपको सौंपी गई: ${leadCode}`,
        messageEn: `${user.fullName} assigned ${leadCode} (${loanProduct}) to your branch. Please assign a Team Leader.`,
        messageHi: `${user.fullName} ने लीड ${leadCode} (${loanProduct}) आपकी ब्रांच को सौंपी है। कृपया टीम लीडर को असाइन करें।`,
      });
    }

    if (resolvedTlId && resolvedTlId !== user.id && !assignedOfficerId) {
      createAlert({
        userId: resolvedTlId,
        leadId,
        category: 'Lead Follow-up Alert',
        titleEn: `Team Lead Assigned to You: ${leadCode}`,
        titleHi: `टीम लीड आपको सौंपी गई: ${leadCode}`,
        messageEn: `${user.fullName} assigned ${leadCode} (${loanProduct}) to your team. Select a Field Officer for follow-up.`,
        messageHi: `${user.fullName} ने लीड ${leadCode} (${loanProduct}) आपकी टीम को सौंपी है। फॉलो-अप के लिए फील्ड ऑफिसर चुनें।`,
      });
    }

    if (assignedOfficerId && assignedOfficerId !== user.id) {
      createAlert({
        userId: assignedOfficerId,
        leadId,
        category: 'Lead Follow-up Alert',
        titleEn: autoAssignDecision ? `Auto-Assigned Lead: ${leadCode}` : `New Lead Assigned: ${leadCode}`,
        titleHi: autoAssignDecision ? `ऑटो-असाइन लीड: ${leadCode}` : `नई लीड सौंपी गई: ${leadCode}`,
        messageEn: autoAssignDecision
          ? `Load-Balancer assigned ${leadCode} (${loanProduct}) to you [${autoAssignDecision.geoMatchReasons[0] || 'Workload Balanced'}]. Update status within ${settings.assignmentSlaMinutes} minutes.`
          : `Lead ${leadCode} (${loanProduct}) assigned to you by ${user.fullName}. Update status within ${settings.assignmentSlaMinutes} minutes.`,
        messageHi: `लीड ${leadCode} (${loanProduct}) आपको सौंपी गई है। ${settings.assignmentSlaMinutes} मिनट में स्टेटस अपडेट करें।`,
      });
    }

    // If Referral Partner generated the lead -> notify ONLY Admin + Back Office Team (for branch-wise BM assignment)
    if (user.role === 'REFERRAL_PARTNER') {
      const assigners = db
        .prepare(`SELECT id FROM users WHERE role IN ('SUPER_ADMIN', 'LEAD_GENERATOR') AND is_active = 1`)
        .all() as { id: number }[];
      for (const staff of assigners) {
        createAlert({
          userId: staff.id,
          leadId,
          category: 'Lead Follow-up Alert',
          titleEn: `Referral Lead Ready (Assign Branch BM): ${leadCode}`,
          titleHi: `रेफरल लीड (BM असाइनमेंट हेतु): ${leadCode}`,
          messageEn: `${user.fullName} (${user.referralCode || user.employeeCode}) submitted referral lead ${leadCode}. Assign Branch Manager.`,
          messageHi: `${user.fullName} द्वारा नई रेफरल लीड ${leadCode} दर्ज की गई है। कृपया ब्रांच मैनेजर (BM) को असाइन करें।`,
        });
      }
    }

    // If Field Officer generated the lead -> notify TL, BM, Back Office Team, and Super Admin
    if (user.role === 'FIELD_OFFICER') {
      const notifyIds = new Set<number>();
      const backOfficeAndAdmins = db
        .prepare(`SELECT id FROM users WHERE role IN ('SUPER_ADMIN', 'LEAD_GENERATOR') AND is_active = 1`)
        .all() as { id: number }[];
      for (const s of backOfficeAndAdmins) notifyIds.add(s.id);
      if (resolvedTlId && resolvedTlId !== user.id) notifyIds.add(resolvedTlId);
      if (resolvedBmId && resolvedBmId !== user.id) notifyIds.add(resolvedBmId);

      for (const targetUid of notifyIds) {
        createAlert({
          userId: targetUid,
          leadId,
          category: 'Lead Follow-up Alert',
          titleEn: `Field Officer Lead Generated: ${leadCode}`,
          titleHi: `फील्ड ऑफिसर द्वारा नई लीड दर्ज: ${leadCode}`,
          messageEn: `${user.fullName} (${user.employeeCode}) generated daily lead ${leadCode} (${loanProduct}).`,
          messageHi: `${user.fullName} (${user.employeeCode}) ने नई लीड ${leadCode} (${loanProduct}) दर्ज की है।`,
        });
      }
    }

    logAudit(
      user,
      autoAssignDecision ? 'LEAD_CREATED_AUTO_ASSIGNED' : 'LEAD_CREATED',
      'LEAD',
      leadCode,
      autoAssignDecision
        ? `Created lead ${leadCode} for ${customerName} · Auto Load-Balanced to ${autoAssignDecision.officer.fullName} (${autoAssignDecision.officer.employeeCode})`
        : `Created lead ${leadCode} for ${customerName}`
    );
    const row = db
      .prepare(`
        SELECT l.*, cb.full_name as created_by_name, cb.role as created_by_role, cb.employee_code as created_by_code,
          bm.full_name as assigned_bm_name, bm.employee_code as assigned_bm_code,
          tl.full_name as assigned_tl_name, tl.employee_code as assigned_tl_code,
          ao.full_name as assigned_officer_name, ao.employee_code as assigned_officer_code, ao.mobile as assigned_officer_mobile, b.name as branch_name
        FROM leads l
        JOIN users cb ON cb.id = l.created_by
        LEFT JOIN users bm ON bm.id = l.assigned_bm_id
        LEFT JOIN users tl ON tl.id = l.assigned_tl_id
        LEFT JOIN users ao ON ao.id = l.assigned_officer_id
        LEFT JOIN branches b ON b.id = l.branch_id
        WHERE l.id = ?
      `)
      .get(leadId);

    res.status(201).json({
      duplicateDetected: false,
      lead: serializeLeadForUser(row, user),
      autoAssignDecision,
    });
  });

  // Automated Lead Assignment Load-Balancer: Overview, Scoring Preview, and Batch Distribution
  router.get(
    '/leads/load-balance/overview',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER', 'LEAD_GENERATOR'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const settings = getSettings();
      const officers = getOfficerWorkloadSnapshots({
        allowedOfficerIds: getScopedOfficerIdsForUser(user),
      });
      const unassignedRows = db
        .prepare(`
          SELECT l.*, cb.role as created_by_role
          FROM leads l
          JOIN users cb ON cb.id = l.created_by
          WHERE l.assigned_officer_id IS NULL
            AND l.status NOT IN ('Disbursed', 'Rejected', 'Closed')
          ORDER BY l.id ASC
        `)
        .all() as any[];

      const accessibleUnassigned = unassignedRows.filter((r) => canUserAccessLead(r, user));

      const recentAutoAssignments = db
        .prepare(`
          SELECT id, user_name as userName, user_role as userRole, action, entity_id as leadCode, details, created_at as createdAt
          FROM audit_logs
          WHERE action IN ('LEAD_AUTO_ASSIGNED', 'LEAD_CREATED_AUTO_ASSIGNED', 'LEAD_BATCH_BALANCED', 'QR_REFERRAL_LEAD_AUTO_ASSIGNED')
          ORDER BY id DESC
          LIMIT 15
        `)
        .all();

      res.json({
        settings: {
          autoAssignIncomingLeads: Boolean(settings.autoAssignIncomingLeads ?? true),
          maxActiveLeads: Number(settings.autoAssignMaxActiveLeads ?? 25),
          geoWeight: Number(settings.autoAssignGeoWeight ?? 60),
        },
        officers,
        unassignedCount: accessibleUnassigned.length,
        unassignedPreview: accessibleUnassigned.slice(0, 15).map((r) => ({
          id: r.id,
          leadCode: r.lead_code,
          customerName: r.customer_name,
          city: r.city,
          state: r.state,
          pinCode: r.pin_code,
          loanProduct: r.loan_product,
          loanAmount: Number(r.loan_amount || 0),
          createdAt: r.created_at,
        })),
        recentAutoAssignments,
      });
    }
  );

  router.post(
    '/leads/load-balance/preview',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER', 'LEAD_GENERATOR'),
    (req: AuthedRequest, res) => {
      const { leadId, city, state, pinCode, address, branchId, excludeCurrent, overrideGeoWeight, overrideMaxActiveLeads } =
        req.body as Record<string, any>;

      let leadGeo = {
        city: city ? String(city) : null,
        state: state ? String(state) : null,
        pinCode: pinCode ? String(pinCode) : null,
        address: address ? String(address) : null,
        branchId: branchId ? Number(branchId) : null,
      };
      let excludeOfficerId: number | null = null;

      if (leadId) {
        const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId)) as any;
        if (!row) {
          res.status(404).json({ error: 'Lead not found' });
          return;
        }
        leadGeo = {
          city: row.city,
          state: row.state,
          pinCode: row.pin_code,
          address: decryptPii(row.address_enc),
          branchId: row.branch_id,
        };
        if (excludeCurrent && row.assigned_officer_id) {
          excludeOfficerId = Number(row.assigned_officer_id);
        }
      }

      const scored = scoreOfficersForLead(leadGeo, {
        excludeOfficerId,
        overrideGeoWeight: overrideGeoWeight !== undefined ? Number(overrideGeoWeight) : undefined,
        overrideMaxActiveLeads: overrideMaxActiveLeads !== undefined ? Number(overrideMaxActiveLeads) : undefined,
        allowedOfficerIds: getScopedOfficerIdsForUser(req.user!),
      });
      res.json(scored);
    }
  );

  router.post(
    '/leads/load-balance/distribute-unassigned',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER', 'LEAD_GENERATOR'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const settings = getSettings();
      const rawUnassigned = db
        .prepare(`
          SELECT l.*, cb.role as created_by_role
          FROM leads l
          JOIN users cb ON cb.id = l.created_by
          WHERE l.assigned_officer_id IS NULL
            AND l.status NOT IN ('Disbursed', 'Rejected', 'Closed')
          ORDER BY l.id ASC
        `)
        .all() as any[];

      const targets = rawUnassigned.filter((r) => canUserAccessLead(r, user));
      if (targets.length === 0) {
        res.json({ distributedCount: 0, assignments: [] });
        return;
      }

      const assignments: {
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
      }[] = [];

      const now = nowSql();
      const deadline = nowSql(settings.assignmentSlaMinutes);

      const scopedOfficerIds = getScopedOfficerIdsForUser(user);
      const runBatch = db.transaction(() => {
        for (const lead of targets) {
          const result = scoreOfficersForLead(
            {
              city: lead.city,
              state: lead.state,
              pinCode: lead.pin_code,
              address: decryptPii(lead.address_enc),
              branchId: lead.branch_id,
            },
            { allowedOfficerIds: scopedOfficerIds }
          );
          if (!result.best) continue;

          const pick = result.best;
          const newStatus = lead.status === 'Lead Generated' ? 'Lead Assigned' : lead.status;
          const hier = resolveOfficerHierarchy(pick.officer.id);

          db.prepare(`
            UPDATE leads
            SET assigned_bm_id = COALESCE(?, assigned_bm_id),
                assigned_tl_id = COALESCE(?, assigned_tl_id),
                assigned_officer_id = ?,
                branch_id = COALESCE(?, branch_id),
                assigned_at = ?, assignment_deadline_at = ?, assignment_sla_checked = 0,
                status = ?, updated_at = ?
            WHERE id = ?
          `).run(hier.bmId, hier.tlId, pick.officer.id, hier.branchId, now, deadline, newStatus, now, lead.id);

          const note = `Batch Load-Balanced to ${pick.officer.fullName} (${pick.officer.employeeCode}) [${pick.geoMatchReasons.join(', ')} | Prior Load: ${pick.officer.activeLeadCount} | Score: ${pick.compositeScore}]`;
          db.prepare(`
            INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks)
            VALUES (?, ?, ?, ?, ?)
          `).run(lead.id, lead.status, newStatus, user.id, note);

          assignments.push({
            leadId: lead.id,
            leadCode: lead.lead_code,
            customerName: lead.customer_name,
            city: lead.city,
            pinCode: lead.pin_code,
            assignedOfficerId: pick.officer.id,
            assignedOfficerName: pick.officer.fullName,
            assignedOfficerCode: pick.officer.employeeCode,
            compositeScore: pick.compositeScore,
            geoMatchReasons: pick.geoMatchReasons,
            previousActiveLoad: pick.officer.activeLeadCount,
          });
        }
      });

      runBatch();

      for (const a of assignments) {
        createAlert({
          userId: a.assignedOfficerId,
          leadId: a.leadId,
          category: 'Lead Follow-up Alert',
          titleEn: `Auto-Distributed Lead: ${a.leadCode}`,
          titleHi: `ऑटो-असाइन लीड: ${a.leadCode}`,
          messageEn: `Load-Balancer assigned ${a.leadCode} (${a.geoMatchReasons[0] || 'Workload Balanced'}) to you. Update within ${settings.assignmentSlaMinutes} minutes.`,
          messageHi: `लोड-बैलेंसर ने लीड ${a.leadCode} आपको सौंपी है। ${settings.assignmentSlaMinutes} मिनट में अपडेट करें।`,
        });
      }

      if (assignments.length > 0) {
        logAudit(
          user,
          'LEAD_BATCH_BALANCED',
          'LEAD',
          `${assignments.length} LEADS`,
          `Auto load-balanced ${assignments.length} unassigned lead(s): ${assignments
            .slice(0, 6)
            .map((a) => `${a.leadCode}->${a.assignedOfficerCode}`)
            .join(', ')}${assignments.length > 6 ? '...' : ''}`
        );
      }

      res.json({ distributedCount: assignments.length, assignments });
    }
  );

  // Lead Details + Case History + Documents + Reminders
  router.get('/leads/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const leadId = Number(req.params.id);
    const row = db
      .prepare(`
        SELECT l.*, cb.full_name as created_by_name, cb.role as created_by_role, cb.employee_code as created_by_code,
          bm.full_name as assigned_bm_name, bm.employee_code as assigned_bm_code,
          tl.full_name as assigned_tl_name, tl.employee_code as assigned_tl_code,
          ao.full_name as assigned_officer_name, ao.employee_code as assigned_officer_code, ao.mobile as assigned_officer_mobile,
          rb.full_name as rejected_by_name, rb.employee_code as rejected_by_code,
          crb.full_name as closure_requested_by_name, cab.full_name as closure_approved_by_name,
          b.name as branch_name
        FROM leads l
        JOIN users cb ON cb.id = l.created_by
        LEFT JOIN users bm ON bm.id = l.assigned_bm_id
        LEFT JOIN users tl ON tl.id = l.assigned_tl_id
        LEFT JOIN users ao ON ao.id = l.assigned_officer_id
        LEFT JOIN users rb ON rb.id = l.rejected_by
        LEFT JOIN users crb ON crb.id = l.closure_requested_by
        LEFT JOIN users cab ON cab.id = l.closure_approved_by
        LEFT JOIN branches b ON b.id = l.branch_id
        WHERE l.id = ?
      `)
      .get(leadId) as any;

    if (!row) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    if (!canUserAccessLead(row, user)) {
      res.status(403).json({ error: 'Access denied: you are not authorized to view this lead' });
      return;
    }

    const history = db
      .prepare(`
        SELECT ch.id, ch.prev_status as prevStatus, ch.new_status as newStatus, ch.remarks, ch.created_at as createdAt,
          u.full_name as updatedByName, u.role as updatedByRole
        FROM case_history ch
        JOIN users u ON u.id = ch.updated_by
        WHERE ch.lead_id = ?
        ORDER BY ch.created_at DESC, ch.id DESC
      `)
      .all(leadId)
      .map((h: any) => ({
        ...h,
        remarks: user.role === 'REFERRAL_PARTNER' ? null : h.remarks, // Strip internal remarks for referrals
      }));

    const documents =
      user.role === 'REFERRAL_PARTNER'
        ? [] // Referral partners MUST NOT view customer KYC documents
        : db
            .prepare(`
              SELECT d.id, d.category, d.file_name as fileName, d.mime_type as mimeType, d.file_size as fileSize,
                d.created_at as createdAt, u.full_name as uploadedByName
              FROM documents d
              JOIN users u ON u.id = d.uploaded_by
              WHERE d.lead_id = ?
              ORDER BY d.created_at DESC
            `)
            .all(leadId);

    const reminders =
      user.role === 'REFERRAL_PARTNER'
        ? []
        : db
            .prepare(`
              SELECT r.*, u.full_name as officerName
              FROM followup_reminders r
              JOIN users u ON u.id = r.assigned_officer_id
              WHERE r.lead_id = ?
              ORDER BY r.due_at DESC
            `)
            .all(leadId);

    const leadRewards =
      user.role === 'REFERRAL_PARTNER'
        ? []
        : db
            .prepare(`
              SELECT sr.id, sr.reward_code as rewardCode, sr.employee_id as employeeId,
                u.full_name as employeeName, u.employee_code as employeeCode,
                sr.staff_bucket as staffBucket, sr.entry_type as entryType,
                sr.points_delta as pointsDelta, sr.amount_inr as amountInr,
                sr.status, sr.reason, sr.created_at as createdAt
              FROM staff_rewards sr
              JOIN users u ON u.id = sr.employee_id
              WHERE sr.lead_id = ?
              ORDER BY sr.id DESC
            `)
            .all(leadId);

    const docCompletion =
      user.role === 'REFERRAL_PARTNER'
        ? null
        : getLeadDocumentCompletion(leadId, row.loan_product);

    purgeExpiredFollowupRecordings();
    const followupRecordings =
      user.role === 'REFERRAL_PARTNER'
        ? []
        : db
            .prepare(`
              SELECT fr.id, fr.recording_code as recordingCode, fr.lead_id as leadId,
                fr.recorded_by as recordedBy, u.full_name as recordedByName, u.employee_code as recordedByCode,
                fr.recorded_by_role as recordedByRole, fr.call_notes as callNotes,
                fr.duration_seconds as durationSeconds, fr.file_name as fileName,
                fr.mime_type as mimeType, fr.file_size as fileSize,
                fr.share_token as shareToken, fr.created_at as createdAt, fr.expires_at as expiresAt
              FROM followup_recordings fr
              JOIN users u ON u.id = fr.recorded_by
              WHERE fr.lead_id = ? AND fr.expires_at > datetime('now')
              ORDER BY fr.created_at DESC, fr.id DESC
            `)
            .all(leadId)
            .map((r: any) => ({
              id: Number(r.id),
              recordingCode: r.recordingCode,
              leadId: Number(r.leadId),
              recordedBy: Number(r.recordedBy),
              recordedByName: r.recordedByName,
              recordedByCode: r.recordedByCode,
              recordedByRole: r.recordedByRole,
              callNotes: r.callNotes ?? null,
              durationSeconds: Number(r.durationSeconds || 0),
              fileName: r.fileName,
              mimeType: r.mimeType,
              fileSize: Number(r.fileSize || 0),
              canPlayOrShare: user.role === 'SUPER_ADMIN',
              hasShareLink: Boolean(r.shareToken),
              shareToken: user.role === 'SUPER_ADMIN' ? r.shareToken ?? null : null,
              createdAt: r.createdAt,
              expiresAt: r.expiresAt,
            }));

    res.json({
      lead: serializeLeadForUser(row, user),
      history,
      documents,
      reminders,
      leadRewards,
      docCompletion,
      followupRecordings,
    });
  });

  // 3-Stage Hierarchical Assignment: Back Office -> Branch Manager (BM) -> Team Leader (TL) -> Field Officer (FO)
  router.patch(
    '/leads/:id/assign',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER', 'LEAD_GENERATOR'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const leadId = Number(req.params.id);
      const {
        assignedBmId,
        assignedTlId,
        assignedOfficerId,
        assignedOfficerEmployeeCode,
        remarks,
      } = req.body as {
        assignedBmId?: number;
        assignedTlId?: number;
        assignedOfficerId?: number;
        assignedOfficerEmployeeCode?: string;
        remarks?: string;
      };

      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      if (!canUserAccessLead(lead, user)) {
        res.status(403).json({ error: 'Access denied: you are not authorized to assign this lead' });
        return;
      }

      const now = nowSql();

      // Stage 1: Assign to Branch Manager (Back Office Team or Super Admin)
      if (assignedBmId && !assignedTlId && !assignedOfficerId && !assignedOfficerEmployeeCode) {
        if (!['SUPER_ADMIN', 'LEAD_GENERATOR'].includes(user.role)) {
          res.status(403).json({ error: 'Only Back Office Team or Super Admin can assign leads to a Branch Manager' });
          return;
        }
        const bm = db
          .prepare(`SELECT * FROM users WHERE id = ? AND is_active = 1 AND role = 'BRANCH_MANAGER'`)
          .get(Number(assignedBmId)) as any;
        if (!bm) {
          res.status(404).json({ error: 'Target Branch Manager not found or inactive' });
          return;
        }
        const nextBranchId = bm.branch_id ?? lead.branch_id;
        db.prepare(`
          UPDATE leads
          SET assigned_bm_id = ?, assigned_tl_id = NULL, assigned_officer_id = NULL, branch_id = ?,
              assigned_at = ?, assignment_deadline_at = NULL, assignment_sla_checked = 0, updated_at = ?
          WHERE id = ?
        `).run(bm.id, nextBranchId, now, now, leadId);

        db.prepare(`
          INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          leadId,
          lead.status,
          lead.status,
          user.id,
          remarks || `Assigned to Branch Manager ${bm.full_name} (${bm.employee_code})`
        );

        createAlert({
          userId: bm.id,
          leadId,
          category: 'Lead Follow-up Alert',
          titleEn: `Branch Lead Assigned: ${lead.lead_code}`,
          titleHi: `ब्रांच लीड सौंपी गई: ${lead.lead_code}`,
          messageEn: `Back Office assigned ${lead.lead_code} to you. Assign a Team Leader under your branch.`,
          messageHi: `बैक ऑफिस ने लीड ${lead.lead_code} आपको सौंपी है। कृपया अपनी ब्रांच के टीम लीडर को असाइन करें।`,
        });

        logAudit(user, 'LEAD_ASSIGNED_TO_BM', 'LEAD', lead.lead_code, `Routed ${lead.lead_code} to BM ${bm.full_name} (${bm.employee_code})`);
        res.json({ ok: true, stage: 'BM' });
        return;
      }

      // Stage 2: Branch Manager (or Super Admin) assigns to Team Leader
      if (assignedTlId && !assignedOfficerId && !assignedOfficerEmployeeCode) {
        if (!['SUPER_ADMIN', 'BRANCH_MANAGER'].includes(user.role)) {
          res.status(403).json({ error: 'Only Branch Manager or Super Admin can assign leads to a Team Leader' });
          return;
        }
        const tl = db
          .prepare(`SELECT * FROM users WHERE id = ? AND is_active = 1 AND role = 'TEAM_LEADER'`)
          .get(Number(assignedTlId)) as any;
        if (!tl) {
          res.status(404).json({ error: 'Target Team Leader not found or inactive' });
          return;
        }
        if (
          user.role === 'BRANCH_MANAGER' &&
          tl.reports_to_user_id !== user.id &&
          tl.branch_id !== user.branchId
        ) {
          res.status(403).json({ error: 'You can only assign leads to Team Leaders under your Branch Manager hierarchy' });
          return;
        }

        const resolvedBmId = tl.reports_to_user_id ?? (user.role === 'BRANCH_MANAGER' ? user.id : lead.assigned_bm_id);
        const nextBranchId = tl.branch_id ?? lead.branch_id;

        db.prepare(`
          UPDATE leads
          SET assigned_bm_id = ?, assigned_tl_id = ?, assigned_officer_id = NULL, branch_id = ?,
              assigned_at = ?, assignment_deadline_at = NULL, assignment_sla_checked = 0, updated_at = ?
          WHERE id = ?
        `).run(resolvedBmId, tl.id, nextBranchId, now, now, leadId);

        db.prepare(`
          INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          leadId,
          lead.status,
          lead.status,
          user.id,
          remarks || `Assigned to Team Leader ${tl.full_name} (${tl.employee_code})`
        );

        createAlert({
          userId: tl.id,
          leadId,
          category: 'Lead Follow-up Alert',
          titleEn: `Team Lead Assigned: ${lead.lead_code}`,
          titleHi: `टीम लीड सौंपी गई: ${lead.lead_code}`,
          messageEn: `${user.fullName} assigned ${lead.lead_code} to you. Select one of your Field Officers for follow-up.`,
          messageHi: `${user.fullName} ने लीड ${lead.lead_code} आपको सौंपी है। फॉलो-अप के लिए अपना फील्ड ऑफिसर चुनें।`,
        });

        logAudit(user, 'LEAD_ASSIGNED_TO_TL', 'LEAD', lead.lead_code, `Routed ${lead.lead_code} to TL ${tl.full_name} (${tl.employee_code})`);
        res.json({ ok: true, stage: 'TL' });
        return;
      }

      // Stage 3: Team Leader (or Super Admin / authorized manager) assigns to Field Officer
      if (!assignedOfficerId && !assignedOfficerEmployeeCode) {
        res.status(400).json({ error: 'Select Branch Manager, Team Leader, or Field Officer' });
        return;
      }

      const officer = assignedOfficerId
        ? (db.prepare(`SELECT * FROM users WHERE id = ? AND is_active = 1 AND role IN ('FIELD_OFFICER', 'TEAM_LEADER')`).get(Number(assignedOfficerId)) as any)
        : (db.prepare(`SELECT * FROM users WHERE UPPER(employee_code) = UPPER(?) AND is_active = 1 AND role IN ('FIELD_OFFICER', 'TEAM_LEADER')`).get(String(assignedOfficerEmployeeCode).trim()) as any);
      if (!officer) {
        res.status(404).json({ error: 'Target Field Officer (by ID or Employee Code) not found' });
        return;
      }

      if (
        user.role === 'TEAM_LEADER' &&
        officer.id !== user.id &&
        officer.reports_to_user_id !== user.id &&
        !(user.teamId && officer.team_id === user.teamId)
      ) {
        res.status(403).json({ error: 'Team Leader can only assign leads to Field Officers under their own team' });
        return;
      }
      if (
        user.role === 'BRANCH_MANAGER' &&
        officer.branch_id !== user.branchId &&
        !(officer.reports_to_user_id && lead.assigned_tl_id === officer.reports_to_user_id)
      ) {
        res.status(403).json({ error: 'Branch Manager can only assign to Field Officers within their branch' });
        return;
      }

      const resolvedTlId =
        officer.role === 'TEAM_LEADER' ? officer.id : officer.reports_to_user_id ?? lead.assigned_tl_id ?? null;
      let resolvedBmId = lead.assigned_bm_id ?? null;
      if (resolvedTlId) {
        const tlRow = db.prepare(`SELECT reports_to_user_id FROM users WHERE id = ?`).get(resolvedTlId) as
          | { reports_to_user_id: number | null }
          | undefined;
        if (tlRow?.reports_to_user_id) resolvedBmId = tlRow.reports_to_user_id;
      }

      const settings = getSettings();
      const deadline = nowSql(settings.assignmentSlaMinutes);
      const isReassign = Boolean(lead.assigned_officer_id);
      const newStatus = lead.status === 'Lead Generated' ? 'Lead Assigned' : lead.status;

      db.prepare(`
        UPDATE leads
        SET assigned_bm_id = COALESCE(?, assigned_bm_id),
            assigned_tl_id = COALESCE(?, assigned_tl_id),
            assigned_officer_id = ?,
            branch_id = COALESCE(?, branch_id),
            assigned_at = ?, assignment_deadline_at = ?, assignment_sla_checked = 0,
            status = ?, updated_at = ?
        WHERE id = ?
      `).run(resolvedBmId, resolvedTlId, officer.id, officer.branch_id, now, deadline, newStatus, now, leadId);

      db.prepare(`
        INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        leadId,
        lead.status,
        newStatus,
        user.id,
        remarks || `${isReassign ? 'Reassigned' : 'Assigned'} to Field Officer ${officer.full_name} (${officer.employee_code})`
      );

      createAlert({
        userId: officer.id,
        leadId,
        category: 'Lead Follow-up Alert',
        titleEn: `Lead ${isReassign ? 'Reassigned' : 'Assigned'}: ${lead.lead_code}`,
        titleHi: `लीड ${isReassign ? 'पुनः आवंटित' : 'सौंपी गई'}: ${lead.lead_code}`,
        messageEn: `Update status on ${lead.lead_code} within ${settings.assignmentSlaMinutes} minutes to avoid ₹10 penalty.`,
        messageHi: `₹10 पेनल्टी से बचने के लिए ${settings.assignmentSlaMinutes} मिनट में ${lead.lead_code} का स्टेटस अपडेट करें।`,
      });

      logAudit(
        user,
        isReassign ? 'LEAD_REASSIGNED' : 'LEAD_ASSIGNED',
        'LEAD',
        lead.lead_code,
        `${isReassign ? 'Reassigned' : 'Assigned'} ${lead.lead_code} to ${officer.full_name}. 10-min SLA deadline: ${deadline}`
      );

      res.json({ ok: true, deadline, stage: 'FO' });
    }
  );

  // Smart Auto-Assign / Rebalance single Lead via Workload + Geographical Area Algorithm
  router.post(
    '/leads/:id/auto-assign',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER', 'LEAD_GENERATOR'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const leadId = Number(req.params.id);
      const { excludeCurrent, remarks } = (req.body || {}) as {
        excludeCurrent?: boolean;
        remarks?: string;
      };

      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      if (!canUserAccessLead(lead, user)) {
        res.status(403).json({ error: 'Access denied: you are not authorized to assign this lead' });
        return;
      }

      const scored = scoreOfficersForLead(
        {
          city: lead.city,
          state: lead.state,
          pinCode: lead.pin_code,
          address: decryptPii(lead.address_enc),
          branchId: lead.branch_id,
        },
        {
          excludeOfficerId: excludeCurrent && lead.assigned_officer_id ? Number(lead.assigned_officer_id) : null,
          allowedOfficerIds: getScopedOfficerIdsForUser(user),
        }
      );

      if (!scored.best) {
        res.status(400).json({ error: 'No active Field Officer available for load-balanced assignment' });
        return;
      }

      const pick = scored.best;
      const settings = getSettings();
      const now = nowSql();
      const deadline = nowSql(settings.assignmentSlaMinutes);
      const isReassign = Boolean(lead.assigned_officer_id);
      const newStatus = lead.status === 'Lead Generated' ? 'Lead Assigned' : lead.status;
      const hier = resolveOfficerHierarchy(pick.officer.id);

      db.prepare(`
        UPDATE leads
        SET assigned_bm_id = COALESCE(?, assigned_bm_id),
            assigned_tl_id = COALESCE(?, assigned_tl_id),
            assigned_officer_id = ?,
            branch_id = COALESCE(?, branch_id),
            assigned_at = ?, assignment_deadline_at = ?, assignment_sla_checked = 0,
            status = ?, updated_at = ?
        WHERE id = ?
      `).run(hier.bmId, hier.tlId, pick.officer.id, hier.branchId, now, deadline, newStatus, now, leadId);

      const historyNote = `${remarks ? `${remarks} · ` : ''}Auto Load-Balanced to ${pick.officer.fullName} (${pick.officer.employeeCode}) [${pick.geoMatchReasons.join(', ')} | Active Workload: ${pick.officer.activeLeadCount} | Score: ${pick.compositeScore}]`;
      db.prepare(`
        INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks)
        VALUES (?, ?, ?, ?, ?)
      `).run(leadId, lead.status, newStatus, user.id, historyNote);

      createAlert({
        userId: pick.officer.id,
        leadId,
        category: 'Lead Follow-up Alert',
        titleEn: `Auto-${isReassign ? 'Rebalanced' : 'Assigned'} Lead: ${lead.lead_code}`,
        titleHi: `ऑटो-${isReassign ? 'पुनः आवंटित' : 'असाइन'} लीड: ${lead.lead_code}`,
        messageEn: `Load-Balancer assigned ${lead.lead_code} (${pick.geoMatchReasons[0] || 'Workload Balanced'}) to you. Update status within ${settings.assignmentSlaMinutes} minutes.`,
        messageHi: `लोड-बैलेंसर ने लीड ${lead.lead_code} आपको सौंपी है। ${settings.assignmentSlaMinutes} मिनट में अपडेट करें।`,
      });

      logAudit(
        user,
        'LEAD_AUTO_ASSIGNED',
        'LEAD',
        lead.lead_code,
        `Auto load-balanced ${lead.lead_code} to ${pick.officer.fullName} (${pick.officer.employeeCode}) [Score ${pick.compositeScore} | ${pick.geoMatchReasons.join(', ')}]`
      );

      res.json({
        ok: true,
        deadline,
        decision: pick,
        candidates: scored.candidates,
      });
    }
  );

  // Update Lead Case Status (Strictly forbidden for Referral Partners)
  router.patch('/leads/:id/status', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Referral partners cannot modify case status' });
      return;
    }

    const leadId = Number(req.params.id);
    const {
      status,
      remarks,
      lostReason,
      docsCompleteVerified,
      wrongLeadPenalty,
    } = req.body as {
      status?: CaseStatus;
      remarks?: string;
      lostReason?: string;
      docsCompleteVerified?: boolean;
      wrongLeadPenalty?: { amount?: number; reason?: string; targetEmployeeId?: number };
    };
    if (!status || !CASE_STATUSES.includes(status)) {
      res.status(400).json({ error: 'Valid case status is required' });
      return;
    }

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    if (!canUserAccessLead(lead, user)) {
      res.status(403).json({ error: 'You are not authorized to update this lead' });
      return;
    }

    const isLostStatus = status === 'Rejected' || status === 'Closed';
    const cleanLostReason = isLostStatus && lostReason ? String(lostReason).trim() : isLostStatus ? lead.lost_reason || 'Other' : null;
    const now = nowSql();

    // Enforce Seniority Approval Rule when closing a lead (Field Officer -> Team Leader | Team Leader -> Branch Manager | Branch Manager -> Super Admin)
    if (status === 'Closed') {
      const targetActorRole =
        lead.status === 'Rejected'
          ? resolveLeadClosureSeniority(lead).actorRole
          : user.role;
      const seniority = resolveLeadClosureSeniority({
        ...lead,
        rejected_by_role: lead.status === 'Rejected' ? lead.rejected_by_role : targetActorRole,
      });
      if (user.role !== seniority.expectedApproverRole) {
        const prefix =
          lead.status === 'Rejected'
            ? `Seniority Approval Rule: Leads rejected by ${seniority.actorRole.replace(/_/g, ' ')} can only be approved for Closed status by ${seniority.expectedApproverLabel}.`
            : `Seniority Approval Rule: Mark the lead as 'Rejected' first or submit it for Close Approval to ${seniority.expectedApproverLabel}.`;
        res.status(403).json({ error: prefix });
        return;
      }
      db.prepare(`
        UPDATE leads
        SET status = 'Closed',
            lost_reason = COALESCE(?, lost_reason),
            closure_status = 'APPROVED',
            closure_approved_by = ?,
            closure_approved_at = ?,
            closure_remarks = COALESCE(?, closure_remarks),
            last_status_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(cleanLostReason, user.id, now, remarks ? String(remarks).trim() : null, now, now, leadId);
    } else if (status === 'Rejected') {
      const seniority = resolveLeadClosureSeniority({
        ...lead,
        rejected_by_role: user.role,
      });
      db.prepare(`
        UPDATE leads
        SET status = 'Rejected',
            lost_reason = ?,
            rejected_by = ?,
            rejected_by_role = ?,
            rejected_at = ?,
            closure_status = 'PENDING_APPROVAL',
            closure_requested_by = ?,
            closure_requested_at = ?,
            closure_approved_by = NULL,
            closure_approved_at = NULL,
            last_status_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(cleanLostReason, user.id, user.role, now, user.id, now, now, now, leadId);

      // Dispatch alert to Seniority Approver (FO -> TL | TL/LG -> BM | BM -> Super Admin)
      const approverIds = new Set<number>();
      if (seniority.expectedApproverRole === 'TEAM_LEADER') {
        if (lead.assigned_tl_id) approverIds.add(Number(lead.assigned_tl_id));
        const userRow = db.prepare(`SELECT reports_to_user_id, team_id FROM users WHERE id = ?`).get(user.id) as any;
        if (userRow?.reports_to_user_id) approverIds.add(Number(userRow.reports_to_user_id));
        if (approverIds.size === 0 && userRow?.team_id) {
          const teamRow = db.prepare(`SELECT leader_user_id FROM teams WHERE id = ?`).get(userRow.team_id) as any;
          if (teamRow?.leader_user_id) approverIds.add(Number(teamRow.leader_user_id));
        }
      } else if (seniority.expectedApproverRole === 'BRANCH_MANAGER') {
        if (lead.assigned_bm_id) approverIds.add(Number(lead.assigned_bm_id));
        const userRow = db.prepare(`SELECT reports_to_user_id, branch_id FROM users WHERE id = ?`).get(user.id) as any;
        if (userRow?.reports_to_user_id) approverIds.add(Number(userRow.reports_to_user_id));
        if (approverIds.size === 0 && (lead.branch_id || userRow?.branch_id)) {
          const bms = db
            .prepare(`SELECT id FROM users WHERE role = 'BRANCH_MANAGER' AND branch_id = ? AND is_active = 1`)
            .all(lead.branch_id || userRow?.branch_id) as { id: number }[];
          for (const b of bms) approverIds.add(b.id);
        }
      } else {
        for (const aid of getSuperAdminIds()) approverIds.add(aid);
      }
      for (const targetId of approverIds) {
        if (targetId === user.id) continue;
        createAlert({
          userId: targetId,
          leadId,
          category: 'Lead Follow-up Alert',
          titleEn: `Close Approval Needed (${lead.lead_code})`,
          titleHi: `लीड क्लोज़ स्वीकृति आवश्यक (${lead.lead_code})`,
          messageEn: `${user.fullName} (${user.employeeCode}) marked ${lead.lead_code} as Rejected (${cleanLostReason}). Seniority Close Approval required by ${seniority.expectedApproverLabel}.`,
          messageHi: `${user.fullName} (${user.employeeCode}) ने ${lead.lead_code} को Rejected (${cleanLostReason}) किया है। कृपया ${seniority.expectedApproverLabel} के रूप में Close Approval दें।`,
        });
      }
    } else {
      db.prepare(`
        UPDATE leads
        SET status = ?,
            lost_reason = ?,
            closure_status = CASE WHEN status = 'Rejected' THEN 'REJECTED_REOPENED' ELSE COALESCE(closure_status, 'NONE') END,
            last_status_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(status, cleanLostReason, now, now, leadId);
    }

    const historyNote = [remarks, cleanLostReason ? `Reason: ${cleanLostReason}` : null].filter(Boolean).join(' · ') || null;
    db.prepare(`
      INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(leadId, lead.status, status, user.id, historyNote, now);

    // Auto-award Staff Rewards (Doc Complete + Finance Login, Disbursement) for Field Officer & Lead Generator staff
    const canVerifyDocsOverride = Boolean(docsCompleteVerified) && ['SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER'].includes(user.role);
    const rewardEval = evaluateAndAwardLeadRewards(leadId, user.id, canVerifyDocsOverride);

    // Optional Wrong Lead Captured Minus Penalty (₹10 to ₹100) by Managers/Admin when rejecting/closing
    let wrongLeadPenaltyApplied: { employeeId: number; amount: number; rewardCode: string } | null = null;
    if (isLostStatus && wrongLeadPenalty && Number(wrongLeadPenalty.amount) > 0) {
      if (!['SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER'].includes(user.role)) {
        res.status(403).json({ error: 'Only Admin, Branch Manager, or Team Leader can impose wrong lead reward penalty' });
        return;
      }
      const settings = getSettings();
      const minPen = Number(settings.wrongLeadPenaltyMin ?? 10);
      const maxPen = Number(settings.wrongLeadPenaltyMax ?? 100);
      const rawAmt = Math.round(Number(wrongLeadPenalty.amount));
      if (rawAmt < minPen || rawAmt > maxPen) {
        res.status(400).json({ error: `Wrong lead minus reward penalty must be between ₹${minPen} and ₹${maxPen}` });
        return;
      }
      const candidateId = Number(wrongLeadPenalty.targetEmployeeId || lead.created_by || lead.assigned_officer_id);
      const targetUser = db.prepare(`SELECT id, full_name, role FROM users WHERE id = ?`).get(candidateId) as any;
      if (targetUser && targetUser.role !== 'REFERRAL_PARTNER') {
        const rewardCode = `RWD-WL-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`;
        const staffBucket = targetUser.id === lead.created_by && lead.created_by !== lead.assigned_officer_id ? 'LEAD_GENERATOR' : 'FIELD_OFFICER';
        const reasonText = (wrongLeadPenalty.reason || cleanLostReason || `Wrong lead captured on ${lead.lead_code}`).trim();
        db.prepare(`
          INSERT INTO staff_rewards
            (reward_code, employee_id, staff_bucket, lead_id, entry_type, points_delta, amount_inr, status, reason, awarded_by)
          VALUES (?, ?, ?, ?, 'WRONG_LEAD_PENALTY', ?, ?, 'ACTIVE', ?, ?)
        `).run(rewardCode, targetUser.id, staffBucket, leadId, -rawAmt, -rawAmt, reasonText, user.id);

        createAlert({
          userId: targetUser.id,
          leadId,
          category: '₹10 Penalty Alert',
          titleEn: `Wrong Lead Minus Reward (-₹${rawAmt}): ${lead.lead_code}`,
          titleHi: `गलत लीड पेनल्टी (-₹${rawAmt}): ${lead.lead_code}`,
          messageEn: `-₹${rawAmt} reward deduction applied on ${lead.lead_code}: ${reasonText}`,
          messageHi: `${lead.lead_code} पर गलत लीड दर्ज करने हेतु -₹${rawAmt} रिवॉर्ड कटौती की गई: ${reasonText}`,
        });
        wrongLeadPenaltyApplied = { employeeId: targetUser.id, amount: rawAmt, rewardCode };
      }
    }

    // Auto-calculate Referral Payout when marked Disbursed
    if (status === 'Disbursed' && (lead.referral_id || lead.created_by)) {
      const refPartner = lead.referral_id
        ? (db.prepare(`SELECT id, referral_code FROM users WHERE UPPER(referral_code) = UPPER(?)`).get(lead.referral_id) as any)
        : (db.prepare(`SELECT id, referral_code FROM users WHERE id = ? AND role = 'REFERRAL_PARTNER'`).get(lead.created_by) as any);

      if (refPartner) {
        const settings = getSettings();
        const prodCfg = settings.loanProducts.find((p) => p.name === lead.loan_product);
        const baseRate = Number(prodCfg?.commissionPct ?? 0.5);
        const monthKey = now.slice(0, 7);
        const monthlyDisbursed = (
          db
            .prepare(`
              SELECT COUNT(*) as c FROM leads
              WHERE (created_by = ? OR referral_id = ?) AND status = 'Disbursed' AND substr(updated_at, 1, 7) = ?
            `)
            .get(refPartner.id, refPartner.referral_code ?? '__', monthKey) as { c: number }
        ).c;
        const threshold = Number(settings.referralBonusThreshold ?? 5);
        const bonusRate = monthlyDisbursed >= threshold ? Number(settings.referralBonusPct ?? 0.15) : 0;
        const payoutAmt = Math.round(Number(lead.loan_amount || 0) * ((baseRate + bonusRate) / 100));

        db.prepare(`
          INSERT INTO referral_payouts (lead_id, referral_user_id, referral_code, loan_product, base_rate_pct, bonus_rate_pct, payout_amount, payout_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
          ON CONFLICT(lead_id) DO UPDATE SET
            base_rate_pct = excluded.base_rate_pct,
            bonus_rate_pct = excluded.bonus_rate_pct,
            payout_amount = excluded.payout_amount
        `).run(leadId, refPartner.id, refPartner.referral_code, lead.loan_product, baseRate, bonusRate, payoutAmt);
      }
    }

    // Satisfy active assignment SLA if updated in time, or record actual update time on penalty if already created
    if (lead.assignment_deadline_at && lead.assignment_sla_checked === 0 && now <= lead.assignment_deadline_at) {
      db.prepare('UPDATE leads SET assignment_sla_checked = 1 WHERE id = ?').run(leadId);
    }
    db.prepare(`
      UPDATE penalties SET actual_update_at = ? WHERE lead_id = ? AND employee_id = ? AND actual_update_at IS NULL
    `).run(now, leadId, user.id);

    // Complete pending follow-up reminders on this lead
    db.prepare(`
      UPDATE followup_reminders SET completed_at = ? WHERE lead_id = ? AND completed_at IS NULL
    `).run(now, leadId);

    // Notify creator + supervisory chain (TL, BM, Back Office Lead Gen) so status updates are visible across the chain
    const statusNotifyIds = new Set<number>();
    if (lead.created_by && lead.created_by !== user.id) statusNotifyIds.add(Number(lead.created_by));
    if (lead.assigned_tl_id && lead.assigned_tl_id !== user.id) statusNotifyIds.add(Number(lead.assigned_tl_id));
    if (lead.assigned_bm_id && lead.assigned_bm_id !== user.id) statusNotifyIds.add(Number(lead.assigned_bm_id));
    for (const targetUid of statusNotifyIds) {
      createAlert({
        userId: targetUid,
        leadId,
        category: 'Lead Follow-up Alert',
        titleEn: `Case Status Updated: ${lead.lead_code}`,
        titleHi: `केस स्टेटस अपडेट: ${lead.lead_code}`,
        messageEn: `${lead.lead_code} moved from ${lead.status} to ${status} (by ${user.fullName}).`,
        messageHi: `${lead.lead_code} की स्थिति ${lead.status} से ${status} हो गई है (${user.fullName})।`,
      });
    }

    logAudit(user, 'CASE_STATUS_UPDATED', 'LEAD', lead.lead_code, `${lead.status} -> ${status}${cleanLostReason ? ` (${cleanLostReason})` : ''}`);
    res.json({
      ok: true,
      rewardEval,
      wrongLeadPenaltyApplied,
    });
  });

  // Seniority-Wise Close Approval / Re-open for Rejected Leads
  // Rule: Field Officer -> Team Leader | Team Leader -> Branch Manager | Branch Manager -> Super Admin
  router.patch(
    '/leads/:id/closure-decision',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const leadId = Number(req.params.id);
      const { decision, remarks } = req.body as {
        decision?: 'APPROVE_CLOSE' | 'REOPEN';
        remarks?: string;
      };

      if (!decision || !['APPROVE_CLOSE', 'REOPEN'].includes(decision)) {
        res.status(400).json({ error: 'Decision must be APPROVE_CLOSE or REOPEN' });
        return;
      }

      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      if (!canUserAccessLead(lead, user)) {
        res.status(403).json({ error: 'You are not authorized to review closure for this lead' });
        return;
      }
      if (lead.status !== 'Rejected') {
        res.status(400).json({ error: 'Seniority close approval applies to leads marked Rejected' });
        return;
      }

      const seniority = resolveLeadClosureSeniority(lead);
      if (user.role !== seniority.expectedApproverRole) {
        res.status(403).json({
          error: `Seniority Approval Rule: Leads rejected by ${seniority.actorRole.replace(/_/g, ' ')} can only be approved by ${seniority.expectedApproverLabel}.`,
        });
        return;
      }

      const now = nowSql();
      const nextStatus: CaseStatus = decision === 'APPROVE_CLOSE' ? 'Closed' : 'Follow-up Pending';
      const nextClosureStatus = decision === 'APPROVE_CLOSE' ? 'APPROVED' : 'REJECTED_REOPENED';
      const cleanRemarks = remarks ? String(remarks).trim() : null;

      db.prepare(`
        UPDATE leads
        SET status = ?,
            closure_status = ?,
            closure_approved_by = ?,
            closure_approved_at = ?,
            closure_remarks = ?,
            last_status_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(nextStatus, nextClosureStatus, user.id, now, cleanRemarks, now, now, leadId);

      const historyNote =
        decision === 'APPROVE_CLOSE'
          ? `Seniority Close Approved by ${user.fullName} (${user.role.replace(/_/g, ' ')})${cleanRemarks ? ` · ${cleanRemarks}` : ''}`
          : `Closure Rejected & Re-opened to Follow-up Pending by ${user.fullName}${cleanRemarks ? ` · ${cleanRemarks}` : ''}`;

      db.prepare(`
        INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(leadId, lead.status, nextStatus, user.id, historyNote, now);

      db.prepare(`UPDATE followup_reminders SET completed_at = ? WHERE lead_id = ? AND completed_at IS NULL`).run(now, leadId);

      const notifyIds = new Set<number>();
      if (lead.rejected_by && lead.rejected_by !== user.id) notifyIds.add(Number(lead.rejected_by));
      if (lead.assigned_officer_id && lead.assigned_officer_id !== user.id) notifyIds.add(Number(lead.assigned_officer_id));
      if (lead.created_by && lead.created_by !== user.id) notifyIds.add(Number(lead.created_by));
      for (const uid of notifyIds) {
        createAlert({
          userId: uid,
          leadId,
          category: 'Lead Follow-up Alert',
          titleEn:
            decision === 'APPROVE_CLOSE'
              ? `Lead Close Approved: ${lead.lead_code}`
              : `Rejected Lead Re-opened: ${lead.lead_code}`,
          titleHi:
            decision === 'APPROVE_CLOSE'
              ? `लीड क्लोज़ स्वीकृत: ${lead.lead_code}`
              : `रिजेक्ट लीड पुनः खोली गई: ${lead.lead_code}`,
          messageEn: historyNote,
          messageHi: historyNote,
        });
      }

      logAudit(
        user,
        decision === 'APPROVE_CLOSE' ? 'LEAD_CLOSURE_APPROVED' : 'LEAD_CLOSURE_REOPENED',
        'LEAD',
        lead.lead_code,
        historyNote
      );

      res.json({ ok: true, status: nextStatus, closureStatus: nextClosureStatus });
    }
  );

  // Log Missing Document Follow-up Reminder
  router.post('/leads/:id/doc-reminder', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Unauthorized' });
      return;
    }
    const leadId = Number(req.params.id);
    const { missingDocs } = req.body as { missingDocs?: string[] };
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
    if (!lead || !canUserAccessLead(lead, user)) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    const docList = Array.isArray(missingDocs) && missingDocs.length > 0 ? missingDocs.join(', ') : 'Pending KYC Documents';
    const officerId = lead.assigned_officer_id || user.id;
    const settings = getSettings();
    const dueAt = nowSql();
    const deadlineAt = nowSql(settings.followupSlaMinutes);

    db.prepare(`
      INSERT INTO followup_reminders (lead_id, assigned_officer_id, created_by, note, due_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(leadId, officerId, user.id, `Collect missing KYC: ${docList}`, dueAt, deadlineAt);

    db.prepare(`
      INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks)
      VALUES (?, ?, ?, ?, ?)
    `).run(leadId, lead.status, lead.status, user.id, `Missing-document reminder logged for: ${docList}`);

    logAudit(user, 'DOC_REMINDER_LOGGED', 'LEAD', lead.lead_code, `Missing docs: ${docList}`);
    res.json({ ok: true });
  });

  // Schedule Follow-up Reminder (starts 10-min follow-up SLA timer once due)
  router.post('/leads/:id/reminders', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Referral partners cannot schedule internal follow-up reminders' });
      return;
    }

    const leadId = Number(req.params.id);
    const { note, dueInMinutes } = req.body as { note?: string; dueInMinutes?: number };
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
    if (!lead || !canUserAccessLead(lead, user)) {
      res.status(404).json({ error: 'Lead not found or unauthorized' });
      return;
    }

    const officerId = lead.assigned_officer_id || user.id;
    const settings = getSettings();
    const mins = Math.max(0, Number(dueInMinutes ?? 0));
    const dueAt = nowSql(mins);
    const deadlineAt = nowSql(mins + settings.followupSlaMinutes);

    db.prepare(`
      INSERT INTO followup_reminders (lead_id, assigned_officer_id, created_by, note, due_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(leadId, officerId, user.id, note || 'Scheduled customer follow-up', dueAt, deadlineAt);

    processSlaTimers();
    logAudit(user, 'FOLLOWUP_REMINDER_CREATED', 'LEAD', lead.lead_code, `Follow-up scheduled at ${dueAt} (SLA deadline ${deadlineAt})`);
    res.status(201).json({ ok: true, dueAt, deadlineAt });
  });

  // Document Upload & Secure Retrieval (Blocked for Referral Partners)
  router.post('/leads/:id/documents', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Referral partners cannot upload or access KYC documents' });
      return;
    }
    const leadId = Number(req.params.id);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
    if (!lead || !canUserAccessLead(lead, user)) {
      res.status(404).json({ error: 'Lead not found or unauthorized' });
      return;
    }

    const { category, fileName, mimeType, dataBase64 } = req.body as {
      category?: string;
      fileName?: string;
      mimeType?: string;
      dataBase64?: string;
    };
    if (!category || !fileName || !dataBase64) {
      res.status(400).json({ error: 'Category, file name, and file data are required' });
      return;
    }

    const cleanBase64 = dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64;
    const buffer = Buffer.from(cleanBase64, 'base64');
    if (buffer.length > 8 * 1024 * 1024) {
      res.status(400).json({ error: 'Maximum file size is 8 MB' });
      return;
    }

    const safeName = `${lead.lead_code}-${Date.now()}-${path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const fullPath = path.join(UPLOADS_PATH, safeName);
    fs.writeFileSync(fullPath, buffer);

    const inserted = db
      .prepare(`
        INSERT INTO documents (lead_id, category, file_name, mime_type, file_size, storage_path, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(leadId, category, fileName, mimeType || 'application/octet-stream', buffer.length, safeName, user.id);

    const rewardEval = evaluateAndAwardLeadRewards(leadId, user.id, false);
    logAudit(user, 'DOCUMENT_UPLOADED', 'DOCUMENT', inserted.lastInsertRowid as number, `Uploaded ${category} (${fileName}) for ${lead.lead_code}`);
    res.status(201).json({ ok: true, documentId: inserted.lastInsertRowid, rewardEval });
  });

  router.get('/documents/:docId/file', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Confidential KYC documents are strictly hidden from Referral Partners' });
      return;
    }
    const doc = db
      .prepare(`SELECT d.*, l.branch_id, l.assigned_bm_id, l.assigned_tl_id, l.assigned_officer_id, l.created_by, l.referral_id FROM documents d JOIN leads l ON l.id = d.lead_id WHERE d.id = ?`)
      .get(Number(req.params.docId)) as any;

    if (!doc) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    if (!canUserAccessLead(doc, user)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const fullPath = path.join(UPLOADS_PATH, doc.storage_path);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ error: 'Stored file missing' });
      return;
    }
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${doc.file_name}"`);
    fs.createReadStream(fullPath).pipe(res);
  });

  // ============================================================================
  // LEAD FOLLOW-UP CALL RECORDINGS (FO / Lead Gen record; ONLY Admin plays/shares; 7-day auto-delete)
  // ============================================================================
  const streamAudioResponse = (
    req: Request,
    res: Response,
    fullPath: string,
    mimeType: string,
    fileName: string,
    forceDownload: boolean
  ) => {
    const stat = fs.statSync(fullPath);
    const total = stat.size;
    const disposition = forceDownload ? 'attachment' : 'inline';
    res.setHeader('Content-Type', mimeType || 'audio/webm');
    res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=300');

    const range = req.headers.range;
    if (range && !forceDownload) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = Math.max(0, parseInt(parts[0] || '0', 10));
      const end = parts[1] ? Math.min(total - 1, parseInt(parts[1], 10)) : total - 1;
      if (start >= total || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      fs.createReadStream(fullPath, { start, end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', String(total));
    fs.createReadStream(fullPath).pipe(res);
  };

  // Admin-only list of all active (non-expired) follow-up call recordings across leads
  router.get('/followup-recordings', requireAuth, requireRoles('SUPER_ADMIN'), (_req, res) => {
    purgeExpiredFollowupRecordings();
    const rows = db
      .prepare(`
        SELECT fr.id, fr.recording_code as recordingCode, fr.lead_id as leadId,
          l.lead_code as leadCode, l.customer_name as customerName,
          fr.recorded_by as recordedBy, u.full_name as recordedByName, u.employee_code as recordedByCode,
          fr.recorded_by_role as recordedByRole, fr.call_notes as callNotes,
          fr.duration_seconds as durationSeconds, fr.file_name as fileName,
          fr.mime_type as mimeType, fr.file_size as fileSize,
          fr.share_token as shareToken, fr.created_at as createdAt, fr.expires_at as expiresAt
        FROM followup_recordings fr
        JOIN leads l ON l.id = fr.lead_id
        JOIN users u ON u.id = fr.recorded_by
        WHERE fr.expires_at > datetime('now')
        ORDER BY fr.created_at DESC, fr.id DESC
        LIMIT 100
      `)
      .all()
      .map((r: any) => ({
        ...r,
        id: Number(r.id),
        leadId: Number(r.leadId),
        recordedBy: Number(r.recordedBy),
        durationSeconds: Number(r.durationSeconds || 0),
        fileSize: Number(r.fileSize || 0),
        canPlayOrShare: true,
        hasShareLink: Boolean(r.shareToken),
        shareToken: r.shareToken ?? null,
      }));
    res.json({ recordings: rows });
  });

  // Upload / Save Follow-up Call Audio Recording (Field Officer, Lead Generation Team, Managers/Admin)
  router.post(
    '/leads/:id/followup-recordings',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER', 'LEAD_GENERATOR', 'FIELD_OFFICER'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const leadId = Number(req.params.id);
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as any;
      if (!lead || !canUserAccessLead(lead, user)) {
        res.status(404).json({ error: 'Lead not found or unauthorized' });
        return;
      }

      const { fileName, mimeType, dataBase64, durationSeconds, callNotes } = req.body as {
        fileName?: string;
        mimeType?: string;
        dataBase64?: string;
        durationSeconds?: number;
        callNotes?: string;
      };

      if (!dataBase64) {
        res.status(400).json({ error: 'Audio recording data is required' });
        return;
      }

      const cleanBase64 = dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64;
      const buffer = Buffer.from(cleanBase64, 'base64');
      if (buffer.length === 0) {
        res.status(400).json({ error: 'Empty audio recording cannot be saved' });
        return;
      }
      if (buffer.length > 12 * 1024 * 1024) {
        res.status(400).json({ error: 'Maximum audio recording size is 12 MB' });
        return;
      }

      purgeExpiredFollowupRecordings();

      const recCode = `REC-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
      const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
      const extFromMime =
        cleanMime.includes('mp4') || cleanMime.includes('m4a')
          ? 'm4a'
          : cleanMime.includes('mpeg') || cleanMime.includes('mp3')
            ? 'mp3'
            : cleanMime.includes('wav')
              ? 'wav'
              : cleanMime.includes('ogg')
                ? 'ogg'
                : 'webm';
      const baseFileName = fileName
        ? path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')
        : `${lead.lead_code}-followup-${Date.now()}.${extFromMime}`;
      const storageName = `${recCode}-${baseFileName}`;
      const fullPath = path.join(UPLOADS_PATH, storageName);
      fs.writeFileSync(fullPath, buffer);

      const safeDuration = Math.max(0, Math.round(Number(durationSeconds || 0)));
      const cleanNotes = callNotes ? String(callNotes).trim() : null;
      const createdAt = nowSql();
      const expiresAt = nowSql(7 * 24 * 60); // Exactly 1 week (7 days) retention

      const inserted = db
        .prepare(`
          INSERT INTO followup_recordings (
            recording_code, lead_id, recorded_by, recorded_by_role, call_notes,
            duration_seconds, file_name, mime_type, file_size, storage_path, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          recCode,
          leadId,
          user.id,
          user.role,
          cleanNotes,
          safeDuration,
          baseFileName,
          cleanMime,
          buffer.length,
          storageName,
          createdAt,
          expiresAt
        );

      const mm = String(Math.floor(safeDuration / 60)).padStart(2, '0');
      const ss = String(safeDuration % 60).padStart(2, '0');
      const historyNote = `Follow-up call recording logged (${mm}:${ss})${cleanNotes ? ` · ${cleanNotes}` : ''} [Admin playback only · Auto-deletes in 7 days]`;

      db.prepare(`
        INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks)
        VALUES (?, ?, ?, ?, ?)
      `).run(leadId, lead.status, lead.status, user.id, historyNote);

      // Mark SLA reminder completion / penalty timestamp if logged by assigned user
      db.prepare(`UPDATE followup_reminders SET completed_at = ? WHERE lead_id = ? AND completed_at IS NULL`).run(
        createdAt,
        leadId
      );

      // Notify Super Admin(s) that a new customer follow-up recording is available to listen/share
      for (const adminId of getSuperAdminIds()) {
        if (adminId !== user.id) {
          createAlert({
            userId: adminId,
            leadId,
            category: 'Lead Follow-up Alert',
            titleEn: `Follow-up Call Recorded (${lead.lead_code})`,
            titleHi: `फॉलो-अप कॉल रिकॉर्डिंग (${lead.lead_code})`,
            messageEn: `${user.fullName} (${user.role.replace('_', ' ')}) logged a ${mm}:${ss} customer call recording on ${lead.lead_code}. Only Admin can listen/share (auto-deletes in 7 days).`,
            messageHi: `${user.fullName} ने ${lead.lead_code} पर ग्राहक बातचीत रिकॉर्डिंग (${mm}:${ss}) सेव की है। केवल एडमिन सुन/शेयर कर सकते हैं (7 दिन में ऑटो डिलीट)।`,
          });
        }
      }

      logAudit(
        user,
        'FOLLOWUP_RECORDING_SAVED',
        'RECORDING',
        recCode,
        `Saved ${mm}:${ss} follow-up recording (${baseFileName}) on ${lead.lead_code}; expires ${expiresAt}`
      );

      res.status(201).json({
        ok: true,
        recording: {
          id: Number(inserted.lastInsertRowid),
          recordingCode: recCode,
          leadId,
          recordedBy: user.id,
          recordedByName: user.fullName,
          recordedByCode: user.employeeCode,
          recordedByRole: user.role,
          callNotes: cleanNotes,
          durationSeconds: safeDuration,
          fileName: baseFileName,
          mimeType: cleanMime,
          fileSize: buffer.length,
          canPlayOrShare: user.role === 'SUPER_ADMIN',
          hasShareLink: false,
          shareToken: null,
          createdAt,
          expiresAt,
        },
      });
    }
  );

  // Strictly Admin-Only Audio Playback & Download
  router.get('/followup-recordings/:recId/audio', requireAuth, requireRoles('SUPER_ADMIN'), (req, res) => {
    purgeExpiredFollowupRecordings();
    const recId = Number(req.params.recId);
    const rec = db
      .prepare(`SELECT * FROM followup_recordings WHERE id = ? AND expires_at > datetime('now')`)
      .get(recId) as any;

    if (!rec) {
      res.status(404).json({ error: 'Follow-up recording not found or expired after 7-day retention' });
      return;
    }

    const fullPath = path.join(UPLOADS_PATH, rec.storage_path);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ error: 'Recording audio file missing from storage' });
      return;
    }

    const forceDownload = req.query.download === '1';
    streamAudioResponse(req, res, fullPath, rec.mime_type, rec.file_name, forceDownload);
  });

  // Strictly Admin-Only Share Link Generation
  router.post('/followup-recordings/:recId/share', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    purgeExpiredFollowupRecordings();
    const recId = Number(req.params.recId);
    const { regenerate } = (req.body || {}) as { regenerate?: boolean };
    const rec = db
      .prepare(`
        SELECT fr.*, l.lead_code
        FROM followup_recordings fr
        JOIN leads l ON l.id = fr.lead_id
        WHERE fr.id = ? AND fr.expires_at > datetime('now')
      `)
      .get(recId) as any;

    if (!rec) {
      res.status(404).json({ error: 'Follow-up recording not found or expired after 7-day retention' });
      return;
    }

    let token = rec.share_token as string | null;
    if (!token || regenerate) {
      token = crypto.randomBytes(18).toString('base64url');
      db.prepare(`UPDATE followup_recordings SET share_token = ?, share_created_at = ? WHERE id = ?`).run(
        token,
        nowSql(),
        recId
      );
      logAudit(
        req.user!,
        'FOLLOWUP_RECORDING_SHARE_CREATED',
        'RECORDING',
        rec.recording_code,
        `Admin generated share link for follow-up recording ${rec.recording_code} (${rec.lead_code})`
      );
    }

    res.json({
      shareToken: token,
      sharePath: `/api/public/recordings/${token}`,
      expiresAt: rec.expires_at,
    });
  });

  // Strictly Admin-Only Revoke Share Link
  router.delete('/followup-recordings/:recId/share', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const recId = Number(req.params.recId);
    const rec = db.prepare(`SELECT recording_code FROM followup_recordings WHERE id = ?`).get(recId) as any;
    if (!rec) {
      res.status(404).json({ error: 'Recording not found' });
      return;
    }
    db.prepare(`UPDATE followup_recordings SET share_token = NULL, share_created_at = NULL WHERE id = ?`).run(recId);
    logAudit(req.user!, 'FOLLOWUP_RECORDING_SHARE_REVOKED', 'RECORDING', rec.recording_code, `Revoked share link`);
    res.json({ ok: true });
  });

  // Public Expiring Share Playback / Download Endpoint (auto-expires when 7-day recording deletes)
  router.get('/public/recordings/:shareToken', (req, res) => {
    purgeExpiredFollowupRecordings();
    const token = String(req.params.shareToken || '').trim();
    if (!token) {
      res.status(400).json({ error: 'Invalid recording share link' });
      return;
    }

    const rec = db
      .prepare(`SELECT * FROM followup_recordings WHERE share_token = ? AND expires_at > datetime('now')`)
      .get(token) as any;

    if (!rec) {
      res.status(404).send('Recording link has expired or was automatically deleted after 7 days.');
      return;
    }

    const fullPath = path.join(UPLOADS_PATH, rec.storage_path);
    if (!fs.existsSync(fullPath)) {
      res.status(404).send('Recording file is no longer available.');
      return;
    }

    const forceDownload = req.query.download === '1';
    streamAudioResponse(req, res, fullPath, rec.mime_type, rec.file_name, forceDownload);
  });

  // Duplicate Verification & Approval (Super Admin)
  router.get('/duplicates', requireAuth, requireRoles('SUPER_ADMIN'), (_req, res) => {
    const rows = db
      .prepare(`
        SELECT dr.*, l.lead_code as existing_lead_code, l.customer_name as existing_customer_name,
          sub.full_name as submitted_by_name, rev.full_name as reviewed_by_name
        FROM duplicate_requests dr
        JOIN leads l ON l.id = dr.existing_lead_id
        JOIN users sub ON sub.id = dr.submitted_by
        LEFT JOIN users rev ON rev.id = dr.reviewed_by
        ORDER BY CASE WHEN dr.status = 'PENDING' THEN 0 ELSE 1 END, dr.created_at DESC
      `)
      .all() as any[];

    const requests = rows.map((r) => ({
      id: r.id,
      requestCode: r.request_code,
      existingLeadId: r.existing_lead_id,
      existingLeadCode: r.existing_lead_code,
      existingCustomerName: r.existing_customer_name,
      matchedFields: JSON.parse(r.matched_fields_json || '[]'),
      submittedPayload: JSON.parse(r.submitted_payload_json || '{}'),
      submittedBy: r.submitted_by,
      submittedByName: r.submitted_by_name,
      status: r.status,
      reviewedBy: r.reviewed_by,
      reviewedByName: r.reviewed_by_name ?? null,
      reviewRemarks: r.review_remarks ?? null,
      reviewedAt: r.reviewed_at ?? null,
      createdLeadId: r.created_lead_id ?? null,
      createdAt: r.created_at,
    }));

    res.json({ requests });
  });

  router.post('/duplicates/:id/approve', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const reqId = Number(req.params.id);
    const { remarks, assignedOfficerId } = req.body as { remarks?: string; assignedOfficerId?: number };

    const dr = db.prepare('SELECT * FROM duplicate_requests WHERE id = ?').get(reqId) as any;
    if (!dr || dr.status !== 'PENDING') {
      res.status(404).json({ error: 'Pending duplicate request not found' });
      return;
    }

    const p = JSON.parse(dr.submitted_payload_json);
    const leadCode = generateLeadCode();
    const settings = getSettings();
    const officerId = assignedOfficerId ? Number(assignedOfficerId) : null;
    const now = nowSql();
    const deadline = officerId ? nowSql(settings.assignmentSlaMinutes) : null;
    const status: CaseStatus = officerId ? 'Lead Assigned' : 'Lead Generated';

    const insertLead = db
      .prepare(`
        INSERT INTO leads (
          lead_code, customer_name, customer_name_norm, customer_mobile_enc, customer_mobile_hash,
          alternate_mobile_enc, pan_enc, pan_hash, dob, address_enc, city, state, pin_code,
          loan_product, loan_amount, employment_details, monthly_income, bank_nbfc,
          referral_id, referral_name, created_by, assigned_officer_id, assigned_at,
          assignment_deadline_at, branch_id, status, last_status_at, remarks, customer_consent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `)
      .run(
        leadCode,
        p.customerName,
        String(p.customerName || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
        encryptPii(p.customerMobile),
        hashLookup(p.customerMobile),
        encryptPii(p.alternateMobile || null),
        encryptPii(p.panNumber || null),
        p.panNumber ? hashLookup(p.panNumber) : null,
        p.dob || null,
        encryptPii(p.address || null),
        p.city || null,
        p.state || null,
        p.pinCode || null,
        p.loanProduct || 'Personal Loan',
        Number(p.loanAmount || 0),
        p.employmentDetails || null,
        p.monthlyIncome ? Number(p.monthlyIncome) : null,
        p.bankNbfc || 'HDFC Bank',
        p.referralId || null,
        p.referralName || null,
        dr.submitted_by,
        officerId,
        officerId ? now : null,
        deadline,
        1,
        status,
        now,
        p.remarks || null
      );

    const newLeadId = insertLead.lastInsertRowid as number;
    db.prepare(`
      INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks)
      VALUES (?, NULL, ?, ?, ?)
    `).run(newLeadId, status, admin.id, `Approved from duplicate request ${dr.request_code}. ${remarks || ''}`);

    db.prepare(`
      UPDATE duplicate_requests
      SET status = 'APPROVED', reviewed_by = ?, review_remarks = ?, reviewed_at = ?, created_lead_id = ?
      WHERE id = ?
    `).run(admin.id, remarks || 'Approved by Super Admin', now, newLeadId, reqId);

    createAlert({
      userId: dr.submitted_by,
      leadId: newLeadId,
      category: 'Duplicate Lead Verification Alert',
      titleEn: `Duplicate Request ${dr.request_code} Approved`,
      titleHi: `डुप्लिकेट अनुरोध ${dr.request_code} स्वीकृत`,
      messageEn: `Admin approved ${dr.request_code}. New Lead ID ${leadCode} created.`,
      messageHi: `एडमिन ने ${dr.request_code} को स्वीकृत किया। नई लीड ${leadCode} बनाई गई।`,
    });

    if (officerId) {
      createAlert({
        userId: officerId,
        leadId: newLeadId,
        category: 'Lead Follow-up Alert',
        titleEn: `New Lead Assigned: ${leadCode}`,
        titleHi: `नई लीड सौंपी गई: ${leadCode}`,
        messageEn: `Update ${leadCode} within ${settings.assignmentSlaMinutes} minutes.`,
        messageHi: `${settings.assignmentSlaMinutes} मिनट में ${leadCode} अपडेट करें।`,
      });
    }

    logAudit(admin, 'DUPLICATE_APPROVED', 'DUPLICATE_REQUEST', dr.request_code, `Approved ${dr.request_code} -> Created ${leadCode}`);
    res.json({ ok: true, leadCode, leadId: newLeadId });
  });

  router.post('/duplicates/:id/reject', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const reqId = Number(req.params.id);
    const { remarks } = req.body as { remarks?: string };
    const dr = db.prepare('SELECT * FROM duplicate_requests WHERE id = ?').get(reqId) as any;
    if (!dr || dr.status !== 'PENDING') {
      res.status(404).json({ error: 'Pending duplicate request not found' });
      return;
    }

    const now = nowSql();
    db.prepare(`
      UPDATE duplicate_requests
      SET status = 'REJECTED', reviewed_by = ?, review_remarks = ?, reviewed_at = ?
      WHERE id = ?
    `).run(admin.id, remarks || 'Duplicate rejected by Admin', now, reqId);

    createAlert({
      userId: dr.submitted_by,
      leadId: dr.existing_lead_id,
      category: 'Duplicate Lead Verification Alert',
      titleEn: `Duplicate Request ${dr.request_code} Rejected`,
      titleHi: `डुप्लिकेट अनुरोध ${dr.request_code} अस्वीकृत`,
      messageEn: `Admin rejected ${dr.request_code}. Remarks: ${remarks || 'Existing lead already active.'}`,
      messageHi: `एडमिन ने ${dr.request_code} को अस्वीकृत किया। टिप्पणी: ${remarks || 'लीड पहले से सक्रिय है।'}`,
    });

    logAudit(admin, 'DUPLICATE_REJECTED', 'DUPLICATE_REQUEST', dr.request_code, `Rejected ${dr.request_code}: ${remarks || ''}`);
    res.json({ ok: true });
  });

  // Penalties Register & Admin Decision
  router.get('/penalties', requireAuth, (req: AuthedRequest, res) => {
    processSlaTimers();
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Referral partners do not have access to internal penalty registers' });
      return;
    }

    const isOwnOnly = user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR';
    const whereClause = isOwnOnly ? 'WHERE p.employee_id = ?' : '';
    const params = isOwnOnly ? [user.id] : [];

    const penalties = db
      .prepare(`
        SELECT p.id, p.penalty_code as penaltyCode, p.employee_id as employeeId,
          emp.full_name as employeeName, emp.employee_code as employeeCode,
          p.lead_id as leadId, l.lead_code as leadCode,
          p.enquiry_id as enquiryId, e.enquiry_code as enquiryCode,
          p.penalty_type as penaltyType, p.event_at as eventAt, p.deadline_at as deadlineAt,
          p.actual_update_at as actualUpdateAt, p.delay_seconds as delaySeconds,
          p.amount, p.approval_status as approvalStatus,
          p.reviewed_by as reviewedBy, rev.full_name as reviewedByName,
          p.review_remarks as reviewRemarks, p.reviewed_at as reviewedAt, p.created_at as createdAt
        FROM penalties p
        JOIN users emp ON emp.id = p.employee_id
        LEFT JOIN leads l ON l.id = p.lead_id
        LEFT JOIN enquiries e ON e.id = p.enquiry_id
        LEFT JOIN users rev ON rev.id = p.reviewed_by
        ${whereClause}
        ORDER BY CASE WHEN p.approval_status = 'PENDING' THEN 0 ELSE 1 END, p.created_at DESC
      `)
      .all(...params);

    res.json({ penalties });
  });

  router.patch('/penalties/:id/decision', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const id = Number(req.params.id);
    const { decision, remarks } = req.body as { decision?: 'APPROVED' | 'REJECTED'; remarks?: string };
    if (!decision || !['APPROVED', 'REJECTED'].includes(decision)) {
      res.status(400).json({ error: 'Decision must be APPROVED or REJECTED' });
      return;
    }

    const pen = db.prepare('SELECT * FROM penalties WHERE id = ?').get(id) as any;
    if (!pen) {
      res.status(404).json({ error: 'Penalty record not found' });
      return;
    }

    const now = nowSql();
    db.prepare(`
      UPDATE penalties SET approval_status = ?, reviewed_by = ?, review_remarks = ?, reviewed_at = ? WHERE id = ?
    `).run(decision, admin.id, remarks || null, now, id);

    createAlert({
      userId: pen.employee_id,
      leadId: pen.lead_id,
      enquiryId: pen.enquiry_id,
      category: '₹10 Penalty Alert',
      titleEn: `Penalty ${pen.penalty_code} ${decision}`,
      titleHi: `पेनल्टी ${pen.penalty_code} ${decision === 'APPROVED' ? 'स्वीकृत' : 'अस्वीकृत'}`,
      messageEn: `Admin marked ₹${pen.amount} penalty ${pen.penalty_code} as ${decision}.${remarks ? ' Note: ' + remarks : ''}`,
      messageHi: `एडमिन ने ₹${pen.amount} पेनल्टी ${pen.penalty_code} को ${decision} किया।`,
    });

    logAudit(admin, `PENALTY_${decision}`, 'PENALTY', pen.penalty_code, `Penalty ${pen.penalty_code} marked ${decision}`);
    res.json({ ok: true });
  });

  // Referral Enquiry / Help Desk with 1-Hour SLA
  router.get('/enquiries', requireAuth, (req: AuthedRequest, res) => {
    processSlaTimers();
    const user = req.user!;
    let where = '1 = 1';
    const params: unknown[] = [];

    if (user.role === 'REFERRAL_PARTNER') {
      where = 'e.referral_user_id = ?';
      params.push(user.id);
    } else if (user.role === 'FIELD_OFFICER') {
      where = 'e.assigned_officer_id = ?';
      params.push(user.id);
    }

    const enquiries = db
      .prepare(`
        SELECT e.id, e.enquiry_code as enquiryCode, e.lead_id as leadId, l.lead_code as leadCode,
          e.referral_user_id as referralUserId, e.referral_code as referralCode, ref.full_name as referralName,
          e.category, e.description, e.assigned_officer_id as assignedOfficerId,
          fo.full_name as assignedOfficerName, fo.mobile as assignedOfficerMobile,
          e.status, e.solution_text as solutionText, e.solution_updated_at as solutionUpdatedAt,
          e.sla_deadline_at as slaDeadlineAt, e.penalty_generated as penaltyGenerated,
          e.created_at as createdAt, e.updated_at as updatedAt
        FROM enquiries e
        LEFT JOIN leads l ON l.id = e.lead_id
        JOIN users ref ON ref.id = e.referral_user_id
        LEFT JOIN users fo ON fo.id = e.assigned_officer_id
        WHERE ${where}
        ORDER BY e.created_at DESC
      `)
      .all(...params);

    res.json({ enquiries });
  });

  router.post('/enquiries', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const { leadId, category, description } = req.body as {
      leadId?: number;
      category?: string;
      description?: string;
    };
    if (!category || !description?.trim()) {
      res.status(400).json({ error: 'Enquiry category and description are required' });
      return;
    }

    let lead: any = null;
    if (leadId) {
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId));
      if (!lead || !canUserAccessLead(lead, user)) {
        res.status(403).json({ error: 'Cannot create enquiry for an unauthorized lead' });
        return;
      }
    }

    const settings = getSettings();
    const enqCode = `ENQ-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const assignedOfficerId = lead?.assigned_officer_id ?? null;
    const status = assignedOfficerId ? 'Assigned' : 'New';
    const slaDeadline = nowSql(settings.enquirySlaMinutes);

    const inserted = db
      .prepare(`
        INSERT INTO enquiries (enquiry_code, lead_id, referral_user_id, referral_code, category, description, assigned_officer_id, status, sla_deadline_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        enqCode,
        lead?.id ?? null,
        user.id,
        user.referralCode ?? user.employeeCode,
        category,
        description.trim(),
        assignedOfficerId,
        status,
        slaDeadline
      );

    const enqId = inserted.lastInsertRowid as number;
    if (assignedOfficerId) {
      createAlert({
        userId: assignedOfficerId,
        leadId: lead?.id ?? null,
        enquiryId: enqId,
        category: 'Complaint / Enquiry Alert',
        titleEn: `New Enquiry ${enqCode} (1-Hr SLA)`,
        titleHi: `नई पूछताछ ${enqCode} (1-घंटे SLA)`,
        messageEn: `${user.fullName} raised an enquiry (${category}). Respond within 1 hour to avoid ₹10 penalty.`,
        messageHi: `${user.fullName} ने पूछताछ (${category}) दर्ज की। ₹10 पेनल्टी से बचने के लिए 1 घंटे में उत्तर दें।`,
      });
    }
    for (const admId of getSuperAdminIds()) {
      createAlert({
        userId: admId,
        leadId: lead?.id ?? null,
        enquiryId: enqId,
        category: 'Complaint / Enquiry Alert',
        titleEn: `Enquiry Created: ${enqCode}`,
        titleHi: `पूछताछ दर्ज: ${enqCode}`,
        messageEn: `${user.fullName} created enquiry ${enqCode} (${category}).`,
        messageHi: `${user.fullName} ने पूछताछ ${enqCode} (${category}) दर्ज की।`,
      });
    }

    logAudit(user, 'ENQUIRY_CREATED', 'ENQUIRY', enqCode, `Created enquiry ${enqCode} (${category})`);
    res.status(201).json({ ok: true, enquiryCode: enqCode });
  });

  router.patch('/enquiries/:id/respond', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Referral partners cannot post internal solutions' });
      return;
    }

    const id = Number(req.params.id);
    const { solutionText, status, assignedOfficerId } = req.body as {
      solutionText?: string;
      status?: string;
      assignedOfficerId?: number;
    };

    const enq = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id) as any;
    if (!enq) {
      res.status(404).json({ error: 'Enquiry not found' });
      return;
    }
    if (user.role === 'FIELD_OFFICER' && enq.assigned_officer_id !== user.id) {
      res.status(403).json({ error: 'You are only permitted to respond to your assigned enquiries' });
      return;
    }

    const now = nowSql();
    const nextStatus = status && ENQUIRY_STATUSES.includes(status as any) ? status : solutionText ? 'Solution Updated' : enq.status;
    const officerId = assignedOfficerId ?? enq.assigned_officer_id;

    db.prepare(`
      UPDATE enquiries
      SET solution_text = COALESCE(?, solution_text),
          solution_updated_at = CASE WHEN ? IS NOT NULL THEN ? ELSE solution_updated_at END,
          status = ?,
          assigned_officer_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(solutionText?.trim() || null, solutionText?.trim() || null, now, nextStatus, officerId, now, id);

    createAlert({
      userId: enq.referral_user_id,
      leadId: enq.lead_id,
      enquiryId: enq.id,
      category: 'Complaint / Enquiry Alert',
      titleEn: `Enquiry ${enq.enquiry_code} Updated`,
      titleHi: `पूछताछ ${enq.enquiry_code} अपडेट`,
      messageEn: `Status: ${nextStatus}.${solutionText ? ' Solution provided.' : ''}`,
      messageHi: `स्थिति: ${nextStatus}।${solutionText ? ' समाधान अपडेट किया गया।' : ''}`,
    });

    logAudit(user, 'ENQUIRY_UPDATED', 'ENQUIRY', enq.enquiry_code, `Status set to ${nextStatus}`);
    res.json({ ok: true });
  });

  // GPS Location & Field Visits
  router.get('/gps', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'GPS records are restricted to field staff and management' });
      return;
    }
    const isOwnGps = user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR';
    const requestedEmpId = req.query.employeeId ? Number(req.query.employeeId) : null;
    const clauses: string[] = [];
    const params: any[] = [];

    if (isOwnGps) {
      clauses.push('g.employee_id = ?');
      params.push(user.id);
    } else if (requestedEmpId && Number.isFinite(requestedEmpId)) {
      clauses.push('g.employee_id = ?');
      params.push(requestedEmpId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const logs = db
      .prepare(`
        SELECT g.id, g.employee_id as employeeId, u.full_name as employeeName, u.employee_code as employeeCode,
          g.latitude, g.longitude, g.accuracy, g.activity_type as activityType,
          g.lead_id as leadId, l.lead_code as leadCode, g.customer_name as customerName,
          g.visit_notes as visitNotes, g.consent_confirmed as consentConfirmed, g.recorded_at as recordedAt
        FROM gps_logs g
        JOIN users u ON u.id = g.employee_id
        LEFT JOIN leads l ON l.id = g.lead_id
        ${where}
        ORDER BY g.recorded_at DESC
        LIMIT 500
      `)
      .all(...params);

    res.json({ logs });
  });

  router.post('/gps', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'GPS tracking is for employees only' });
      return;
    }
    const { latitude, longitude, accuracy, activityType, leadId, customerName, visitNotes, consentConfirmed } =
      req.body as Record<string, any>;

    if (!consentConfirmed && !user.gpsConsent) {
      res.status(400).json({ error: 'Employee GPS consent is required before recording location' });
      return;
    }
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      res.status(400).json({ error: 'Valid latitude and longitude coordinates are required' });
      return;
    }

    if (consentConfirmed && !user.gpsConsent) {
      db.prepare('UPDATE users SET gps_consent = 1 WHERE id = ?').run(user.id);
    }

    db.prepare(`
      INSERT INTO gps_logs (employee_id, latitude, longitude, accuracy, activity_type, lead_id, customer_name, visit_notes, consent_confirmed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      user.id,
      latitude,
      longitude,
      accuracy ? Number(accuracy) : null,
      activityType || 'TRACKING_PING',
      leadId ? Number(leadId) : null,
      customerName || null,
      visitNotes || null
    );

    if (activityType === 'VISIT_CHECKIN' || activityType === 'TRACKING_START') {
      for (const admId of getSuperAdminIds()) {
        createAlert({
          userId: admId,
          leadId: leadId ? Number(leadId) : null,
          category: 'Field Officer GPS Location Alert',
          titleEn: `${user.fullName}: ${activityType === 'VISIT_CHECKIN' ? 'Customer Visit Check-In' : 'GPS Shift Started'}`,
          titleHi: `${user.fullName}: ${activityType === 'VISIT_CHECKIN' ? 'ग्राहक विजिट चेक-इन' : 'GPS शिफ्ट शुरू'}`,
          messageEn: `${user.fullName} recorded ${activityType} at (${latitude.toFixed(4)}, ${longitude.toFixed(4)})${customerName ? ' — ' + customerName : ''}.`,
          messageHi: `${user.fullName} ने (${latitude.toFixed(4)}, ${longitude.toFixed(4)}) पर लोकेशन दर्ज की।`,
        });
      }
    }

    logAudit(user, `GPS_${activityType || 'PING'}`, 'GPS', user.employeeCode, `Lat ${latitude.toFixed(5)}, Lng ${longitude.toFixed(5)}`);
    res.status(201).json({ ok: true });
  });

  // Seniority-wise Bike Run Approver Helpers:
  // Field Officer -> Team Leader | Team Leader -> Branch Manager | Branch Manager / Staff -> Super Admin
  const getExpectedBikeApproverRole = (
    employeeRole: string
  ): 'TEAM_LEADER' | 'BRANCH_MANAGER' | 'SUPER_ADMIN' => {
    if (employeeRole === 'FIELD_OFFICER') return 'TEAM_LEADER';
    if (employeeRole === 'TEAM_LEADER') return 'BRANCH_MANAGER';
    return 'SUPER_ADMIN';
  };

  const getExpectedApproverRoleLabel = (role: 'TEAM_LEADER' | 'BRANCH_MANAGER' | 'SUPER_ADMIN') => {
    if (role === 'TEAM_LEADER') return 'Team Leader';
    if (role === 'BRANCH_MANAGER') return 'Branch Manager';
    return 'Super Admin';
  };

  const canUserReviewBikeRun = (
    reviewer: { id: number; role: string; branchId: number | null; teamId: number | null },
    employee: {
      id: number;
      role: string;
      branchId: number | null;
      teamId: number | null;
      reportsToUserId: number | null;
    }
  ): boolean => {
    if (reviewer.id === employee.id) return false;
    const expectedRole = getExpectedBikeApproverRole(employee.role);
    if (reviewer.role !== expectedRole) return false;
    if (expectedRole === 'SUPER_ADMIN') return true;
    if (expectedRole === 'TEAM_LEADER') {
      if (employee.reportsToUserId) return employee.reportsToUserId === reviewer.id;
      if (employee.teamId && reviewer.teamId) return employee.teamId === reviewer.teamId;
      return Boolean(employee.branchId && reviewer.branchId && employee.branchId === reviewer.branchId);
    }
    // expectedRole === 'BRANCH_MANAGER'
    if (employee.reportsToUserId) return employee.reportsToUserId === reviewer.id;
    return Boolean(employee.branchId && reviewer.branchId && employee.branchId === reviewer.branchId);
  };

  const resolveExpectedApproverUsers = (employee: {
    id: number;
    role: string;
    branchId: number | null;
    teamId: number | null;
    reportsToUserId: number | null;
  }): { id: number; fullName: string; employeeCode: string }[] => {
    const expectedRole = getExpectedBikeApproverRole(employee.role);
    if (expectedRole === 'SUPER_ADMIN') {
      return db
        .prepare(`SELECT id, full_name as fullName, employee_code as employeeCode FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1`)
        .all() as any[];
    }
    if (employee.reportsToUserId) {
      const direct = db
        .prepare(`SELECT id, full_name as fullName, employee_code as employeeCode FROM users WHERE id = ? AND role = ? AND is_active = 1`)
        .get(employee.reportsToUserId, expectedRole) as any;
      if (direct) return [direct];
    }
    if (expectedRole === 'TEAM_LEADER' && employee.teamId) {
      const byTeam = db
        .prepare(`SELECT id, full_name as fullName, employee_code as employeeCode FROM users WHERE team_id = ? AND role = 'TEAM_LEADER' AND is_active = 1`)
        .all(employee.teamId) as any[];
      if (byTeam.length > 0) return byTeam;
    }
    if (employee.branchId) {
      return db
        .prepare(`SELECT id, full_name as fullName, employee_code as employeeCode FROM users WHERE branch_id = ? AND role = ? AND is_active = 1`)
        .all(employee.branchId, expectedRole) as any[];
    }
    return [];
  };

  // GPS Bike Run & Petrol Incentive Module
  router.get('/bike-runs', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Bike run records are restricted to field staff and management' });
      return;
    }

    let where = '';
    const params: any[] = [];
    if (user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR') {
      where = 'WHERE br.employee_id = ?';
      params.push(user.id);
    } else if (user.role === 'TEAM_LEADER') {
      where = `WHERE (br.employee_id = ? OR (u.role = 'FIELD_OFFICER' AND (u.reports_to_user_id = ? OR (u.reports_to_user_id IS NULL AND u.team_id = ?))))`;
      params.push(user.id, user.id, user.teamId || -1);
    } else if (user.role === 'BRANCH_MANAGER') {
      where = `WHERE (br.employee_id = ? OR u.reports_to_user_id = ? OR (u.branch_id = ? AND u.role IN ('TEAM_LEADER','FIELD_OFFICER')))`;
      params.push(user.id, user.id, user.branchId || -1);
    }

    const runs = db
      .prepare(`
        SELECT br.id, br.run_code as runCode, br.employee_id as employeeId,
          u.full_name as employeeName, u.employee_code as employeeCode, u.role as employeeRole,
          u.branch_id as employeeBranchId, u.team_id as employeeTeamId, u.reports_to_user_id as employeeReportsToUserId,
          br.lead_id as leadId, l.lead_code as leadCode,
          br.customer_name as customerName, br.tour_reason as tourReason,
          br.start_location as startLocation, br.end_location as endLocation,
          br.start_time as startTime, br.end_time as endTime,
          br.start_lat as startLat, br.start_lng as startLng,
          br.end_lat as endLat, br.end_lng as endLng,
          br.opening_odometer as openingOdometer, br.closing_odometer as closingOdometer,
          br.gps_distance_km as gpsDistanceKm, br.odometer_distance_km as odometerDistanceKm,
          br.discrepancy_km as discrepancyKm, br.discrepancy_flag as discrepancyFlag,
          br.rate_per_km as ratePerKm, br.eligible_km as eligibleKm,
          br.gross_amount as grossAmount, br.deducted_amount as deductedAmount, br.incentive_amount as incentiveAmount,
          br.approval_status as approvalStatus, br.reviewed_by as reviewedBy,
          rev.full_name as reviewedByName, br.reviewer_role as reviewerRole,
          br.review_remarks as reviewRemarks, br.reviewed_at as reviewedAt,
          br.route_points_json as routePointsJson, br.status
        FROM bike_runs br
        JOIN users u ON u.id = br.employee_id
        LEFT JOIN leads l ON l.id = br.lead_id
        LEFT JOIN users rev ON rev.id = br.reviewed_by
        ${where}
        ORDER BY br.start_time DESC
      `)
      .all(...params)
      .map((r: any) => {
        const empObj = {
          id: Number(r.employeeId),
          role: String(r.employeeRole),
          branchId: r.employeeBranchId ?? null,
          teamId: r.employeeTeamId ?? null,
          reportsToUserId: r.employeeReportsToUserId ?? null,
        };
        const expectedApproverRole = getExpectedBikeApproverRole(empObj.role);
        const expectedApproverLabel = getExpectedApproverRoleLabel(expectedApproverRole);
        const approvers = resolveExpectedApproverUsers(empObj);
        const rate = Number(r.ratePerKm || 3.0);
        const grossAmount =
          r.grossAmount && Number(r.grossAmount) > 0
            ? Number(r.grossAmount)
            : Math.round(Number(r.eligibleKm || 0) * rate * 100) / 100;
        const deductedAmount = Number(r.deductedAmount || 0);
        return {
          ...r,
          grossAmount,
          deductedAmount,
          expectedApproverRole,
          expectedApproverLabel,
          expectedApproverName: approvers[0]?.fullName || expectedApproverLabel,
          canReview: canUserReviewBikeRun(
            { id: user.id, role: user.role, branchId: user.branchId ?? null, teamId: user.teamId ?? null },
            empObj
          ),
          discrepancyFlag: Boolean(r.discrepancyFlag),
          routePoints: JSON.parse(r.routePointsJson || '[]'),
        };
      });

    res.json({ runs, petrolRatePerKm: getSettings().petrolRatePerKm });
  });

  router.post('/bike-runs/start', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Unauthorized' });
      return;
    }
    const {
      openingOdometer,
      latitude,
      longitude,
      leadId,
      customerName,
      tourReason,
      startLocation,
    } = req.body as {
      openingOdometer?: number;
      latitude?: number;
      longitude?: number;
      leadId?: number;
      customerName?: string;
      tourReason?: string;
      startLocation?: string;
    };
    if (openingOdometer === undefined || typeof latitude !== 'number' || typeof longitude !== 'number') {
      res.status(400).json({ error: 'Opening odometer and starting GPS coordinates are required' });
      return;
    }

    const active = db
      .prepare(`SELECT id FROM bike_runs WHERE employee_id = ? AND status = 'ACTIVE'`)
      .get(user.id);
    if (active) {
      res.status(400).json({ error: 'You already have an active Bike Run. Stop it before starting a new one.' });
      return;
    }

    let resolvedCustomer = (customerName || '').trim();
    if (!resolvedCustomer && leadId) {
      const leadRow = db.prepare('SELECT customer_name FROM leads WHERE id = ?').get(Number(leadId)) as { customer_name?: string } | undefined;
      resolvedCustomer = leadRow?.customer_name || '';
    }
    const resolvedReason = (tourReason || '').trim();
    const coordStr = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
    const resolvedStartLoc = startLocation?.trim()
      ? startLocation.trim().includes(latitude.toFixed(2))
        ? startLocation.trim()
        : `${startLocation.trim()} (${coordStr})`
      : coordStr;

    const runCode = `RUN-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const rate = getSettings().petrolRatePerKm;
    const now = nowSql();
    const points = [{ lat: latitude, lng: longitude, ts: now }];

    const inserted = db
      .prepare(`
        INSERT INTO bike_runs (
          run_code, employee_id, lead_id, customer_name, tour_reason, start_location,
          start_time, start_lat, start_lng, opening_odometer, rate_per_km, route_points_json, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
      `)
      .run(
        runCode,
        user.id,
        leadId ? Number(leadId) : null,
        resolvedCustomer,
        resolvedReason,
        resolvedStartLoc,
        now,
        latitude,
        longitude,
        Number(openingOdometer),
        rate,
        JSON.stringify(points)
      );

    logAudit(
      user,
      'BIKE_RUN_STARTED',
      'BIKE_RUN',
      runCode,
      `Opening Odometer ${openingOdometer} km at ${resolvedStartLoc}${resolvedCustomer ? ` | Customer: ${resolvedCustomer}` : ''}`
    );
    res.status(201).json({ ok: true, id: inserted.lastInsertRowid, runCode });
  });

  router.post('/bike-runs/:id/waypoint', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const run = db.prepare('SELECT * FROM bike_runs WHERE id = ? AND employee_id = ?').get(Number(req.params.id), user.id) as any;
    if (!run || run.status !== 'ACTIVE') {
      res.status(404).json({ error: 'Active bike run not found' });
      return;
    }
    const { latitude, longitude } = req.body as { latitude?: number; longitude?: number };
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      res.status(400).json({ error: 'Valid coordinates required' });
      return;
    }
    const points = JSON.parse(run.route_points_json || '[]');
    points.push({ lat: latitude, lng: longitude, ts: nowSql() });
    db.prepare('UPDATE bike_runs SET route_points_json = ? WHERE id = ?').run(JSON.stringify(points), run.id);
    res.json({ ok: true, pointCount: points.length });
  });

  router.post('/bike-runs/:id/stop', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const run = db.prepare('SELECT * FROM bike_runs WHERE id = ? AND employee_id = ?').get(Number(req.params.id), user.id) as any;
    if (!run || run.status !== 'ACTIVE') {
      res.status(404).json({ error: 'Active bike run not found' });
      return;
    }

    const {
      closingOdometer,
      latitude,
      longitude,
      simulatedExtraKm,
      customerName,
      tourReason,
      endLocation,
    } = req.body as {
      closingOdometer?: number;
      latitude?: number;
      longitude?: number;
      simulatedExtraKm?: number;
      customerName?: string;
      tourReason?: string;
      endLocation?: string;
    };
    if (closingOdometer === undefined || typeof latitude !== 'number' || typeof longitude !== 'number') {
      res.status(400).json({ error: 'Closing odometer and ending GPS coordinates are required' });
      return;
    }
    if (Number(closingOdometer) < Number(run.opening_odometer)) {
      res.status(400).json({ error: 'Closing odometer cannot be less than opening odometer' });
      return;
    }

    const now = nowSql();
    const points: { lat: number; lng: number; ts: string }[] = JSON.parse(run.route_points_json || '[]');
    points.push({ lat: latitude, lng: longitude, ts: now });

    let gpsKm = 0;
    for (let i = 1; i < points.length; i++) {
      gpsKm += haversineKm(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    }
    if (simulatedExtraKm && simulatedExtraKm > 0) {
      gpsKm += Number(simulatedExtraKm);
    }
    gpsKm = Math.round(gpsKm * 100) / 100;

    const odoKm = Math.round((Number(closingOdometer) - Number(run.opening_odometer)) * 100) / 100;
    const discrepancyKm = Math.round(Math.abs(odoKm - gpsKm) * 100) / 100;
    const discrepancyFlag = discrepancyKm > Math.max(2, gpsKm * 0.2) ? 1 : 0;

    const rate = getSettings().petrolRatePerKm;
    const eligibleKm = Math.min(gpsKm > 0 ? gpsKm : odoKm, odoKm);
    const grossAmount = Math.round(eligibleKm * rate * 100) / 100;

    const resolvedCustomer = (customerName || '').trim() || run.customer_name || '';
    const resolvedReason = (tourReason || '').trim() || run.tour_reason || '';
    const coordStr = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
    const resolvedEndLoc = endLocation?.trim()
      ? endLocation.trim().includes(latitude.toFixed(2))
        ? endLocation.trim()
        : `${endLocation.trim()} (${coordStr})`
      : coordStr;

    db.prepare(`
      UPDATE bike_runs
      SET end_time = ?, end_lat = ?, end_lng = ?, end_location = ?,
          customer_name = ?, tour_reason = ?,
          closing_odometer = ?,
          gps_distance_km = ?, odometer_distance_km = ?, discrepancy_km = ?, discrepancy_flag = ?,
          rate_per_km = ?, eligible_km = ?, gross_amount = ?, deducted_amount = 0, incentive_amount = ?,
          route_points_json = ?, status = 'COMPLETED'
      WHERE id = ?
    `).run(
      now,
      latitude,
      longitude,
      resolvedEndLoc,
      resolvedCustomer,
      resolvedReason,
      Number(closingOdometer),
      gpsKm,
      odoKm,
      discrepancyKm,
      discrepancyFlag,
      rate,
      eligibleKm,
      grossAmount,
      grossAmount,
      JSON.stringify(points),
      run.id
    );

    // Notify seniority-wise approver about completed bike run (and flag discrepancy if any)
    const approvers = resolveExpectedApproverUsers({
      id: user.id,
      role: user.role,
      branchId: user.branchId ?? null,
      teamId: user.teamId ?? null,
      reportsToUserId: user.reportsToUserId ?? null,
    });
    const notifyIds = approvers.length > 0 ? approvers.map((a) => a.id) : getSuperAdminIds();
    for (const mgrId of notifyIds) {
      createAlert({
        userId: mgrId,
        category: 'Field Officer GPS Location Alert',
        titleEn: discrepancyFlag
          ? `Bike Run Discrepancy Pending Approval: ${run.run_code}`
          : `Bike Run Bill Pending Approval: ${run.run_code}`,
        titleHi: discrepancyFlag
          ? `बाइक रन अंतर अनुमोदन लंबित: ${run.run_code}`
          : `बाइक रन बिल अनुमोदन लंबित: ${run.run_code}`,
        messageEn: `${user.fullName} completed ${eligibleKm} km @ ₹${rate}/km = ₹${grossAmount}${
          resolvedCustomer ? ` (${resolvedCustomer})` : ''
        }.${discrepancyFlag ? ` Odometer vs GPS diff: ${discrepancyKm} km.` : ''}`,
        messageHi: `${user.fullName} ने ${eligibleKm} किमी × ₹${rate}/किमी = ₹${grossAmount} पूरा किया।`,
      });
    }

    logAudit(
      user,
      'BIKE_RUN_COMPLETED',
      'BIKE_RUN',
      run.run_code,
      `GPS ${gpsKm} km, Odo ${odoKm} km, Eligible ${eligibleKm} km @ ₹${rate}/km = ₹${grossAmount}`
    );
    res.json({
      ok: true,
      gpsKm,
      odoKm,
      discrepancyKm,
      discrepancyFlag: Boolean(discrepancyFlag),
      ratePerKm: rate,
      eligibleKm,
      grossAmount,
      incentive: grossAmount,
    });
  });

  router.patch(
    '/bike-runs/:id/decision',
    requireAuth,
    requireRoles('TEAM_LEADER', 'BRANCH_MANAGER', 'SUPER_ADMIN'),
    (req: AuthedRequest, res) => {
      const reviewer = req.user!;
      const id = Number(req.params.id);
      const { decision, eligibleKm, deductedAmount, remarks } = req.body as {
        decision?: 'APPROVED' | 'DEDUCTED' | 'REJECTED';
        eligibleKm?: number;
        deductedAmount?: number;
        remarks?: string;
      };
      if (!decision || !['APPROVED', 'DEDUCTED', 'REJECTED'].includes(decision)) {
        res.status(400).json({ error: 'Decision must be APPROVED, DEDUCTED, or REJECTED' });
        return;
      }

      const run = db.prepare('SELECT * FROM bike_runs WHERE id = ?').get(id) as any;
      if (!run) {
        res.status(404).json({ error: 'Bike run not found' });
        return;
      }
      if (run.status !== 'COMPLETED') {
        res.status(400).json({ error: 'Only completed bike runs can be approved, deducted, or rejected' });
        return;
      }

      const empRow = db
        .prepare(
          `SELECT id, role, branch_id as branchId, team_id as teamId, reports_to_user_id as reportsToUserId FROM users WHERE id = ?`
        )
        .get(run.employee_id) as
        | {
            id: number;
            role: string;
            branchId: number | null;
            teamId: number | null;
            reportsToUserId: number | null;
          }
        | undefined;
      if (!empRow) {
        res.status(404).json({ error: 'Employee not found' });
        return;
      }

      const expectedRole = getExpectedBikeApproverRole(empRow.role);
      const allowed = canUserReviewBikeRun(
        {
          id: reviewer.id,
          role: reviewer.role,
          branchId: reviewer.branchId ?? null,
          teamId: reviewer.teamId ?? null,
        },
        empRow
      );
      if (!allowed) {
        const expectedLabel = getExpectedApproverRoleLabel(expectedRole);
        res.status(403).json({
          error: `Seniority hierarchy rule: ${empRow.role.replace(/_/g, ' ')} bike runs can only be approved, deducted, or rejected by their assigned ${expectedLabel}.`,
        });
        return;
      }

      const rate = Number(run.rate_per_km || getSettings().petrolRatePerKm || 3.0);
      const origKm = Number(run.eligible_km || 0);
      const origGross =
        Number(run.gross_amount || 0) > 0
          ? Number(run.gross_amount)
          : Math.round(origKm * rate * 100) / 100;

      const finalKm =
        eligibleKm !== undefined && !Number.isNaN(Number(eligibleKm))
          ? Math.max(0, Number(eligibleKm))
          : origKm;
      const computedGrossFromFinalKm = Math.round(finalKm * rate * 100) / 100;

      let storedGross = computedGrossFromFinalKm;
      let storedDeducted = 0;
      let finalIncentive = computedGrossFromFinalKm;

      if (decision === 'APPROVED') {
        storedDeducted = 0;
        finalIncentive = computedGrossFromFinalKm;
      } else if (decision === 'DEDUCTED') {
        const rawDeduct = Math.max(0, Number(deductedAmount || 0));
        if (rawDeduct === 0 && finalKm < origKm) {
          // Manager lowered eligible KM directly
          storedGross = origGross;
          storedDeducted = Math.round(Math.max(0, origGross - computedGrossFromFinalKm) * 100) / 100;
          finalIncentive = computedGrossFromFinalKm;
        } else {
          if (rawDeduct <= 0) {
            res.status(400).json({
              error: 'Enter a Deduction Amount (₹) greater than 0 or lower Eligible KM when selecting Deduct.',
            });
            return;
          }
          storedGross = computedGrossFromFinalKm;
          storedDeducted = Math.min(computedGrossFromFinalKm, Math.round(rawDeduct * 100) / 100);
          finalIncentive = Math.round(Math.max(0, computedGrossFromFinalKm - storedDeducted) * 100) / 100;
        }
      } else {
        // REJECTED
        storedGross = computedGrossFromFinalKm;
        storedDeducted = computedGrossFromFinalKm;
        finalIncentive = 0;
      }

      db.prepare(`
        UPDATE bike_runs
        SET eligible_km = ?, gross_amount = ?, deducted_amount = ?, incentive_amount = ?,
            approval_status = ?, reviewed_by = ?, reviewer_role = ?, review_remarks = ?, reviewed_at = ?
        WHERE id = ?
      `).run(
        finalKm,
        storedGross,
        storedDeducted,
        finalIncentive,
        decision,
        reviewer.id,
        reviewer.role,
        remarks?.trim() || null,
        nowSql(),
        id
      );

      createAlert({
        userId: run.employee_id,
        category: 'Field Officer GPS Location Alert',
        titleEn: `Petrol Bill ${run.run_code} ${decision}`,
        titleHi: `पेट्रोल बिल ${run.run_code} ${
          decision === 'APPROVED' ? 'स्वीकृत' : decision === 'DEDUCTED' ? 'कटौती के साथ स्वीकृत' : 'अस्वीकृत'
        }`,
        messageEn:
          decision === 'APPROVED'
            ? `Approved by ${reviewer.fullName} (${getExpectedApproverRoleLabel(expectedRole)}): ${finalKm} km × ₹${rate}/km = ₹${finalIncentive}.`
            : decision === 'DEDUCTED'
            ? `Deducted by ${reviewer.fullName}: Gross ₹${storedGross} - Deducted ₹${storedDeducted} = Net Payable ₹${finalIncentive}.${
                remarks ? ` Remarks: ${remarks}` : ''
              }`
            : `Rejected by ${reviewer.fullName}. Remarks: ${remarks || 'Discrepancy review'}`,
        messageHi:
          decision === 'APPROVED'
            ? `${reviewer.fullName} द्वारा ₹${finalIncentive} (${finalKm} किमी × ₹${rate}/किमी) स्वीकृत।`
            : decision === 'DEDUCTED'
            ? `${reviewer.fullName} द्वारा ₹${storedDeducted} कटौती के बाद ₹${finalIncentive} स्वीकृत।`
            : `${reviewer.fullName} द्वारा बाइक रन ${run.run_code} अस्वीकृत।`,
      });

      logAudit(
        reviewer,
        `BIKE_RUN_${decision}`,
        'BIKE_RUN',
        run.run_code,
        `Km: ${finalKm}, Gross: ₹${storedGross}, Deducted: ₹${storedDeducted}, Net: ₹${finalIncentive}${
          remarks ? `, Remarks: ${remarks}` : ''
        }`
      );
      res.json({
        ok: true,
        approvalStatus: decision,
        grossAmount: storedGross,
        deductedAmount: storedDeducted,
        incentiveAmount: finalIncentive,
      });
    }
  );

  // ============================================================================
  // DAILY ATTENDANCE & LEAVE MANAGEMENT
  // Self-approved attendance inside Ambika Office GPS (green <= 10:00 AM IST, ₹20/day after 10:00 AM IST)
  // Seniority Leave Approval: FO -> TL | TL / Back Office Lead Gen -> BM | BM -> Super Admin
  // Without approval leave -> ₹100/leave penalty
  // ============================================================================
  const getIstDateTimeParts = (dateObj = new Date()) => {
    const istMs = dateObj.getTime() + 330 * 60 * 1000;
    const d = new Date(istMs);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = d.getUTCHours();
    const min = d.getUTCMinutes();
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return {
      istDate: `${yyyy}-${mm}-${dd}`,
      istHour: hh,
      istMinute: min,
      istMinutesOfDay: hh * 60 + min,
      istTimeDisplay: `${String(h12).padStart(2, '0')}:${String(min).padStart(2, '0')} ${ampm} IST`,
    };
  };

  const parseCutoffMinutes = (cutoffStr: string | undefined) => {
    const [hStr, mStr] = (cutoffStr || '10:00').split(':');
    const h = Number(hStr);
    const m = Number(mStr);
    return (Number.isFinite(h) ? h : 10) * 60 + (Number.isFinite(m) ? m : 0);
  };

  const getExpectedLeaveApproverRole = (
    employeeRole: string
  ): 'TEAM_LEADER' | 'BRANCH_MANAGER' | 'SUPER_ADMIN' => {
    if (employeeRole === 'FIELD_OFFICER') return 'TEAM_LEADER';
    if (employeeRole === 'TEAM_LEADER' || employeeRole === 'LEAD_GENERATOR') return 'BRANCH_MANAGER';
    return 'SUPER_ADMIN';
  };

  const canUserReviewLeave = (
    reviewer: { id: number; role: string; branchId: number | null; teamId: number | null },
    applicant: {
      id: number;
      role: string;
      branchId: number | null;
      teamId: number | null;
      reportsToUserId: number | null;
    }
  ): boolean => {
    const expectedRole = getExpectedLeaveApproverRole(applicant.role);
    if (reviewer.role !== expectedRole) return false;
    if (applicant.role === 'SUPER_ADMIN') {
      if (reviewer.id !== applicant.id) return true;
      const adminCount = (db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1`).get() as { c: number }).c;
      return adminCount <= 1;
    }
    if (reviewer.id === applicant.id) return false;
    if (expectedRole === 'SUPER_ADMIN') return true;
    if (expectedRole === 'TEAM_LEADER') {
      if (applicant.reportsToUserId) return applicant.reportsToUserId === reviewer.id;
      if (applicant.teamId && reviewer.teamId) return applicant.teamId === reviewer.teamId;
      return Boolean(applicant.branchId && reviewer.branchId && applicant.branchId === reviewer.branchId);
    }
    // expectedRole === 'BRANCH_MANAGER' (for TEAM_LEADER & LEAD_GENERATOR)
    if (applicant.reportsToUserId) return applicant.reportsToUserId === reviewer.id;
    if (applicant.branchId && reviewer.branchId) return applicant.branchId === reviewer.branchId;
    return true;
  };

  const resolveExpectedLeaveApprovers = (applicant: {
    id: number;
    role: string;
    branchId: number | null;
    teamId: number | null;
    reportsToUserId: number | null;
  }) => {
    const expectedRole = getExpectedLeaveApproverRole(applicant.role);
    if (expectedRole === 'SUPER_ADMIN') {
      return db
        .prepare(`SELECT id, full_name as fullName FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1`)
        .all() as { id: number; fullName: string }[];
    }
    if (applicant.reportsToUserId) {
      const direct = db
        .prepare(`SELECT id, full_name as fullName FROM users WHERE id = ? AND role = ? AND is_active = 1`)
        .get(applicant.reportsToUserId, expectedRole) as { id: number; fullName: string } | undefined;
      if (direct) return [direct];
    }
    if (expectedRole === 'TEAM_LEADER' && applicant.teamId) {
      const byTeam = db
        .prepare(`SELECT id, full_name as fullName FROM users WHERE team_id = ? AND role = 'TEAM_LEADER' AND is_active = 1`)
        .all(applicant.teamId) as { id: number; fullName: string }[];
      if (byTeam.length > 0) return byTeam;
    }
    if (applicant.branchId) {
      const byBranch = db
        .prepare(`SELECT id, full_name as fullName FROM users WHERE branch_id = ? AND role = ? AND is_active = 1`)
        .all(applicant.branchId, expectedRole) as { id: number; fullName: string }[];
      if (byBranch.length > 0) return byBranch;
    }
    return db
      .prepare(`SELECT id, full_name as fullName FROM users WHERE role = ? AND is_active = 1`)
      .all(expectedRole) as { id: number; fullName: string }[];
  };

  const enumerateIsoDates = (fromIso: string, toIso: string): string[] => {
    const out: string[] = [];
    const start = new Date(`${fromIso}T00:00:00Z`).getTime();
    const end = new Date(`${toIso}T00:00:00Z`).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return out;
    for (let ts = start; ts <= end && out.length < 60; ts += 86400000) {
      out.push(new Date(ts).toISOString().slice(0, 10));
    }
    return out;
  };

  router.get('/attendance', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Daily attendance is for company employees only' });
      return;
    }
    const settings = getSettings();
    const ist = getIstDateTimeParts();
    const cutoffMins = parseCutoffMinutes(settings.attendanceCutoffTime);
    const isAfterCutoff = ist.istMinutesOfDay > cutoffMins;

    let where = '';
    const params: any[] = [];
    if (user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR') {
      where = 'WHERE a.employee_id = ?';
      params.push(user.id);
    } else if (user.role === 'TEAM_LEADER') {
      where = `WHERE (a.employee_id = ? OR (u.role = 'FIELD_OFFICER' AND (u.reports_to_user_id = ? OR (u.reports_to_user_id IS NULL AND u.team_id = ?))))`;
      params.push(user.id, user.id, user.teamId || -1);
    } else if (user.role === 'BRANCH_MANAGER') {
      where = `WHERE (a.employee_id = ? OR u.reports_to_user_id = ? OR (u.branch_id = ? AND u.role IN ('TEAM_LEADER','FIELD_OFFICER','LEAD_GENERATOR')))`;
      params.push(user.id, user.id, user.branchId || -1);
    }

    const records = db
      .prepare(`
        SELECT a.id, a.attendance_code as attendanceCode, a.employee_id as employeeId,
          u.full_name as employeeName, u.employee_code as employeeCode, u.role as employeeRole,
          a.attendance_date as attendanceDate, a.marked_at as markedAt, a.marked_time_ist as markedTimeIst,
          a.latitude, a.longitude, a.accuracy, a.location_label as locationLabel,
          a.distance_meters as distanceMeters, a.within_office as withinOffice,
          a.auto_captured as autoCaptured, a.status, a.self_approved as selfApproved,
          a.is_late as isLate, a.delay_minutes as delayMinutes,
          a.delay_penalty_amount as delayPenaltyAmount, a.penalty_id as penaltyId,
          a.notes, a.created_at as createdAt
        FROM attendance_logs a
        JOIN users u ON u.id = a.employee_id
        ${where}
        ORDER BY a.attendance_date DESC, a.marked_at DESC
        LIMIT 250
      `)
      .all(...params)
      .map((r: any) => ({
        ...r,
        withinOffice: Boolean(r.withinOffice),
        autoCaptured: Boolean(r.autoCaptured),
        selfApproved: Boolean(r.selfApproved),
        isLate: Boolean(r.isLate),
      }));

    const todayRecord =
      records.find((r: any) => r.employeeId === user.id && r.attendanceDate === ist.istDate) || null;

    // Staff list visible to manager for unapproved leave monitoring
    let staffWhere = `WHERE u.is_active = 1 AND u.role <> 'REFERRAL_PARTNER'`;
    const staffParams: any[] = [];
    if (user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR') {
      staffWhere += ' AND u.id = ?';
      staffParams.push(user.id);
    } else if (user.role === 'TEAM_LEADER') {
      staffWhere += ` AND (u.id = ? OR (u.role = 'FIELD_OFFICER' AND (u.reports_to_user_id = ? OR (u.reports_to_user_id IS NULL AND u.team_id = ?))))`;
      staffParams.push(user.id, user.id, user.teamId || -1);
    } else if (user.role === 'BRANCH_MANAGER') {
      staffWhere += ` AND (u.id = ? OR u.reports_to_user_id = ? OR (u.branch_id = ? AND u.role IN ('TEAM_LEADER','FIELD_OFFICER','LEAD_GENERATOR')))`;
      staffParams.push(user.id, user.id, user.branchId || -1);
    }
    const staff = db
      .prepare(`
        SELECT u.id, u.full_name as fullName, u.employee_code as employeeCode, u.role
        FROM users u
        ${staffWhere}
        ORDER BY u.full_name ASC
      `)
      .all(...staffParams);

    res.json({
      records,
      todayRecord,
      staff,
      officeConfig: {
        officeName: settings.officeName,
        officeAddress: settings.officeAddress,
        officeLatitude: settings.officeLatitude,
        officeLongitude: settings.officeLongitude,
        officeRadiusMeters: settings.officeRadiusMeters,
        attendanceCutoffTime: settings.attendanceCutoffTime,
        attendanceLatePenaltyInr: settings.attendanceLatePenaltyInr,
        unapprovedLeavePenaltyInr: settings.unapprovedLeavePenaltyInr,
      },
      serverIstDate: ist.istDate,
      serverIstTime: ist.istTimeDisplay,
      isAfterCutoff,
    });
  });

  router.post('/attendance/mark', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Daily attendance is for company employees only' });
      return;
    }

    const { latitude, longitude, accuracy, locationLabel, notes } = req.body as {
      latitude?: number;
      longitude?: number;
      accuracy?: number;
      locationLabel?: string;
      notes?: string;
    };
    if (typeof latitude !== 'number' || typeof longitude !== 'number' || Number.isNaN(latitude) || Number.isNaN(longitude)) {
      res.status(400).json({ error: 'Auto GPS coordinates (latitude, longitude) are required to mark attendance.' });
      return;
    }

    const settings = getSettings();
    const officeLat = Number(settings.officeLatitude ?? 24.5819);
    const officeLng = Number(settings.officeLongitude ?? 80.7921);
    const radiusMeters = Math.max(50, Number(settings.officeRadiusMeters ?? 500));
    const distanceMeters = Math.round(haversineKm(latitude, longitude, officeLat, officeLng) * 1000);
    const rawAccuracy =
      typeof accuracy === 'number' && !Number.isNaN(accuracy) ? Math.max(0, Math.round(accuracy)) : 0;
    // Indoor 1st-floor GPS readings often carry ±50m–250m signal jitter; subtract capped device accuracy
    const accuracyAllowance = Math.min(rawAccuracy, 250);
    const effectiveDistance = Math.max(0, distanceMeters - accuracyAllowance);

    if (effectiveDistance > radiusMeters) {
      res.status(403).json({
        error: `Outside Ambika Office range (${distanceMeters}m away${rawAccuracy > 0 ? `, GPS ±${rawAccuracy}m` : ''}; allowed radius ${radiusMeters}m from ${settings.officeName}). Attendance turns ON only inside Ambika Office GPS.`,
        distanceMeters,
        effectiveDistance,
        radiusMeters,
      });
      return;
    }

    const ist = getIstDateTimeParts();
    const existing = db
      .prepare(`SELECT id, attendance_code as attendanceCode FROM attendance_logs WHERE employee_id = ? AND attendance_date = ?`)
      .get(user.id, ist.istDate) as { id: number; attendanceCode: string } | undefined;
    if (existing) {
      res.status(400).json({ error: `Today's self-attendance (${existing.attendanceCode}) is already approved.` });
      return;
    }

    const cutoffMins = parseCutoffMinutes(settings.attendanceCutoffTime);
    const isLate = ist.istMinutesOfDay > cutoffMins;
    const delayMinutes = isLate ? ist.istMinutesOfDay - cutoffMins : 0;
    const latePenaltyAmt = isLate ? Math.max(0, Number(settings.attendanceLatePenaltyInr ?? 20)) : 0;
    const status = isLate ? 'LATE_PRESENT' : 'PRESENT';

    const now = nowSql();
    const attCode = `ATT-${ist.istDate.replace(/-/g, '')}-${user.employeeCode}`;
    const resolvedLabel =
      (locationLabel || '').trim() ||
      `${settings.officeName || 'AMBIKA Office'} (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;

    let penaltyId: number | null = null;
    if (isLate && latePenaltyAmt > 0) {
      const penCode = `PEN-LATE-${ist.istDate.replace(/-/g, '')}-${user.id}`;
      const cutoffDisplay = `${settings.attendanceCutoffTime || '10:00'} IST`;
      const penInsert = db
        .prepare(`
          INSERT INTO penalties (
            penalty_code, employee_id, penalty_type, event_at, deadline_at, actual_update_at,
            delay_seconds, amount, approval_status, review_remarks, reviewed_at
          )
          VALUES (?, ?, 'ATTENDANCE_LATE_20', ?, ?, ?, ?, ?, 'APPROVED', ?, ?)
        `)
        .run(
          penCode,
          user.id,
          now,
          `${ist.istDate} ${cutoffDisplay}`,
          now,
          delayMinutes * 60,
          latePenaltyAmt,
          `Auto late attendance penalty (${delayMinutes} mins after ${cutoffDisplay})`,
          now
        );
      penaltyId = Number(penInsert.lastInsertRowid);

      createAlert({
        userId: user.id,
        category: 'Attendance & Leave Alert',
        titleEn: `Late Attendance Delay Penalty (₹${latePenaltyAmt})`,
        titleHi: `देरी से उपस्थिति जुर्माना (₹${latePenaltyAmt})`,
        messageEn: `Self-attendance approved at ${ist.istTimeDisplay} (${delayMinutes} min after ${cutoffDisplay}). ₹${latePenaltyAmt} daily delay penalty applied.`,
        messageHi: `${ist.istTimeDisplay} पर उपस्थिति दर्ज हुई (सुबह 10:00 के बाद ${delayMinutes} मिनट देरी)। ₹${latePenaltyAmt} जुर्माना लागू।`,
      });
    }

    const insAtt = db
      .prepare(`
        INSERT INTO attendance_logs (
          attendance_code, employee_id, attendance_date, marked_at, marked_time_ist,
          latitude, longitude, accuracy, location_label, distance_meters, within_office,
          auto_captured, status, self_approved, is_late, delay_minutes, delay_penalty_amount, penalty_id, notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 1, ?, ?, ?, ?, ?)
      `)
      .run(
        attCode,
        user.id,
        ist.istDate,
        now,
        ist.istTimeDisplay,
        latitude,
        longitude,
        accuracy ?? null,
        resolvedLabel,
        distanceMeters,
        status,
        isLate ? 1 : 0,
        delayMinutes,
        latePenaltyAmt,
        penaltyId,
        notes?.trim() || null
      );

    logAudit(
      user,
      isLate ? 'ATTENDANCE_SELF_APPROVED_LATE' : 'ATTENDANCE_SELF_APPROVED',
      'ATTENDANCE',
      attCode,
      `Date: ${ist.istDate}, Time: ${ist.istTimeDisplay}, Distance: ${distanceMeters}m from office${
        isLate ? `, Late ${delayMinutes}m -> Penalty ₹${latePenaltyAmt}` : ' (On-Time)'
      }`
    );

    pushSseEvent('attendance', {
      employeeId: user.id,
      employeeName: user.fullName,
      employeeCode: user.employeeCode,
      role: user.role,
      attendanceDate: ist.istDate,
      status,
    });

    res.status(201).json({
      ok: true,
      id: insAtt.lastInsertRowid,
      attendanceCode: attCode,
      attendanceDate: ist.istDate,
      markedTimeIst: ist.istTimeDisplay,
      distanceMeters,
      status,
      selfApproved: true,
      isLate,
      delayMinutes,
      delayPenaltyAmount: latePenaltyAmt,
    });
  });

  router.post(
    '/attendance/office-location',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER'),
    (req: AuthedRequest, res) => {
      const admin = req.user!;
      const { officeName, officeAddress, latitude, longitude, radiusMeters } = req.body as {
        officeName?: string;
        officeAddress?: string;
        latitude?: number;
        longitude?: number;
        radiusMeters?: number;
      };
      if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        res.status(400).json({ error: 'Valid office latitude and longitude are required' });
        return;
      }
      if (officeName?.trim()) updateSetting('officeName', officeName.trim(), admin.id);
      if (officeAddress?.trim()) updateSetting('officeAddress', officeAddress.trim(), admin.id);
      updateSetting('officeLatitude', latitude, admin.id);
      updateSetting('officeLongitude', longitude, admin.id);
      if (radiusMeters !== undefined && Number(radiusMeters) >= 50) {
        updateSetting('officeRadiusMeters', Math.round(Number(radiusMeters)), admin.id);
      }
      logAudit(
        admin,
        'OFFICE_GEOFENCE_UPDATED',
        'SETTINGS',
        'OFFICE_GPS',
        `Updated Ambika Office GPS to (${latitude.toFixed(5)}, ${longitude.toFixed(5)}), radius ${radiusMeters || getSettings().officeRadiusMeters}m`
      );
      broadcastLiveSync(
        'OFFICE_GPS_UPDATED',
        `Ambika Office GPS anchored by ${admin.fullName} (Radius ${radiusMeters || getSettings().officeRadiusMeters}m)`,
        admin
      );
      res.json({ ok: true, settings: getSettings() });
    }
  );

  router.get('/leaves', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Leave management is for company employees only' });
      return;
    }

    let where = '';
    const params: any[] = [];
    if (user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR') {
      where = 'WHERE lr.employee_id = ?';
      params.push(user.id);
    } else if (user.role === 'TEAM_LEADER') {
      where = `WHERE (lr.employee_id = ? OR (u.role = 'FIELD_OFFICER' AND (u.reports_to_user_id = ? OR (u.reports_to_user_id IS NULL AND u.team_id = ?))))`;
      params.push(user.id, user.id, user.teamId || -1);
    } else if (user.role === 'BRANCH_MANAGER') {
      where = `WHERE (lr.employee_id = ? OR u.reports_to_user_id = ? OR (u.branch_id = ? AND u.role IN ('TEAM_LEADER','FIELD_OFFICER','LEAD_GENERATOR')))`;
      params.push(user.id, user.id, user.branchId || -1);
    }

    const leaves = db
      .prepare(`
        SELECT lr.id, lr.leave_code as leaveCode, lr.employee_id as employeeId,
          u.full_name as employeeName, u.employee_code as employeeCode, u.role as employeeRole,
          u.branch_id as employeeBranchId, u.team_id as employeeTeamId, u.reports_to_user_id as employeeReportsToUserId,
          lr.from_date as fromDate, lr.to_date as toDate, lr.total_days as totalDays,
          lr.leave_type as leaveType, lr.reason, lr.approval_status as approvalStatus,
          lr.expected_approver_role as expectedApproverRole,
          lr.reviewed_by as reviewedBy, rev.full_name as reviewedByName,
          lr.reviewer_role as reviewerRole, lr.review_remarks as reviewRemarks, lr.reviewed_at as reviewedAt,
          lr.unapproved_penalty_amount as unapprovedPenaltyAmount, lr.penalty_id as penaltyId,
          lr.created_at as createdAt
        FROM leave_requests lr
        JOIN users u ON u.id = lr.employee_id
        LEFT JOIN users rev ON rev.id = lr.reviewed_by
        ${where}
        ORDER BY CASE WHEN lr.approval_status = 'PENDING' THEN 0 ELSE 1 END, lr.created_at DESC
      `)
      .all(...params)
      .map((r: any) => {
        const expectedRole = getExpectedLeaveApproverRole(r.employeeRole);
        return {
          ...r,
          expectedApproverRole: expectedRole,
          expectedApproverLabel: getExpectedApproverRoleLabel(expectedRole),
          canReview: canUserReviewLeave(
            { id: user.id, role: user.role, branchId: user.branchId ?? null, teamId: user.teamId ?? null },
            {
              id: Number(r.employeeId),
              role: String(r.employeeRole),
              branchId: r.employeeBranchId ?? null,
              teamId: r.employeeTeamId ?? null,
              reportsToUserId: r.employeeReportsToUserId ?? null,
            }
          ),
        };
      });

    res.json({ leaves });
  });

  router.post('/leaves', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Only company employees can apply for leave' });
      return;
    }

    const { fromDate, toDate, leaveType, reason } = req.body as {
      fromDate?: string;
      toDate?: string;
      leaveType?: string;
      reason?: string;
    };
    if (!fromDate || !toDate || !reason?.trim()) {
      res.status(400).json({ error: 'From date, To date, and Leave Reason are required' });
      return;
    }
    const dates = enumerateIsoDates(fromDate, toDate);
    if (dates.length === 0) {
      res.status(400).json({ error: 'To date must be on or after From date' });
      return;
    }

    const totalDays = dates.length;
    const expectedRole = getExpectedLeaveApproverRole(user.role);
    const leaveCode = `LVE-${Date.now().toString(36).toUpperCase().slice(-5)}`;

    const inserted = db
      .prepare(`
        INSERT INTO leave_requests (
          leave_code, employee_id, from_date, to_date, total_days, leave_type, reason, expected_approver_role
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        leaveCode,
        user.id,
        fromDate,
        toDate,
        totalDays,
        (leaveType || 'Casual Leave').trim(),
        reason.trim(),
        expectedRole
      );

    const approvers = resolveExpectedLeaveApprovers({
      id: user.id,
      role: user.role,
      branchId: user.branchId ?? null,
      teamId: user.teamId ?? null,
      reportsToUserId: user.reportsToUserId ?? null,
    });
    for (const mgr of approvers) {
      createAlert({
        userId: mgr.id,
        category: 'Attendance & Leave Alert',
        titleEn: `Leave Approval Pending: ${leaveCode}`,
        titleHi: `अवकाश स्वीकृति लंबित: ${leaveCode}`,
        messageEn: `${user.fullName} (${user.role.replace(/_/g, ' ')}) requested ${totalDays} day(s) leave (${fromDate} to ${toDate}). Reason: ${reason.trim()}`,
        messageHi: `${user.fullName} ने ${totalDays} दिन के अवकाश का अनुरोध किया है (${fromDate} से ${toDate})। कारण: ${reason.trim()}`,
      });
    }

    logAudit(
      user,
      'LEAVE_APPLIED',
      'LEAVE',
      leaveCode,
      `Applied ${totalDays} day(s) (${fromDate} to ${toDate}), Approver: ${expectedRole}, Reason: ${reason.trim()}`
    );

    res.status(201).json({
      ok: true,
      id: inserted.lastInsertRowid,
      leaveCode,
      totalDays,
      expectedApproverRole: expectedRole,
      expectedApproverLabel: getExpectedApproverRoleLabel(expectedRole),
    });
  });

  router.patch(
    '/leaves/:id/decision',
    requireAuth,
    requireRoles('TEAM_LEADER', 'BRANCH_MANAGER', 'SUPER_ADMIN'),
    (req: AuthedRequest, res) => {
      const reviewer = req.user!;
      const id = Number(req.params.id);
      const { decision, remarks } = req.body as {
        decision?: 'APPROVED' | 'REJECTED';
        remarks?: string;
      };
      if (!decision || !['APPROVED', 'REJECTED'].includes(decision)) {
        res.status(400).json({ error: 'Decision must be APPROVED or REJECTED' });
        return;
      }

      const leave = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id) as any;
      if (!leave) {
        res.status(404).json({ error: 'Leave request not found' });
        return;
      }

      const empRow = db
        .prepare(
          `SELECT id, role, branch_id as branchId, team_id as teamId, reports_to_user_id as reportsToUserId FROM users WHERE id = ?`
        )
        .get(leave.employee_id) as
        | {
            id: number;
            role: string;
            branchId: number | null;
            teamId: number | null;
            reportsToUserId: number | null;
          }
        | undefined;
      if (!empRow) {
        res.status(404).json({ error: 'Applicant employee not found' });
        return;
      }

      const expectedRole = getExpectedLeaveApproverRole(empRow.role);
      const allowed = canUserReviewLeave(
        {
          id: reviewer.id,
          role: reviewer.role,
          branchId: reviewer.branchId ?? null,
          teamId: reviewer.teamId ?? null,
        },
        empRow
      );
      if (!allowed) {
        const expectedLabel = getExpectedApproverRoleLabel(expectedRole);
        res.status(403).json({
          error: `Seniority Approval Rule: ${empRow.role.replace(/_/g, ' ')} leave requests can only be approved or rejected by their ${expectedLabel}.`,
        });
        return;
      }

      const settings = getSettings();
      const now = nowSql();
      const ist = getIstDateTimeParts();
      let penaltyAmt = 0;
      let penaltyId: number | null = leave.penalty_id || null;

      if (decision === 'REJECTED') {
        // Without approval leave -> ₹100 per leave penalty charge
        const perLeaveCharge = Math.max(0, Number(settings.unapprovedLeavePenaltyInr ?? 100));
        const dates = enumerateIsoDates(leave.from_date, leave.to_date);
        // Exclude days where employee already marked self-attendance
        const absentDates = dates.filter((dt) => {
          const hasAtt = db
            .prepare(`SELECT id FROM attendance_logs WHERE employee_id = ? AND attendance_date = ?`)
            .get(leave.employee_id, dt);
          return !hasAtt;
        });
        const chargeableDays = absentDates.length > 0 ? absentDates.length : Number(leave.total_days || 1);
        penaltyAmt = perLeaveCharge * chargeableDays;

        if (penaltyAmt > 0 && !penaltyId) {
          const penCode = `PEN-ULV-${leave.leave_code}`;
          const penIns = db
            .prepare(`
              INSERT INTO penalties (
                penalty_code, employee_id, penalty_type, event_at, deadline_at, actual_update_at,
                delay_seconds, amount, approval_status, reviewed_by, review_remarks, reviewed_at
              )
              VALUES (?, ?, 'UNAPPROVED_LEAVE_100', ?, ?, ?, 0, ?, 'APPROVED', ?, ?, ?)
            `)
            .run(
              penCode,
              leave.employee_id,
              now,
              `${leave.from_date} to ${leave.to_date}`,
              now,
              penaltyAmt,
              reviewer.id,
              `Unapproved leave penalty (₹${perLeaveCharge} × ${chargeableDays} leave(s)) — ${leave.leave_code}${
                remarks ? `: ${remarks}` : ''
              }`,
              now
            );
          penaltyId = Number(penIns.lastInsertRowid);
        }
      }

      db.prepare(`
        UPDATE leave_requests
        SET approval_status = ?, reviewed_by = ?, reviewer_role = ?, review_remarks = ?, reviewed_at = ?,
            unapproved_penalty_amount = ?, penalty_id = ?
        WHERE id = ?
      `).run(
        decision,
        reviewer.id,
        reviewer.role,
        remarks?.trim() || null,
        now,
        penaltyAmt,
        penaltyId,
        id
      );

      createAlert({
        userId: leave.employee_id,
        category: 'Attendance & Leave Alert',
        titleEn:
          decision === 'APPROVED'
            ? `Leave Approved: ${leave.leave_code}`
            : `Leave Rejected — ₹${penaltyAmt} Unapproved Leave Penalty`,
        titleHi:
          decision === 'APPROVED'
            ? `अवकाश स्वीकृत: ${leave.leave_code}`
            : `अवकाश अस्वीकृत — ₹${penaltyAmt} बिना स्वीकृति जुर्माना`,
        messageEn:
          decision === 'APPROVED'
            ? `${reviewer.fullName} approved your leave (${leave.from_date} to ${leave.to_date}).${remarks ? ' Remarks: ' + remarks : ''}`
            : `${reviewer.fullName} rejected your leave (${leave.from_date} to ${leave.to_date}). Without-approval leave penalty of ₹${penaltyAmt} charged.${
                remarks ? ' Remarks: ' + remarks : ''
              }`,
        messageHi:
          decision === 'APPROVED'
            ? `${reviewer.fullName} ने आपका अवकाश (${leave.from_date} से ${leave.to_date}) स्वीकृत किया।`
            : `${reviewer.fullName} ने अवकाश अस्वीकृत किया। ₹${penaltyAmt} जुर्माना लागू।`,
      });

      logAudit(
        reviewer,
        `LEAVE_${decision}`,
        'LEAVE',
        leave.leave_code,
        `Leave ${leave.leave_code} ${decision} by ${reviewer.fullName}${
          penaltyAmt > 0 ? ` | Unapproved Penalty ₹${penaltyAmt}` : ''
        }`
      );

      res.json({
        ok: true,
        approvalStatus: decision,
        unapprovedPenaltyAmount: penaltyAmt,
        istDate: ist.istDate,
      });
    }
  );

  // Direct Without-Approval Leave Penalty Charge (₹100/leave for any absent staff without attendance or approved leave)
  router.post(
    '/attendance/unapproved-leave-penalty',
    requireAuth,
    requireRoles('TEAM_LEADER', 'BRANCH_MANAGER', 'SUPER_ADMIN'),
    (req: AuthedRequest, res) => {
      const reviewer = req.user!;
      const { employeeId, leaveDate, remarks } = req.body as {
        employeeId?: number;
        leaveDate?: string;
        remarks?: string;
      };
      const targetDate = (leaveDate || getIstDateTimeParts().istDate).trim();
      if (!employeeId) {
        res.status(400).json({ error: 'Employee ID is required' });
        return;
      }

      const emp = db
        .prepare(
          `SELECT id, full_name as fullName, employee_code as employeeCode, role, branch_id as branchId, team_id as teamId, reports_to_user_id as reportsToUserId FROM users WHERE id = ? AND is_active = 1`
        )
        .get(Number(employeeId)) as any;
      if (!emp || emp.role === 'REFERRAL_PARTNER') {
        res.status(404).json({ error: 'Active employee not found' });
        return;
      }

      const allowed = canUserReviewLeave(
        { id: reviewer.id, role: reviewer.role, branchId: reviewer.branchId ?? null, teamId: reviewer.teamId ?? null },
        emp
      );
      if (!allowed && reviewer.role !== 'SUPER_ADMIN') {
        const expectedLabel = getExpectedApproverRoleLabel(getExpectedLeaveApproverRole(emp.role));
        res.status(403).json({
          error: `Seniority Approval Rule: Only ${emp.fullName}'s ${expectedLabel} or Super Admin can charge unapproved leave penalty.`,
        });
        return;
      }

      const hasAttendance = db
        .prepare(`SELECT id FROM attendance_logs WHERE employee_id = ? AND attendance_date = ?`)
        .get(emp.id, targetDate);
      if (hasAttendance) {
        res.status(400).json({ error: `${emp.fullName} has marked present attendance on ${targetDate}.` });
        return;
      }

      const approvedLeave = db
        .prepare(`SELECT id, leave_code FROM leave_requests WHERE employee_id = ? AND approval_status = 'APPROVED' AND ? BETWEEN from_date AND to_date`)
        .get(emp.id, targetDate) as { id: number; leave_code: string } | undefined;
      if (approvedLeave) {
        res.status(400).json({ error: `${emp.fullName} has an APPROVED leave (${approvedLeave.leave_code}) on ${targetDate}.` });
        return;
      }

      const penCode = `PEN-ABS-${targetDate.replace(/-/g, '')}-${emp.id}`;
      const existingPen = db.prepare(`SELECT id FROM penalties WHERE penalty_code = ?`).get(penCode);
      if (existingPen) {
        res.status(400).json({ error: `Unapproved leave penalty already charged for ${emp.fullName} on ${targetDate}.` });
        return;
      }

      const settings = getSettings();
      const amount = Math.max(0, Number(settings.unapprovedLeavePenaltyInr ?? 100));
      const now = nowSql();

      const penIns = db
        .prepare(`
          INSERT INTO penalties (
            penalty_code, employee_id, penalty_type, event_at, deadline_at, actual_update_at,
            delay_seconds, amount, approval_status, reviewed_by, review_remarks, reviewed_at
          )
          VALUES (?, ?, 'UNAPPROVED_LEAVE_100', ?, ?, ?, 0, ?, 'APPROVED', ?, ?, ?)
        `)
        .run(
          penCode,
          emp.id,
          now,
          targetDate,
          now,
          amount,
          reviewer.id,
          remarks?.trim() || `Without-approval leave / absence on ${targetDate} (₹${amount}/leave)`,
          now
        );

      createAlert({
        userId: emp.id,
        category: 'Attendance & Leave Alert',
        titleEn: `₹${amount} Unapproved Leave Penalty (${targetDate})`,
        titleHi: `₹${amount} बिना स्वीकृति अवकाश जुर्माना (${targetDate})`,
        messageEn: `Absent without approved leave on ${targetDate}. ₹${amount} unapproved leave penalty charged by ${reviewer.fullName}.`,
        messageHi: `${targetDate} को बिना स्वीकृत अवकाश अनुपस्थिति पर ₹${amount} जुर्माना लगाया गया।`,
      });

      logAudit(
        reviewer,
        'UNAPPROVED_LEAVE_PENALTY',
        'PENALTY',
        penCode,
        `Charged ₹${amount} unapproved leave penalty to ${emp.fullName} (${emp.employeeCode}) for ${targetDate}`
      );

      res.status(201).json({ ok: true, id: penIns.lastInsertRowid, penaltyCode: penCode, amount });
    }
  );

  // Alert Centre (Top Header Bell Icon)
  router.get('/alerts', requireAuth, (req: AuthedRequest, res) => {
    processSlaTimers();
    const user = req.user!;
    const alerts = db
      .prepare(`
        SELECT a.id, a.alert_code as alertCode, a.user_id as userId, a.lead_id as leadId, l.lead_code as leadCode,
          a.enquiry_id as enquiryId, e.enquiry_code as enquiryCode, a.category,
          a.title_en as titleEn, a.title_hi as titleHi, a.message_en as messageEn, a.message_hi as messageHi,
          a.is_read as isRead, a.read_at as readAt, a.created_at as createdAt
        FROM alerts a
        LEFT JOIN leads l ON l.id = a.lead_id
        LEFT JOIN enquiries e ON e.id = a.enquiry_id
        WHERE a.user_id = ?
        ORDER BY a.is_read ASC, a.created_at DESC, a.id DESC
        LIMIT 150
      `)
      .all(user.id)
      .map((a: any) => ({ ...a, isRead: Boolean(a.isRead) }));

    const unreadCount = alerts.filter((a: any) => !a.isRead).length;
    res.json({ alerts, unreadCount });
  });

  router.patch('/alerts/:id/read', requireAuth, (req: AuthedRequest, res) => {
    db.prepare(`UPDATE alerts SET is_read = 1, read_at = ? WHERE id = ? AND user_id = ?`).run(
      nowSql(),
      Number(req.params.id),
      req.user!.id
    );
    res.json({ ok: true });
  });

  router.patch('/alerts/read-all', requireAuth, (req: AuthedRequest, res) => {
    db.prepare(`UPDATE alerts SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0`).run(
      nowSql(),
      req.user!.id
    );
    res.json({ ok: true });
  });

  // 15 Downloadable Reports
  router.get('/reports/:type', requireAuth, (req: AuthedRequest, res) => {
    processSlaTimers();
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER' && !['referral_leads', 'case_status', 'enquiry'].includes(req.params.type)) {
      res.status(403).json({ error: 'Access denied for this management report' });
      return;
    }

    const type = req.params.type;
    const scope = buildLeadScopeFilter(user);
    const todayStr = new Date().toISOString().slice(0, 10);
    const monthStr = todayStr.slice(0, 7);

    let title = 'CRM Report';
    let columns: string[] = [];
    let rows: Record<string, unknown>[] = [];

    const loadLeads = () =>
      (
        db
          .prepare(`
            SELECT l.*, cb.full_name as created_by_name, cb.role as created_by_role, cb.employee_code as created_by_code,
              bm.full_name as assigned_bm_name, bm.employee_code as assigned_bm_code,
              tl.full_name as assigned_tl_name, tl.employee_code as assigned_tl_code,
              ao.full_name as assigned_officer_name, ao.employee_code as assigned_officer_code, ao.mobile as assigned_officer_mobile, b.name as branch_name
            FROM leads l
            JOIN users cb ON cb.id = l.created_by
            LEFT JOIN users bm ON bm.id = l.assigned_bm_id
            LEFT JOIN users tl ON tl.id = l.assigned_tl_id
            LEFT JOIN users ao ON ao.id = l.assigned_officer_id
            LEFT JOIN branches b ON b.id = l.branch_id
            WHERE ${scope.sql}
            ORDER BY l.created_at DESC
          `)
          .all(...scope.params) as any[]
      ).map((r) => serializeLeadForUser(r, user));

    switch (type) {
      case 'daily_leads': {
        title = 'Daily Lead Report';
        const data = loadLeads().filter((l) => l.createdAt.startsWith(todayStr));
        columns = ['Lead ID', 'Customer', 'Product', 'Bank/NBFC', 'Status', 'Assigned Officer', 'Created At'];
        rows = data.map((l) => ({
          'Lead ID': l.leadCode,
          Customer: l.customerName,
          Product: l.loanProduct,
          'Bank/NBFC': l.bankNbfc,
          Status: l.status,
          'Assigned Officer': l.assignedOfficerName || 'Unassigned',
          'Created At': l.createdAt,
        }));
        break;
      }
      case 'monthly_leads': {
        title = 'Monthly Lead Report';
        const data = loadLeads().filter((l) => l.createdAt.startsWith(monthStr));
        columns = ['Lead ID', 'Customer', 'Product', 'Amount (INR)', 'Bank/NBFC', 'Status', 'Created At'];
        rows = data.map((l) => ({
          'Lead ID': l.leadCode,
          Customer: l.customerName,
          Product: l.loanProduct,
          'Amount (INR)': l.loanAmount ?? 'Redacted',
          'Bank/NBFC': l.bankNbfc,
          Status: l.status,
          'Created At': l.createdAt,
        }));
        break;
      }
      case 'referral_leads': {
        title = 'Referral-wise Lead Report';
        const data = loadLeads().filter((l) => l.referralId || l.referralName);
        columns = ['Referral ID', 'Referral Name', 'Lead ID', 'Customer', 'Product', 'Status', 'Created At'];
        rows = data.map((l) => ({
          'Referral ID': l.referralId || '-',
          'Referral Name': l.referralName || l.createdByName,
          'Lead ID': l.leadCode,
          Customer: l.customerName,
          Product: l.loanProduct,
          Status: l.status,
          'Created At': l.createdAt,
        }));
        break;
      }
      case 'employee_leads':
      case 'field_officer_performance': {
        title = type === 'employee_leads' ? 'Employee-wise Lead Report' : 'Field Officer Performance Report';
        columns = ['Emp Code', 'Field Officer', 'Total Leads', 'Disbursed', 'Disbursement (INR)', 'Approved Penalties (INR)'];
        const isFieldOfficer = user.role === 'FIELD_OFFICER';
        rows = db
          .prepare(`
            SELECT u.employee_code as "Emp Code", u.full_name as "Field Officer",
              COUNT(DISTINCT l.id) as "Total Leads",
              SUM(CASE WHEN l.status = 'Disbursed' THEN 1 ELSE 0 END) as "Disbursed",
              COALESCE(SUM(CASE WHEN l.status = 'Disbursed' THEN l.loan_amount ELSE 0 END), 0) as "Disbursement (INR)",
              (SELECT COALESCE(SUM(p.amount), 0) FROM penalties p WHERE p.employee_id = u.id AND p.approval_status = 'APPROVED') as "Approved Penalties (INR)"
            FROM users u
            LEFT JOIN leads l ON l.assigned_officer_id = u.id
            WHERE u.role = 'FIELD_OFFICER' ${isFieldOfficer ? 'AND u.id = ?' : ''}
            GROUP BY u.id
          `)
          .all(...(isFieldOfficer ? [user.id] : [])) as any[];
        break;
      }
      case 'branch_performance': {
        title = 'Branch Performance Report';
        columns = ['Branch Code', 'Branch Name', 'City', 'Total Leads', 'Disbursed Cases', 'Total Disbursed (INR)'];
        rows = db
          .prepare(`
            SELECT b.code as "Branch Code", b.name as "Branch Name", b.city as "City",
              COUNT(l.id) as "Total Leads",
              SUM(CASE WHEN l.status = 'Disbursed' THEN 1 ELSE 0 END) as "Disbursed Cases",
              COALESCE(SUM(CASE WHEN l.status = 'Disbursed' THEN l.loan_amount ELSE 0 END), 0) as "Total Disbursed (INR)"
            FROM branches b
            LEFT JOIN leads l ON l.branch_id = b.id
            GROUP BY b.id
          `)
          .all() as any[];
        break;
      }
      case 'case_status': {
        title = 'Case Status Report';
        const data = loadLeads();
        columns = ['Lead ID', 'Customer', 'Loan Product', 'Bank/NBFC', 'Current Status', 'Last Updated'];
        rows = data.map((l) => ({
          'Lead ID': l.leadCode,
          Customer: l.customerName,
          'Loan Product': l.loanProduct,
          'Bank/NBFC': l.bankNbfc,
          'Current Status': l.status,
          'Last Updated': l.updatedAt,
        }));
        break;
      }
      case 'disbursement': {
        title = 'Disbursement Report';
        const data = loadLeads().filter((l) => l.status === 'Disbursed');
        columns = ['Lead ID', 'Customer', 'Product', 'Bank/NBFC', 'Loan Amount (INR)', 'Field Officer', 'Disbursed Date'];
        rows = data.map((l) => ({
          'Lead ID': l.leadCode,
          Customer: l.customerName,
          Product: l.loanProduct,
          'Bank/NBFC': l.bankNbfc,
          'Loan Amount (INR)': l.loanAmount ?? 0,
          'Field Officer': l.assignedOfficerName || '-',
          'Disbursed Date': l.updatedAt,
        }));
        break;
      }
      case 'pending_followup': {
        title = 'Pending Follow-up Report';
        const data = loadLeads().filter((l) =>
          ['Lead Generated', 'Lead Assigned', 'Follow-up Pending', 'Documents Pending', 'Query Raised'].includes(l.status)
        );
        columns = ['Lead ID', 'Customer', 'Status', 'Assigned Officer', 'Assignment Deadline', 'Last Updated'];
        rows = data.map((l) => ({
          'Lead ID': l.leadCode,
          Customer: l.customerName,
          Status: l.status,
          'Assigned Officer': l.assignedOfficerName || 'Unassigned',
          'Assignment Deadline': l.assignmentDeadlineAt || '-',
          'Last Updated': l.updatedAt,
        }));
        break;
      }
      case 'duplicate_verification': {
        title = 'Duplicate Verification Report';
        columns = ['Request Code', 'Existing Lead', 'Matched Fields', 'Submitted By', 'Decision Status', 'Reviewed By', 'Date'];
        rows = db
          .prepare(`
            SELECT dr.request_code as "Request Code", l.lead_code as "Existing Lead",
              dr.matched_fields_json as "Matched Fields", sub.full_name as "Submitted By",
              dr.status as "Decision Status", COALESCE(rev.full_name, '-') as "Reviewed By", dr.created_at as "Date"
            FROM duplicate_requests dr
            JOIN leads l ON l.id = dr.existing_lead_id
            JOIN users sub ON sub.id = dr.submitted_by
            LEFT JOIN users rev ON rev.id = dr.reviewed_by
            ORDER BY dr.created_at DESC
          `)
          .all() as any[];
        break;
      }
      case 'enquiry': {
        title = 'Enquiry & SLA Report';
        const where = user.role === 'REFERRAL_PARTNER' ? 'WHERE e.referral_user_id = ?' : '';
        const params = user.role === 'REFERRAL_PARTNER' ? [user.id] : [];
        columns = ['Enquiry ID', 'Lead ID', 'Category', 'Status', 'Officer', 'SLA Deadline', 'Created At'];
        rows = db
          .prepare(`
            SELECT e.enquiry_code as "Enquiry ID", COALESCE(l.lead_code, '-') as "Lead ID",
              e.category as "Category", e.status as "Status",
              COALESCE(fo.full_name, '-') as "Officer", e.sla_deadline_at as "SLA Deadline", e.created_at as "Created At"
            FROM enquiries e
            LEFT JOIN leads l ON l.id = e.lead_id
            LEFT JOIN users fo ON fo.id = e.assigned_officer_id
            ${where}
            ORDER BY e.created_at DESC
          `)
          .all(...params) as any[];
        break;
      }
      case 'penalty': {
        title = 'Penalty Register Report';
        columns = ['Penalty Code', 'Employee', 'Lead / Enquiry', 'Type', 'Delay (sec)', 'Amount (INR)', 'Status', 'Created At'];
        rows = db
          .prepare(`
            SELECT p.penalty_code as "Penalty Code", u.full_name as "Employee",
              COALESCE(l.lead_code, e.enquiry_code, '-') as "Lead / Enquiry",
              p.penalty_type as "Type", p.delay_seconds as "Delay (sec)",
              p.amount as "Amount (INR)", p.approval_status as "Status", p.created_at as "Created At"
            FROM penalties p
            JOIN users u ON u.id = p.employee_id
            LEFT JOIN leads l ON l.id = p.lead_id
            LEFT JOIN enquiries e ON e.id = p.enquiry_id
            ORDER BY p.created_at DESC
          `)
          .all() as any[];
        break;
      }
      case 'gps_visit': {
        title = 'GPS Visit & Location Report';
        columns = ['Employee', 'Activity', 'Customer / Lead', 'Latitude', 'Longitude', 'Accuracy (m)', 'Recorded At'];
        rows = db
          .prepare(`
            SELECT u.full_name as "Employee", g.activity_type as "Activity",
              COALESCE(g.customer_name, l.lead_code, '-') as "Customer / Lead",
              ROUND(g.latitude, 5) as "Latitude", ROUND(g.longitude, 5) as "Longitude",
              COALESCE(g.accuracy, 0) as "Accuracy (m)", g.recorded_at as "Recorded At"
            FROM gps_logs g
            JOIN users u ON u.id = g.employee_id
            LEFT JOIN leads l ON l.id = g.lead_id
            ORDER BY g.recorded_at DESC
          `)
          .all() as any[];
        break;
      }
      case 'bike_run':
      case 'petrol_incentive': {
        title = type === 'bike_run' ? 'Bike Run Distance Report' : 'Weekly Petrol Incentive Bill Report (@ ₹3/km)';
        let bikeWhere = '';
        const bikeRepParams: any[] = [];
        if (user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR') {
          bikeWhere = 'WHERE br.employee_id = ?';
          bikeRepParams.push(user.id);
        } else if (user.role === 'TEAM_LEADER') {
          bikeWhere = `WHERE (br.employee_id = ? OR (u.role = 'FIELD_OFFICER' AND (u.reports_to_user_id = ? OR (u.reports_to_user_id IS NULL AND u.team_id = ?))))`;
          bikeRepParams.push(user.id, user.id, user.teamId || -1);
        } else if (user.role === 'BRANCH_MANAGER') {
          bikeWhere = `WHERE (br.employee_id = ? OR u.reports_to_user_id = ? OR (u.branch_id = ? AND u.role IN ('TEAM_LEADER','FIELD_OFFICER')))`;
          bikeRepParams.push(user.id, user.id, user.branchId || -1);
        }
        columns = [
          'Run Code',
          'Employee',
          'Role',
          'Start Date/Time',
          'End Date/Time',
          'Start Meter',
          'Close Meter',
          'GPS Location',
          'Customer Name',
          'Reason for Tour',
          'Total KM',
          'Rate/KM',
          'Gross Bill (INR)',
          'Deducted (INR)',
          'Net Payable (INR)',
          'Approval Status',
          'Reviewed By',
        ];
        rows = db
          .prepare(`
            SELECT br.run_code as "Run Code", u.full_name as "Employee", u.role as "Role",
              br.start_time as "Start Date/Time", COALESCE(br.end_time, 'Active') as "End Date/Time",
              br.opening_odometer as "Start Meter", COALESCE(br.closing_odometer, 0) as "Close Meter",
              CASE
                WHEN COALESCE(br.end_location, '') <> '' THEN COALESCE(br.start_location, '') || ' -> ' || br.end_location
                ELSE COALESCE(br.start_location, printf('%.4f, %.4f', br.start_lat, br.start_lng))
              END as "GPS Location",
              COALESCE(NULLIF(br.customer_name, ''), '-') as "Customer Name",
              COALESCE(NULLIF(br.tour_reason, ''), '-') as "Reason for Tour",
              br.eligible_km as "Total KM",
              br.rate_per_km as "Rate/KM",
              CASE WHEN br.gross_amount > 0 THEN br.gross_amount ELSE ROUND(br.eligible_km * br.rate_per_km, 2) END as "Gross Bill (INR)",
              COALESCE(br.deducted_amount, 0) as "Deducted (INR)",
              br.incentive_amount as "Net Payable (INR)",
              br.approval_status as "Approval Status",
              COALESCE(rev.full_name, '-') as "Reviewed By"
            FROM bike_runs br
            JOIN users u ON u.id = br.employee_id
            LEFT JOIN users rev ON rev.id = br.reviewed_by
            ${bikeWhere}
            ORDER BY br.start_time DESC
          `)
          .all(...bikeRepParams) as any[];
        break;
      }
      case 'attendance': {
        title = 'Daily Self-Attendance & Late Penalty Report';
        let attWhere = '';
        const attParams: any[] = [];
        if (user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR') {
          attWhere = 'WHERE a.employee_id = ?';
          attParams.push(user.id);
        } else if (user.role === 'TEAM_LEADER') {
          attWhere = `WHERE (a.employee_id = ? OR (u.role = 'FIELD_OFFICER' AND (u.reports_to_user_id = ? OR (u.reports_to_user_id IS NULL AND u.team_id = ?))))`;
          attParams.push(user.id, user.id, user.teamId || -1);
        } else if (user.role === 'BRANCH_MANAGER') {
          attWhere = `WHERE (a.employee_id = ? OR u.reports_to_user_id = ? OR (u.branch_id = ? AND u.role IN ('TEAM_LEADER','FIELD_OFFICER','LEAD_GENERATOR')))`;
          attParams.push(user.id, user.id, user.branchId || -1);
        }
        columns = [
          'Attendance Code',
          'Employee',
          'Role',
          'Date',
          'Auto Time (IST)',
          'Auto GPS Location',
          'Office Distance (m)',
          'Status',
          'Self Approved',
          'Delay (Min)',
          'Late Penalty (INR)',
        ];
        rows = db
          .prepare(`
            SELECT a.attendance_code as "Attendance Code", u.full_name as "Employee", u.role as "Role",
              a.attendance_date as "Date", a.marked_time_ist as "Auto Time (IST)",
              a.location_label as "Auto GPS Location", a.distance_meters as "Office Distance (m)",
              a.status as "Status", CASE WHEN a.self_approved = 1 THEN 'Yes' ELSE 'No' END as "Self Approved",
              a.delay_minutes as "Delay (Min)", a.delay_penalty_amount as "Late Penalty (INR)"
            FROM attendance_logs a
            JOIN users u ON u.id = a.employee_id
            ${attWhere}
            ORDER BY a.attendance_date DESC, a.marked_at DESC
          `)
          .all(...attParams) as any[];
        break;
      }
      case 'leave': {
        title = 'Leave & Seniority Approval Penalty Report';
        let lvWhere = '';
        const lvParams: any[] = [];
        if (user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR') {
          lvWhere = 'WHERE lr.employee_id = ?';
          lvParams.push(user.id);
        } else if (user.role === 'TEAM_LEADER') {
          lvWhere = `WHERE (lr.employee_id = ? OR (u.role = 'FIELD_OFFICER' AND (u.reports_to_user_id = ? OR (u.reports_to_user_id IS NULL AND u.team_id = ?))))`;
          lvParams.push(user.id, user.id, user.teamId || -1);
        } else if (user.role === 'BRANCH_MANAGER') {
          lvWhere = `WHERE (lr.employee_id = ? OR u.reports_to_user_id = ? OR (u.branch_id = ? AND u.role IN ('TEAM_LEADER','FIELD_OFFICER','LEAD_GENERATOR')))`;
          lvParams.push(user.id, user.id, user.branchId || -1);
        }
        columns = [
          'Leave Code',
          'Employee',
          'Role',
          'From Date',
          'To Date',
          'Days',
          'Type',
          'Leave Reason',
          'Required Approver',
          'Status',
          'Reviewed By',
          'Unapproved Penalty (INR)',
        ];
        rows = db
          .prepare(`
            SELECT lr.leave_code as "Leave Code", u.full_name as "Employee", u.role as "Role",
              lr.from_date as "From Date", lr.to_date as "To Date", lr.total_days as "Days",
              lr.leave_type as "Type", lr.reason as "Leave Reason",
              lr.expected_approver_role as "Required Approver", lr.approval_status as "Status",
              COALESCE(rev.full_name, '-') as "Reviewed By",
              lr.unapproved_penalty_amount as "Unapproved Penalty (INR)"
            FROM leave_requests lr
            JOIN users u ON u.id = lr.employee_id
            LEFT JOIN users rev ON rev.id = lr.reviewed_by
            ${lvWhere}
            ORDER BY lr.created_at DESC
          `)
          .all(...lvParams) as any[];
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown report type' });
        return;
    }

    res.json({ title, columns, rows, generatedAt: nowSql() });
  });

  // Admin: User Management, Hierarchy Quotas (1 BM -> 10 TL -> 10 FO -> 50 Referrals), Back Office & Referral ID Console
  router.get(
    '/admin/users',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER', 'LEAD_GENERATOR'),
    (req: AuthedRequest, res) => {
      const childCountRows = db
        .prepare(`
          SELECT reports_to_user_id as parentId, role as childRole, COUNT(*) as cnt
          FROM users
          WHERE is_active = 1 AND reports_to_user_id IS NOT NULL
          GROUP BY reports_to_user_id, role
        `)
        .all() as { parentId: number; childRole: UserRole; cnt: number }[];

      const childCountsMap = new Map<string, number>();
      for (const c of childCountRows) {
        childCountsMap.set(`${c.parentId}:${c.childRole}`, Number(c.cnt));
      }

      const users = db
        .prepare(`
          SELECT u.id, u.employee_code as employeeCode, u.full_name as fullName, u.mobile, u.email,
            u.role, u.branch_id as branchId, b.name as branchName, u.team_id as teamId, t.name as teamName,
            u.reports_to_user_id as reportsToUserId, rep.full_name as reportsToName, rep.employee_code as reportsToCode,
            u.referral_code as referralCode, u.service_city as serviceCity, u.service_pincodes as servicePincodes,
            u.profile_photo_data_url as profilePhotoDataUrl,
            u.admin_saved_password_enc as adminSavedPasswordEnc,
            u.is_active as isActive, u.otp_enabled as otpEnabled,
            u.gps_consent as gpsConsent, u.camera_consent as cameraConsent, u.created_at as createdAt
          FROM users u
          LEFT JOIN branches b ON b.id = u.branch_id
          LEFT JOIN teams t ON t.id = u.team_id
          LEFT JOIN users rep ON rep.id = u.reports_to_user_id
          ORDER BY CASE WHEN u.role = 'SUPER_ADMIN' THEN 0 ELSE 1 END, u.id DESC
        `)
        .all()
        .map((u: any) => {
          let childCount = 0;
          let quotaMax: number | null = null;
          if (u.role === 'BRANCH_MANAGER') {
            childCount = childCountsMap.get(`${u.id}:TEAM_LEADER`) ?? 0;
            quotaMax = HIERARCHY_LIMITS.TEAM_LEADERS_PER_BM;
          } else if (u.role === 'TEAM_LEADER') {
            childCount = childCountsMap.get(`${u.id}:FIELD_OFFICER`) ?? 0;
            quotaMax = HIERARCHY_LIMITS.FIELD_OFFICERS_PER_TL;
          } else if (u.role === 'FIELD_OFFICER') {
            childCount = childCountsMap.get(`${u.id}:REFERRAL_PARTNER`) ?? 0;
            quotaMax = HIERARCHY_LIMITS.REFERRALS_PER_FO;
          }
          const { adminSavedPasswordEnc, ...rest } = u;
          let savedPassword: string | null = null;
          if (req.user!.role === 'SUPER_ADMIN' && adminSavedPasswordEnc) {
            try {
              savedPassword = decryptPii(adminSavedPasswordEnc) || null;
            } catch {
              savedPassword = null;
            }
          }
          return {
            ...rest,
            savedPassword,
            isActive: Boolean(u.isActive),
            otpEnabled: Boolean(u.otpEnabled),
            gpsConsent: Boolean(u.gpsConsent),
            cameraConsent: Boolean(u.cameraConsent),
            childCount,
            quotaMax,
          };
        });
      res.json({ users, hierarchyLimits: HIERARCHY_LIMITS });
    }
  );

  const VALID_USER_ROLES: UserRole[] = [
    'SUPER_ADMIN',
    'BRANCH_MANAGER',
    'TEAM_LEADER',
    'LEAD_GENERATOR',
    'FIELD_OFFICER',
    'REFERRAL_PARTNER',
  ];

  function generateReadablePassword(length = 8): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#';
    let out = '';
    for (let i = 0; i < length; i++) {
      out += chars[crypto.randomInt(0, chars.length)];
    }
    return out;
  }

  function validateParentHierarchyAndCapacity(
    role: UserRole,
    reportsToUserId: number | null | undefined,
    additionalCount = 1,
    excludeUserId?: number
  ): { ok: true; parentId: number | null; branchId: number | null; teamId: number | null } | { ok: false; error: string } {
    const ruleMap: Partial<Record<UserRole, { parentRole: UserRole; label: string; childLabel: string; max: number }>> = {
      TEAM_LEADER: {
        parentRole: 'BRANCH_MANAGER',
        label: 'Branch Manager (BM)',
        childLabel: 'Team Leader IDs',
        max: HIERARCHY_LIMITS.TEAM_LEADERS_PER_BM,
      },
      FIELD_OFFICER: {
        parentRole: 'TEAM_LEADER',
        label: 'Team Leader (TL)',
        childLabel: 'Field Officer IDs',
        max: HIERARCHY_LIMITS.FIELD_OFFICERS_PER_TL,
      },
      REFERRAL_PARTNER: {
        parentRole: 'FIELD_OFFICER',
        label: 'Field Officer (FO)',
        childLabel: 'Referral IDs',
        max: HIERARCHY_LIMITS.REFERRALS_PER_FO,
      },
    };

    const rule = ruleMap[role];
    if (!rule) {
      return { ok: true, parentId: null, branchId: null, teamId: null };
    }

    const parentNum = reportsToUserId ? Number(reportsToUserId) : 0;
    if (!parentNum) {
      return {
        ok: false,
        error: `Please select a reporting ${rule.label}. Hierarchy rule: 1 BM -> max ${HIERARCHY_LIMITS.TEAM_LEADERS_PER_BM} TLs -> max ${HIERARCHY_LIMITS.FIELD_OFFICERS_PER_TL} FOs -> max ${HIERARCHY_LIMITS.REFERRALS_PER_FO} Referrals.`,
      };
    }

    const parent = db
      .prepare(`SELECT id, employee_code, full_name, role, branch_id, team_id, is_active FROM users WHERE id = ?`)
      .get(parentNum) as any;
    if (!parent || !parent.is_active || parent.role !== rule.parentRole) {
      return { ok: false, error: `Selected reporting ${rule.label} was not found or is inactive.` };
    }

    const countRow = db
      .prepare(`
        SELECT COUNT(*) as cnt
        FROM users
        WHERE is_active = 1 AND role = ? AND reports_to_user_id = ?
          AND (? IS NULL OR id != ?)
      `)
      .get(role, parent.id, excludeUserId ?? null, excludeUserId ?? -1) as { cnt: number };

    const currentCount = Number(countRow?.cnt ?? 0);
    if (currentCount + additionalCount > rule.max) {
      const remaining = Math.max(0, rule.max - currentCount);
      return {
        ok: false,
        error: `Hierarchy limit reached: ${parent.full_name} (${parent.employee_code}) already has ${currentCount}/${rule.max} active ${rule.childLabel}. Remaining capacity: ${remaining}.`,
      };
    }

    return {
      ok: true,
      parentId: Number(parent.id),
      branchId: parent.branch_id ? Number(parent.branch_id) : null,
      teamId: parent.team_id ? Number(parent.team_id) : null,
    };
  }

  router.post('/admin/users', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const {
      employeeCode,
      fullName,
      mobile,
      email,
      password,
      role,
      branchId,
      teamId,
      reportsToUserId,
      referralCode,
      serviceCity,
      servicePincodes,
      otpEnabled,
    } = req.body as Record<string, any>;

    const cleanCode = String(employeeCode || '').trim().replace(/\s+/g, '').toUpperCase();
    const cleanPass = String(password || '').trim();
    const cleanRole = String(role || 'FIELD_OFFICER') as UserRole;
    const cleanName = String(fullName || cleanCode).trim();
    const cleanMobile = String(mobile || '').trim();

    if (!cleanCode || !cleanPass || !VALID_USER_ROLES.includes(cleanRole)) {
      res.status(400).json({ error: 'Employee ID, Password (non-empty), and valid Role are required' });
      return;
    }

    const existing = db
      .prepare(`SELECT id FROM users WHERE UPPER(REPLACE(employee_code, ' ', '')) = UPPER(?)`)
      .get(cleanCode);
    if (existing) {
      res.status(409).json({ error: `Employee ID "${cleanCode}" already exists. Use another ID or Auto-Generate.` });
      return;
    }

    const hierCheck = validateParentHierarchyAndCapacity(cleanRole, reportsToUserId, 1);
    if (hierCheck.ok === false) {
      res.status(400).json({ error: hierCheck.error });
      return;
    }

    const resolvedBranchId = hierCheck.branchId ?? (branchId ? Number(branchId) : null);
    let resolvedTeamId = cleanRole === 'FIELD_OFFICER' || cleanRole === 'REFERRAL_PARTNER'
      ? (hierCheck.teamId ?? (teamId ? Number(teamId) : null))
      : (teamId ? Number(teamId) : null);

    const hash = bcrypt.hashSync(cleanPass, 10);
    const cleanRefCode =
      referralCode && String(referralCode).trim()
        ? String(referralCode).trim().toUpperCase()
        : cleanRole === 'REFERRAL_PARTNER'
          ? `DSA-${cleanCode}`
          : null;

    try {
      const inserted = db
        .prepare(`
          INSERT INTO users (employee_code, full_name, mobile, email, password_hash, admin_saved_password_enc, role, branch_id, team_id, reports_to_user_id, referral_code, service_city, service_pincodes, is_active, otp_enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `)
        .run(
          cleanCode,
          cleanName,
          cleanMobile,
          String(email || `${cleanCode.toLowerCase()}@ambikaassociate.in`).trim(),
          hash,
          encryptPii(cleanPass),
          cleanRole,
          resolvedBranchId,
          resolvedTeamId,
          hierCheck.parentId,
          cleanRefCode,
          serviceCity ? String(serviceCity).trim() : null,
          servicePincodes ? String(servicePincodes).trim() : null,
          otpEnabled ? 1 : 0
        );

      const newUserId = Number(inserted.lastInsertRowid);
      if (cleanRole === 'TEAM_LEADER' && !resolvedTeamId && resolvedBranchId) {
        const teamIns = db
          .prepare(`INSERT INTO teams (branch_id, name, leader_user_id) VALUES (?, ?, ?)`)
          .run(resolvedBranchId, `${cleanName} Team (${cleanCode})`, newUserId);
        resolvedTeamId = Number(teamIns.lastInsertRowid);
        db.prepare(`UPDATE users SET team_id = ? WHERE id = ?`).run(resolvedTeamId, newUserId);
      }

      syncUsersBackupToDisk();
      logAudit(admin, 'USER_CREATED', 'USER', cleanCode, `Created ${cleanRole} login ID ${cleanCode} (${cleanName})`);
      broadcastLiveSync('HIERARCHY_UPDATED', `New ${cleanRole} ID ${cleanCode} (${cleanName}) added by Admin`, admin);
      res.status(201).json({
        ok: true,
        id: newUserId,
        created: {
          id: newUserId,
          employeeCode: cleanCode,
          password: cleanPass,
          fullName: cleanName,
          mobile: cleanMobile,
          role: cleanRole,
          reportsToUserId: hierCheck.parentId,
          branchId: resolvedBranchId,
          teamId: resolvedTeamId,
          isActive: true,
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Could not create employee ID (duplicate code or referral ID)' });
    }
  });

  // Unlimited Batch Employee ID & Password Generator (Super Admin Only — respects 1 BM -> 10 TL -> 10 FO -> 50 Referrals)
  router.post('/admin/users/bulk', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const {
      prefix = 'EMP',
      count = 1,
      role = 'FIELD_OFFICER',
      branchId = 1,
      reportsToUserId = null,
      namePrefix = 'Staff',
      passwordMode = 'random',
      commonPassword = '',
      serviceCity = '',
      servicePincodes = '',
    } = req.body as Record<string, any>;

    const cleanPrefix = String(prefix || 'EMP')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '');
    const qty = Math.floor(Number(count));
    const cleanRole = String(role || 'FIELD_OFFICER') as UserRole;

    if (!cleanPrefix) {
      res.status(400).json({ error: 'Employee ID Prefix is required' });
      return;
    }
    if (!Number.isFinite(qty) || qty < 1) {
      res.status(400).json({ error: 'Count must be at least 1' });
      return;
    }
    if (!VALID_USER_ROLES.includes(cleanRole)) {
      res.status(400).json({ error: 'Invalid role selected' });
      return;
    }
    if (passwordMode === 'custom' && !String(commonPassword || '').trim()) {
      res.status(400).json({ error: 'Initial password is required when using custom shared password' });
      return;
    }

    const hierCheck = validateParentHierarchyAndCapacity(cleanRole, reportsToUserId, qty);
    if (hierCheck.ok === false) {
      res.status(400).json({ error: hierCheck.error });
      return;
    }

    const existingRows = db.prepare(`SELECT employee_code FROM users`).all() as { employee_code: string }[];
    const existingSet = new Set(existingRows.map((r) => r.employee_code.toUpperCase()));
    let maxSeq = 0;
    const prefixRegex = new RegExp(`^${cleanPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`, 'i');
    for (const r of existingRows) {
      const m = r.employee_code.match(prefixRegex);
      if (m && m[1]) {
        const n = Number.parseInt(m[1], 10);
        if (n > maxSeq) maxSeq = n;
      }
    }

    const stmt = db.prepare(`
      INSERT INTO users (employee_code, full_name, mobile, email, password_hash, admin_saved_password_enc, role, branch_id, team_id, reports_to_user_id, referral_code, service_city, service_pincodes, is_active, otp_enabled)
      VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
    `);

    const createdList: {
      id: number;
      employeeCode: string;
      password: string;
      fullName: string;
      role: UserRole;
      branchId: number | null;
      reportsToUserId: number | null;
      isActive: boolean;
    }[] = [];

    const cleanNamePrefix = String(namePrefix || 'Staff').trim() || 'Staff';
    const resolvedBranchId = hierCheck.branchId ?? (branchId ? Number(branchId) : null);
    const inheritedTeamId =
      cleanRole === 'FIELD_OFFICER' || cleanRole === 'REFERRAL_PARTNER' ? hierCheck.teamId : null;
    const resolvedCity = serviceCity ? String(serviceCity).trim() : null;
    const resolvedPins = servicePincodes ? String(servicePincodes).trim() : null;

    const runBatch = db.transaction(() => {
      let seq = maxSeq + 1;
      for (let i = 0; i < qty; i++) {
        let code = `${cleanPrefix}${String(seq).padStart(3, '0')}`;
        while (existingSet.has(code)) {
          seq++;
          code = `${cleanPrefix}${String(seq).padStart(3, '0')}`;
        }
        existingSet.add(code);
        seq++;

        const plainPassword =
          passwordMode === 'custom' ? String(commonPassword || '').trim() : generateReadablePassword(8);
        const passHash = bcrypt.hashSync(plainPassword, 10);
        const fullName = `${cleanNamePrefix} ${code}`;
        const email = `${code.toLowerCase()}@ambikaassociate.in`;
        const refCode = cleanRole === 'REFERRAL_PARTNER' ? `DSA-${code}` : null;

        const info = stmt.run(
          code,
          fullName,
          email,
          passHash,
          encryptPii(plainPassword),
          cleanRole,
          resolvedBranchId,
          inheritedTeamId,
          hierCheck.parentId,
          refCode,
          resolvedCity,
          resolvedPins
        );

        const createdId = Number(info.lastInsertRowid);
        if (cleanRole === 'TEAM_LEADER' && resolvedBranchId) {
          const teamIns = db
            .prepare(`INSERT INTO teams (branch_id, name, leader_user_id) VALUES (?, ?, ?)`)
            .run(resolvedBranchId, `${fullName} Team (${code})`, createdId);
          db.prepare(`UPDATE users SET team_id = ? WHERE id = ?`).run(Number(teamIns.lastInsertRowid), createdId);
        }

        createdList.push({
          id: createdId,
          employeeCode: code,
          password: plainPassword,
          fullName,
          role: cleanRole,
          branchId: resolvedBranchId,
          reportsToUserId: hierCheck.parentId,
          isActive: true,
        });
      }
    });

    runBatch();
    syncUsersBackupToDisk();

    logAudit(
      admin,
      'BULK_USERS_CREATED',
      'USER',
      cleanPrefix,
      `Generated ${createdList.length} ${cleanRole} login IDs (${createdList[0]?.employeeCode} .. ${createdList[createdList.length - 1]?.employeeCode})`
    );
    broadcastLiveSync(
      'HIERARCHY_UPDATED',
      `${createdList.length} new ${cleanRole} IDs (${createdList[0]?.employeeCode}..) created by Admin`,
      admin
    );
    res.status(201).json({ ok: true, count: createdList.length, created: createdList });
  });

  router.patch('/admin/users/:id', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const targetId = Number(req.params.id);
    const {
      employeeCode,
      referralCode,
      fullName,
      mobile,
      role,
      branchId,
      teamId,
      reportsToUserId,
      serviceCity,
      servicePincodes,
      isActive,
      otpEnabled,
      newPassword,
    } = req.body as Record<string, any>;

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as any;
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (typeof isActive === 'boolean' && !isActive && targetId === admin.id) {
      res.status(400).json({ error: 'You cannot turn OFF your own active Super Admin login ID.' });
      return;
    }

    let renamedEmpCode: string | null = null;
    if (employeeCode !== undefined) {
      const cleanNewCode = String(employeeCode || '').trim().replace(/\s+/g, '').toUpperCase();
      if (!cleanNewCode || !/^[A-Z0-9_-]{2,32}$/.test(cleanNewCode)) {
        res.status(400).json({
          error: 'Employee ID must be 2–32 characters using letters, numbers, "-" or "_" (no spaces).',
        });
        return;
      }
      if (cleanNewCode.toUpperCase() !== String(target.employee_code || '').toUpperCase()) {
        const dupCode = db
          .prepare(`SELECT id FROM users WHERE UPPER(REPLACE(employee_code, ' ', '')) = UPPER(?) AND id != ?`)
          .get(cleanNewCode, targetId);
        if (dupCode) {
          res.status(409).json({ error: `Employee ID "${cleanNewCode}" already exists. Choose a different ID.` });
          return;
        }
        renamedEmpCode = cleanNewCode;
      }
    }

    let renamedRefCode: string | null | undefined = undefined;
    if (referralCode !== undefined) {
      const cleanNewRef = String(referralCode || '').trim().replace(/\s+/g, '').toUpperCase();
      if (cleanNewRef && !/^[A-Z0-9_-]{2,36}$/.test(cleanNewRef)) {
        res.status(400).json({
          error: 'Referral Code must be 2–36 characters using letters, numbers, "-" or "_" (no spaces).',
        });
        return;
      }
      const oldRef = String(target.referral_code || '').toUpperCase();
      if (cleanNewRef !== oldRef) {
        if (cleanNewRef) {
          const dupRef = db
            .prepare(`SELECT id FROM users WHERE UPPER(REPLACE(referral_code, ' ', '')) = UPPER(?) AND id != ?`)
            .get(cleanNewRef, targetId);
          if (dupRef) {
            res.status(409).json({ error: `Referral Code "${cleanNewRef}" already exists. Choose another code.` });
            return;
          }
        }
        renamedRefCode = cleanNewRef || null;
      }
    }

    const {
      transferExistingDownlineToUserId,
    } = req.body as Record<string, any>;

    const nextRole = role !== undefined && VALID_USER_ROLES.includes(role) ? (role as UserRole) : (target.role as UserRole);
    const roleChanged = nextRole !== (target.role as UserRole);

    if (roleChanged && targetId === admin.id && nextRole !== 'SUPER_ADMIN') {
      res.status(400).json({ error: 'You cannot change your own active Super Admin designation.' });
      return;
    }

    if (roleChanged && target.role === 'SUPER_ADMIN' && nextRole !== 'SUPER_ADMIN') {
      const otherAdmins = db
        .prepare(`SELECT COUNT(*) as cnt FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1 AND id != ?`)
        .get(targetId) as { cnt: number };
      if (Number(otherAdmins?.cnt ?? 0) === 0) {
        res.status(400).json({ error: 'At least one active Super Admin account must remain in the system.' });
        return;
      }
    }

    const isTopLevelNextRole = ['SUPER_ADMIN', 'BRANCH_MANAGER', 'LEAD_GENERATOR'].includes(nextRole);
    const nextParentId = isTopLevelNextRole
      ? null
      : reportsToUserId !== undefined
      ? reportsToUserId
        ? Number(reportsToUserId)
        : null
      : target.reports_to_user_id;

    if (nextParentId && Number(nextParentId) === targetId) {
      res.status(400).json({ error: 'An employee cannot report to themselves.' });
      return;
    }

    const nextActive = typeof isActive === 'boolean' ? isActive : Boolean(target.is_active);
    const needsCapacityValidation =
      nextActive &&
      ['TEAM_LEADER', 'FIELD_OFFICER', 'REFERRAL_PARTNER'].includes(nextRole) &&
      (reportsToUserId !== undefined || roleChanged || (typeof isActive === 'boolean' && isActive && !target.is_active));

    let syncedBranchId: number | null | undefined = branchId !== undefined ? (branchId ? Number(branchId) : null) : undefined;
    let syncedTeamId: number | null | undefined = teamId !== undefined ? (teamId ? Number(teamId) : null) : undefined;

    if (needsCapacityValidation) {
      const hierCheck = validateParentHierarchyAndCapacity(nextRole, nextParentId, 1, targetId);
      if (hierCheck.ok === false) {
        res.status(400).json({ error: hierCheck.error });
        return;
      }
      if (hierCheck.branchId) syncedBranchId = hierCheck.branchId;
      if ((nextRole === 'FIELD_OFFICER' || nextRole === 'REFERRAL_PARTNER') && hierCheck.teamId) {
        syncedTeamId = hierCheck.teamId;
      }
    }

    // If designation/role changed and this employee currently has direct downline staff,
    // validate optional replacement senior transfer before mutating anything.
    const existingChildren = roleChanged
      ? (db
          .prepare(`SELECT id, employee_code, full_name, role, is_active FROM users WHERE reports_to_user_id = ?`)
          .all(targetId) as { id: number; employee_code: string; full_name: string; role: UserRole; is_active: number }[])
      : [];

    let replacementSenior: any = null;
    if (roleChanged && existingChildren.length > 0 && transferExistingDownlineToUserId) {
      const repId = Number(transferExistingDownlineToUserId);
      if (repId === targetId) {
        res.status(400).json({ error: 'Replacement senior cannot be the same employee whose designation is changing.' });
        return;
      }
      replacementSenior = db
        .prepare(`SELECT id, employee_code, full_name, role, branch_id, team_id, is_active FROM users WHERE id = ?`)
        .get(repId) as any;
      if (!replacementSenior || !replacementSenior.is_active || replacementSenior.role !== target.role) {
        res.status(400).json({
          error: `Replacement senior must be an active ${String(target.role).replace(/_/g, ' ')}.`,
        });
        return;
      }
      const activeChildRole = existingChildren[0].role;
      const activeChildCount = existingChildren.filter((c) => c.is_active).length;
      if (activeChildCount > 0) {
        const capCheck = validateParentHierarchyAndCapacity(activeChildRole, repId, activeChildCount);
        if (capCheck.ok === false) {
          res.status(400).json({ error: `Cannot transfer downline to ${replacementSenior.full_name}: ${capCheck.error}` });
          return;
        }
      }
    }

    if (renamedEmpCode) {
      const oldEmpCode = String(target.employee_code || '');
      db.prepare('UPDATE users SET employee_code = ? WHERE id = ?').run(renamedEmpCode, targetId);
      const expectedAutoEmail = `${oldEmpCode.toLowerCase()}@ambikaassociate.in`;
      if (String(target.email || '').toLowerCase() === expectedAutoEmail) {
        const nextAutoEmail = `${renamedEmpCode.toLowerCase()}@ambikaassociate.in`;
        const emailConflict = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?').get(nextAutoEmail, targetId);
        if (!emailConflict) {
          db.prepare('UPDATE users SET email = ? WHERE id = ?').run(nextAutoEmail, targetId);
        }
      }
      logAudit(
        admin,
        'USER_ID_RENAMED',
        'USER',
        renamedEmpCode,
        `Renamed Employee ID from ${oldEmpCode} to ${renamedEmpCode} (${target.full_name})`
      );
    }

    if (renamedRefCode !== undefined) {
      const oldRefCode = target.referral_code ? String(target.referral_code) : null;
      db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(renamedRefCode, targetId);
      if (oldRefCode && renamedRefCode) {
        db.prepare('UPDATE leads SET referral_id = ? WHERE UPPER(referral_id) = UPPER(?)').run(renamedRefCode, oldRefCode);
      }
      logAudit(
        admin,
        'REFERRAL_CODE_RENAMED',
        'USER',
        renamedEmpCode || target.employee_code,
        `Renamed Referral Code from ${oldRefCode || 'none'} to ${renamedRefCode || 'none'} (${target.full_name})`
      );
    }

    if (fullName !== undefined && String(fullName).trim()) {
      db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(String(fullName).trim(), targetId);
    }
    if (mobile !== undefined) {
      db.prepare('UPDATE users SET mobile = ? WHERE id = ?').run(String(mobile || '').trim(), targetId);
    }

    let transferredChildCount = 0;
    if (roleChanged) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(nextRole, targetId);
      // Auto-assign a unique referral code if promoted/changed to REFERRAL_PARTNER without one
      if (nextRole === 'REFERRAL_PARTNER' && !target.referral_code && renamedRefCode === undefined) {
        const baseRef = `DSA-${renamedEmpCode || target.employee_code}`;
        const conflict = db.prepare(`SELECT id FROM users WHERE UPPER(referral_code) = UPPER(?) AND id != ?`).get(baseRef, targetId);
        const autoRef = conflict ? `${baseRef}-${targetId}` : baseRef;
        db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(autoRef, targetId);
      }
      // Handle existing downline children of the old role
      if (existingChildren.length > 0) {
        if (replacementSenior) {
          db.prepare(
            `UPDATE users SET reports_to_user_id = ?, branch_id = COALESCE(?, branch_id), team_id = COALESCE(?, team_id) WHERE reports_to_user_id = ?`
          ).run(
            replacementSenior.id,
            replacementSenior.branch_id ?? null,
            replacementSenior.team_id ?? null,
            targetId
          );
          if (target.role === 'BRANCH_MANAGER') {
            db.prepare(`UPDATE leads SET assigned_bm_id = ? WHERE assigned_bm_id = ? AND status NOT IN ('Disbursed', 'Closed')`).run(
              replacementSenior.id,
              targetId
            );
          } else if (target.role === 'TEAM_LEADER') {
            db.prepare(`UPDATE leads SET assigned_tl_id = ? WHERE assigned_tl_id = ? AND status NOT IN ('Disbursed', 'Closed')`).run(
              replacementSenior.id,
              targetId
            );
          }
          transferredChildCount = existingChildren.length;
        } else {
          db.prepare(`UPDATE users SET reports_to_user_id = NULL WHERE reports_to_user_id = ?`).run(targetId);
        }
      }
      logAudit(
        admin,
        'DESIGNATION_CHANGED',
        'USER',
        renamedEmpCode || target.employee_code,
        `Changed designation of ${target.full_name} (${renamedEmpCode || target.employee_code}) from ${target.role} to ${nextRole}${
          transferredChildCount > 0 && replacementSenior
            ? ` and transferred ${transferredChildCount} downline member(s) to ${replacementSenior.full_name} (${replacementSenior.employee_code})`
            : ''
        }`
      );
    }

    const parentActuallyChanged =
      (reportsToUserId !== undefined || isTopLevelNextRole) &&
      Number(nextParentId || 0) !== Number(target.reports_to_user_id || 0);

    if (reportsToUserId !== undefined || isTopLevelNextRole) {
      db.prepare('UPDATE users SET reports_to_user_id = ? WHERE id = ?').run(nextParentId, targetId);
      if (parentActuallyChanged && nextParentId) {
        if (nextRole === 'TEAM_LEADER') {
          db.prepare(`UPDATE leads SET assigned_bm_id = ? WHERE assigned_tl_id = ? AND status NOT IN ('Disbursed', 'Closed')`).run(
            nextParentId,
            targetId
          );
        } else if (nextRole === 'FIELD_OFFICER') {
          const newTl = db.prepare(`SELECT reports_to_user_id FROM users WHERE id = ?`).get(nextParentId) as { reports_to_user_id: number | null } | undefined;
          db.prepare(
            `UPDATE leads SET assigned_tl_id = ?, assigned_bm_id = COALESCE(?, assigned_bm_id) WHERE assigned_officer_id = ? AND status NOT IN ('Disbursed', 'Closed')`
          ).run(nextParentId, newTl?.reports_to_user_id ?? null, targetId);
        }
      }
    }
    if (syncedBranchId !== undefined) {
      db.prepare('UPDATE users SET branch_id = ? WHERE id = ?').run(syncedBranchId, targetId);
    }
    if (syncedTeamId !== undefined) {
      db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(syncedTeamId, targetId);
    }
    if (serviceCity !== undefined) {
      db.prepare('UPDATE users SET service_city = ? WHERE id = ?').run(serviceCity ? String(serviceCity).trim() : null, targetId);
    }
    if (servicePincodes !== undefined) {
      db.prepare('UPDATE users SET service_pincodes = ? WHERE id = ?').run(servicePincodes ? String(servicePincodes).trim() : null, targetId);
    }
    if (typeof isActive === 'boolean') {
      db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, targetId);
      if (!isActive) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
        db.prepare('DELETE FROM otp_challenges WHERE user_id = ?').run(targetId);
      }
      logAudit(
        admin,
        isActive ? 'LOGIN_ID_ON' : 'LOGIN_ID_OFF',
        'USER',
        renamedEmpCode || target.employee_code,
        `${isActive ? 'Turned ON' : 'Turned OFF'} login ID ${renamedEmpCode || target.employee_code} (${target.full_name})`
      );
    }
    if (typeof otpEnabled === 'boolean') db.prepare('UPDATE users SET otp_enabled = ? WHERE id = ?').run(otpEnabled ? 1 : 0, targetId);
    if (newPassword && String(newPassword).trim()) {
      const cleanNewPass = String(newPassword).trim();
      db.prepare('UPDATE users SET password_hash = ?, admin_saved_password_enc = ? WHERE id = ?').run(
        bcrypt.hashSync(cleanNewPass, 10),
        encryptPii(cleanNewPass),
        targetId
      );
      logAudit(
        admin,
        'PASSWORD_RESET',
        'USER',
        renamedEmpCode || target.employee_code,
        `Updated password for login ID ${renamedEmpCode || target.employee_code}`
      );
    }

    syncUsersBackupToDisk();
    if (typeof isActive !== 'boolean' && !newPassword && !renamedEmpCode && renamedRefCode === undefined && !roleChanged) {
      logAudit(
        admin,
        'USER_UPDATED',
        'USER',
        renamedEmpCode || target.employee_code,
        `Updated permissions/hierarchy/territory for ${target.full_name}`
      );
    }
    broadcastLiveSync(
      'HIERARCHY_UPDATED',
      renamedEmpCode
        ? `Employee ID renamed to ${renamedEmpCode} (${target.full_name})`
        : roleChanged
        ? `Designation changed to ${nextRole.replace(/_/g, ' ')} for ${target.full_name}`
        : `Staff profile/hierarchy updated for ${target.full_name} (${renamedEmpCode || target.employee_code})`,
      admin
    );
    res.json({
      ok: true,
      employeeCode: renamedEmpCode || target.employee_code,
      referralCode: renamedRefCode !== undefined ? renamedRefCode : target.referral_code,
      role: nextRole,
      transferredChildCount,
    });
  });

  // Bulk or Single Downline Transfer to Another Senior (Super Admin Only)
  router.post('/admin/users/transfer-downline', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const { employeeIds, targetSeniorId } = req.body as {
      employeeIds?: number[];
      targetSeniorId?: number;
    };

    const cleanIds = Array.from(
      new Set((Array.isArray(employeeIds) ? employeeIds : []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))
    );
    const nextSeniorId = Number(targetSeniorId || 0);

    if (cleanIds.length === 0 || !nextSeniorId) {
      res.status(400).json({ error: 'Please select at least one downline employee and a destination senior.' });
      return;
    }
    if (cleanIds.includes(nextSeniorId)) {
      res.status(400).json({ error: 'Cannot transfer an employee under themselves.' });
      return;
    }

    const senior = db
      .prepare(`SELECT id, employee_code, full_name, role, branch_id, team_id, reports_to_user_id, is_active FROM users WHERE id = ?`)
      .get(nextSeniorId) as any;
    if (!senior || !senior.is_active) {
      res.status(404).json({ error: 'Selected destination senior was not found or is currently OFF (inactive).' });
      return;
    }

    const expectedChildRoleMap: Partial<Record<UserRole, { childRole: UserRole; max: number; label: string }>> = {
      BRANCH_MANAGER: { childRole: 'TEAM_LEADER', max: HIERARCHY_LIMITS.TEAM_LEADERS_PER_BM, label: 'Team Leaders' },
      TEAM_LEADER: { childRole: 'FIELD_OFFICER', max: HIERARCHY_LIMITS.FIELD_OFFICERS_PER_TL, label: 'Field Officers' },
      FIELD_OFFICER: { childRole: 'REFERRAL_PARTNER', max: HIERARCHY_LIMITS.REFERRALS_PER_FO, label: 'Referral Partners' },
    };

    const mappingRule = expectedChildRoleMap[senior.role as UserRole];
    if (!mappingRule) {
      res.status(400).json({
        error: 'Destination senior must be a Branch Manager (for TLs), Team Leader (for FOs), or Field Officer (for Referrals).',
      });
      return;
    }

    const employees = db
      .prepare(
        `SELECT id, employee_code, full_name, role, reports_to_user_id, is_active FROM users WHERE id IN (${cleanIds
          .map(() => '?')
          .join(',')})`
      )
      .all(...cleanIds) as any[];

    if (employees.length === 0) {
      res.status(404).json({ error: 'No matching employees found to transfer.' });
      return;
    }

    const invalidRoleEmp = employees.find((e) => e.role !== mappingRule.childRole);
    if (invalidRoleEmp) {
      res.status(400).json({
        error: `${invalidRoleEmp.full_name} (${invalidRoleEmp.employee_code}) is a ${String(invalidRoleEmp.role).replace(
          /_/g,
          ' '
        )} and cannot be mapped under ${senior.full_name} (${String(senior.role).replace(/_/g, ' ')}).`,
      });
      return;
    }

    // Count how many newly added ACTIVE children will increase target senior's quota
    const newlyAddedActiveCount = employees.filter(
      (e) => Boolean(e.is_active) && Number(e.reports_to_user_id || 0) !== nextSeniorId
    ).length;

    if (newlyAddedActiveCount > 0) {
      const capCheck = validateParentHierarchyAndCapacity(mappingRule.childRole, nextSeniorId, newlyAddedActiveCount);
      if (capCheck.ok === false) {
        res.status(400).json({ error: capCheck.error });
        return;
      }
    }

    const transferTx = db.transaction(() => {
      const updateUser = db.prepare(`
        UPDATE users
        SET reports_to_user_id = ?,
            branch_id = COALESCE(?, branch_id),
            team_id = CASE WHEN ? IN ('FIELD_OFFICER', 'REFERRAL_PARTNER') THEN COALESCE(?, team_id) ELSE team_id END
        WHERE id = ?
      `);

      for (const emp of employees) {
        updateUser.run(nextSeniorId, senior.branch_id ?? null, emp.role, senior.team_id ?? null, emp.id);

        if (emp.role === 'TEAM_LEADER') {
          db.prepare(
            `UPDATE leads SET assigned_bm_id = ?, branch_id = COALESCE(?, branch_id) WHERE assigned_tl_id = ? AND status NOT IN ('Disbursed', 'Closed')`
          ).run(nextSeniorId, senior.branch_id ?? null, emp.id);
        } else if (emp.role === 'FIELD_OFFICER') {
          db.prepare(
            `UPDATE leads SET assigned_tl_id = ?, assigned_bm_id = COALESCE(?, assigned_bm_id), branch_id = COALESCE(?, branch_id) WHERE assigned_officer_id = ? AND status NOT IN ('Disbursed', 'Closed')`
          ).run(nextSeniorId, senior.reports_to_user_id ?? null, senior.branch_id ?? null, emp.id);
        }

        createAlert({
          userId: Number(emp.id),
          category: 'Lead Follow-up Alert',
          titleEn: 'Reporting Senior Updated',
          titleHi: 'रिपोर्टिंग सीनियर बदला गया',
          messageEn: `Admin mapped your ID (${emp.employee_code}) under ${senior.full_name} (${senior.employee_code}).`,
          messageHi: `एडमिन ने आपकी आईडी (${emp.employee_code}) को ${senior.full_name} (${senior.employee_code}) के अंडर ट्रांसफर किया है।`,
        });
      }

      createAlert({
        userId: nextSeniorId,
        category: 'Lead Follow-up Alert',
        titleEn: `${employees.length} Downline Member(s) Transferred`,
        titleHi: `${employees.length} डाउनलाइन सदस्य ट्रांसफर हुए`,
        messageEn: `Super Admin transferred ${employees.length} ${mappingRule.label} into your downline.`,
        messageHi: `सुपर एडमिन ने ${employees.length} ${mappingRule.label} को आपकी डाउनलाइन में ट्रांसफर किया है।`,
      });
    });

    transferTx();
    syncUsersBackupToDisk();
    logAudit(
      admin,
      'DOWNLINE_TRANSFERRED',
      'USER',
      senior.employee_code,
      `Transferred ${employees.length} ${mappingRule.label} (${employees
        .map((e) => e.employee_code)
        .slice(0, 8)
        .join(', ')}) to ${senior.full_name} (${senior.employee_code})`
    );
    broadcastLiveSync(
      'HIERARCHY_UPDATED',
      `Transferred ${employees.length} ${mappingRule.label} under ${senior.full_name} (${senior.employee_code})`,
      admin
    );

    res.json({
      ok: true,
      transferredCount: employees.length,
      targetSenior: {
        id: senior.id,
        employeeCode: senior.employee_code,
        fullName: senior.full_name,
        role: senior.role,
      },
    });
  });

  // Permanently Delete Any Employee ID (Super Admin Only — FK-Safe with Optional Downline Transfer)
  router.delete('/admin/users/:id', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const targetId = Number(req.params.id);
    const rawTransferTo = req.body?.transferDownlineToUserId ?? req.query?.transferDownlineToUserId;
    const transferToId = rawTransferTo ? Number(rawTransferTo) : null;

    if (!Number.isFinite(targetId) || targetId <= 0) {
      res.status(400).json({ error: 'Invalid employee ID.' });
      return;
    }

    if (targetId === admin.id) {
      res.status(400).json({ error: 'You cannot delete your own currently signed-in Super Admin account.' });
      return;
    }

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as any;
    if (!target) {
      res.status(404).json({ error: 'Employee ID not found.' });
      return;
    }

    if (target.role === 'SUPER_ADMIN') {
      const otherAdmins = db
        .prepare(`SELECT COUNT(*) as cnt FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1 AND id != ?`)
        .get(targetId) as { cnt: number };
      if (Number(otherAdmins?.cnt ?? 0) === 0) {
        res.status(400).json({ error: 'Cannot delete the last remaining active Super Admin account.' });
        return;
      }
    }

    const directChildren = db
      .prepare(`SELECT id, employee_code, full_name, role, is_active FROM users WHERE reports_to_user_id = ?`)
      .all(targetId) as { id: number; employee_code: string; full_name: string; role: UserRole; is_active: number }[];

    let replacementSenior: any = null;
    if (transferToId) {
      if (transferToId === targetId) {
        res.status(400).json({ error: 'Replacement senior cannot be the employee being deleted.' });
        return;
      }
      replacementSenior = db
        .prepare(`SELECT id, employee_code, full_name, role, branch_id, team_id, reports_to_user_id, is_active FROM users WHERE id = ?`)
        .get(transferToId) as any;
      if (!replacementSenior || !replacementSenior.is_active || replacementSenior.role !== target.role) {
        res.status(400).json({
          error: `Replacement senior must be an active ${String(target.role).replace(/_/g, ' ')}.`,
        });
        return;
      }
      if (directChildren.length > 0) {
        const activeChildCount = directChildren.filter((c) => c.is_active).length;
        if (activeChildCount > 0) {
          const capCheck = validateParentHierarchyAndCapacity(directChildren[0].role, transferToId, activeChildCount);
          if (capCheck.ok === false) {
            res.status(400).json({ error: `Cannot transfer downline to ${replacementSenior.full_name}: ${capCheck.error}` });
            return;
          }
        }
      }
    }

    const fallbackOwnerId = replacementSenior ? Number(replacementSenior.id) : admin.id;
    let transferredDownlineCount = 0;

    const deleteTx = db.transaction(() => {
      // 1. Transfer or unlink direct downline employees
      if (directChildren.length > 0) {
        if (replacementSenior) {
          db.prepare(
            `UPDATE users SET reports_to_user_id = ?, branch_id = COALESCE(?, branch_id), team_id = COALESCE(?, team_id) WHERE reports_to_user_id = ?`
          ).run(
            replacementSenior.id,
            replacementSenior.branch_id ?? null,
            replacementSenior.team_id ?? null,
            targetId
          );
          transferredDownlineCount = directChildren.length;
        } else {
          db.prepare(`UPDATE users SET reports_to_user_id = NULL WHERE reports_to_user_id = ?`).run(targetId);
        }
      }

      // 2. Clean/reassign all FK references safely so historical leads & documents are never lost
      db.prepare(`UPDATE teams SET leader_user_id = NULL WHERE leader_user_id = ?`).run(targetId);

      db.prepare(`UPDATE leads SET created_by = ? WHERE created_by = ?`).run(fallbackOwnerId, targetId);
      db.prepare(`UPDATE leads SET assigned_bm_id = ? WHERE assigned_bm_id = ?`).run(
        replacementSenior && target.role === 'BRANCH_MANAGER' ? replacementSenior.id : null,
        targetId
      );
      db.prepare(`UPDATE leads SET assigned_tl_id = ? WHERE assigned_tl_id = ?`).run(
        replacementSenior && target.role === 'TEAM_LEADER' ? replacementSenior.id : null,
        targetId
      );
      db.prepare(`UPDATE leads SET assigned_officer_id = ? WHERE assigned_officer_id = ?`).run(
        replacementSenior && target.role === 'FIELD_OFFICER' ? replacementSenior.id : null,
        targetId
      );
      db.prepare(`UPDATE leads SET rejected_by = NULL WHERE rejected_by = ?`).run(targetId);
      db.prepare(`UPDATE leads SET closure_requested_by = NULL WHERE closure_requested_by = ?`).run(targetId);
      db.prepare(`UPDATE leads SET closure_approved_by = NULL WHERE closure_approved_by = ?`).run(targetId);

      db.prepare(`UPDATE duplicate_requests SET submitted_by = ? WHERE submitted_by = ?`).run(admin.id, targetId);
      db.prepare(`UPDATE duplicate_requests SET reviewed_by = NULL WHERE reviewed_by = ?`).run(targetId);
      db.prepare(`UPDATE case_history SET updated_by = ? WHERE updated_by = ?`).run(admin.id, targetId);
      db.prepare(`UPDATE documents SET uploaded_by = ? WHERE uploaded_by = ?`).run(admin.id, targetId);
      db.prepare(`UPDATE followup_reminders SET assigned_officer_id = ? WHERE assigned_officer_id = ?`).run(
        fallbackOwnerId,
        targetId
      );
      db.prepare(`UPDATE followup_reminders SET created_by = ? WHERE created_by = ?`).run(admin.id, targetId);
      db.prepare(`UPDATE followup_recordings SET recorded_by = ? WHERE recorded_by = ?`).run(admin.id, targetId);

      db.prepare(`DELETE FROM penalties WHERE employee_id = ?`).run(targetId);
      db.prepare(`UPDATE penalties SET reviewed_by = NULL WHERE reviewed_by = ?`).run(targetId);

      db.prepare(`UPDATE enquiries SET referral_user_id = ? WHERE referral_user_id = ?`).run(fallbackOwnerId, targetId);
      db.prepare(`UPDATE enquiries SET assigned_officer_id = ? WHERE assigned_officer_id = ?`).run(
        replacementSenior && target.role === 'FIELD_OFFICER' ? replacementSenior.id : null,
        targetId
      );

      db.prepare(`DELETE FROM gps_logs WHERE employee_id = ?`).run(targetId);
      db.prepare(`DELETE FROM bike_runs WHERE employee_id = ?`).run(targetId);
      db.prepare(`UPDATE bike_runs SET reviewed_by = NULL WHERE reviewed_by = ?`).run(targetId);
      db.prepare(`UPDATE settings SET updated_by = NULL WHERE updated_by = ?`).run(targetId);
      db.prepare(`UPDATE referral_payouts SET referral_user_id = NULL WHERE referral_user_id = ?`).run(targetId);
      db.prepare(`DELETE FROM staff_rewards WHERE employee_id = ?`).run(targetId);
      db.prepare(`UPDATE staff_rewards SET awarded_by = NULL WHERE awarded_by = ?`).run(targetId);
      db.prepare(`UPDATE staff_rewards SET waived_by = NULL WHERE waived_by = ?`).run(targetId);
      db.prepare(`DELETE FROM attendance_logs WHERE employee_id = ?`).run(targetId);
      db.prepare(`DELETE FROM leave_requests WHERE employee_id = ?`).run(targetId);
      db.prepare(`UPDATE leave_requests SET reviewed_by = NULL WHERE reviewed_by = ?`).run(targetId);
      db.prepare(`DELETE FROM sales_targets WHERE user_id = ?`).run(targetId);
      db.prepare(`DELETE FROM alerts WHERE user_id = ?`).run(targetId);
      db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(targetId);
      db.prepare(`DELETE FROM otp_challenges WHERE user_id = ?`).run(targetId);

      // 3. Permanently delete the employee row
      db.prepare(`DELETE FROM users WHERE id = ?`).run(targetId);
    });

    deleteTx();
    syncUsersBackupToDisk();

    logAudit(
      admin,
      'USER_DELETED',
      'USER',
      target.employee_code,
      `Permanently deleted Employee ID ${target.employee_code} (${target.full_name} · ${target.role})${
        transferredDownlineCount > 0 && replacementSenior
          ? ` and transferred ${transferredDownlineCount} downline member(s) to ${replacementSenior.full_name} (${replacementSenior.employee_code})`
          : ''
      }`
    );
    broadcastLiveSync(
      'HIERARCHY_UPDATED',
      `Employee ID ${target.employee_code} (${target.full_name}) deleted by Super Admin`,
      admin
    );

    res.json({
      ok: true,
      deletedEmployeeCode: target.employee_code,
      deletedFullName: target.full_name,
      transferredDownlineCount,
    });
  });

  // Referral ID Creation & Management Console
  // - SUPER_ADMIN & LEAD_GENERATOR (Back Office Team): create, change Field Officer (up to 50/FO), and remove
  // - FIELD_OFFICER: ONLY create Referral IDs under self (up to 50); NO change Field Officer, NO remove
  router.get(
    '/referrals/manage',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'LEAD_GENERATOR', 'FIELD_OFFICER'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const isFO = user.role === 'FIELD_OFFICER';

      const referrals = db
        .prepare(`
          SELECT u.id, u.employee_code as employeeCode, u.full_name as fullName, u.mobile, u.email,
            u.referral_code as referralCode, u.branch_id as branchId, b.name as branchName,
            u.service_city as serviceCity, u.reports_to_user_id as assignedFieldOfficerId,
            fo.full_name as assignedFieldOfficerName, fo.employee_code as assignedFieldOfficerCode,
            u.is_active as isActive, u.created_at as createdAt
          FROM users u
          LEFT JOIN branches b ON b.id = u.branch_id
          LEFT JOIN users fo ON fo.id = u.reports_to_user_id
          WHERE u.role = 'REFERRAL_PARTNER' AND u.is_active = 1
            ${isFO ? 'AND u.reports_to_user_id = ?' : ''}
          ORDER BY u.id DESC
        `)
        .all(...(isFO ? [user.id] : []))
        .map((r: any) => ({ ...r, isActive: Boolean(r.isActive) }));

      const fieldOfficers = db
        .prepare(`
          SELECT fo.id, fo.employee_code as employeeCode, fo.full_name as fullName, fo.mobile,
            fo.branch_id as branchId, b.name as branchName, fo.team_id as teamId,
            (
              SELECT COUNT(*) FROM users r
              WHERE r.role = 'REFERRAL_PARTNER' AND r.is_active = 1 AND r.reports_to_user_id = fo.id
            ) as referralCount
          FROM users fo
          LEFT JOIN branches b ON b.id = fo.branch_id
          WHERE fo.role = 'FIELD_OFFICER' AND fo.is_active = 1
            ${isFO ? 'AND fo.id = ?' : ''}
          ORDER BY fo.full_name ASC
        `)
        .all(...(isFO ? [user.id] : []))
        .map((fo: any) => ({
          ...fo,
          referralCount: Number(fo.referralCount || 0),
          maxReferrals: HIERARCHY_LIMITS.REFERRALS_PER_FO,
        }));

      res.json({
        referrals,
        fieldOfficers,
        maxReferralsPerFo: HIERARCHY_LIMITS.REFERRALS_PER_FO,
        permissions: {
          canCreate: true,
          canRename: true,
          canChangeFieldOfficer: !isFO,
          canRemove: !isFO,
        },
      });
    }
  );

  router.post(
    '/referrals/manage',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'LEAD_GENERATOR', 'FIELD_OFFICER'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const {
        employeeCode,
        fullName,
        mobile,
        password,
        referralCode,
        assignedFieldOfficerId,
        serviceCity,
      } = req.body as Record<string, any>;

      if (
        user.role === 'FIELD_OFFICER' &&
        assignedFieldOfficerId &&
        Number(assignedFieldOfficerId) !== user.id
      ) {
        res.status(403).json({
          error: 'Field Officers can only create Referral IDs under their own ID.',
        });
        return;
      }

      const targetFoId = user.role === 'FIELD_OFFICER' ? user.id : Number(assignedFieldOfficerId || 0);
      const hierCheck = validateParentHierarchyAndCapacity('REFERRAL_PARTNER', targetFoId, 1);
      if (hierCheck.ok === false) {
        res.status(400).json({ error: hierCheck.error });
        return;
      }

      const cleanName = String(fullName || '').trim();
      if (!cleanName) {
        res.status(400).json({ error: 'Referral Partner Full Name is required' });
        return;
      }

      let cleanCode = String(employeeCode || '').trim().replace(/\s+/g, '').toUpperCase();
      if (!cleanCode) {
        const existingCodes = db
          .prepare(`SELECT employee_code FROM users WHERE UPPER(employee_code) LIKE 'DSA%'`)
          .all() as { employee_code: string }[];
        let maxSeq = 0;
        for (const r of existingCodes) {
          const m = r.employee_code.match(/^DSA(\d+)$/i);
          if (m && m[1]) {
            maxSeq = Math.max(maxSeq, Number.parseInt(m[1], 10));
          }
        }
        const existingAll = new Set(
          (db.prepare(`SELECT UPPER(employee_code) as c FROM users`).all() as { c: string }[]).map((r) => r.c)
        );
        let seq = maxSeq + 1;
        cleanCode = `DSA${String(seq).padStart(3, '0')}`;
        while (existingAll.has(cleanCode)) {
          seq++;
          cleanCode = `DSA${String(seq).padStart(3, '0')}`;
        }
      } else {
        const dup = db
          .prepare(`SELECT id FROM users WHERE UPPER(employee_code) = UPPER(?)`)
          .get(cleanCode);
        if (dup) {
          res.status(409).json({ error: `Login ID "${cleanCode}" already exists.` });
          return;
        }
      }

      const cleanPassword = String(password || '').trim() || generateReadablePassword(8);
      const cleanRefCode = String(referralCode || `DSA-${cleanCode}`).trim().replace(/\s+/g, '').toUpperCase();
      const dupRef = db
        .prepare(`SELECT id FROM users WHERE UPPER(REPLACE(referral_code, ' ', '')) = UPPER(?)`)
        .get(cleanRefCode);
      if (dupRef) {
        res.status(409).json({ error: `Referral Code "${cleanRefCode}" already exists.` });
        return;
      }

      const foInfo = db
        .prepare(`SELECT id, full_name, employee_code, branch_id, team_id FROM users WHERE id = ?`)
        .get(targetFoId) as any;

      const passHash = bcrypt.hashSync(cleanPassword, 10);
      const inserted = db
        .prepare(`
          INSERT INTO users (employee_code, full_name, mobile, email, password_hash, role, branch_id, team_id, reports_to_user_id, referral_code, service_city, is_active, otp_enabled)
          VALUES (?, ?, ?, ?, ?, 'REFERRAL_PARTNER', ?, ?, ?, ?, ?, 1, 0)
        `)
        .run(
          cleanCode,
          cleanName,
          String(mobile || '').trim(),
          `${cleanCode.toLowerCase()}@ambikaassociate.in`,
          passHash,
          foInfo?.branch_id ?? null,
          foInfo?.team_id ?? null,
          targetFoId,
          cleanRefCode,
          serviceCity ? String(serviceCity).trim() : null
        );

      logAudit(
        user,
        'REFERRAL_ID_CREATED',
        'USER',
        cleanCode,
        `Created Referral ID ${cleanCode} (${cleanName}) linked to Field Officer ${foInfo?.full_name} (${foInfo?.employee_code})`
      );
      broadcastLiveSync('HIERARCHY_UPDATED', `New Referral ID ${cleanCode} (${cleanRefCode}) created`, user);

      res.status(201).json({
        ok: true,
        created: {
          id: Number(inserted.lastInsertRowid),
          employeeCode: cleanCode,
          password: cleanPassword,
          fullName: cleanName,
          mobile: String(mobile || '').trim(),
          referralCode: cleanRefCode,
          assignedFieldOfficerId: targetFoId,
          assignedFieldOfficerName: foInfo?.full_name ?? '',
          assignedFieldOfficerCode: foInfo?.employee_code ?? '',
        },
      });
    }
  );

  // Rename Referral Partner Login ID & Referral Code (Admin, Back Office, or owning Field Officer)
  router.patch(
    '/referrals/manage/:id/rename',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'LEAD_GENERATOR', 'FIELD_OFFICER'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const referralId = Number(req.params.id);
      const { employeeCode, referralCode, fullName } = req.body as {
        employeeCode?: string;
        referralCode?: string;
        fullName?: string;
      };

      const refUser = db
        .prepare(`SELECT * FROM users WHERE id = ? AND role = 'REFERRAL_PARTNER' AND is_active = 1`)
        .get(referralId) as any;
      if (!refUser) {
        res.status(404).json({ error: 'Active Referral ID not found' });
        return;
      }
      if (user.role === 'FIELD_OFFICER' && Number(refUser.reports_to_user_id) !== user.id) {
        res.status(403).json({ error: 'You can only rename Referral IDs assigned under your Field Officer ID.' });
        return;
      }

      const cleanNewCode =
        employeeCode !== undefined
          ? String(employeeCode || '').trim().replace(/\s+/g, '').toUpperCase()
          : String(refUser.employee_code || '').toUpperCase();
      if (!cleanNewCode || !/^[A-Z0-9_-]{2,32}$/.test(cleanNewCode)) {
        res.status(400).json({
          error: 'Login ID must be 2–32 characters using letters, numbers, "-" or "_" (no spaces).',
        });
        return;
      }

      const cleanNewRef =
        referralCode !== undefined
          ? String(referralCode || '').trim().replace(/\s+/g, '').toUpperCase()
          : String(refUser.referral_code || `DSA-${cleanNewCode}`).toUpperCase();
      if (!cleanNewRef || !/^[A-Z0-9_-]{2,36}$/.test(cleanNewRef)) {
        res.status(400).json({
          error: 'Referral Code must be 2–36 characters using letters, numbers, "-" or "_" (no spaces).',
        });
        return;
      }

      const dupCode = db
        .prepare(`SELECT id FROM users WHERE UPPER(REPLACE(employee_code, ' ', '')) = UPPER(?) AND id != ?`)
        .get(cleanNewCode, referralId);
      if (dupCode) {
        res.status(409).json({ error: `Login ID "${cleanNewCode}" already exists. Choose a different ID.` });
        return;
      }

      const dupRef = db
        .prepare(`SELECT id FROM users WHERE UPPER(REPLACE(referral_code, ' ', '')) = UPPER(?) AND id != ?`)
        .get(cleanNewRef, referralId);
      if (dupRef) {
        res.status(409).json({ error: `Referral Code "${cleanNewRef}" already exists. Choose a different code.` });
        return;
      }

      const oldCode = String(refUser.employee_code || '');
      const oldRef = String(refUser.referral_code || '');
      const nextName = fullName && String(fullName).trim() ? String(fullName).trim() : refUser.full_name;

      db.prepare(`UPDATE users SET employee_code = ?, referral_code = ?, full_name = ? WHERE id = ?`).run(
        cleanNewCode,
        cleanNewRef,
        nextName,
        referralId
      );

      if (oldRef && oldRef.toUpperCase() !== cleanNewRef.toUpperCase()) {
        db.prepare(`UPDATE leads SET referral_id = ? WHERE UPPER(referral_id) = UPPER(?)`).run(cleanNewRef, oldRef);
      }

      logAudit(
        user,
        'REFERRAL_ID_RENAMED',
        'USER',
        cleanNewCode,
        `Renamed Referral ID ${oldCode}/${oldRef} -> ${cleanNewCode}/${cleanNewRef} (${nextName})`
      );
      broadcastLiveSync('HIERARCHY_UPDATED', `Referral ID renamed to ${cleanNewCode} (${cleanNewRef})`, user);

      res.json({
        ok: true,
        employeeCode: cleanNewCode,
        referralCode: cleanNewRef,
        fullName: nextName,
      });
    }
  );

  router.patch(
    '/referrals/manage/:id/field-officer',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'LEAD_GENERATOR'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const referralId = Number(req.params.id);
      const { assignedFieldOfficerId } = req.body as { assignedFieldOfficerId?: number };

      const refUser = db
        .prepare(`SELECT * FROM users WHERE id = ? AND role = 'REFERRAL_PARTNER' AND is_active = 1`)
        .get(referralId) as any;
      if (!refUser) {
        res.status(404).json({ error: 'Active Referral ID not found' });
        return;
      }

      const hierCheck = validateParentHierarchyAndCapacity(
        'REFERRAL_PARTNER',
        assignedFieldOfficerId,
        1,
        referralId
      );
      if (hierCheck.ok === false) {
        res.status(400).json({ error: hierCheck.error });
        return;
      }

      const newFo = db
        .prepare(`SELECT id, full_name, employee_code, branch_id, team_id FROM users WHERE id = ?`)
        .get(hierCheck.parentId) as any;

      db.prepare(`
        UPDATE users
        SET reports_to_user_id = ?, branch_id = ?, team_id = ?
        WHERE id = ?
      `).run(newFo.id, newFo.branch_id ?? refUser.branch_id, newFo.team_id ?? null, referralId);

      logAudit(
        user,
        'REFERRAL_FO_CHANGED',
        'USER',
        refUser.employee_code,
        `Changed Field Officer on Referral ID ${refUser.employee_code} (${refUser.full_name}) to ${newFo.full_name} (${newFo.employee_code})`
      );

      res.json({ ok: true });
    }
  );

  router.delete(
    '/referrals/manage/:id',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'LEAD_GENERATOR'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const referralId = Number(req.params.id);

      const refUser = db
        .prepare(`SELECT * FROM users WHERE id = ? AND role = 'REFERRAL_PARTNER'`)
        .get(referralId) as any;
      if (!refUser) {
        res.status(404).json({ error: 'Referral ID not found' });
        return;
      }

      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(referralId);
      db.prepare('DELETE FROM otp_challenges WHERE user_id = ?').run(referralId);
      db.prepare(`UPDATE users SET is_active = 0, reports_to_user_id = NULL, team_id = NULL WHERE id = ?`).run(
        referralId
      );

      logAudit(
        user,
        'REFERRAL_ID_REMOVED',
        'USER',
        refUser.employee_code,
        `Removed Referral ID ${refUser.employee_code} (${refUser.full_name}) from Field Officer console and revoked login`
      );

      res.json({ ok: true });
    }
  );

  router.post('/admin/branches', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const { code, name, city, state } = req.body as Record<string, string>;
    if (!code || !name || !city || !state) {
      res.status(400).json({ error: 'All branch fields are required' });
      return;
    }
    const inserted = db.prepare('INSERT INTO branches (code, name, city, state) VALUES (?, ?, ?, ?)').run(
      code.trim().toUpperCase(),
      name.trim(),
      city.trim(),
      state.trim()
    );
    logAudit(req.user!, 'BRANCH_CREATED', 'BRANCH', code, `Created branch ${name}`);
    broadcastLiveSync('HIERARCHY_UPDATED', `New branch ${name} created by Admin`, req.user!);
    res.status(201).json({ ok: true, id: inserted.lastInsertRowid });
  });

  router.post('/admin/teams', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const { branchId, name, leaderUserId } = req.body as Record<string, any>;
    if (!branchId || !name) {
      res.status(400).json({ error: 'Branch and team name are required' });
      return;
    }
    const inserted = db
      .prepare('INSERT INTO teams (branch_id, name, leader_user_id) VALUES (?, ?, ?)')
      .run(Number(branchId), String(name).trim(), leaderUserId ? Number(leaderUserId) : null);
    logAudit(req.user!, 'TEAM_CREATED', 'TEAM', name, `Created team ${name}`);
    broadcastLiveSync('HIERARCHY_UPDATED', `New team ${name} created by Admin`, req.user!);
    res.status(201).json({ ok: true, id: inserted.lastInsertRowid });
  });

  router.get('/admin/settings', requireAuth, (_req, res) => {
    res.json({ settings: getSettings() });
  });

  router.patch('/admin/settings', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const allowedKeys = [
      'petrolRatePerKm',
      'assignmentSlaMinutes',
      'followupSlaMinutes',
      'enquirySlaMinutes',
      'otpRequiredGlobal',
      'defaultLanguage',
      'companyLogoDataUrl',
      'loanProducts',
      'referralBonusThreshold',
      'referralBonusPct',
      'loginRewardOfficerPts',
      'loginRewardGeneratorPts',
      'disbursementRewardOfficerPts',
      'disbursementRewardGeneratorPts',
      'wrongLeadPenaltyMin',
      'wrongLeadPenaltyMax',
      'wrongLeadPenaltyDefault',
      'playStoreUrl',
      'apkDownloadUrl',
      'autoAssignIncomingLeads',
      'autoAssignMaxActiveLeads',
      'autoAssignGeoWeight',
      'officeName',
      'officeAddress',
      'officeLatitude',
      'officeLongitude',
      'officeRadiusMeters',
      'attendanceCutoffTime',
      'attendanceLatePenaltyInr',
      'unapprovedLeavePenaltyInr',
      'seniorityInstructions',
    ];
    const changedKeys: string[] = [];
    for (const k of allowedKeys) {
      if (req.body[k] !== undefined) {
        if (k === 'playStoreUrl' || k === 'apkDownloadUrl') {
          const raw = typeof req.body[k] === 'string' ? req.body[k].trim() : '';
          if (raw && !/^https?:\/\//i.test(raw)) {
            res.status(400).json({ error: `${k} must start with http:// or https://` });
            return;
          }
          updateSetting(k, raw || null, admin.id);
        } else {
          updateSetting(k, req.body[k], admin.id);
        }
        changedKeys.push(k);
      }
    }
    logAudit(admin, 'SETTINGS_UPDATED', 'SETTINGS', 'SYSTEM', `Updated system settings: ${changedKeys.join(', ')}`);

    if (changedKeys.includes('seniorityInstructions') && String(req.body.seniorityInstructions || '').trim()) {
      const instructionText = String(req.body.seniorityInstructions).trim();
      const staffIds = db
        .prepare(`SELECT id FROM users WHERE is_active = 1 AND role <> 'REFERRAL_PARTNER' AND id <> ?`)
        .all(admin.id) as Array<{ id: number }>;
      for (const s of staffIds) {
        createAlert({
          userId: s.id,
          category: 'Admin Seniority Instruction',
          titleEn: 'New Seniority Instruction from Super Admin',
          titleHi: 'सुपर एडमिन से नया सीनियरिटी निर्देश',
          messageEn: instructionText,
          messageHi: instructionText,
        });
      }
    }

    const summary = changedKeys.includes('companyLogoDataUrl')
      ? 'Company Logo & Admin Rules synced live'
      : changedKeys.includes('seniorityInstructions')
        ? 'Seniority Instructions & Admin Rules synced live'
        : changedKeys.includes('officeLatitude') || changedKeys.includes('officeAddress')
          ? 'Office Address / Attendance GPS synced live'
          : `Admin Panel Rules synced (${changedKeys.length} setting${changedKeys.length === 1 ? '' : 's'})`;

    broadcastLiveSync('SETTINGS_UPDATED', summary, admin);
    res.json({ settings: getSettings() });
  });

  // ============================================================================
  // PAN CARD OCR (Server-side Gemini Vision when GEMINI_API_KEY is configured)
  // ============================================================================
  router.post('/ocr/pan', requireAuth, async (req: AuthedRequest, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.json({ available: false, fallbackToLocalOcr: true });
      return;
    }

    const imageDataUrl = String(req.body?.imageDataUrl || '').trim();
    const match = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      res.status(400).json({ error: 'Valid base64 image data URL is required' });
      return;
    }

    const mimeType = match[1];
    const base64Data = match[2];

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Data,
              },
            },
            {
              text:
                'Extract fields from this Indian PAN Card image. ' +
                'Return the 10-character PAN number (5 uppercase letters, 4 digits, 1 uppercase letter), ' +
                'the cardholder full name (NOT father name), the father name if visible, and Date of Birth formatted as YYYY-MM-DD. ' +
                'Leave missing fields as empty strings.',
            },
          ],
        },
        config: {
          systemInstruction:
            'You are an accurate Indian KYC PAN Card OCR parser. Output strict JSON matching the schema.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              panNumber: { type: Type.STRING, description: '10-character Indian PAN number uppercase' },
              customerName: { type: Type.STRING, description: 'PAN cardholder full name' },
              fatherName: { type: Type.STRING, description: 'Father name if present on card' },
              dob: { type: Type.STRING, description: 'Date of birth in YYYY-MM-DD format or empty string' },
              rawText: { type: Type.STRING, description: 'Visible text lines extracted from the card' },
            },
          },
        },
      });

      const parsed = JSON.parse((response.text || '{}').trim()) as Record<string, string>;
      const rawPan = String(parsed.panNumber || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      const validPan = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(rawPan) ? rawPan : '';

      logAudit(
        req.user!,
        'PAN_OCR_PARSED',
        'OCR',
        validPan || 'UNREAD',
        `Parsed PAN OCR via Vision (${validPan ? 'PAN detected' : 'partial'})`
      );

      res.json({
        available: true,
        panNumber: validPan,
        customerName: String(parsed.customerName || '').trim(),
        fatherName: String(parsed.fatherName || '').trim(),
        dob: String(parsed.dob || '').trim(),
        rawText: String(parsed.rawText || '').trim(),
      });
    } catch (err: any) {
      res.json({
        available: false,
        fallbackToLocalOcr: true,
        message: err?.message || 'Falling back to local OCR',
      });
    }
  });

  // ============================================================================
  // SALES GROWTH HUB: TARGETS, PRIORITY QUEUE, CROSS-SELL, FUNNEL, BANK SLA & PAYOUTS
  // ============================================================================
  router.get('/sales/overview', requireAuth, (req: AuthedRequest, res) => {
    processSlaTimers();
    const user = req.user!;
    const monthKey = new Date().toISOString().slice(0, 7);
    const scope = buildLeadScopeFilter(user);

    const leads = db
      .prepare(`
        SELECT l.*, cb.full_name as created_by_name, ao.full_name as assigned_officer_name,
          ao.mobile as assigned_officer_mobile, b.name as branch_name
        FROM leads l
        JOIN users cb ON cb.id = l.created_by
        LEFT JOIN users ao ON ao.id = l.assigned_officer_id
        LEFT JOIN branches b ON b.id = l.branch_id
        WHERE ${scope.sql}
        ORDER BY l.updated_at DESC
      `)
      .all(...scope.params) as any[];

    const isReferral = user.role === 'REFERRAL_PARTNER';

    // 1. Smart Next-Best-Action Priority Queue
    const nowMs = Date.now();
    const pendingReminders = !isReferral
      ? (db
          .prepare(`
            SELECT r.lead_id, r.note, r.deadline_at, r.due_at
            FROM followup_reminders r
            WHERE r.completed_at IS NULL
            ORDER BY r.deadline_at ASC
          `)
          .all() as any[])
      : [];
    const reminderByLead = new Map<number, any>();
    for (const r of pendingReminders) {
      if (!reminderByLead.has(r.lead_id)) reminderByLead.set(r.lead_id, r);
    }

    const priorityQueue = leads
      .filter((l) => !['Disbursed', 'Rejected', 'Closed'].includes(l.status))
      .map((l) => {
        let urgencyScore = 10;
        let urgencyReason = 'Routine Follow-up';
        let urgencyLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' = 'MEDIUM';

        const rem = reminderByLead.get(l.id);
        if (l.assignment_deadline_at && l.status === 'Lead Assigned') {
          const minsLeft = Math.round((new Date(l.assignment_deadline_at.replace(' ', 'T') + 'Z').getTime() - nowMs) / 60000);
          urgencyScore += minsLeft <= 5 ? 95 : 70;
          urgencyLevel = 'CRITICAL';
          urgencyReason = minsLeft <= 0 ? '10-Min Assignment SLA Overdue' : `10-Min SLA (${minsLeft}m left)`;
        } else if (rem) {
          urgencyScore += 85;
          urgencyLevel = 'CRITICAL';
          urgencyReason = `Follow-up Due: ${rem.note}`;
        } else if (['Approved', 'Disbursement Pending'].includes(l.status)) {
          urgencyScore += 65;
          urgencyLevel = 'HIGH';
          urgencyReason = 'Sanctioned — Push for Disbursement';
        } else if (['Documents Pending', 'Query Raised'].includes(l.status)) {
          urgencyScore += 55;
          urgencyLevel = 'HIGH';
          urgencyReason = l.status === 'Query Raised' ? 'Resolve Bank Query' : 'Collect Missing KYC Docs';
        } else if (l.status === 'Login Pending' || l.status === 'Documents Received') {
          urgencyScore += 45;
          urgencyLevel = 'HIGH';
          urgencyReason = 'Ready for Bank Login';
        }

        if (!isReferral && Number(l.loan_amount || 0) >= 2500000) {
          urgencyScore += 15;
        }

        return {
          id: l.id,
          leadCode: l.lead_code,
          customerName: l.customer_name,
          customerMobile: isReferral ? null : decryptPii(l.customer_mobile_enc),
          loanProduct: l.loan_product,
          loanAmount: isReferral ? null : Number(l.loan_amount || 0),
          bankNbfc: l.bank_nbfc,
          status: l.status,
          assignedOfficerName: l.assigned_officer_name ?? 'Unassigned',
          urgencyScore,
          urgencyLevel,
          urgencyReason,
        };
      })
      .sort((a, b) => b.urgencyScore - a.urgencyScore)
      .slice(0, 12);

    // 2. Monthly Targets vs Achievement (hidden amount details for Referral Partners)
    let targets: any[] = [];
    if (!isReferral) {
      const targetRows = db
        .prepare(`
          SELECT st.*, u.full_name as userName, u.employee_code as employeeCode, b.name as branchName
          FROM sales_targets st
          LEFT JOIN users u ON u.id = st.user_id
          LEFT JOIN branches b ON b.id = st.branch_id
          WHERE st.month_key = ?
          ORDER BY st.user_id IS NULL ASC, st.target_amount DESC
        `)
        .all(monthKey) as any[];

      targets = targetRows
        .filter((tr) => {
          if (user.role === 'FIELD_OFFICER') return tr.user_id === user.id;
          if (user.role === 'BRANCH_MANAGER' || user.role === 'TEAM_LEADER') {
            return tr.branch_id === user.branchId || tr.user_id === user.id;
          }
          return true;
        })
        .map((tr) => {
          const matching = tr.user_id
            ? leads.filter((l) => l.assigned_officer_id === tr.user_id)
            : leads.filter((l) => l.branch_id === tr.branch_id);
          const disbursedAmt = matching
            .filter((l) => l.status === 'Disbursed')
            .reduce((s, l) => s + Number(l.loan_amount || 0), 0);
          const pipelineAmt = matching
            .filter((l) => !['Disbursed', 'Rejected', 'Closed'].includes(l.status))
            .reduce((s, l) => s + Number(l.loan_amount || 0), 0);
          const achievedLeads = matching.length;
          const disbursedCount = matching.filter((l) => l.status === 'Disbursed').length;
          const pct = tr.target_amount > 0 ? Math.min(200, Math.round((disbursedAmt / tr.target_amount) * 100)) : 0;

          return {
            id: tr.id,
            monthKey: tr.month_key,
            userId: tr.user_id,
            userName: tr.userName,
            employeeCode: tr.employeeCode,
            branchId: tr.branch_id,
            branchName: tr.branchName,
            targetLeads: tr.target_leads,
            targetAmount: tr.target_amount,
            achievedLeads,
            disbursedCount,
            disbursedAmount: disbursedAmt,
            pipelineAmount: pipelineAmt,
            achievementPct: pct,
          };
        });
    }

    // 3. Stage-Wise Conversion Funnel
    const totalCount = leads.length;
    const contactedDocsCount = leads.filter((l) =>
      ['Customer Contacted', 'Documents Pending', 'Documents Received', 'Login Pending', 'Case Logged In', 'Under Process', 'Query Raised', 'Approved', 'Disbursement Pending', 'Disbursed'].includes(l.status)
    ).length;
    const loggedInCount = leads.filter((l) =>
      ['Case Logged In', 'Under Process', 'Query Raised', 'Approved', 'Disbursement Pending', 'Disbursed'].includes(l.status)
    ).length;
    const approvedCount = leads.filter((l) =>
      ['Approved', 'Disbursement Pending', 'Disbursed'].includes(l.status)
    ).length;
    const disbursedCount = leads.filter((l) => l.status === 'Disbursed').length;

    const funnel = [
      { stage: 'Leads Generated', count: totalCount, pct: 100 },
      { stage: 'Contacted & Docs', count: contactedDocsCount, pct: totalCount ? Math.round((contactedDocsCount / totalCount) * 100) : 0 },
      { stage: 'Logged In / Process', count: loggedInCount, pct: totalCount ? Math.round((loggedInCount / totalCount) * 100) : 0 },
      { stage: 'Sanctioned / Approved', count: approvedCount, pct: totalCount ? Math.round((approvedCount / totalCount) * 100) : 0 },
      { stage: 'Disbursed', count: disbursedCount, pct: totalCount ? Math.round((disbursedCount / totalCount) * 100) : 0 },
    ];

    // 4. Bank / NBFC Turnaround & Approval Analytics
    const bankMap = new Map<string, { bank: string; total: number; disbursed: number; rejected: number; active: number; totalHours: number; completedSamples: number }>();
    for (const l of leads) {
      const entry = bankMap.get(l.bank_nbfc) || {
        bank: l.bank_nbfc,
        total: 0,
        disbursed: 0,
        rejected: 0,
        active: 0,
        totalHours: 0,
        completedSamples: 0,
      };
      entry.total += 1;
      if (l.status === 'Disbursed') {
        entry.disbursed += 1;
        const hrs = Math.max(
          1,
          Math.round((new Date(String(l.updated_at).replace(' ', 'T')).getTime() - new Date(String(l.created_at).replace(' ', 'T')).getTime()) / 3600000)
        );
        if (Number.isFinite(hrs) && hrs < 5000) {
          entry.totalHours += hrs;
          entry.completedSamples += 1;
        }
      } else if (l.status === 'Rejected' || l.status === 'Closed') {
        entry.rejected += 1;
      } else {
        entry.active += 1;
      }
      bankMap.set(l.bank_nbfc, entry);
    }

    const bankAnalytics = Array.from(bankMap.values()).map((b) => ({
      bank: b.bank,
      total: b.total,
      disbursed: b.disbursed,
      rejected: b.rejected,
      active: b.active,
      approvalRatePct: b.disbursed + b.rejected > 0 ? Math.round((b.disbursed / (b.disbursed + b.rejected)) * 100) : b.total > 0 ? Math.round((b.disbursed / b.total) * 100) : 0,
      avgTurnaroundHours: b.completedSamples > 0 ? Math.round(b.totalHours / b.completedSamples) : null,
    }));

    // 5. Lost-Lead Reason Breakdown (Non-Referral)
    const lostReasons: { reason: string; count: number }[] = [];
    if (!isReferral) {
      const reasonMap = new Map<string, number>();
      for (const l of leads) {
        if (l.status === 'Rejected' || l.status === 'Closed') {
          const r = l.lost_reason || 'Unspecified';
          reasonMap.set(r, (reasonMap.get(r) || 0) + 1);
        }
      }
      for (const [reason, count] of reasonMap.entries()) {
        lostReasons.push({ reason, count });
      }
      lostReasons.sort((a, b) => b.count - a.count);
    }

    // 6. Cross-Sell / Top-Up Radar (Seasoned Disbursed customers >= 120 days)
    const crossSellCandidates = isReferral
      ? []
      : leads
          .filter((l) => l.status === 'Disbursed')
          .map((l) => {
            const ageDays = Math.floor(
              (nowMs - new Date(String(l.updated_at).replace(' ', 'T')).getTime()) / 86400000
            );
            return {
              id: l.id,
              leadCode: l.lead_code,
              customerName: l.customer_name,
              customerMobile: decryptPii(l.customer_mobile_enc),
              panNumber: decryptPii(l.pan_enc),
              loanProduct: l.loan_product,
              loanAmount: Number(l.loan_amount || 0),
              bankNbfc: l.bank_nbfc,
              ageDays: Number.isFinite(ageDays) ? ageDays : 0,
              offerSuggestion:
                l.loan_product.includes('Home') || l.loan_product.includes('LAP')
                  ? 'Top-Up Loan / Balance Transfer (-0.35% ROI)'
                  : 'Repeat Personal / Business Expansion Loan',
            };
          })
          .filter((c) => c.ageDays >= 120)
          .sort((a, b) => b.ageDays - a.ageDays);

    res.json({
      monthKey,
      priorityQueue,
      targets,
      funnel,
      bankAnalytics,
      lostReasons,
      crossSellCandidates,
    });
  });

  router.post('/sales/targets', requireAuth, requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER'), (req: AuthedRequest, res) => {
    const { monthKey, userId, branchId, targetLeads, targetAmount } = req.body as {
      monthKey?: string;
      userId?: number | null;
      branchId?: number | null;
      targetLeads?: number;
      targetAmount?: number;
    };
    const mKey = monthKey || new Date().toISOString().slice(0, 7);
    const tLeads = Math.max(1, Number(targetLeads || 10));
    const tAmt = Math.max(100000, Number(targetAmount || 5000000));

    const existing = userId
      ? (db.prepare(`SELECT id FROM sales_targets WHERE month_key = ? AND user_id = ?`).get(mKey, Number(userId)) as any)
      : (db.prepare(`SELECT id FROM sales_targets WHERE month_key = ? AND user_id IS NULL AND branch_id = ?`).get(mKey, Number(branchId || 1)) as any);

    if (existing) {
      db.prepare(`
        UPDATE sales_targets SET target_leads = ?, target_amount = ?, updated_at = datetime('now') WHERE id = ?
      `).run(tLeads, tAmt, existing.id);
    } else {
      db.prepare(`
        INSERT INTO sales_targets (month_key, user_id, branch_id, target_leads, target_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(mKey, userId ? Number(userId) : null, branchId ? Number(branchId) : null, tLeads, tAmt);
    }

    logAudit(req.user!, 'SALES_TARGET_SAVED', 'TARGET', mKey, `Target ${tLeads} leads / ₹${tAmt} saved`);
    res.json({ ok: true });
  });

  // ============================================================================
  // BM DOWNLINE COMMAND CENTER (10 TLs -> 10 FOs -> REFERRALS, LEADS & ENQUIRIES)
  // ============================================================================
  router.get(
    '/bm/downline-hierarchy',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER'),
    (req: AuthedRequest, res) => {
      const caller = req.user!;
      const rawMonth = typeof req.query.month === 'string' ? req.query.month.trim() : '';
      const monthKey = /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : new Date().toISOString().slice(0, 7);

      const allBms = db
        .prepare(`
          SELECT u.id, u.employee_code as employeeCode, u.full_name as fullName,
                 u.mobile, u.email, u.is_active as isActive, u.branch_id as branchId,
                 b.name as branchName, b.code as branchCode,
                 (SELECT COUNT(*) FROM users tl WHERE tl.role = 'TEAM_LEADER' AND tl.reports_to_user_id = u.id) as tlCount
          FROM users u
          LEFT JOIN branches b ON b.id = u.branch_id
          WHERE u.role = 'BRANCH_MANAGER'
          ORDER BY tlCount DESC, u.id ASC
        `)
        .all() as any[];

      let selectedBm: any = null;
      let tlRows: any[] = [];

      if (caller.role === 'TEAM_LEADER') {
        const myTl = db
          .prepare(`
            SELECT u.id, u.employee_code as employeeCode, u.full_name as fullName,
                   u.mobile, u.email, u.is_active as isActive, u.branch_id as branchId,
                   u.reports_to_user_id as reportsToUserId, u.created_at as createdAt,
                   b.name as branchName, t.name as teamName
            FROM users u
            LEFT JOIN branches b ON b.id = u.branch_id
            LEFT JOIN teams t ON t.id = u.team_id
            WHERE u.id = ?
          `)
          .get(caller.id) as any;
        tlRows = myTl ? [myTl] : [];
        selectedBm =
          (myTl?.reportsToUserId
            ? allBms.find((b) => Number(b.id) === Number(myTl.reportsToUserId))
            : null) || {
            id: caller.id,
            employeeCode: caller.employeeCode,
            fullName: caller.fullName,
            mobile: caller.mobile,
            branchId: caller.branchId,
            branchName: caller.branchName || 'Branch',
            branchCode: '',
            tlCount: 1,
          };
      } else {
        const requestedBmId = req.query.bmId ? Number(req.query.bmId) : null;
        if (caller.role === 'BRANCH_MANAGER') {
          selectedBm = allBms.find((b) => Number(b.id) === Number(caller.id)) || {
            id: caller.id,
            employeeCode: caller.employeeCode,
            fullName: caller.fullName,
            mobile: caller.mobile,
            branchId: caller.branchId,
            branchName: caller.branchName || 'Branch',
            branchCode: '',
            tlCount: 0,
          };
        } else {
          selectedBm =
            (requestedBmId ? allBms.find((b) => Number(b.id) === requestedBmId) : null) ||
            allBms[0] ||
            null;
        }

        if (selectedBm) {
          tlRows = db
            .prepare(`
              SELECT u.id, u.employee_code as employeeCode, u.full_name as fullName,
                     u.mobile, u.email, u.is_active as isActive, u.branch_id as branchId,
                     u.reports_to_user_id as reportsToUserId, u.created_at as createdAt,
                     b.name as branchName, t.name as teamName
              FROM users u
              LEFT JOIN branches b ON b.id = u.branch_id
              LEFT JOIN teams t ON t.id = u.team_id
              WHERE u.role = 'TEAM_LEADER' AND u.reports_to_user_id = ?
              ORDER BY u.id ASC
              LIMIT 10
            `)
            .all(selectedBm.id) as any[];
        }
      }

      const tlIds = tlRows.map((t) => Number(t.id));
      const foRows: any[] =
        tlIds.length > 0
          ? (db
              .prepare(`
                SELECT u.id, u.employee_code as employeeCode, u.full_name as fullName,
                       u.mobile, u.email, u.is_active as isActive, u.branch_id as branchId,
                       u.reports_to_user_id as reportsToUserId, u.service_city as serviceCity,
                       u.service_pincodes as servicePincodes, u.created_at as createdAt
                FROM users u
                WHERE u.role = 'FIELD_OFFICER' AND u.reports_to_user_id IN (${tlIds.map(() => '?').join(',')})
                ORDER BY u.id ASC
              `)
              .all(...tlIds) as any[])
          : [];

      const foIds = foRows.map((f) => Number(f.id));
      const refRows: any[] =
        foIds.length > 0
          ? (db
              .prepare(`
                SELECT u.id, u.employee_code as employeeCode, u.referral_code as referralCode,
                       u.full_name as fullName, u.mobile, u.email, u.is_active as isActive,
                       u.reports_to_user_id as reportsToUserId, u.service_city as serviceCity,
                       u.created_at as createdAt
                FROM users u
                WHERE u.role = 'REFERRAL_PARTNER' AND u.reports_to_user_id IN (${foIds.map(() => '?').join(',')})
                ORDER BY u.id ASC
              `)
              .all(...foIds) as any[])
          : [];

      const targetUserIds = [...tlIds, ...foIds];
      const targetMap = new Map<number, { id: number; targetLeads: number; targetAmount: number }>();
      if (targetUserIds.length > 0) {
        const targetRows = db
          .prepare(`
            SELECT id, user_id as userId, target_leads as targetLeads, target_amount as targetAmount
            FROM sales_targets
            WHERE month_key = ? AND user_id IN (${targetUserIds.map(() => '?').join(',')})
          `)
          .all(monthKey, ...targetUserIds) as any[];
        for (const tr of targetRows) {
          targetMap.set(Number(tr.userId), {
            id: Number(tr.id),
            targetLeads: Number(tr.targetLeads || 0),
            targetAmount: Number(tr.targetAmount || 0),
          });
        }
      }

      // Load all relevant leads, enquiries, and referral payouts once for crisp in-memory attribution
      const allLeads = db
        .prepare(`
          SELECT l.id, l.lead_code as leadCode, l.customer_name as customerName,
                 l.loan_product as loanProduct, l.loan_amount as loanAmount, l.bank_nbfc as bankNbfc,
                 l.status, l.referral_id as referralId, l.referral_name as referralName,
                 l.created_by as createdBy, l.assigned_bm_id as assignedBmId,
                 l.assigned_tl_id as assignedTlId, l.assigned_officer_id as assignedOfficerId,
                 l.created_at as createdAt, l.updated_at as updatedAt
          FROM leads l
          ORDER BY l.id DESC
        `)
        .all() as any[];

      const allEnquiries = db
        .prepare(`
          SELECT e.id, e.enquiry_code as enquiryCode, e.lead_id as leadId,
                 l.lead_code as leadCode, e.referral_user_id as referralUserId,
                 e.referral_code as referralCode, u.full_name as referralName,
                 e.category, e.description, e.assigned_officer_id as assignedOfficerId,
                 e.status, e.solution_text as solutionText, e.sla_deadline_at as slaDeadlineAt,
                 e.created_at as createdAt, e.updated_at as updatedAt
          FROM enquiries e
          LEFT JOIN leads l ON l.id = e.lead_id
          LEFT JOIN users u ON u.id = e.referral_user_id
          ORDER BY e.id DESC
        `)
        .all() as any[];

      const allPayouts = db
        .prepare(`
          SELECT lead_id as leadId, referral_user_id as referralUserId, referral_code as referralCode,
                 payout_amount as payoutAmount, payout_status as payoutStatus
          FROM referral_payouts
        `)
        .all() as any[];

      const nowMs = Date.now();
      const isCompletedStatus = (st: string) => st === 'Disbursed' || st === 'Closed';
      const isDisbursedStatus = (st: string) => st === 'Disbursed';
      const isRejectedStatus = (st: string) => st === 'Rejected';
      const isOpenEnquiry = (st: string) => st !== 'Resolved' && st !== 'Closed';
      const isOverdueEnquiry = (enq: any) => {
        if (!isOpenEnquiry(enq.status) || enq.status === 'Solution Updated') return false;
        const deadlineMs = Date.parse(String(enq.slaDeadlineAt || ''));
        return Number.isFinite(deadlineMs) && deadlineMs < nowMs;
      };

      const refsByFo = new Map<number, any[]>();
      for (const r of refRows) {
        const foId = Number(r.reportsToUserId);
        const list = refsByFo.get(foId) || [];
        list.push(r);
        refsByFo.set(foId, list);
      }

      const fosByTl = new Map<number, any[]>();
      for (const f of foRows) {
        const tlId = Number(f.reportsToUserId);
        const list = fosByTl.get(tlId) || [];
        list.push(f);
        fosByTl.set(tlId, list);
      }

      const teamLeaders = tlRows.map((tl) => {
        const tlId = Number(tl.id);
        const tlFosRaw = (fosByTl.get(tlId) || []).slice(0, 10);
        const tlLeadMap = new Map<number, any>();
        const tlEnquiryMap = new Map<number, any>();

        const fieldOfficers = tlFosRaw.map((fo) => {
          const foId = Number(fo.id);
          const foRefsRaw = refsByFo.get(foId) || [];
          const refUserIds = new Set<number>(foRefsRaw.map((r) => Number(r.id)));
          const refCodeSet = new Set<string>();
          for (const r of foRefsRaw) {
            if (r.referralCode) refCodeSet.add(String(r.referralCode).trim().toUpperCase());
            if (r.employeeCode) refCodeSet.add(String(r.employeeCode).trim().toUpperCase());
          }

          // Match leads assigned to this FO or originated by any of this FO's mapped referrals
          const foLeads = allLeads.filter((l) => {
            if (Number(l.assignedOfficerId) === foId) return true;
            if (refUserIds.has(Number(l.createdBy))) return true;
            const refTag = String(l.referralId || '').trim().toUpperCase();
            if (refTag && refCodeSet.has(refTag)) return true;
            return false;
          });
          const foLeadIds = new Set<number>(foLeads.map((l) => Number(l.id)));

          // Match enquiries assigned to this FO, raised by their mapped referrals, or linked to their leads
          const foEnquiries = allEnquiries.filter((e) => {
            if (Number(e.assignedOfficerId) === foId) return true;
            if (refUserIds.has(Number(e.referralUserId))) return true;
            if (e.leadId && foLeadIds.has(Number(e.leadId))) return true;
            const refTag = String(e.referralCode || '').trim().toUpperCase();
            if (refTag && refCodeSet.has(refTag)) return true;
            return false;
          });

          for (const l of foLeads) tlLeadMap.set(Number(l.id), l);
          for (const e of foEnquiries) tlEnquiryMap.set(Number(e.id), e);

          const referrals = foRefsRaw.map((ref) => {
            const refId = Number(ref.id);
            const rCode = String(ref.referralCode || '').trim().toUpperCase();
            const eCode = String(ref.employeeCode || '').trim().toUpperCase();
            const rLeads = foLeads.filter((l) => {
              if (Number(l.createdBy) === refId) return true;
              const lRef = String(l.referralId || '').trim().toUpperCase();
              return Boolean(lRef && (lRef === rCode || lRef === eCode));
            });
            const rEnqs = foEnquiries.filter((e) => {
              if (Number(e.referralUserId) === refId) return true;
              const eRef = String(e.referralCode || '').trim().toUpperCase();
              return Boolean(eRef && (eRef === rCode || eRef === eCode));
            });
            const rPayouts = allPayouts.filter((p) => {
              if (Number(p.referralUserId) === refId) return true;
              const pRef = String(p.referralCode || '').trim().toUpperCase();
              return Boolean(pRef && (pRef === rCode || pRef === eCode));
            });
            const disbursedLeads = rLeads.filter((l) => isDisbursedStatus(l.status));
            const completedLeads = rLeads.filter((l) => isCompletedStatus(l.status));
            const rejectedLeads = rLeads.filter((l) => isRejectedStatus(l.status));
            const inProgressLeads = rLeads.filter((l) => !isCompletedStatus(l.status) && !isRejectedStatus(l.status));

            return {
              id: refId,
              employeeCode: ref.employeeCode,
              referralCode: ref.referralCode || ref.employeeCode,
              fullName: ref.fullName,
              mobile: ref.mobile || '',
              email: ref.email || '',
              isActive: Boolean(ref.isActive),
              serviceCity: ref.serviceCity || '',
              leadsTotal: rLeads.length,
              leadsInProgress: inProgressLeads.length,
              leadsCompleted: completedLeads.length,
              leadsDisbursed: disbursedLeads.length,
              leadsRejected: rejectedLeads.length,
              disbursedAmount: disbursedLeads.reduce((s, l) => s + Number(l.loanAmount || 0), 0),
              enquiriesTotal: rEnqs.length,
              enquiriesOpen: rEnqs.filter((e) => isOpenEnquiry(e.status)).length,
              enquiriesResolved: rEnqs.filter((e) => !isOpenEnquiry(e.status)).length,
              payoutPending: rPayouts
                .filter((p) => p.payoutStatus !== 'PAID')
                .reduce((s, p) => s + Number(p.payoutAmount || 0), 0),
              payoutPaid: rPayouts
                .filter((p) => p.payoutStatus === 'PAID')
                .reduce((s, p) => s + Number(p.payoutAmount || 0), 0),
            };
          });

          const foTarget = targetMap.get(foId);
          const foTargetLeads = foTarget?.targetLeads ?? 0;
          const foTargetAmount = foTarget?.targetAmount ?? 0;
          const foCompleted = foLeads.filter((l) => isCompletedStatus(l.status));
          const foDisbursed = foLeads.filter((l) => isDisbursedStatus(l.status));
          const foRejected = foLeads.filter((l) => isRejectedStatus(l.status));
          const foInProgress = foLeads.filter((l) => !isCompletedStatus(l.status) && !isRejectedStatus(l.status));
          const foDisbursedAmt = foDisbursed.reduce((s, l) => s + Number(l.loanAmount || 0), 0);
          const completionPct = foLeads.length > 0 ? Math.round((foCompleted.length / foLeads.length) * 100) : 0;
          const targetAchievementPct =
            foTargetAmount > 0
              ? Math.min(999, Math.round((foDisbursedAmt / foTargetAmount) * 100))
              : foTargetLeads > 0
              ? Math.min(999, Math.round((foCompleted.length / foTargetLeads) * 100))
              : 0;

          return {
            id: foId,
            employeeCode: fo.employeeCode,
            fullName: fo.fullName,
            mobile: fo.mobile || '',
            email: fo.email || '',
            isActive: Boolean(fo.isActive),
            serviceCity: fo.serviceCity || '',
            servicePincodes: fo.servicePincodes || '',
            referralCount: referrals.length,
            maxReferralCount: HIERARCHY_LIMITS.REFERRALS_PER_FO,
            activeReferralCount: referrals.filter((r) => r.isActive).length,
            targetLeads: foTargetLeads,
            targetAmount: foTargetAmount,
            leadsAssigned: foLeads.length,
            leadsInProgress: foInProgress.length,
            leadsCompleted: foCompleted.length,
            leadsDisbursed: foDisbursed.length,
            leadsRejected: foRejected.length,
            disbursedAmount: foDisbursedAmt,
            completionPct,
            targetAchievementPct,
            enquiriesTotal: foEnquiries.length,
            enquiriesOpen: foEnquiries.filter((e) => isOpenEnquiry(e.status)).length,
            enquiriesResolved: foEnquiries.filter((e) => !isOpenEnquiry(e.status)).length,
            enquiriesOverdue: foEnquiries.filter((e) => isOverdueEnquiry(e)).length,
            referrals,
            leads: foLeads.map((l) => ({
              id: Number(l.id),
              leadCode: l.leadCode,
              customerName: l.customerName,
              loanProduct: l.loanProduct,
              loanAmount: Number(l.loanAmount || 0),
              bankNbfc: l.bankNbfc,
              status: l.status,
              referralCode: l.referralId || '',
              referralName: l.referralName || '',
              createdBy: Number(l.createdBy),
              createdAt: l.createdAt,
              updatedAt: l.updatedAt,
            })),
            enquiries: foEnquiries.map((e) => ({
              id: Number(e.id),
              enquiryCode: e.enquiryCode,
              leadId: e.leadId ? Number(e.leadId) : null,
              leadCode: e.leadCode || '',
              referralUserId: Number(e.referralUserId),
              referralCode: e.referralCode || '',
              referralName: e.referralName || '',
              category: e.category,
              description: e.description,
              status: e.status,
              solutionText: e.solutionText || '',
              slaDeadlineAt: e.slaDeadlineAt,
              isOverdue: isOverdueEnquiry(e),
              createdAt: e.createdAt,
              updatedAt: e.updatedAt,
            })),
          };
        });

        // Include any leads directly assigned to this TL (even if not yet assigned to an FO)
        for (const l of allLeads) {
          if (Number(l.assignedTlId) === tlId) {
            tlLeadMap.set(Number(l.id), l);
          }
        }

        const tlLeads = Array.from(tlLeadMap.values());
        const tlEnquiries = Array.from(tlEnquiryMap.values());
        const tlCompleted = tlLeads.filter((l) => isCompletedStatus(l.status));
        const tlDisbursed = tlLeads.filter((l) => isDisbursedStatus(l.status));
        const tlRejected = tlLeads.filter((l) => isRejectedStatus(l.status));
        const tlInProgress = tlLeads.filter((l) => !isCompletedStatus(l.status) && !isRejectedStatus(l.status));
        const tlDisbursedAmt = tlDisbursed.reduce((s, l) => s + Number(l.loanAmount || 0), 0);

        const tlTarget = targetMap.get(tlId);
        const tlTargetLeads = tlTarget?.targetLeads ?? 0;
        const tlTargetAmount = tlTarget?.targetAmount ?? 0;
        const completionPct = tlLeads.length > 0 ? Math.round((tlCompleted.length / tlLeads.length) * 100) : 0;
        const targetAchievementPct =
          tlTargetAmount > 0
            ? Math.min(999, Math.round((tlDisbursedAmt / tlTargetAmount) * 100))
            : tlTargetLeads > 0
            ? Math.min(999, Math.round((tlCompleted.length / tlTargetLeads) * 100))
            : 0;

        return {
          id: tlId,
          employeeCode: tl.employeeCode,
          fullName: tl.fullName,
          mobile: tl.mobile || '',
          email: tl.email || '',
          isActive: Boolean(tl.isActive),
          branchName: tl.branchName || '',
          teamName: tl.teamName || '',
          foCount: fieldOfficers.length,
          maxFoCount: HIERARCHY_LIMITS.FIELD_OFFICERS_PER_TL,
          activeFoCount: fieldOfficers.filter((f) => f.isActive).length,
          referralCount: fieldOfficers.reduce((s, f) => s + f.referralCount, 0),
          targetLeads: tlTargetLeads,
          targetAmount: tlTargetAmount,
          leadsAssigned: tlLeads.length,
          leadsInProgress: tlInProgress.length,
          leadsCompleted: tlCompleted.length,
          leadsDisbursed: tlDisbursed.length,
          leadsRejected: tlRejected.length,
          disbursedAmount: tlDisbursedAmt,
          completionPct,
          targetAchievementPct,
          enquiriesTotal: tlEnquiries.length,
          enquiriesOpen: tlEnquiries.filter((e) => isOpenEnquiry(e.status)).length,
          enquiriesResolved: tlEnquiries.filter((e) => !isOpenEnquiry(e.status)).length,
          enquiriesOverdue: tlEnquiries.filter((e) => isOverdueEnquiry(e)).length,
          fieldOfficers,
        };
      });

      const totalLeadsAssigned = teamLeaders.reduce((s, t) => s + t.leadsAssigned, 0);
      const totalLeadsCompleted = teamLeaders.reduce((s, t) => s + t.leadsCompleted, 0);
      const totalLeadsInProgress = teamLeaders.reduce((s, t) => s + t.leadsInProgress, 0);
      const totalDisbursedLeads = teamLeaders.reduce((s, t) => s + t.leadsDisbursed, 0);
      const totalDisbursedAmount = teamLeaders.reduce((s, t) => s + t.disbursedAmount, 0);
      const totalTargetLeads = teamLeaders.reduce((s, t) => s + t.targetLeads, 0);
      const totalTargetAmount = teamLeaders.reduce((s, t) => s + t.targetAmount, 0);

      res.json({
        monthKey,
        canAssignTargets: caller.role === 'SUPER_ADMIN' || caller.role === 'BRANCH_MANAGER',
        branchManagers: caller.role === 'SUPER_ADMIN' ? allBms : selectedBm ? [selectedBm] : [],
        selectedBm,
        summary: {
          totalTeamLeaders: teamLeaders.length,
          maxTeamLeaders: HIERARCHY_LIMITS.TEAM_LEADERS_PER_BM,
          activeTeamLeaders: teamLeaders.filter((t) => t.isActive).length,
          totalFieldOfficers: teamLeaders.reduce((s, t) => s + t.foCount, 0),
          maxFieldOfficers: HIERARCHY_LIMITS.TEAM_LEADERS_PER_BM * HIERARCHY_LIMITS.FIELD_OFFICERS_PER_TL,
          activeFieldOfficers: teamLeaders.reduce((s, t) => s + t.activeFoCount, 0),
          totalReferrals: teamLeaders.reduce((s, t) => s + t.referralCount, 0),
          totalLeadsAssigned,
          totalLeadsInProgress,
          totalLeadsCompleted,
          totalDisbursedLeads,
          totalDisbursedAmount,
          completionPct: totalLeadsAssigned > 0 ? Math.round((totalLeadsCompleted / totalLeadsAssigned) * 100) : 0,
          totalTargetLeads,
          totalTargetAmount,
          achievementPct:
            totalTargetAmount > 0
              ? Math.min(999, Math.round((totalDisbursedAmount / totalTargetAmount) * 100))
              : totalTargetLeads > 0
              ? Math.min(999, Math.round((totalLeadsCompleted / totalTargetLeads) * 100))
              : 0,
          totalEnquiries: teamLeaders.reduce((s, t) => s + t.enquiriesTotal, 0),
          openEnquiries: teamLeaders.reduce((s, t) => s + t.enquiriesOpen, 0),
          resolvedEnquiries: teamLeaders.reduce((s, t) => s + t.enquiriesResolved, 0),
          overdueEnquiries: teamLeaders.reduce((s, t) => s + t.enquiriesOverdue, 0),
        },
        teamLeaders,
      });
    }
  );

  router.post(
    '/bm/assign-target',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER'),
    (req: AuthedRequest, res) => {
      const caller = req.user!;
      const body = req.body as {
        monthKey?: string;
        userId?: number;
        targetLeads?: number;
        targetAmount?: number;
        targets?: { userId: number; targetLeads: number; targetAmount: number }[];
      };

      const rawMonth = typeof body?.monthKey === 'string' ? body.monthKey.trim() : '';
      const monthKey = /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : new Date().toISOString().slice(0, 7);

      const items = Array.isArray(body?.targets)
        ? body.targets
        : body?.userId
        ? [
            {
              userId: Number(body.userId),
              targetLeads: Number(body.targetLeads || 0),
              targetAmount: Number(body.targetAmount || 0),
            },
          ]
        : [];

      if (items.length === 0) {
        res.status(400).json({ error: 'At least one Team Leader or Field Officer target is required.' });
        return;
      }

      // Compute allowed downline IDs for BM
      let allowedDownlineIds: Set<number> | null = null;
      if (caller.role === 'BRANCH_MANAGER') {
        const myTls = db
          .prepare(`SELECT id FROM users WHERE role = 'TEAM_LEADER' AND reports_to_user_id = ?`)
          .all(caller.id) as { id: number }[];
        const tlIdList = myTls.map((t) => Number(t.id));
        const myFos =
          tlIdList.length > 0
            ? (db
                .prepare(
                  `SELECT id FROM users WHERE role = 'FIELD_OFFICER' AND reports_to_user_id IN (${tlIdList.map(() => '?').join(',')})`
                )
                .all(...tlIdList) as { id: number }[])
            : [];
        allowedDownlineIds = new Set<number>([...tlIdList, ...myFos.map((f) => Number(f.id))]);
      }

      let savedCount = 0;
      for (const item of items) {
        const targetUid = Number(item.userId);
        if (!targetUid) continue;
        if (allowedDownlineIds && !allowedDownlineIds.has(targetUid)) {
          res.status(403).json({ error: 'You can only assign targets to Team Leaders & Field Officers mapped in your downline.' });
          return;
        }
        const targetUser = db
          .prepare(`SELECT id, employee_code, full_name, role, branch_id FROM users WHERE id = ?`)
          .get(targetUid) as any;
        if (!targetUser) continue;

        const tLeads = Math.max(1, Math.min(5000, Math.round(Number(item.targetLeads || 10))));
        const tAmt = Math.max(50000, Math.min(1000000000, Math.round(Number(item.targetAmount || 500000))));

        const existing = db
          .prepare(`SELECT id FROM sales_targets WHERE month_key = ? AND user_id = ?`)
          .get(monthKey, targetUid) as { id: number } | undefined;

        if (existing) {
          db.prepare(`
            UPDATE sales_targets
            SET target_leads = ?, target_amount = ?, branch_id = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(tLeads, tAmt, targetUser.branch_id ?? null, existing.id);
        } else {
          db.prepare(`
            INSERT INTO sales_targets (month_key, user_id, branch_id, target_leads, target_amount)
            VALUES (?, ?, ?, ?, ?)
          `).run(monthKey, targetUid, targetUser.branch_id ?? null, tLeads, tAmt);
        }

        createAlert({
          userId: targetUid,
          category: 'Lead Follow-up Alert',
          titleEn: `Monthly Target Assigned (${monthKey})`,
          titleHi: `मासिक टारगेट असाइन (${monthKey})`,
          messageEn: `${caller.fullName} (${caller.employeeCode}) assigned you a target of ${tLeads} leads & ₹${tAmt.toLocaleString('en-IN')} for ${monthKey}.`,
          messageHi: `${caller.fullName} (${caller.employeeCode}) ने ${monthKey} के लिए ${tLeads} लीड और ₹${tAmt.toLocaleString('en-IN')} का टारगेट दिया है।`,
        });

        savedCount += 1;
      }

      logAudit(
        caller,
        'BM_TARGET_ASSIGNED',
        'TARGET',
        monthKey,
        `Assigned monthly targets for ${savedCount} downline team member(s)`
      );
      broadcastLiveSync('TARGET_ASSIGNED', `BM updated ${monthKey} targets for ${savedCount} team member(s)`, caller);
      res.json({ ok: true, savedCount, monthKey });
    }
  );

  // Referral Payout Ledger & Leaderboard (Strict Referral Privacy Enforcement)
  router.get('/sales/referral-hub', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const settings = getSettings();
    const isReferral = user.role === 'REFERRAL_PARTNER';
    const monthKey = new Date().toISOString().slice(0, 7);

    const commissionSlabs = settings.loanProducts.map((p) => ({
      id: p.id,
      name: p.name,
      defaultRate: p.defaultRate,
      commissionPct: p.commissionPct ?? 0.5,
    }));

    // Payout rows (only own for Referral Partner, all for Admin/BM)
    const whereClause = isReferral ? 'WHERE rp.referral_user_id = ?' : '';
    const params = isReferral ? [user.id] : [];
    const payoutRows = db
      .prepare(`
        SELECT rp.id, rp.lead_id as leadId, l.lead_code as leadCode, l.customer_name as customerName,
          l.status as caseStatus, rp.referral_user_id as referralUserId, rp.referral_code as referralCode,
          u.full_name as partnerName, rp.loan_product as loanProduct,
          rp.base_rate_pct as baseRatePct, rp.bonus_rate_pct as bonusRatePct,
          rp.payout_amount as payoutAmount, rp.payout_status as payoutStatus,
          rp.paid_at as paidAt, rp.created_at as createdAt,
          CASE WHEN ? = 1 THEN NULL ELSE l.loan_amount END as loanAmount
        FROM referral_payouts rp
        JOIN leads l ON l.id = rp.lead_id
        LEFT JOIN users u ON u.id = rp.referral_user_id
        ${whereClause}
        ORDER BY rp.created_at DESC
      `)
      .all(isReferral ? 1 : 0, ...params) as any[];

    // Own / Overall summary
    const totalEarned = payoutRows.reduce((s, r) => s + Number(r.payoutAmount || 0), 0);
    const paidAmount = payoutRows.filter((r) => r.payoutStatus === 'PAID').reduce((s, r) => s + Number(r.payoutAmount || 0), 0);
    const pendingAmount = totalEarned - paidAmount;

    // Monthly Leaderboard
    const leaderboardRows = db
      .prepare(`
        SELECT u.id, u.full_name as partnerName, u.referral_code as referralCode,
          COUNT(l.id) as totalLeads,
          SUM(CASE WHEN l.status = 'Disbursed' THEN 1 ELSE 0 END) as disbursedCount,
          SUM(CASE WHEN l.status = 'Disbursed' AND substr(l.updated_at, 1, 7) = ? THEN 1 ELSE 0 END) as monthlyDisbursed
        FROM users u
        LEFT JOIN leads l ON (l.created_by = u.id OR l.referral_id = u.referral_code)
        WHERE u.role = 'REFERRAL_PARTNER' AND u.is_active = 1
        GROUP BY u.id
        ORDER BY disbursedCount DESC, totalLeads DESC
      `)
      .all(monthKey) as any[];

    const bonusThreshold = Number(settings.referralBonusThreshold ?? 5);
    const bonusPct = Number(settings.referralBonusPct ?? 0.15);

    const leaderboard = leaderboardRows.map((r, idx) => ({
      rank: idx + 1,
      partnerName: isReferral && r.id !== user.id ? `DSA Partner #${idx + 1}` : r.partnerName,
      referralCode: isReferral && r.id !== user.id ? 'PROTECTED' : r.referralCode,
      isSelf: r.id === user.id,
      totalLeads: Number(r.totalLeads || 0),
      disbursedCount: Number(r.disbursedCount || 0),
      monthlyDisbursed: Number(r.monthlyDisbursed || 0),
      tier:
        Number(r.disbursedCount || 0) >= bonusThreshold
          ? 'Gold'
          : Number(r.disbursedCount || 0) >= 2
          ? 'Silver'
          : 'Bronze',
      bonusUnlocked: Number(r.monthlyDisbursed || 0) >= bonusThreshold,
    }));

    const selfBoard = leaderboardRows.find((r) => r.id === user.id);

    res.json({
      commissionSlabs,
      bonusThreshold,
      bonusPct,
      summary: {
        totalEarned,
        paidAmount,
        pendingAmount,
        monthlyDisbursed: Number(selfBoard?.monthlyDisbursed || 0),
      },
      payoutRows,
      leaderboard,
    });
  });

  router.patch('/sales/payouts/:id', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const id = Number(req.params.id);
    const { payoutStatus, remarks } = req.body as { payoutStatus?: 'APPROVED' | 'PAID'; remarks?: string };
    if (!payoutStatus || !['APPROVED', 'PAID'].includes(payoutStatus)) {
      res.status(400).json({ error: 'Valid payoutStatus (APPROVED or PAID) required' });
      return;
    }

    const row = db
      .prepare(`SELECT rp.*, l.lead_code FROM referral_payouts rp JOIN leads l ON l.id = rp.lead_id WHERE rp.id = ?`)
      .get(id) as any;
    if (!row) {
      res.status(404).json({ error: 'Payout record not found' });
      return;
    }

    const paidAt = payoutStatus === 'PAID' ? nowSql() : null;
    db.prepare(`UPDATE referral_payouts SET payout_status = ?, paid_at = COALESCE(?, paid_at), remarks = ? WHERE id = ?`).run(
      payoutStatus,
      paidAt,
      remarks || null,
      id
    );

    if (row.referral_user_id) {
      createAlert({
        userId: row.referral_user_id,
        leadId: row.lead_id,
        category: 'Lead Follow-up Alert',
        titleEn: `Referral Payout ${payoutStatus}: ${row.lead_code}`,
        titleHi: `रेफरल कमीशन ${payoutStatus === 'PAID' ? 'भुगतान हुआ' : 'स्वीकृत'}: ${row.lead_code}`,
        messageEn: `Commission of ₹${Number(row.payout_amount).toLocaleString('en-IN')} on ${row.lead_code} marked ${payoutStatus}.`,
        messageHi: `${row.lead_code} पर ₹${Number(row.payout_amount).toLocaleString('en-IN')} कमीशन ${payoutStatus} हुआ।`,
      });
    }

    logAudit(admin, `REFERRAL_PAYOUT_${payoutStatus}`, 'PAYOUT', row.lead_code, `₹${row.payout_amount} marked ${payoutStatus}`);
    res.json({ ok: true });
  });

  router.get('/admin/audit-logs', requireAuth, requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER'), (_req, res) => {
    const logs = db
      .prepare(`
        SELECT id, user_id as userId, user_name as userName, user_role as userRole,
          action, entity_type as entityType, entity_id as entityId, details, created_at as createdAt
        FROM audit_logs
        ORDER BY id DESC
        LIMIT 300
      `)
      .all();
    res.json({ logs });
  });

  router.post('/admin/reset-test-data', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    clearTestData(req.user!);
    res.json({ ok: true });
  });

  router.post('/admin/seed-test-data', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    seedVerificationDatasetInternal(false);
    seedSalesExtensionsIfNeeded();
    res.json({ ok: true });
  });

  // ============================================================================
  // FIREBASE CLOUD SYNC BRIDGE (SUPER ADMIN ONLY)
  // ============================================================================
  router.get('/admin/cloud-sync/export', requireAuth, requireRoles('SUPER_ADMIN'), (_req: AuthedRequest, res) => {
    const branches = (
      db
        .prepare(`SELECT id, code, name, city, state, is_active FROM branches ORDER BY id ASC`)
        .all() as any[]
    ).map((b) => ({
      code: String(b.code || '').trim().toUpperCase(),
      name: String(b.name || '').trim(),
      city: String(b.city || '').trim(),
      state: String(b.state || '').trim(),
      isActive: Boolean(b.is_active),
    }));

    const branchIdToCode = new Map<number, string>();
    const branchRows = db.prepare(`SELECT id, code FROM branches`).all() as { id: number; code: string }[];
    for (const b of branchRows) {
      branchIdToCode.set(Number(b.id), String(b.code || '').trim().toUpperCase());
    }

    const teamIdToName = new Map<number, string>();
    const teamRows = db.prepare(`SELECT id, name FROM teams`).all() as { id: number; name: string }[];
    for (const t of teamRows) {
      teamIdToName.set(Number(t.id), String(t.name || '').trim());
    }

    const userIdToCode = new Map<number, string>();
    const allUserCodes = db.prepare(`SELECT id, employee_code FROM users`).all() as { id: number; employee_code: string }[];
    for (const u of allUserCodes) {
      userIdToCode.set(Number(u.id), String(u.employee_code || '').trim().toUpperCase());
    }

    const employees = (
      db
        .prepare(`
          SELECT employee_code, full_name, mobile, email, password_hash, admin_saved_password_enc,
                 role, branch_id, team_id, reports_to_user_id, referral_code, service_city,
                 service_pincodes, is_active, otp_enabled, preferred_lang
          FROM users
          ORDER BY id ASC
        `)
        .all() as any[]
    ).map((u) => ({
      employeeCode: String(u.employee_code || '').trim().replace(/\s+/g, '').toUpperCase(),
      fullName: String(u.full_name || u.employee_code || '').trim(),
      mobile: String(u.mobile || '').trim(),
      email: String(u.email || '').trim(),
      passwordHash: String(u.password_hash || ''),
      adminSavedPasswordEnc: String(u.admin_saved_password_enc || ''),
      role: String(u.role || 'FIELD_OFFICER'),
      branchCode: u.branch_id ? branchIdToCode.get(Number(u.branch_id)) || '' : '',
      teamName: u.team_id ? teamIdToName.get(Number(u.team_id)) || '' : '',
      reportsToEmployeeCode: u.reports_to_user_id ? userIdToCode.get(Number(u.reports_to_user_id)) || '' : '',
      referralCode: String(u.referral_code || '').trim(),
      serviceCity: String(u.service_city || '').trim(),
      servicePincodes: String(u.service_pincodes || '').trim(),
      isActive: Boolean(u.is_active),
      otpEnabled: Boolean(u.otp_enabled),
      preferredLang: u.preferred_lang === 'hi' ? 'hi' : 'en',
    }));

    const currentSettings = getSettings();
    const settings = [
      {
        settingKey: 'global',
        officeName: String(currentSettings.officeName || 'AMBIKA ASSOCIATE Head Office'),
        officeAddress: String(currentSettings.officeAddress || ''),
        petrolRatePerKm: Number(currentSettings.petrolRatePerKm ?? 3),
        attendanceCutoffTime: String(currentSettings.attendanceCutoffTime || '10:30'),
        attendanceLatePenaltyInr: Number(currentSettings.attendanceLatePenaltyInr ?? 20),
        unapprovedLeavePenaltyInr: Number(currentSettings.unapprovedLeavePenaltyInr ?? 100),
        defaultLanguage: currentSettings.defaultLanguage === 'hi' ? 'hi' : 'en',
      },
    ];

    res.json({ branches, employees, settings });
  });

  router.post('/admin/cloud-sync/restore', requireAuth, requireRoles('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const admin = req.user!;
    const body = req.body as {
      branches?: any[];
      employees?: any[];
      settings?: any[];
    };

    const cloudBranches = Array.isArray(body?.branches) ? body.branches : [];
    const cloudEmployees = Array.isArray(body?.employees) ? body.employees : [];

    let restoredBranches = 0;
    const branchCodeToId = new Map<string, number>();
    const existingBranches = db.prepare(`SELECT id, code FROM branches`).all() as { id: number; code: string }[];
    for (const b of existingBranches) {
      branchCodeToId.set(String(b.code || '').trim().toUpperCase(), Number(b.id));
    }

    const insertBranch = db.prepare(`
      INSERT OR IGNORE INTO branches (code, name, city, state, is_active)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const cb of cloudBranches) {
      const code = String(cb?.code || '').trim().replace(/\s+/g, '').toUpperCase();
      if (!code || branchCodeToId.has(code)) continue;
      const result = insertBranch.run(
        code,
        String(cb?.name || code).trim(),
        String(cb?.city || '').trim(),
        String(cb?.state || '').trim(),
        cb?.isActive === false ? 0 : 1
      );
      if (result.changes > 0) {
        restoredBranches += 1;
        branchCodeToId.set(code, Number(result.lastInsertRowid));
      }
    }

    const defaultBranch = db.prepare(`SELECT id FROM branches ORDER BY id ASC LIMIT 1`).get() as { id: number } | undefined;
    const existingUsers = db
      .prepare(`SELECT id, UPPER(REPLACE(employee_code, ' ', '')) as code, admin_saved_password_enc FROM users`)
      .all() as { id: number; code: string; admin_saved_password_enc: string | null }[];
    const existingCodeMap = new Map<string, { id: number; hasSavedPass: boolean }>();
    for (const u of existingUsers) {
      existingCodeMap.set(u.code, { id: Number(u.id), hasSavedPass: Boolean(u.admin_saved_password_enc) });
    }

    const insertUser = db.prepare(`
      INSERT OR IGNORE INTO users (
        employee_code, full_name, mobile, email, password_hash, admin_saved_password_enc,
        role, branch_id, team_id, referral_code, is_active, otp_enabled,
        gps_consent, camera_consent, preferred_lang, service_city, service_pincodes,
        reports_to_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, 1, ?, ?, ?, NULL)
    `);

    let restoredEmployees = 0;
    const pendingParentLinks: { employeeCode: string; parentCode: string }[] = [];

    for (const ce of cloudEmployees) {
      const cleanCode = String(ce?.employeeCode || '').trim().replace(/\s+/g, '').toUpperCase();
      if (!cleanCode || cleanCode.length < 2) continue;
      const passwordHash = String(ce?.passwordHash || '').trim();
      if (passwordHash.length < 10) continue;

      const existingEntry = existingCodeMap.get(cleanCode);
      if (existingEntry) {
        // Hydrate encrypted admin saved password if missing locally
        if (!existingEntry.hasSavedPass && ce?.adminSavedPasswordEnc) {
          db.prepare(`UPDATE users SET admin_saved_password_enc = ? WHERE id = ?`).run(
            String(ce.adminSavedPasswordEnc),
            existingEntry.id
          );
        }
        continue;
      }

      const role = VALID_USER_ROLES.includes(ce?.role) ? ce.role : 'FIELD_OFFICER';
      const bCode = String(ce?.branchCode || '').trim().toUpperCase();
      const branchId = (bCode ? branchCodeToId.get(bCode) : undefined) ?? defaultBranch?.id ?? null;
      const rawRef = String(ce?.referralCode || '').trim();
      let safeRef: string | null = rawRef || null;
      if (safeRef) {
        const refConflict = db
          .prepare(`SELECT id FROM users WHERE UPPER(referral_code) = UPPER(?)`)
          .get(safeRef);
        if (refConflict) safeRef = null;
      }

      try {
        const ins = insertUser.run(
          cleanCode,
          String(ce?.fullName || cleanCode).trim(),
          String(ce?.mobile || '').trim(),
          String(ce?.email || `${cleanCode.toLowerCase()}@ambikaassociate.in`).trim(),
          passwordHash,
          ce?.adminSavedPasswordEnc ? String(ce.adminSavedPasswordEnc) : null,
          role,
          branchId,
          safeRef,
          ce?.isActive === false ? 0 : 1,
          ce?.otpEnabled ? 1 : 0,
          ce?.preferredLang === 'hi' ? 'hi' : 'en',
          ce?.serviceCity ? String(ce.serviceCity).trim() : null,
          ce?.servicePincodes ? String(ce.servicePincodes).trim() : null
        );
        if (ins.changes > 0) {
          restoredEmployees += 1;
          existingCodeMap.set(cleanCode, {
            id: Number(ins.lastInsertRowid),
            hasSavedPass: Boolean(ce?.adminSavedPasswordEnc),
          });
          if (ce?.reportsToEmployeeCode) {
            pendingParentLinks.push({
              employeeCode: cleanCode,
              parentCode: String(ce.reportsToEmployeeCode).trim().toUpperCase(),
            });
          }
        }
      } catch {
        // skip conflicting duplicate constraint rows cleanly
      }
    }

    for (const link of pendingParentLinks) {
      const parent = db
        .prepare(`SELECT id FROM users WHERE UPPER(employee_code) = UPPER(?)`)
        .get(link.parentCode) as { id: number } | undefined;
      if (parent) {
        db.prepare(`UPDATE users SET reports_to_user_id = ? WHERE UPPER(employee_code) = UPPER(?) AND reports_to_user_id IS NULL`).run(
          parent.id,
          link.employeeCode
        );
      }
    }

    if (restoredEmployees > 0 || restoredBranches > 0) {
      syncUsersBackupToDisk();
      logAudit(
        admin,
        'CLOUD_SYNC_RESTORED',
        'SYSTEM',
        'FIRESTORE',
        `Restored ${restoredEmployees} employee ID(s) and ${restoredBranches} branch(es) from Google Cloud Firestore`
      );
    }

    const totalUsersRow = db.prepare(`SELECT COUNT(*) as cnt FROM users`).get() as { cnt: number };
    res.json({
      ok: true,
      restoredEmployees,
      restoredBranches,
      totalUsers: Number(totalUsersRow?.cnt ?? 0),
    });
  });

  // ============================================================================
  // STAFF REWARD POINTS & WRONG-LEAD MINUS PENALTY (FIELD OFFICER & STAFF ONLY)
  // ============================================================================
  router.get('/rewards', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.role === 'REFERRAL_PARTNER') {
      res.status(403).json({ error: 'Staff reward points are available for internal Field Officers and Lead Generator staff only' });
      return;
    }

    const scopeWhere =
      user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR'
        ? 'sr.employee_id = ?'
        : user.role === 'TEAM_LEADER'
        ? '(sr.employee_id = ? OR u.team_id = ?)'
        : user.role === 'BRANCH_MANAGER'
        ? 'u.branch_id = ?'
        : '1 = 1';
    const scopeParams =
      user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR'
        ? [user.id]
        : user.role === 'TEAM_LEADER'
        ? [user.id, user.teamId ?? -1]
        : user.role === 'BRANCH_MANAGER'
        ? [user.branchId ?? -1]
        : [];

    const entries = db
      .prepare(`
        SELECT
          sr.id,
          sr.reward_code as rewardCode,
          sr.employee_id as employeeId,
          u.full_name as employeeName,
          u.employee_code as employeeCode,
          u.role as employeeRole,
          sr.staff_bucket as staffBucket,
          sr.lead_id as leadId,
          l.lead_code as leadCode,
          l.customer_name as customerName,
          l.loan_product as loanProduct,
          sr.entry_type as entryType,
          sr.points_delta as pointsDelta,
          sr.amount_inr as amountInr,
          sr.status,
          sr.reason,
          sr.awarded_by as awardedBy,
          ab.full_name as awardedByName,
          wb.full_name as waivedByName,
          sr.waived_at as waivedAt,
          sr.created_at as createdAt
        FROM staff_rewards sr
        JOIN users u ON u.id = sr.employee_id
        LEFT JOIN leads l ON l.id = sr.lead_id
        LEFT JOIN users ab ON ab.id = sr.awarded_by
        LEFT JOIN users wb ON wb.id = sr.waived_by
        WHERE ${scopeWhere}
        ORDER BY sr.id DESC
        LIMIT 300
      `)
      .all(...scopeParams) as any[];

    const activeEntries = entries.filter((e) => e.status === 'ACTIVE');
    const summary = {
      loginRewardPts: activeEntries
        .filter((e) => e.entryType === 'DOC_LOGIN_REWARD')
        .reduce((s, e) => s + Number(e.pointsDelta), 0),
      loginRewardCount: activeEntries.filter((e) => e.entryType === 'DOC_LOGIN_REWARD').length,
      disbursementRewardPts: activeEntries
        .filter((e) => e.entryType === 'DISBURSEMENT_REWARD')
        .reduce((s, e) => s + Number(e.pointsDelta), 0),
      disbursementRewardCount: activeEntries.filter((e) => e.entryType === 'DISBURSEMENT_REWARD').length,
      wrongLeadPenaltyPts: activeEntries
        .filter((e) => e.entryType === 'WRONG_LEAD_PENALTY')
        .reduce((s, e) => s + Math.abs(Number(e.pointsDelta)), 0),
      wrongLeadCount: activeEntries.filter((e) => e.entryType === 'WRONG_LEAD_PENALTY').length,
      netRewardPts: activeEntries.reduce((s, e) => s + Number(e.pointsDelta), 0),
    };

    const staffWhere =
      user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR'
        ? `u.id = ?`
        : user.role === 'TEAM_LEADER'
        ? `u.role != 'REFERRAL_PARTNER' AND u.is_active = 1 AND (u.id = ? OR u.team_id = ?)`
        : user.role === 'BRANCH_MANAGER'
        ? `u.role != 'REFERRAL_PARTNER' AND u.is_active = 1 AND u.branch_id = ?`
        : `u.role != 'REFERRAL_PARTNER' AND u.is_active = 1`;
    const staffParams =
      user.role === 'FIELD_OFFICER' || user.role === 'LEAD_GENERATOR'
        ? [user.id]
        : user.role === 'TEAM_LEADER'
        ? [user.id, user.teamId ?? -1]
        : user.role === 'BRANCH_MANAGER'
        ? [user.branchId ?? -1]
        : [];

    const staffBalances = db
      .prepare(`
        SELECT
          u.id as employeeId,
          u.full_name as employeeName,
          u.employee_code as employeeCode,
          u.role as employeeRole,
          COALESCE(SUM(CASE WHEN sr.status = 'ACTIVE' AND sr.entry_type = 'DOC_LOGIN_REWARD' THEN sr.points_delta ELSE 0 END), 0) as loginPts,
          COALESCE(SUM(CASE WHEN sr.status = 'ACTIVE' AND sr.entry_type = 'DISBURSEMENT_REWARD' THEN sr.points_delta ELSE 0 END), 0) as disbursementPts,
          COALESCE(SUM(CASE WHEN sr.status = 'ACTIVE' AND sr.entry_type = 'WRONG_LEAD_PENALTY' THEN ABS(sr.points_delta) ELSE 0 END), 0) as wrongLeadPenaltyPts,
          COALESCE(SUM(CASE WHEN sr.status = 'ACTIVE' THEN sr.points_delta ELSE 0 END), 0) as netPts
        FROM users u
        LEFT JOIN staff_rewards sr ON sr.employee_id = u.id
        WHERE ${staffWhere}
        GROUP BY u.id
        ORDER BY netPts DESC, u.full_name ASC
      `)
      .all(...staffParams);

    const eligibleStaff = db
      .prepare(`
        SELECT id, full_name as fullName, employee_code as employeeCode, role
        FROM users
        WHERE role != 'REFERRAL_PARTNER' AND is_active = 1
        ORDER BY full_name ASC
      `)
      .all();

    const myEntries = db
      .prepare(`
        SELECT
          sr.id,
          sr.reward_code as rewardCode,
          sr.employee_id as employeeId,
          u.full_name as employeeName,
          u.employee_code as employeeCode,
          u.role as employeeRole,
          sr.staff_bucket as staffBucket,
          sr.lead_id as leadId,
          l.lead_code as leadCode,
          l.customer_name as customerName,
          l.loan_product as loanProduct,
          sr.entry_type as entryType,
          sr.points_delta as pointsDelta,
          sr.amount_inr as amountInr,
          sr.status,
          sr.reason,
          sr.awarded_by as awardedBy,
          ab.full_name as awardedByName,
          wb.full_name as waivedByName,
          sr.waived_at as waivedAt,
          sr.created_at as createdAt
        FROM staff_rewards sr
        JOIN users u ON u.id = sr.employee_id
        LEFT JOIN leads l ON l.id = sr.lead_id
        LEFT JOIN users ab ON ab.id = sr.awarded_by
        LEFT JOIN users wb ON wb.id = sr.waived_by
        WHERE sr.employee_id = ?
        ORDER BY sr.id DESC
        LIMIT 300
      `)
      .all(user.id) as any[];

    const myActiveEntries = myEntries.filter((e) => e.status === 'ACTIVE');
    const mySummary = {
      loginRewardPts: myActiveEntries
        .filter((e) => e.entryType === 'DOC_LOGIN_REWARD')
        .reduce((s, e) => s + Number(e.pointsDelta), 0),
      loginRewardCount: myActiveEntries.filter((e) => e.entryType === 'DOC_LOGIN_REWARD').length,
      disbursementRewardPts: myActiveEntries
        .filter((e) => e.entryType === 'DISBURSEMENT_REWARD')
        .reduce((s, e) => s + Number(e.pointsDelta), 0),
      disbursementRewardCount: myActiveEntries.filter((e) => e.entryType === 'DISBURSEMENT_REWARD').length,
      wrongLeadPenaltyPts: myActiveEntries
        .filter((e) => e.entryType === 'WRONG_LEAD_PENALTY')
        .reduce((s, e) => s + Math.abs(Number(e.pointsDelta)), 0),
      wrongLeadCount: myActiveEntries.filter((e) => e.entryType === 'WRONG_LEAD_PENALTY').length,
      netRewardPts: myActiveEntries.reduce((s, e) => s + Number(e.pointsDelta), 0),
    };

    const settings = getSettings();
    res.json({
      mySummary,
      myEntries,
      summary,
      entries,
      staffBalances,
      eligibleStaff,
      rules: {
        loginRewardOfficerPts: settings.loginRewardOfficerPts ?? 50,
        loginRewardGeneratorPts: settings.loginRewardGeneratorPts ?? 30,
        disbursementRewardOfficerPts: settings.disbursementRewardOfficerPts ?? 150,
        disbursementRewardGeneratorPts: settings.disbursementRewardGeneratorPts ?? 100,
        wrongLeadPenaltyMin: settings.wrongLeadPenaltyMin ?? 10,
        wrongLeadPenaltyMax: settings.wrongLeadPenaltyMax ?? 100,
        wrongLeadPenaltyDefault: settings.wrongLeadPenaltyDefault ?? 50,
      },
    });
  });

  router.post(
    '/rewards/wrong-lead-penalty',
    requireAuth,
    requireRoles('SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER'),
    (req: AuthedRequest, res) => {
      const user = req.user!;
      const { employeeId, leadId, amount, reason, staffBucket } = req.body as {
        employeeId?: number;
        leadId?: number | null;
        amount?: number;
        reason?: string;
        staffBucket?: 'FIELD_OFFICER' | 'LEAD_GENERATOR';
      };

      const settings = getSettings();
      const minPen = Number(settings.wrongLeadPenaltyMin ?? 10);
      const maxPen = Number(settings.wrongLeadPenaltyMax ?? 100);
      const amt = Math.round(Number(amount ?? 0));

      if (!employeeId) {
        res.status(400).json({ error: 'Select a Field Officer or Lead Generator staff member' });
        return;
      }
      if (!Number.isFinite(amt) || amt < minPen || amt > maxPen) {
        res.status(400).json({ error: `Wrong lead minus reward penalty must be between ₹${minPen} and ₹${maxPen} per lead` });
        return;
      }
      if (!reason || !String(reason).trim()) {
        res.status(400).json({ error: 'Reason for wrong lead penalty is required' });
        return;
      }

      const target = db.prepare(`SELECT id, full_name, employee_code, role FROM users WHERE id = ? AND is_active = 1`).get(Number(employeeId)) as any;
      if (!target) {
        res.status(404).json({ error: 'Staff employee not found' });
        return;
      }
      if (target.role === 'REFERRAL_PARTNER') {
        res.status(400).json({ error: 'Wrong lead minus reward applies to Field Officers and internal Lead Generator staff only' });
        return;
      }

      let leadRow: any = null;
      if (leadId) {
        leadRow = db.prepare(`SELECT id, lead_code FROM leads WHERE id = ?`).get(Number(leadId));
      }

      const rewardCode = `RWD-WL-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`;
      const bucket = staffBucket === 'LEAD_GENERATOR' || target.role !== 'FIELD_OFFICER' ? 'LEAD_GENERATOR' : 'FIELD_OFFICER';
      const cleanReason = String(reason).trim();

      db.prepare(`
        INSERT INTO staff_rewards
          (reward_code, employee_id, staff_bucket, lead_id, entry_type, points_delta, amount_inr, status, reason, awarded_by)
        VALUES (?, ?, ?, ?, 'WRONG_LEAD_PENALTY', ?, ?, 'ACTIVE', ?, ?)
      `).run(rewardCode, target.id, bucket, leadRow ? leadRow.id : null, -amt, -amt, cleanReason, user.id);

      createAlert({
        userId: target.id,
        leadId: leadRow ? leadRow.id : null,
        category: '₹10 Penalty Alert',
        titleEn: `Wrong Lead Minus Reward (-₹${amt})${leadRow ? `: ${leadRow.lead_code}` : ''}`,
        titleHi: `गलत लीड रिवॉर्ड कटौती (-₹${amt})${leadRow ? `: ${leadRow.lead_code}` : ''}`,
        messageEn: `-₹${amt} deducted from your reward points: ${cleanReason}`,
        messageHi: `आपके रिवॉर्ड पॉइंट्स से -₹${amt} की कटौती की गई: ${cleanReason}`,
      });

      logAudit(
        user,
        'WRONG_LEAD_REWARD_PENALTY',
        'STAFF_REWARD',
        rewardCode,
        `Deducted -₹${amt} from ${target.employee_code} (${target.full_name})${leadRow ? ` on ${leadRow.lead_code}` : ''}: ${cleanReason}`
      );
      res.status(201).json({ ok: true, rewardCode });
    }
  );

  router.patch(
    '/rewards/:id/waive',
    requireAuth,
    requireRoles('SUPER_ADMIN'),
    (req: AuthedRequest, res) => {
      const id = Number(req.params.id);
      const entry = db.prepare(`SELECT * FROM staff_rewards WHERE id = ?`).get(id) as any;
      if (!entry) {
        res.status(404).json({ error: 'Reward ledger entry not found' });
        return;
      }
      if (entry.entry_type !== 'WRONG_LEAD_PENALTY') {
        res.status(400).json({ error: 'Only wrong-lead penalty entries can be waived' });
        return;
      }
      db.prepare(`
        UPDATE staff_rewards SET status = 'WAIVED', waived_by = ?, waived_at = ? WHERE id = ?
      `).run(req.user!.id, nowSql(), id);

      logAudit(req.user!, 'WRONG_LEAD_PENALTY_WAIVED', 'STAFF_REWARD', entry.reward_code, `Waived wrong-lead deduction ${entry.reward_code}`);
      res.json({ ok: true });
    }
  );

  return router;
}
