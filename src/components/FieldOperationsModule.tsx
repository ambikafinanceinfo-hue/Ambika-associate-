import React, { useEffect, useState } from 'react';
import { Bike, MapPin, Navigation, CheckCircle2, XCircle, AlertTriangle, Route } from 'lucide-react';
import type { AuthUser, LeadRecord } from '../../shared/types';
import { apiFetch, formatDateTime, formatInr } from '../lib/api';
import { FieldGpsTimelineView } from './FieldGpsTimelineView';

interface FieldOperationsModuleProps {
  user: AuthUser;
  activeOption?: 'gps' | 'timeline' | 'bike' | null;
  onSelectOption?: (opt: 'gps' | 'timeline' | 'bike') => void;
  onAlertsChanged: () => void;
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
  const [petrolRate, setPetrolRate] = useState(3.5);
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

  // Bike Run forms
  const [openingOdo, setOpeningOdo] = useState('');
  const [closingOdo, setClosingOdo] = useState('');
  const [simExtraKm, setSimExtraKm] = useState('');
  const [adminKmMap, setAdminKmMap] = useState<Record<number, string>>({});
  const [adminNoteMap, setAdminNoteMap] = useState<Record<number, string>>({});
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const isAdmin = user.role === 'SUPER_ADMIN';

  const loadAll = async () => {
    const [gRes, bRes, lRes] = await Promise.all([
      apiFetch<{ logs: any[] }>('/gps'),
      apiFetch<{ runs: any[]; petrolRatePerKm: number }>('/bike-runs'),
      apiFetch<{ leads: LeadRecord[] }>('/leads'),
    ]);
    setGpsLogs(gRes.logs);
    setBikeRuns(bRes.runs);
    setPetrolRate(bRes.petrolRatePerKm);
    setLeads(lRes.leads);
  };

  useEffect(() => {
    loadAll();
  }, []);

  const captureBrowserGps = (): Promise<{ lat: number; lng: number; accuracy: number }> => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        setLocError('Browser geolocation unavailable; using Mumbai HQ verification coordinates.');
        const fallback = { lat: 19.076 + Math.random() * 0.01, lng: 72.8777 + Math.random() * 0.01, accuracy: 25 };
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

