export interface Point2D {
  x: number; // Normalized 0..1 when in UI state, or pixels when warping
  y: number;
}

export type ScanFilterMode = 'original' | 'enhance' | 'grayscale' | 'bw';
export type CropSizePreset = 'auto' | 'a4' | 'id_card' | 'photo' | 'free';

export interface ScanAdjustments {
  brightness?: number; // -50 to +50
  contrast?: number; // 0.6 to 2.2
}

/**
 * Solves an 8x8 linear system A * x = b using Gaussian elimination with partial pivoting.
 */
function solveLinear8(A: number[][], b: number[]): number[] {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(M[r][col]);
      if (val > maxVal) {
        maxVal = val;
        pivotRow = r;
      }
    }
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) continue;

    for (let j = col; j <= n; j++) {
      M[col][j] /= pivot;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let j = col; j <= n; j++) {
        M[r][j] -= factor * M[col][j];
      }
    }
  }

  return M.map((row) => row[n]);
}

/**
 * Computes a 3x3 homography matrix mapping src[0..3] -> dst[0..3].
 */
function computeHomography(src: Point2D[], dst: Point2D[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const sx = src[i].x;
    const sy = src[i].y;
    const dx = dst[i].x;
    const dy = dst[i].y;

    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    b.push(dx);

    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }

  const h = solveLinear8(A, b);
  return [...h, 1];
}

export function smoothQuad(prev: Point2D[], next: Point2D[], alpha = 0.35): Point2D[] {
  if (prev.length !== 4 || next.length !== 4) return next;
  return next.map((p, i) => ({
    x: prev[i].x * (1 - alpha) + p.x * alpha,
    y: prev[i].y * (1 - alpha) + p.y * alpha,
  }));
}

/**
 * Measures corner movement between frames (0 = identical, higher = moving).
 */
export function quadDelta(a: Point2D[], b: Point2D[]): number {
  if (a.length !== 4 || b.length !== 4) return 1;
  let total = 0;
  for (let i = 0; i < 4; i++) {
    total += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  }
  return total / 4;
}

/**
 * Returns centered normalized quad corners matching a standard KYC document cropping size.
 */
export function getPresetQuad(
  preset: CropSizePreset,
  canvasWidth: number,
  canvasHeight: number
): Point2D[] {
  if (preset === 'free' || preset === 'auto') {
    return [
      { x: 0.08, y: 0.08 },
      { x: 0.92, y: 0.08 },
      { x: 0.92, y: 0.92 },
      { x: 0.08, y: 0.92 },
    ];
  }

  // Target width/height aspect ratio in real pixels
  const targetRatio =
    preset === 'a4'
      ? 210 / 297 // Portrait A4
      : preset === 'id_card'
      ? 85.6 / 54 // PAN / Aadhaar landscape card
      : 35 / 45; // Customer Passport Photo

  const imgRatio = canvasWidth / Math.max(1, canvasHeight);
  let normW = 0.82;
  let normH = (normW * imgRatio) / targetRatio;

  if (normH > 0.86) {
    normH = 0.86;
    normW = (normH * targetRatio) / imgRatio;
  }

  const x0 = (1 - normW) / 2;
  const y0 = (1 - normH) / 2;
  return [
    { x: x0, y: y0 },
    { x: x0 + normW, y: y0 },
    { x: x0 + normW, y: y0 + normH },
    { x: x0, y: y0 + normH },
  ];
}

export function getPresetAspectRatio(preset: CropSizePreset): number | undefined {
  if (preset === 'a4') return 210 / 297;
  if (preset === 'id_card') return 85.6 / 54;
  if (preset === 'photo') return 35 / 45;
  return undefined;
}

/**
 * Fast edge-based document quad detector on a downscaled canvas or video source.
 */
