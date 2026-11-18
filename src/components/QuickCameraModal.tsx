import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  Check,
  Download,
  FileText,
  Grid3X3,
  Mail,
  MapPin,
  MessageCircle,
  RefreshCw,
  Share2,
  SlidersHorizontal,
  SwitchCamera,
  Timer,
  Upload,
  UserCheck,
  X,
} from 'lucide-react';
import type { AuthUser, LeadRecord } from '../../shared/types';
import { apiFetch } from '../lib/api';
import { DocumentScannerModal } from './DocumentScannerModal';

interface QuickCameraModalProps {
  user: AuthUser;
  initialMode?: 'selfie' | 'document';
  initialDocCategory?: string;
  onClose: () => void;
  onActivitySaved: () => void;
  onPrefillLeadFromOcr?: (data: {
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

interface GeoState {
  lat: number;
  lng: number;
  accuracy: number;
  place: string;
  isFallback: boolean;
}

function formatVisitDateTime(date: Date): string {
  const datePart = date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const timePart = date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return `${datePart}, ${timePart}`;
}

export const QuickCameraModal: React.FC<QuickCameraModalProps> = ({
  user,
  initialMode = 'selfie',
  initialDocCategory = 'PAN Card',
  onClose,
  onActivitySaved,
  onPrefillLeadFromOcr,
}) => {
  const isReferral = user.role === 'REFERRAL_PARTNER';
  const [cameraMode, setCameraMode] = useState<'selfie' | 'document'>(initialMode);

  // Visit Selfie Camera State
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [mirrorFront, setMirrorFront] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [timerSeconds, setTimerSeconds] = useState<0 | 3>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Visit Metadata & Location
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [visitWithType, setVisitWithType] = useState<'Customer' | 'Referral Partner'>('Customer');
  const [personName, setPersonName] = useState('');
  const [visitNotes, setVisitNotes] = useState('');
  const [liveClock, setLiveClock] = useState(() => new Date());
  const [geo, setGeo] = useState<GeoState | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [customLocationText, setCustomLocationText] = useState('');

  // Captured Stamped Selfie Output
  const [capturedRawCanvas, setCapturedRawCanvas] = useState<HTMLCanvasElement | null>(null);
  const [stampedDataUrl, setStampedDataUrl] = useState<string | null>(null);
  const [capturedAtText, setCapturedAtText] = useState<string>('');
  const [savingToCrm, setSavingToCrm] = useState(false);
  const [crmStatusMsg, setCrmStatusMsg] = useState<string | null>(null);
  const [crmError, setCrmError] = useState<string | null>(null);

  // Clean document upload target
  const [docLeadId, setDocLeadId] = useState('');

  // Live clock for viewfinder HUD
  useEffect(() => {
    const id = window.setInterval(() => setLiveClock(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Load leads for tagging Visit Selfie or uploading clean KYC docs
  useEffect(() => {
    apiFetch<{ leads: LeadRecord[] }>('/leads')
      .then((res) => {
        setLeads(res.leads || []);
        if (res.leads?.length > 0) {
          setDocLeadId(String(res.leads[0].id));
        }
      })
      .catch(() => {
        // optional
      });
  }, []);

  const fetchGeoLocation = () => {
    setGeoLoading(true);
    const applyCoords = async (lat: number, lng: number, accuracy: number, isFallback: boolean) => {
      const basePlace = isFallback
        ? 'Office / Field Area (GPS Approximate)'
        : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      setGeo({ lat, lng, accuracy, place: basePlace, isFallback });
      setGeoLoading(false);

      if (!isFallback) {
        try {
          const ctrl = new AbortController();
          const tId = window.setTimeout(() => ctrl.abort(), 3500);
          const resp = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`,
            { signal: ctrl.signal }
          );
          window.clearTimeout(tId);
          if (resp.ok) {
            const data = await resp.json();
            const addr = data?.address || {};
            const parts = [
              addr.suburb || addr.neighbourhood || addr.road,
              addr.city || addr.town || addr.village || addr.state_district,
              addr.state,
            ].filter(Boolean);
            if (parts.length > 0) {
              const resolved = parts.join(', ');
              setGeo((prev) => (prev ? { ...prev, place: resolved } : prev));
            }
          }
        } catch {
          // keep lat/lng fallback
        }
      }
    };

    if (!navigator.geolocation) {
      applyCoords(19.076, 72.8777, 30, true);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        applyCoords(pos.coords.latitude, pos.coords.longitude, Math.round(pos.coords.accuracy), false);
      },
      () => {
        applyCoords(19.076, 72.8777, 35, true);
      },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 15000 }
    );
  };

  useEffect(() => {
    fetchGeoLocation();
  }, []);

  const stopSelfieCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraReady(false);
    setCameraStarting(false);
  };

  const startSelfieCamera = async (overrideFacing?: 'user' | 'environment') => {
    const targetFacing = overrideFacing ?? facingMode;
    stopSelfieCamera();
    setCameraError(null);
    setCameraStarting(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraStarting(false);
      setCameraError('Live browser camera unavailable. Use "Camera App / Photo File" below to snap or pick a photo.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: targetFacing },
          width: { ideal: 1280 },
          height: { ideal: 960 },
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
      setCameraError('Camera permission denied or no camera device detected. Use "Camera App / Photo File" below.');
    } finally {
      setCameraStarting(false);
    }
  };

  // Auto-start full camera immediately on modal open in Visit Selfie mode
  useEffect(() => {
    if (cameraMode === 'selfie' && !stampedDataUrl) {
      startSelfieCamera();
    } else {
      stopSelfieCamera();
    }
    return () => stopSelfieCamera();
  }, [cameraMode, stampedDataUrl]);

  // Burn Geo Location + Date & Time stamp onto captured Visit Selfie canvas
  const renderStampedSelfie = (
    rawCanvas: HTMLCanvasElement,
    timestampText: string,
    activeGeo: GeoState | null,
    areaNote: string,
    withType: string,
    withName: string,
    leadCodeLabel?: string
  ): string => {
    const out = document.createElement('canvas');
    out.width = rawCanvas.width;
    out.height = rawCanvas.height;
    const ctx = out.getContext('2d');
    if (!ctx) return rawCanvas.toDataURL('image/jpeg', 0.92);

    ctx.drawImage(rawCanvas, 0, 0);

    const w = out.width;
    const h = out.height;
    const scale = Math.max(0.8, w / 900);
    const pad = Math.round(18 * scale);
    const bannerH = Math.round(154 * scale);
    const bannerY = h - bannerH - pad;

    // Dark Navy translucent card
    ctx.fillStyle = 'rgba(15, 39, 68, 0.86)';
    ctx.fillRect(pad, bannerY, w - pad * 2, bannerH);

    // Orange top accent stripe on stamp card
    ctx.fillStyle = '#EA580C';
    ctx.fillRect(pad, bannerY, w - pad * 2, Math.max(4, Math.round(5 * scale)));

    const textX = pad + Math.round(16 * scale);
    const rightX = w - pad - Math.round(16 * scale);
    let y = bannerY + Math.round(28 * scale);

    // Header row
    ctx.fillStyle = '#FBBF24';
    ctx.font = `bold ${Math.round(16 * scale)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText('AMBIKA ASSOCIATE · VISIT VERIFICATION SELFIE', textX, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#86EFAC';
    ctx.font = `bold ${Math.round(14 * scale)}px monospace`;
    ctx.fillText('GEO & TIME STAMPED', rightX, y);
    ctx.textAlign = 'left';

    y += Math.round(26 * scale);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `600 ${Math.round(15 * scale)}px system-ui, -apple-system, sans-serif`;
    const leadPart = leadCodeLabel ? ` · Lead: ${leadCodeLabel}` : '';
    const guestPart = withName.trim() ? ` | With ${withType}: ${withName.trim()}` : ` | ${withType} Visit`;
    ctx.fillText(`Staff: ${user.fullName} (${user.employeeCode})${guestPart}${leadPart}`, textX, y);

    y += Math.round(25 * scale);
    ctx.fillStyle = '#E2E8F0';
    ctx.font = `600 ${Math.round(14 * scale)}px monospace`;
    ctx.fillText(`Date & Time: ${timestampText}`, textX, y);

    y += Math.round(24 * scale);
    const locLabel = areaNote.trim() || activeGeo?.place || 'Location Recorded';
    ctx.fillStyle = '#F8FAFC';
    ctx.font = `500 ${Math.round(14 * scale)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(`Location: ${locLabel.slice(0, 74)}`, textX, y);

    y += Math.round(22 * scale);
    if (activeGeo) {
      ctx.fillStyle = '#94A3B8';
      ctx.font = `500 ${Math.round(13 * scale)}px monospace`;
      ctx.fillText(
        `GPS: ${activeGeo.lat.toFixed(5)}, ${activeGeo.lng.toFixed(5)} (±${activeGeo.accuracy}m)`,
        textX,
        y
      );
    }

    return out.toDataURL('image/jpeg', 0.92);
  };

  // Re-stamp live if user updates Customer/Referral name or Location note after capture
  useEffect(() => {
    if (!capturedRawCanvas || !capturedAtText) return;
    const selectedLead = leads.find((l) => String(l.id) === selectedLeadId);
    const url = renderStampedSelfie(
      capturedRawCanvas,
      capturedAtText,
      geo,
      customLocationText,
      visitWithType,
      personName,
      selectedLead?.leadCode
    );
    setStampedDataUrl(url);
  }, [capturedRawCanvas, capturedAtText, geo, customLocationText, visitWithType, personName, selectedLeadId]);

  const executeCaptureSelfie = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cropW = vw / zoomFactor;
    const cropH = vh / zoomFactor;
    const sx = (vw - cropW) / 2;
    const sy = (vh - cropH) / 2;

    const raw = document.createElement('canvas');
    raw.width = Math.min(1280, Math.round(vw));
    raw.height = Math.round((raw.width * vh) / vw);
    const ctx = raw.getContext('2d');
    if (ctx) {
      // Un-mirrored final output so customer/background signs remain readable
      ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, raw.width, raw.height);
    }

    const nowText = formatVisitDateTime(new Date());
    setCapturedAtText(nowText);
    setCapturedRawCanvas(raw);
    const selectedLead = leads.find((l) => String(l.id) === selectedLeadId);
    setStampedDataUrl(
      renderStampedSelfie(raw, nowText, geo, customLocationText, visitWithType, personName, selectedLead?.leadCode)
    );
    stopSelfieCamera();
  };

  const handleCaptureClick = () => {
    if (timerSeconds === 0) {
      executeCaptureSelfie();
      return;
    }
    setCountdown(timerSeconds);
    let remaining = timerSeconds;
    const iv = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(iv);
        setCountdown(null);
        executeCaptureSelfie();
      } else {
        setCountdown(remaining);
      }
    }, 1000);
  };

  const handleSelfieFilePicked = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const raw = document.createElement('canvas');
        const maxW = 1280;
        const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
        raw.width = Math.round(img.naturalWidth * scale);
        raw.height = Math.round(img.naturalHeight * scale);
        const ctx = raw.getContext('2d');
        ctx?.drawImage(img, 0, 0, raw.width, raw.height);
        const nowText = formatVisitDateTime(new Date());
        setCapturedAtText(nowText);
        setCapturedRawCanvas(raw);
        const selectedLead = leads.find((l) => String(l.id) === selectedLeadId);
        setStampedDataUrl(
          renderStampedSelfie(raw, nowText, geo, customLocationText, visitWithType, personName, selectedLead?.leadCode)
        );
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const selfieFileName = useMemo(() => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    return `AMBIKA_Visit_Selfie_${user.employeeCode}_${stamp}.jpg`;
  }, [capturedAtText, user.employeeCode]);

  const downloadSelfiePhoto = () => {
    if (!stampedDataUrl) return;
    const a = document.createElement('a');
    a.href = stampedDataUrl;
    a.download = selfieFileName;
    a.click();
  };

  const visitShareText = useMemo(() => {
    const selectedLead = leads.find((l) => String(l.id) === selectedLeadId);
    const mapLink = geo ? `https://maps.google.com/?q=${geo.lat.toFixed(6)},${geo.lng.toFixed(6)}` : '';
    const loc = customLocationText.trim() || geo?.place || 'Recorded GPS';
    return [
      `*AMBIKA ASSOCIATE — Visit Verification Selfie*`,
      `Officer: ${user.fullName} (${user.employeeCode})`,
      `Visit With (${visitWithType}): ${personName.trim() || 'Not specified'}`,
      selectedLead ? `Lead ID: ${selectedLead.leadCode}` : null,
      `Date & Time: ${capturedAtText || formatVisitDateTime(liveClock)}`,
      `Location: ${loc}`,
      geo ? `GPS Map: ${mapLink}` : null,
      visitNotes.trim() ? `Notes: ${visitNotes.trim()}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }, [user, visitWithType, personName, selectedLeadId, leads, capturedAtText, liveClock, customLocationText, geo, visitNotes]);

  const handleNativeSharePhoto = async () => {
    if (!stampedDataUrl) return;
    try {
      const resp = await fetch(stampedDataUrl);
      const blob = await resp.blob();
      const file = new File([blob], selfieFileName, { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: `AMBIKA Visit Selfie — ${personName.trim() || visitWithType}`,
          text: visitShareText,
          files: [file],
        });
        return;
      }
      downloadSelfiePhoto();
      setCrmStatusMsg('Photo saved to device. Attach the downloaded image in WhatsApp or Mail.');
    } catch {
      // user cancelled or unsupported
    }
  };

  const handleSaveSelfieToCrm = async () => {
    if (!stampedDataUrl) return;
    setSavingToCrm(true);
    setCrmError(null);
    setCrmStatusMsg(null);
    try {
      const selectedLead = leads.find((l) => String(l.id) === selectedLeadId);
      if (selectedLead && !isReferral) {
        await apiFetch(`/leads/${selectedLead.id}/documents`, {
          method: 'POST',
          json: {
            category: 'Visit Selfie',
            fileName: selfieFileName,
            mimeType: 'image/jpeg',
            dataBase64: stampedDataUrl,
          },
        });
      }
      if (!isReferral && geo) {
        await apiFetch('/gps', {
          method: 'POST',
          json: {
            latitude: geo.lat,
            longitude: geo.lng,
            accuracy: geo.accuracy,
            activityType: 'VISIT_CHECKIN',
            leadId: selectedLead?.id ?? undefined,
            customerName: personName.trim() || selectedLead?.customerName || `${visitWithType} Visit`,
            visitNotes: `Visit Selfie (${visitWithType}) · ${customLocationText.trim() || geo.place}${visitNotes.trim() ? ' · ' + visitNotes.trim() : ''}`,
            consentConfirmed: true,
          },
        });
      }
      onActivitySaved();
      setCrmStatusMsg(
        selectedLead
          ? `Visit selfie & GPS check-in saved to Lead ${selectedLead.leadCode}.`
          : 'Visit GPS check-in recorded in Field Operations.'
      );
    } catch (err: any) {
      setCrmError(err.message || 'Could not save visit selfie to CRM');
    } finally {
      setSavingToCrm(false);
    }
  };

  const supportsFileShare =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white rounded-xl max-w-5xl w-full max-h-[94vh] flex flex-col overflow-hidden border border-slate-200">
        {/* Top Modal Header + Mode Switcher */}
        <div className="px-5 py-3 bg-[#0F2744] text-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => {
                stopSelfieCamera();
                onClose();
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold text-white shrink-0"
              aria-label="Back from camera"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back
            </button>
            <div className="w-9 h-9 rounded-lg bg-[#EA580C] flex items-center justify-center shrink-0">
              <Camera className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-display font-bold truncate">
                Smart Field Camera Studio
              </div>
              <div className="text-[11px] text-slate-300 truncate">
                {cameraMode === 'selfie'
                  ? 'Visit Selfie Mode: Auto GPS Location + Date & Time Stamp · Save & Share'
                  : 'Document Scan Mode: Clean Perspective Scan (No Location / Date Stamp)'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center p-0.5 rounded-lg bg-white/10">
              <button
                type="button"
                onClick={() => setCameraMode('selfie')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${
                  cameraMode === 'selfie' ? 'bg-[#EA580C] text-white' : 'text-slate-200 hover:text-white'
                }`}
              >
                <UserCheck className="w-3.5 h-3.5" />
                Visit Selfie (Geo+Time)
              </button>
              <button
                type="button"
                onClick={() => setCameraMode('document')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${
                  cameraMode === 'document' ? 'bg-[#15803D] text-white' : 'text-slate-200 hover:text-white'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                Document Scan + PAN OCR
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                stopSelfieCamera();
                onClose();
              }}
              className="p-1.5 rounded-lg hover:bg-white/10 text-white shrink-0"
              aria-label="Close camera studio"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* MODE 1: VISIT SELFIE WITH LOCATION + DATE/TIME */}
        {cameraMode === 'selfie' && (
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
            {/* Visit Metadata & Geo Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Visit With</label>
                <select
                  value={visitWithType}
                  onChange={(e) => setVisitWithType(e.target.value as 'Customer' | 'Referral Partner')}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white font-medium"
                >
                  <option value="Customer">Customer Visit</option>
                  <option value="Referral Partner">Referral Partner Visit</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Link Lead (Optional)</label>
                <select
                  value={selectedLeadId}
                  onChange={(e) => {
                    setSelectedLeadId(e.target.value);
                    const found = leads.find((l) => String(l.id) === e.target.value);
                    if (found && !personName.trim()) {
                      setPersonName(found.customerName);
                    }
                  }}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">General Visit (No Lead)</option>
                  {leads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.leadCode} — {l.customerName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                  {visitWithType} Name
                </label>
                <input
                  type="text"
                  value={personName}
                  onChange={(e) => setPersonName(e.target.value)}
                  placeholder={`Enter ${visitWithType} name`}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                  Location Label (Auto GPS / Edit)
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={customLocationText}
                    onChange={(e) => setCustomLocationText(e.target.value)}
                    placeholder={geo?.place || 'Fetching GPS...'}
                    className="flex-1 min-w-0 px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
                  />
                  <button
                    type="button"
                    onClick={fetchGeoLocation}
                    title="Refresh GPS Location"
                    className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-[#0F2744] shrink-0"
                  >
                    <MapPin className={`w-3.5 h-3.5 ${geoLoading ? 'animate-pulse text-[#EA580C]' : 'text-[#15803D]'}`} />
                  </button>
                </div>
              </div>
            </div>

            {cameraError && !stampedDataUrl && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                {cameraError}
              </div>
            )}
            {crmError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">{crmError}</div>
            )}
            {crmStatusMsg && (
              <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-xs text-[#15803D] font-medium">
                {crmStatusMsg}
              </div>
            )}

            {/* Live Selfie Viewfinder OR Captured Stamped Preview */}
            {!stampedDataUrl ? (
              <div className="space-y-3">
                <div className="relative bg-slate-950 rounded-xl overflow-hidden aspect-[4/3] max-h-[50vh] mx-auto flex items-center justify-center border border-slate-800">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    style={{
                      transform: `${facingMode === 'user' && mirrorFront ? 'scaleX(-1) ' : ''}scale(${zoomFactor})`,
                    }}
                    className={`w-full h-full object-cover transition-transform duration-150 ${
                      cameraReady ? 'opacity-100' : 'opacity-0'
                    }`}
                  />

                  {/* 3x3 Composition Grid */}
                  {cameraReady && showGrid && (
                    <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
                      {Array.from({ length: 9 }).map((_, idx) => (
                        <div key={idx} className="border border-white/15" />
                      ))}
                    </div>
                  )}

                  {/* Countdown Indicator */}
                  {countdown !== null && (
                    <div className="absolute inset-0 bg-black/45 flex items-center justify-center">
                      <span className="text-6xl font-display font-bold text-white drop-shadow-lg tabular-nums">
                        {countdown}
                      </span>
                    </div>
                  )}

                  {/* Live Geo + Date/Time Watermark Preview Overlay */}
                  {cameraReady && (
                    <div className="pointer-events-none absolute bottom-3 left-3 right-3 rounded-lg bg-[#0F2744]/85 border-t-2 border-[#EA580C] px-3.5 py-2.5 text-white text-[11px] space-y-0.5">
                      <div className="flex items-center justify-between gap-2 font-bold text-amber-300">
                        <span>AMBIKA ASSOCIATE · VISIT SELFIE STAMP</span>
                        <span className="font-mono text-green-300">{formatVisitDateTime(liveClock)}</span>
                      </div>
                      <div className="truncate">
                        {user.fullName} ({user.employeeCode})
                        {personName.trim() ? ` · With ${visitWithType}: ${personName.trim()}` : ''}
                      </div>
                      <div className="text-slate-300 font-mono truncate">
                        {customLocationText.trim() || geo?.place || 'Locating GPS...'}{' '}
                        {geo ? `(${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)})` : ''}
                      </div>
                    </div>
                  )}

                  {!cameraReady && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-slate-900/95">
                      <Camera className="w-10 h-10 text-[#EA580C]" />
                      <div className="text-xs text-slate-300 max-w-xs">
                        {cameraStarting
                          ? 'Starting live camera with Geo & Time stamp...'
                          : 'Click Start Camera or pick/take a photo with your device camera app.'}
                      </div>
                      <button
                        type="button"
                        disabled={cameraStarting}
                        onClick={() => startSelfieCamera()}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#EA580C] text-white text-xs font-semibold"
                      >
                        <Camera className="w-4 h-4" />
                        {cameraStarting ? 'Starting Camera...' : 'Start Camera'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Full Camera Feature Controls */}
                <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const next = facingMode === 'user' ? 'environment' : 'user';
                        setFacingMode(next);
                        startSelfieCamera(next);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-[#0F2744]"
                    >
                      <SwitchCamera className="w-3.5 h-3.5" />
                      {facingMode === 'user' ? 'Front Selfie' : 'Rear Camera'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTimerSeconds((t) => (t === 0 ? 3 : 0))}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold ${
                        timerSeconds === 3
                          ? 'bg-[#0F2744] text-white border-[#0F2744]'
                          : 'bg-white text-slate-700 border-slate-300'
                      }`}
                    >
                      <Timer className="w-3.5 h-3.5" />
                      Timer: {timerSeconds}s
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowGrid((g) => !g)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold ${
                        showGrid
                          ? 'bg-[#0F2744] text-white border-[#0F2744]'
                          : 'bg-white text-slate-700 border-slate-300'
                      }`}
                    >
                      <Grid3X3 className="w-3.5 h-3.5" />
                      Grid
                    </button>
                    {facingMode === 'user' && (
                      <button
                        type="button"
                        onClick={() => setMirrorFront((m) => !m)}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-semibold ${
                          mirrorFront
                            ? 'bg-[#0F2744] text-white border-[#0F2744]'
                            : 'bg-white text-slate-700 border-slate-300'
                        }`}
                      >
                        Mirror
                      </button>
                    )}
                    <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-xs">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-[#EA580C]" />
                      <span className="font-semibold text-slate-700">Zoom</span>
                      <input
                        type="range"
                        min={1}
                        max={2.5}
                        step={0.1}
                        value={zoomFactor}
                        onChange={(e) => setZoomFactor(Number(e.target.value))}
                        className="w-20 accent-[#EA580C]"
                      />
                      <span className="font-mono tabular-nums text-[11px]">{zoomFactor.toFixed(1)}×</span>
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={!cameraReady || countdown !== null}
                      onClick={handleCaptureClick}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
                    >
                      <Camera className="w-4 h-4" />
                      {countdown !== null ? `Capturing in ${countdown}...` : 'Capture Geo-Stamped Selfie'}
                    </button>
                    <label className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold cursor-pointer whitespace-nowrap">
                      <Upload className="w-3.5 h-3.5" />
                      Camera App / Photo File
                      <input
                        type="file"
                        accept="image/*"
                        capture="user"
                        className="hidden"
                        onChange={(e) => handleSelfieFilePicked(e.target.files?.[0])}
                      />
                    </label>
                  </div>
                </div>
              </div>
            ) : (
              /* Stamped Visit Selfie Preview + Save + WhatsApp + Mail + CRM Save */
              <div className="space-y-4">
                <div className="bg-slate-900 rounded-xl p-3 flex justify-center">
                  <img
                    src={stampedDataUrl}
                    alt="Geo and Timestamped Visit Selfie"
                    className="max-h-[48vh] w-auto rounded-lg object-contain border border-white/10"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Visit Note (Optional — included in WhatsApp/Mail &amp; CRM Check-In)
                  </label>
                  <input
                    type="text"
                    value={visitNotes}
                    onChange={(e) => setVisitNotes(e.target.value)}
                    placeholder="e.g. Met customer at residence and collected loan enquiry details"
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={() => {
                      setStampedDataUrl(null);
                      setCapturedRawCanvas(null);
                      setCrmStatusMsg(null);
                      setCrmError(null);
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retake Selfie
                  </button>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={downloadSelfiePhoto}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-[#0F2744]"
                    >
                      <Download className="w-4 h-4" />
                      Save Photo
                    </button>

                    {supportsFileShare && (
                      <button
                        type="button"
                        onClick={handleNativeSharePhoto}
                        className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold"
                      >
                        <Share2 className="w-4 h-4" />
                        Share Photo
                      </button>
                    )}

                    <a
                      href={`https://wa.me/?text=${encodeURIComponent(visitShareText)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={downloadSelfiePhoto}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold"
                    >
                      <MessageCircle className="w-4 h-4" />
                      Send WhatsApp
                    </a>

                    <a
                      href={`mailto:?subject=${encodeURIComponent(
                        `AMBIKA Visit Verification — ${personName.trim() || visitWithType} (${user.employeeCode})`
                      )}&body=${encodeURIComponent(visitShareText)}`}
                      onClick={downloadSelfiePhoto}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold"
                    >
                      <Mail className="w-4 h-4" />
                      Send Mail
                    </a>

                    {!isReferral && (
                      <button
                        type="button"
                        disabled={savingToCrm}
                        onClick={handleSaveSelfieToCrm}
                        className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold disabled:opacity-50"
                      >
                        <Check className="w-4 h-4" />
                        {savingToCrm
                          ? 'Saving...'
                          : selectedLeadId
                          ? 'Save to Lead & GPS'
                          : 'Log GPS Check-In'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* MODE 2: CLEAN DOCUMENT SCANNER + PAN OCR (STRICTLY NO LOCATION OR DATE/TIME STAMP) */}
        {cameraMode === 'document' && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="px-5 py-2 bg-green-50 border-b border-green-200 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[#15803D]">
                  Clean KYC Document + PAN OCR Mode — Location, Date &amp; Time watermark are OFF.
                </span>
              </div>
              {!isReferral && (
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-700">Target Lead:</span>
                  <select
                    value={docLeadId}
                    onChange={(e) => setDocLeadId(e.target.value)}
                    className="px-2.5 py-1 text-xs border border-slate-300 rounded-lg bg-white text-[#0F2744] font-medium"
                  >
                    {leads.length === 0 ? (
                      <option value="">New Lead / Save Photo</option>
                    ) : (
                      leads.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.leadCode} — {l.customerName}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              )}
            </div>

            <DocumentScannerModal
              embedded
              autoStart
              allowUpload={!isReferral}
              leadCode={leads.find((l) => String(l.id) === docLeadId)?.leadCode || 'KYC'}
              initialCategory={initialDocCategory}
              onClose={onClose}
              onPrefillLead={onPrefillLeadFromOcr}
              onUploadScanned={async (payload) => {
                if (!docLeadId) {
                  throw new Error('Select a Lead above or use "Pre-fill Lead Form" / "Save Photo".');
                }
                await apiFetch(`/leads/${docLeadId}/documents`, {
                  method: 'POST',
                  json: payload,
                });
                onActivitySaved();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
