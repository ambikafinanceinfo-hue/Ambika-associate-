import React, { useEffect, useState } from 'react';
import { Bell, CheckCheck, Check } from 'lucide-react';
import { ALERT_CATEGORIES, type AlertRecord } from '../../shared/types';
import { apiFetch, formatDateTime } from '../lib/api';
import { t, type Lang } from '../lib/i18n';

interface AlertCentreViewProps {
  alerts: AlertRecord[];
  lang: Lang;
  activeOption?: 'ALL' | 'UNREAD' | 'READ' | null;
  onSelectOption?: (opt: 'ALL' | 'UNREAD' | 'READ') => void;
  onRefresh: () => void;
  onOpenRelated: (alert: AlertRecord) => void;
}

export const AlertCentreView: React.FC<AlertCentreViewProps> = ({
  alerts,
  lang,
  activeOption,
  onSelectOption,
  onRefresh,
  onOpenRelated,
}) => {
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [readFilter, setReadFilter] = useState<'ALL' | 'UNREAD' | 'READ'>(
    activeOption && ['ALL', 'UNREAD', 'READ'].includes(activeOption) ? activeOption : 'ALL'
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (activeOption && ['ALL', 'UNREAD', 'READ'].includes(activeOption)) {
      setReadFilter(activeOption);
    } else if (activeOption === null) {
      setReadFilter('ALL');
    }
  }, [activeOption]);

  const filtered = alerts.filter((a) => {
    if (categoryFilter !== 'ALL' && a.category !== categoryFilter) return false;
    if (readFilter === 'UNREAD' && a.isRead) return false;
    if (readFilter === 'READ' && !a.isRead) return false;
    return true;
  });

  const unreadCount = alerts.filter((a) => !a.isRead).length;

  const markOneRead = async (id: number) => {
    setBusy(true);
    try {
      await apiFetch(`/alerts/${id}/read`, { method: 'PATCH' });
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const markAllRead = async () => {
    setBusy(true);
    try {
      await apiFetch('/alerts/read-all', { method: 'PATCH' });
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center border ${
              unreadCount > 0
                ? 'bg-red-50 border-red-200 text-red-600'
                : 'bg-green-50 border-green-200 text-green-600'
            }`}
          >
            <Bell className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-display font-bold text-[#0F2744]">
              {t(lang, 'navAlerts')}
            </h1>
            <p className="text-xs text-slate-500 tabular-nums">
              {unreadCount > 0
                ? `${unreadCount} ${t(lang, 'unreadAlerts')}`
                : t(lang, 'allAlertsRead')}
            </p>
          </div>
        </div>

        <button
          type="button"
          disabled={busy || unreadCount === 0}
          onClick={markAllRead}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold disabled:opacity-40 whitespace-nowrap"
        >
          <CheckCheck className="w-4 h-4" />
          {t(lang, 'markAllRead')}
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700"
          >
            <option value="ALL">All Alert Categories</option>
            {ALERT_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(['ALL', 'UNREAD', 'READ'] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => {
                  setReadFilter(status);
                  onSelectOption?.(status);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  readFilter === status
                    ? 'bg-white text-[#0F2744] shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {status === 'ALL' ? 'All' : status === 'UNREAD' ? 'Unread' : 'Read History'}
              </button>
            ))}
          </div>
        </div>

        <span className="text-xs text-slate-500 tabular-nums">
          Showing {filtered.length} of {alerts.length} alerts
        </span>
      </div>

      {/* Alerts List */}
      <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
        {filtered.map((alert) => (
          <div
            key={alert.id}
            className={`p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-colors ${
              alert.isRead ? 'bg-white' : 'bg-orange-50/40'
            }`}
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-mono font-semibold text-slate-700">{alert.alertCode}</span>
                <span aria-hidden="true">·</span>
                <span className="font-medium text-[#EA580C]">{alert.category}</span>
                {alert.leadCode && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-[#0F2744]">{alert.leadCode}</span>
                  </>
                )}
                {alert.enquiryCode && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono text-[#0F2744]">{alert.enquiryCode}</span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{formatDateTime(alert.createdAt)}</span>
                <span aria-hidden="true">·</span>
                <span className={alert.isRead ? 'text-[#15803D]' : 'text-[#DC2626] font-semibold'}>
                  {alert.isRead ? 'Read' : 'Unread'}
                </span>
              </div>

              <div className="text-sm font-semibold text-[#0F2744]">
                {lang === 'hi' ? alert.titleHi : alert.titleEn}
              </div>
              <p className="text-sm text-slate-600">
                {lang === 'hi' ? alert.messageHi : alert.messageEn}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {(alert.leadId || alert.enquiryId) && (
                <button
                  type="button"
                  onClick={() => onOpenRelated(alert)}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 whitespace-nowrap"
                >
                  Inspect Record
                </button>
              )}
              {!alert.isRead && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => markOneRead(alert.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#15803D] hover:bg-green-800 text-white whitespace-nowrap"
                >
                  <Check className="w-3.5 h-3.5" />
                  {t(lang, 'markRead')}
                </button>
              )}
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="p-10 text-center text-sm text-slate-500">
            No alerts match the selected filter.
          </div>
        )}
      </div>
    </div>
  );
};
