import fs from 'fs';
import path from 'path';
import { createAlert, db, getSettings, getSuperAdminIds, logAudit, UPLOADS_PATH } from './db.ts';

function toSqliteUtcNow(date = new Date()): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function secondsBetween(earlierIso: string, laterIso: string): number {
  const t1 = new Date(earlierIso.replace(' ', 'T') + 'Z').getTime();
  const t2 = new Date(laterIso.replace(' ', 'T') + 'Z').getTime();
  return Math.max(0, Math.round((t2 - t1) / 1000));
}

/**
 * Automated server-side SLA processor:
 * 1. Lead Assignment 10-minute SLA -> ₹10 penalty event
 * 2. Follow-up Reminder 10-minute SLA -> ₹10 penalty event
 * 3. Referral Enquiry 1-hour (60-min) SLA -> ₹10 penalty event
 */
export function purgeExpiredFollowupRecordings(): number {
  const nowStr = toSqliteUtcNow();
  const expired = db
    .prepare(`SELECT id, recording_code, storage_path FROM followup_recordings WHERE expires_at <= ?`)
    .all(nowStr) as { id: number; recording_code: string; storage_path: string }[];

  let deletedCount = 0;
  for (const rec of expired) {
    const fullPath = path.join(UPLOADS_PATH, rec.storage_path);
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch {
      // Ignore file removal error if already absent
    }
    db.prepare('DELETE FROM followup_recordings WHERE id = ?').run(rec.id);
    logAudit(
      null,
      'FOLLOWUP_RECORDING_AUTO_DELETED',
      'RECORDING',
      rec.recording_code,
      '1-week (7-day) retention expired; follow-up call recording deleted automatically'
    );
    deletedCount++;
  }
  return deletedCount;
}

