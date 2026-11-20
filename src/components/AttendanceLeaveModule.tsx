import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarCheck2,
  MapPin,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  ShieldAlert,
  CalendarPlus,
  LocateFixed,
} from 'lucide-react';
import type { AttendanceRecord, AuthUser, LeaveRequestRecord } from '../../shared/types';
import { apiFetch, formatInr } from '../lib/api';

interface AttendanceLeaveModuleProps {
  user: AuthUser;
  activeOption?: 'attendance' | 'leave' | null;
  onSelectOption?: (opt: 'attendance' | 'leave') => void;
  onAlertsChanged: () => void;
  onAttendanceMarked?: () => void;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getLiveIstParts(cutoffStr = '10:00') {
  const istMs = Date.now() + 330 * 60 * 1000;
  const d = new Date(istMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = d.getUTCHours();
  const min = d.getUTCMinutes();
  const sec = d.getUTCSeconds();
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const [cutH, cutM] = cutoffStr.split(':').map(Number);
  const cutoffMins = (Number.isFinite(cutH) ? cutH : 10) * 60 + (Number.isFinite(cutM) ? cutM : 0);
  const nowMins = hh * 60 + min;
  return {
    istDate: `${yyyy}-${mm}-${dd}`,
    istTime: `${String(h12).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')} ${ampm} IST`,
    isAfterCutoff: nowMins > cutoffMins,
    delayMinutes: Math.max(0, nowMins - cutoffMins),
  };
}

function getClientExpectedLeaveApprover(role: string): string {
  if (role === 'FIELD_OFFICER') return 'Team Leader';
  if (role === 'TEAM_LEADER' || role === 'LEAD_GENERATOR') return 'Branch Manager';
  return 'Super Admin';
}

export const AttendanceLeaveModule: React.FC<AttendanceLeaveModuleProps> = ({
  user,
  activeOption,
  onSelectOption,
  onAlertsChanged,
  onAttendanceMarked,
}) => {
  const [subTab, setSubTab] = useState<'attendance' | 'leave'>(
    activeOption === 'leave' ? 'leave' : 'attendance'
  );

  useEffect(() => {
    if (activeOption === 'attendance' || activeOption === 'leave') {
      setSubTab(activeOption);
    } else if (activeOption === null) {
      setSubTab('attendance');
    }
  }, [activeOption]);

  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [todayRecord, setTodayRecord] = useState<AttendanceRecord | null>(null);
  const [staff, setStaff] = useState<{ id: number; fullName: string; employeeCode: string; role: string }[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequestRecord[]>([]);
  const [officeConfig, setOfficeConfig] = useState({
    officeName: 'AMBIKA ASSOCIATE Head Office',
    officeAddress: '1ST FLOR ANUPAM COMPLEX,PATERI ROAD,NEAR RELIANCE BAZAR,SATNA MP(485001)',
    officeLatitude: 24.5819,
    officeLongitude: 80.7921,
    officeRadiusMeters: 500,
    attendanceCutoffTime: '10:00',
    attendanceLatePenaltyInr: 20,
    unapprovedLeavePenaltyInr: 100,
  });

  // Auto-captured live GPS & clock
  const [liveGps, setLiveGps] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'detecting' | 'captured' | 'error'>('detecting');
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [istClock, setIstClock] = useState(() => getLiveIstParts('10:00'));

  const [attNotes, setAttNotes] = useState('');
  const [markingAtt, setMarkingAtt] = useState(false);

  // Leave application state
  const [fromDate, setFromDate] = useState(() => getLiveIstParts().istDate);
  const [toDate, setToDate] = useState(() => getLiveIstParts().istDate);
  const [leaveType, setLeaveType] = useState('Casual Leave');
  const [leaveReason, setLeaveReason] = useState('');
  const [submittingLeave, setSubmittingLeave] = useState(false);

  // Manager leave decision & unapproved leave penalty state
  const [leaveRemarksMap, setLeaveRemarksMap] = useState<Record<number, string>>({});
  const [unapprovedEmpId, setUnapprovedEmpId] = useState('');
  const [unapprovedDate, setUnapprovedDate] = useState(() => getLiveIstParts().istDate);
  const [unapprovedRemarks, setUnapprovedRemarks] = useState('');

  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const canAnchorOfficeGps = user.role === 'SUPER_ADMIN' || user.role === 'BRANCH_MANAGER';
  const isManager = ['SUPER_ADMIN', 'BRANCH_MANAGER', 'TEAM_LEADER'].includes(user.role);

  const loadAll = async () => {
    const [attRes, lvRes] = await Promise.all([
      apiFetch<any>('/attendance'),
      apiFetch<{ leaves: LeaveRequestRecord[] }>('/leaves'),
    ]);
    setRecords(attRes.records || []);
    setTodayRecord(attRes.todayRecord || null);
    setStaff(attRes.staff || []);
    if (attRes.officeConfig) {
      setOfficeConfig(attRes.officeConfig);
    }
    setLeaves(lvRes.leaves || []);
  };

  const applyGpsPosition = (pos: GeolocationPosition) => {
    setLiveGps({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: Math.round(pos.coords.accuracy || 0),
    });
    setGpsStatus('captured');
    setGpsError(null);
  };

  const detectAutoGps = () => {
    if (!navigator.geolocation) {
      setGpsStatus('error');
      setGpsError('Browser GPS geolocation is unavailable on this device.');
      return;
    }
    setGpsStatus('detecting');
    setGpsError(null);

    const requestNetworkFallback = () => {
      navigator.geolocation.getCurrentPosition(
        applyGpsPosition,
        (fallbackErr) => {
          setGpsStatus('error');
          setGpsError(
            fallbackErr?.code === 1
              ? 'Location permission denied. Enable GPS/Location permission for Ambika CRM in phone settings, then tap Refresh Auto GPS.'
              : 'Unable to acquire GPS fix indoors. Turn ON phone Location (High Accuracy / Wi-Fi Scanning) and tap Refresh Auto GPS.'
          );
        },
        { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 }
      );
    };

    // High accuracy GPS first, automatic Wi-Fi/cell fallback if indoors (1st floor) times out
    navigator.geolocation.getCurrentPosition(
      applyGpsPosition,
      (err) => {
        if (err?.code === 1) {
          setGpsStatus('error');
          setGpsError(
            'Location permission denied. Allow GPS access in your browser/app settings to mark Ambika Office attendance.'
          );
          return;
        }
        requestNetworkFallback();
      },
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 15000 }
    );
  };

  useEffect(() => {
    loadAll();
    detectAutoGps();

    let watchId: number | null = null;
    if (navigator.geolocation && typeof navigator.geolocation.watchPosition === 'function') {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setLiveGps((prev) => {
            const nextAcc = Math.round(pos.coords.accuracy || 0);
            if (!prev || nextAcc <= prev.accuracy + 30) {
              setGpsStatus('captured');
              setGpsError(null);
              return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: nextAcc };
            }
            return prev;
          });
        },
        () => {
          // Ignore passive watch errors; explicit detectAutoGps handles user-visible feedback
        },
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
      );
    }

    const handleLiveSync = () => {
      void loadAll();
    };
    window.addEventListener('ambika:live-sync', handleLiveSync);
    return () => {
      window.removeEventListener('ambika:live-sync', handleLiveSync);
      if (watchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setIstClock(getLiveIstParts(officeConfig.attendanceCutoffTime));
    }, 1000);
    return () => clearInterval(timer);
  }, [officeConfig.attendanceCutoffTime]);

  const distanceFromOffice = useMemo(() => {
    if (!liveGps) return null;
    return haversineMeters(
      liveGps.lat,
      liveGps.lng,
      officeConfig.officeLatitude,
      officeConfig.officeLongitude
    );
  }, [liveGps, officeConfig.officeLatitude, officeConfig.officeLongitude]);

  const effectiveDistanceFromOffice = useMemo(() => {
    if (distanceFromOffice === null || !liveGps) return null;
    const accuracyAllowance = Math.min(Math.max(0, liveGps.accuracy || 0), 250);
    return Math.max(0, distanceFromOffice - accuracyAllowance);
  }, [distanceFromOffice, liveGps]);

  const isWithinOffice =
    effectiveDistanceFromOffice !== null && effectiveDistanceFromOffice <= officeConfig.officeRadiusMeters;

  // Green ON strictly when GPS is inside Ambika Office AND time <= 10:00 AM IST
  const isAttendanceGreenOn = isWithinOffice && !istClock.isAfterCutoff && !todayRecord;
  const isAttendanceLateOn = isWithinOffice && istClock.isAfterCutoff && !todayRecord;

  const handleSelfApproveAttendance = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    if (!liveGps) {
      setErrorMsg('Auto GPS coordinates not captured yet. Click Refresh Auto GPS.');
      return;
    }
    setMarkingAtt(true);
    try {
      const res = await apiFetch<any>('/attendance/mark', {
        method: 'POST',
        json: {
          latitude: liveGps.lat,
          longitude: liveGps.lng,
          accuracy: liveGps.accuracy,
          locationLabel: `${officeConfig.officeName} (${liveGps.lat.toFixed(4)}, ${liveGps.lng.toFixed(4)})`,
          notes: attNotes.trim() || undefined,
        },
      });
      setAttNotes('');
      setStatusMsg(
        res.isLate
          ? `Self-Attendance approved at ${res.markedTimeIst} (${res.distanceMeters}m from Ambika Office). Late after 10:00 AM -> ₹${res.delayPenaltyAmount} delay penalty applied.`
          : `Self-Attendance approved ON TIME at ${res.markedTimeIst} (${res.distanceMeters}m inside Ambika Office).`
      );
      await loadAll();
      onAlertsChanged();
      onAttendanceMarked?.();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to mark attendance');
    } finally {
      setMarkingAtt(false);
    }
  };

  const handleSetOfficeLocationToCurrentGps = async () => {
    if (!liveGps) {
      setErrorMsg('Capture GPS first before setting Ambika Office coordinates.');
      return;
    }
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await apiFetch('/attendance/office-location', {
        method: 'POST',
        json: {
          latitude: liveGps.lat,
          longitude: liveGps.lng,
        },
      });
      setStatusMsg(
        `Ambika Office GPS anchored to (${liveGps.lat.toFixed(5)}, ${liveGps.lng.toFixed(5)}) and synced live to all staff apps. Radius: ${officeConfig.officeRadiusMeters}m.`
      );
      await loadAll();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to update office GPS location');
    }
  };

  const handleApplyLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    setSubmittingLeave(true);
    try {
      const res = await apiFetch<any>('/leaves', {
        method: 'POST',
        json: {
          fromDate,
          toDate,
          leaveType,
          reason: leaveReason,
        },
      });
      setLeaveReason('');
      setStatusMsg(
        `Leave ${res.leaveCode} (${res.totalDays} day(s)) submitted to ${res.expectedApproverLabel} for seniority approval.`
      );
      await loadAll();
      onAlertsChanged();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to submit leave request');
    } finally {
      setSubmittingLeave(false);
    }
  };

  const handleLeaveDecision = async (id: number, decision: 'APPROVED' | 'REJECTED') => {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await apiFetch<any>(`/leaves/${id}/decision`, {
        method: 'PATCH',
        json: {
          decision,
          remarks: leaveRemarksMap[id] || '',
        },
      });
      setStatusMsg(
        decision === 'APPROVED'
          ? 'Leave request approved cleanly.'
          : `Leave rejected. Without-approval leave penalty of ₹${res.unapprovedPenaltyAmount} charged.`
      );
      await loadAll();
      onAlertsChanged();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to update leave decision');
    }
  };

  const handleChargeUnapprovedLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setStatusMsg(null);
    if (!unapprovedEmpId) {
      setErrorMsg('Select an employee to charge unapproved leave penalty.');
      return;
    }
    try {
      const res = await apiFetch<any>('/attendance/unapproved-leave-penalty', {
        method: 'POST',
        json: {
          employeeId: Number(unapprovedEmpId),
          leaveDate: unapprovedDate,
          remarks: unapprovedRemarks.trim() || undefined,
        },
      });
      setUnapprovedRemarks('');
      setStatusMsg(
        `Unapproved leave penalty ${res.penaltyCode} (₹${res.amount}) charged for ${unapprovedDate}.`
      );
      await loadAll();
      onAlertsChanged();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to charge unapproved leave penalty');
    }
  };

  const myTotalLatePenalty = records
    .filter((r) => r.employeeId === user.id)
    .reduce((sum, r) => sum + Number(r.delayPenaltyAmount || 0), 0);
  const myTotalUnapprovedPenalty = leaves
    .filter((l) => l.employeeId === user.id)
    .reduce((sum, l) => sum + Number(l.unapprovedPenaltyAmount || 0), 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-display font-bold text-[#0F2744]">
            Daily Attendance &amp; Leave Management
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Self-approved daily attendance inside Ambika Office GPS (Green ON ≤ 10:00 AM IST; ₹{officeConfig.attendanceLatePenaltyInr}/day after 10 AM) &amp; seniority-wise leave approvals (₹{officeConfig.unapprovedLeavePenaltyInr}/unapproved leave).
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => {
              setSubTab('attendance');
              onSelectOption?.('attendance');
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'attendance' ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
            }`}
          >
            <CalendarCheck2 className="w-3.5 h-3.5" />
            Daily Self Attendance
          </button>
          <button
            type="button"
            onClick={() => {
              setSubTab('leave');
              onSelectOption?.('leave');
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
              subTab === 'leave' ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
            }`}
          >
            <CalendarPlus className="w-3.5 h-3.5" />
            Leave &amp; Seniority Approval
          </button>
        </div>
      </div>

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

      {subTab === 'attendance' ? (
        <div className="space-y-5">
          {/* Auto Mode Date / Time / Location & Ambika Office Geofence Card */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-display font-bold text-[#0F2744] flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-[#EA580C]" />
                    Auto Mode GPS &amp; Ambika Office Check-In
                  </h2>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Every employee has self-approval authority when GPS is captured inside{' '}
                    <strong>{officeConfig.officeName}</strong> (≤ {officeConfig.officeRadiusMeters}m).
                  </p>
                </div>
                <button
                  type="button"
                  onClick={detectAutoGps}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-[#0F2744]"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${gpsStatus === 'detecting' ? 'animate-spin' : ''}`} />
                  Refresh Auto GPS
                </button>
              </div>

              {/* Auto-Captured Live Values */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3.5 text-xs">
                <div>
                  <div className="text-[10px] uppercase font-semibold text-slate-500">Auto Capture Date</div>
                  <div className="font-mono font-bold text-[#0F2744] mt-0.5">{istClock.istDate}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase font-semibold text-slate-500">Auto Time (Cutoff 10:00 AM)</div>
                  <div className="font-mono font-bold text-[#0F2744] mt-0.5 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                    {istClock.istTime}
                  </div>
                  <div className={`text-[11px] font-semibold mt-0.5 ${istClock.isAfterCutoff ? 'text-[#EA580C]' : 'text-[#15803D]'}`}>
                    {istClock.isAfterCutoff
                      ? `Late (+${istClock.delayMinutes}m) -> ₹${officeConfig.attendanceLatePenaltyInr} penalty`
                      : 'Before 10:00 AM IST (No Penalty)'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase font-semibold text-slate-500">Auto GPS Location</div>
                  {liveGps ? (
                    <>
                      <div className="font-mono text-[11px] font-semibold text-slate-800 mt-0.5">
                        {liveGps.lat.toFixed(5)}, {liveGps.lng.toFixed(5)}
                      </div>
                      <div className={`text-[11px] font-bold mt-0.5 ${isWithinOffice ? 'text-[#15803D]' : 'text-[#DC2626]'}`}>
                        {isWithinOffice
                          ? `Inside Ambika Office (${distanceFromOffice}m${liveGps.accuracy ? `, ±${liveGps.accuracy}m` : ''})`
                          : `Outside Office (${distanceFromOffice}m${liveGps.accuracy ? `, ±${liveGps.accuracy}m` : ''} > ${officeConfig.officeRadiusMeters}m)`}
                      </div>
                    </>
                  ) : (
                    <div className="text-[11px] text-amber-700 font-medium mt-0.5">
                      {gpsStatus === 'detecting' ? 'Detecting GPS...' : 'GPS Unavailable'}
                    </div>
                  )}
                </div>
              </div>

              {gpsError && (
                <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
                  {gpsError}
                </div>
              )}

              {todayRecord ? (
                <div className="p-4 rounded-xl bg-green-50 border border-green-200 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-bold text-[#15803D] flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      Today&apos;s Self-Attendance Approved ({todayRecord.attendanceCode})
                    </div>
                    <div className="text-[11px] text-slate-700 mt-1">
                      Captured Auto Time: <span className="font-mono font-semibold">{todayRecord.markedTimeIst}</span> ·
                      Location: <span className="font-mono">{todayRecord.locationLabel}</span> ·
                      Distance: <span className="font-mono">{todayRecord.distanceMeters}m</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span
                      className={`inline-block px-2.5 py-1 rounded text-xs font-bold ${
                        todayRecord.isLate ? 'bg-amber-100 text-amber-800' : 'bg-[#15803D] text-white'
                      }`}
                    >
                      {todayRecord.status === 'PRESENT' ? 'PRESENT (ON TIME)' : `LATE (+₹${todayRecord.delayPenaltyAmount})`}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <input
                    type="text"
                    value={attNotes}
                    onChange={(e) => setAttNotes(e.target.value)}
                    placeholder="Optional daily shift note..."
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  />
                  <button
                    type="button"
                    disabled={markingAtt || (!isAttendanceGreenOn && !isAttendanceLateOn)}
                    onClick={handleSelfApproveAttendance}
                    className={`w-full py-3 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-colors ${
                      isAttendanceGreenOn
                        ? 'bg-[#15803D] hover:bg-green-800 text-white shadow-sm'
                        : isAttendanceLateOn
                        ? 'bg-[#EA580C] hover:bg-[#C2410C] text-white shadow-sm'
                        : 'bg-slate-200 text-slate-500 cursor-not-allowed'
                    }`}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    {markingAtt
                      ? 'Saving Auto-Captured Attendance...'
                      : isAttendanceGreenOn
                      ? 'GREEN ON — Self-Approve Today Attendance (Inside Office ≤ 10:00 AM)'
                      : isAttendanceLateOn
                      ? `Approve Late Attendance (After 10:00 AM · ₹${officeConfig.attendanceLatePenaltyInr} Delay Penalty)`
                      : !liveGps
                      ? 'Attendance Locked — Waiting for Ambika Office Auto GPS'
                      : `Attendance Locked — Outside Ambika Office (${distanceFromOffice}m away, max ${officeConfig.officeRadiusMeters}m)`}
                  </button>
                </div>
              )}
            </div>

            {/* Office Geofence & My Attendance Summary Card */}
            <div className="lg:col-span-5 space-y-4">
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Ambika Office Geofence &amp; Penalty Policy
                </h2>
                <div className="space-y-2 text-xs text-slate-600">
                  <div className="flex justify-between py-1 border-b border-slate-100">
                    <span>Office Location:</span>
                    <strong className="text-[#0F2744]">{officeConfig.officeName}</strong>
                  </div>
                  <div className="py-1 border-b border-slate-100">
                    <span className="block text-[11px] text-slate-500">Office Address:</span>
                    <strong className="text-[#0F2744] text-[11px] leading-snug block mt-0.5">
                      {officeConfig.officeAddress ||
                        '1ST FLOR ANUPAM COMPLEX,PATERI ROAD,NEAR RELIANCE BAZAR,SATNA MP(485001)'}
                    </strong>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100">
                    <span>Office Coordinates:</span>
                    <span className="font-mono text-slate-800">
                      {Number(officeConfig.officeLatitude).toFixed(5)}, {Number(officeConfig.officeLongitude).toFixed(5)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100">
                    <span>Allowed Office Radius:</span>
                    <strong className="font-mono text-[#15803D]">{officeConfig.officeRadiusMeters} meters</strong>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100">
                    <span>Green ON Cutoff Time:</span>
                    <strong className="font-mono text-[#0F2744]">Up to {officeConfig.attendanceCutoffTime} AM IST</strong>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-100">
                    <span>Late Delay Penalty (After 10 AM):</span>
                    <strong className="font-mono text-[#EA580C]">₹{officeConfig.attendanceLatePenaltyInr} / day</strong>
                  </div>
                  <div className="flex justify-between py-1">
                    <span>Without-Approval Leave Charge:</span>
                    <strong className="font-mono text-[#DC2626]">₹{officeConfig.unapprovedLeavePenaltyInr} / leave</strong>
                  </div>
                </div>

                {canAnchorOfficeGps && (
                  <button
                    type="button"
                    onClick={handleSetOfficeLocationToCurrentGps}
                    disabled={!liveGps}
                    className="w-full mt-2 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-[#0F2744] text-[#0F2744] hover:bg-slate-50 text-xs font-semibold disabled:opacity-40"
                  >
                    <LocateFixed className="w-3.5 h-3.5" />
                    Set Current GPS as Ambika Office Location (Syncs All Apps)
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-[11px] text-slate-500">My Late Attendance Penalty</div>
                  <div className="mt-1 text-lg font-bold font-mono text-[#EA580C]">
                    {formatInr(myTotalLatePenalty)}
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="text-[11px] text-slate-500">My Unapproved Leave Penalty</div>
                  <div className="mt-1 text-lg font-bold font-mono text-[#DC2626]">
                    {formatInr(myTotalUnapprovedPenalty)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Attendance Register Table with Auto Date / Time / Location columns */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-display font-bold text-[#0F2744]">
                Daily Self-Attendance Register (Auto Date / Time / Location Capture)
              </h2>
              <span className="text-xs text-slate-500 tabular-nums">{records.length} records</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-3 py-3 font-semibold">Auto Date</th>
                    <th className="text-left px-3 py-3 font-semibold">Auto Time (IST)</th>
                    <th className="text-left px-3 py-3 font-semibold">Employee &amp; Role</th>
                    <th className="text-left px-3 py-3 font-semibold">Auto GPS Location</th>
                    <th className="text-right px-3 py-3 font-semibold">Office Distance</th>
                    <th className="text-left px-3 py-3 font-semibold">Self-Approval Status</th>
                    <th className="text-right px-3 py-3 font-semibold">Delay Penalty</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-3 font-mono font-semibold text-[#0F2744]">
                        <div>{r.attendanceDate}</div>
                        <div className="text-[10px] text-slate-400">{r.attendanceCode}</div>
                      </td>
                      <td className="px-3 py-3 font-mono">
                        <div className="font-semibold text-slate-800">{r.markedTimeIst}</div>
                        <div className="text-[10px] text-slate-400">
                          {r.autoCaptured ? 'Auto-Captured' : 'Manual'}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-semibold text-slate-900">{r.employeeName}</div>
                        <div className="text-[11px] text-slate-500">
                          {r.employeeCode} · {String(r.employeeRole).replace(/_/g, ' ')}
                        </div>
                      </td>
                      <td className="px-3 py-3 max-w-[230px] text-[11px] text-slate-700">
                        <div>{r.locationLabel}</div>
                        <div className="font-mono text-[10px] text-slate-400">
                          {Number(r.latitude).toFixed(5)}, {Number(r.longitude).toFixed(5)}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono">
                        <span className="text-[#15803D] font-semibold">{r.distanceMeters} m</span>
                        <div className="text-[10px] text-slate-400">Inside Office</div>
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold ${
                            r.status === 'PRESENT'
                              ? 'bg-green-100 text-[#15803D]'
                              : 'bg-amber-100 text-[#EA580C]'
                          }`}
                        >
                          {r.status === 'PRESENT' ? 'SELF-APPROVED (ON TIME)' : 'SELF-APPROVED (LATE)'}
                        </span>
                        {r.notes && <div className="text-[11px] text-slate-500 mt-0.5">{r.notes}</div>}
                      </td>
                      <td className="px-3 py-3 text-right font-mono font-bold">
                        {r.delayPenaltyAmount > 0 ? (
                          <span className="text-[#DC2626]">
                            {formatInr(r.delayPenaltyAmount)}
                            <span className="block text-[10px] font-normal text-slate-500">
                              +{r.delayMinutes}m late
                            </span>
                          </span>
                        ) : (
                          <span className="text-[#15803D]">₹0</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {records.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        No attendance records captured yet.
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
          {/* Leave Application + Unapproved Leave Penalty Panel */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <form
              onSubmit={handleApplyLeave}
              className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-display font-bold text-[#0F2744]">
                    Apply for Leave (Seniority Approval Required)
                  </h2>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Your Approver: <strong>{getClientExpectedLeaveApprover(user.role)}</strong> · Without-approval leave charges{' '}
                    <strong className="text-[#DC2626]">₹{officeConfig.unapprovedLeavePenaltyInr} / leave</strong>.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">From Date *</label>
                  <input
                    type="date"
                    required
                    value={fromDate}
                    onChange={(e) => {
                      setFromDate(e.target.value);
                      if (e.target.value > toDate) setToDate(e.target.value);
                    }}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">To Date *</label>
                  <input
                    type="date"
                    required
                    min={fromDate}
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Leave Type *</label>
                  <select
                    value={leaveType}
                    onChange={(e) => setLeaveType(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="Casual Leave">Casual Leave</option>
                    <option value="Sick Leave">Sick Leave</option>
                    <option value="Emergency Leave">Emergency Leave</option>
                    <option value="Half Day Leave">Half Day Leave</option>
                    <option value="Earned Leave">Earned Leave</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Reason for Leave *
                </label>
                <input
                  type="text"
                  required
                  value={leaveReason}
                  onChange={(e) => setLeaveReason(e.target.value)}
                  placeholder="Enter exact reason for leave (visible to Seniority Approver)"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">
                  Rule: FO → TL | TL / Back Office Lead Gen → BM | BM → Super Admin
                </span>
                <button
                  type="submit"
                  disabled={submittingLeave}
                  className="px-5 py-2.5 rounded-lg bg-[#0F2744] hover:bg-[#16365D] text-white text-xs font-semibold disabled:opacity-50"
                >
                  {submittingLeave ? 'Submitting...' : 'Submit Leave Request'}
                </button>
              </div>
            </form>

            {/* Manager / Admin: Charge Without-Approval Leave Penalty */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm font-display font-bold text-[#0F2744]">
                <ShieldAlert className="w-4 h-4 text-[#DC2626]" />
                Without-Approval Leave Penalty (₹{officeConfig.unapprovedLeavePenaltyInr} / Leave)
              </div>
              <p className="text-[11px] text-slate-500">
                Rejected leave requests automatically charge ₹{officeConfig.unapprovedLeavePenaltyInr} per leave day. Managers/Admin can also directly charge ₹{officeConfig.unapprovedLeavePenaltyInr} for any employee absent without approved leave.
              </p>
              {isManager ? (
                <form onSubmit={handleChargeUnapprovedLeave} className="space-y-2.5">
                  <select
                    value={unapprovedEmpId}
                    onChange={(e) => setUnapprovedEmpId(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">Select Employee (Absent Without Approval)</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.fullName} ({s.employeeCode} · {s.role.replace(/_/g, ' ')})
                      </option>
                    ))}
                  </select>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="date"
                      value={unapprovedDate}
                      onChange={(e) => setUnapprovedDate(e.target.value)}
                      className="px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                    <input
                      type="text"
                      value={unapprovedRemarks}
                      onChange={(e) => setUnapprovedRemarks(e.target.value)}
                      placeholder="Absence remarks..."
                      className="px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full py-2 rounded-lg bg-[#DC2626] hover:bg-red-700 text-white text-xs font-semibold"
                  >
                    Charge ₹{officeConfig.unapprovedLeavePenaltyInr} Unapproved Leave Penalty
                  </button>
                </form>
              ) : (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-[#DC2626]">
                  <AlertTriangle className="w-4 h-4 inline mr-1.5" />
                  Apply leave beforehand to avoid ₹{officeConfig.unapprovedLeavePenaltyInr}/leave unapproved penalty.
                </div>
              )}
            </div>
          </div>

          {/* Leave Register & Seniority Approval Queue */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Leave Applications &amp; Seniority Approval Queue
                </h2>
                <div className="text-[11px] text-slate-500">
                  Seniority Approval Rule: Field Officer → Team Leader | Team Leader / Back Office Lead Gen → Branch Manager | Branch Manager → Super Admin
                </div>
              </div>
              <span className="text-xs text-slate-500 tabular-nums">{leaves.length} applications</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-3 py-3 font-semibold">Leave ID &amp; Employee</th>
                    <th className="text-left px-3 py-3 font-semibold">Dates &amp; Days</th>
                    <th className="text-left px-3 py-3 font-semibold">Leave Reason</th>
                    <th className="text-left px-3 py-3 font-semibold">Seniority Approver</th>
                    <th className="text-left px-3 py-3 font-semibold">Status</th>
                    <th className="text-right px-3 py-3 font-semibold">Penalty (₹100/leave)</th>
                    <th className="text-right px-3 py-3 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {leaves.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-3 align-top">
                        <div className="font-mono font-semibold text-[#0F2744]">{l.leaveCode}</div>
                        <div className="font-semibold text-slate-900">{l.employeeName}</div>
                        <div className="text-[11px] text-slate-500">
                          {l.employeeCode} · {String(l.employeeRole).replace(/_/g, ' ')}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top font-mono">
                        <div>{l.fromDate} → {l.toDate}</div>
                        <div className="text-[11px] text-slate-500">
                          {l.totalDays} day(s) · {l.leaveType}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top max-w-[240px] text-slate-700">
                        {l.reason}
                      </td>
                      <td className="px-3 py-3 align-top text-[11px] text-slate-600">
                        <div className="font-semibold text-[#0F2744]">{l.expectedApproverLabel}</div>
                        {l.reviewedByName && <div>By: {l.reviewedByName}</div>}
                        {l.reviewRemarks && <div className="italic text-slate-500">“{l.reviewRemarks}”</div>}
                      </td>
                      <td className="px-3 py-3 align-top font-bold">
                        <span
                          className={
                            l.approvalStatus === 'APPROVED'
                              ? 'text-[#15803D]'
                              : l.approvalStatus === 'REJECTED'
                              ? 'text-[#DC2626]'
                              : 'text-[#D97706]'
                          }
                        >
                          {l.approvalStatus}
                        </span>
                      </td>
                      <td className="px-3 py-3 align-top text-right font-mono font-bold">
                        {l.unapprovedPenaltyAmount > 0 ? (
                          <span className="text-[#DC2626]">{formatInr(l.unapprovedPenaltyAmount)}</span>
                        ) : (
                          <span className="text-slate-400">₹0</span>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top text-right">
                        {l.canReview && l.approvalStatus === 'PENDING' ? (
                          <div className="flex flex-col items-end gap-1.5 min-w-[180px]">
                            <input
                              type="text"
                              placeholder="Approval / Reject remarks"
                              value={leaveRemarksMap[l.id] || ''}
                              onChange={(e) => setLeaveRemarksMap({ ...leaveRemarksMap, [l.id]: e.target.value })}
                              className="w-full px-2 py-1 text-[11px] border border-slate-300 rounded"
                            />
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleLeaveDecision(l.id, 'APPROVED')}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#15803D] text-white text-[11px] font-semibold"
                              >
                                <CheckCircle2 className="w-3 h-3" />
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => handleLeaveDecision(l.id, 'REJECTED')}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#DC2626] text-white text-[11px] font-semibold"
                              >
                                <XCircle className="w-3 h-3" />
                                Reject
                              </button>
                            </div>
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">
                            {l.approvalStatus === 'PENDING'
                              ? `Awaiting ${l.expectedApproverLabel}`
                              : l.reviewedByName || '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {leaves.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        No leave requests recorded yet.
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
