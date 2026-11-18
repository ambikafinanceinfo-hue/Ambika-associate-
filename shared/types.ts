export type UserRole =
  | 'SUPER_ADMIN'
  | 'BRANCH_MANAGER'
  | 'TEAM_LEADER'
  | 'LEAD_GENERATOR'
  | 'FIELD_OFFICER'
  | 'REFERRAL_PARTNER';

export const USER_ROLES: { value: UserRole; labelEn: string; labelHi: string }[] = [
  { value: 'SUPER_ADMIN', labelEn: 'Super Admin', labelHi: 'सुपर एडमिन' },
  { value: 'BRANCH_MANAGER', labelEn: 'Branch Manager (BM)', labelHi: 'शाखा प्रबंधक (BM)' },
  { value: 'TEAM_LEADER', labelEn: 'Team Leader (TL)', labelHi: 'टीम लीडर (TL)' },
  { value: 'LEAD_GENERATOR', labelEn: 'Back Office Team (Lead Gen)', labelHi: 'बैक ऑफिस टीम (लीड जनरेशन)' },
  { value: 'FIELD_OFFICER', labelEn: 'Field Officer (FO)', labelHi: 'फील्ड ऑफिसर (FO)' },
  { value: 'REFERRAL_PARTNER', labelEn: 'Referral Partner / DSA', labelHi: 'रेफरल पार्टनर / डीएसए' },
];

export const HIERARCHY_LIMITS = {
  TEAM_LEADERS_PER_BM: 10,
  FIELD_OFFICERS_PER_TL: 10,
  REFERRALS_PER_FO: 50,
} as const;

