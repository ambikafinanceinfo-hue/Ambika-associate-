import type { Lang } from './i18n';
import { formatInr } from './api';

export interface BankMatchRecommendation {
  bank: string;
  indicativeRate: number;
  maxFoirPct: number;
  maxEligibleAmount: number;
  estimatedEmi: number;
  fitScore: number;
  odds: 'HIGH' | 'MODERATE' | 'TIGHT';
  reason: string;
}

export interface EligibilityAssessment {
  requestedAmount: number;
  monthlyIncome: number;
  existingEmi: number;
  estimatedNewEmi: number;
  totalFoirPct: number;
  maxEligibleAmount: number;
  overallOdds: 'HIGH' | 'MODERATE' | 'TIGHT';
  recommendations: BankMatchRecommendation[];
}

interface BankPolicy {
  bank: string;
  products: string[];
  baseRateOffset: number;
  salariedFoir: number;
  selfEmployedFoir: number;
  minIncome: number;
  strength: string;
}

const BANK_POLICIES: BankPolicy[] = [
  {
    bank: 'HDFC Bank',
    products: ['Home Loan', 'Loan Against Property (LAP)', 'Personal Loan', 'Auto / Commercial Vehicle Loan'],
    baseRateOffset: 0,
    salariedFoir: 0.6,
    selfEmployedFoir: 0.55,
    minIncome: 25000,
    strength: 'Fastest digital sanction for salaried & prime residential properties',
  },
  {
    bank: 'ICICI Bank',
    products: ['Home Loan', 'Loan Against Property (LAP)', 'Personal Loan', 'Business Loan', 'Auto / Commercial Vehicle Loan'],
    baseRateOffset: 0.15,
    salariedFoir: 0.6,
    selfEmployedFoir: 0.6,
    minIncome: 25000,
    strength: 'Strong self-employed & GST surrogate underwriting',
  },
  {
    bank: 'State Bank of India (SBI)',
    products: ['Home Loan', 'Loan Against Property (LAP)', 'Auto / Commercial Vehicle Loan', 'Gold / Working Capital'],
    baseRateOffset: -0.2,
    salariedFoir: 0.55,
    selfEmployedFoir: 0.5,
    minIncome: 20000,
    strength: 'Lowest ROI & zero prepayment penalty on floating home loans',
  },
  {
    bank: 'Axis Bank',
    products: ['Home Loan', 'Loan Against Property (LAP)', 'Personal Loan', 'Business Loan'],
    baseRateOffset: 0.25,
    salariedFoir: 0.62,
    selfEmployedFoir: 0.58,
    minIncome: 22000,
    strength: 'Flexible FOIR up to 62% for higher monthly income slabs',
  },
  {
    bank: 'Bajaj Finserv',
    products: ['Personal Loan', 'Business Loan', 'Loan Against Property (LAP)', 'Gold / Working Capital'],
    baseRateOffset: 1.15,
    salariedFoir: 0.65,
    selfEmployedFoir: 0.65,
    minIncome: 20000,
    strength: '24–48 hr express turnaround & flexible flexi-OD options',
  },
  {
    bank: 'Tata Capital',
    products: ['Home Loan', 'Personal Loan', 'Business Loan', 'Loan Against Property (LAP)', 'Auto / Commercial Vehicle Loan'],
    baseRateOffset: 0.75,
    salariedFoir: 0.62,
    selfEmployedFoir: 0.6,
    minIncome: 18000,
    strength: 'Balanced approval on non-metro & mixed-income profiles',
  },
  {
    bank: 'Kotak Mahindra Bank',
    products: ['Home Loan', 'Personal Loan', 'Business Loan', 'Auto / Commercial Vehicle Loan'],
    baseRateOffset: 0.3,
    salariedFoir: 0.58,
    selfEmployedFoir: 0.55,
    minIncome: 25000,
    strength: 'Competitive balance transfer & top-up bundles',
  },
];

