import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Lock, RefreshCw, Search, ShieldCheck, Volume2 } from 'lucide-react';
import type { FollowupRecordingRecord } from '../../shared/types';
import { apiFetch, formatDateTime } from '../lib/api';
import {
  FollowupRecordingAdminControls,
  formatBytesCompact,
  formatDurationMmSs,
  formatRemainingRetention,
} from './FollowupCallRecorder';

interface AdminCallRecordingsVaultProps {
  onOpenLead: (leadId: number) => void;
}

export const AdminCallRecordingsVault: React.FC<AdminCallRecordingsVaultProps> = ({ onOpenLead }) => {
  const [recordings, setRecordings] = useState<FollowupRecordingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'ALL' | 'FIELD_OFFICER' | 'LEAD_GENERATOR'>('ALL');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadRecordings = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch<{ recordings: FollowupRecordingRecord[] }>('/followup-recordings');
      setRecordings(res.recordings || []);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load follow-up recordings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRecordings();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recordings.filter((rec) => {
      if (roleFilter !== 'ALL' && rec.recordedByRole !== roleFilter) return false;
      if (!q) return true;
      return (
        rec.recordingCode.toLowerCase().includes(q) ||
        (rec.leadCode || '').toLowerCase().includes(q) ||
        (rec.customerName || '').toLowerCase().includes(q) ||
        rec.recordedByName.toLowerCase().includes(q) ||
        (rec.callNotes || '').toLowerCase().includes(q)
      );
    });
  }, [recordings, query, roleFilter]);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Volume2 className="w-5 h-5 text-[#EA580C]" />
            <h2 className="text-base font-display font-bold text-[#0F2744]">
              Admin Call Recordings Vault (7-Day Auto-Delete)
            </h2>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Listen, download, and share customer follow-up conversations recorded by Field Officers and Lead Generation Staff. Strictly visible to Super Admin only.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-50 border border-emerald-200 text-[11px] font-semibold text-[#15803D]">
            <ShieldCheck className="w-3.5 h-3.5" />
            Admin-Only Playback
          </span>
          <button
            type="button"
            onClick={() => void loadRecordings()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-[#0F2744]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by Lead ID, Customer, Staff name, or Call notes..."
            className="w-full pl-9 pr-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:border-[#0F2744]"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as any)}
          className="px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700"
        >
          <option value="ALL">All Staff ({recordings.length})</option>
          <option value="FIELD_OFFICER">Field Officers</option>
          <option value="LEAD_GENERATOR">Lead Gen Team</option>
        </select>
      </div>

      {errorMsg && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[#DC2626]">{errorMsg}</div>
      )}

      {loading ? (
        <div className="py-10 text-center text-xs text-slate-500">Loading active 7-day call recordings...</div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center space-y-2 border border-dashed border-slate-200 rounded-xl bg-slate-50">
          <Lock className="w-6 h-6 text-slate-400 mx-auto" />
          <div className="text-xs font-semibold text-slate-700">No active follow-up recordings found</div>
          <div className="text-[11px] text-slate-500 max-w-md mx-auto">
            Field Officers and Back Office Lead Generation staff can record or attach customer call audio directly inside any Lead&apos;s Follow-up panel. Recordings remain here for 7 days.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map((rec) => (
            <div key={rec.id} className="p-4 rounded-xl border border-slate-200 bg-white space-y-2 shadow-xs">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-[#0F2744]">
                      {rec.leadCode || `Lead #${rec.leadId}`}
                    </span>
                    <span className="text-xs font-semibold text-slate-800">{rec.customerName || 'Customer'}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    By <span className="font-semibold text-slate-700">{rec.recordedByName}</span> ({rec.recordedByCode} ·{' '}
                    {rec.recordedByRole === 'FIELD_OFFICER'
                      ? 'Field Officer'
                      : rec.recordedByRole === 'LEAD_GENERATOR'
                        ? 'Lead Gen Team'
                        : rec.recordedByRole.replace('_', ' ')}
                    )
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-orange-50 border border-orange-200 text-[10px] font-semibold text-[#EA580C]">
                    <Clock className="w-3 h-3" />
                    {formatRemainingRetention(rec.expiresAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenLead(rec.leadId)}
                    className="px-2.5 py-1 rounded border border-slate-300 hover:bg-slate-50 text-[11px] font-semibold text-[#0F2744]"
                  >
                    Open Lead
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 font-mono">
                <span>
                  {rec.recordingCode} · {formatDurationMmSs(rec.durationSeconds)} · {formatBytesCompact(rec.fileSize)}
                </span>
                <span className="font-sans">Recorded {formatDateTime(rec.createdAt)}</span>
              </div>

              {rec.callNotes && (
                <div className="px-2.5 py-1.5 rounded bg-slate-50 border border-slate-100 text-xs text-slate-700">
                  {rec.callNotes}
                </div>
              )}

              <FollowupRecordingAdminControls
                rec={rec}
                leadCode={rec.leadCode || `Lead #${rec.leadId}`}
                customerName={rec.customerName || 'Customer'}
                onUpdated={loadRecordings}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