export function detectDocumentQuad(
  source: HTMLCanvasElement | HTMLVideoElement
): { quad: Point2D[]; detected: boolean } {
  const fallback: Point2D[] = [
    { x: 0.08, y: 0.08 },
    { x: 0.92, y: 0.08 },
    { x: 0.92, y: 0.92 },
    { x: 0.08, y: 0.92 },
  ];

  try {
    const srcW = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const srcH = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (!srcW || !srcH) return { quad: fallback, detected: false };

    const maxDim = 180;
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const w = Math.max(32, Math.round(srcW * scale));
    const h = Math.max(32, Math.round(srcH * scale));

    const work = document.createElement('canvas');
    work.width = w;
    work.height = h;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { quad: fallback, detected: false };
    ctx.drawImage(source, 0, 0, w, h);

    const img = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      gray[i] = 0.299 * img[idx] + 0.587 * img[idx + 1] + 0.114 * img[idx + 2];
    }

    const edges: { x: number; y: number }[] = [];
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const gx =
          gray[y * w + (x + 1)] -
          gray[y * w + (x - 1)] +
          2 * (gray[y * w + (x + 1)] - gray[y * w + (x - 1)]);
        const gy =
          gray[(y + 1) * w + x] -
          gray[(y - 1) * w + x] +
          2 * (gray[(y + 1) * w + x] - gray[(y - 1) * w + x]);
        if (Math.hypot(gx, gy) > 80) {
          edges.push({ x, y });
        }
      }
    }

    if (edges.length < 45) return { quad: fallback, detected: false };

    let minSum = Infinity,
      maxSum = -Infinity,
      minDiff = Infinity,
      maxDiff = -Infinity;
    let tl = { x: w * 0.08, y: h * 0.08 };
    let br = { x: w * 0.92, y: h * 0.92 };
    let tr = { x: w * 0.92, y: h * 0.08 };
    let bl = { x: w * 0.08, y: h * 0.92 };

    for (const p of edges) {
      const sum = p.x + p.y;
      const diff = p.x - p.y;
      if (sum < minSum) {
        minSum = sum;
        tl = p;
      }
      if (sum > maxSum) {
        maxSum = sum;
        br = p;
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        tr = p;
      }
      if (diff < minDiff) {
        minDiff = diff;
        bl = p;
      }
    }

    const quad: Point2D[] = [
      { x: Math.max(0.02, Math.min(0.48, tl.x / w)), y: Math.max(0.02, Math.min(0.48, tl.y / h)) },
      { x: Math.max(0.52, Math.min(0.98, tr.x / w)), y: Math.max(0.02, Math.min(0.48, tr.y / h)) },
      { x: Math.max(0.52, Math.min(0.98, br.x / w)), y: Math.max(0.52, Math.min(0.98, br.y / h)) },
      { x: Math.max(0.02, Math.min(0.48, bl.x / w)), y: Math.max(0.52, Math.min(0.98, bl.y / h)) },
    ];

    const area =
      0.5 *
      Math.abs(
        quad[0].x * quad[1].y -
          quad[1].x * quad[0].y +
          quad[1].x * quad[2].y -
          quad[2].x * quad[1].y +
          quad[2].x * quad[3].y -
          quad[3].x * quad[2].y +
          quad[3].x * quad[0].y -
          quad[0].x * quad[3].y
      );

    if (area < 0.16 || area > 0.96) return { quad: fallback, detected: false };
    return { quad, detected: true };
  } catch {
    return { quad: fallback, detected: false };
  }
}

/**
 * Analyzes the cropped document region's luminance histogram (2nd to 98th percentile)
 * and computes optimal Auto Brightness and Auto Contrast settings.
 */
export function computeAutoContrastAdjustments(
  sourceCanvas: HTMLCanvasElement,
  corners: Point2D[]
): { brightness: number; contrast: number } {
  const sample = warpPerspectiveDocument(sourceCanvas, corners, 'original', { maxDim: 160 });
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { brightness: 8, contrast: 1.25 };

  const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
  const hist = new Int32Array(256);
  const total = sample.width * sample.height;

  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const lum = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
    hist[Math.max(0, Math.min(255, lum))]++;
  }

  let acc = 0;
  let p2 = 20;
  let p98 = 235;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= total * 0.02) {
      p2 = i;
      break;
    }
  }
  acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= total * 0.98) {
      p98 = i;
      break;
    }
  }

  const spread = Math.max(40, p98 - p2);
  const contrast = Math.min(1.85, Math.max(1.05, Number((225 / spread).toFixed(2))));
  const mid = (p2 + p98) / 2;
  const brightness = Math.min(32, Math.max(-25, Math.round(135 - mid)));

  return { brightness, contrast };
}

/**
 * Applies O(W*H) integral-image local illumination normalization for shadow-free
 * grayscale and crisp B&W document scans.
 */
function applyAdaptiveDocumentEnhancement(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  mode: 'grayscale' | 'bw',
  brightness: number,
  contrast: number
) {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    lum[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  const integral = new Float64Array((w + 1) * (h + 1));
  const stride = w + 1;
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += lum[(y - 1) * w + (x - 1)];
      integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
    }
  }

  const radius = Math.max(12, Math.round(Math.min(w, h) * 0.06));
  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(w - 1, x + radius);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integral[(y2 + 1) * stride + (x2 + 1)] -
        integral[y1 * stride + (x2 + 1)] -
        integral[(y2 + 1) * stride + x1] +
        integral[y1 * stride + x1];
      const localMean = sum / count;
      const val = lum[y * w + x];

      const normalized = localMean > 1 ? (val / localMean) * 232 : val;
      let out = (normalized - 128) * contrast + 128 + brightness;

      if (mode === 'bw') {
        out = val < localMean * 0.87 ? Math.max(0, out * 0.55) : Math.min(255, Math.max(out, 238));
      } else {
        out = Math.min(255, Math.max(0, out));
      }

      const idx = (y * w + x) * 4;
      data[idx] = out;
      data[idx + 1] = out;
      data[idx + 2] = out;
      data[idx + 3] = 255;
    }
  }
}