export function computeMonthlyEmi(principal: number, annualRatePct: number, tenureMonths: number): number {
  const P = Math.max(0, principal);
  const n = Math.max(1, Math.round(tenureMonths));
  const r = Math.max(0, annualRatePct) / 12 / 100;
  if (r === 0) return P / n;
  const factor = Math.pow(1 + r, n);
  return (P * r * factor) / (factor - 1);
}

export function maxLoanFromEmi(affordableEmi: number, annualRatePct: number, tenureMonths: number): number {
  const E = Math.max(0, affordableEmi);
  const n = Math.max(1, Math.round(tenureMonths));
  const r = Math.max(0, annualRatePct) / 12 / 100;
  if (E === 0) return 0;
  if (r === 0) return E * n;
  const factor = Math.pow(1 + r, n);
  return (E * (factor - 1)) / (r * factor);
}

export function evaluateBankEligibility(params: {
  loanProduct: string;
  requestedAmount: number;
  monthlyIncome: number;
  existingEmi?: number;
  employmentType?: string;
  baseRatePct?: number;
  tenureMonths?: number;
}): EligibilityAssessment {
  const product = params.loanProduct || 'Home Loan';
  const requestedAmount = Math.max(0, Number(params.requestedAmount) || 0);
  const monthlyIncome = Math.max(0, Number(params.monthlyIncome) || 0);
  const existingEmi = Math.max(0, Number(params.existingEmi) || 0);
  const isSelfEmployed = (params.employmentType || '').toLowerCase().includes('self') ||
    (params.employmentType || '').toLowerCase().includes('business');

  const defaultTenure =
    product.includes('Home') ? 240 : product.includes('LAP') ? 180 : product.includes('Auto') ? 60 : 48;
  const tenureMonths = params.tenureMonths || defaultTenure;

  const defaultBaseRate =
    params.baseRatePct ||
    (product.includes('Home')
      ? 8.65
      : product.includes('LAP')
      ? 9.75
      : product.includes('Auto')
      ? 9.25
      : product.includes('Personal')
      ? 11.25
      : product.includes('Business')
      ? 14.5
      : 10.5);

  const estimatedNewEmi = Math.round(computeMonthlyEmi(requestedAmount, defaultBaseRate, tenureMonths));
  const totalFoirPct = monthlyIncome > 0 ? Math.round(((existingEmi + estimatedNewEmi) / monthlyIncome) * 100) : 0;

  const recommendations: BankMatchRecommendation[] = BANK_POLICIES.filter((bp) =>
    bp.products.some((p) => p === product || product.includes(p.split(' ')[0]))
  )
    .map((bp) => {
      const foirCap = isSelfEmployed ? bp.selfEmployedFoir : bp.salariedFoir;
      const indicativeRate = Number(Math.max(7.5, defaultBaseRate + bp.baseRateOffset).toFixed(2));
      const availableForNewEmi = Math.max(0, monthlyIncome * foirCap - existingEmi);
      const maxEligibleAmount = Math.round(maxLoanFromEmi(availableForNewEmi, indicativeRate, tenureMonths));
      const bankEmi = Math.round(computeMonthlyEmi(requestedAmount, indicativeRate, tenureMonths));

      let fitScore = 50;
      if (monthlyIncome >= bp.minIncome) fitScore += 15;
      if (maxEligibleAmount >= requestedAmount && requestedAmount > 0) fitScore += 25;
      else if (maxEligibleAmount >= requestedAmount * 0.8) fitScore += 10;
      else fitScore -= 15;

      if (bp.baseRateOffset <= 0.25) fitScore += 10;
      if (isSelfEmployed && bp.selfEmployedFoir >= 0.58) fitScore += 8;

      const odds: 'HIGH' | 'MODERATE' | 'TIGHT' =
        monthlyIncome > 0 && maxEligibleAmount >= requestedAmount
          ? 'HIGH'
          : maxEligibleAmount >= requestedAmount * 0.75
          ? 'MODERATE'
          : 'TIGHT';

      return {
        bank: bp.bank,
        indicativeRate,
        maxFoirPct: Math.round(foirCap * 100),
        maxEligibleAmount,
        estimatedEmi: bankEmi,
        fitScore,
        odds,
        reason: bp.strength,
      };
    })
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, 3);

  const bestMax = recommendations[0]?.maxEligibleAmount ?? 0;
  const overallOdds: 'HIGH' | 'MODERATE' | 'TIGHT' =
    monthlyIncome <= 0 || requestedAmount <= 0
      ? 'MODERATE'
      : bestMax >= requestedAmount
      ? 'HIGH'
      : bestMax >= requestedAmount * 0.75
      ? 'MODERATE'
      : 'TIGHT';

  return {
    requestedAmount,
    monthlyIncome,
    existingEmi,
    estimatedNewEmi,
    totalFoirPct,
    maxEligibleAmount: bestMax,
    overallOdds,
    recommendations,
  };
}

