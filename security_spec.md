# AMBIKA ASSOCIATE CRM — Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Default-Deny Safety Net**: Every unspecified path in `/databases/{database}/documents` is strictly denied (`allow read, write: if false`).
2. **Strict Admin-Only PII Isolation**: `/crm_employees/{employeeCode}`, `/crm_branches/{branchCode}`, `/crm_settings/{settingKey}`, and `/admins/{adminUid}` contain sensitive staff PII (`mobile`, `email`, `passwordHash`, `adminSavedPasswordEnc`). Only verified Super Admins (`request.auth != null && request.auth.token.email_verified == true` and matching bootstrapped admin email or `/admins/{uid}` document) may read, list, create, update, or delete records.
3. **Path Variable Hardening**: Every single-document operation (`get`, `create`, `update`, `delete`) validates `isValidId(docId)` (`^[a-zA-Z0-9_\-]+$`, max 128 chars) and ensures `incoming().employeeCode == employeeCode` / `incoming().code == branchCode` / `incoming().settingKey == settingKey`.
4. **Anti-Update-Gap & Schema Strictness**: Every `create` and `update` calls a standalone `isValid*()` helper enforcing `hasAll` + `hasOnly`, strict types, `.size()` bounds on every string, enum checks on `role` / `preferredLang` / `defaultLanguage`, `ownerUid == request.auth.uid`, and strict `request.time` timestamp integrity.
5. **Immutable Fields**: `createdAt`, `ownerUid`, and primary key codes (`employeeCode`, `code`, `settingKey`) are immutable after creation (`incoming().field == existing().field`).
6. **Secure List Queries**: `allow list` never uses blanket `isSignedIn()`; it requires `isAdmin()` AND evaluates `resource.data.ownerUid is string` without `get()`/`exists()` inside `allow list` where avoidable (for admin-only vault, bootstrapped email verification checks `request.auth.token.email_verified == true` with zero O(n) reads!).

## 2. The "Dirty Dozen" Adversarial Payloads (All Must Return PERMISSION_DENIED)
1. **Unauthenticated Read** on `/crm_employees/ADM001` (`auth: null`).
2. **Non-Admin Signed-In User Read** on `/crm_employees/ADM001` (`email: "random@gmail.com"`, `email_verified: true`).
3. **Unverified Email Spoofing Attack** (`email: "rajadineshgupta0@gmail.com"`, `email_verified: false`) attempting read/write on `/crm_employees/FO001`.
4. **Self-Assigned Admin Privilege Escalation**: Non-admin user creating `/admins/{uid}` with `role: "SUPER_ADMIN"`.
5. **Shadow / Ghost Field Injection** on `/crm_employees/FO099` create/update adding extra key `isSuperAdmin: true`.
6. **ID Poisoning Attack**: Creating `/crm_employees/../../bad$id` or 200-char doc ID.
7. **Owner UID Spoofing**: Creating `/crm_employees/FO099` with `ownerUid: "someone-else-uid" != request.auth.uid`.
8. **Immutable Field Tampering**: Updating `createdAt` or `employeeCode` or `ownerUid` on an existing `/crm_employees/FO099`.
9. **Client Timestamp Forgery**: Creating `/crm_employees/FO099` with client-supplied `createdAt` instead of `request.time`.
10. **Value Poisoning / Oversized String (Denial of Wallet)**: Updating `fullName` to a 5,000-character string or boolean.
11. **Invalid Role Enum**: Creating `/crm_employees/FO099` with `role: "ROOT_HACKER"`.
12. **Blanket List Scraping**: Non-admin authenticated user executing `list` on `/crm_employees`.