  const handleStartBikeRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consentChecked) {
      setLocError('Employee GPS consent is required for GPS Bike Run.');
      return;
    }
    const c = await captureBrowserGps();
    await apiFetch('/bike-runs/start', {
      method: 'POST',
      json: {
        openingOdometer: Number(openingOdo),
        latitude: c.lat,
        longitude: c.lng,
      },
    });
    setOpeningOdo('');
    setStatusMsg('Bike Run started with opening odometer and GPS waypoint.');
    await loadAll();
  };

  const handleStopBikeRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRun) return;
    const c = await captureBrowserGps();
    const res = await apiFetch<any>(`/bike-runs/${activeRun.id}/stop`, {
      method: 'POST',
      json: {
        closingOdometer: Number(closingOdo),
        latitude: c.lat,
        longitude: c.lng,
        simulatedExtraKm: simExtraKm ? Number(simExtraKm) : 0,
      },
    });
    setClosingOdo('');
    setSimExtraKm('');
    setStatusMsg(
      `Bike Run completed: GPS ${res.gpsKm} km, Odometer ${res.odoKm} km, Est. Incentive ₹${res.incentive}`
    );
    await loadAll();
    onAlertsChanged();
  };

  const handleAdminBikeDecision = async (id: number, decision: 'APPROVED' | 'REJECTED') => {
    await apiFetch(`/bike-runs/${id}/decision`, {
      method: 'PATCH',
      json: {
        decision,
        eligibleKm: adminKmMap[id] ? Number(adminKmMap[id]) : undefined,
        remarks: adminNoteMap[id] || '',
      },
    });
    await loadAll();
    onAlertsChanged();
  };

  // Daily / Weekly / Monthly KM Summary
  const now = Date.now();
  const completedRuns = bikeRuns.filter((r) => r.status === 'COMPLETED');
  const sumKmWithinDays = (days: number) =>
    completedRuns
      .filter((r) => {
        const ts = new Date(String(r.startTime).replace(' ', 'T') + 'Z').getTime();
        return now - ts <= days * 86400000;
      })
      .reduce((sum, r) => sum + Number(r.eligibleKm || 0), 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            Field GPS Visits &amp; Bike Run Petrol Incentive
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Consent-based field GPS tracking, customer visit check-ins, and odometer-verified petrol incentives (Rate: ₹{petrolRate}/km).
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
              <form onSubmit={handleStartBikeRun} className="flex flex-wrap items-end gap-4">
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Opening Odometer Reading (KM) *
                  </label>
                  <input
                    type="number"
                    required
                    step="0.1"
                    value={openingOdo}
                    onChange={(e) => setOpeningOdo(e.target.value)}
                    placeholder="e.g. 14270.0"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-lg bg-[#15803D] hover:bg-green-800 text-white text-xs font-semibold whitespace-nowrap"
                >
                  Start Bike Run
                </button>
              </form>
            ) : (
              <form onSubmit={handleStopBikeRun} className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-[#EA580C]">
                    Active Run: <span className="font-mono">{activeRun.runCode}</span> · Opening Odo:{' '}
                    <span className="font-mono">{activeRun.openingOdometer} km</span>
                  </span>
                  <span className="text-slate-500">Started {formatDateTime(activeRun.startTime)}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Closing Odometer (KM) *</label>
                    <input
                      type="number"
                      required
                      step="0.1"
                      min={activeRun.openingOdometer}
                      value={closingOdo}
                      onChange={(e) => setClosingOdo(e.target.value)}
                      placeholder="Closing km"
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Desktop GPS Travel Offset (KM, optional)
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      min={0}
                      value={simExtraKm}
                      onChange={(e) => setSimExtraKm(e.target.value)}
                      placeholder="0 if real mobile GPS moved"
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="submit"
                      className="w-full py-2.5 rounded-lg bg-[#EA580C] hover:bg-[#C2410C] text-white text-xs font-semibold"
                    >
                      Stop Bike Run &amp; Calculate
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>

          {/* Bike Run Register */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">
                Bike Run &amp; Petrol Incentive Register
              </h2>
              <span className="text-xs text-slate-500">Formula: Eligible KM × ₹{petrolRate}/km</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold">Run / Employee</th>
                    <th className="text-right px-4 py-3 font-semibold">Opening / Closing</th>
                    <th className="text-right px-4 py-3 font-semibold">GPS vs Odo KM</th>
                    <th className="text-right px-4 py-3 font-semibold">Eligible &amp; Payout</th>
                    <th className="text-left px-4 py-3 font-semibold">Status</th>
                    {isAdmin && <th className="text-right px-4 py-3 font-semibold">Admin Approval</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bikeRuns.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-3">
                        <div className="font-mono font-semibold text-[#0F2744]">{r.runCode}</div>
                        <div className="text-slate-700">{r.employeeName}</div>
                        <div className="text-[11px] text-slate-400">{formatDateTime(r.startTime)}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        <div>Open: {r.openingOdometer}</div>
                        <div>Close: {r.closingOdometer ?? 'Active'}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        <div>GPS: {r.gpsDistanceKm} km</div>
                        <div>Odo: {r.odometerDistanceKm} km</div>
                        {r.discrepancyFlag && (
                          <div className="inline-flex items-center gap-1 text-[#DC2626] font-semibold">
                            <AlertTriangle className="w-3 h-3" />
                            Diff {r.discrepancyKm} km
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        <div className="font-semibold text-slate-800">{r.eligibleKm} km × ₹{r.ratePerKm}</div>
                        <div className="font-bold text-[#15803D]">{formatInr(r.incentiveAmount)}</div>
                      </td>
                      <td className="px-4 py-3 font-semibold">
                        <span
                          className={
                            r.approvalStatus === 'APPROVED'
                              ? 'text-[#15803D]'
                              : r.approvalStatus === 'REJECTED'
                              ? 'text-[#DC2626]'
                              : 'text-[#D97706]'
                          }
                        >
                          {r.status === 'ACTIVE' ? 'IN PROGRESS' : r.approvalStatus}
                        </span>
                      </td>
                      {isAdmin && (
                        <td className="px-4 py-3 text-right">
                          {r.status === 'COMPLETED' && r.approvalStatus === 'PENDING' ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <input
                                type="number"
                                step="0.1"
                                placeholder={String(r.eligibleKm)}
                                value={adminKmMap[r.id] || ''}
                                onChange={(e) => setAdminKmMap({ ...adminKmMap, [r.id]: e.target.value })}
                                className="w-16 px-2 py-1 text-[11px] font-mono border border-slate-300 rounded"
                                title="Override eligible KM"
                              />
                              <input
                                type="text"
                                placeholder="Remarks"
                                value={adminNoteMap[r.id] || ''}
                                onChange={(e) => setAdminNoteMap({ ...adminNoteMap, [r.id]: e.target.value })}
                                className="w-24 px-2 py-1 text-[11px] border border-slate-300 rounded"
                              />
                              <button
                                type="button"
                                onClick={() => handleAdminBikeDecision(r.id, 'APPROVED')}
                                className="p-1.5 rounded bg-[#15803D] text-white"
                                title="Approve Petrol Incentive"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleAdminBikeDecision(r.id, 'REJECTED')}
                                className="p-1.5 rounded bg-[#DC2626] text-white"
                                title="Reject"
                              >
                                <XCircle className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <span className="text-[11px] text-slate-400">{r.reviewedByName || '—'}</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                  {bikeRuns.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
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
