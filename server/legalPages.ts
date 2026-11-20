export const LEGAL_META = {
  companyName: 'AMBIKA ASSOCIATE',
  tagline: 'SMART FINANCE SMART SAVING',
  appName: 'AMBIKA ASSOCIATE CRM',
  packageId: 'in.ambikaassociate.crm',
  supportEmail: 'support@ambikaassociate.in',
  grievanceEmail: 'rajadineshgupta0@gmail.com',
  effectiveDate: '2026-11-17',
};

function renderLegalShell(title: string, badge: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} · ${LEGAL_META.companyName}</title>
  <link rel="icon" href="/pwa-192x192.png" />
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; line-height: 1.65; }
    header { background: #0F2744; color: #ffffff; padding: 20px 24px; border-bottom: 3px solid #EA580C; }
    .hdr-inner { max-width: 880px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand img { width: 42px; height: 42px; border-radius: 10px; background: #fff; object-fit: cover; border: 1px solid rgba(250,204,21,.6); }
    .brand-title { font-weight: 800; font-size: 17px; letter-spacing: .2px; }
    .brand-sub { font-size: 11px; color: #fde047; font-weight: 600; }
    nav a { color: #e2e8f0; text-decoration: none; font-size: 12px; font-weight: 600; margin-left: 14px; }
    nav a:hover { color: #ffffff; text-decoration: underline; }
    main { max-width: 880px; margin: 28px auto; padding: 0 16px 48px; }
    .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 28px; box-shadow: 0 1px 3px rgba(15,23,42,.04); }
    .badge { display: inline-block; background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; border-radius: 6px; padding: 3px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; }
    h1 { color: #0F2744; font-size: 24px; margin: 10px 0 6px; }
    .meta { font-size: 12px; color: #64748b; margin-bottom: 22px; padding-bottom: 14px; border-bottom: 1px solid #e2e8f0; }
    h2 { color: #0F2744; font-size: 16px; margin-top: 22px; margin-bottom: 8px; }
    ul { padding-left: 20px; margin: 8px 0; }
    li { margin-bottom: 6px; font-size: 14px; color: #334155; }
    p { font-size: 14px; color: #334155; margin: 8px 0; }
    .callout { background: #f1f5f9; border-left: 4px solid #0F2744; padding: 12px 16px; border-radius: 6px; font-size: 13px; margin: 16px 0; }
    footer { text-align: center; font-size: 12px; color: #64748b; margin-top: 24px; }
  </style>
</head>
<body>
  <header>
    <div class="hdr-inner">
      <div class="brand">
        <img src="/pwa-192x192.png" alt="AMBIKA ASSOCIATE" />
        <div>
          <div class="brand-title">${LEGAL_META.companyName}</div>
          <div class="brand-sub">${LEGAL_META.tagline}</div>
        </div>
      </div>
      <nav>
        <a href="/privacy-policy">Privacy Policy</a>
        <a href="/terms-and-conditions">Terms &amp; Conditions</a>
        <a href="/account-deletion">Account Deletion</a>
        <a href="/">Open App</a>
      </nav>
    </div>
  </header>
  <main>
    <div class="card">
      <span class="badge">${badge}</span>
      <h1>${title}</h1>
      <div class="meta">
        Application: <strong>${LEGAL_META.appName}</strong> (${LEGAL_META.packageId}) · Effective Date: ${LEGAL_META.effectiveDate}
      </div>
      ${bodyHtml}
    </div>
    <footer>
      &copy; ${new Date().getFullYear()} ${LEGAL_META.companyName} · ${LEGAL_META.tagline} · Contact: ${LEGAL_META.supportEmail}
    </footer>
  </main>
</body>
</html>`;
}

export function renderPrivacyPolicyHtml(): string {
  return renderLegalShell(
    'Privacy Policy & Data Safety Disclosure',
    'Google Play Compliance · Privacy Policy',
    `
    <p><strong>${LEGAL_META.companyName}</strong> ("we", "our", "us") operates the <strong>${LEGAL_META.appName}</strong> mobile and web application (package ID: <code>${LEGAL_META.packageId}</code>) for authorized financial service operations, loan lead management, KYC verification, field visit tracking, and partner coordination.</p>

    <h2>1. Information We Collect &amp; Process</h2>
    <ul>
      <li><strong>Account &amp; Role Identity:</strong> Employee/Partner ID, full name, phone number, email address, branch/team hierarchy assignment, and encrypted authentication credentials.</li>
      <li><strong>Loan Lead &amp; KYC Data (Customer Consent Required):</strong> Customer name, mobile number, PAN card number (for OCR pre-fill &amp; duplicate prevention), city/pincode, loan product, loan amount, bank/NBFC selection, and KYC documents uploaded strictly with confirmed customer consent.</li>
      <li><strong>Camera &amp; Document Images:</strong> Used only when a user opens the Quick Camera / Document Scanner for PAN OCR pre-fill or geotagged customer visit verification photos.</li>
      <li><strong>Location / GPS Coordinates:</strong> Collected only with explicit user consent during active Field Officer check-in, visit verification, or active Bike Run petrol incentive logging (persistent foreground notification displayed when active).</li>
      <li><strong>Follow-up Voice Recording (Audio):</strong> When initiated by an authorized employee with explicit consent confirmation, customer follow-up call audio is stored for compliance review by Super Admin only and is <strong>automatically and permanently deleted after 7 days (1 week)</strong>.</li>
      <li><strong>Device Offline Queue:</strong> Leads captured without internet connectivity are temporarily stored locally in device IndexedDB and automatically synced once network returns.</li>
    </ul>

    <h2>2. How We Use Information &amp; Strict Access Control</h2>
    <ul>
      <li>Routing leads securely through the hierarchy: <strong>Referral / Back Office → Branch Manager → Team Leader → Field Officer</strong>.</li>
      <li>Preventing duplicate lead submissions while protecting confidential customer PII (Referral Partners see redacted progress statuses only; customer mobile numbers, PAN, and KYC docs remain restricted).</li>
      <li>Calculating automated load-balancing assignments, SLA adherence, staff rewards, and petrol incentives.</li>
      <li>We <strong>never sell, rent, or trade</strong> personal or customer financial data to third-party advertisers.</li>
    </ul>

    <h2>3. Data Security &amp; Retention</h2>
    <ul>
      <li>All network communication uses HTTPS/TLS encryption in transit.</li>
      <li>Sensitive customer PII (mobile numbers, PAN, addresses) is encrypted at rest on the server; passwords are salted and hashed with bcrypt.</li>
      <li>Follow-up audio recordings auto-expire and delete after <strong>7 days</strong>.</li>
      <li>Administrators can immediately deactivate any user ID or revoke login sessions at any time.</li>
    </ul>

    <h2>4. User Rights &amp; Contact</h2>
    <p>Authorized users or customers may request access, correction, or account/data deletion at any time. See our <a href="/account-deletion">Account &amp; Data Deletion Policy</a> or email <strong>${LEGAL_META.grievanceEmail}</strong> / <strong>${LEGAL_META.supportEmail}</strong>.</p>
    `
  );
}

export function renderTermsHtml(): string {
  return renderLegalShell(
    'Terms & Conditions of Use',
    'Authorized CRM Agreement',
    `
    <p>By accessing or installing <strong>${LEGAL_META.appName}</strong> (<code>${LEGAL_META.packageId}</code>), provided by <strong>${LEGAL_META.companyName}</strong> (${LEGAL_META.tagline}), you ("Authorized User", "Employee", or "Referral Partner") agree to these Terms &amp; Conditions.</p>

    <h2>1. Authorized Access &amp; Account Responsibility</h2>
    <ul>
      <li>Access is restricted to valid credentials issued by Super Admin, Back Office Team, or authorized Field Officers within company hierarchy limits (1 Branch Manager → max 10 Team Leaders → max 10 Field Officers → max 50 Referral Partners).</li>
      <li>You must keep your Employee/Referral ID and password confidential. Super Admin reserves the right to disable or revoke any login ID immediately for policy violations or inactivity.</li>
    </ul>

    <h2>2. Customer Consent &amp; KYC Compliance</h2>
    <ul>
      <li>Before submitting any customer lead, scanning a PAN card, uploading KYC documents, or recording a follow-up call, the user warrants that explicit customer consent has been obtained.</li>
      <li>Submission of fabricated, duplicate, or unauthorized customer records is prohibited and subject to SLA penalty deductions and account termination.</li>
    </ul>

    <h2>3. Device Permissions &amp; Prominent Disclosure</h2>
    <ul>
      <li><strong>Camera:</strong> Used solely for PAN card OCR scanning and geotagged field visit photos.</li>
      <li><strong>Location (GPS):</strong> Used solely during active field visits and Bike Run mileage logging with user consent.</li>
      <li><strong>Microphone (Audio):</strong> Used solely when voluntarily recording follow-up conversations (strictly restricted to Super Admin playback; auto-deleted after 7 days).</li>
      <li><strong>Phone Dialer (` + '`tel:`' + `):</strong> Used when tapping a customer mobile number to place an outbound follow-up call via your device dialer.</li>
    </ul>

    <h2>4. Confidentiality &amp; Non-Disclosure</h2>
    <p>All customer financial details, loan applications, bank/NBFC terms, and commission schedules inside the CRM are strictly confidential property of ${LEGAL_META.companyName}. Unauthorized screenshots, scraping, or external sharing is strictly prohibited.</p>

    <h2>5. Governing Law &amp; Support</h2>
    <p>These terms are governed by the laws of India. For grievance redressal or support, contact <strong>${LEGAL_META.grievanceEmail}</strong> or <strong>${LEGAL_META.supportEmail}</strong>.</p>
    `
  );
}

export function renderAccountDeletionHtml(): string {
  return renderLegalShell(
    'Account & Data Deletion Request Policy',
    'Google Play Data Safety',
    `
    <p><strong>${LEGAL_META.companyName}</strong> provides a transparent process for Employees, Team Leaders, Field Officers, Back Office Staff, and Referral Partners to request account deactivation and personal data deletion for <strong>${LEGAL_META.appName}</strong> (<code>${LEGAL_META.packageId}</code>).</p>

    <div class="callout">
      <strong>Direct Account Deactivation Options:</strong>
      <br />1. <strong>Self / Back Office Removal:</strong> Referral Partners can be deactivated and unlinked immediately by Back Office Team or Super Admin inside the <em>Referral ID Console</em>.
      <br />2. <strong>Super Admin Console:</strong> Any employee or partner login ID can be disabled instantly inside <em>Admin Console → Users &amp; Roles</em>, revoking all active tokens and OTP sessions.
      <br />3. <strong>Email Deletion Request:</strong> Send an email to <strong>${LEGAL_META.grievanceEmail}</strong> or <strong>${LEGAL_META.supportEmail}</strong> with subject <code>Account Deletion Request - [Your Employee/Referral ID]</code>.
    </div>

    <h2>Data Deletion &amp; Retention Scope</h2>
    <ul>
      <li><strong>Deleted / Revoked Immediately (within 48 hours of verified request):</strong> Active session tokens, OTP challenges, login access, device GPS tracking pings, and optional contact preferences.</li>
      <li><strong>Auto-Purged Data:</strong> Follow-up call audio recordings are automatically deleted after <strong>7 days</strong>.</li>
      <li><strong>Statutory Financial Audit Retention:</strong> Disbursed loan audit trails, payout ledgers, and regulatory KYC records required under Indian banking/NBFC compliance norms are retained securely in encrypted form for statutory audit periods and cannot be altered retroactively.</li>
    </ul>
    `
  );
}
