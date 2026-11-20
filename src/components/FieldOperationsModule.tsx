import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  Bike,
  MapPin,
  Navigation,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Route,
  FileDown,
  Scissors,
  Calendar,
} from 'lucide-react';
import type { AuthUser, LeadRecord } from '../../shared/types';
import { apiFetch, formatDateTime, formatInr } from '../lib/api';
import { FieldGpsTimelineView } from './FieldGpsTimelineView';

interface FieldOperationsModuleProps {
  user: AuthUser;
  activeOption?: 'gps' | 'timeline' | 'bike' | null;
  onSelectOption?: (opt: 'gps' | 'timeline' | 'bike') => void;
  onAlertsChanged: () => void;
}

function getMondayIsoDate(refDate = new Date()): string {
  const d = new Date(refDate);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysIsoDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function parseSqlUtcMs(value: string | null | undefined): number {
  if (!value) return 0;
  const s = String(value);
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z');
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

export const FieldOperationsModule: React.FC<FieldOperationsModuleProps> = ({
  user,
  activeOption,
  onSelectOption,
  onAlertsChanged,
}) => {
  const [subTab, setSubTab] = useState<'gps' | 'timeline' | 'bike'>(
    activeOption === 'bike' || activeOption === 'timeline' ? activeOption : 'gps'
  );

  useEffect(() => {
    if (activeOption === 'gps' || activeOption === 'timeline' || activeOption === 'bike') {
      setSubTab(activeOption);
    } else if (activeOption === null) {
      setSubTab('gps');
    }
  }, [activeOption]);

  const [gpsLogs, setGpsLogs] = useState<any[]>([]);
  const [bikeRuns, setBikeRuns] = useState<any[]>([]);
  const [petrolRate, setPetrolRate] = useState(3.0);
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [consentChecked, setConsentChecked] = useState(user.gpsConsent);
  const [gpsActive, setGpsActive] = useState(false);

  // Location state
  const [coords, setCoords] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [locError, setLocError] = useState<string | null>(null);

  // Visit Check-In / Check-Out form
  const [visitLeadId, setVisitLeadId] = useState('');
  const [visitCustomer, setVisitCustomer] = useState('');
  const [visitNotes, setVisitNotes] = useState('');

  // Bike Run Start form
  const [openingOdo, setOpeningOdo] = useState('');
  const [bikeLeadId, setBikeLeadId] = useState('');
  const [bikeCustomerName, setBikeCustomerName] = useState('');
  const [bikeTourReason, setBikeTourReason] = useState('');
  const [bikeStartLocation, setBikeStartLocation] = useState('');

  // Bike Run Stop form
  const [closingOdo, setClosingOdo] = useState('');
  const [simExtraKm, setSimExtraKm] = useState('');
  const [stopCustomerName, setStopCustomerName] = useState('');
  const [stopTourReason, setStopTourReason] = useState('');
  const [stopEndLocation, setStopEndLocation] = useState('');

  // Seniority manager decision inputs per run ID
  const [mgrKmMap, setMgrKmMap] = useState<Record<number, string>>({});
  const [mgrDeductMap, setMgrDeductMap] = useState<Record<number, string>>({});
  const [mgrNoteMap, setMgrNoteMap] = useState<Record<number, string>>({});

  // Weekly Bike Run Chart & PDF Bill Filter state
  const [weekMode, setWeekMode] = useState<'week' | 'all'>('week');
  const [weekStartDate, setWeekStartDate] = useState<string>(() => getMondayIsoDate());
  const [weekEmployeeFilter, setWeekEmployeeFilter] = useState<string>('ALL');

  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadAll = async () => {
    const [gRes, bRes, lRes] = await Promise.all([
      apiFetch<{ logs: any[] }>('/gps'),
      apiFetch<{ runs: any[]; petrolRatePerKm: number }>('/bike-runs'),
      apiFetch<{ leads: LeadRecord[] }>('/leads'),
    ]);
    setGpsLogs(gRes.logs);
    setBikeRuns(bRes.runs);
    setPetrolRate(Number(bRes.petrolRatePerKm || 3.0));
    setLeads(lRes.leads);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const captureBrowserGps = (): Promise<{ lat: number; lng: number; accuracy: number }> => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        setLocError('Browser geolocation unavailable; using Satna Head Office verification coordinates.');
        const fallback = { lat: 24.5773 + Math.random() * 0.01, lng: 80.8272 + Math.random() * 0.01, accuracy: 25 };
        setCoords(fallback);
        resolve(fallback);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const c = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
          };
          setCoords(c);
          setLocError(null);
          resolve(c);
        },
        () => {
          setLocError('GPS permission denied or unavailable on desktop; recorded fallback verification coordinates.');
          const fallback = { lat: 19.076 + Math.random() * 0.015, lng: 72.8777 + Math.random() * 0.015, accuracy: 30 };
          setCoords(fallback);
          resolve(fallback);
        },
        { enableHighAccuracy: true, timeout: 5000 }
      );
    });
  };

  const recordGpsActivity = async (
    activityType: 'TRACKING_START' | 'TRACKING_PING' | 'TRACKING_STOP' | 'VISIT_CHECKIN' | 'VISIT_CHECKOUT'
  ) => {
    setErrorMsg(null);
    if (!consentChecked) {
      setLocError('Please confirm Employee GPS Consent before tracking or checking in.');
      return;
    }
    const c = await captureBrowserGps();
    await apiFetch('/gps', {
      method: 'POST',
      json: {
        latitude: c.lat,
        longitude: c.lng,
        accuracy: c.accuracy,
        activityType,
        leadId: visitLeadId ? Number(visitLeadId) : undefined,
        customerName: visitCustomer || undefined,
        visitNotes: visitNotes || undefined,
        consentConfirmed: true,
      },
    });
    if (activityType === 'TRACKING_START') setGpsActive(true);
    if (activityType === 'TRACKING_STOP') setGpsActive(false);
    setStatusMsg(`Recorded ${activityType} at (${c.lat.toFixed(4)}, ${c.lng.toFixed(4)})`);
    await loadAll();
    onAlertsChanged();
  };

  const activeRun = bikeRuns.find((r) => r.employeeId === user.id && r.status === 'ACTIVE');

  useEffect(() => {
    if (activeRun) {
      setStopCustomerName(activeRun.customerName || '');
      setStopTourReason(activeRun.tourReason || '');
    }
  }, [activeRun?.id]);

  const handleStartBikeRun = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    if (!consentChecked) {
      setLocError('Employee GPS consent is required for GPS Bike Run.');
      return;
    }
    try {
      const c = await captureBrowserGps();
      await apiFetch('/bike-runs/start', {
        method: 'POST',
        json: {
          openingOdometer: Number(openingOdo),
          latitude: c.lat,
          longitude: c.lng,
          leadId: bikeLeadId ? Number(bikeLeadId) : undefined,
          customerName: bikeCustomerName.trim(),
          tourReason: bikeTourReason.trim(),
          startLocation: bikeStartLocation.trim(),
        },
      });
      setOpeningOdo('');
      setBikeLeadId('');
      setBikeCustomerName('');
      setBikeTourReason('');
      setBikeStartLocation('');
      setStatusMsg('Bike Run started with opening meter reading, customer/tour details, and GPS coordinates.');
      await loadAll();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to start bike run');
    }
  };

  const handleStopBikeRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRun) return;
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const c = await captureBrowserGps();
      const res = await apiFetch<any>(`/bike-runs/${activeRun.id}/stop`, {
        method: 'POST',
        json: {
          closingOdometer: Number(closingOdo),
          latitude: c.lat,
          longitude: c.lng,
          simulatedExtraKm: simExtraKm ? Number(simExtraKm) : 0,
          customerName: stopCustomerName.trim() || undefined,
          tourReason: stopTourReason.trim() || undefined,
          endLocation: stopEndLocation.trim() || undefined,
        },
      });
      setClosingOdo('');
      setSimExtraKm('');
      setStopEndLocation('');
      setStatusMsg(
        `Bike Run completed: GPS ${res.gpsKm} km, Meter ${res.odoKm} km, Bill @ ₹${res.ratePerKm ?? petrolRate}/km = ₹${res.incentive}`
      );
      await loadAll();
      onAlertsChanged();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to stop bike run');
    }
  };

  const handleManagerDecision = async (
    id: number,
    decision: 'APPROVED' | 'DEDUCTED' | 'REJECTED'
  ) => {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await apiFetch<any>(`/bike-runs/${id}/decision`, {
        method: 'PATCH',
        json: {
          decision,
          eligibleKm: mgrKmMap[id] ? Number(mgrKmMap[id]) : undefined,
          deductedAmount: mgrDeductMap[id] ? Number(mgrDeductMap[id]) : undefined,
          remarks: mgrNoteMap[id] || '',
        },
      });
      setStatusMsg(
        `Run #${id} marked ${res.approvalStatus}: Gross ₹${res.grossAmount}, Deducted ₹${res.deductedAmount}, Net Payable ₹${res.incentiveAmount}.`
      );
      await loadAll();
      onAlertsChanged();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to process bike run decision');
    }
  };

  // Daily / Weekly / Monthly KM Summary
  const now = Date.now();
  const completedRuns = bikeRuns.filter((r) => r.status === 'COMPLETED');
  const sumKmWithinDays = (days: number) =>
    completedRuns
      .filter((r) => {
        const ts = parseSqlUtcMs(r.startTime);
        return now - ts <= days * 86400000;
      })
      .reduce((sum, r) => sum + Number(r.eligibleKm || 0), 0);

  // Weekly Bike Run Chart & PDF Bill computation
  const weekEndDate = useMemo(() => addDaysIsoDate(weekStartDate, 6), [weekStartDate]);

  const employeeOptions = useMemo(() => {
    const map = new Map<string, { id: string; label: string }>();
    for (const r of bikeRuns) {
      const key = String(r.employeeId);
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          label: `${r.employeeName} (${r.employeeCode})`,
        });
      }
    }
    return Array.from(map.values());
  }, [bikeRuns]);

  const weeklyFilteredRuns = useMemo(() => {
    const startMs = new Date(`${weekStartDate}T00:00:00`).getTime();
    const endMs = new Date(`${weekEndDate}T23:59:59.999`).getTime();
    return completedRuns.filter((r) => {
      if (weekEmployeeFilter !== 'ALL' && String(r.employeeId) !== weekEmployeeFilter) {
        return false;
      }
      if (weekMode === 'all') return true;
      const runMs = parseSqlUtcMs(r.startTime);
      return runMs >= startMs && runMs <= endMs;
    });
  }, [completedRuns, weekEmployeeFilter, weekMode, weekStartDate, weekEndDate]);

  const weeklyTotals = useMemo(() => {
    return weeklyFilteredRuns.reduce(
      (acc, r) => {
        const km = Number(r.eligibleKm || 0);
        const rate = Number(r.ratePerKm || petrolRate || 3.0);
        const gross = Number(r.grossAmount || Math.round(km * rate * 100) / 100);
        const deducted = Number(r.deductedAmount || 0);
        const net = Number(r.incentiveAmount || 0);
        acc.runs += 1;
        acc.km += km;
        acc.gross += gross;
        acc.deducted += deducted;
        acc.net += net;
        return acc;
      },
      { runs: 0, km: 0, gross: 0, deducted: 0, net: 0 }
    );
  }, [weeklyFilteredRuns, petrolRate]);

  const exportWeeklyBikeBillPdf = () => {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const periodLabel =
      weekMode === 'all' ? 'All Completed Trips' : `${weekStartDate} to ${weekEndDate}`;
    const selectedEmpLabel =
      weekEmployeeFilter === 'ALL'
        ? 'All Visible Staff'
        : employeeOptions.find((e) => e.id === weekEmployeeFilter)?.label || 'Selected Staff';

    doc.setFontSize(14);
    doc.setTextColor(15, 39, 68);
    doc.text('AMBIKA ASSOCIATE — WEEKLY BIKE RUN & PETROL BILL', 14, 14);

    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    doc.text(
      `Period: ${periodLabel}  |  Staff Scope: ${selectedEmpLabel}  |  Configured Rate: Rs. ${petrolRate.toFixed(2)} / KM`,
      14,
      20
    );
    doc.text(
      `Generated By: ${user.fullName} (${user.employeeCode})  |  Generated At: ${new Date().toLocaleString('en-IN')}`,
      14,
      25
    );

    doc.setFontSize(9.5);
    doc.setTextColor(15, 39, 68);
    doc.text(
      `Summary -> Total Trips: ${weeklyTotals.runs}   |   Total KM: ${weeklyTotals.km.toFixed(2)} km   |   Gross Bill (@ Rs.${petrolRate.toFixed(
        2
      )}/km): Rs. ${weeklyTotals.gross.toFixed(2)}   |   Deducted: Rs. ${weeklyTotals.deducted.toFixed(
        2
      )}   |   Net Payable Bill: Rs. ${weeklyTotals.net.toFixed(2)}`,
      14,
      32
    );

    const head = [
      [
        'Run / Date & Time',
        'Employee (Role)',
        'Start Meter',
        'Close Meter',
        'GPS Location (Start -> Close)',
        'Customer Name',
        'Reason for Tour',
        'Total KM',
        'Rate/KM',
        'Bill (Rs.)',
        'Deducted',
        'Net Bill',
        'Senior Approval',
      ],
    ];

    const body = weeklyFilteredRuns.map((r) => {
      const rate = Number(r.ratePerKm || petrolRate || 3.0);
      const gross = Number(r.grossAmount || Math.round(Number(r.eligibleKm || 0) * rate * 100) / 100);
      const deducted = Number(r.deductedAmount || 0);
      const net = Number(r.incentiveAmount || 0);
      const gpsLoc =
        r.startLocation || r.endLocation
          ? `${r.startLocation || `${Number(r.startLat).toFixed(4)}, ${Number(r.startLng).toFixed(4)}`} -> ${
              r.endLocation || (r.endLat ? `${Number(r.endLat).toFixed(4)}, ${Number(r.endLng).toFixed(4)}` : '—')
            }`
          : `${Number(r.startLat).toFixed(4)}, ${Number(r.startLng).toFixed(4)} -> ${
              r.endLat ? `${Number(r.endLat).toFixed(4)}, ${Number(r.endLng).toFixed(4)}` : '—'
            }`;
      const approverText =
        r.approvalStatus === 'PENDING'
          ? `PENDING (${r.expectedApproverLabel})`
          : `${r.approvalStatus} by ${r.reviewedByName || r.expectedApproverLabel}${
              r.reviewRemarks ? ` [${r.reviewRemarks}]` : ''
            }`;

      return [
        `${r.runCode}\n${formatDateTime(r.startTime)}\nto ${r.endTime ? formatDateTime(r.endTime) : '—'}`,
        `${r.employeeName}\n(${r.employeeCode} · ${String(r.employeeRole || '').replace(/_/g, ' ')})`,
        `${r.openingOdometer} km`,
        `${r.closingOdometer ?? '—'} km`,
        gpsLoc,
        r.customerName || '—',
        r.tourReason || '—',
        `${Number(r.eligibleKm || 0).toFixed(2)}`,
        `Rs. ${rate.toFixed(2)}`,
        `Rs. ${gross.toFixed(2)}`,
        `Rs. ${deducted.toFixed(2)}`,
        `Rs. ${net.toFixed(2)}`,
        approverText,
      ];
    });

    if (body.length > 0) {
      body.push([
        'WEEKLY TOTAL',
        `${weeklyTotals.runs} Trip(s)`,
        '—',
        '—',
        '—',
        '—',
        '—',
        `${weeklyTotals.km.toFixed(2)} km`,
        `Rs. ${petrolRate.toFixed(2)}`,
        `Rs. ${weeklyTotals.gross.toFixed(2)}`,
        `Rs. ${weeklyTotals.deducted.toFixed(2)}`,
        `Rs. ${weeklyTotals.net.toFixed(2)}`,
        'Seniority Checked',
      ]);
    }

    autoTable(doc, {
      head,
      body:
        body.length > 0
          ? body
          : [['No completed bike runs found for the selected week.', '', '', '', '', '', '', '', '', '', '', '', '']],
      startY: 36,
      styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: [15, 39, 68], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      didParseCell: (data) => {
        if (body.length > 0 && data.row.index === body.length - 1) {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fillColor = [226, 232, 240];
        }
      },
    });

    const finalY = (doc as any).lastAutoTable?.finalY ? (doc as any).lastAutoTable.finalY + 8 : 185;
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(
      'Seniority Approval Rule: Field Officer -> Team Leader   |   Team Leader -> Branch Manager   |   Branch Manager -> Super Admin',
      14,
      Math.min(finalY, 198)
    );

    doc.save(`ambika_weekly_bike_bill_${weekMode === 'all' ? 'all' : weekStartDate}.pdf`);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            Field GPS Visits &amp; Bike Run Petrol Incentive
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Consent-based field GPS tracking, tour logs, weekly ₹{petrolRate.toFixed(2)}/km billing PDF, and seniority-wise manager approvals.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => {
              setSubTab('gps');
              onSelectOption?.('gps');
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'gps' ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
            }`}
          >
            <MapPin className="w-3.5 h-3.5" />
            GPS Location &amp; Visits
          </button>
          <button
            type="button"
            onClick={() => {
              setSubTab('timeline');
              onSelectOption?.('timeline');
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'timeline' ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
            }`}
          >
            <Route className="w-3.5 h-3.5" />
            Timeline Map
          </button>
          <button
            type="button"
            onClick={() => {
              setSubTab('bike');
              onSelectOption?.('bike');
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'bike' ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
            }`}
          >
            <Bike className="w-3.5 h-3.5" />
            Bike Run &amp; Petrol
          </button>
        </div>
      </div>

      {/* Employee GPS Consent Strip */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={consentChecked}
            onChange={(e) => setConsentChecked(e.target.checked)}
            className="rounded border-slate-300 accent-[#15803D]"
          />
          <span>
            Employee Consent Confirmed: Allow AMBIKA ASSOCIATE to capture GPS location during field shifts, customer visits, and Bike Runs.
          </span>
        </label>
        {coords && (
          <span className="text-xs font-mono text-[#15803D]">
            Last Fix: {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)} (±{coords.accuracy}m)
          </span>
        )}
      </div>

      {locError && (
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
          {locError}
        </div>
      )}
      {errorMsg && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[#DC2626] font-medium">
          {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-xs text-[#15803D] font-medium">
          {statusMsg}
        </div>
      )}

      {subTab === 'timeline' ? (
        <FieldGpsTimelineView
          logs={gpsLogs}
          onRecordCheckInClick={() => {
            setSubTab('gps');
            onSelectOption?.('gps');
          }}
        />
      ) : subTab === 'gps' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
            <div>
              <h2 className="text-sm font-display font-bold text-[#0F2744]">Shift GPS Controls</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => recordGpsActivity('TRACKING_START')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold"
                >
                  <Navigation className="w-3.5 h-3.5" />
                  Start GPS
                </button>
                <button
                  type="button"
                  onClick={() => recordGpsActivity('TRACKING_PING')}
                  className="px-3.5 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-[#0F2744]"
                >
                  Log Current Location
                </button>
                <button
                  type="button"
                  onClick={() => recordGpsActivity('TRACKING_STOP')}
                  disabled={!gpsActive}
                  className="px-3.5 py-2 rounded-lg bg-slate-800 text-white text-xs font-semibold disabled:opacity-40"
                >
                  Stop GPS
                </button>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200 space-y-3">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">Authorized Customer Visit</h2>
              <select
                value={visitLeadId}
                onChange={(e) => {
                  setVisitLeadId(e.target.value);
                  const found = leads.find((l) => String(l.id) === e.target.value);
                  if (found) setVisitCustomer(found.customerName);
                }}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="">Select Lead (Optional)</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.leadCode} — {l.customerName}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={visitCustomer}
                onChange={(e) => setVisitCustomer(e.target.value)}
                placeholder="Customer / Site Name"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
              <input
                type="text"
                value={visitNotes}
                onChange={(e) => setVisitNotes(e.target.value)}
                placeholder="Visit notes (e.g. KYC verification completed)"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => recordGpsActivity('VISIT_CHECKIN')}
                  className="flex-1 py-2 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold"
                >
                  Visit Check-In
                </button>
                <button
                  type="button"
                  onClick={() => recordGpsActivity('VISIT_CHECKOUT')}
                  className="flex-1 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-[#0F2744] text-xs font-semibold"
                >
                  Visit Check-Out
                </button>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">GPS &amp; Customer Visit History</h2>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setSubTab('timeline');
                    onSelectOption?.('timeline');
                  }}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#EA580C] hover:underline"
                >
                  <Route className="w-3.5 h-3.5" />
                  Open Timeline Map
                </button>
                <span className="text-xs text-slate-500 tabular-nums">{gpsLogs.length} records</span>
              </div>
            </div>
            <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold">Employee</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Activity</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Visit / Lead</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Coordinates</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {gpsLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="px-4 py-2.5">
                        <div className="font-semibold text-slate-800">{log.employeeName}</div>
                        <div className="font-mono text-[11px] text-slate-400">{log.employeeCode}</div>
                      </td>
                      <td className="px-4 py-2.5 font-medium text-[#0F2744]">{log.activityType}</td>
                      <td className="px-4 py-2.5">
                        <div>{log.customerName || log.leadCode || '—'}</div>
                        {log.visitNotes && <div className="text-[11px] text-slate-500">{log.visitNotes}</div>}
                      </td>
                      <td className="px-4 py-2.5 font-mono tabular-nums text-[11px] text-slate-600">
                        {Number(log.latitude).toFixed(4)}, {Number(log.longitude).toFixed(4)}
                        {log.accuracy ? ` (±${Math.round(log.accuracy)}m)` : ''}
                      </td>
                      <td className="px-4 py-2.5 font-mono tabular-nums text-[11px] text-slate-500">
                        {formatDateTime(log.recordedAt)}
                      </td>
                    </tr>
                  ))}
                  {gpsLogs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                        No GPS records yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Daily / Weekly / Monthly KM Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Daily KM (24h)</div>
              <div className="mt-1 text-xl font-bold font-mono tabular-nums text-[#0F2744]">
                {sumKmWithinDays(1).toFixed(1)} km
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Weekly KM (7d)</div>
              <div className="mt-1 text-xl font-bold font-mono tabular-nums text-[#0F2744]">
                {sumKmWithinDays(7).toFixed(1)} km
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Monthly KM (30d)</div>
              <div className="mt-1 text-xl font-bold font-mono tabular-nums text-[#0F2744]">
                {sumKmWithinDays(30).toFixed(1)} km
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Configured Rate / KM</div>
              <div className="mt-1 text-xl font-bold font-mono tabular-nums text-[#15803D]">
                ₹{petrolRate.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Start / Stop Bike Run Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            {!activeRun ? (
              <form onSubmit={handleStartBikeRun} className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-display font-bold text-[#0F2744]">
                    Start Bike Tour / Field Visit Run
                  </h2>
                  <span className="text-[11px] font-semibold text-slate-500">
                    Billing Rate: ₹{petrolRate.toFixed(2)}/km · Seniority Approval Applied
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Select Lead (Optional)
                    </label>
                    <select
                      value={bikeLeadId}
                      onChange={(e) => {
                        setBikeLeadId(e.target.value);
                        const found = leads.find((l) => String(l.id) === e.target.value);
                        if (found) {
                          setBikeCustomerName(found.customerName);
                          if (!bikeTourReason) {
                            setBikeTourReason(`${found.loanProduct} — Document Collection / Follow-up`);
                          }
                        }
                      }}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Manual / Walk-in Visit</option>
                      {leads.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.leadCode} — {l.customerName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Customer Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={bikeCustomerName}
                      onChange={(e) => setBikeCustomerName(e.target.value)}
                      placeholder="e.g. Ramesh Tiwari"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Reason for Tour *
                    </label>
                    <input
                      type="text"
                      required
                      value={bikeTourReason}
                      onChange={(e) => setBikeTourReason(e.target.value)}
                      placeholder="e.g. KYC Pickup / Bank Valuation"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Start Location / Area *
                    </label>
                    <input
                      type="text"
                      required
                      value={bikeStartLocation}
                      onChange={(e) => setBikeStartLocation(e.target.value)}
                      placeholder="e.g. Andheri Branch"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Start Meter Reading (KM) *
                    </label>
                    <input
                      type="number"
                      required
                      step="0.1"
                      value={openingOdo}
                      onChange={(e) => setOpeningOdo(e.target.value)}
                      placeholder="e.g. 14270.0"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="px-5 py-2.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold whitespace-nowrap"
                  >
                    Start Bike Run
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleStopBikeRun} className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-[#EA580C]">
                    Active Run: <span className="font-mono">{activeRun.runCode}</span> · Start Meter:{' '}
                    <span className="font-mono">{activeRun.openingOdometer} km</span> · Start Loc:{' '}
                    <span className="text-slate-700">{activeRun.startLocation || 'GPS Captured'}</span>
                  </span>
                  <span className="text-slate-500">Started {formatDateTime(activeRun.startTime)}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Customer Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={stopCustomerName}
                      onChange={(e) => setStopCustomerName(e.target.value)}
                      placeholder="Customer name"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Reason for Tour *
                    </label>
                    <input
                      type="text"
                      required
                      value={stopTourReason}
                      onChange={(e) => setStopTourReason(e.target.value)}
                      placeholder="Reason for tour"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Closing Location / Area *
                    </label>
                    <input
                      type="text"
                      required
                      value={stopEndLocation}
                      onChange={(e) => setStopEndLocation(e.target.value)}
                      placeholder="e.g. Bandra Client Office"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Close Meter Reading (KM) *
                    </label>
                    <input
                      type="number"
                      required
                      step="0.1"
                      min={activeRun.openingOdometer}
                      value={closingOdo}
                      onChange={(e) => setClosingOdo(e.target.value)}
                      placeholder="Closing km"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Desktop GPS Offset (KM, opt)
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      min={0}
                      value={simExtraKm}
                      onChange={(e) => setSimExtraKm(e.target.value)}
                      placeholder="0 on mobile GPS"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="px-5 py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold"
                  >
                    Stop Bike Run &amp; Generate Bill (@ ₹{petrolRate.toFixed(2)}/km)
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Weekly Bike Run Detail Chart & PDF Bill Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-display font-bold text-[#0F2744] flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-[#EA580C]" />
                  Weekly Bike Run Detail Chart &amp; Bill PDF (₹{petrolRate.toFixed(2)} / KM)
                </h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Includes Start/Close Meter Reading, GPS Location, Customer Name, Reason for Tour, Total KM with Date/Time &amp; Seniority Approval Status.
                </p>
              </div>
              <button
                type="button"
                onClick={exportWeeklyBikeBillPdf}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold whitespace-nowrap"
              >
                <FileDown className="w-4 h-4" />
                Download Weekly Bike Run Bill (PDF)
              </button>
            </div>

            <div className="flex flex-wrap items-end gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Period Mode</label>
                <div className="inline-flex rounded-lg border border-slate-300 bg-white overflow-hidden">
                  <button
                    type="button"
                    onClick={() => {
                      setWeekMode('week');
                      setWeekStartDate(getMondayIsoDate());
                    }}
                    className={`px-3 py-1.5 text-xs font-semibold ${
                      weekMode === 'week' && weekStartDate === getMondayIsoDate()
                        ? 'bg-[#0F2744] text-white'
                        : 'text-slate-700'
                    }`}
                  >
                    This Week
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setWeekMode('week');
                      setWeekStartDate(addDaysIsoDate(getMondayIsoDate(), -7));
                    }}
                    className={`px-3 py-1.5 text-xs font-semibold border-l border-slate-300 ${
                      weekMode === 'week' && weekStartDate === addDaysIsoDate(getMondayIsoDate(), -7)
                        ? 'bg-[#0F2744] text-white'
                        : 'text-slate-700'
                    }`}
                  >
                    Last Week
                  </button>
                  <button
                    type="button"
                    onClick={() => setWeekMode('all')}
                    className={`px-3 py-1.5 text-xs font-semibold border-l border-slate-300 ${
                      weekMode === 'all' ? 'bg-[#0F2744] text-white' : 'text-slate-700'
                    }`}
                  >
                    All Trips
                  </button>
                </div>
              </div>

              {weekMode === 'week' && (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                    Week Start ({weekStartDate} to {weekEndDate})
                  </label>
                  <input
                    type="date"
                    value={weekStartDate}
                    onChange={(e) => setWeekStartDate(e.target.value)}
                    className="px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg bg-white"
                  />
                </div>
              )}

              {employeeOptions.length > 1 && (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 mb-1">Filter Employee</label>
                  <select
                    value={weekEmployeeFilter}
                    onChange={(e) => setWeekEmployeeFilter(e.target.value)}
                    className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="ALL">All Visible Staff</option>
                    {employeeOptions.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="ml-auto grid grid-cols-4 gap-3 text-right">
                <div>
                  <div className="text-[10px] text-slate-500 uppercase">Trips</div>
                  <div className="text-xs font-bold font-mono text-[#0F2744]">{weeklyTotals.runs}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500 uppercase">Total KM</div>
                  <div className="text-xs font-bold font-mono text-[#0F2744]">{weeklyTotals.km.toFixed(2)} km</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500 uppercase">Gross Bill</div>
                  <div className="text-xs font-bold font-mono text-slate-700">{formatInr(weeklyTotals.gross)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500 uppercase">Net Payable</div>
                  <div className="text-xs font-bold font-mono text-[#15803D]">{formatInr(weeklyTotals.net)}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Bike Run & Petrol Incentive Register with Seniority Approval */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Bike Run &amp; Petrol Incentive Register
                </h2>
                <div className="text-[11px] text-slate-500">
                  Seniority Approval: Field Officer → Team Leader | Team Leader → Branch Manager | Branch Manager → Super Admin
                </div>
              </div>
              <span className="text-xs font-mono font-semibold text-[#15803D]">
                Rate: ₹{petrolRate.toFixed(2)}/km
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-3 py-3 font-semibold">Date/Time &amp; Employee</th>
                    <th className="text-left px-3 py-3 font-semibold">Customer &amp; Tour Reason</th>
                    <th className="text-left px-3 py-3 font-semibold">GPS Location (Start → Close)</th>
                    <th className="text-right px-3 py-3 font-semibold">Start / Close Meter</th>
                    <th className="text-right px-3 py-3 font-semibold">KM &amp; Bill (@ ₹{petrolRate.toFixed(2)})</th>
                    <th className="text-left px-3 py-3 font-semibold">Seniority Status</th>
                    <th className="text-right px-3 py-3 font-semibold">Manager Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bikeRuns.map((r) => {
                    const rate = Number(r.ratePerKm || petrolRate || 3.0);
                    const gross = Number(r.grossAmount || Math.round(Number(r.eligibleKm || 0) * rate * 100) / 100);
                    const deducted = Number(r.deductedAmount || 0);
                    return (
                      <tr key={r.id}>
                        <td className="px-3 py-3 align-top">
                          <div className="font-mono font-semibold text-[#0F2744]">{r.runCode}</div>
                          <div className="font-semibold text-slate-800">{r.employeeName}</div>
                          <div className="text-[11px] text-slate-500">
                            {r.employeeCode} · {String(r.employeeRole || '').replace(/_/g, ' ')}
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                            {formatDateTime(r.startTime)}
                            {r.endTime ? ` → ${formatDateTime(r.endTime)}` : ''}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top max-w-[200px]">
                          <div className="font-semibold text-slate-800">{r.customerName || '—'}</div>
                          <div className="text-[11px] text-slate-600 mt-0.5">{r.tourReason || '—'}</div>
                        </td>
                        <td className="px-3 py-3 align-top max-w-[210px] text-[11px] text-slate-600">
                          <div>
                            <span className="font-semibold text-slate-700">Start:</span>{' '}
                            {r.startLocation || `${Number(r.startLat).toFixed(4)}, ${Number(r.startLng).toFixed(4)}`}
                          </div>
                          <div className="mt-0.5">
                            <span className="font-semibold text-slate-700">Close:</span>{' '}
                            {r.endLocation ||
                              (r.endLat ? `${Number(r.endLat).toFixed(4)}, ${Number(r.endLng).toFixed(4)}` : 'Active')}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top text-right font-mono tabular-nums">
                          <div>Start: {r.openingOdometer}</div>
                          <div>Close: {r.closingOdometer ?? 'Active'}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            GPS {r.gpsDistanceKm} | Mtr {r.odometerDistanceKm}
                          </div>
                          {r.discrepancyFlag && (
                            <div className="inline-flex items-center gap-1 text-[#DC2626] font-semibold mt-0.5">
                              <AlertTriangle className="w-3 h-3" />
                              Diff {r.discrepancyKm} km
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top text-right font-mono tabular-nums">
                          <div className="font-semibold text-slate-800">
                            {r.eligibleKm} km × ₹{rate.toFixed(2)}
                          </div>
                          <div className="text-[11px] text-slate-500">Gross: {formatInr(gross)}</div>
                          {deducted > 0 && (
                            <div className="text-[11px] text-[#EA580C] font-semibold">
                              Deducted: -{formatInr(deducted)}
                            </div>
                          )}
                          <div className="font-bold text-[#15803D]">{formatInr(r.incentiveAmount)}</div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <span
                            className={`font-semibold ${
                              r.approvalStatus === 'APPROVED'
                                ? 'text-[#15803D]'
                                : r.approvalStatus === 'DEDUCTED'
                                ? 'text-[#EA580C]'
                                : r.approvalStatus === 'REJECTED'
                                ? 'text-[#DC2626]'
                                : 'text-[#D97706]'
                            }`}
                          >
                            {r.status === 'ACTIVE' ? 'IN PROGRESS' : r.approvalStatus}
                          </span>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Approver: {r.expectedApproverLabel}
                          </div>
                          {r.reviewedByName && (
                            <div className="text-[11px] text-slate-600">By: {r.reviewedByName}</div>
                          )}
                          {r.reviewRemarks && (
                            <div className="text-[11px] text-slate-500 italic mt-0.5">“{r.reviewRemarks}”</div>
                          )}
                        </td>
                        <td className="px-3 py-3 align-top text-right">
                          {r.canReview && r.status === 'COMPLETED' && r.approvalStatus === 'PENDING' ? (
                            <div className="flex flex-col items-end gap-1.5 min-w-[210px]">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  step="0.1"
                                  placeholder={`KM (${r.eligibleKm})`}
                                  value={mgrKmMap[r.id] || ''}
                                  onChange={(e) => setMgrKmMap({ ...mgrKmMap, [r.id]: e.target.value })}
                                  className="w-20 px-2 py-1 text-[11px] font-mono border border-slate-300 rounded"
                                  title="Override eligible KM"
                                />
                                <input
                                  type="number"
                                  step="1"
                                  min="0"
                                  placeholder="Deduct ₹"
                                  value={mgrDeductMap[r.id] || ''}
                                  onChange={(e) => setMgrDeductMap({ ...mgrDeductMap, [r.id]: e.target.value })}
                                  className="w-20 px-2 py-1 text-[11px] font-mono border border-slate-300 rounded"
                                  title="Deduction amount in ₹"
                                />
                              </div>
                              <input
                                type="text"
                                placeholder="Manager remarks"
                                value={mgrNoteMap[r.id] || ''}
                                onChange={(e) => setMgrNoteMap({ ...mgrNoteMap, [r.id]: e.target.value })}
                                className="w-full px-2 py-1 text-[11px] border border-slate-300 rounded"
                              />
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => handleManagerDecision(r.id, 'APPROVED')}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#15803D] text-white text-[11px] font-semibold"
                                  title="Approve full bill"
                                >
                                  <CheckCircle2 className="w-3 h-3" />
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleManagerDecision(r.id, 'DEDUCTED')}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#EA580C] text-white text-[11px] font-semibold"
                                  title="Approve with deduction"
                                >
                                  <Scissors className="w-3 h-3" />
                                  Deduct
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleManagerDecision(r.id, 'REJECTED')}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#DC2626] text-white text-[11px] font-semibold"
                                  title="Reject bill"
                                >
                                  <XCircle className="w-3 h-3" />
                                  Reject
                                </button>
                              </div>
                            </div>
                          ) : (
                            <span className="text-[11px] text-slate-400">
                              {r.status === 'COMPLETED' && r.approvalStatus === 'PENDING'
                                ? `Awaiting ${r.expectedApproverLabel}`
                                : r.reviewedByName || '—'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {bikeRuns.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        No bike runs recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
