/**
 * Phase 0 Security Rules Verification Specification for AMBIKA ASSOCIATE CRM
 * Verifies all "Dirty Dozen" adversarial payloads return PERMISSION_DENIED
 * against firestore.rules when executed with @firebase/rules-unit-testing.
 */

export interface DirtyDozenTestCase {
  id: number;
  name: string;
  path: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: { uid: string; email?: string; email_verified?: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenTestCase[] = [
  {
    id: 1,
    name: 'Unauthenticated read on crm_employees',
    path: '/crm_employees/ADM001',
    operation: 'get',
    auth: null,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Non-admin signed-in user reading employee PII',
    path: '/crm_employees/FO001',
    operation: 'get',
    auth: { uid: 'attacker-uid-1', email: 'attacker@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Email spoofing attack with email_verified = false',
    path: '/crm_employees/FO001',
    operation: 'get',
    auth: { uid: 'spoof-uid-1', email: 'rajadineshgupta0@gmail.com', email_verified: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Non-admin self-assigning SUPER_ADMIN in /admins',
    path: '/admins/attacker-uid-1',
    operation: 'create',
    auth: { uid: 'attacker-uid-1', email: 'attacker@example.com', email_verified: true },
    payload: {
      uid: 'attacker-uid-1',
      email: 'attacker@example.com',
      displayName: 'Attacker',
      role: 'SUPER_ADMIN',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow / ghost field injection on crm_employees create',
    path: '/crm_employees/FO099',
    operation: 'create',
    auth: { uid: 'admin-uid-1', email: 'rajadineshgupta0@gmail.com', email_verified: true },
    payload: {
      ownerUid: 'admin-uid-1',
      employeeCode: 'FO099',
      fullName: 'Test User',
      ghostField: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'ID poisoning with invalid characters in document ID',
    path: '/crm_employees/INVALID$ID!@#',
    operation: 'create',
    auth: { uid: 'admin-uid-1', email: 'rajadineshgupta0@gmail.com', email_verified: true },
    payload: { ownerUid: 'admin-uid-1', employeeCode: 'INVALID$ID!@#' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Owner UID spoofing on create',
    path: '/crm_employees/FO100',
    operation: 'create',
    auth: { uid: 'admin-uid-1', email: 'rajadineshgupta0@gmail.com', email_verified: true },
    payload: { ownerUid: 'different-uid', employeeCode: 'FO100', fullName: 'Spoofed' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Immutable employeeCode / createdAt tampering on update',
    path: '/crm_employees/FO001',
    operation: 'update',
    auth: { uid: 'admin-uid-1', email: 'rajadineshgupta0@gmail.com', email_verified: true },
    payload: { employeeCode: 'HACKED001' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Client-forged createdAt timestamp instead of request.time',
    path: '/crm_employees/FO101',
    operation: 'create',
    auth: { uid: 'admin-uid-1', email: 'rajadineshgupta0@gmail.com', email_verified: true },
    payload: { ownerUid: 'admin-uid-1', employeeCode: 'FO101', createdAt: '1999-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Denial of wallet oversized fullName string (>120 chars)',
    path: '/crm_employees/FO001',
    operation: 'update',
    auth: { uid: 'admin-uid-1', email: 'rajadineshgupta0@gmail.com', email_verified: true },
    payload: { fullName: 'A'.repeat(500) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Invalid role enum value on create',
    path: '/crm_employees/FO102',
    operation: 'create',
    auth: { uid: 'admin-uid-1', email: 'rajadineshgupta0@gmail.com', email_verified: true },
    payload: { ownerUid: 'admin-uid-1', employeeCode: 'FO102', role: 'ROOT_HACKER' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Unauthorized list scraping on /crm_employees',
    path: '/crm_employees',
    operation: 'list',
    auth: { uid: 'attacker-uid-1', email: 'attacker@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
];
