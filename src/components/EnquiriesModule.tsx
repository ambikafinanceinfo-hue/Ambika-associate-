import React, { useEffect, useState } from 'react';
import { ArrowLeft, Clock, MessageSquarePlus, PhoneCall, Send } from 'lucide-react';
import {
  ENQUIRY_CATEGORIES,
  ENQUIRY_STATUSES,
  type AuthUser,
  type EnquiryRecord,
  type LeadRecord,
} from '../../shared/types';
import { apiFetch, buildTelHref, formatDateTime } from '../lib/api';

interface EnquiriesModuleProps {
  user: AuthUser;
  activeOption?: string | null;
  onSelectOption?: (opt: string | null) => void;
  onAlertsChanged: () => void;
}

export const EnquiriesModule: React.FC<EnquiriesModuleProps> = ({
  user,
  activeOption,
  onSelectOption,
  onAlertsChanged,
}) => {
  const [enquiries, setEnquiries] = useState<EnquiryRecord[]>([]);
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [officers, setOfficers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNew, setShowNew] = useState(activeOption === 'new');

  useEffect(() => {
    setShowNew(activeOption === 'new');
  }, [activeOption]);
  const [newForm, setNewForm] = useState({
    leadId: '',
    category: ENQUIRY_CATEGORIES[0] as string,
    description: '',
  });
  const [solutionInputs, setSolutionInputs] = useState<Record<number, string>>({});
  const [statusInputs, setStatusInputs] = useState<Record<number, string>>({});
  const [assignInputs, setAssignInputs] = useState<Record<number, string>>({});

  const isReferral = user.role === 'REFERRAL_PARTNER';
  const canRespond = !isReferral;

  const load = async () => {
    setLoading(true);
    try {
      const [enqRes, leadRes, dirRes] = await Promise.all([
        apiFetch<{ enquiries: EnquiryRecord[] }>('/enquiries'),
        apiFetch<{ leads: LeadRecord[] }>('/leads'),
        apiFetch<any>('/directory'),
      ]);
      setEnquiries(enqRes.enquiries);
      setLeads(leadRes.leads);
      setOfficers(dirRes.fieldOfficers || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const createEnquiry = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/enquiries', {
      method: 'POST',
      json: {
        leadId: newForm.leadId ? Number(newForm.leadId) : undefined,
        category: newForm.category,
        description: newForm.description,
      },
    });
    setNewForm({ leadId: '', category: ENQUIRY_CATEGORIES[0], description: '' });
    setShowNew(false);
    await load();
    onAlertsChanged();
  };

  const respondEnquiry = async (id: number) => {
    await apiFetch(`/enquiries/${id}/respond`, {
      method: 'PATCH',
      json: {
        solutionText: solutionInputs[id] || undefined,
        status: statusInputs[id] || undefined,
        assignedOfficerId: assignInputs[id] ? Number(assignInputs[id]) : undefined,
      },
    });
    setSolutionInputs({ ...solutionInputs, [id]: '' });
    await load();
    onAlertsChanged();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            Referral Enquiry &amp; Help Desk
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {isReferral
              ? 'Create enquiries for your leads and track your own enquiry status and solution.'
              : '1-Hour SLA active on assigned enquiries. Late resolution triggers ₹10 penalty pending Admin approval.'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            const next = !showNew;
            setShowNew(next);
            onSelectOption?.(next ? 'new' : null);
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold whitespace-nowrap"
        >
          {showNew ? <ArrowLeft className="w-4 h-4" /> : <MessageSquarePlus className="w-4 h-4" />}
          {showNew ? 'Back to Enquiries' : 'Create Enquiry'}
        </button>
      </div>

      {showNew && (
        <form onSubmit={createEnquiry} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100">
            <h2 className="text-sm font-display font-bold text-[#0F2744]">New Help Desk Enquiry (1-Hr SLA)</h2>
            <button
              type="button"
              onClick={() => {
                setShowNew(false);
                onSelectOption?.(null);
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-[#0F2744]"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Related Lead (Optional)</label>
              <select
                value={newForm.leadId}
                onChange={(e) => setNewForm({ ...newForm, leadId: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="">General Enquiry</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.leadCode} — {l.customerName} ({l.status})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Enquiry Category *</label>
              <select
                value={newForm.category}
                onChange={(e) => setNewForm({ ...newForm, category: e.target.value })}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                {ENQUIRY_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Enquiry Description *</label>
              <textarea
                required
                rows={3}
                value={newForm.description}
                onChange={(e) => setNewForm({ ...newForm, description: e.target.value })}
                placeholder="Describe the assistance needed..."
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowNew(false)}
              className="px-4 py-2 text-xs font-medium border border-slate-300 rounded-lg text-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#EA580C] text-white hover:bg-[#C2410C]"
            >
              Submit Enquiry
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="p-8 bg-white border border-slate-200 rounded-xl text-center text-xs text-slate-500">
          Loading enquiries...
        </div>
      ) : enquiries.length === 0 ? (
        <div className="p-10 bg-white border border-slate-200 rounded-xl text-center text-sm text-slate-500">
          No enquiries found.
        </div>
      ) : (
        <div className="space-y-4">
          {enquiries.map((enq) => (
            <div key={enq.id} className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-slate-100">
                <div>
                  <div className="text-xs text-slate-500 flex flex-wrap items-center gap-2">
                    <span className="font-mono font-bold text-[#0F2744]">{enq.enquiryCode}</span>
                    {enq.leadCode && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-[#EA580C]">{enq.leadCode}</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{enq.category}</span>
                    <span aria-hidden="true">·</span>
                    <span>By {enq.referralName}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDateTime(enq.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-800">{enq.description}</p>
                </div>

                <div className="text-right text-xs shrink-0">
                  <div
                    className={`font-bold ${
                      enq.status === 'Resolved' || enq.status === 'Closed' || enq.status === 'Solution Updated'
                        ? 'text-[#15803D]'
                        : 'text-[#EA580C]'
                    }`}
                  >
                    {enq.status}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 flex items-center justify-end gap-1">
                    <Clock className="w-3 h-3" />
                    SLA: {formatDateTime(enq.slaDeadlineAt)}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
                <div>
                  Responsible Officer:{' '}
                  <strong>{enq.assignedOfficerName || 'Unassigned'}</strong>
                  {enq.assignedOfficerMobile && (
                    <>
                      {' · '}
                      <a
                        href={buildTelHref(enq.assignedOfficerMobile)}
                        className="inline-flex items-center gap-1 font-mono font-semibold text-[#15803D] hover:underline"
                      >
                        <PhoneCall className="w-3 h-3 shrink-0" />
                        <span>{enq.assignedOfficerMobile}</span>
                      </a>
                    </>
                  )}
                </div>
                {enq.penaltyGenerated && (
                  <span className="text-[#DC2626] font-semibold">1-Hour SLA Exceeded (₹10 Penalty Logged)</span>
                )}
              </div>

              {enq.solutionText && (
                <div className="p-3.5 rounded-lg bg-green-50 border border-green-200 text-xs text-green-950">
                  <div className="font-semibold text-[#15803D]">
                    Solution / Action Taken ({formatDateTime(enq.solutionUpdatedAt)})
                  </div>
                  <p className="mt-1">{enq.solutionText}</p>
                </div>
              )}

              {canRespond && (
                <div className="pt-2 flex flex-col sm:flex-row gap-2">
                  {user.role !== 'FIELD_OFFICER' && (
                    <select
                      value={assignInputs[enq.id] ?? (enq.assignedOfficerId ? String(enq.assignedOfficerId) : '')}
                      onChange={(e) => setAssignInputs({ ...assignInputs, [enq.id]: e.target.value })}
                      className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Assign Officer...</option>
                      {officers.map((fo) => (
                        <option key={fo.id} value={fo.id}>
                          {fo.fullName}
                        </option>
                      ))}
                    </select>
                  )}
                  <select
                    value={statusInputs[enq.id] || enq.status}
                    onChange={(e) => setStatusInputs({ ...statusInputs, [enq.id]: e.target.value })}
                    className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    {ENQUIRY_STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={solutionInputs[enq.id] || ''}
                    onChange={(e) => setSolutionInputs({ ...solutionInputs, [enq.id]: e.target.value })}
                    placeholder="Enter solution / action taken..."
                    className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                  <button
                    type="button"
                    onClick={() => respondEnquiry(enq.id)}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold whitespace-nowrap"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Update Solution
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
