import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Compass,
  Layers,
  MapPin,
  Maximize2,
  Navigation,
  Route as RouteIcon,
  User,
} from 'lucide-react';

export interface GpsTimelineLog {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  activityType: string;
  leadId: number | null;
  leadCode: string | null;
  customerName: string | null;
  visitNotes: string | null;
  recordedAt: string;
}

interface FieldGpsTimelineViewProps {
  logs: GpsTimelineLog[];
  onRecordCheckInClick?: () => void;
}

function parseUtcDate(value: string): Date {
  if (!value) return new Date(NaN);
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(normalized);
}

function toLocalDateKey(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatLocalTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function formatDateLabel(dateKey: string): string {
  if (!dateKey) return '';
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function shiftDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + deltaDays);
  return toLocalDateKey(dt);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getActivityMeta(activityType: string): {
  label: string;
  color: string;
  badgeClass: string;
} {
  switch (activityType) {
    case 'VISIT_CHECKIN':
      return {
        label: 'Visit Check-In',
        color: '#15803D',
        badgeClass: 'bg-green-50 text-[#15803D] border-green-200',
      };
    case 'VISIT_CHECKOUT':
      return {
        label: 'Visit Check-Out',
        color: '#EA580C',
        badgeClass: 'bg-orange-50 text-[#EA580C] border-orange-200',
      };
    case 'TRACKING_START':
      return {
        label: 'Shift Started',
        color: '#0F2744',
        badgeClass: 'bg-slate-100 text-[#0F2744] border-slate-300',
      };
    case 'TRACKING_STOP':
      return {
        label: 'Shift Ended',
        color: '#475569',
        badgeClass: 'bg-slate-100 text-slate-700 border-slate-300',
      };
    default:
      return {
        label: 'Location Ping',
        color: '#2563EB',
        badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
      };
  }
}

export const FieldGpsTimelineView: React.FC<FieldGpsTimelineViewProps> = ({
  logs,
  onRecordCheckInClick,
}) => {
  const todayKey = useMemo(() => toLocalDateKey(new Date()), []);

  const parsedLogs = useMemo(() => {
    return logs
      .map((l) => {
        const dt = parseUtcDate(l.recordedAt);
        return {
          ...l,
          latitude: Number(l.latitude),
          longitude: Number(l.longitude),
          parsedDate: dt,
          dateKey: toLocalDateKey(dt),
          timestampMs: dt.getTime(),
        };
      })
      .filter((l) => !Number.isNaN(l.latitude) && !Number.isNaN(l.longitude) && !Number.isNaN(l.timestampMs));
  }, [logs]);

  // Distinct dates available (prioritize dates that have check-in/check-out records)
  const activeDates = useMemo(() => {
    const checkSet = new Set<string>();
    const allSet = new Set<string>();
    for (const item of parsedLogs) {
      if (!item.dateKey) continue;
      allSet.add(item.dateKey);
      if (item.activityType === 'VISIT_CHECKIN' || item.activityType === 'VISIT_CHECKOUT') {
        checkSet.add(item.dateKey);
      }
    }
    const chosen = checkSet.size > 0 ? Array.from(checkSet) : Array.from(allSet);
    return chosen.sort((a, b) => b.localeCompare(a));
  }, [parsedLogs]);

  const [selectedDate, setSelectedDate] = useState<string>(() => todayKey);
  const [dateInitialized, setDateInitialized] = useState(false);
  const [employeeFilter, setEmployeeFilter] = useState<string>('ALL');
  const [onlyCheckInsOuts, setOnlyCheckInsOuts] = useState<boolean>(true);
  const [selectedStopId, setSelectedStopId] = useState<number | null>(null);
  const [mapMode, setMapMode] = useState<'street' | 'coordinate'>('street');
  const [tileErrorCount, setTileErrorCount] = useState(0);

  // Default to today if today has records, otherwise most recent active date
  useEffect(() => {
    if (!dateInitialized && activeDates.length > 0) {
      setSelectedDate(activeDates.includes(todayKey) ? todayKey : activeDates[0]);
      setDateInitialized(true);
    }
  }, [activeDates, dateInitialized, todayKey]);

  const employees = useMemo(() => {
    const map = new Map<number, { id: number; name: string; code: string }>();
    for (const l of parsedLogs) {
      if (!map.has(l.employeeId)) {
        map.set(l.employeeId, { id: l.employeeId, name: l.employeeName, code: l.employeeCode });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [parsedLogs]);

  const dayStops = useMemo(() => {
    const filtered = parsedLogs.filter((l) => {
      if (l.dateKey !== selectedDate) return false;
      if (employeeFilter !== 'ALL' && String(l.employeeId) !== employeeFilter) return false;
      if (onlyCheckInsOuts && l.activityType !== 'VISIT_CHECKIN' && l.activityType !== 'VISIT_CHECKOUT') {
        return false;
      }
      return true;
    });
    // Strictly chronological ascending (earliest stop -> latest stop)
    filtered.sort((a, b) => a.timestampMs - b.timestampMs || a.id - b.id);

    return filtered.map((stop, idx) => {
      const prev = idx > 0 ? filtered[idx - 1] : null;
      const distFromPrevKm = prev
        ? haversineKm(prev.latitude, prev.longitude, stop.latitude, stop.longitude)
        : 0;
      const minsFromPrev = prev ? Math.max(0, Math.round((stop.timestampMs - prev.timestampMs) / 60000)) : 0;
      return {
        ...stop,
        seq: idx + 1,
        distFromPrevKm,
        minsFromPrev,
      };
    });
  }, [parsedLogs, selectedDate, employeeFilter, onlyCheckInsOuts]);

  // Keep selectedStopId valid
  useEffect(() => {
    if (dayStops.length === 0) {
      setSelectedStopId(null);
    } else if (!dayStops.some((s) => s.id === selectedStopId)) {
      setSelectedStopId(dayStops[0].id);
    }
  }, [dayStops]);

  const totalRouteKm = useMemo(
    () => dayStops.reduce((sum, s) => sum + s.distFromPrevKm, 0),
    [dayStops]
  );
  const checkInCount = useMemo(
    () => dayStops.filter((s) => s.activityType === 'VISIT_CHECKIN').length,
    [dayStops]
  );
  const checkOutCount = useMemo(
    () => dayStops.filter((s) => s.activityType === 'VISIT_CHECKOUT').length,
    [dayStops]
  );
  const uniqueCustomerCount = useMemo(() => {
    const set = new Set(
      dayStops.map((s) => s.leadCode || s.customerName).filter((v): v is string => Boolean(v))
    );
    return set.size;
  }, [dayStops]);

  // Leaflet Map Instance & Layers
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const markerMapRef = useRef<Map<number, L.Marker>>(new Map());
  const stopCardRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Initialize Leaflet map when street mode container is mounted
  useEffect(() => {
    if (mapMode !== 'street' || !mapContainerRef.current) return;
    if (mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [19.076, 72.8777],
      zoom: 12,
      zoomControl: true,
    });

    const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    });

    tileLayer.on('tileerror', () => {
      setTileErrorCount((c) => c + 1);
    });

    tileLayer.addTo(map);
    const layerGroup = L.layerGroup().addTo(map);

    mapInstanceRef.current = map;
    layerGroupRef.current = layerGroup;

    // Ensure container dimensions settle after tab switch
    const resizeTimer = window.setTimeout(() => {
      map.invalidateSize();
    }, 120);

    return () => {
      window.clearTimeout(resizeTimer);
      map.remove();
      mapInstanceRef.current = null;
      layerGroupRef.current = null;
      markerMapRef.current.clear();
    };
  }, [mapMode]);

  // Render chronological pins + connecting route polyline whenever dayStops or selection updates
  const fitAllStops = () => {
    const map = mapInstanceRef.current;
    if (!map || dayStops.length === 0) return;
    if (dayStops.length === 1) {
      map.setView([dayStops[0].latitude, dayStops[0].longitude], 15, { animate: true });
      return;
    }
    const bounds = L.latLngBounds(dayStops.map((s) => [s.latitude, s.longitude] as [number, number]));
    map.fitBounds(bounds, { padding: [44, 44], maxZoom: 15, animate: true });
  };

  useEffect(() => {
    const map = mapInstanceRef.current;
    const layerGroup = layerGroupRef.current;
    if (mapMode !== 'street' || !map || !layerGroup) return;

    layerGroup.clearLayers();
    markerMapRef.current.clear();

    if (dayStops.length === 0) {
      map.setView([19.076, 72.8777], 11);
      return;
    }

    // Draw chronological route polyline
    if (dayStops.length >= 2) {
      const coords = dayStops.map((s) => [s.latitude, s.longitude] as [number, number]);
      L.polyline(coords, {
        color: '#0F2744',
        weight: 3.5,
        opacity: 0.85,
        dashArray: '7, 6',
      }).addTo(layerGroup);
    }

    // Draw numbered chronological pins
    dayStops.forEach((stop) => {
      const meta = getActivityMeta(stop.activityType);
      const isSelected = stop.id === selectedStopId;
      const size = isSelected ? 34 : 28;

      const icon = L.divIcon({
        className: 'ambika-timeline-pin',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        popupAnchor: [0, -size / 2],
        html: `<div style="
          width:${size}px;
          height:${size}px;
          border-radius:9999px;
          background:${meta.color};
          color:#ffffff;
          border:${isSelected ? '3px solid #FACC15' : '2.5px solid #ffffff'};
          box-shadow:0 2px 8px rgba(15,39,68,0.38);
          display:flex;
          align-items:center;
          justify-content:center;
          font-family:JetBrains Mono,monospace;
          font-weight:700;
          font-size:${isSelected ? '13px' : '11px'};
          cursor:pointer;
        ">${stop.seq}</div>`,
      });

      const marker = L.marker([stop.latitude, stop.longitude], {
        icon,
        zIndexOffset: isSelected ? 500 : stop.seq,
      });

      const title = stop.customerName || stop.leadCode || meta.label;
      const notesHtml = stop.visitNotes
        ? `<div style="margin-top:4px;color:#334155;">${stop.visitNotes.replace(/</g, '&lt;')}</div>`
        : '';
      const legHtml =
        stop.seq > 1
          ? `<div style="margin-top:4px;font-size:11px;color:#64748B;">+${stop.distFromPrevKm.toFixed(2)} km · ${stop.minsFromPrev} min from Stop #${stop.seq - 1}</div>`
          : '';

      marker.bindPopup(
        `<div style="min-width:190px;font-family:DM Sans,system-ui,sans-serif;font-size:12px;line-height:1.45;">
          <div style="font-weight:700;color:${meta.color};">#${stop.seq} · ${meta.label}</div>
          <div style="font-weight:700;color:#0F2744;margin-top:2px;">${title.replace(/</g, '&lt;')}</div>
          <div style="color:#475569;font-size:11px;margin-top:2px;">${stop.employeeName.replace(/</g, '&lt;')} (${stop.employeeCode})</div>
          <div style="font-family:JetBrains Mono,monospace;font-size:11px;color:#0F2744;margin-top:3px;">${formatLocalTime(stop.parsedDate)}</div>
          <div style="font-family:JetBrains Mono,monospace;font-size:10px;color:#64748B;">${stop.latitude.toFixed(5)}, ${stop.longitude.toFixed(5)}</div>
          ${notesHtml}
          ${legHtml}
        </div>`
      );

      marker.on('click', () => {
        setSelectedStopId(stop.id);
        const btn = stopCardRefs.current.get(stop.id);
        btn?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });

      marker.addTo(layerGroup);
      markerMapRef.current.set(stop.id, marker);
    });

    fitAllStops();
  }, [dayStops, mapMode]);

  // Update marker highlight & focus popup when user clicks a timeline item
  const handleSelectStop = (stopId: number) => {
    setSelectedStopId(stopId);
    const stop = dayStops.find((s) => s.id === stopId);
    if (!stop) return;

    const map = mapInstanceRef.current;
    const marker = markerMapRef.current.get(stopId);
    if (map && mapMode === 'street') {
      map.setView([stop.latitude, stop.longitude], Math.max(map.getZoom(), 15), { animate: true });
      marker?.openPopup();
    }
  };

  // Re-style selected marker ring without resetting zoom when selectedStopId changes
  useEffect(() => {
    if (mapMode !== 'street') return;
    dayStops.forEach((stop) => {
      const marker = markerMapRef.current.get(stop.id);
      if (!marker) return;
      const meta = getActivityMeta(stop.activityType);
      const isSelected = stop.id === selectedStopId;
      const size = isSelected ? 34 : 28;
      marker.setIcon(
        L.divIcon({
          className: 'ambika-timeline-pin',
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
          popupAnchor: [0, -size / 2],
          html: `<div style="
            width:${size}px;
            height:${size}px;
            border-radius:9999px;
            background:${meta.color};
            color:#ffffff;
            border:${isSelected ? '3px solid #FACC15' : '2.5px solid #ffffff'};
            box-shadow:0 2px 8px rgba(15,39,68,0.38);
            display:flex;
            align-items:center;
            justify-content:center;
            font-family:JetBrains Mono,monospace;
            font-weight:700;
            font-size:${isSelected ? '13px' : '11px'};
            cursor:pointer;
          ">${stop.seq}</div>`,
        })
      );
      marker.setZIndexOffset(isSelected ? 500 : stop.seq);
    });
  }, [selectedStopId, dayStops, mapMode]);

  // Coordinate-plot SVG geometry (works 100% offline or when user chooses Coordinate Plot view)
  const svgPlot = useMemo(() => {
    if (dayStops.length === 0) return null;
    const width = 640;
    const height = 400;
    const pad = 54;
    const lats = dayStops.map((s) => s.latitude);
    const lngs = dayStops.map((s) => s.longitude);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const latSpan = Math.max(0.008, maxLat - minLat);
    const lngSpan = Math.max(0.008, maxLng - minLng);

    const points = dayStops.map((s) => {
      const x =
        dayStops.length === 1 || maxLng === minLng
          ? width / 2
          : pad + ((s.longitude - minLng) / lngSpan) * (width - pad * 2);
      const y =
        dayStops.length === 1 || maxLat === minLat
          ? height / 2
          : height - pad - ((s.latitude - minLat) / latSpan) * (height - pad * 2);
      return { ...s, x, y };
    });

    return { width, height, minLat, maxLat, minLng, maxLng, points };
  }, [dayStops]);

  return (
    <div className="space-y-4">
      {/* Timeline Filters & Date Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center rounded-lg border border-slate-300 bg-white overflow-hidden">
              <button
                type="button"
                onClick={() => setSelectedDate(shiftDateKey(selectedDate, -1))}
                className="p-2 hover:bg-slate-50 text-[#0F2744] border-r border-slate-200"
                title="Previous day"
                aria-label="Previous day"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-[#0F2744]">
                <Calendar className="w-3.5 h-3.5 text-[#EA580C]" />
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
                  className="font-mono text-xs bg-transparent focus:outline-none"
                />
              </label>
              <button
                type="button"
                onClick={() => setSelectedDate(shiftDateKey(selectedDate, 1))}
                className="p-2 hover:bg-slate-50 text-[#0F2744] border-l border-slate-200"
                title="Next day"
                aria-label="Next day"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => setSelectedDate(todayKey)}
              className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                selectedDate === todayKey
                  ? 'bg-[#0F2744] text-white border-[#0F2744]'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              Today
            </button>

            {employees.length > 1 && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white">
                <User className="w-3.5 h-3.5 text-slate-500" />
                <select
                  value={employeeFilter}
                  onChange={(e) => setEmployeeFilter(e.target.value)}
                  className="text-xs font-medium text-[#0F2744] bg-transparent focus:outline-none"
                >
                  <option value="ALL">All Field Staff ({employees.length})</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} ({emp.code})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center p-0.5 bg-slate-100 rounded-lg border border-slate-200">
              <button
                type="button"
                onClick={() => setOnlyCheckInsOuts(true)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap ${
                  onlyCheckInsOuts ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
                }`}
              >
                Check-In / Out Only
              </button>
              <button
                type="button"
                onClick={() => setOnlyCheckInsOuts(false)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap ${
                  !onlyCheckInsOuts ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
                }`}
              >
                All GPS Fixes
              </button>
            </div>

            <div className="inline-flex items-center p-0.5 bg-slate-100 rounded-lg border border-slate-200">
              <button
                type="button"
                onClick={() => setMapMode('street')}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap ${
                  mapMode === 'street' ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                Street Map
              </button>
              <button
                type="button"
                onClick={() => setMapMode('coordinate')}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap ${
                  mapMode === 'coordinate' ? 'bg-white text-[#0F2744] shadow-sm' : 'text-slate-600'
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                GPS Route Plot
              </button>
            </div>
          </div>
        </div>

        {/* Quick-jump active dates bar */}
        {activeDates.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 text-[11px]">
            <span className="text-slate-500 font-medium mr-1">Dates with GPS Visits:</span>
            {activeDates.slice(0, 6).map((dt) => (
              <button
                key={dt}
                type="button"
                onClick={() => setSelectedDate(dt)}
                className={`px-2.5 py-1 rounded-md font-mono font-semibold border transition-colors ${
                  selectedDate === dt
                    ? 'bg-[#EA580C] text-white border-[#EA580C]'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {dt}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Date Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-lg p-3.5">
          <div className="text-[11px] text-slate-500">Check-Ins / Check-Outs</div>
          <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#0F2744]">
            <span className="text-[#15803D]">{checkInCount}</span>
            <span className="text-slate-400 mx-1">/</span>
            <span className="text-[#EA580C]">{checkOutCount}</span>
            <span className="text-xs font-normal text-slate-500 ml-1.5">
              ({dayStops.length} total)
            </span>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-3.5">
          <div className="text-[11px] text-slate-500">Chronological Span</div>
          <div className="mt-1 text-xs sm:text-sm font-bold font-mono tabular-nums text-[#0F2744]">
            {dayStops.length > 0
              ? `${formatLocalTime(dayStops[0].parsedDate)} → ${formatLocalTime(dayStops[dayStops.length - 1].parsedDate)}`
              : '—'}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-3.5">
          <div className="text-[11px] text-slate-500">Point-to-Point Route</div>
          <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#15803D]">
            {totalRouteKm.toFixed(2)} km
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-3.5">
          <div className="text-[11px] text-slate-500">Customers / Leads Visited</div>
          <div className="mt-1 text-lg font-bold font-mono tabular-nums text-[#0F2744]">
            {uniqueCustomerCount}
          </div>
        </div>
      </div>

      {dayStops.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
          <MapPin className="w-9 h-9 text-slate-300 mx-auto" />
          <div className="text-sm font-display font-bold text-[#0F2744]">
            No {onlyCheckInsOuts ? 'Check-In / Check-Out' : 'GPS'} locations recorded on{' '}
            {formatDateLabel(selectedDate)}
          </div>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Select another date above or record a customer Visit Check-In / Check-Out from GPS Location &amp; Visits.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {activeDates[0] && activeDates[0] !== selectedDate && (
              <button
                type="button"
                onClick={() => setSelectedDate(activeDates[0])}
                className="px-3.5 py-2 rounded-lg bg-[#0F2744] text-white text-xs font-semibold"
              >
                Jump to {activeDates[0]}
              </button>
            )}
            {onlyCheckInsOuts && (
              <button
                type="button"
                onClick={() => setOnlyCheckInsOuts(false)}
                className="px-3.5 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-[#0F2744]"
              >
                Include Shift GPS Pings
              </button>
            )}
            {onRecordCheckInClick && (
              <button
                type="button"
                onClick={onRecordCheckInClick}
                className="px-3.5 py-2 rounded-lg bg-[#EA580C] text-white text-xs font-semibold"
              >
                Record Visit Check-In
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Chronological Interactive Map */}
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <RouteIcon className="w-4 h-4 text-[#EA580C]" />
                <div>
                  <h2 className="text-sm font-display font-bold text-[#0F2744]">
                    Chronological Route Map · {formatDateLabel(selectedDate)}
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    Numbered stops (#1 → #{dayStops.length}) in exact time order · Green: Check-In · Orange: Check-Out
                  </p>
                </div>
              </div>
              {mapMode === 'street' && (
                <button
                  type="button"
                  onClick={fitAllStops}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-[#0F2744]"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                  Fit Route
                </button>
              )}
            </div>

            {tileErrorCount > 3 && mapMode === 'street' && (
              <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800 flex items-center justify-between gap-2">
                <span>Map tiles are unreachable offline. Switch to GPS Route Plot for clean offline visualization.</span>
                <button
                  type="button"
                  onClick={() => setMapMode('coordinate')}
                  className="px-2.5 py-1 rounded bg-[#0F2744] text-white font-semibold shrink-0"
                >
                  Use Route Plot
                </button>
              </div>
            )}

            {mapMode === 'street' ? (
              <div ref={mapContainerRef} className="w-full h-[420px] sm:h-[480px] z-0" />
            ) : (
              svgPlot && (
                <div className="p-4 bg-slate-50">
                  <svg
                    viewBox={`0 0 ${svgPlot.width} ${svgPlot.height}`}
                    className="w-full h-[390px] sm:h-[440px] bg-white border border-slate-200 rounded-lg"
                  >
                    {/* Coordinate Grid Lines */}
                    {[0.2, 0.4, 0.6, 0.8].map((f) => (
                      <g key={f}>
                        <line
                          x1={0}
                          y1={svgPlot.height * f}
                          x2={svgPlot.width}
                          y2={svgPlot.height * f}
                          stroke="#E2E8F0"
                          strokeDasharray="4 4"
                        />
                        <line
                          x1={svgPlot.width * f}
                          y1={0}
                          x2={svgPlot.width * f}
                          y2={svgPlot.height}
                          stroke="#E2E8F0"
                          strokeDasharray="4 4"
                        />
                      </g>
                    ))}
                    {/* Route Polyline */}
                    {svgPlot.points.length >= 2 && (
                      <polyline
                        fill="none"
                        stroke="#0F2744"
                        strokeWidth="2.5"
                        strokeDasharray="6 5"
                        points={svgPlot.points.map((p) => `${p.x},${p.y}`).join(' ')}
                      />
                    )}
                    {/* Stops */}
                    {svgPlot.points.map((pt) => {
                      const meta = getActivityMeta(pt.activityType);
                      const isSel = pt.id === selectedStopId;
                      return (
                        <g
                          key={pt.id}
                          className="cursor-pointer"
                          onClick={() => handleSelectStop(pt.id)}
                        >
                          <circle
                            cx={pt.x}
                            cy={pt.y}
                            r={isSel ? 17 : 13}
                            fill={meta.color}
                            stroke={isSel ? '#FACC15' : '#FFFFFF'}
                            strokeWidth={isSel ? 3.5 : 2.5}
                          />
                          <text
                            x={pt.x}
                            y={pt.y + 4}
                            textAnchor="middle"
                            fill="#FFFFFF"
                            fontSize="11"
                            fontWeight="bold"
                            fontFamily="JetBrains Mono, monospace"
                          >
                            {pt.seq}
                          </text>
                          <text
                            x={pt.x}
                            y={pt.y - (isSel ? 22 : 18)}
                            textAnchor="middle"
                            fill="#0F2744"
                            fontSize="10"
                            fontWeight="600"
                          >
                            {(pt.customerName || pt.leadCode || meta.label).slice(0, 18)}
                          </text>
                        </g>
                      );
                    })}
                    {/* Bounds Label */}
                    <text x="12" y={svgPlot.height - 10} fontSize="10" fill="#64748B" fontFamily="JetBrains Mono, monospace">
                      Lat {svgPlot.minLat.toFixed(4)}–{svgPlot.maxLat.toFixed(4)} · Lng {svgPlot.minLng.toFixed(4)}–{svgPlot.maxLng.toFixed(4)}
                    </text>
                  </svg>
                </div>
              )
            )}
          </div>

          {/* Chronological Timeline List */}
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-display font-bold text-[#0F2744]">
                  Chronological Visit Timeline
                </h2>
                <p className="text-[11px] text-slate-500">
                  Earliest to latest stop · Click any stop to focus on map
                </p>
              </div>
              <span className="font-mono text-xs font-bold text-[#0F2744] tabular-nums">
                {dayStops.length} stop{dayStops.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="p-4 max-h-[500px] overflow-y-auto space-y-3">
              {dayStops.map((stop, idx) => {
                const meta = getActivityMeta(stop.activityType);
                const isSelected = stop.id === selectedStopId;
                return (
                  <div key={stop.id} className="relative pl-9">
                    {/* Vertical timeline connector */}
                    {idx < dayStops.length - 1 && (
                      <div
                        className="absolute left-[13px] top-7 bottom-[-14px] w-0.5 bg-slate-200"
                        aria-hidden="true"
                      />
                    )}

                    {/* Sequence circle */}
                    <div
                      style={{ backgroundColor: meta.color }}
                      className={`absolute left-0 top-2 w-7 h-7 rounded-full text-white font-mono text-xs font-bold flex items-center justify-center shadow-sm border-2 ${
                        isSelected ? 'border-yellow-300 ring-2 ring-[#EA580C]/40' : 'border-white'
                      }`}
                    >
                      {stop.seq}
                    </div>

                    <button
                      ref={(el) => {
                        if (el) stopCardRefs.current.set(stop.id, el);
                        else stopCardRefs.current.delete(stop.id);
                      }}
                      type="button"
                      onClick={() => handleSelectStop(stop.id)}
                      className={`w-full text-left rounded-xl border p-3 transition-all ${
                        isSelected
                          ? 'bg-orange-50/50 border-[#EA580C] shadow-sm'
                          : 'bg-white border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-bold ${meta.badgeClass}`}
                        >
                          {meta.label}
                        </span>
                        <span className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-[#0F2744] tabular-nums">
                          <Clock className="w-3 h-3 text-slate-400" />
                          {formatLocalTime(stop.parsedDate)}
                        </span>
                      </div>

                      <div className="mt-1.5 text-xs font-bold text-[#0F2744]">
                        {stop.customerName || stop.leadCode || 'Field Location'}
                        {stop.leadCode && stop.customerName && (
                          <span className="ml-1.5 font-mono text-[11px] font-semibold text-[#EA580C]">
                            ({stop.leadCode})
                          </span>
                        )}
                      </div>

                      <div className="mt-1 text-[11px] text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span>
                          {stop.employeeName} <span className="font-mono text-slate-400">({stop.employeeCode})</span>
                        </span>
                        <span className="font-mono tabular-nums text-slate-500">
                          {stop.latitude.toFixed(5)}, {stop.longitude.toFixed(5)}
                          {stop.accuracy ? ` (±${Math.round(stop.accuracy)}m)` : ''}
                        </span>
                      </div>

                      {stop.visitNotes && (
                        <div className="mt-1.5 text-[11px] text-slate-700 bg-slate-50 rounded px-2 py-1 border border-slate-100">
                          {stop.visitNotes}
                        </div>
                      )}

                      {idx > 0 && (
                        <div className="mt-1.5 text-[10px] font-mono text-slate-500 flex items-center gap-1.5">
                          <Navigation className="w-3 h-3 text-[#0F2744]" />
                          <span>
                            From Stop #{stop.seq - 1}: +{stop.distFromPrevKm.toFixed(2)} km · {stop.minsFromPrev} min elapsed
                          </span>
                        </div>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
