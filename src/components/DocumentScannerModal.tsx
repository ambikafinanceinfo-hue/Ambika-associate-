import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  Check,
  Crop,
  Download,
  Loader2,
  RefreshCw,
  RotateCw,
  ScanLine,
  SlidersHorizontal,
  Sparkles,
  Square,
  SwitchCamera,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import { DOCUMENT_CATEGORIES } from '../../shared/types';
import { runPanCardOcr, type PanOcrResult } from '../lib/panOcr';
import {
  computeAutoContrastAdjustments,
  detectDocumentQuad,
  getPresetAspectRatio,
  getPresetQuad,
  quadDelta,
  rotateCanvas90,
  smoothQuad,
  warpPerspectiveDocument,
  type CropSizePreset,
  type Point2D,
  type ScanFilterMode,
} from '../lib/perspectiveWarp';

interface DocumentScannerModalProps {
  leadCode: string;
  initialCategory: string;
  autoStart?: boolean;
  embedded?: boolean;
  allowUpload?: boolean;
  onClose: () => void;
  onUploadScanned: (payload: {
    category: string;
    fileName: string;
    mimeType: string;
    dataBase64: string;
  }) => Promise<void>;
  onPrefillLead?: (data: {
    customerName: string;
    panNumber: string;
    dob?: string;
    scannedDoc: {
      category: string;
      fileName: string;
      mimeType: string;
      dataBase64: string;
    };
  }) => void;
}

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'];

const DEFAULT_QUAD: Point2D[] = [
  { x: 0.08, y: 0.08 },
  { x: 0.92, y: 0.08 },
  { x: 0.92, y: 0.92 },
  { x: 0.08, y: 0.92 },
];

const CROP_PRESETS: { id: CropSizePreset; label: string; ratioHint: string }[] = [
  { id: 'auto', label: 'Auto Detect', ratioHint: 'Edge Lock' },
  { id: 'id_card', label: 'PAN / ID Card', ratioHint: '85.6×54mm' },
  { id: 'a4', label: 'A4 Document', ratioHint: '210×297mm' },
  { id: 'photo', label: 'Passport Photo', ratioHint: '35×45mm' },
  { id: 'free', label: 'Freeform', ratioHint: 'Custom' },
];

const OUTPUT_RESOLUTIONS: { maxDim: number; label: string }[] = [
  { maxDim: 900, label: 'Compact (900px)' },
  { maxDim: 1200, label: 'Standard (1200px)' },
  { maxDim: 1600, label: 'HD (1600px)' },
];

const AUTO_SCAN_FRAMES_REQUIRED = 4;

