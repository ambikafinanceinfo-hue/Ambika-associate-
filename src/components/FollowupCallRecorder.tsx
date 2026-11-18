import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Link2Off,
  Lock,
  Mail,
  MessageCircle,
  Mic,
  Pause,
  Play,
  Share2,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react';
import type { AuthUser, FollowupRecordingRecord, UserRole } from '../../shared/types';
import { apiFetch, formatDateTime, getStoredToken } from '../lib/api';

interface FollowupCallRecorderProps {
  leadId: number;
  leadCode: string;
  customerName: string;
  user: AuthUser;
  recordings: FollowupRecordingRecord[];
  onRecordingSaved: () => Promise<void> | void;
}

const ROLE_BADGE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: 'Admin',
  BRANCH_MANAGER: 'Branch Mgr',
  TEAM_LEADER: 'Team Leader',
  LEAD_GENERATOR: 'Lead Gen Team',
  FIELD_OFFICER: 'Field Officer',
  REFERRAL_PARTNER: 'Referral',
};

export function formatDurationMmSs(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const mins = String(Math.floor(safe / 60)).padStart(2, '0');
  const secs = String(safe % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

export function formatBytesCompact(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRemainingRetention(expiresAt: string): string {
  const normalized = expiresAt.includes('T') ? expiresAt : expiresAt.replace(' ', 'T') + 'Z';
  const diffMs = new Date(normalized).getTime() - Date.now();
  if (Number.isNaN(diffMs) || diffMs <= 0) return 'Expiring soon';
  const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days >= 1) return `${days}d ${hours}h left`;
  if (totalHours >= 1) return `${totalHours}h left`;
  const mins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
  return `${mins}m left`;
}

function pickSupportedRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read audio recording'));
    reader.readAsDataURL(blob);
  });
}

function readAudioFileDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('audio');
    const cleanup = () => {
      probe.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      const dur = Number.isFinite(probe.duration) ? Math.round(probe.duration) : 0;
      cleanup();
      resolve(dur);
    };
    probe.onerror = () => {
      cleanup();
      resolve(0);
    };
    probe.src = url;
  });
}