/**
 * Warps a 4-corner region from sourceCanvas into a clean rectangular canvas
 * using inverse homography + bilinear interpolation, and applies scan enhancement.
 */
export function warpPerspectiveDocument(
  sourceCanvas: HTMLCanvasElement,
  normalizedCorners: Point2D[], // [TL, TR, BR, BL]
  filterMode: ScanFilterMode,
  options: { maxDim?: number; targetAspectRatio?: number; adjustments?: ScanAdjustments } = {}
): HTMLCanvasElement {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;

  const srcPts: Point2D[] = normalizedCorners.map((p) => ({
    x: Math.max(0, Math.min(sw - 1, p.x * sw)),
    y: Math.max(0, Math.min(sh - 1, p.y * sh)),
  }));

  const topW = Math.hypot(srcPts[1].x - srcPts[0].x, srcPts[1].y - srcPts[0].y);
  const botW = Math.hypot(srcPts[2].x - srcPts[3].x, srcPts[2].y - srcPts[3].y);
  const leftH = Math.hypot(srcPts[3].x - srcPts[0].x, srcPts[3].y - srcPts[0].y);
  const rightH = Math.hypot(srcPts[2].x - srcPts[1].x, srcPts[2].y - srcPts[1].y);

  let outW = Math.max(160, Math.round(Math.max(topW, botW)));
  let outH = Math.max(160, Math.round(Math.max(leftH, rightH)));

  if (options.targetAspectRatio && options.targetAspectRatio > 0) {
    if (options.targetAspectRatio >= 1) {
      outH = Math.max(120, Math.round(outW / options.targetAspectRatio));
    } else {
      outW = Math.max(120, Math.round(outH * options.targetAspectRatio));
    }
  }

  const MAX_OUT = options.maxDim ?? 1600;
  if (outW > MAX_OUT || outH > MAX_OUT) {
    const ratio = MAX_OUT / Math.max(outW, outH);
    outW = Math.max(100, Math.round(outW * ratio));
    outH = Math.max(100, Math.round(outH * ratio));
  }

  const dstPts: Point2D[] = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 },
  ];

  const invH = computeHomography(dstPts, srcPts);

  const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!srcCtx) throw new Error('Source 2D context unavailable');
  const srcData = srcCtx.getImageData(0, 0, sw, sh).data;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  if (!outCtx) throw new Error('Output 2D context unavailable');
  const outImg = outCtx.createImageData(outW, outH);
  const dstData = outImg.data;

  const brightness = options.adjustments?.brightness ?? 8;
  const contrast = options.adjustments?.contrast ?? 1.18;

  const h0 = invH[0],
    h1 = invH[1],
    h2 = invH[2];
  const h3 = invH[3],
    h4 = invH[4],
    h5 = invH[5];
  const h6 = invH[6],
    h7 = invH[7],
    h8 = invH[8];

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const denom = h6 * x + h7 * y + h8;
      const sx = (h0 * x + h1 * y + h2) / denom;
      const sy = (h3 * x + h4 * y + h5) / denom;

      const outIdx = (y * outW + x) * 4;

      if (sx < 0 || sx >= sw - 1 || sy < 0 || sy >= sh - 1) {
        dstData[outIdx] = 255;
        dstData[outIdx + 1] = 255;
        dstData[outIdx + 2] = 255;
        dstData[outIdx + 3] = 255;
        continue;
      }

      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;

      let r = srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11;
      let g =
        srcData[i00 + 1] * w00 +
        srcData[i10 + 1] * w10 +
        srcData[i01 + 1] * w01 +
        srcData[i11 + 1] * w11;
      let b =
        srcData[i00 + 2] * w00 +
        srcData[i10 + 2] * w10 +
        srcData[i01 + 2] * w01 +
        srcData[i11 + 2] * w11;

      if (filterMode === 'enhance') {
        r = Math.min(255, Math.max(0, (r - 128) * contrast + 128 + brightness));
        g = Math.min(255, Math.max(0, (g - 128) * contrast + 128 + brightness));
        b = Math.min(255, Math.max(0, (b - 128) * contrast + 128 + brightness));
      }

      dstData[outIdx] = r;
      dstData[outIdx + 1] = g;
      dstData[outIdx + 2] = b;
      dstData[outIdx + 3] = 255;
    }
  }

  if (filterMode === 'grayscale' || filterMode === 'bw') {
    applyAdaptiveDocumentEnhancement(dstData, outW, outH, filterMode, brightness, contrast);
  }

  outCtx.putImageData(outImg, 0, 0);
  return outCanvas;
}

/**
 * Rotates a canvas 90 degrees clockwise.
 */
export function rotateCanvas90(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = canvas.height;
  out.height = canvas.width;
  const ctx = out.getContext('2d');
  if (ctx) {
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  }
  return out;
}