export const DocumentScannerModal: React.FC<DocumentScannerModalProps> = ({
  leadCode,
  initialCategory,
  autoStart = false,
  embedded = false,
  allowUpload = true,
  onClose,
  onUploadScanned,
  onPrefillLead,
}) => {
  const [step, setStep] = useState<'capture' | 'edit'>('capture');
  const [category, setCategory] = useState(initialCategory || DOCUMENT_CATEGORIES[0]);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Live viewfinder edge detection & auto-scanning
  const [autoScan, setAutoScan] = useState(true);
  const [liveQuad, setLiveQuad] = useState<Point2D[]>(DEFAULT_QUAD);
  const [liveEdgeLocked, setLiveEdgeLocked] = useState(false);
  const [autoScanProgress, setAutoScanProgress] = useState(0);
  const stableQuadRef = useRef<Point2D[]>(DEFAULT_QUAD);
  const stableCountRef = useRef(0);
  const autoSnappedRef = useRef(false);

  // Captured image & real-time perspective editing state
  const [sourceCanvas, setSourceCanvas] = useState<HTMLCanvasElement | null>(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState<string | null>(null);
  const [corners, setCorners] = useState<Point2D[]>(DEFAULT_QUAD);
  const [cropPreset, setCropPreset] = useState<CropSizePreset>('auto');
  const [outputMaxDim, setOutputMaxDim] = useState<number>(1200);
  const [outputDimensions, setOutputDimensions] = useState<{ w: number; h: number } | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const cropContainerRef = useRef<HTMLDivElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const livePreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Enhancement & Contrast Auto Mode
  const [filterMode, setFilterMode] = useState<ScanFilterMode>('grayscale');
  const [autoContrastMode, setAutoContrastMode] = useState(true);
  const [brightness, setBrightness] = useState(8);
  const [contrast, setContrast] = useState(1.22);
  const [fileName, setFileName] = useState(`${leadCode}_scan.jpg`);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // PAN Card OCR State
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStage, setOcrStage] = useState('');
  const [ocrResult, setOcrResult] = useState<PanOcrResult | null>(null);
  const [ocrPanNumber, setOcrPanNumber] = useState('');
  const [ocrCustomerName, setOcrCustomerName] = useState('');
  const [ocrDob, setOcrDob] = useState('');
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [showRawOcr, setShowRawOcr] = useState(false);
  const lastOcrSourceKeyRef = useRef<string | null>(null);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    stableCountRef.current = 0;
    autoSnappedRef.current = false;
    setAutoScanProgress(0);
    setLiveEdgeLocked(false);
    setCameraStarting(false);
    setCameraReady(false);
  };

  const startCamera = async (overrideFacing?: 'environment' | 'user') => {
    const targetFacing = overrideFacing ?? facingMode;
    stopCamera();
    setCameraError(null);
    setCameraStarting(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraStarting(false);
      setCameraError(
        'Live camera stream unavailable in this browser. Use "Camera App / Photo File" below to capture and perspective-crop.'
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: targetFacing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraReady(true);
    } catch {
      setCameraError(
        'Camera access was denied or no webcam was found. Use "Camera App / Photo File" to take or pick a photo for perspective cropping and contrast enhancement.'
      );
    } finally {
      setCameraStarting(false);
    }
  };

  useEffect(() => {
    if (step !== 'capture') {
      stopCamera();
    } else if (autoStart) {
      startCamera();
    }
    return () => stopCamera();
  }, [step, autoStart]);

  const computeEstimatedDimensions = (
    canvas: HTMLCanvasElement,
    pts: Point2D[],
    preset: CropSizePreset,
    maxDim: number
  ) => {
    const sw = canvas.width;
    const sh = canvas.height;
    const srcPts = pts.map((p) => ({ x: p.x * sw, y: p.y * sh }));
    const topW = Math.hypot(srcPts[1].x - srcPts[0].x, srcPts[1].y - srcPts[0].y);
    const botW = Math.hypot(srcPts[2].x - srcPts[3].x, srcPts[2].y - srcPts[3].y);
    const leftH = Math.hypot(srcPts[3].x - srcPts[0].x, srcPts[3].y - srcPts[0].y);
    const rightH = Math.hypot(srcPts[2].x - srcPts[1].x, srcPts[2].y - srcPts[1].y);

    let outW = Math.max(160, Math.round(Math.max(topW, botW)));
    let outH = Math.max(160, Math.round(Math.max(leftH, rightH)));
    const targetRatio = getPresetAspectRatio(preset);
    if (targetRatio && targetRatio > 0) {
      if (targetRatio >= 1) {
        outH = Math.max(120, Math.round(outW / targetRatio));
      } else {
        outW = Math.max(120, Math.round(outH * targetRatio));
      }
    }
    if (outW > maxDim || outH > maxDim) {
      const scale = maxDim / Math.max(outW, outH);
      outW = Math.max(100, Math.round(outW * scale));
      outH = Math.max(100, Math.round(outH * scale));
    }
    return { w: outW, h: outH };
  };

  const applyAutoContrast = (canvas: HTMLCanvasElement, quad: Point2D[]) => {
    const auto = computeAutoContrastAdjustments(canvas, quad);
    setBrightness(auto.brightness);
    setContrast(auto.contrast);
  };

  const loadCanvasIntoEditor = (
    canvas: HTMLCanvasElement,
    initialQuad?: Point2D[],
    initialPreset: CropSizePreset = 'auto'
  ) => {
    const maxDim = 1600;
    let target = canvas;
    if (canvas.width > maxDim || canvas.height > maxDim) {
      const scale = maxDim / Math.max(canvas.width, canvas.height);
      const resized = document.createElement('canvas');
      resized.width = Math.round(canvas.width * scale);
      resized.height = Math.round(canvas.height * scale);
      const rCtx = resized.getContext('2d');
      rCtx?.drawImage(canvas, 0, 0, resized.width, resized.height);
      target = resized;
    }

    const quadToUse = initialQuad ?? detectDocumentQuad(target).quad;
    lastOcrSourceKeyRef.current = null;
    setOcrResult(null);
    setOcrError(null);
    setOcrPanNumber('');
    setOcrCustomerName('');
    setOcrDob('');
    setSourceCanvas(target);
    setSourcePreviewUrl(target.toDataURL('image/jpeg', 0.92));
    setCropPreset(initialPreset);
    setCorners(quadToUse);
    if (autoContrastMode) {
      applyAutoContrast(target, quadToUse);
    }
    setStep('edit');
  };

  const handleSnapFromVideo = (overrideQuad?: Point2D[]) => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const quadForEdit = overrideQuad ?? (liveEdgeLocked ? liveQuad : undefined);
    loadCanvasIntoEditor(canvas, quadForEdit, 'auto');
  };

  // Real-time edge detection + Auto Scan trigger while live camera stream is active
  useEffect(() => {
    if (step !== 'capture' || !cameraReady) return;
    let cancelled = false;
    let timerId: number | null = null;
    autoSnappedRef.current = false;
    stableCountRef.current = 0;

    const tick = () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (video && video.videoWidth > 0) {
        const { quad, detected } = detectDocumentQuad(video);
        setLiveEdgeLocked(detected);

        if (detected) {
          let smoothed = quad;
          setLiveQuad((prev) => {
            smoothed = smoothQuad(prev, quad, 0.35);
            return smoothed;
          });

          if (autoScan && !autoSnappedRef.current) {
            const delta = quadDelta(stableQuadRef.current, quad);
            stableQuadRef.current = quad;
            if (delta < 0.018) {
              stableCountRef.current += 1;
            } else {
              stableCountRef.current = 1;
            }
            setAutoScanProgress(Math.min(AUTO_SCAN_FRAMES_REQUIRED, stableCountRef.current));

            if (stableCountRef.current >= AUTO_SCAN_FRAMES_REQUIRED) {
              autoSnappedRef.current = true;
              handleSnapFromVideo(quad);
              return;
            }
          } else {
            stableCountRef.current = 0;
            setAutoScanProgress(0);
          }
        } else {
          setLiveQuad(DEFAULT_QUAD);
          stableCountRef.current = 0;
          setAutoScanProgress(0);
        }
      }
      timerId = window.setTimeout(() => requestAnimationFrame(tick), 150);
    };

    timerId = window.setTimeout(() => requestAnimationFrame(tick), 150);
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [step, cameraReady, autoScan]);

  // Real-time warped + grayscale/filter preview canvas in edit mode
  useEffect(() => {
    if (step !== 'edit' || !sourceCanvas || !livePreviewCanvasRef.current) return;
    setOutputDimensions(computeEstimatedDimensions(sourceCanvas, corners, cropPreset, outputMaxDim));

    const raf = requestAnimationFrame(() => {
      const previewCanvas = livePreviewCanvasRef.current;
      if (!previewCanvas) return;
      const warped = warpPerspectiveDocument(sourceCanvas, corners, filterMode, {
        maxDim: 480,
        targetAspectRatio: getPresetAspectRatio(cropPreset),
        adjustments: { brightness, contrast },
      });
      previewCanvas.width = warped.width;
      previewCanvas.height = warped.height;
      const ctx = previewCanvas.getContext('2d');
      ctx?.drawImage(warped, 0, 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [step, sourceCanvas, corners, cropPreset, outputMaxDim, filterMode, brightness, contrast]);

  // Real-time zoom loupe when dragging a corner handle
  useEffect(() => {
    if (draggingIndex === null || !sourceCanvas || !loupeCanvasRef.current) return;
    const loupe = loupeCanvasRef.current;
    const ctx = loupe.getContext('2d');
    if (!ctx) return;

    const pt = corners[draggingIndex];
    const cx = pt.x * sourceCanvas.width;
    const cy = pt.y * sourceCanvas.height;
    const sampleRadius = Math.max(40, Math.min(sourceCanvas.width, sourceCanvas.height) * 0.08);

    ctx.fillStyle = '#0F2744';
    ctx.fillRect(0, 0, loupe.width, loupe.height);
    ctx.drawImage(
      sourceCanvas,
      cx - sampleRadius,
      cy - sampleRadius,
      sampleRadius * 2,
      sampleRadius * 2,
      0,
      0,
      loupe.width,
      loupe.height
    );

    ctx.strokeStyle = '#EA580C';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(loupe.width / 2, 0);
    ctx.lineTo(loupe.width / 2, loupe.height);
    ctx.moveTo(0, loupe.height / 2);
    ctx.lineTo(loupe.width, loupe.height / 2);
    ctx.stroke();
  }, [draggingIndex, corners, sourceCanvas]);

  const handleImageFileSelected = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0);
        const cleanBase = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
        setFileName(`${leadCode}_${cleanBase || 'scan'}.jpg`);
        loadCanvasIntoEditor(canvas);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleSelectCropPreset = (preset: CropSizePreset) => {
    if (!sourceCanvas) return;
    setCropPreset(preset);
    const nextQuad =
      preset === 'auto'
        ? detectDocumentQuad(sourceCanvas).quad
        : getPresetQuad(preset, sourceCanvas.width, sourceCanvas.height);
    setCorners(nextQuad);
    if (autoContrastMode) {
      applyAutoContrast(sourceCanvas, nextQuad);
    }
  };

  const handleRotateSource = () => {
    if (!sourceCanvas) return;
    const rotated = rotateCanvas90(sourceCanvas);
    loadCanvasIntoEditor(rotated, undefined, cropPreset);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingIndex === null || !cropContainerRef.current) return;
    const rect = cropContainerRef.current.getBoundingClientRect();
    const nx = Math.max(0.01, Math.min(0.99, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0.01, Math.min(0.99, (e.clientY - rect.top) / rect.height));
    setCorners((prev) => prev.map((pt, idx) => (idx === draggingIndex ? { x: nx, y: ny } : pt)));
  };

  const handlePointerFinish = () => {
    if (draggingIndex === null) return;
    setDraggingIndex(null);
    if (sourceCanvas && autoContrastMode) {
      applyAutoContrast(sourceCanvas, corners);
    }
  };

  const handleToggleAutoContrast = () => {
    const next = !autoContrastMode;
    setAutoContrastMode(next);
    if (next && sourceCanvas) {
      applyAutoContrast(sourceCanvas, corners);
    }
  };

  const handleDownloadScan = () => {
    if (!sourceCanvas) return;
    const highRes = warpPerspectiveDocument(sourceCanvas, corners, filterMode, {
      maxDim: outputMaxDim,
      targetAspectRatio: getPresetAspectRatio(cropPreset),
      adjustments: { brightness, contrast },
    });
    const link = document.createElement('a');
    link.href = highRes.toDataURL('image/jpeg', 0.92);
    link.download = fileName.trim() || `${leadCode}_scan.jpg`;
    link.click();
  };

  const runOcrOnCurrentScan = async () => {
    if (!sourceCanvas || ocrRunning) return;
    setOcrRunning(true);
    setOcrError(null);
    setOcrProgress(10);
    setOcrStage('Preparing cropped PAN scan...');
    try {
      const ocrCanvas = warpPerspectiveDocument(sourceCanvas, corners, filterMode === 'bw' ? 'grayscale' : filterMode, {
        maxDim: 1200,
        targetAspectRatio: getPresetAspectRatio(cropPreset),
        adjustments: { brightness, contrast },
      });
      const dataUrl = ocrCanvas.toDataURL('image/jpeg', 0.92);
      const res = await runPanCardOcr(dataUrl, (pct, stage) => {
        setOcrProgress(pct);
        setOcrStage(stage);
      });
      setOcrResult(res);
      setOcrPanNumber(res.panNumber || '');
      setOcrCustomerName(res.customerName || '');
      setOcrDob(res.dob || '');
    } catch (err: any) {
      setOcrError(err?.message || 'Could not parse PAN details. You can adjust crop corners or enter fields manually.');
    } finally {
      setOcrRunning(false);
    }
  };

  // Auto-run PAN OCR once when entering edit mode with PAN Card category
  useEffect(() => {
    if (step !== 'edit' || !sourceCanvas || category !== 'PAN Card') return;
    const key = `${sourcePreviewUrl?.slice(0, 80)}_${category}`;
    if (lastOcrSourceKeyRef.current === key) return;
    lastOcrSourceKeyRef.current = key;
    const timer = window.setTimeout(() => {
      runOcrOnCurrentScan();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [step, sourceCanvas, sourcePreviewUrl, category]);

  const handleApplyOcrToLeadForm = () => {
    if (!sourceCanvas || !onPrefillLead) return;
    const highRes = warpPerspectiveDocument(sourceCanvas, corners, filterMode, {
      maxDim: outputMaxDim,
      targetAspectRatio: getPresetAspectRatio(cropPreset),
      adjustments: { brightness, contrast },
    });
    const cleanPan = ocrPanNumber.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    onPrefillLead({
      customerName: ocrCustomerName.trim(),
      panNumber: cleanPan,
      dob: ocrDob.trim() || undefined,
      scannedDoc: {
        category: category || 'PAN Card',
        fileName: fileName.trim() || `${cleanPan || leadCode}_pan.jpg`,
        mimeType: 'image/jpeg',
        dataBase64: highRes.toDataURL('image/jpeg', 0.9),
      },
    });
  };

  const handleConfirmUpload = async () => {
    if (!sourceCanvas) return;
    setUploading(true);
    setUploadError(null);
    try {
      const highRes = warpPerspectiveDocument(sourceCanvas, corners, filterMode, {
        maxDim: outputMaxDim,
        targetAspectRatio: getPresetAspectRatio(cropPreset),
        adjustments: { brightness, contrast },
      });
      const dataBase64 = highRes.toDataURL('image/jpeg', 0.9);
      await onUploadScanned({
        category,
        fileName: fileName.trim() || `${leadCode}_scan.jpg`,
        mimeType: 'image/jpeg',
        dataBase64,
      });
      onClose();
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const scannerBody = (
    <>
      {!embedded && (
        <div className="px-5 py-3.5 bg-[#0F2744] text-white flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => {
                if (step === 'edit') {
                  setStep('capture');
                } else {
                  stopCamera();
                  onClose();
                }
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold text-white shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back
            </button>
            <div className="w-9 h-9 rounded-lg bg-[#EA580C] flex items-center justify-center shrink-0">
              <Camera className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-display font-bold truncate">
                Document Scanner · {leadCode}
              </div>
              <div className="text-[11px] text-slate-300 truncate">
                {step === 'capture'
                  ? 'Clean KYC Scan (No Location / Date Stamp) · Auto-Scan Edge Detection'
                  : 'Cropping Size, Perspective Warp & Auto Contrast Mode (Clean Document)'}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              onClose();
            }}
            className="p-1.5 rounded-lg hover:bg-white/10 text-white shrink-0"
            aria-label="Close scanner"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

        {/* Category & Auto Scan Status Bar */}
        <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-slate-700 whitespace-nowrap">KYC Category:</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-medium text-[#0F2744]"
            >
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {step === 'capture' && (
              <button
                type="button"
                onClick={() => setAutoScan((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  autoScan
                    ? 'bg-[#15803D] border-[#15803D] text-white'
                    : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <ScanLine className="w-3.5 h-3.5" />
                Auto Scan: {autoScan ? 'ON' : 'OFF'}
              </button>
            )}
            <div className="text-xs text-slate-600 font-medium">
              {step === 'capture'
                ? cameraReady
                  ? liveEdgeLocked
                    ? autoScan && autoScanProgress > 0
                      ? `Steady edge lock · Auto scanning (${autoScanProgress}/${AUTO_SCAN_FRAMES_REQUIRED})`
                      : 'Document edges detected · Ready to capture'
                    : 'Scanning frame for document edges...'
                  : 'Click Start Camera or pick a photo to scan'
                : 'Drag corners, choose Cropping Size & Contrast Mode'}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {step === 'capture' && (
            <div className="space-y-4">
              {cameraError && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                  {cameraError}
                </div>
              )}

              <div className="relative bg-slate-950 rounded-xl overflow-hidden aspect-[4/3] max-h-[54vh] mx-auto flex items-center justify-center border border-slate-800">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className={`w-full h-full object-cover ${cameraReady ? 'opacity-100' : 'opacity-0'}`}
                />

                {cameraReady && (
                  <svg
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    className="pointer-events-none absolute inset-0 w-full h-full"
                  >
                    <polygon
                      points={liveQuad.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                      fill={liveEdgeLocked ? 'rgba(21, 128, 61, 0.16)' : 'rgba(234, 88, 12, 0.06)'}
                      stroke={liveEdgeLocked ? '#22C55E' : '#FACC15'}
                      strokeWidth="0.75"
                      strokeDasharray={liveEdgeLocked ? undefined : '2.5 2'}
                    />
                  </svg>
                )}

                {cameraReady && autoScan && liveEdgeLocked && (
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-[#0F2744]/90 text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 border border-white/15">
                    <ScanLine className="w-3.5 h-3.5 text-[#22C55E]" />
                    <span className="tabular-nums">
                      Auto Scanning ({autoScanProgress}/{AUTO_SCAN_FRAMES_REQUIRED}) — Hold Steady
                    </span>
                  </div>
                )}

                {/* Dedicated Start Camera Hero with Camera Logo when idle */}
                {!cameraReady && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center bg-slate-900/95">
                    <div className="w-16 h-16 rounded-2xl bg-[#0F2744] border-2 border-[#EA580C] flex items-center justify-center shadow-lg">
                      <Camera className="w-8 h-8 text-[#EA580C]" />
                    </div>
                    <div className="space-y-1 max-w-sm">
                      <div className="text-sm font-display font-bold text-white">
                        KYC Camera Scanner
                      </div>
                      <p className="text-xs text-slate-300">
                        Start the live camera for automatic edge detection and auto-scanning, or upload a photo for perspective cropping.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={cameraStarting}
                      onClick={() => startCamera()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold shadow-sm disabled:opacity-60 whitespace-nowrap"
                    >
                      <Camera className="w-4 h-4" />
                      {cameraStarting ? 'Starting Camera...' : cameraError ? 'Retry Start Camera' : 'Start Camera'}
                    </button>
                  </div>
                )}
              </div>

              {/* Action Controls Bar */}
              <div className="flex flex-wrap items-center justify-center gap-3">
                {!cameraReady ? (
                  <button
                    type="button"
                    disabled={cameraStarting}
                    onClick={() => startCamera()}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold disabled:opacity-60 whitespace-nowrap shrink-0"
                  >
                    <Camera className="w-4 h-4" />
                    {cameraStarting ? 'Starting Camera...' : 'Start Camera'}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => handleSnapFromVideo()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold whitespace-nowrap shrink-0"
                    >
                      <Camera className="w-4 h-4" />
                      Capture Document Now
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const next = facingMode === 'environment' ? 'user' : 'environment';
                        setFacingMode(next);
                        startCamera(next);
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-[#0F2744] whitespace-nowrap shrink-0"
                    >
                      <SwitchCamera className="w-3.5 h-3.5" />
                      Flip ({facingMode === 'environment' ? 'Rear' : 'Front'})
                    </button>
                    <button
                      type="button"
                      onClick={stopCamera}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700 whitespace-nowrap shrink-0"
                    >
                      <Square className="w-3.5 h-3.5 text-slate-600" />
                      Stop Camera
                    </button>
                  </>
                )}

                <label className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0">
                  <Upload className="w-4 h-4" />
                  Camera App / Photo File
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => handleImageFileSelected(e.target.files?.[0])}
                  />
                </label>

                {cameraError && (
                  <button
                    type="button"
                    onClick={() => startCamera()}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry Camera
                  </button>
                )}
              </div>
            </div>
          )}

          {step === 'edit' && sourcePreviewUrl && (
            <div className="space-y-4">
              {uploadError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {uploadError}
                </div>
              )}

              {/* Cropping Size & Output Dimension Controls */}
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#0F2744] mr-1 whitespace-nowrap">
                    <Crop className="w-3.5 h-3.5 text-[#EA580C]" />
                    Cropping Size:
                  </span>
                  {CROP_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleSelectCropPreset(preset.id)}
                      className={`px-2.5 py-1.5 rounded-md text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
                        cropPreset === preset.id
                          ? 'bg-[#0F2744] text-white border-[#0F2744]'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                      }`}
                    >
                      {preset.label}{' '}
                      <span
                        className={`text-[10px] font-normal ${
                          cropPreset === preset.id ? 'text-slate-300' : 'text-slate-400'
                        }`}
                      >
                        ({preset.ratioHint})
                      </span>
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold text-slate-700 whitespace-nowrap">Output Size:</span>
                  <select
                    value={outputMaxDim}
                    onChange={(e) => setOutputMaxDim(Number(e.target.value))}
                    className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-medium text-[#0F2744]"
                  >
                    {OUTPUT_RESOLUTIONS.map((r) => (
                      <option key={r.maxDim} value={r.maxDim}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Filter Mode & Rotation Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {(
                    [
                      { id: 'grayscale', label: 'Grayscale' },
                      { id: 'bw', label: 'B&W Scan' },
                      { id: 'enhance', label: 'Color Enhance' },
                      { id: 'original', label: 'Original' },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setFilterMode(m.id)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                        filterMode === m.id
                          ? 'bg-white text-[#0F2744] shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleSelectCropPreset('auto')}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium whitespace-nowrap"
                  >
                    Auto-Detect Corners
                  </button>
                  <button
                    type="button"
                    onClick={handleRotateSource}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium whitespace-nowrap"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    Rotate 90°
                  </button>
                </div>
              </div>

              {/* Side-by-Side Interactive Crop + Live Warped Preview */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-700">
                    1. Drag Corners to Adjust Document Crop
                  </div>
                  <div className="relative flex justify-center bg-slate-900 rounded-xl p-2 sm:p-3 select-none">
                    <div
                      ref={cropContainerRef}
                      onPointerMove={handlePointerMove}
                      onPointerUp={handlePointerFinish}
                      onPointerCancel={handlePointerFinish}
                      className="relative inline-block max-h-[46vh] touch-none"
                    >
                      <img
                        src={sourcePreviewUrl}
                        alt="Captured document for corner alignment"
                        draggable={false}
                        className="max-h-[44vh] w-auto block rounded select-none pointer-events-none"
                      />

                      <svg
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                        className="absolute inset-0 w-full h-full pointer-events-none"
                      >
                        <defs>
                          <mask id="doc-crop-mask">
                            <rect x="0" y="0" width="100" height="100" fill="white" />
                            <polygon
                              points={corners.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                              fill="black"
                            />
                          </mask>
                        </defs>
                        <rect
                          x="0"
                          y="0"
                          width="100"
                          height="100"
                          fill="rgba(9, 24, 44, 0.55)"
                          mask="url(#doc-crop-mask)"
                        />
                        <polygon
                          points={corners.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                          fill="none"
                          stroke="#EA580C"
                          strokeWidth="0.8"
                        />
                      </svg>

                      {corners.map((pt, idx) => (
                        <button
                          key={CORNER_LABELS[idx]}
                          type="button"
                          onPointerDown={(e) => {
                            e.currentTarget.setPointerCapture(e.pointerId);
                            setDraggingIndex(idx);
                          }}
                          style={{
                            left: `${pt.x * 100}%`,
                            top: `${pt.y * 100}%`,
                            transform: 'translate(-50%, -50%)',
                          }}
                          aria-label={`Drag ${CORNER_LABELS[idx]} corner`}
                          className="absolute w-11 h-11 flex items-center justify-center cursor-grab active:cursor-grabbing focus:outline-none"
                        >
                          <span className="w-6 h-6 rounded-full bg-[#EA580C] border-2 border-white shadow-md flex items-center justify-center text-[9px] font-bold text-white">
                            {CORNER_LABELS[idx]}
                          </span>
                        </button>
                      ))}
                    </div>

                    {draggingIndex !== null && (
                      <canvas
                        ref={loupeCanvasRef}
                        width={96}
                        height={96}
                        className="absolute top-3 right-3 w-24 h-24 rounded-full border-2 border-white shadow-lg pointer-events-none"
                      />
                    )}
                  </div>
                </div>

                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-slate-700">
                      2. Live Perspective &amp; Contrast Preview
                    </div>
                    {outputDimensions && (
                      <div className="text-[11px] font-mono tabular-nums text-slate-500">
                        {outputDimensions.w} × {outputDimensions.h} px
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-100 rounded-xl p-3 flex items-center justify-center border border-slate-200 min-h-[240px] max-h-[46vh]">
                    <canvas
                      ref={livePreviewCanvasRef}
                      className="max-h-[42vh] max-w-full w-auto h-auto object-contain rounded shadow-sm bg-white"
                    />
                  </div>

                  {/* Contrast Adjust Auto Mode + Manual Sliders */}
                  {filterMode !== 'original' && (
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0F2744]">
                          <SlidersHorizontal className="w-3.5 h-3.5 text-[#EA580C]" />
                          Contrast Adjust
                        </span>
                        <button
                          type="button"
                          onClick={handleToggleAutoContrast}
                          className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
                            autoContrastMode
                              ? 'bg-[#15803D] border-[#15803D] text-white'
                              : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          Auto Mode: {autoContrastMode ? 'ON' : 'OFF (Manual)'}
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <label className="block">
                          <span className="flex justify-between font-medium text-slate-600 mb-1">
                            <span>Brightness</span>
                            <span className="font-mono tabular-nums">{brightness}</span>
                          </span>
                          <input
                            type="range"
                            min={-40}
                            max={40}
                            value={brightness}
                            onChange={(e) => {
                              setAutoContrastMode(false);
                              setBrightness(Number(e.target.value));
                            }}
                            className="w-full accent-[#0F2744]"
                          />
                        </label>
                        <label className="block">
                          <span className="flex justify-between font-medium text-slate-600 mb-1">
                            <span>Contrast</span>
                            <span className="font-mono tabular-nums">{contrast.toFixed(2)}×</span>
                          </span>
                          <input
                            type="range"
                            min={0.8}
                            max={1.85}
                            step={0.05}
                            value={contrast}
                            onChange={(e) => {
                              setAutoContrastMode(false);
                              setContrast(Number(e.target.value));
                            }}
                            className="w-full accent-[#EA580C]"
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* PAN Card OCR Extraction & Lead Form Pre-fill Card */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-[#0F2744] text-white">
                      <Sparkles className="w-4 h-4 text-[#FACC15]" />
                    </div>
                    <div>
                      <div className="text-xs font-display font-bold text-[#0F2744]">
                        PAN Card OCR Auto-Parser
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Automatically extracts PAN number, cardholder name &amp; DOB to pre-fill the Lead Generation form.
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {ocrResult && (
                      <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-600">
                        {ocrResult.engine === 'gemini-vision' ? 'Vision OCR' : 'On-Device OCR'}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={ocrRunning}
                      onClick={runOcrOnCurrentScan}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold disabled:opacity-60 whitespace-nowrap"
                    >
                      {ocrRunning ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ScanLine className="w-3.5 h-3.5" />
                      )}
                      {ocrRunning ? `${ocrProgress}%` : ocrResult ? 'Re-Scan PAN (OCR)' : 'Parse PAN (OCR)'}
                    </button>
                  </div>
                </div>

                {ocrRunning && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[11px] font-medium text-[#0F2744]">
                      <span>{ocrStage || 'Reading PAN card...'}</span>
                      <span className="font-mono tabular-nums">{ocrProgress}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full bg-[#EA580C] transition-all duration-200"
                        style={{ width: `${ocrProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {ocrError && (
                  <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                    {ocrError}
                  </div>
                )}

                {(ocrResult || ocrPanNumber || ocrCustomerName) && (
                  <div className="space-y-3 pt-1">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="flex items-center justify-between text-[11px] font-semibold text-slate-700 mb-1">
                          <span>Parsed PAN Number</span>
                          {/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(ocrPanNumber.trim().toUpperCase()) && (
                            <span className="text-[10px] font-semibold text-[#15803D]">Valid Format ✓</span>
                          )}
                        </label>
                        <input
                          type="text"
                          maxLength={10}
                          value={ocrPanNumber}
                          onChange={(e) => setOcrPanNumber(e.target.value.toUpperCase())}
                          placeholder="ABCDE1234F"
                          className="w-full px-3 py-1.5 text-xs font-mono uppercase border border-slate-300 rounded-lg bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Parsed Customer Full Name
                        </label>
                        <input
                          type="text"
                          value={ocrCustomerName}
                          onChange={(e) => setOcrCustomerName(e.target.value)}
                          placeholder="Cardholder Name"
                          className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Parsed Date of Birth
                        </label>
                        <input
                          type="date"
                          value={ocrDob}
                          onChange={(e) => setOcrDob(e.target.value)}
                          className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {ocrResult?.rawText ? (
                        <button
                          type="button"
                          onClick={() => setShowRawOcr((v) => !v)}
                          className="text-[11px] font-semibold text-slate-500 hover:text-[#0F2744] underline"
                        >
                          {showRawOcr ? 'Hide Raw OCR Text' : 'Inspect Raw OCR Text'}
                        </button>
                      ) : (
                        <span />
                      )}

                      {onPrefillLead && (
                        <button
                          type="button"
                          disabled={!ocrPanNumber.trim() && !ocrCustomerName.trim()}
                          onClick={handleApplyOcrToLeadForm}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
                        >
                          <UserPlus className="w-3.5 h-3.5" />
                          Pre-fill Lead Form with PAN &amp; Name
                        </button>
                      )}
                    </div>

                    {showRawOcr && ocrResult?.rawText && (
                      <pre className="p-2.5 rounded-lg bg-white border border-slate-200 text-[11px] font-mono text-slate-600 whitespace-pre-wrap max-h-28 overflow-y-auto">
                        {ocrResult.rawText}
                      </pre>
                    )}
                  </div>
                )}
              </div>

              {/* Footer Actions */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setStep('capture')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    Retake / Camera
                  </button>
                  <input
                    type="text"
                    value={fileName}
                    onChange={(e) => setFileName(e.target.value)}
                    className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg w-48 sm:w-56"
                    aria-label="Scanned document filename"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleDownloadScan}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-[#0F2744] whitespace-nowrap"
                  >
                    <Download className="w-4 h-4" />
                    Save Photo
                  </button>
                  {onPrefillLead && (
                    <button
                      type="button"
                      disabled={!ocrPanNumber.trim() && !ocrCustomerName.trim()}
                      onClick={handleApplyOcrToLeadForm}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
                    >
                      <UserPlus className="w-4 h-4" />
                      Pre-fill Lead Form
                    </button>
                  )}
                  {allowUpload && (
                    <button
                      type="button"
                      disabled={uploading}
                      onClick={handleConfirmUpload}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
                    >
                      <Check className="w-4 h-4" />
                      {uploading ? 'Uploading High-Res Scan...' : 'Upload Scanned Document'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </>
    );

  if (embedded) {
    return <div className="flex flex-col flex-1 min-h-0 overflow-hidden">{scannerBody}</div>;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white rounded-xl max-w-5xl w-full max-h-[94vh] flex flex-col overflow-hidden border border-slate-200">
        {scannerBody}
      </div>
    </div>
  );
};
