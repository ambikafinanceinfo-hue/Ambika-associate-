import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  serverTimestamp,
  getDocFromServer,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Mandatory: Always pass firebaseConfig.firestoreDatabaseId for provisioned named databases
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export const AUTHORIZED_CLOUD_ADMIN_EMAILS = [
  'rajadineshgupta0@gmail.com',
  'ambikafinance.info@gmail.com',
] as const;

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
    // Other errors (like permission-denied on default-deny test path) are expected when online.
  }
}
void testConnection();

export type CloudEmployeeRole =
  | 'SUPER_ADMIN'
  | 'BRANCH_MANAGER'
  | 'TEAM_LEADER'
  | 'LEAD_GENERATOR'
  | 'FIELD_OFFICER'
  | 'REFERRAL_PARTNER';

export interface CloudEmployeePayload {
  employeeCode: string;
  fullName: string;
  mobile: string;
  email: string;
  passwordHash: string;
  adminSavedPasswordEnc: string;
  role: CloudEmployeeRole;
  branchCode: string;
  teamName: string;
  reportsToEmployeeCode: string;
  referralCode: string;
  serviceCity: string;
  servicePincodes: string;
  isActive: boolean;
  otpEnabled: boolean;
  preferredLang: 'en' | 'hi';
}

export interface CloudBranchPayload {
  code: string;
  name: string;
  city: string;
  state: string;
  isActive: boolean;
}

export interface CloudSettingPayload {
  settingKey: string;
  officeName: string;
  officeAddress: string;
  petrolRatePerKm: number;
  attendanceCutoffTime: string;
  attendanceLatePenaltyInr: number;
  unapprovedLeavePenaltyInr: number;
  defaultLanguage: 'en' | 'hi';
}

export interface CloudSnapshot {
  employees: CloudEmployeePayload[];
  branches: CloudBranchPayload[];
  settings: CloudSettingPayload[];
}

const VALID_ROLES: CloudEmployeeRole[] = [
  'SUPER_ADMIN',
  'BRANCH_MANAGER',
  'TEAM_LEADER',
  'LEAD_GENERATOR',
  'FIELD_OFFICER',
  'REFERRAL_PARTNER',
];

function clampStr(value: unknown, maxLen: number): string {
  return String(value ?? '').trim().slice(0, maxLen);
}

function sanitizeDocId(raw: unknown, maxLen: number): string {
  return String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, maxLen);
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function isAuthorizedAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.trim().toLowerCase();
  return (AUTHORIZED_CLOUD_ADMIN_EMAILS as readonly string[]).includes(lower);
}

export function subscribeCloudAuth(cb: (user: FirebaseUser | null) => void): () => void {
  return onAuthStateChanged(auth, cb);
}