export const CASE_STATUSES = [
  'Lead Generated',
  'Lead Assigned',
  'Follow-up Pending',
  'Customer Contacted',
  'Documents Pending',
  'Documents Received',
  'Login Pending',
  'Case Logged In',
  'Under Process',
  'Query Raised',
  'Approved',
  'Rejected',
  'Disbursement Pending',
  'Disbursed',
  'Closed',
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

export const ENQUIRY_STATUSES = [
  'New',
  'Assigned',
  'In Progress',
  'Solution Updated',
  'Resolved',
  'Closed',
] as const;

export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const ENQUIRY_CATEGORIES = [
  'Lead Status',
  'Assigned Field Officer Name',
  'Assigned Field Officer Contact Number',
  'Lead Assignment',
  'Follow-up',
  'Other Lead Assistance',
] as const;

export const DOCUMENT_CATEGORIES = [
  'PAN Card',
  'Aadhaar Card',
  'Photograph',
  'Address Proof',
  'Bank Statement',
  'Salary Slip',
  'Business Proof',
  'Visit Selfie',
  'Other Loan Documents',
] as const;

export const LOST_LEAD_REASONS = [
  'High Interest Rate (ROI)',
  'Low CIBIL / Credit Score',
  'Incomplete KYC / Income Docs',
  'Competitor Bank Offer',
  'Property / Legal Valuation Issue',
  'Customer Dropped / Unreachable',
  'Other',
] as const;

export type LostLeadReason = (typeof LOST_LEAD_REASONS)[number];

export const PRODUCT_DOC_CHECKLIST: Record<string, string[]> = {
  'Home Loan': ['PAN Card', 'Aadhaar Card', 'Photograph', 'Address Proof', 'Bank Statement', 'Salary Slip'],
  'Loan Against Property (LAP)': ['PAN Card', 'Aadhaar Card', 'Photograph', 'Address Proof', 'Bank Statement', 'Business Proof'],
  'Personal Loan': ['PAN Card', 'Aadhaar Card', 'Photograph', 'Bank Statement', 'Salary Slip'],
  'Business Loan': ['PAN Card', 'Aadhaar Card', 'Photograph', 'Address Proof', 'Bank Statement', 'Business Proof'],
  'Auto / Commercial Vehicle Loan': ['PAN Card', 'Aadhaar Card', 'Photograph', 'Address Proof', 'Bank Statement'],
  'Gold / Working Capital': ['PAN Card', 'Aadhaar Card', 'Photograph', 'Address Proof'],
};

export type AlertCategory =
  | 'Lead Follow-up Alert'
  | '₹10 Penalty Alert'
  | 'Follow-up Reminder Alert'
  | 'Field Officer GPS Location Alert'
  | 'Complaint / Enquiry Alert'
  | 'Duplicate Lead Verification Alert';

export const ALERT_CATEGORIES: AlertCategory[] = [
  'Lead Follow-up Alert',
  '₹10 Penalty Alert',
  'Follow-up Reminder Alert',
  'Field Officer GPS Location Alert',
  'Complaint / Enquiry Alert',
  'Duplicate Lead Verification Alert',
];

export type PenaltyType =
  | 'LEAD_ASSIGNMENT_10M'
  | 'FOLLOWUP_REMINDER_10M'
  | 'ENQUIRY_SLA_60M';

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface AuthUser {
  id: number;
  employeeCode: string;
  fullName: string;
  mobile: string;
  email: string;
  role: UserRole;
  branchId: number | null;
  branchName: string | null;
  teamId: number | null;
  teamName: string | null;
  referralCode: string | null;
  reportsToUserId?: number | null;
  reportsToName?: string | null;
  reportsToCode?: string | null;
  isActive: boolean;
  otpEnabled: boolean;
  gpsConsent: boolean;
  cameraConsent: boolean;
  preferredLang: 'en' | 'hi';
}

export interface LeadRecord {
  id: number;
  leadCode: string;
  customerName: string;
  customerMobile: string | null;
  alternateMobile: string | null;
  panNumber: string | null;
  dob: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pinCode: string | null;
  loanProduct: string;
  loanAmount: number | null;
  employmentDetails: string | null;
  monthlyIncome: number | null;
  bankNbfc: string;
  referralId: string | null;
  referralName: string | null;
  createdBy: number;
  createdByName: string;
  createdByRole?: UserRole | null;
  createdByCode?: string | null;
  assignedBmId?: number | null;
  assignedBmName?: string | null;
  assignedBmCode?: string | null;
  assignedTlId?: number | null;
  assignedTlName?: string | null;
  assignedTlCode?: string | null;
  assignedOfficerId: number | null;
  assignedOfficerName: string | null;
  assignedOfficerCode?: string | null;
  assignedOfficerMobile: string | null;
  assignedAt: string | null;
  assignmentDeadlineAt: string | null;
  branchId: number | null;
  branchName: string | null;
  status: CaseStatus;
  lostReason?: string | null;
  existingEmi?: number | null;
  employmentType?: string | null;
  lastStatusAt: string | null;
  remarks: string | null;
  customerConsent: boolean;
  createdAt: string;
  updatedAt: string;
  redactedForReferral?: boolean;
}

export interface DuplicateRequestRecord {
  id: number;
  requestCode: string;
  existingLeadId: number;
  existingLeadCode: string;
  existingCustomerName: string;
  matchedFields: string[];
  submittedPayload: Record<string, unknown>;
  submittedBy: number;
  submittedByName: string;
  status: ApprovalStatus;
  reviewedBy: number | null;
  reviewedByName: string | null;
  reviewRemarks: string | null;
  reviewedAt: string | null;
  createdLeadId: number | null;
  createdAt: string;
}

export interface PenaltyRecord {
  id: number;
  penaltyCode: string;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  leadId: number | null;
  leadCode: string | null;
  enquiryId: number | null;
  enquiryCode: string | null;
  penaltyType: PenaltyType;
  eventAt: string;
  deadlineAt: string;
  actualUpdateAt: string | null;
  delaySeconds: number;
  amount: number;
  approvalStatus: ApprovalStatus;
  reviewedBy: number | null;
  reviewedByName: string | null;
  reviewRemarks: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface EnquiryRecord {
  id: number;
  enquiryCode: string;
  leadId: number | null;
  leadCode: string | null;
  referralUserId: number;
  referralCode: string | null;
  referralName: string;
  category: string;
  description: string;
  assignedOfficerId: number | null;
  assignedOfficerName: string | null;
  assignedOfficerMobile: string | null;
  status: EnquiryStatus;
  solutionText: string | null;
  solutionUpdatedAt: string | null;
  slaDeadlineAt: string;
  penaltyGenerated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertRecord {
  id: number;
  alertCode: string;
  userId: number;
  leadId: number | null;
  leadCode: string | null;
  enquiryId: number | null;
  enquiryCode: string | null;
  category: AlertCategory;
  titleEn: string;
  titleHi: string;
  messageEn: string;
  messageHi: string;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface LoanProductConfig {
  id: string;
  name: string;
  defaultRate: number;
  minTenureMonths: number;
  maxTenureMonths: number;
  commissionPct?: number;
}

export type RewardEntryType =
  | 'DOC_LOGIN_REWARD'
  | 'DISBURSEMENT_REWARD'
  | 'WRONG_LEAD_PENALTY';

export type RewardStaffRole = 'FIELD_OFFICER' | 'LEAD_GENERATOR';

export interface StaffRewardRecord {
  id: number;
  rewardCode: string;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  employeeRole: UserRole;
  staffBucket: RewardStaffRole;
  leadId: number | null;
  leadCode: string | null;
  customerName: string | null;
  loanProduct: string | null;
  entryType: RewardEntryType;
  pointsDelta: number;
  amountInr: number;
  status: 'ACTIVE' | 'WAIVED';
  reason: string;
  awardedBy: number | null;
  awardedByName: string | null;
  waivedByName: string | null;
  waivedAt: string | null;
  createdAt: string;
}

export interface SystemSettings {
  petrolRatePerKm: number;
  assignmentSlaMinutes: number;
  followupSlaMinutes: number;
  enquirySlaMinutes: number;
  otpRequiredGlobal: boolean;
  defaultLanguage: 'en' | 'hi';
  companyLogoDataUrl: string | null;
  loanProducts: LoanProductConfig[];
  referralBonusThreshold?: number;
  referralBonusPct?: number;
  loginRewardOfficerPts?: number;
  loginRewardGeneratorPts?: number;
  disbursementRewardOfficerPts?: number;
  disbursementRewardGeneratorPts?: number;
  wrongLeadPenaltyMin?: number;
  wrongLeadPenaltyMax?: number;
  wrongLeadPenaltyDefault?: number;
  playStoreUrl?: string | null;
  apkDownloadUrl?: string | null;
  hasUploadedApk?: boolean;
  apkFileName?: string | null;
  apkFileSize?: number | null;
  autoAssignIncomingLeads?: boolean;
  autoAssignMaxActiveLeads?: number;
  autoAssignGeoWeight?: number;
}

export interface SalesTargetRecord {
  id: number;
  monthKey: string;
  userId: number | null;
  userName?: string | null;
  employeeCode?: string | null;
  branchId: number | null;
  branchName?: string | null;
  targetLeads: number;
  targetAmount: number;
}

export interface FieldOfficerWorkload {
  id: number;
  employeeCode: string;
  fullName: string;
  mobile: string;
  role: UserRole;
  branchId: number | null;
  branchName: string | null;
  branchCity: string | null;
  branchState: string | null;
  teamId: number | null;
  serviceCity: string | null;
  servicePincodes: string | null;
  activeLeadCount: number;
  urgentPendingCount: number;
  assignedTodayCount: number;
  disbursedCount: number;
  activePipelineAmount: number;
  utilizationPct: number;
  loadStatus: 'AVAILABLE' | 'BALANCED' | 'HIGH_LOAD' | 'AT_CAPACITY';
  lastAssignedAt: string | null;
  lastGpsAt: string | null;
  lastGpsLat: number | null;
  lastGpsLng: number | null;
}

export interface LoadBalanceCandidate {
  officer: FieldOfficerWorkload;
  compositeScore: number;
  geoScore: number;
  workloadPenalty: number;
  fairnessBonus: number;
  geoTier: 'exact_pincode' | 'locality' | 'pincode_prefix' | 'city_branch' | 'state' | 'cross_region' | 'general';
  geoMatchReasons: string[];
  recommended: boolean;
}

export interface FollowupRecordingRecord {
  id: number;
  recordingCode: string;
  leadId: number;
  leadCode?: string;
  customerName?: string;
  recordedBy: number;
  recordedByName: string;
  recordedByCode: string;
  recordedByRole: UserRole;
  callNotes: string | null;
  durationSeconds: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
  canPlayOrShare: boolean;
  hasShareLink: boolean;
  shareToken: string | null;
  createdAt: string;
  expiresAt: string;
}



