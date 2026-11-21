import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import type { AlertCategory, LoanProductConfig, SystemSettings, UserRole } from '../shared/types.ts';
import { encryptPii, hashLookup } from './crypto.ts';

const DB_PATH = process.env.CRM_DB_PATH || path.join(process.cwd(), 'data', 'ambika_crm.db');
const DATA_DIR = path.dirname(DB_PATH);
const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const UPLOADS_PATH = UPLOAD_DIR;

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      name TEXT NOT NULL,
      leader_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_code TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      mobile TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','BRANCH_MANAGER','TEAM_LEADER','LEAD_GENERATOR','FIELD_OFFICER','REFERRAL_PARTNER')),
      branch_id INTEGER REFERENCES branches(id),
      team_id INTEGER REFERENCES teams(id),
      referral_code TEXT UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      otp_enabled INTEGER NOT NULL DEFAULT 0,
      gps_consent INTEGER NOT NULL DEFAULT 0,
      camera_consent INTEGER NOT NULL DEFAULT 0,
      preferred_lang TEXT NOT NULL DEFAULT 'en',
      service_city TEXT,
      service_pincodes TEXT,
      reports_to_user_id INTEGER REFERENCES users(id),
      profile_photo_data_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS otp_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mobile TEXT NOT NULL,
      otp_code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_code TEXT NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      customer_name_norm TEXT NOT NULL,
      customer_mobile_enc TEXT NOT NULL,
      customer_mobile_hash TEXT NOT NULL,
      alternate_mobile_enc TEXT,
      pan_enc TEXT,
      pan_hash TEXT,
      dob TEXT,
      address_enc TEXT,
      city TEXT,
      state TEXT,
      pin_code TEXT,
      loan_product TEXT NOT NULL,
      loan_amount REAL NOT NULL DEFAULT 0,
      employment_details TEXT,
      monthly_income REAL,
      bank_nbfc TEXT NOT NULL,
      referral_id TEXT,
      referral_name TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      assigned_bm_id INTEGER REFERENCES users(id),
      assigned_tl_id INTEGER REFERENCES users(id),
      assigned_officer_id INTEGER REFERENCES users(id),
      assigned_at TEXT,
      assignment_deadline_at TEXT,
      assignment_sla_checked INTEGER NOT NULL DEFAULT 0,
      branch_id INTEGER REFERENCES branches(id),
      status TEXT NOT NULL DEFAULT 'Lead Generated',
      last_status_at TEXT,
      remarks TEXT,
      customer_consent INTEGER NOT NULL DEFAULT 1,
      is_test_record INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_leads_mobile_hash ON leads(customer_mobile_hash);
    CREATE INDEX IF NOT EXISTS idx_leads_pan_hash ON leads(pan_hash);
    CREATE INDEX IF NOT EXISTS idx_leads_name_norm ON leads(customer_name_norm);
    CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_officer_id);
    CREATE INDEX IF NOT EXISTS idx_leads_created_by ON leads(created_by);

    CREATE TABLE IF NOT EXISTS duplicate_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_code TEXT NOT NULL UNIQUE,
      existing_lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      matched_fields_json TEXT NOT NULL,
      submitted_payload_json TEXT NOT NULL,
      submitted_by INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
      reviewed_by INTEGER REFERENCES users(id),
      review_remarks TEXT,
      reviewed_at TEXT,
      created_lead_id INTEGER REFERENCES leads(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS case_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      prev_status TEXT,
      new_status TEXT NOT NULL,
      updated_by INTEGER NOT NULL REFERENCES users(id),
      remarks TEXT,
      supporting_doc_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      uploaded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS followup_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      assigned_officer_id INTEGER NOT NULL REFERENCES users(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      note TEXT NOT NULL,
      due_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      completed_at TEXT,
      penalty_generated INTEGER NOT NULL DEFAULT 0,
      alert_dispatched INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS followup_recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_code TEXT NOT NULL UNIQUE,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      recorded_by INTEGER NOT NULL REFERENCES users(id),
      recorded_by_role TEXT NOT NULL,
      call_notes TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      share_token TEXT UNIQUE,
      share_created_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL DEFAULT (datetime('now', '+7 days'))
    );

    CREATE INDEX IF NOT EXISTS idx_followup_rec_lead ON followup_recordings(lead_id);
    CREATE INDEX IF NOT EXISTS idx_followup_rec_expires ON followup_recordings(expires_at);

    CREATE TABLE IF NOT EXISTS penalties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      penalty_code TEXT NOT NULL UNIQUE,
      employee_id INTEGER NOT NULL REFERENCES users(id),
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      enquiry_id INTEGER,
      penalty_type TEXT NOT NULL CHECK (penalty_type IN ('LEAD_ASSIGNMENT_10M','FOLLOWUP_REMINDER_10M','ENQUIRY_SLA_60M','ATTENDANCE_LATE_20','UNAPPROVED_LEAVE_100')),
      event_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      actual_update_at TEXT,
      delay_seconds INTEGER NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 10,
      approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING','APPROVED','REJECTED')),
      reviewed_by INTEGER REFERENCES users(id),
      review_remarks TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS enquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enquiry_code TEXT NOT NULL UNIQUE,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      referral_user_id INTEGER NOT NULL REFERENCES users(id),
      referral_code TEXT,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      assigned_officer_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Assigned','In Progress','Solution Updated','Resolved','Closed')),
      solution_text TEXT,
      solution_updated_at TEXT,
      sla_deadline_at TEXT NOT NULL,
      penalty_generated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS gps_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES users(id),
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      accuracy REAL,
      activity_type TEXT NOT NULL CHECK (activity_type IN ('TRACKING_START','TRACKING_PING','TRACKING_STOP','VISIT_CHECKIN','VISIT_CHECKOUT')),
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      customer_name TEXT,
      visit_notes TEXT,
      consent_confirmed INTEGER NOT NULL DEFAULT 1,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bike_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_code TEXT NOT NULL UNIQUE,
      employee_id INTEGER NOT NULL REFERENCES users(id),
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      tour_reason TEXT NOT NULL DEFAULT '',
      start_location TEXT NOT NULL DEFAULT '',
      end_location TEXT NOT NULL DEFAULT '',
      start_time TEXT NOT NULL,
      end_time TEXT,
      start_lat REAL NOT NULL,
      start_lng REAL NOT NULL,
      end_lat REAL,
      end_lng REAL,
      opening_odometer REAL NOT NULL,
      closing_odometer REAL,
      gps_distance_km REAL NOT NULL DEFAULT 0,
      odometer_distance_km REAL NOT NULL DEFAULT 0,
      discrepancy_km REAL NOT NULL DEFAULT 0,
      discrepancy_flag INTEGER NOT NULL DEFAULT 0,
      rate_per_km REAL NOT NULL DEFAULT 3.0,
      eligible_km REAL NOT NULL DEFAULT 0,
      gross_amount REAL NOT NULL DEFAULT 0,
      deducted_amount REAL NOT NULL DEFAULT 0,
      incentive_amount REAL NOT NULL DEFAULT 0,
      approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING','APPROVED','DEDUCTED','REJECTED')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewer_role TEXT,
      review_remarks TEXT,
      reviewed_at TEXT,
      route_points_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED'))
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_code TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      enquiry_id INTEGER REFERENCES enquiries(id) ON DELETE SET NULL,
      category TEXT NOT NULL,
      title_en TEXT NOT NULL,
      title_hi TEXT NOT NULL,
      message_en TEXT NOT NULL,
      message_hi TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_user_read ON alerts(user_id, is_read);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_name TEXT NOT NULL,
      user_role TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sales_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
      target_leads INTEGER NOT NULL DEFAULT 10,
      target_amount REAL NOT NULL DEFAULT 5000000,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS referral_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
      referral_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      referral_code TEXT,
      loan_product TEXT NOT NULL,
      base_rate_pct REAL NOT NULL DEFAULT 0.5,
      bonus_rate_pct REAL NOT NULL DEFAULT 0,
      payout_amount REAL NOT NULL DEFAULT 0,
      payout_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (payout_status IN ('PENDING','APPROVED','PAID')),
      paid_at TEXT,
      remarks TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS staff_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reward_code TEXT NOT NULL UNIQUE,
      employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      staff_bucket TEXT NOT NULL CHECK (staff_bucket IN ('FIELD_OFFICER','LEAD_GENERATOR')),
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('DOC_LOGIN_REWARD','DISBURSEMENT_REWARD','WRONG_LEAD_PENALTY')),
      points_delta INTEGER NOT NULL,
      amount_inr REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','WAIVED')),
      reason TEXT NOT NULL,
      awarded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      waived_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      waived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_rewards_milestone
      ON staff_rewards(lead_id, employee_id, entry_type, staff_bucket)
      WHERE entry_type IN ('DOC_LOGIN_REWARD', 'DISBURSEMENT_REWARD') AND lead_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS attendance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendance_code TEXT NOT NULL UNIQUE,
      employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attendance_date TEXT NOT NULL,
      marked_at TEXT NOT NULL,
      marked_time_ist TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      accuracy REAL,
      location_label TEXT NOT NULL DEFAULT '',
      distance_meters REAL NOT NULL DEFAULT 0,
      within_office INTEGER NOT NULL DEFAULT 1,
      auto_captured INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('PRESENT','LATE_PRESENT')),
      self_approved INTEGER NOT NULL DEFAULT 1,
      is_late INTEGER NOT NULL DEFAULT 0,
      delay_minutes INTEGER NOT NULL DEFAULT 0,
      delay_penalty_amount REAL NOT NULL DEFAULT 0,
      penalty_id INTEGER REFERENCES penalties(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(employee_id, attendance_date)
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_emp_date ON attendance_logs(employee_id, attendance_date);

    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leave_code TEXT NOT NULL UNIQUE,
      employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      total_days INTEGER NOT NULL DEFAULT 1,
      leave_type TEXT NOT NULL DEFAULT 'Casual Leave',
      reason TEXT NOT NULL,
      approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING','APPROVED','REJECTED')),
      expected_approver_role TEXT NOT NULL,
      reviewed_by INTEGER REFERENCES users(id),
      reviewer_role TEXT,
      review_remarks TEXT,
      reviewed_at TEXT,
      unapproved_penalty_amount REAL NOT NULL DEFAULT 0,
      penalty_id INTEGER REFERENCES penalties(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_leaves_emp ON leave_requests(employee_id, approval_status);
  `);

  // Safe column migrations for existing SQLite files
  const leadCols = (db.prepare(`PRAGMA table_info(leads)`).all() as { name: string }[]).map((c) => c.name);
  if (!leadCols.includes('lost_reason')) {
    db.exec(`ALTER TABLE leads ADD COLUMN lost_reason TEXT`);
  }
  if (!leadCols.includes('existing_emi')) {
    db.exec(`ALTER TABLE leads ADD COLUMN existing_emi REAL DEFAULT 0`);
  }
  if (!leadCols.includes('employment_type')) {
    db.exec(`ALTER TABLE leads ADD COLUMN employment_type TEXT DEFAULT 'Salaried'`);
  }
  if (!leadCols.includes('assigned_bm_id')) {
    db.exec(`ALTER TABLE leads ADD COLUMN assigned_bm_id INTEGER REFERENCES users(id)`);
  }
  if (!leadCols.includes('assigned_tl_id')) {
    db.exec(`ALTER TABLE leads ADD COLUMN assigned_tl_id INTEGER REFERENCES users(id)`);
  }
  if (!leadCols.includes('rejected_by')) {
    db.exec(`ALTER TABLE leads ADD COLUMN rejected_by INTEGER REFERENCES users(id)`);
  }
  if (!leadCols.includes('rejected_by_role')) {
    db.exec(`ALTER TABLE leads ADD COLUMN rejected_by_role TEXT`);
  }
  if (!leadCols.includes('rejected_at')) {
    db.exec(`ALTER TABLE leads ADD COLUMN rejected_at TEXT`);
  }
  if (!leadCols.includes('closure_status')) {
    db.exec(`ALTER TABLE leads ADD COLUMN closure_status TEXT DEFAULT 'NONE'`);
  }
  if (!leadCols.includes('closure_requested_by')) {
    db.exec(`ALTER TABLE leads ADD COLUMN closure_requested_by INTEGER REFERENCES users(id)`);
  }
  if (!leadCols.includes('closure_requested_at')) {
    db.exec(`ALTER TABLE leads ADD COLUMN closure_requested_at TEXT`);
  }
  if (!leadCols.includes('closure_approved_by')) {
    db.exec(`ALTER TABLE leads ADD COLUMN closure_approved_by INTEGER REFERENCES users(id)`);
  }
  if (!leadCols.includes('closure_approved_at')) {
    db.exec(`ALTER TABLE leads ADD COLUMN closure_approved_at TEXT`);
  }
  if (!leadCols.includes('closure_remarks')) {
    db.exec(`ALTER TABLE leads ADD COLUMN closure_remarks TEXT`);
  }
  // Backfill any pre-existing Rejected leads so they enter Seniority Close Approval cleanly
  db.exec(`
    UPDATE leads
    SET closure_status = 'PENDING_APPROVAL'
    WHERE status = 'Rejected' AND (closure_status IS NULL OR closure_status = 'NONE')
  `);

  // Safe migration for officer geographical area coverage & hierarchy parent columns
  const userCols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
  if (!userCols.includes('service_city')) {
    db.exec(`ALTER TABLE users ADD COLUMN service_city TEXT`);
  }
  if (!userCols.includes('service_pincodes')) {
    db.exec(`ALTER TABLE users ADD COLUMN service_pincodes TEXT`);
  }
  if (!userCols.includes('reports_to_user_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN reports_to_user_id INTEGER REFERENCES users(id)`);
  }
  if (!userCols.includes('profile_photo_data_url')) {
    db.exec(`ALTER TABLE users ADD COLUMN profile_photo_data_url TEXT`);
  }

  // Safe migration for existing SQLite files where users.role CHECK lacked LEAD_GENERATOR or mobile had UNIQUE
  const usersSqlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get() as { sql?: string } | undefined;
  if (
    usersSqlRow?.sql &&
    (!usersSqlRow.sql.includes('LEAD_GENERATOR') || /mobile\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(usersSqlRow.sql))
  ) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE users_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_code TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        mobile TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','BRANCH_MANAGER','TEAM_LEADER','LEAD_GENERATOR','FIELD_OFFICER','REFERRAL_PARTNER')),
        branch_id INTEGER REFERENCES branches(id),
        team_id INTEGER REFERENCES teams(id),
        referral_code TEXT UNIQUE,
        is_active INTEGER NOT NULL DEFAULT 1,
        otp_enabled INTEGER NOT NULL DEFAULT 0,
        gps_consent INTEGER NOT NULL DEFAULT 0,
        camera_consent INTEGER NOT NULL DEFAULT 0,
        preferred_lang TEXT NOT NULL DEFAULT 'en',
        service_city TEXT,
        service_pincodes TEXT,
        reports_to_user_id INTEGER REFERENCES users(id),
        profile_photo_data_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_migrated (
        id, employee_code, full_name, mobile, email, password_hash, role,
        branch_id, team_id, referral_code, is_active, otp_enabled, gps_consent, camera_consent,
        preferred_lang, service_city, service_pincodes, reports_to_user_id, profile_photo_data_url, created_at
      )
      SELECT
        id, employee_code, full_name, COALESCE(mobile, ''), email, password_hash, role,
        branch_id, team_id, referral_code, is_active, otp_enabled, gps_consent, camera_consent,
        preferred_lang, service_city, service_pincodes, reports_to_user_id, NULL, created_at
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_migrated RENAME TO users;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Safe migration for bike_runs to support DEDUCTED status, tour/customer/location details & billing breakdown
  const bikeRunsSqlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bike_runs'`).get() as { sql?: string } | undefined;
  const bikeCols = (db.prepare(`PRAGMA table_info(bike_runs)`).all() as { name: string }[]).map((c) => c.name);
  if (
    bikeRunsSqlRow?.sql &&
    (!bikeRunsSqlRow.sql.includes('DEDUCTED') || !bikeCols.includes('customer_name') || !bikeCols.includes('gross_amount'))
  ) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE bike_runs_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_code TEXT NOT NULL UNIQUE,
        employee_id INTEGER NOT NULL REFERENCES users(id),
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        customer_name TEXT NOT NULL DEFAULT '',
        tour_reason TEXT NOT NULL DEFAULT '',
        start_location TEXT NOT NULL DEFAULT '',
        end_location TEXT NOT NULL DEFAULT '',
        start_time TEXT NOT NULL,
        end_time TEXT,
        start_lat REAL NOT NULL,
        start_lng REAL NOT NULL,
        end_lat REAL,
        end_lng REAL,
        opening_odometer REAL NOT NULL,
        closing_odometer REAL,
        gps_distance_km REAL NOT NULL DEFAULT 0,
        odometer_distance_km REAL NOT NULL DEFAULT 0,
        discrepancy_km REAL NOT NULL DEFAULT 0,
        discrepancy_flag INTEGER NOT NULL DEFAULT 0,
        rate_per_km REAL NOT NULL DEFAULT 3.0,
        eligible_km REAL NOT NULL DEFAULT 0,
        gross_amount REAL NOT NULL DEFAULT 0,
        deducted_amount REAL NOT NULL DEFAULT 0,
        incentive_amount REAL NOT NULL DEFAULT 0,
        approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING','APPROVED','DEDUCTED','REJECTED')),
        reviewed_by INTEGER REFERENCES users(id),
        reviewer_role TEXT,
        review_remarks TEXT,
        reviewed_at TEXT,
        route_points_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED'))
      );
      INSERT INTO bike_runs_migrated (
        id, run_code, employee_id, lead_id, customer_name, tour_reason, start_location, end_location,
        start_time, end_time, start_lat, start_lng, end_lat, end_lng,
        opening_odometer, closing_odometer, gps_distance_km, odometer_distance_km, discrepancy_km, discrepancy_flag,
        rate_per_km, eligible_km, gross_amount, deducted_amount, incentive_amount,
        approval_status, reviewed_by, reviewer_role, review_remarks, reviewed_at, route_points_json, status
      )
      SELECT
        id, run_code, employee_id, NULL, '', '',
        printf('%.4f, %.4f', start_lat, start_lng),
        CASE WHEN end_lat IS NOT NULL AND end_lng IS NOT NULL THEN printf('%.4f, %.4f', end_lat, end_lng) ELSE '' END,
        start_time, end_time, start_lat, start_lng, end_lat, end_lng,
        opening_odometer, closing_odometer, gps_distance_km, odometer_distance_km, discrepancy_km, discrepancy_flag,
        rate_per_km, eligible_km,
        ROUND(COALESCE(eligible_km, 0) * COALESCE(rate_per_km, 3.0), 2),
        0,
        incentive_amount,
        approval_status, reviewed_by, NULL, review_remarks, reviewed_at, route_points_json, status
      FROM bike_runs;
      DROP TABLE bike_runs;
      ALTER TABLE bike_runs_migrated RENAME TO bike_runs;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Safe migration for penalties CHECK constraint to allow ATTENDANCE_LATE_20 & UNAPPROVED_LEAVE_100
  const penaltiesSqlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'penalties'`).get() as { sql?: string } | undefined;
  if (penaltiesSqlRow?.sql && !penaltiesSqlRow.sql.includes('ATTENDANCE_LATE_20')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE penalties_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        penalty_code TEXT NOT NULL UNIQUE,
        employee_id INTEGER NOT NULL REFERENCES users(id),
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        enquiry_id INTEGER,
        penalty_type TEXT NOT NULL CHECK (penalty_type IN ('LEAD_ASSIGNMENT_10M','FOLLOWUP_REMINDER_10M','ENQUIRY_SLA_60M','ATTENDANCE_LATE_20','UNAPPROVED_LEAVE_100')),
        event_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        actual_update_at TEXT,
        delay_seconds INTEGER NOT NULL DEFAULT 0,
        amount REAL NOT NULL DEFAULT 10,
        approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING','APPROVED','REJECTED')),
        reviewed_by INTEGER REFERENCES users(id),
        review_remarks TEXT,
        reviewed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO penalties_migrated (
        id, penalty_code, employee_id, lead_id, enquiry_id, penalty_type, event_at, deadline_at,
        actual_update_at, delay_seconds, amount, approval_status, reviewed_by, review_remarks, reviewed_at, created_at
      )
      SELECT
        id, penalty_code, employee_id, lead_id, enquiry_id, penalty_type, event_at, deadline_at,
        actual_update_at, delay_seconds, amount, approval_status, reviewed_by, review_remarks, reviewed_at, created_at
      FROM penalties;
      DROP TABLE penalties;
      ALTER TABLE penalties_migrated RENAME TO penalties;
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  }

  seedInitialOrgAndSettings();
  db.prepare(`UPDATE users SET full_name = 'Ruchi Gupta' WHERE employee_code = 'ADM001' AND full_name = 'Rajesh Sharma'`).run();
  // Update default Head Office branch & official office address to Satna MP (485001)
  db.prepare(`
    UPDATE branches
    SET code = 'HQ-STA',
        name = 'Satna Head Office',
        city = 'Satna',
        state = 'Madhya Pradesh'
    WHERE (code = 'HQ-MUM' OR name = 'Mumbai Head Office') AND city = 'Mumbai'
  `).run();
  db.prepare(`UPDATE teams SET name = 'Satna Retail Loans Alpha' WHERE name = 'Mumbai Retail Loans Alpha'`).run();
  db.prepare(`UPDATE teams SET name = 'Satna Mortgage & LAP Bravo' WHERE name = 'Mumbai Mortgage & LAP Bravo'`).run();
  db.prepare(`
    INSERT OR IGNORE INTO settings (key, value_json)
    VALUES ('officeAddress', ?)
  `).run(JSON.stringify(OFFICIAL_OFFICE_ADDRESS));
  db.prepare(`
    INSERT OR IGNORE INTO settings (key, value_json)
    VALUES ('seniorityInstructions', ?)
  `).run(JSON.stringify(DEFAULT_SENIORITY_INSTRUCTIONS));
  db.prepare(`
    INSERT OR IGNORE INTO settings (key, value_json)
    VALUES ('configVersion', '1')
  `).run();
  // Migrate uncalibrated city-center / Mumbai defaults to Satna Pateri Road Anupam Complex (24.5819, 80.7921)
  db.prepare(`UPDATE settings SET value_json = '24.5819' WHERE key = 'officeLatitude' AND value_json IN ('19.076', '19.0760', '24.5773')`).run();
  db.prepare(`UPDATE settings SET value_json = '80.7921' WHERE key = 'officeLongitude' AND value_json IN ('72.8777', '80.8272')`).run();
  db.prepare(`UPDATE settings SET value_json = '500' WHERE key = 'officeRadiusMeters' AND value_json = '300'`).run();
  // Enforce configured ₹3.00/km petrol rate across existing databases
  db.prepare(`UPDATE settings SET value_json = '3' WHERE key = 'petrolRatePerKm' AND value_json IN ('3.5', '"3.5"')`).run();
  db.prepare(`
    UPDATE bike_runs
    SET rate_per_km = 3.0,
        gross_amount = ROUND(eligible_km * 3.0, 2),
        incentive_amount = ROUND(eligible_km * 3.0, 2),
        customer_name = CASE WHEN customer_name = '' THEN 'Ramesh Chandra Tiwari' ELSE customer_name END,
        tour_reason = CASE WHEN tour_reason = '' THEN 'Loan Agreement & KYC Document Pickup' ELSE tour_reason END,
        start_location = CASE WHEN start_location IN ('', '19.0760, 72.8777') THEN 'Satna Head Office (24.5819, 80.7921)' ELSE start_location END,
        end_location = CASE WHEN end_location IN ('', '19.1364, 72.8296') THEN 'Pateri Road, Satna (24.5835, 80.7950)' ELSE end_location END
    WHERE run_code = 'RUN-0001' AND approval_status = 'PENDING' AND rate_per_km = 3.5
  `).run();
  seedOfficerTerritoriesIfNeeded();
  seedSalesExtensionsIfNeeded();
  seedHierarchyLinksIfNeeded();
}

function seedHierarchyLinksIfNeeded() {
  const bm1 = db.prepare(`SELECT id, branch_id FROM users WHERE employee_code = 'BM001'`).get() as { id: number; branch_id: number } | undefined;
  const tl1 = db.prepare(`SELECT id, branch_id FROM users WHERE employee_code = 'TL001'`).get() as { id: number; branch_id: number } | undefined;
  const fo1 = db.prepare(`SELECT id FROM users WHERE employee_code = 'FO001'`).get() as { id: number } | undefined;
  const fo3 = db.prepare(`SELECT id FROM users WHERE employee_code = 'FO003'`).get() as { id: number } | undefined;

  if (bm1 && tl1) {
    db.prepare(`UPDATE users SET reports_to_user_id = ? WHERE id = ? AND reports_to_user_id IS NULL`).run(bm1.id, tl1.id);
  }
  if (tl1) {
    db.prepare(`UPDATE users SET reports_to_user_id = ? WHERE employee_code IN ('FO001', 'FO002') AND reports_to_user_id IS NULL`).run(tl1.id);
  }
  if (fo1) {
    db.prepare(`UPDATE users SET reports_to_user_id = ? WHERE employee_code = 'REF001' AND reports_to_user_id IS NULL`).run(fo1.id);
  }
  if (fo3) {
    db.prepare(`UPDATE users SET reports_to_user_id = ? WHERE employee_code = 'REF002' AND reports_to_user_id IS NULL`).run(fo3.id);
  }

  // Backfill assigned_tl_id and assigned_bm_id on existing FO-assigned leads if not yet tagged
  const assignedLeads = db
    .prepare(`SELECT id, assigned_officer_id, branch_id FROM leads WHERE assigned_officer_id IS NOT NULL AND (assigned_tl_id IS NULL OR assigned_bm_id IS NULL)`)
    .all() as { id: number; assigned_officer_id: number; branch_id: number | null }[];
  for (const lead of assignedLeads) {
    const fo = db
      .prepare(`SELECT reports_to_user_id, branch_id FROM users WHERE id = ?`)
      .get(lead.assigned_officer_id) as { reports_to_user_id: number | null; branch_id: number | null } | undefined;
    const tlId = fo?.reports_to_user_id ?? tl1?.id ?? null;
    const tlRow = tlId
      ? (db.prepare(`SELECT reports_to_user_id FROM users WHERE id = ?`).get(tlId) as { reports_to_user_id: number | null } | undefined)
      : undefined;
    const branchBm = (lead.branch_id || fo?.branch_id)
      ? (db.prepare(`SELECT id FROM users WHERE role = 'BRANCH_MANAGER' AND branch_id = ? AND is_active = 1 LIMIT 1`).get(lead.branch_id || fo?.branch_id) as { id: number } | undefined)
      : undefined;
    const bmId = tlRow?.reports_to_user_id ?? branchBm?.id ?? bm1?.id ?? null;
    db.prepare(`UPDATE leads SET assigned_tl_id = COALESCE(assigned_tl_id, ?), assigned_bm_id = COALESCE(assigned_bm_id, ?) WHERE id = ?`).run(
      tlId,
      bmId,
      lead.id
    );
  }
}

function seedOfficerTerritoriesIfNeeded() {
  const presets: { code: string; city: string; pincodes: string }[] = [
    {
      code: 'FO001',
      city: 'Mumbai',
      pincodes: '400, 400001, 400053, 400058, 400050, Andheri, Bandra, Dadar, Lower Parel, Mumbai',
    },
    {
      code: 'FO002',
      city: 'Mumbai',
      pincodes: '400, 400067, 400092, 401, 400601, Borivali, Kandivali, Malad, Thane, Navi Mumbai',
    },
    {
      code: 'FO003',
      city: 'Pune',
      pincodes: '411, 411001, 411004, 411038, 412, Kothrud, Shivajinagar, Baner, Pimpri, Pune',
    },
    {
      code: 'TL001',
      city: 'Mumbai',
      pincodes: '400, Mumbai',
    },
  ];
  const stmt = db.prepare(
    `UPDATE users SET service_city = ?, service_pincodes = ? WHERE employee_code = ? AND (service_city IS NULL OR TRIM(service_city) = '')`
  );
  for (const p of presets) {
    stmt.run(p.city, p.pincodes, p.code);
  }
}

const DEFAULT_LOAN_PRODUCTS: LoanProductConfig[] = [
  { id: 'home_loan', name: 'Home Loan', defaultRate: 8.65, minTenureMonths: 12, maxTenureMonths: 360, commissionPct: 0.45 },
  { id: 'lap', name: 'Loan Against Property (LAP)', defaultRate: 9.75, minTenureMonths: 12, maxTenureMonths: 240, commissionPct: 0.65 },
  { id: 'personal_loan', name: 'Personal Loan', defaultRate: 11.25, minTenureMonths: 12, maxTenureMonths: 72, commissionPct: 1.25 },
  { id: 'business_loan', name: 'Business Loan', defaultRate: 14.5, minTenureMonths: 12, maxTenureMonths: 60, commissionPct: 1.5 },
  { id: 'auto_loan', name: 'Auto / Commercial Vehicle Loan', defaultRate: 9.25, minTenureMonths: 12, maxTenureMonths: 84, commissionPct: 0.85 },
  { id: 'gold_loan', name: 'Gold / Working Capital', defaultRate: 10.5, minTenureMonths: 3, maxTenureMonths: 36, commissionPct: 0.5 },
];

export const APP_BUILD_VERSION = '2026.11.20-v3';

export const OFFICIAL_OFFICE_ADDRESS =
  '1ST FLOR ANUPAM COMPLEX,PATERI ROAD,NEAR RELIANCE BAZAR,SATNA MP(485001)';

export const DEFAULT_SENIORITY_INSTRUCTIONS =
  'Seniority Policy: Field Officer -> Team Leader | Team Leader & Back Office Lead Gen -> Branch Manager | Branch Manager -> Super Admin (Ruchi Gupta). Daily Self-Attendance turns GREEN ON inside Ambika Office GPS up to 10:00 AM IST (₹20/day late penalty after 10 AM). Unapproved leave penalty ₹100/leave. Petrol conveyance rate ₹3.00/km.';

function seedInitialOrgAndSettings() {
  const branchCount = (db.prepare('SELECT COUNT(*) as c FROM branches').get() as { c: number }).c;
  if (branchCount === 0) {
    const insertBranch = db.prepare(
      'INSERT INTO branches (code, name, city, state) VALUES (?, ?, ?, ?)'
    );
    const b1 = insertBranch.run('HQ-STA', 'Satna Head Office', 'Satna', 'Madhya Pradesh').lastInsertRowid as number;
    const b2 = insertBranch.run('BR-PUN', 'Pune Regional Branch', 'Pune', 'Maharashtra').lastInsertRowid as number;
    const b3 = insertBranch.run('BR-SUR', 'Surat Commercial Branch', 'Surat', 'Gujarat').lastInsertRowid as number;

    const insertTeam = db.prepare('INSERT INTO teams (branch_id, name) VALUES (?, ?)');
    const t1 = insertTeam.run(b1, 'Satna Retail Loans Alpha').lastInsertRowid as number;
    const t2 = insertTeam.run(b1, 'Satna Mortgage & LAP Bravo').lastInsertRowid as number;
    const t3 = insertTeam.run(b2, 'Pune Field Sales Unit').lastInsertRowid as number;

    const insertUser = db.prepare(`
      INSERT INTO users (employee_code, full_name, mobile, email, password_hash, role, branch_id, team_id, referral_code, is_active, otp_enabled, gps_consent, camera_consent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, 1)
    `);

    const adminHash = bcrypt.hashSync('Admin@123', 10);
    const branchHash = bcrypt.hashSync('Branch@123', 10);
    const leaderHash = bcrypt.hashSync('Leader@123', 10);
    const fieldHash = bcrypt.hashSync('Field@123', 10);
    const backofficeHash = bcrypt.hashSync('Backoffice@123', 10);
    const refHash = bcrypt.hashSync('Referral@123', 10);

    insertUser.run('ADM001', 'Ruchi Gupta', '9800000001', 'ambikafinance.info@gmail.com', adminHash, 'SUPER_ADMIN', b1, null, null);
    insertUser.run('BM001', 'Vikram Patel', '9800000002', 'vikram.bm@ambikaassociate.in', branchHash, 'BRANCH_MANAGER', b1, null, null);
    const tlId = insertUser.run('TL001', 'Neha Kulkarni', '9800000003', 'neha.tl@ambikaassociate.in', leaderHash, 'TEAM_LEADER', b1, t1, null).lastInsertRowid as number;
    db.prepare('UPDATE teams SET leader_user_id = ? WHERE id = ?').run(tlId, t1);

    insertUser.run('LG001', 'Sneha Tiwari', '9800000009', 'sneha.lg@ambikaassociate.in', backofficeHash, 'LEAD_GENERATOR', b1, null, null);
    insertUser.run('FO001', 'Amit Verma', '9800000004', 'amit.fo@ambikaassociate.in', fieldHash, 'FIELD_OFFICER', b1, t1, null);
    insertUser.run('FO002', 'Suresh Nair', '9800000005', 'suresh.fo@ambikaassociate.in', fieldHash, 'FIELD_OFFICER', b1, t2, null);
    insertUser.run('FO003', 'Deepak Deshmukh', '9800000008', 'deepak.fo@ambikaassociate.in', fieldHash, 'FIELD_OFFICER', b2, t3, null);
    insertUser.run('REF001', 'Kiran Joshi', '9800000006', 'kiran.dsa@ambikaassociate.in', refHash, 'REFERRAL_PARTNER', b1, t1, 'REF-AA-101');
    insertUser.run('REF002', 'Priya Mehta', '9800000007', 'priya.dsa@ambikaassociate.in', refHash, 'REFERRAL_PARTNER', b2, t3, 'REF-AA-102');

    const defaultSettings: Record<string, unknown> = {
      petrolRatePerKm: 3.0,
      assignmentSlaMinutes: 10,
      followupSlaMinutes: 10,
      enquirySlaMinutes: 60,
      otpRequiredGlobal: false,
      defaultLanguage: 'en',
      companyLogoDataUrl: null,
      playStoreUrl: null,
      apkDownloadUrl: null,
      autoAssignIncomingLeads: true,
      autoAssignMaxActiveLeads: 25,
      autoAssignGeoWeight: 60,
      officeName: 'AMBIKA ASSOCIATE Head Office',
      officeAddress: OFFICIAL_OFFICE_ADDRESS,
      officeLatitude: 24.5819,
      officeLongitude: 80.7921,
      officeRadiusMeters: 500,
      attendanceCutoffTime: '10:00',
      attendanceLatePenaltyInr: 20,
      unapprovedLeavePenaltyInr: 100,
      seniorityInstructions: DEFAULT_SENIORITY_INSTRUCTIONS,
      configVersion: 1,
      lastSyncSummary: 'Initial Ambika Associate Satna configuration active',
      lastSyncUpdatedAt: new Date().toISOString(),
      loanProducts: DEFAULT_LOAN_PRODUCTS,
    };

    const insertSetting = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value_json) VALUES (?, ?)'
    );
    for (const [k, v] of Object.entries(defaultSettings)) {
      insertSetting.run(k, JSON.stringify(v));
    }

    // Seed initial verification dataset so every module & RBAC rule can be tested immediately
    seedVerificationDatasetInternal(true);
  }
}

export function getSettings(): SystemSettings {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as {
    key: string;
    value_json: string;
  }[];
  const map: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      map[r.key] = JSON.parse(r.value_json);
    } catch {
      map[r.key] = r.value_json;
    }
  }
  const rawProducts = Array.isArray(map.loanProducts)
    ? (map.loanProducts as LoanProductConfig[])
    : DEFAULT_LOAN_PRODUCTS;
  const normalizedProducts = rawProducts.map((p) => {
    const def = DEFAULT_LOAN_PRODUCTS.find((d) => d.id === p.id || d.name === p.name);
    return {
      ...p,
      commissionPct: p.commissionPct ?? def?.commissionPct ?? 0.5,
    };
  });
  const hasAutoLoan = normalizedProducts.some(
    (p) => p.id === 'auto_loan' || /auto|commercial vehicle/i.test(p.name)
  );
  const autoDefault = DEFAULT_LOAN_PRODUCTS.find((d) => d.id === 'auto_loan')!;
  const loanProducts = hasAutoLoan ? normalizedProducts : [...normalizedProducts, autoDefault];

  const uploadedApkPath = path.join(UPLOAD_DIR, 'ambika-associate-crm.apk');
  const bundledApkPath = path.join(process.cwd(), 'public', 'ambika-associate-crm.apk');
  const hostedApkPath = fs.existsSync(uploadedApkPath)
    ? uploadedApkPath
    : fs.existsSync(bundledApkPath)
      ? bundledApkPath
      : null;
  const hasUploadedApk = Boolean(hostedApkPath);
  const apkFileSize = hostedApkPath ? fs.statSync(hostedApkPath).size : null;

  const uploadedAabPath = path.join(UPLOAD_DIR, 'ambika-associate-crm.aab');
  const bundledAabPath = path.join(process.cwd(), 'public', 'ambika-associate-crm.aab');
  const hostedAabPath = fs.existsSync(uploadedAabPath)
    ? uploadedAabPath
    : fs.existsSync(bundledAabPath)
      ? bundledAabPath
      : null;
  const hasUploadedAab = Boolean(hostedAabPath);
  const aabFileSize = hostedAabPath ? fs.statSync(hostedAabPath).size : null;

  return {
    petrolRatePerKm: Number(map.petrolRatePerKm ?? 3.0),
    assignmentSlaMinutes: Number(map.assignmentSlaMinutes ?? 10),
    followupSlaMinutes: Number(map.followupSlaMinutes ?? 10),
    enquirySlaMinutes: Number(map.enquirySlaMinutes ?? 60),
    otpRequiredGlobal: Boolean(map.otpRequiredGlobal ?? false),
    defaultLanguage: (map.defaultLanguage as 'en' | 'hi') ?? 'en',
    companyLogoDataUrl: (map.companyLogoDataUrl as string | null) ?? null,
    loanProducts,
    referralBonusThreshold: Number(map.referralBonusThreshold ?? 5),
    referralBonusPct: Number(map.referralBonusPct ?? 0.15),
    loginRewardOfficerPts: Number(map.loginRewardOfficerPts ?? 50),
    loginRewardGeneratorPts: Number(map.loginRewardGeneratorPts ?? 30),
    disbursementRewardOfficerPts: Number(map.disbursementRewardOfficerPts ?? 150),
    disbursementRewardGeneratorPts: Number(map.disbursementRewardGeneratorPts ?? 100),
    wrongLeadPenaltyMin: Number(map.wrongLeadPenaltyMin ?? 10),
    wrongLeadPenaltyMax: Number(map.wrongLeadPenaltyMax ?? 100),
    wrongLeadPenaltyDefault: Number(map.wrongLeadPenaltyDefault ?? 50),
    playStoreUrl: (map.playStoreUrl as string | null) ?? null,
    apkDownloadUrl: (map.apkDownloadUrl as string | null) ?? null,
    hasUploadedApk,
    apkFileName: hasUploadedApk ? 'ambika-associate-crm.apk' : null,
    apkFileSize,
    hasUploadedAab,
    aabFileName: hasUploadedAab ? 'ambika-associate-crm.aab' : null,
    aabFileSize,
    autoAssignIncomingLeads:
      map.autoAssignIncomingLeads === undefined ? true : Boolean(map.autoAssignIncomingLeads),
    autoAssignMaxActiveLeads: Math.max(1, Number(map.autoAssignMaxActiveLeads ?? 25)),
    autoAssignGeoWeight: Math.min(100, Math.max(0, Number(map.autoAssignGeoWeight ?? 60))),
    officeName: String(map.officeName ?? 'AMBIKA ASSOCIATE Head Office'),
    officeAddress: String(map.officeAddress ?? OFFICIAL_OFFICE_ADDRESS),
    officeLatitude: Number(map.officeLatitude ?? 24.5819),
    officeLongitude: Number(map.officeLongitude ?? 80.7921),
    officeRadiusMeters: Math.max(50, Number(map.officeRadiusMeters ?? 500)),
    attendanceCutoffTime: String(map.attendanceCutoffTime ?? '10:00'),
    attendanceLatePenaltyInr: Math.max(0, Number(map.attendanceLatePenaltyInr ?? 20)),
    unapprovedLeavePenaltyInr: Math.max(0, Number(map.unapprovedLeavePenaltyInr ?? 100)),
    seniorityInstructions: String(map.seniorityInstructions ?? DEFAULT_SENIORITY_INSTRUCTIONS),
    configVersion: Math.max(1, Number(map.configVersion ?? 1)),
    appBuildVersion: APP_BUILD_VERSION,
    lastSyncSummary: (map.lastSyncSummary as string | null) ?? null,
    lastSyncUpdatedAt: (map.lastSyncUpdatedAt as string | null) ?? null,
  };
}

export function updateSetting(key: string, value: unknown, userId: number | null) {
  db.prepare(`
    INSERT INTO settings (key, value_json, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).run(key, JSON.stringify(value), userId ?? null);
}