export const FollowupRecordingAdminControls: React.FC<{
  rec: FollowupRecordingRecord;
  leadCode: string;
  customerName: string;
  onUpdated: () => Promise<void> | void;
}> = ({ rec, leadCode, customerName, onUpdated }) => {
  const token = getStoredToken() || '';
  const audioUrl = `/api/followup-recordings/${rec.id}/audio?token=${encodeURIComponent(token)}`;
  const downloadUrl = `/api/followup-recordings/${rec.id}/audio?download=1&token=${encodeURIComponent(token)}`;

  const [sharePath, setSharePath] = useState<string | null>(
    rec.shareToken ? `/api/public/recordings/${rec.shareToken}` : null
  );
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    setSharePath(rec.shareToken ? `/api/public/recordings/${rec.shareToken}` : null);
  }, [rec.shareToken]);

  const fullShareUrl = sharePath ? `${window.location.origin}${sharePath}` : '';

  const ensureShareLink = async (): Promise<string | null> => {
    if (sharePath) return `${window.location.origin}${sharePath}`;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ shareToken: string; sharePath: string }>(
        `/followup-recordings/${rec.id}/share`,
        { method: 'POST', json: {} }
      );
      setSharePath(res.sharePath);
      await onUpdated();
      return `${window.location.origin}${res.sharePath}`;
    } catch (err: any) {
      setFeedback(err?.message || 'Could not generate share link');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleOpenSharePanel = async () => {
    if (!sharePanelOpen && !sharePath) {
      await ensureShareLink();
    }
    setSharePanelOpen((prev) => !prev);
  };

  const handleCopyLink = async () => {
    const url = await ensureShareLink();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setFeedback('7-day expiring share link copied to clipboard.');
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setFeedback('Share link ready below.');
    }
  };

  const handleNativeShare = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const shareUrl = await ensureShareLink();
      if (!navigator.share) {
        if (shareUrl) {
          await navigator.clipboard.writeText(shareUrl);
          setFeedback('Device share unavailable; link copied to clipboard.');
        }
        return;
      }

      // Attempt native file share first; fallback to link share
      try {
        const resp = await fetch(audioUrl);
        if (resp.ok) {
          const blob = await resp.blob();
          const audioFile = new File([blob], rec.fileName, { type: rec.mimeType || 'audio/webm' });
          if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [audioFile] })) {
            await navigator.share({
              title: `Follow-up Recording · ${leadCode}`,
              text: `Customer: ${customerName} · Recorded by ${rec.recordedByName} (${formatDurationMmSs(rec.durationSeconds)})`,
              files: [audioFile],
            });
            setFeedback('Audio file shared via device share sheet.');
            return;
          }
        }
      } catch {
        // Fallback to URL share below
      }

      if (shareUrl) {
        await navigator.share({
          title: `Follow-up Call Recording · ${leadCode}`,
          text: `Customer: ${customerName} · Recorded by ${rec.recordedByName} (${formatDurationMmSs(rec.durationSeconds)}). Auto-deletes in 7 days.`,
          url: shareUrl,
        });
        setFeedback('Expiring recording link shared.');
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setFeedback(err?.message || 'Share cancelled or unavailable');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeShare = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/followup-recordings/${rec.id}/share`, { method: 'DELETE' });
      setSharePath(null);
      setFeedback('Public share link revoked.');
      await onUpdated();
    } catch (err: any) {
      setFeedback(err?.message || 'Failed to revoke share link');
    } finally {
      setBusy(false);
    }
  };

  const shareText = `Ambika Associate Follow-up Recording\nLead: ${leadCode} (${customerName})\nStaff: ${rec.recordedByName} (${ROLE_BADGE_LABELS[rec.recordedByRole] || rec.recordedByRole})\nDuration: ${formatDurationMmSs(rec.durationSeconds)}\nAuto-deletes after 7 days: ${fullShareUrl}`;

  return (
    <div className="mt-2.5 space-y-2">
      {/* Admin-only native audio player */}
      <audio controls preload="metadata" src={audioUrl} className="w-full h-9 rounded-lg" />

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={handleOpenSharePanel}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#0F2744] hover:bg-[#16365D] text-white text-[11px] font-semibold disabled:opacity-50"
        >
          <Share2 className="w-3 h-3" />
          {sharePath ? 'Share Options' : 'Share Recording'}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={handleCopyLink}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-[#0F2744] text-[11px] font-semibold disabled:opacity-50"
        >
          {copied ? <Check className="w-3 h-3 text-[#15803D]" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : 'Copy Link'}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={handleNativeShare}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-semibold disabled:opacity-50"
        >
          <ExternalLink className="w-3 h-3" />
          Send Audio
        </button>

        <a
          href={downloadUrl}
          download={rec.fileName}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-semibold"
        >
          <Download className="w-3 h-3" />
          Download
        </a>
      </div>

      {sharePanelOpen && fullShareUrl && (
        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-[#0F2744]">
              Expiring Share Link ({formatRemainingRetention(rec.expiresAt)})
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={handleRevokeShare}
              className="inline-flex items-center gap-1 text-[#DC2626] font-semibold hover:underline"
            >
              <Link2Off className="w-3 h-3" />
              Revoke Link
            </button>
          </div>
          <input
            type="text"
            readOnly
            value={fullShareUrl}
            onClick={(e) => (e.target as HTMLInputElement).select()}
            className="w-full px-2 py-1 rounded border border-slate-200 bg-white font-mono text-[10px] text-slate-700"
          />
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#15803D] hover:bg-green-800 text-white font-semibold"
            >
              <MessageCircle className="w-3 h-3" />
              WhatsApp
            </a>
            <a
              href={`mailto:?subject=${encodeURIComponent(`Follow-up Call Recording - ${leadCode} (${customerName})`)}&body=${encodeURIComponent(shareText)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#EA580C] hover:bg-[#C2410C] text-white font-semibold"
            >
              <Mail className="w-3 h-3" />
              Email
            </a>
          </div>
        </div>
      )}

      {feedback && <div className="text-[11px] font-medium text-[#15803D]">{feedback}</div>}
    </div>
  );
};

