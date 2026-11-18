import { apiFetch } from './api';

export interface PanOcrResult {
  panNumber: string;
  customerName: string;
  fatherName: string;
  dob: string;
  rawText: string;
  engine: 'gemini-vision' | 'local-tesseract';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

const VALID_PAN_ENTITY_CHARS = new Set(['P', 'C', 'H', 'F', 'A', 'T', 'B', 'L', 'J', 'G']);

const LETTER_FIX_MAP: Record<string, string> = {
  '0': 'O',
  '1': 'I',
  '2': 'Z',
  '5': 'S',
  '6': 'G',
  '8': 'B',
  '$': 'S',
};

const DIGIT_FIX_MAP: Record<string, string> = {
  O: '0',
  D: '0',
  Q: '0',
  U: '0',
  I: '1',
  L: '1',
  Z: '2',
  S: '5',
  G: '6',
  B: '8',
  A: '4',
};

const STOPWORD_PATTERNS = [
  /INCOME\s*TAX/i,
  /GOVT\.?\s*(OF)?\s*INDIA/i,
  /GOVERNMENT\s*(OF)?\s*INDIA/i,
  /PERMANENT\s*ACCOUNT/i,
  /ACCOUNT\s*NUMBER/i,
  /NUMBER\s*CARD/i,
  /SIGNATURE/i,
  /DATE\s*OF\s*BIRTH/i,
  /FATHER/i,
  /HUSBAND/i,
  /VERIFY/i,
  /ELECTRONIC/i,
  /TAX\s*DEPARTMENT/i,
  /E-?PAN/i,
  /^PAN$/i,
  /^DOB$/i,
  /^CARD$/i,
  /^INDIA$/i,
  /^NAME$/i,
];

function toTitleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function repairPanCandidate(token: string): string | null {
  const clean = token.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 10) return null;

  const chars = clean.split('');
  for (let i = 0; i < 10; i++) {
    const ch = chars[i];
    if (i < 5 || i === 9) {
      if (/[A-Z]/.test(ch)) continue;
      if (LETTER_FIX_MAP[ch]) chars[i] = LETTER_FIX_MAP[ch];
      else return null;
    } else {
      if (/[0-9]/.test(ch)) continue;
      if (DIGIT_FIX_MAP[ch]) chars[i] = DIGIT_FIX_MAP[ch];
      else return null;
    }
  }
  const candidate = chars.join('');
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(candidate) ? candidate : null;
}

export function extractPanNumber(rawText: string): string {
  const upper = rawText.toUpperCase();
  // 1. Direct exact match (including spaced PANs like "ABCDE 1234 F")
  const compactMatches = upper.match(/[A-Z]{5}\s*[0-9]{4}\s*[A-Z]/g) || [];
  for (const m of compactMatches) {
    const cleaned = m.replace(/\s+/g, '');
    if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleaned) && VALID_PAN_ENTITY_CHARS.has(cleaned[3])) {
      return cleaned;
    }
  }
  const firstMatch = compactMatches[0];
  if (firstMatch) {
    return firstMatch.replace(/\s+/g, '');
  }

  // 2. Sliding 10-char alphanumeric token repair for noisy OCR
  const tokens = upper.replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const candidates: string[] = [];
  for (const t of tokens) {
    if (t.length === 10) candidates.push(t);
    else if (t.length > 10 && t.length <= 14) {
      for (let i = 0; i <= t.length - 10; i++) {
        candidates.push(t.slice(i, i + 10));
      }
    }
  }
  // Join adjacent short tokens (e.g. "ABCDE" + "1234F")
  for (let i = 0; i < tokens.length - 1; i++) {
    const joined2 = tokens[i] + tokens[i + 1];
    if (joined2.length === 10) candidates.push(joined2);
    if (i < tokens.length - 2) {
      const joined3 = tokens[i] + tokens[i + 1] + tokens[i + 2];
      if (joined3.length === 10) candidates.push(joined3);
    }
  }

  const repaired = candidates
    .map(repairPanCandidate)
    .filter((p): p is string => Boolean(p));

  const validEntity = repaired.find((p) => VALID_PAN_ENTITY_CHARS.has(p[3]));
  return validEntity || repaired[0] || '';
}