export function buildQuoteText(params: {
  lang: Lang;
  customerName?: string;
  loanProduct: string;
  bankNbfc?: string;
  loanAmount: number;
  ratePct: number;
  tenureMonths: number;
  emi: number;
  totalInterest?: number;
  leadCode?: string;
}): string {
  const amt = formatInr(params.loanAmount);
  const emi = formatInr(Math.round(params.emi));
  const yrs = (params.tenureMonths / 12).toFixed(1);

  if (params.lang === 'hi') {
    return [
      `*AMBIKA ASSOCIATE — स्मार्ट फाइनेंस स्मार्ट सेविंग*`,
      params.customerName ? `ग्राहक: ${params.customerName}` : '',
      params.leadCode ? `लीड आईडी: ${params.leadCode}` : '',
      `लोन उत्पाद: ${params.loanProduct}`,
      params.bankNbfc ? `प्रस्तावित बैंक/NBFC: ${params.bankNbfc}` : '',
      `लोन राशि: ${amt}`,
      `ब्याज दर: ${params.ratePct}% वार्षिक · अवधि: ${params.tenureMonths} माह (${yrs} वर्ष)`,
      `*अनुमानित मासिक EMI: ${emi}*`,
      params.totalInterest ? `कुल ब्याज: ${formatInr(Math.round(params.totalInterest))}` : '',
      `तुरंत लोन प्रोसेसिंग के लिए कृपया अपने KYC दस्तावेज़ साझा करें।`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    `*AMBIKA ASSOCIATE — SMART FINANCE SMART SAVING*`,
    params.customerName ? `Customer: ${params.customerName}` : '',
    params.leadCode ? `Reference ID: ${params.leadCode}` : '',
    `Loan Product: ${params.loanProduct}`,
    params.bankNbfc ? `Recommended Bank/NBFC: ${params.bankNbfc}` : '',
    `Loan Amount: ${amt}`,
    `Interest Rate: ${params.ratePct}% p.a. · Tenure: ${params.tenureMonths} months (${yrs} yrs)`,
    `*Estimated Monthly EMI: ${emi}*`,
    params.totalInterest ? `Total Interest Outgo: ${formatInr(Math.round(params.totalInterest))}` : '',
    `Reply to proceed with fast digital sanction & doorstep KYC pickup.`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildMissingDocReminder(params: {
  lang: Lang;
  customerName: string;
  leadCode: string;
  loanProduct: string;
  missingDocs: string[];
}): string {
  const docs = params.missingDocs.join(', ');
  if (params.lang === 'hi') {
    return `नमस्ते ${params.customerName} जी,\nAMBIKA ASSOCIATE से आपके ${params.loanProduct} आवेदन (${params.leadCode}) को बैंक में लॉग-इन करने के लिए कृपया ये लंबित दस्तावेज़ साझा करें:\n• ${params.missingDocs.join('\n• ')}\nदस्तावेज़ मिलते ही आपका लोन प्रोसेस तेज़ी से आगे बढ़ाया जाएगा।`;
  }
  return `Hello ${params.customerName},\nTo submit your ${params.loanProduct} application (${params.leadCode}) with AMBIKA ASSOCIATE for faster sanction, please share the following pending KYC documents:\n- ${docs}\nOur field officer can also collect/scan them at your doorstep.`;
}

export function downloadQuoteCardPng(params: {
  customerName?: string;
  loanProduct: string;
  bankNbfc?: string;
  loanAmount: number;
  ratePct: number;
  tenureMonths: number;
  emi: number;
  totalInterest: number;
}) {
  const canvas = document.createElement('canvas');
  canvas.width = 880;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Top Navy Header
  ctx.fillStyle = '#0F2744';
  ctx.fillRect(0, 0, canvas.width, 108);

  // Orange & Green brand bars
  ctx.fillStyle = '#EA580C';
  ctx.fillRect(0, 108, canvas.width * 0.65, 6);
  ctx.fillStyle = '#15803D';
  ctx.fillRect(canvas.width * 0.65, 108, canvas.width * 0.35, 6);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 28px Inter, system-ui, sans-serif';
  ctx.fillText('AMBIKA ASSOCIATE', 40, 52);

  ctx.fillStyle = '#FACC15';
  ctx.font = 'bold 14px Inter, system-ui, sans-serif';
  ctx.fillText('SMART FINANCE SMART SAVING · LOAN QUOTE ESTIMATE', 40, 82);

  // Customer & Product Title
  ctx.fillStyle = '#0F2744';
  ctx.font = 'bold 24px Inter, system-ui, sans-serif';
  ctx.fillText(
    params.customerName ? `Prepared for ${params.customerName}` : `${params.loanProduct} Quote`,
    40,
    162
  );

  ctx.fillStyle = '#475569';
  ctx.font = '16px Inter, system-ui, sans-serif';
  ctx.fillText(
    `${params.loanProduct}${params.bankNbfc ? ` · ${params.bankNbfc}` : ''}`,
    40,
    192
  );

  // Highlight EMI Box
  ctx.fillStyle = '#F8FAFC';
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 2;
  ctx.fillRect(40, 220, 800, 165);
  ctx.strokeRect(40, 220, 800, 165);

  ctx.fillStyle = '#64748B';
  ctx.font = 'bold 14px Inter, system-ui, sans-serif';
  ctx.fillText('ESTIMATED MONTHLY EMI', 70, 258);

  ctx.fillStyle = '#EA580C';
  ctx.font = 'bold 42px Inter, system-ui, sans-serif';
  ctx.fillText(formatInr(Math.round(params.emi)), 70, 312);

  ctx.fillStyle = '#0F2744';
  ctx.font = 'bold 16px Inter, system-ui, sans-serif';
  ctx.fillText(`Loan Amount: ${formatInr(params.loanAmount)}`, 440, 266);
  ctx.fillText(`Interest Rate: ${params.ratePct}% p.a.`, 440, 302);
  ctx.fillText(`Tenure: ${params.tenureMonths} months (${(params.tenureMonths / 12).toFixed(1)} yrs)`, 440, 338);
  ctx.fillStyle = '#15803D';
  ctx.fillText(`Total Interest: ${formatInr(Math.round(params.totalInterest))}`, 440, 370);

  // Footer
  ctx.fillStyle = '#64748B';
  ctx.font = '13px Inter, system-ui, sans-serif';
  ctx.fillText(
    'Indicative quote subject to final bank/NBFC underwriting & KYC verification · AMBIKA ASSOCIATE',
    40,
    438
  );

  const link = document.createElement('a');
  link.download = `AMBIKA_Quote_${params.loanProduct.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