export const FollowupCallRecorder: React.FC<FollowupCallRecorderProps> = ({
  leadId,
  leadCode,
  customerName,
  user,
  recordings,
  onRecordingSaved,
}) => {
  const isAdmin = user.role === 'SUPER_ADMIN';
  const canRecord = ['SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER', 'LEAD_GENERATOR', 'FIELD_OFFICER'].includes(
    user.role
  );

  const [callNotes, setCallNotes] = useState('');
  const [recState, setRecState] = useState<'idle' | 'recording' | 'paused' | 'uploading'>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(new Array(14).fill(8));
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const discardOnStopRef = useRef(false);
  const elapsedRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const cleanupHardware = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((tr) => tr.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    mediaRecorderRef.current = null;
    setLevels(new Array(14).fill(8));
  };

  useEffect(() => {
    return () => {
      discardOnStopRef.current = true;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      cleanupHardware();
    };
  }, [leadId]);

  const startMeterLoop = () => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(bins);
      const nextBars: number[] = [];
      const stride = Math.max(1, Math.floor(bins.length / 14));
      for (let i = 0; i < 14; i++) {
        const val = bins[i * stride] ?? 0;
        nextBars.push(Math.max(8, Math.min(100, Math.round((val / 255) * 100))));
      }
      setLevels(nextBars);
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
  };

  const uploadAudioBlob = async (blob: Blob, durationSecs: number, customFileName?: string) => {
    if (blob.size <= 0) {
      setErrorMsg('Recorded audio was empty. Please speak closer to the mic and try again.');
      setRecState('idle');
      return;
    }
    if (blob.size > 11.5 * 1024 * 1024) {
      setErrorMsg('Audio recording exceeds 11.5 MB limit. Please upload a shorter clip.');
      setRecState('idle');
      return;
    }

    setRecState('uploading');
    setErrorMsg(null);
    try {
      const dataBase64 = await blobToDataUrl(blob);
      const cleanMime = (blob.type || 'audio/webm').split(';')[0] || 'audio/webm';
      const ext = cleanMime.includes('mp4') || cleanMime.includes('m4a')
        ? 'm4a'
        : cleanMime.includes('mpeg') || cleanMime.includes('mp3')
          ? 'mp3'
          : cleanMime.includes('wav')
            ? 'wav'
            : cleanMime.includes('ogg')
              ? 'ogg'
              : 'webm';
      const fileName = customFileName || `${leadCode}-followup-${Date.now()}.${ext}`;

      await apiFetch(`/leads/${leadId}/followup-recordings`, {
        method: 'POST',
        json: {
          fileName,
          mimeType: cleanMime,
          dataBase64,
          durationSeconds: Math.max(1, Math.round(durationSecs)),
          callNotes: callNotes.trim() || undefined,
        },
      });

      setCallNotes('');
      setElapsedSeconds(0);
      elapsedRef.current = 0;
      setSuccessMsg(
        isAdmin
          ? 'Follow-up recording saved (auto-deletes in 7 days).'
          : 'Follow-up recording saved & locked. Only Super Admin can listen or share (auto-deletes in 7 days).'
      );
      await onRecordingSaved();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to upload follow-up recording');
    } finally {
      setRecState('idle');
    }
  };

  const handleStartRecording = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setErrorMsg('Live audio recording is not supported in this browser. Use "Attach Audio File" below.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        startMeterLoop();
      }

      const mime = pickSupportedRecorderMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      discardOnStopRef.current = false;
      elapsedRef.current = 0;
      setElapsedSeconds(0);

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        const shouldDiscard = discardOnStopRef.current;
        const capturedSecs = elapsedRef.current;
        const finalType = recorder.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: finalType });
        chunksRef.current = [];
        cleanupHardware();
        if (shouldDiscard) {
          setElapsedSeconds(0);
          elapsedRef.current = 0;
          setRecState('idle');
          return;
        }
        await uploadAudioBlob(blob, capturedSecs);
      };

      recorder.start(500);
      setRecState('recording');
      timerRef.current = window.setInterval(() => {
        elapsedRef.current += 1;
        setElapsedSeconds(elapsedRef.current);
      }, 1000);
    } catch (err: any) {
      cleanupHardware();
      setErrorMsg(err?.message || 'Microphone access denied. Allow mic permission or attach a call audio file.');
    }
  };

  const handleTogglePause = () => {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    if (recState === 'recording' && typeof rec.pause === 'function') {
      rec.pause();
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setRecState('paused');
    } else if (recState === 'paused' && typeof rec.resume === 'function') {
      rec.resume();
      timerRef.current = window.setInterval(() => {
        elapsedRef.current += 1;
        setElapsedSeconds(elapsedRef.current);
      }, 1000);
      setRecState('recording');
    }
  };

  const handleStopAndSave = () => {
    const rec = mediaRecorderRef.current;
    if (!rec || rec.state === 'inactive') return;
    discardOnStopRef.current = false;
    rec.stop();
  };

  const handleDiscardRecording = () => {
    const rec = mediaRecorderRef.current;
    discardOnStopRef.current = true;
    if (rec && rec.state !== 'inactive') {
      rec.stop();
    } else {
      cleanupHardware();
      setRecState('idle');
    }
  };

  const handleAudioFileSelected = async (file: File | undefined) => {
    if (!file) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    if (file.size > 11.5 * 1024 * 1024) {
      setErrorMsg('Selected audio file is larger than 11.5 MB.');
      return;
    }
    const dur = await readAudioFileDuration(file);
    await uploadAudioBlob(file, dur, file.name);
  };

  return (
    <div className="pt-3 border-t border-slate-200 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-[#0F2744] flex items-center gap-1.5">
          <Volume2 className="w-4 h-4 text-[#EA580C]" />
          Follow-up Customer Call Recording
        </div>
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
          <Clock className="w-3 h-3 text-[#EA580C]" />
          7-Day Auto-Delete · Admin-Only Listen
        </span>
      </div>

      {/* Recording / Upload Controls for Field Officers, Lead Gen Team & Managers */}
      {canRecord && (
        <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
          <input
            type="text"
            value={callNotes}
            onChange={(e) => setCallNotes(e.target.value)}
            disabled={recState === 'uploading'}
            placeholder="Call notes (e.g. Discussed ROI, documents pickup timing, customer feedback)"
            className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-[#0F2744]"
          />

          {recState === 'idle' && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleStartRecording}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#DC2626] hover:bg-red-700 text-white text-xs font-semibold whitespace-nowrap"
              >
                <Mic className="w-3.5 h-3.5" />
                Record Customer Call
              </button>

              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-[#0F2744] text-xs font-semibold cursor-pointer whitespace-nowrap">
                <Upload className="w-3.5 h-3.5" />
                Attach Audio File
                <input
                  type="file"
                  accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm,.aac"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    void handleAudioFileSelected(f);
                  }}
                />
              </label>

              {!isAdmin && (
                <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                  <Lock className="w-3 h-3 text-slate-400" />
                  Saved recordings are locked for Admin review only
                </span>
              )}
            </div>
          )}

          {(recState === 'recording' || recState === 'paused') && (
            <div className="p-2.5 rounded-lg bg-white border border-red-200 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      recState === 'recording' ? 'bg-[#DC2626] animate-pulse' : 'bg-amber-500'
                    }`}
                  />
                  <span className="text-xs font-semibold text-[#0F2744]">
                    {recState === 'recording' ? 'Recording Customer Follow-up...' : 'Recording Paused'}
                  </span>
                </div>
                <span className="font-mono text-xs font-bold text-[#DC2626] tabular-nums">
                  {formatDurationMmSs(elapsedSeconds)}
                </span>
              </div>

              {/* Audio level meter bars (no playback exposed) */}
              <div className="h-7 flex items-end gap-1 px-1 bg-slate-50 rounded border border-slate-100 py-1">
                {levels.map((lvl, idx) => (
                  <div
                    key={idx}
                    className={`flex-1 rounded-sm transition-all duration-75 ${
                      recState === 'paused' ? 'bg-amber-400' : 'bg-[#EA580C]'
                    }`}
                    style={{ height: `${recState === 'paused' ? 18 : lvl}%` }}
                  />
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleTogglePause}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-[#0F2744]"
                >
                  {recState === 'recording' ? (
                    <>
                      <Pause className="w-3.5 h-3.5" />
                      Pause
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      Resume
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleStopAndSave}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold"
                >
                  <Square className="w-3.5 h-3.5" />
                  Stop &amp; Save Recording
                </button>
                <button
                  type="button"
                  onClick={handleDiscardRecording}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-[#DC2626] hover:bg-red-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Discard
                </button>
              </div>
            </div>
          )}

          {recState === 'uploading' && (
            <div className="text-xs font-medium text-[#0F2744] py-1">
              Uploading follow-up call recording securely...
            </div>
          )}

          {errorMsg && (
            <div className="px-2.5 py-1.5 rounded bg-red-50 border border-red-200 text-[11px] text-[#DC2626]">
              {errorMsg}
            </div>
          )}
          {successMsg && (
            <div className="px-2.5 py-1.5 rounded bg-green-50 border border-green-200 text-[11px] text-[#15803D] font-medium">
              {successMsg}
            </div>
          )}
        </div>
      )}

      {/* Recordings List */}
      {recordings.length > 0 ? (
        <div className="space-y-2">
          {recordings.map((rec) => (
            <div
              key={rec.id}
              className="p-3 rounded-xl border border-slate-200 bg-white text-xs space-y-1.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                  <span className="font-mono text-[11px] font-bold text-[#0F2744]">{rec.recordingCode}</span>
                  <span className="text-slate-700 font-semibold truncate">{rec.recordedByName}</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-[10px] font-semibold text-slate-600">
                    {ROLE_BADGE_LABELS[rec.recordedByRole] || rec.recordedByRole}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
                  <span className="font-semibold text-[#0F2744]">{formatDurationMmSs(rec.durationSeconds)}</span>
                  <span>·</span>
                  <span>{formatBytesCompact(rec.fileSize)}</span>
                  <span>·</span>
                  <span className="text-[#EA580C] font-sans font-semibold">
                    {formatRemainingRetention(rec.expiresAt)}
                  </span>
                </div>
              </div>

              <div className="text-[11px] text-slate-500 flex flex-wrap items-center justify-between gap-2">
                <span>Recorded on {formatDateTime(rec.createdAt)}</span>
                <span>Auto-deletes {formatDateTime(rec.expiresAt)}</span>
              </div>

              {rec.callNotes && (
                <div className="px-2.5 py-1.5 rounded bg-slate-50 border border-slate-100 text-[11px] text-slate-700">
                  {rec.callNotes}
                </div>
              )}

              {isAdmin && rec.canPlayOrShare ? (
                <FollowupRecordingAdminControls
                  rec={rec}
                  leadCode={leadCode}
                  customerName={customerName}
                  onUpdated={onRecordingSaved}
                />
              ) : (
                <div className="mt-1.5 px-2.5 py-2 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between gap-2 text-[11px] text-slate-600">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-[#0F2744]">
                    <Lock className="w-3.5 h-3.5 text-[#EA580C]" />
                    Locked · Only Super Admin can listen or share this call recording
                  </span>
                  <span className="inline-flex items-center gap-1 text-[#15803D] font-semibold shrink-0">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Saved
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          No active call recordings logged for this lead yet. Recordings stay available to Super Admin for 7 days before automatic deletion.
        </div>
      )}
    </div>
  );
};