export function extractDobFromPanText(rawText: string): string {
  const m = rawText.match(/\b(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})\b/);
  if (!m) return '';
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1920 || year > 2025) {
    return '';
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isLikelyNameLine(line: string, panNumber: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return false;
  if (panNumber && trimmed.toUpperCase().replace(/\s+/g, '').includes(panNumber)) return false;
  if (/\d{2,}/.test(trimmed)) return false; // dates, pin codes, numbers
  if (STOPWORD_PATTERNS.some((rx) => rx.test(trimmed))) return false;

  const alphaOnly = trimmed.replace(/[^A-Za-z\s.]/g, '').trim();
  if (alphaOnly.length < 3) return false;
  const ratio = alphaOnly.length / trimmed.length;
  if (ratio < 0.72) return false;

  const words = alphaOnly.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  // Filter out 1-letter gibberish tokens
  const meaningfulWords = words.filter((w) => w.replace(/\./g, '').length >= 2);
  return meaningfulWords.length >= 1;
}

function cleanNameLine(line: string): string {
  const cleaned = line
    .replace(/^(name|naam|applicant\s*name)\s*[:\-]?\s*/i, '')
    .replace(/[^A-Za-z\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? toTitleCase(cleaned) : '';
}

export function parsePanCardText(rawText: string): Omit<PanOcrResult, 'engine'> {
  const panNumber = extractPanNumber(rawText);
  const dob = extractDobFromPanText(rawText);
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let customerName = '';
  let fatherName = '';

  // Strategy 1: Explicit "Name" / "Father's Name" labels (New Indian PAN layout)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!customerName && /\bname\b/i.test(line) && !/father|husband|account/i.test(line)) {
      const inline = cleanNameLine(line);
      if (inline.length >= 3 && !STOPWORD_PATTERNS.some((rx) => rx.test(inline))) {
        customerName = inline;
      } else if (i + 1 < lines.length && isLikelyNameLine(lines[i + 1], panNumber)) {
        customerName = cleanNameLine(lines[i + 1]);
      }
    }
    if (!fatherName && /father/i.test(line)) {
      const inline = cleanNameLine(line.replace(/father'?s?\s*name\s*[:\-]?/i, ''));
      if (inline.length >= 3 && !STOPWORD_PATTERNS.some((rx) => rx.test(inline))) {
        fatherName = inline;
      } else if (i + 1 < lines.length && isLikelyNameLine(lines[i + 1], panNumber)) {
        fatherName = cleanNameLine(lines[i + 1]);
      }
    }
  }

  // Strategy 2: Classic PAN layout (first clean uppercase candidate line after header/PAN)
  if (!customerName) {
    const candidates: string[] = [];
    for (const line of lines) {
      if (isLikelyNameLine(line, panNumber)) {
        const cleaned = cleanNameLine(line);
        if (cleaned && cleaned !== fatherName) {
          candidates.push(cleaned);
        }
      }
    }
    if (candidates.length > 0) customerName = candidates[0];
    if (!fatherName && candidates.length > 1) fatherName = candidates[1];
  }

  const confidence: PanOcrResult['confidence'] =
    panNumber && customerName ? 'HIGH' : panNumber || customerName ? 'MEDIUM' : 'LOW';

  return {
    panNumber,
    customerName,
    fatherName,
    dob,
    rawText: rawText.trim(),
    confidence,
  };
}

export async function runPanCardOcr(
  imageDataUrl: string,
  onProgress?: (pct: number, stage: string) => void
): Promise<PanOcrResult> {
  onProgress?.(12, 'Analyzing PAN card image...');

  // 1. Prefer server-side Gemini Vision OCR when online & configured
  if (typeof navigator === 'undefined' || navigator.onLine) {
    try {
      const serverRes = await apiFetch<{
        available?: boolean;
        fallbackToLocalOcr?: boolean;
        panNumber?: string;
        customerName?: string;
        fatherName?: string;
        dob?: string;
        rawText?: string;
      }>('/ocr/pan', {
        method: 'POST',
        json: { imageDataUrl },
      });

      if (serverRes.available && (serverRes.panNumber || serverRes.customerName)) {
        onProgress?.(100, 'PAN & Name extracted');
        const parsedPan = extractPanNumber(serverRes.panNumber || serverRes.rawText || '');
        const cleanName = serverRes.customerName ? toTitleCase(serverRes.customerName.trim()) : '';
        return {
          panNumber: parsedPan,
          customerName: cleanName,
          fatherName: serverRes.fatherName ? toTitleCase(serverRes.fatherName.trim()) : '',
          dob: serverRes.dob || extractDobFromPanText(serverRes.rawText || ''),
          rawText: serverRes.rawText || `${cleanName}\n${parsedPan}`,
          engine: 'gemini-vision',
          confidence: parsedPan && cleanName ? 'HIGH' : 'MEDIUM',
        };
      }
    } catch {
      // Fall back cleanly to local browser OCR
    }
  }

  // 2. Local client-side Tesseract OCR fallback (works offline & without API key)
  onProgress?.(25, 'Running on-device OCR engine...');
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    logger: (m: { status?: string; progress?: number }) => {
      if (typeof m.progress === 'number') {
        const mapped = Math.min(96, Math.max(25, Math.round(25 + m.progress * 70)));
        onProgress?.(mapped, m.status === 'recognizing text' ? 'Reading PAN & Name...' : 'Preparing OCR...');
      }
    },
  });

  try {
    const {
      data: { text },
    } = await worker.recognize(imageDataUrl);
    const parsed = parsePanCardText(text || '');
    onProgress?.(100, 'OCR complete');
    return {
      ...parsed,
      engine: 'local-tesseract',
    };
  } finally {
    await worker.terminate();
  }
}