export async function ensureAdminProfile(fbUser: FirebaseUser): Promise<void> {
  const email = clampStr(fbUser.email, 160);
  if (!fbUser.emailVerified || !isAuthorizedAdminEmail(email)) {
    throw new Error(
      `Unauthorized Google account (${email || 'unknown'}). Please sign in with rajadineshgupta0@gmail.com or ambikafinance.info@gmail.com.`
    );
  }

  const uid = sanitizeDocId(fbUser.uid, 128);
  const path = `admins/${uid}`;
  const adminRef = doc(db, 'admins', uid);
  const displayName = clampStr(fbUser.displayName || email.split('@')[0] || 'Super Admin', 120) || 'Super Admin';

  try {
    const existingSnap = await getDoc(adminRef);
    if (existingSnap.exists()) {
      await updateDoc(adminRef, {
        email,
        displayName,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(adminRef, {
        uid,
        email,
        displayName,
        role: 'SUPER_ADMIN',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function signInCloudAdmin(): Promise<FirebaseUser> {
  const result = await signInWithPopup(auth, googleProvider);
  const fbUser = result.user;
  try {
    await ensureAdminProfile(fbUser);
    return fbUser;
  } catch (err) {
    await signOut(auth).catch(() => {});
    throw err;
  }
}

export async function signOutCloudAdmin(): Promise<void> {
  await signOut(auth);
}

function normalizeEmployeeForCloud(emp: CloudEmployeePayload) {
  const employeeCode = sanitizeDocId(emp.employeeCode, 32).toUpperCase();
  if (employeeCode.length < 2) return null;
  const passwordHash = clampStr(emp.passwordHash, 200);
  if (passwordHash.length < 10) return null;

  const role: CloudEmployeeRole = VALID_ROLES.includes(emp.role) ? emp.role : 'FIELD_OFFICER';
  return {
    employeeCode,
    fullName: clampStr(emp.fullName || employeeCode, 120) || employeeCode,
    mobile: clampStr(emp.mobile, 24),
    email: clampStr(emp.email, 160),
    passwordHash,
    adminSavedPasswordEnc: clampStr(emp.adminSavedPasswordEnc, 512),
    role,
    branchCode: clampStr(emp.branchCode, 40),
    teamName: clampStr(emp.teamName, 120),
    reportsToEmployeeCode: sanitizeDocId(emp.reportsToEmployeeCode, 32).toUpperCase(),
    referralCode: clampStr(emp.referralCode, 40),
    serviceCity: clampStr(emp.serviceCity, 80),
    servicePincodes: clampStr(emp.servicePincodes, 400),
    isActive: Boolean(emp.isActive),
    otpEnabled: Boolean(emp.otpEnabled),
    preferredLang: (emp.preferredLang === 'hi' ? 'hi' : 'en') as 'en' | 'hi',
  };
}

export async function upsertEmployeeToCloud(emp: CloudEmployeePayload): Promise<boolean> {
  const fbUser = auth.currentUser;
  if (!fbUser) return false;

  const normalized = normalizeEmployeeForCloud(emp);
  if (!normalized) return false;

  const path = `crm_employees/${normalized.employeeCode}`;
  const ref = doc(db, 'crm_employees', normalized.employeeCode);

  try {
    const existing = await getDoc(ref);
    if (existing.exists()) {
      await updateDoc(ref, {
        fullName: normalized.fullName,
        mobile: normalized.mobile,
        email: normalized.email,
        passwordHash: normalized.passwordHash,
        adminSavedPasswordEnc: normalized.adminSavedPasswordEnc,
        role: normalized.role,
        branchCode: normalized.branchCode,
        teamName: normalized.teamName,
        reportsToEmployeeCode: normalized.reportsToEmployeeCode,
        referralCode: normalized.referralCode,
        serviceCity: normalized.serviceCity,
        servicePincodes: normalized.servicePincodes,
        isActive: normalized.isActive,
        otpEnabled: normalized.otpEnabled,
        preferredLang: normalized.preferredLang,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ownerUid: sanitizeDocId(fbUser.uid, 128),
        ...normalized,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteEmployeeFromCloud(employeeCode: string): Promise<void> {
  if (!auth.currentUser) return;
  const cleanCode = sanitizeDocId(employeeCode, 32).toUpperCase();
  if (cleanCode.length < 2) return;
  const path = `crm_employees/${cleanCode}`;
  try {
    await deleteDoc(doc(db, 'crm_employees', cleanCode));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function upsertBranchToCloud(branch: CloudBranchPayload): Promise<boolean> {
  const fbUser = auth.currentUser;
  if (!fbUser) return false;

  const code = sanitizeDocId(branch.code, 40).toUpperCase();
  if (code.length < 2) return false;
  const name = clampStr(branch.name || code, 120) || code;
  const city = clampStr(branch.city, 80);
  const state = clampStr(branch.state, 80);
  const isActive = Boolean(branch.isActive);

  const path = `crm_branches/${code}`;
  const ref = doc(db, 'crm_branches', code);

  try {
    const existing = await getDoc(ref);
    if (existing.exists()) {
      await updateDoc(ref, {
        name,
        city,
        state,
        isActive,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ownerUid: sanitizeDocId(fbUser.uid, 128),
        code,
        name,
        city,
        state,
        isActive,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function upsertSettingToCloud(setting: CloudSettingPayload): Promise<boolean> {
  const fbUser = auth.currentUser;
  if (!fbUser) return false;

  const settingKey = sanitizeDocId(setting.settingKey || 'global', 64) || 'global';
  if (settingKey.length < 2) return false;

  const officeName = clampStr(setting.officeName, 140);
  const officeAddress = clampStr(setting.officeAddress, 300);
  const petrolRatePerKm = clampNum(setting.petrolRatePerKm, 0, 100, 3);
  const attendanceCutoffTime = clampStr(setting.attendanceCutoffTime || '10:30', 16);
  const attendanceLatePenaltyInr = clampNum(setting.attendanceLatePenaltyInr, 0, 10000, 20);
  const unapprovedLeavePenaltyInr = clampNum(setting.unapprovedLeavePenaltyInr, 0, 10000, 100);
  const defaultLanguage: 'en' | 'hi' = setting.defaultLanguage === 'hi' ? 'hi' : 'en';

  const path = `crm_settings/${settingKey}`;
  const ref = doc(db, 'crm_settings', settingKey);

  try {
    const existing = await getDoc(ref);
    if (existing.exists()) {
      await updateDoc(ref, {
        officeName,
        officeAddress,
        petrolRatePerKm,
        attendanceCutoffTime,
        attendanceLatePenaltyInr,
        unapprovedLeavePenaltyInr,
        defaultLanguage,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ownerUid: sanitizeDocId(fbUser.uid, 128),
        settingKey,
        officeName,
        officeAddress,
        petrolRatePerKm,
        attendanceCutoffTime,
        attendanceLatePenaltyInr,
        unapprovedLeavePenaltyInr,
        defaultLanguage,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function fetchCloudSnapshot(): Promise<CloudSnapshot> {
  if (!auth.currentUser) {
    return { employees: [], branches: [], settings: [] };
  }

  let employees: CloudEmployeePayload[] = [];
  let branches: CloudBranchPayload[] = [];
  let settings: CloudSettingPayload[] = [];

  try {
    const empSnap = await getDocs(collection(db, 'crm_employees'));
    employees = empSnap.docs.map((d) => {
      const data = d.data();
      return {
        employeeCode: String(data.employeeCode || d.id),
        fullName: String(data.fullName || d.id),
        mobile: String(data.mobile || ''),
        email: String(data.email || ''),
        passwordHash: String(data.passwordHash || ''),
        adminSavedPasswordEnc: String(data.adminSavedPasswordEnc || ''),
        role: (VALID_ROLES.includes(data.role) ? data.role : 'FIELD_OFFICER') as CloudEmployeeRole,
        branchCode: String(data.branchCode || ''),
        teamName: String(data.teamName || ''),
        reportsToEmployeeCode: String(data.reportsToEmployeeCode || ''),
        referralCode: String(data.referralCode || ''),
        serviceCity: String(data.serviceCity || ''),
        servicePincodes: String(data.servicePincodes || ''),
        isActive: Boolean(data.isActive),
        otpEnabled: Boolean(data.otpEnabled),
        preferredLang: data.preferredLang === 'hi' ? 'hi' : 'en',
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'crm_employees');
  }

  try {
    const brSnap = await getDocs(collection(db, 'crm_branches'));
    branches = brSnap.docs.map((d) => {
      const data = d.data();
      return {
        code: String(data.code || d.id),
        name: String(data.name || d.id),
        city: String(data.city || ''),
        state: String(data.state || ''),
        isActive: Boolean(data.isActive),
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'crm_branches');
  }

  try {
    const setSnap = await getDocs(collection(db, 'crm_settings'));
    settings = setSnap.docs.map((d) => {
      const data = d.data();
      return {
        settingKey: String(data.settingKey || d.id),
        officeName: String(data.officeName || ''),
        officeAddress: String(data.officeAddress || ''),
        petrolRatePerKm: Number(data.petrolRatePerKm ?? 3),
        attendanceCutoffTime: String(data.attendanceCutoffTime || '10:30'),
        attendanceLatePenaltyInr: Number(data.attendanceLatePenaltyInr ?? 20),
        unapprovedLeavePenaltyInr: Number(data.unapprovedLeavePenaltyInr ?? 100),
        defaultLanguage: data.defaultLanguage === 'hi' ? 'hi' : 'en',
      };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'crm_settings');
  }

  return { employees, branches, settings };
}

export async function pushFullSnapshotToCloud(snapshot: CloudSnapshot): Promise<{
  syncedEmployees: number;
  syncedBranches: number;
  syncedSettings: number;
}> {
  if (!auth.currentUser) {
    return { syncedEmployees: 0, syncedBranches: 0, syncedSettings: 0 };
  }

  let syncedBranches = 0;
  for (const b of snapshot.branches) {
    if (await upsertBranchToCloud(b)) syncedBranches += 1;
  }

  let syncedSettings = 0;
  for (const s of snapshot.settings) {
    if (await upsertSettingToCloud(s)) syncedSettings += 1;
  }

  let syncedEmployees = 0;
  const chunkSize = 8;
  for (let i = 0; i < snapshot.employees.length; i += chunkSize) {
    const chunk = snapshot.employees.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map((emp) => upsertEmployeeToCloud(emp)));
    syncedEmployees += results.filter(Boolean).length;
  }

  return { syncedEmployees, syncedBranches, syncedSettings };
}
