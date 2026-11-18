import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, ShieldAlert } from 'lucide-react';
import type { AuthUser, DuplicateRequestRecord, PenaltyRecord } from '../../shared/types';
import { apiFetch, formatDateTime, formatInr } from '../lib/api';

interface DuplicateApprovalProps {
  activeOption?: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  onSelectOption?: (opt: 'PENDING' | 'APPROVED' | 'REJECTED') => void;
  onChanged: () => void;
}

export const DuplicateApprovalView: React.FC<DuplicateApprovalProps> = ({
  activeOption,
  onSelectOption,
  onChanged,
}) => {
  const [requests, setRequests] = useState<DuplicateRequestRecord[]>([]);
  const [tab, setTab] = useState<'PENDING' | 'APPROVED' | 'REJECTED'>(
    activeOption && ['PENDING', 'APPROVED', 'REJECTED'].includes(activeOption) ? activeOption : 'PENDING'
  );

  useEffect(() => {
    if (activeOption && ['PENDING', 'APPROVED', 'REJECTED'].includes(activeOption)) {
      setTab(activeOption);
    } else if (activeOption === null) {
      setTab('PENDING');
    }
  }, [activeOption]);
  const [fieldOfficers, setFieldOfficers] = useState<any[]>([]);
  const [remarksMap, setRemarksMap] = useState<Record<number, string>>({});
  const [assignMap, setAssignMap] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [dupRes, dirRes] = await Promise.all([
        apiFetch<{ requests: DuplicateRequestRecord[] }>('/duplicates'),
        apiFetch<any>('/directory'),
      ]);
      setRequests(dupRes.requests);
      setFieldOfficers(dirRes.fieldOfficers || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleDecision = async (id: number, action: 'approve' | 'reject') => {
    await apiFetch(`/duplicates/${id}/${action}`, {
      method: 'POST',
      json: {
        remarks: remarksMap[id] || '',
        assignedOfficerId: assignMap[id] ? Number(assignMap[id]) : undefined,
      },
    });
    await load();
    onChanged();
  };

  const filtered = requests.filter((r) => r.status === tab);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            Admin Duplicate Verification &amp; Approval
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Review held duplicate lead requests before creating a new Lead ID or rejecting.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          {(['PENDING', 'APPROVED', 'REJECTED'] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => {
                setTab(status);
                onSelectOption?.(status);
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                tab === status ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {status} ({requests.filter((r) => r.status === status).length})
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="p-8 bg-white border border-slate-200 rounded-xl text-center text-xs text-slate-500">
          Loading duplicate verification queue...
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-10 bg-white border border-slate-200 rounded-xl text-center text-sm text-slate-500">
          No {tab.toLowerCase()} duplicate requests.
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((req) => (
            <div key={req.id} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-slate-100">
                <div>
                  <div className="text-xs text-slate-500 flex flex-wrap items-center gap-2">
                    <span className="font-mono font-bold text-[#0F2744]">{req.requestCode}</span>
                    <span aria-hidden="true">·</span>
                    <span>Matched Existing Lead: <strong className="font-mono">{req.existingLeadCode}</strong> ({req.existingCustomerName})</span>
                    <span aria-hidden="true">·</span>
                    <span>Submitted by {req.submittedByName}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDateTime(req.createdAt)}</span>
                  </div>
                  <div className="mt-1.5 text-xs font-semibold text-[#DC2626]">
                    Matched Fields: {req.matchedFields.join(' · ')}
                  </div>
                </div>
                <span
                  className={`text-xs font-bold ${
                    req.status === 'APPROVED'
                      ? 'text-[#15803D]'
                      : req.status === 'REJECTED'
                      ? 'text-[#DC2626]'
                      : 'text-[#D97706]'
                  }`}
                >
                  {req.status}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                <div>
                  <span className="text-slate-500">Customer Name:</span>{' '}
                  <strong className="text-slate-900">{String(req.submittedPayload.customerName || '—')}</strong>
                </div>
                <div>
                  <span className="text-slate-500">Mobile:</span>{' '}
                  <strong className="font-mono text-slate-900">{String(req.submittedPayload.customerMobile || '—')}</strong>
                </div>
                <div>
                  <span className="text-slate-500">PAN:</span>{' '}
                  <strong className="font-mono text-slate-900">{String(req.submittedPayload.panNumber || '—')}</strong>
                </div>
                <div>
                  <span className="text-slate-500">Loan Product &amp; Amt:</span>{' '}
                  <strong className="text-slate-900">
                    {String(req.submittedPayload.loanProduct || '')} · {formatInr(Number(req.submittedPayload.loanAmount || 0))}
                  </strong>
                </div>
              </div>

              {req.status === 'PENDING' ? (
                <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center pt-1">
                  <select
                    value={assignMap[req.id] || ''}
                    onChange={(e) => setAssignMap({ ...assignMap, [req.id]: e.target.value })}
                    className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">Assign Field Officer on Approval (Optional)</option>
                    {fieldOfficers.map((fo) => (
                      <option key={fo.id} value={fo.id}>
                        {fo.fullName} ({fo.employeeCode})
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={remarksMap[req.id] || ''}
                    onChange={(e) => setRemarksMap({ ...remarksMap, [req.id]: e.target.value })}
                    placeholder="Admin verification remarks..."
                    className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleDecision(req.id, 'approve')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      APPROVE
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDecision(req.id, 'reject')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#DC2626] hover:bg-red-700 text-white text-xs font-semibold"
                    >
                      <XCircle className="w-4 h-4" />
                      REJECT
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-600">
                  Reviewed by <strong>{req.reviewedByName}</strong> at {formatDateTime(req.reviewedAt)} · Remarks:{' '}
                  {req.reviewRemarks || '—'}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface PenaltyRegisterProps {
  user: AuthUser;
  onChanged: () => void;
}

export const PenaltyRegisterView: React.FC<PenaltyRegisterProps> = ({ user, onChanged }) => {
  const [penalties, setPenalties] = useState<PenaltyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [remarksMap, setRemarksMap] = useState<Record<number, string>>({});

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ penalties: PenaltyRecord[] }>('/penalties');
      setPenalties(res.penalties);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const decide = async (id: number, decision: 'APPROVED' | 'REJECTED') => {
    await apiFetch(`/penalties/${id}/decision`, {
      method: 'PATCH',
      json: { decision, remarks: remarksMap[id] || '' },
    });
    await load();
    onChanged();
  };

  const isAdmin = user.role === 'SUPER_ADMIN';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            SLA Penalty Register &amp; Admin Review
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            10-min Lead Assignment SLA (₹10), 10-min Follow-up SLA (₹10), and 1-hr Enquiry SLA (₹10). Requires Admin approval before finalization.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <ShieldAlert className="w-4 h-4 text-[#EA580C]" />
          <span className="tabular-nums font-semibold">
            {penalties.filter((p) => p.approvalStatus === 'PENDING').length} Pending Review
          </span>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
              <tr>
                <th className="text-left font-semibold px-4 py-3">Employee</th>
                <th className="text-left font-semibold px-4 py-3">Lead / Enquiry</th>
                <th className="text-left font-semibold px-4 py-3">Penalty Type</th>
                <th className="text-left font-semibold px-4 py-3">Event &amp; Deadline</th>
                <th className="text-left font-semibold px-4 py-3">Actual Update &amp; Delay</th>
                <th className="text-right font-semibold px-4 py-3">Amount</th>
                <th className="text-left font-semibold px-4 py-3">Approval Status</th>
                {isAdmin && <th className="text-right font-semibold px-4 py-3">Admin Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                    Loading penalty register...
                  </td>
                </tr>
              )}
              {!loading &&
                penalties.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{p.employeeName}</div>
                      <div className="font-mono text-[11px] text-slate-500">{p.employeeCode}</div>
                    </td>
                    <td className="px-4 py-3 font-mono font-semibold text-[#0F2744]">
                      {p.leadCode || p.enquiryCode || '—'}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-700">
                      {p.penaltyType === 'LEAD_ASSIGNMENT_10M'
                        ? 'Lead Assignment (10m)'
                        : p.penaltyType === 'FOLLOWUP_REMINDER_10M'
                        ? 'Follow-up Reminder (10m)'
                        : 'Enquiry SLA (1 hr)'}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[11px] text-slate-600">
                      <div>Evt: {formatDateTime(p.eventAt)}</div>
                      <div>Due: {formatDateTime(p.deadlineAt)}</div>
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-[11px] text-slate-600">
                      <div>Upd: {p.actualUpdateAt ? formatDateTime(p.actualUpdateAt) : 'Not updated yet'}</div>
                      <div className="text-[#DC2626] font-semibold">
                        Delay: {Math.floor(p.delaySeconds / 60)}m {p.delaySeconds % 60}s
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums font-bold text-[#DC2626]">
                      {formatInr(p.amount)}
                    </td>
                    <td className="px-4 py-3 font-semibold">
                      <span
                        className={
                          p.approvalStatus === 'APPROVED'
                            ? 'text-[#DC2626]'
                            : p.approvalStatus === 'REJECTED'
                            ? 'text-slate-500'
                            : 'text-[#D97706]'
                        }
                      >
                        {p.approvalStatus}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3 text-right">
                        {p.approvalStatus === 'PENDING' ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <input
                              type="text"
                              value={remarksMap[p.id] || ''}
                              onChange={(e) => setRemarksMap({ ...remarksMap, [p.id]: e.target.value })}
                              placeholder="Note"
                              className="w-24 px-2 py-1 text-[11px] border border-slate-300 rounded"
                            />
                            <button
                              type="button"
                              onClick={() => decide(p.id, 'APPROVED')}
                              className="px-2.5 py-1 rounded bg-[#DC2626] text-white text-[11px] font-semibold"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => decide(p.id, 'REJECTED')}
                              className="px-2.5 py-1 rounded bg-slate-200 text-slate-700 text-[11px] font-semibold"
                            >
                              Waive
                            </button>
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">
                            {p.reviewedByName || 'Reviewed'}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              {!loading && penalties.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                    No SLA penalty events recorded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