export function processSlaTimers(): { generatedPenalties: number; dispatchedReminders: number } {
  purgeExpiredFollowupRecordings();
  const nowStr = toSqliteUtcNow();
  const settings = getSettings();
  const adminIds = getSuperAdminIds();
  let generatedPenalties = 0;
  let dispatchedReminders = 0;

  // 1. Lead Assignment SLA check
  const overdueAssignments = db
    .prepare(`
      SELECT id, lead_code, assigned_officer_id, assigned_at, assignment_deadline_at, last_status_at
      FROM leads
      WHERE assigned_officer_id IS NOT NULL
        AND assignment_deadline_at IS NOT NULL
        AND assignment_sla_checked = 0
        AND assignment_deadline_at <= ?
    `)
    .all(nowStr) as {
      id: number;
      lead_code: string;
      assigned_officer_id: number;
      assigned_at: string;
      assignment_deadline_at: string;
      last_status_at: string | null;
    }[];

  for (const lead of overdueAssignments) {
    // Check if an actual status change happened by the officer after assigned_at and before deadline
    const validUpdate = db
      .prepare(`
        SELECT id, created_at FROM case_history
        WHERE lead_id = ? AND updated_by = ? AND created_at > ? AND created_at <= ?
        ORDER BY created_at ASC LIMIT 1
      `)
      .get(lead.id, lead.assigned_officer_id, lead.assigned_at, lead.assignment_deadline_at) as
      | { id: number; created_at: string }
      | undefined;

    if (validUpdate) {
      db.prepare('UPDATE leads SET assignment_sla_checked = 1 WHERE id = ?').run(lead.id);
    } else {
      const code = `PEN-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
      const delay = secondsBetween(lead.assignment_deadline_at, nowStr);
      db.prepare(`
        INSERT INTO penalties (penalty_code, employee_id, lead_id, penalty_type, event_at, deadline_at, delay_seconds, amount, approval_status)
        VALUES (?, ?, ?, 'LEAD_ASSIGNMENT_10M', ?, ?, ?, 10, 'PENDING')
      `).run(code, lead.assigned_officer_id, lead.id, lead.assigned_at, lead.assignment_deadline_at, delay);

      db.prepare('UPDATE leads SET assignment_sla_checked = 1 WHERE id = ?').run(lead.id);
      generatedPenalties++;

      const fo = db
        .prepare('SELECT full_name FROM users WHERE id = ?')
        .get(lead.assigned_officer_id) as { full_name: string } | undefined;

      createAlert({
        userId: lead.assigned_officer_id,
        leadId: lead.id,
        category: '₹10 Penalty Alert',
        titleEn: `₹10 Assignment SLA Penalty (${lead.lead_code})`,
        titleHi: `₹10 असाइनमेंट SLA पेनल्टी (${lead.lead_code})`,
        messageEn: `Lead ${lead.lead_code} was not updated within ${settings.assignmentSlaMinutes} minutes of assignment. ₹10 penalty logged (Pending Admin Approval).`,
        messageHi: `लीड ${lead.lead_code} असाइनमेंट के ${settings.assignmentSlaMinutes} मिनट के भीतर अपडेट नहीं हुई। ₹10 पेनल्टी दर्ज (एडमिन अनुमोदन लंबित)।`,
      });

      for (const admId of adminIds) {
        createAlert({
          userId: admId,
          leadId: lead.id,
          category: '₹10 Penalty Alert',
          titleEn: `₹10 Penalty: ${fo?.full_name ?? 'Field Officer'} (${lead.lead_code})`,
          titleHi: `₹10 पेनल्टी: ${fo?.full_name ?? 'फील्ड ऑफिसर'} (${lead.lead_code})`,
          messageEn: `10-min assignment SLA missed on ${lead.lead_code}. Pending your review & approval.`,
          messageHi: `${lead.lead_code} पर 10-मिनट असाइनमेंट SLA छूटा। आपके अनुमोदन हेतु लंबित।`,
        });
      }

      logAudit(
        null,
        'AUTO_PENALTY_ASSIGNMENT_10M',
        'PENALTY',
        code,
        `Generated ₹10 assignment SLA penalty for Lead ${lead.lead_code} against Officer #${lead.assigned_officer_id}`
      );
    }
  }

  // 2. Follow-up Reminder Due Dispatch (when due_at <= nowStr and alert_dispatched = 0)
  const dueReminders = db
    .prepare(`
      SELECT r.id, r.lead_id, r.assigned_officer_id, r.note, r.due_at, r.deadline_at, l.lead_code
      FROM followup_reminders r
      JOIN leads l ON l.id = r.lead_id
      WHERE r.alert_dispatched = 0 AND r.completed_at IS NULL AND r.due_at <= ?
    `)
    .all(nowStr) as {
      id: number;
      lead_id: number;
      assigned_officer_id: number;
      note: string;
      due_at: string;
      deadline_at: string;
      lead_code: string;
    }[];

  for (const rem of dueReminders) {
    db.prepare('UPDATE followup_reminders SET alert_dispatched = 1 WHERE id = ?').run(rem.id);
    dispatchedReminders++;
    createAlert({
      userId: rem.assigned_officer_id,
      leadId: rem.lead_id,
      category: 'Follow-up Reminder Alert',
      titleEn: `Follow-up Due Now: ${rem.lead_code}`,
      titleHi: `फॉलो-अप अभी देय है: ${rem.lead_code}`,
      messageEn: `${rem.note} — Update lead status within ${settings.followupSlaMinutes} minutes to avoid ₹10 follow-up penalty.`,
      messageHi: `${rem.note} — ₹10 फॉलो-अप पेनल्टी से बचने के लिए ${settings.followupSlaMinutes} मिनट में स्टेटस अपडेट करें।`,
    });
  }

  // 2b. Follow-up Reminder 10-min SLA missed
  const overdueFollowups = db
    .prepare(`
      SELECT r.id, r.lead_id, r.assigned_officer_id, r.due_at, r.deadline_at, l.lead_code
      FROM followup_reminders r
      JOIN leads l ON l.id = r.lead_id
      WHERE r.completed_at IS NULL AND r.penalty_generated = 0 AND r.deadline_at <= ?
    `)
    .all(nowStr) as {
      id: number;
      lead_id: number;
      assigned_officer_id: number;
      due_at: string;
      deadline_at: string;
      lead_code: string;
    }[];

  for (const rem of overdueFollowups) {
    const code = `PEN-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
    const delay = secondsBetween(rem.deadline_at, nowStr);
    db.prepare(`
      INSERT INTO penalties (penalty_code, employee_id, lead_id, penalty_type, event_at, deadline_at, delay_seconds, amount, approval_status)
      VALUES (?, ?, ?, 'FOLLOWUP_REMINDER_10M', ?, ?, ?, 10, 'PENDING')
    `).run(code, rem.assigned_officer_id, rem.lead_id, rem.due_at, rem.deadline_at, delay);

    db.prepare('UPDATE followup_reminders SET penalty_generated = 1 WHERE id = ?').run(rem.id);
    generatedPenalties++;

    const fo = db
      .prepare('SELECT full_name FROM users WHERE id = ?')
      .get(rem.assigned_officer_id) as { full_name: string } | undefined;

    createAlert({
      userId: rem.assigned_officer_id,
      leadId: rem.lead_id,
      category: '₹10 Penalty Alert',
      titleEn: `₹10 Follow-up SLA Penalty (${rem.lead_code})`,
      titleHi: `₹10 फॉलो-अप SLA पेनल्टी (${rem.lead_code})`,
      messageEn: `Follow-up reminder on ${rem.lead_code} exceeded the ${settings.followupSlaMinutes}-minute window. ₹10 penalty logged.`,
      messageHi: `${rem.lead_code} पर फॉलो-अप रिमाइंडर ${settings.followupSlaMinutes}-मिनट की सीमा से अधिक हो गया। ₹10 पेनल्टी दर्ज।`,
    });

    for (const admId of adminIds) {
      createAlert({
        userId: admId,
        leadId: rem.lead_id,
        category: '₹10 Penalty Alert',
        titleEn: `₹10 Follow-up Penalty: ${fo?.full_name ?? 'Field Officer'} (${rem.lead_code})`,
        titleHi: `₹10 फॉलो-अप पेनल्टी: ${fo?.full_name ?? 'फील्ड ऑफिसर'} (${rem.lead_code})`,
        messageEn: `10-min follow-up SLA missed on ${rem.lead_code}. Pending Admin approval.`,
        messageHi: `${rem.lead_code} पर 10-मिनट फॉलो-अप SLA छूटा। एडमिन अनुमोदन लंबित।`,
      });
    }

    logAudit(
      null,
      'AUTO_PENALTY_FOLLOWUP_10M',
      'PENALTY',
      code,
      `Generated ₹10 follow-up SLA penalty for Lead ${rem.lead_code} against Officer #${rem.assigned_officer_id}`
    );
  }

  // 3. Referral Enquiry 1-hour (60-min) SLA check
  const overdueEnquiries = db
    .prepare(`
      SELECT id, enquiry_code, lead_id, assigned_officer_id, created_at, sla_deadline_at
      FROM enquiries
      WHERE assigned_officer_id IS NOT NULL
        AND solution_updated_at IS NULL
        AND penalty_generated = 0
        AND status NOT IN ('Solution Updated','Resolved','Closed')
        AND sla_deadline_at <= ?
    `)
    .all(nowStr) as {
      id: number;
      enquiry_code: string;
      lead_id: number | null;
      assigned_officer_id: number;
      created_at: string;
      sla_deadline_at: string;
    }[];

  for (const enq of overdueEnquiries) {
    const code = `PEN-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
    const delay = secondsBetween(enq.sla_deadline_at, nowStr);
    db.prepare(`
      INSERT INTO penalties (penalty_code, employee_id, lead_id, enquiry_id, penalty_type, event_at, deadline_at, delay_seconds, amount, approval_status)
      VALUES (?, ?, ?, ?, 'ENQUIRY_SLA_60M', ?, ?, ?, 10, 'PENDING')
    `).run(code, enq.assigned_officer_id, enq.lead_id, enq.id, enq.created_at, enq.sla_deadline_at, delay);

    db.prepare('UPDATE enquiries SET penalty_generated = 1 WHERE id = ?').run(enq.id);
    generatedPenalties++;

    const fo = db
      .prepare('SELECT full_name FROM users WHERE id = ?')
      .get(enq.assigned_officer_id) as { full_name: string } | undefined;

    createAlert({
      userId: enq.assigned_officer_id,
      leadId: enq.lead_id,
      enquiryId: enq.id,
      category: '₹10 Penalty Alert',
      titleEn: `₹10 Enquiry SLA Penalty (${enq.enquiry_code})`,
      titleHi: `₹10 पूछताछ SLA पेनल्टी (${enq.enquiry_code})`,
      messageEn: `Enquiry ${enq.enquiry_code} was not resolved within 1 hour. ₹10 penalty logged (Pending Admin Approval).`,
      messageHi: `पूछताछ ${enq.enquiry_code} का समाधान 1 घंटे के भीतर नहीं हुआ। ₹10 पेनल्टी दर्ज (एडमिन अनुमोदन लंबित)।`,
    });

    for (const admId of adminIds) {
      createAlert({
        userId: admId,
        leadId: enq.lead_id,
        enquiryId: enq.id,
        category: '₹10 Penalty Alert',
        titleEn: `₹10 Enquiry SLA Penalty: ${fo?.full_name ?? 'Field Officer'} (${enq.enquiry_code})`,
        titleHi: `₹10 पूछताछ SLA पेनल्टी: ${fo?.full_name ?? 'फील्ड ऑफिसर'} (${enq.enquiry_code})`,
        messageEn: `1-hour enquiry SLA missed on ${enq.enquiry_code}. Pending Admin approval.`,
        messageHi: `${enq.enquiry_code} पर 1-घंटे का पूछताछ SLA छूटा। एडमिन अनुमोदन लंबित।`,
      });
    }

    logAudit(
      null,
      'AUTO_PENALTY_ENQUIRY_60M',
      'PENALTY',
      code,
      `Generated ₹10 1-hour enquiry SLA penalty for ${enq.enquiry_code} against Officer #${enq.assigned_officer_id}`
    );
  }

  return { generatedPenalties, dispatchedReminders };
}