export function bumpConfigVersion(summary: string, userId?: number | null) {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = 'configVersion'`).get() as
    | { value_json: string }
    | undefined;
  let current = 1;
  if (row) {
    try {
      current = Number(JSON.parse(row.value_json)) || 1;
    } catch {
      current = 1;
    }
  }
  const nextVersion = current + 1;
  const updatedAt = new Date().toISOString();
  updateSetting('configVersion', nextVersion, userId ?? null);
  updateSetting('lastSyncSummary', summary, userId ?? null);
  updateSetting('lastSyncUpdatedAt', updatedAt, userId ?? null);
  return {
    configVersion: nextVersion,
    appBuildVersion: APP_BUILD_VERSION,
    summary,
    updatedAt,
  };
}

export function logAudit(
  user: { id?: number | null; fullName: string; role: string } | null,
  action: string,
  entityType: string,
  entityId: string | number | null,
  details: string
) {
  db.prepare(`
    INSERT INTO audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    user?.id ?? null,
    user?.fullName ?? 'SYSTEM',
    user?.role ?? 'SYSTEM',
    action,
    entityType,
    entityId !== null && entityId !== undefined ? String(entityId) : null,
    details
  );
}

export function nextCode(prefix: string, table: string, col: string): string {
  const row = db
    .prepare(`SELECT COUNT(*) as c FROM ${table}`)
    .get() as { c: number };
  const seq = (row?.c ?? 0) + 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

export function createAlert(params: {
  userId: number;
  leadId?: number | null;
  enquiryId?: number | null;
  category: AlertCategory;
  titleEn: string;
  titleHi: string;
  messageEn: string;
  messageHi: string;
}) {
  const code = `ALT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
  db.prepare(`
    INSERT INTO alerts (alert_code, user_id, lead_id, enquiry_id, category, title_en, title_hi, message_en, message_hi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code,
    params.userId,
    params.leadId ?? null,
    params.enquiryId ?? null,
    params.category,
    params.titleEn,
    params.titleHi,
    params.messageEn,
    params.messageHi
  );
}

export function getSuperAdminIds(): number[] {
  const rows = db
    .prepare(`SELECT id FROM users WHERE role = 'SUPER_ADMIN' AND is_active = 1`)
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}

export function seedVerificationDatasetInternal(initialBoot = false) {
  const existingCount = (db.prepare('SELECT COUNT(*) as c FROM leads').get() as { c: number }).c;
  if (existingCount > 0) return;

  const admin = db.prepare(`SELECT id FROM users WHERE employee_code = 'ADM001'`).get() as { id: number };
  const fo1 = db.prepare(`SELECT id, branch_id FROM users WHERE employee_code = 'FO001'`).get() as { id: number; branch_id: number };
  const fo2 = db.prepare(`SELECT id, branch_id FROM users WHERE employee_code = 'FO002'`).get() as { id: number; branch_id: number };
  const ref1 = db.prepare(`SELECT id, full_name, referral_code, branch_id FROM users WHERE employee_code = 'REF001'`).get() as {
    id: number; full_name: string; referral_code: string; branch_id: number;
  };
  const ref2 = db.prepare(`SELECT id, full_name, referral_code, branch_id FROM users WHERE employee_code = 'REF002'`).get() as {
    id: number; full_name: string; referral_code: string; branch_id: number;
  };

  const now = new Date();
  const isoAgo = (mins: number) => new Date(now.getTime() - mins * 60000).toISOString().replace('T', ' ').slice(0, 19);
  const isoFuture = (mins: number) => new Date(now.getTime() + mins * 60000).toISOString().replace('T', ' ').slice(0, 19);

  const insertLead = db.prepare(`
    INSERT INTO leads (
      lead_code, customer_name, customer_name_norm, customer_mobile_enc, customer_mobile_hash,
      alternate_mobile_enc, pan_enc, pan_hash, dob, address_enc, city, state, pin_code,
      loan_product, loan_amount, employment_details, monthly_income, bank_nbfc,
      referral_id, referral_name, created_by, assigned_officer_id, assigned_at,
      assignment_deadline_at, assignment_sla_checked, branch_id, status, last_status_at,
      remarks, customer_consent, is_test_record, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `);

  const l1 = insertLead.run(
    'AMB-2026-0001', 'Ramesh Chandra Tiwari', 'RAMESHCHANDRATIWARI',
    encryptPii('9820112233'), hashLookup('9820112233'), encryptPii('9820112234'),
    encryptPii('ABCPT1234K'), hashLookup('ABCPT1234K'), '1986-05-14',
    encryptPii('402 Sai Krupa Residency, Andheri West'), 'Mumbai', 'Maharashtra', '400053',
    'Home Loan', 4500000, 'Senior Manager - Tata Consultancy', 145000, 'HDFC Bank',
    ref1.referral_code, ref1.full_name, ref1.id, fo1.id, isoAgo(180),
    isoAgo(170), 1, fo1.branch_id, 'Disbursed', isoAgo(30),
    'All KYC & property legal cleared. Disbursed first tranche.', isoAgo(240), isoAgo(30)
  ).lastInsertRowid as number;

  const l2 = insertLead.run(
    'AMB-2026-0002', 'Sunita Manoj Deshpande', 'SUNITAMANOJDESHPANDE',
    encryptPii('9820445566'), hashLookup('9820445566'), null,
    encryptPii('BGHPD5678L'), hashLookup('BGHPD5678L'), '1990-11-22',
    encryptPii('18 Prabhat Road, Deccan Gymkhana'), 'Pune', 'Maharashtra', '411004',
    'Loan Against Property (LAP)', 3200000, 'Proprietor - Deshpande Traders', 180000, 'ICICI Bank',
    ref2.referral_code, ref2.full_name, ref2.id, fo2.id, isoAgo(95),
    isoAgo(85), 1, ref2.branch_id, 'Documents Pending', isoAgo(45),
    'Awaiting last 6 months GST return and property index II copy.', isoAgo(120), isoAgo(45)
  ).lastInsertRowid as number;

  const l3 = insertLead.run(
    'AMB-2026-0003', 'Mahesh Kumar Agarwal', 'MAHESHKUMARAGARWAL',
    encryptPii('9820778899'), hashLookup('9820778899'), null,
    encryptPii('CKLPA9012M'), hashLookup('CKLPA9012M'), '1988-02-09',
    encryptPii('72 Ring Road, Vesu'), 'Surat', 'Gujarat', '395007',
    'Business Loan', 1500000, 'Textile Wholesale Partner', 210000, 'Bajaj Finserv',
    ref1.referral_code, ref1.full_name, ref1.id, fo1.id, isoAgo(4),
    isoFuture(6), 0, fo1.branch_id, 'Lead Assigned', isoAgo(4),
    'Freshly assigned lead - 10 min SLA active.', isoAgo(15), isoAgo(4)
  ).lastInsertRowid as number;

  const l4 = insertLead.run(
    'AMB-2026-0004', 'Anjali Vivek Sawant', 'ANJALIVIVEKSAWANT',
    encryptPii('9820334455'), hashLookup('9820334455'), null,
    encryptPii('DMNPS4321R'), hashLookup('DMNPS4321R'), '1993-08-17',
    encryptPii('1204 Hiranandani Gardens, Powai'), 'Mumbai', 'Maharashtra', '400076',
    'Personal Loan', 850000, 'Product Analyst - FinTech Pvt Ltd', 92000, 'Axis Bank',
    null, null, admin.id, fo2.id, isoAgo(60),
    isoAgo(50), 1, fo2.branch_id, 'Under Process', isoAgo(20),
    'Credit appraisal underway with Axis Bank central underwriting.', isoAgo(75), isoAgo(20)
  ).lastInsertRowid as number;

  const insertHist = db.prepare(`
    INSERT INTO case_history (lead_id, prev_status, new_status, updated_by, remarks, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertHist.run(l1, null, 'Lead Generated', ref1.id, 'Submitted via Referral Partner portal', isoAgo(240));
  insertHist.run(l1, 'Lead Generated', 'Lead Assigned', admin.id, 'Assigned to Amit Verma', isoAgo(180));
  insertHist.run(l1, 'Lead Assigned', 'Case Logged In', fo1.id, 'Logged in with HDFC Bank', isoAgo(110));
  insertHist.run(l1, 'Case Logged In', 'Disbursed', fo1.id, 'Loan disbursed ₹45,00,000', isoAgo(30));

  insertHist.run(l2, null, 'Lead Generated', ref2.id, 'Submitted by Priya Mehta', isoAgo(120));
  insertHist.run(l2, 'Lead Generated', 'Documents Pending', fo2.id, 'Customer contacted, GST docs awaited', isoAgo(45));

  insertHist.run(l3, null, 'Lead Generated', ref1.id, 'Submitted by Kiran Joshi', isoAgo(15));
  insertHist.run(l3, 'Lead Generated', 'Lead Assigned', admin.id, 'Assigned to Amit Verma', isoAgo(4));

  insertHist.run(l4, null, 'Lead Generated', admin.id, 'Walk-in enquiry at Mumbai HQ', isoAgo(75));
  insertHist.run(l4, 'Lead Generated', 'Under Process', fo2.id, 'File logged in and under credit review', isoAgo(20));

  // Pending Duplicate Request for Admin Verification
  db.prepare(`
    INSERT INTO duplicate_requests (request_code, existing_lead_id, matched_fields_json, submitted_payload_json, submitted_by, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
  `).run(
    'DUP-0001',
    l1,
    JSON.stringify(['Mobile Number', 'PAN Card Number']),
    JSON.stringify({
      customerName: 'Ramesh C. Tiwari',
      customerMobile: '9820112233',
      panNumber: 'ABCPT1234K',
      loanProduct: 'Personal Loan',
      loanAmount: 500000,
      bankNbfc: 'ICICI Bank',
      city: 'Mumbai',
      state: 'Maharashtra',
      referralId: ref1.referral_code,
      referralName: ref1.full_name,
      remarks: 'Customer also wants top-up personal loan',
    }),
    ref1.id,
    isoAgo(25)
  );

  // One pending ₹10 penalty for verification
  db.prepare(`
    INSERT INTO penalties (penalty_code, employee_id, lead_id, penalty_type, event_at, deadline_at, actual_update_at, delay_seconds, amount, approval_status, created_at)
    VALUES (?, ?, ?, 'LEAD_ASSIGNMENT_10M', ?, ?, ?, 420, 10, 'PENDING', ?)
  `).run('PEN-0001', fo2.id, l2, isoAgo(95), isoAgo(85), isoAgo(78), isoAgo(78));

  // One active enquiry with 1-hour SLA
  const enqId = db.prepare(`
    INSERT INTO enquiries (enquiry_code, lead_id, referral_user_id, referral_code, category, description, assigned_officer_id, status, sla_deadline_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Assigned', ?, ?, ?)
  `).run(
    'ENQ-0001', l2, ref2.id, ref2.referral_code,
    'Lead Status',
    'Customer asked when the valuation team will visit the Pune property. Please confirm.',
    fo2.id, isoFuture(42), isoAgo(18), isoAgo(18)
  ).lastInsertRowid as number;

  // One GPS visit log & one completed Bike Run awaiting Admin approval
  db.prepare(`
    INSERT INTO gps_logs (employee_id, latitude, longitude, accuracy, activity_type, lead_id, customer_name, visit_notes, consent_confirmed, recorded_at)
    VALUES (?, 19.1364, 72.8296, 12.5, 'VISIT_CHECKIN', ?, 'Ramesh Chandra Tiwari', 'Collected signed loan agreement at Andheri West.', 1, ?)
  `).run(fo1.id, l1, isoAgo(140));

  db.prepare(`
    INSERT INTO bike_runs (run_code, employee_id, lead_id, customer_name, tour_reason, start_location, end_location, start_time, end_time, start_lat, start_lng, end_lat, end_lng, opening_odometer, closing_odometer, gps_distance_km, odometer_distance_km, discrepancy_km, discrepancy_flag, rate_per_km, eligible_km, gross_amount, deducted_amount, incentive_amount, approval_status, route_points_json, status)
    VALUES (?, ?, ?, 'Ramesh Chandra Tiwari', 'Loan Agreement & KYC Document Pickup', 'Mumbai HQ (19.0760, 72.8777)', 'Andheri West (19.1364, 72.8296)', ?, ?, 19.0760, 72.8777, 19.1364, 72.8296, 14250, 14268.4, 17.8, 18.4, 0.6, 0, 3.0, 17.8, 53.40, 0, 53.40, 'PENDING', ?, 'COMPLETED')
  `).run(
    'RUN-0001', fo1.id, l1, isoAgo(210), isoAgo(145),
    JSON.stringify([
      { lat: 19.076, lng: 72.8777, ts: isoAgo(210) },
      { lat: 19.105, lng: 72.852, ts: isoAgo(175) },
      { lat: 19.1364, lng: 72.8296, ts: isoAgo(145) },
    ])
  );

  // Initial Alerts for Admin & Field Officers
  createAlert({
    userId: admin.id,
    leadId: l1,
    category: 'Duplicate Lead Verification Alert',
    titleEn: 'Duplicate Lead Pending Approval',
    titleHi: 'डुप्लिकेट लीड सत्यापन लंबित',
    messageEn: 'Request DUP-0001 matched AMB-2026-0001 on Mobile Number & PAN Card.',
    messageHi: 'अनुरोध DUP-0001 मोबाइल नंबर और पैन कार्ड पर AMB-2026-0001 से मेल खाता है।',
  });
  createAlert({
    userId: admin.id,
    leadId: l2,
    category: '₹10 Penalty Alert',
    titleEn: '₹10 Assignment SLA Penalty Generated',
    titleHi: '₹10 असाइनमेंट SLA पेनल्टी उत्पन्न',
    messageEn: 'Suresh Nair missed 10-min update deadline on AMB-2026-0002 (Pending Admin Approval).',
    messageHi: 'सुरेश नायर ने AMB-2026-0002 पर 10-मिनट की समय सीमा पार की (एडमिन अनुमोदन लंबित)।',
  });
  createAlert({
    userId: fo1.id,
    leadId: l3,
    category: 'Lead Follow-up Alert',
    titleEn: 'New Lead Assigned: AMB-2026-0003',
    titleHi: 'नई लीड सौंपी गई: AMB-2026-0003',
    messageEn: 'Update status within 10 minutes to avoid ₹10 SLA penalty.',
    messageHi: '₹10 SLA पेनल्टी से बचने के लिए 10 मिनट के भीतर स्टेटस अपडेट करें।',
  });
  createAlert({
    userId: fo2.id,
    leadId: l2,
    enquiryId: enqId,
    category: 'Complaint / Enquiry Alert',
    titleEn: 'New Referral Enquiry ENQ-0001',
    titleHi: 'नई रेफरल पूछताछ ENQ-0001',
    messageEn: '1-hour SLA active: Respond to Priya Mehta enquiry on AMB-2026-0002.',
    messageHi: '1 घंटे का SLA सक्रिय: AMB-2026-0002 पर प्रिया मेहता की पूछताछ का उत्तर दें।',
  });

  if (!initialBoot) {
    logAudit(
      { id: admin.id, fullName: 'Ruchi Gupta', role: 'SUPER_ADMIN' },
      'SEED_VERIFICATION_DATA',
      'SYSTEM',
      null,
      'Loaded role-verification dataset for CRM testing.'
    );
  }
}

export function seedSalesExtensionsIfNeeded() {
  // Ensure Back Office Lead Generation Staff account (LG001) exists on existing DBs
  const lgExists = db.prepare(`SELECT id FROM users WHERE employee_code = 'LG001'`).get();
  if (!lgExists) {
    const b1 = db.prepare(`SELECT id FROM branches ORDER BY id ASC LIMIT 1`).get() as { id: number } | undefined;
    if (b1) {
      const backofficeHash = bcrypt.hashSync('Backoffice@123', 10);
      db.prepare(`
        INSERT OR IGNORE INTO users (employee_code, full_name, mobile, email, password_hash, role, branch_id, team_id, referral_code, is_active, otp_enabled, gps_consent, camera_consent)
        VALUES ('LG001', 'Sneha Tiwari', '9800000009', 'sneha.lg@ambikaassociate.in', ?, 'LEAD_GENERATOR', ?, NULL, NULL, 1, 0, 1, 1)
      `).run(backofficeHash, b1.id);
    }
  }

  // Ensure Admin-requested Branch Manager account (TLPALAKGUPTA) exists cleanly if absent
  const palakExists = db
    .prepare(`SELECT id FROM users WHERE UPPER(REPLACE(employee_code, ' ', '')) = 'TLPALAKGUPTA'`)
    .get();
  if (!palakExists) {
    const b1 = db.prepare(`SELECT id FROM branches ORDER BY id ASC LIMIT 1`).get() as { id: number } | undefined;
    const palakHash = bcrypt.hashSync('palak123', 10);
    db.prepare(`
      INSERT OR IGNORE INTO users (employee_code, full_name, mobile, email, password_hash, role, branch_id, team_id, referral_code, is_active, otp_enabled, gps_consent, camera_consent)
      VALUES ('TLPALAKGUPTA', 'Palak Gupta', '', 'tlpalakgupta@ambikaassociate.in', ?, 'BRANCH_MANAGER', ?, NULL, NULL, 1, 0, 1, 1)
    `).run(palakHash, b1?.id ?? null);
  }

  // Sync Super Admin ADM001 placeholder email to official publish/update email ambikafinance.info@gmail.com
  db.prepare(`
    UPDATE users
    SET email = 'ambikafinance.info@gmail.com'
    WHERE UPPER(employee_code) = 'ADM001' AND LOWER(email) = 'admin@ambikaassociate.in'
  `).run();

  const monthKey = new Date().toISOString().slice(0, 7);
  const targetCount = (db.prepare(`SELECT COUNT(*) as c FROM sales_targets WHERE month_key = ?`).get(monthKey) as { c: number }).c;
  if (targetCount === 0) {
    const officers = db.prepare(`SELECT id, employee_code, branch_id FROM users WHERE role = 'FIELD_OFFICER' AND is_active = 1`).all() as any[];
    const insTarget = db.prepare(`
      INSERT INTO sales_targets (month_key, user_id, branch_id, target_leads, target_amount)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const fo of officers) {
      const amt = fo.employee_code === 'FO001' ? 7500000 : fo.employee_code === 'FO002' ? 6000000 : 5000000;
      insTarget.run(monthKey, fo.id, fo.branch_id, 12, amt);
    }
    const branches = db.prepare(`SELECT id FROM branches WHERE is_active = 1`).all() as { id: number }[];
    for (const b of branches) {
      insTarget.run(monthKey, null, b.id, 30, 15000000);
    }
  }

  // Seed 1 seasoned disbursed lead (210 days ago) for Top-Up/Cross-Sell radar & 1 referral payout record
  const leadCount = (db.prepare('SELECT COUNT(*) as c FROM leads').get() as { c: number }).c;
  if (leadCount > 0) {
    const olderExists = db.prepare(`SELECT id FROM leads WHERE lead_code = 'AMB-2025-0098'`).get();
    if (!olderExists) {
      const fo1 = db.prepare(`SELECT id, branch_id FROM users WHERE employee_code = 'FO001'`).get() as any;
      const ref1 = db.prepare(`SELECT id, full_name, referral_code FROM users WHERE employee_code = 'REF001'`).get() as any;
      if (fo1 && ref1) {
        const oldDate = new Date(Date.now() - 210 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
        const insertedOld = db
          .prepare(`
            INSERT INTO leads (
              lead_code, customer_name, customer_name_norm, customer_mobile_enc, customer_mobile_hash,
              alternate_mobile_enc, pan_enc, pan_hash, dob, address_enc, city, state, pin_code,
              loan_product, loan_amount, employment_details, employment_type, existing_emi, monthly_income, bank_nbfc,
              referral_id, referral_name, created_by, assigned_officer_id, assigned_at,
              assignment_deadline_at, assignment_sla_checked, branch_id, status, last_status_at,
              remarks, customer_consent, is_test_record, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, '1984-04-10', ?, 'Mumbai', 'Maharashtra', '400069',
              'Home Loan', 3800000, 'Operations Director - Logistics Co', 'Salaried', 12000, 165000, 'HDFC Bank',
              ?, ?, ?, ?, ?, ?, 1, ?, 'Disbursed', ?, 'Seasoned home loan customer - eligible for top-up or balance transfer.', 1, 1, ?, ?)
          `)
          .run(
            'AMB-2025-0098',
            'Rajeshwar Rao',
            'RAJESHWARRAO',
            encryptPii('9820998877'),
            hashLookup('9820998877'),
            encryptPii('EFRPR7788N'),
            hashLookup('EFRPR7788N'),
            encryptPii('702 Gokuldham Tower, Andheri East'),
            ref1.referral_code,
            ref1.full_name,
            ref1.id,
            fo1.id,
            oldDate,
            oldDate,
            fo1.branch_id,
            oldDate,
            oldDate,
            oldDate
          );
        const oldId = insertedOld.lastInsertRowid as number;
        db.prepare(`
          INSERT OR IGNORE INTO referral_payouts (lead_id, referral_user_id, referral_code, loan_product, base_rate_pct, bonus_rate_pct, payout_amount, payout_status, paid_at)
          VALUES (?, ?, ?, 'Home Loan', 0.45, 0, 17100, 'PAID', ?)
        `).run(oldId, ref1.id, ref1.referral_code, oldDate);
      }
    }

    // Ensure payout record exists for AMB-2026-0001
    const l1 = db.prepare(`SELECT id, loan_product, loan_amount, referral_id, created_by FROM leads WHERE lead_code = 'AMB-2026-0001'`).get() as any;
    if (l1) {
      db.prepare(`
        INSERT OR IGNORE INTO referral_payouts (lead_id, referral_user_id, referral_code, loan_product, base_rate_pct, bonus_rate_pct, payout_amount, payout_status)
        VALUES (?, ?, ?, ?, 0.45, 0, ?, 'APPROVED')
      `).run(l1.id, l1.created_by, l1.referral_id, l1.loan_product, Math.round(Number(l1.loan_amount || 0) * 0.0045));
    }

    // Seed initial Staff Reward Points & Wrong-Lead Minus example if empty
    const rewardCount = (db.prepare(`SELECT COUNT(*) as c FROM staff_rewards`).get() as { c: number }).c;
    if (rewardCount === 0) {
      const fo1 = db.prepare(`SELECT id FROM users WHERE employee_code = 'FO001'`).get() as { id: number } | undefined;
      const fo2 = db.prepare(`SELECT id FROM users WHERE employee_code = 'FO002'`).get() as { id: number } | undefined;
      const tl1 = db.prepare(`SELECT id FROM users WHERE employee_code = 'TL001'`).get() as { id: number } | undefined;
      const adm = db.prepare(`SELECT id FROM users WHERE employee_code = 'ADM001'`).get() as { id: number } | undefined;
      const seasonedLead = db.prepare(`SELECT id, lead_code FROM leads WHERE lead_code = 'AMB-2025-0098'`).get() as { id: number; lead_code: string } | undefined;
      const lead1 = db.prepare(`SELECT id, lead_code FROM leads WHERE lead_code = 'AMB-2026-0001'`).get() as { id: number; lead_code: string } | undefined;
      const lead2 = db.prepare(`SELECT id, lead_code FROM leads WHERE lead_code = 'AMB-2026-0002'`).get() as { id: number; lead_code: string } | undefined;

      const insReward = db.prepare(`
        INSERT OR IGNORE INTO staff_rewards (reward_code, employee_id, staff_bucket, lead_id, entry_type, points_delta, amount_inr, status, reason, awarded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      `);
      if (fo1 && seasonedLead) {
        insReward.run('RWD-2026-0001', fo1.id, 'FIELD_OFFICER', seasonedLead.id, 'DOC_LOGIN_REWARD', 50, 50, 'All KYC documents complete & logged in with HDFC Bank', adm?.id ?? null);
        insReward.run('RWD-2026-0002', fo1.id, 'FIELD_OFFICER', seasonedLead.id, 'DISBURSEMENT_REWARD', 150, 150, 'Loan disbursed reward for AMB-2025-0098', adm?.id ?? null);
      }
      if (fo1 && lead1) {
        insReward.run('RWD-2026-0003', fo1.id, 'FIELD_OFFICER', lead1.id, 'DOC_LOGIN_REWARD', 50, 50, 'KYC documents verified & logged in with finance company', adm?.id ?? null);
        insReward.run('RWD-2026-0004', fo1.id, 'FIELD_OFFICER', lead1.id, 'DISBURSEMENT_REWARD', 150, 150, 'Disbursement milestone reward for AMB-2026-0001', adm?.id ?? null);
      }
      if (tl1 && lead2) {
        insReward.run('RWD-2026-0005', tl1.id, 'LEAD_GENERATOR', lead2.id, 'DOC_LOGIN_REWARD', 30, 30, 'Lead generator reward: KYC complete & case logged in', adm?.id ?? null);
      }
      if (fo2 && lead2) {
        insReward.run('RWD-2026-0006', fo2.id, 'FIELD_OFFICER', lead2.id, 'DOC_LOGIN_REWARD', 50, 50, 'Field officer reward: KYC complete & case logged in', adm?.id ?? null);
        insReward.run('RWD-2026-0007', fo2.id, 'FIELD_OFFICER', null, 'WRONG_LEAD_PENALTY', -50, -50, 'Wrong customer contact / incomplete verification captured on test intake', adm?.id ?? null);
      }
    }
  }
}

export function clearTestData(adminUser: { id: number; fullName: string; role: UserRole }) {
  db.exec(`
    DELETE FROM staff_rewards;
    DELETE FROM attendance_logs;
    DELETE FROM leave_requests;
    DELETE FROM referral_payouts;
    DELETE FROM alerts;
    DELETE FROM audit_logs;
    DELETE FROM bike_runs;
    DELETE FROM gps_logs;
    DELETE FROM enquiries;
    DELETE FROM penalties;
    DELETE FROM followup_reminders;
    DELETE FROM documents;
    DELETE FROM case_history;
    DELETE FROM duplicate_requests;
    DELETE FROM leads;
  `);
  logAudit(
    adminUser,
    'CLEAR_PRODUCTION_DATA',
    'SYSTEM',
    null,
    'Cleared all verification leads, enquiries, penalties, staff rewards, GPS logs, bike runs, payouts, and alerts for production use.'
  );
}
