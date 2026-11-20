import type { FieldOfficerWorkload, LoadBalanceCandidate } from '../shared/types.ts';
import { db, getSettings } from './db.ts';

export interface LeadGeoInput {
  city?: string | null;
  state?: string | null;
  pinCode?: string | null;
  address?: string | null;
  branchId?: number | null;
}

const CITY_POSTAL_ZONES: Record<string, string[]> = {
  mumbai: ['400', '401'],
  thane: ['400', '401', '421'],
  'navi mumbai': ['400', '410'],
  pune: ['411', '412'],
  surat: ['394', '395'],
  ahmedabad: ['380', '382'],
  vadodara: ['390', '391'],
  rajkot: ['360'],
  nashik: ['422'],
  nagpur: ['440'],
  delhi: ['110'],
  'new delhi': ['110'],
  noida: ['201'],
  gurgaon: ['122'],
  gurugram: ['122'],
  bengaluru: ['560'],
  bangalore: ['560'],
  hyderabad: ['500'],
  chennai: ['600'],
  kolkata: ['700'],
  jaipur: ['302'],
  indore: ['452'],
  bhopal: ['462'],
  satna: ['485'],
  rewa: ['486'],
  lucknow: ['226'],
};

const CITY_HUB_COORDS: Record<string, { lat: number; lng: number }> = {
  satna: { lat: 24.5773, lng: 80.8272 },
  rewa: { lat: 24.5362, lng: 81.3037 },
  mumbai: { lat: 19.076, lng: 72.8777 },
  thane: { lat: 19.2183, lng: 72.9781 },
  'navi mumbai': { lat: 19.033, lng: 73.0297 },
  pune: { lat: 18.5204, lng: 73.8567 },
  surat: { lat: 21.1702, lng: 72.8311 },
  ahmedabad: { lat: 23.0225, lng: 72.5714 },
  nashik: { lat: 19.9975, lng: 73.7898 },
  nagpur: { lat: 21.1458, lng: 79.0882 },
  delhi: { lat: 28.6139, lng: 77.209 },
  bengaluru: { lat: 12.9716, lng: 77.5946 },
  bangalore: { lat: 12.9716, lng: 77.5946 },
  hyderabad: { lat: 17.385, lng: 78.4867 },
  chennai: { lat: 13.0827, lng: 80.2707 },
  kolkata: { lat: 22.5726, lng: 88.3639 },
  jaipur: { lat: 26.9124, lng: 75.7873 },
  indore: { lat: 22.7196, lng: 75.8577 },
};

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeStr(v?: string | null): string {
  return (v ?? '').trim().toLowerCase();
}

function parseTerritoryTokens(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\n|]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);
}

function resolveHubCoords(city?: string | null, pinCode?: string | null): { lat: number; lng: number } | null {
  const c = normalizeStr(city);
  for (const [hub, coords] of Object.entries(CITY_HUB_COORDS)) {
    if (c && (c === hub || c.includes(hub))) {
      return coords;
    }
  }
  const pin3 = (pinCode ?? '').replace(/\D/g, '').slice(0, 3);
  if (pin3.length === 3) {
    for (const [hub, prefixes] of Object.entries(CITY_POSTAL_ZONES)) {
      if (prefixes.includes(pin3) && CITY_HUB_COORDS[hub]) {
        return CITY_HUB_COORDS[hub];
      }
    }
  }
  return null;
}

export function getOfficerWorkloadSnapshots(options?: {
  includeTeamLeaders?: boolean;
  allowedOfficerIds?: number[];
}): FieldOfficerWorkload[] {
  const settings = getSettings();
  const maxActiveLeads = Math.max(1, Number(settings.autoAssignMaxActiveLeads ?? 25));

  const fetchRoles = (roles: string[]) => {
    const placeholders = roles.map(() => '?').join(',');
    return db
      .prepare(`
        SELECT u.id, u.employee_code as employeeCode, u.full_name as fullName, u.mobile, u.role,
          u.branch_id as branchId, b.name as branchName, b.city as branchCity, b.state as branchState,
          u.team_id as teamId, t.name as teamName,
          u.service_city as serviceCity, u.service_pincodes as servicePincodes,
          tl.id as teamLeaderId, tl.full_name as teamLeaderName, tl.employee_code as teamLeaderCode,
          bm.id as branchManagerId, bm.full_name as branchManagerName, bm.employee_code as branchManagerCode
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN teams t ON t.id = u.team_id
        LEFT JOIN users tl ON tl.id = COALESCE(
          CASE WHEN u.role = 'TEAM_LEADER' THEN u.id ELSE u.reports_to_user_id END,
          t.leader_user_id
        )
        LEFT JOIN users bm ON bm.id = COALESCE(
          tl.reports_to_user_id,
          (SELECT bmu.id FROM users bmu WHERE bmu.role = 'BRANCH_MANAGER' AND bmu.branch_id = u.branch_id AND bmu.is_active = 1 LIMIT 1)
        )
        WHERE u.is_active = 1 AND u.role IN (${placeholders})
        ORDER BY CASE WHEN u.role = 'FIELD_OFFICER' THEN 0 ELSE 1 END, u.full_name ASC
      `)
      .all(...roles) as any[];
  };

  let officerRows = fetchRoles(['FIELD_OFFICER']);
  if (officerRows.length === 0 || options?.includeTeamLeaders) {
    const withTl = fetchRoles(['FIELD_OFFICER', 'TEAM_LEADER']);
    if (officerRows.length === 0 || options?.includeTeamLeaders) {
      officerRows = withTl;
    }
  }
  if (options?.allowedOfficerIds) {
    const allowedSet = new Set(options.allowedOfficerIds.map((id) => Number(id)));
    officerRows = officerRows.filter((o) => allowedSet.has(Number(o.id)));
  }

  const workloadRows = db
    .prepare(`
      SELECT
        assigned_officer_id as officerId,
        COUNT(CASE WHEN status NOT IN ('Disbursed', 'Rejected', 'Closed') THEN 1 END) as activeLeadCount,
        COUNT(CASE WHEN status IN ('Lead Generated', 'Lead Assigned', 'Follow-up Pending', 'Documents Pending', 'Query Raised') THEN 1 END) as urgentPendingCount,
        COUNT(CASE WHEN assigned_at IS NOT NULL AND date(assigned_at) = date('now') THEN 1 END) as assignedTodayCount,
        COUNT(CASE WHEN status = 'Disbursed' THEN 1 END) as disbursedCount,
        COALESCE(SUM(CASE WHEN status NOT IN ('Disbursed', 'Rejected', 'Closed') THEN loan_amount ELSE 0 END), 0) as activePipelineAmount,
        MAX(assigned_at) as lastAssignedAt
      FROM leads
      WHERE assigned_officer_id IS NOT NULL
      GROUP BY assigned_officer_id
    `)
    .all() as any[];

  const workloadMap = new Map<number, any>();
  for (const w of workloadRows) {
    workloadMap.set(Number(w.officerId), w);
  }

  const gpsRows = db
    .prepare(`
      SELECT g.employee_id as employeeId, g.latitude, g.longitude, g.recorded_at as recordedAt
      FROM gps_logs g
      INNER JOIN (
        SELECT employee_id, MAX(id) as maxId
        FROM gps_logs
        GROUP BY employee_id
      ) latest ON latest.maxId = g.id
    `)
    .all() as any[];

  const gpsMap = new Map<number, any>();
  for (const g of gpsRows) {
    gpsMap.set(Number(g.employeeId), g);
  }

  return officerRows.map((o) => {
    const w = workloadMap.get(Number(o.id));
    const g = gpsMap.get(Number(o.id));
    const activeLeadCount = Number(w?.activeLeadCount ?? 0);
    const urgentPendingCount = Number(w?.urgentPendingCount ?? 0);
    const assignedTodayCount = Number(w?.assignedTodayCount ?? 0);
    const disbursedCount = Number(w?.disbursedCount ?? 0);
    const activePipelineAmount = Number(w?.activePipelineAmount ?? 0);
    const utilizationPct = Math.min(100, Math.round((activeLeadCount / maxActiveLeads) * 100));

    let loadStatus: FieldOfficerWorkload['loadStatus'] = 'AVAILABLE';
    if (activeLeadCount >= maxActiveLeads) loadStatus = 'AT_CAPACITY';
    else if (utilizationPct >= 75) loadStatus = 'HIGH_LOAD';
    else if (utilizationPct >= 35 || activeLeadCount >= 3) loadStatus = 'BALANCED';

    return {
      id: Number(o.id),
      employeeCode: o.employeeCode,
      fullName: o.fullName,
      mobile: o.mobile,
      role: o.role,
      branchId: o.branchId ? Number(o.branchId) : null,
      branchName: o.branchName ?? null,
      branchCity: o.branchCity ?? null,
      branchState: o.branchState ?? null,
      teamId: o.teamId ? Number(o.teamId) : null,
      teamName: o.teamName ?? null,
      teamLeaderId: o.teamLeaderId ? Number(o.teamLeaderId) : null,
      teamLeaderName: o.teamLeaderName ?? null,
      teamLeaderCode: o.teamLeaderCode ?? null,
      branchManagerId: o.branchManagerId ? Number(o.branchManagerId) : null,
      branchManagerName: o.branchManagerName ?? null,
      branchManagerCode: o.branchManagerCode ?? null,
      serviceCity: o.serviceCity ?? o.branchCity ?? null,
      servicePincodes: o.servicePincodes ?? null,
      activeLeadCount,
      urgentPendingCount,
      assignedTodayCount,
      disbursedCount,
      activePipelineAmount,
      utilizationPct,
      loadStatus,
      lastAssignedAt: w?.lastAssignedAt ?? null,
      lastGpsAt: g?.recordedAt ?? null,
      lastGpsLat: g?.latitude != null ? Number(g.latitude) : null,
      lastGpsLng: g?.longitude != null ? Number(g.longitude) : null,
    };
  });
}

export function scoreOfficersForLead(
  lead: LeadGeoInput,
  options?: {
    excludeOfficerId?: number | null;
    overrideMaxActiveLeads?: number;
    overrideGeoWeight?: number;
    allowedOfficerIds?: number[];
  }
): {
  best: LoadBalanceCandidate | null;
  candidates: LoadBalanceCandidate[];
  settingsUsed: {
    autoAssignIncomingLeads: boolean;
    maxActiveLeads: number;
    geoWeight: number;
  };
} {
  const settings = getSettings();
  const maxActiveLeads = Math.max(
    1,
    Number(options?.overrideMaxActiveLeads ?? settings.autoAssignMaxActiveLeads ?? 25)
  );
  const geoWeight = Math.min(
    100,
    Math.max(0, Number(options?.overrideGeoWeight ?? settings.autoAssignGeoWeight ?? 60))
  );

  // Normalize weights around 60/40 reference
  const geoScale = geoWeight / 60;
  const workScale = (100 - geoWeight) / 40;

  let officers = getOfficerWorkloadSnapshots(
    options?.allowedOfficerIds ? { allowedOfficerIds: options.allowedOfficerIds } : undefined
  );
  if (options?.excludeOfficerId) {
    const filtered = officers.filter((o) => o.id !== options.excludeOfficerId);
    if (filtered.length > 0) officers = filtered;
  }

  if (officers.length === 0) {
    return {
      best: null,
      candidates: [],
      settingsUsed: {
        autoAssignIncomingLeads: Boolean(settings.autoAssignIncomingLeads ?? true),
        maxActiveLeads,
        geoWeight,
      },
    };
  }

  const leadCity = normalizeStr(lead.city);
  const leadState = normalizeStr(lead.state);
  const leadPinFull = (lead.pinCode ?? '').replace(/\D/g, '').slice(0, 6);
  const leadPinPrefix = leadPinFull.slice(0, 3);
  const leadAddressLower = normalizeStr(lead.address);
  const leadBranchId = lead.branchId ? Number(lead.branchId) : null;
  const leadHubCoords = resolveHubCoords(lead.city, leadPinFull);

  // Compute fairness bonus ranking by oldest lastAssignedAt (null = never assigned -> highest fairness)
  const orderedByAge = [...officers].sort((a, b) => {
    if (!a.lastAssignedAt && !b.lastAssignedAt) return a.id - b.id;
    if (!a.lastAssignedAt) return -1;
    if (!b.lastAssignedAt) return 1;
    return a.lastAssignedAt.localeCompare(b.lastAssignedAt);
  });
  const fairnessRankMap = new Map<number, number>();
  orderedByAge.forEach((o, idx) => {
    const denom = Math.max(1, orderedByAge.length - 1);
    const bonus = orderedByAge.length === 1 ? 0 : Math.round(((orderedByAge.length - 1 - idx) / denom) * 6 * 10) / 10;
    fairnessRankMap.set(o.id, bonus);
  });

  const candidates: LoadBalanceCandidate[] = officers.map((officer) => {
    const officerCity = normalizeStr(officer.serviceCity || officer.branchCity);
    const officerState = normalizeStr(officer.branchState);
    const tokens = parseTerritoryTokens(officer.servicePincodes);
    const cityDefaultPrefixes = officerCity ? CITY_POSTAL_ZONES[officerCity] || [] : [];

    let rawGeoScore = 0;
    let geoTier: LoadBalanceCandidate['geoTier'] = 'general';
    const geoMatchReasons: string[] = [];
    let hasPositiveGeoMatch = false;

    // 1. Exact 6-digit PIN code match
    if (leadPinFull.length === 6 && tokens.includes(leadPinFull)) {
      rawGeoScore += 55;
      geoTier = 'exact_pincode';
      hasPositiveGeoMatch = true;
      geoMatchReasons.push(`Exact PIN Match (${leadPinFull})`);
    } else if (leadPinPrefix.length === 3 && tokens.includes(leadPinPrefix)) {
      // 2. 3-digit Postal Zone match from officer's territory config
      rawGeoScore += 42;
      geoTier = 'pincode_prefix';
      hasPositiveGeoMatch = true;
      geoMatchReasons.push(`Postal Zone Match (${leadPinPrefix}xxx)`);
    } else if (leadPinPrefix.length === 3 && cityDefaultPrefixes.includes(leadPinPrefix)) {
      rawGeoScore += 36;
      geoTier = 'pincode_prefix';
      hasPositiveGeoMatch = true;
      geoMatchReasons.push(`City Postal Zone (${leadPinPrefix}xxx)`);
    }

    // 3. Locality / Area keyword match inside customer address or city
    const matchedLocality = tokens.find(
      (tok) =>
        !/^\d+$/.test(tok) &&
        tok.length >= 3 &&
        tok !== officerCity &&
        (leadAddressLower.includes(tok) || leadCity.includes(tok))
    );
    if (matchedLocality) {
      rawGeoScore += 40;
      if (geoTier === 'general' || geoTier === 'pincode_prefix') {
        geoTier = 'locality';
      }
      hasPositiveGeoMatch = true;
      geoMatchReasons.push(
        `Area Match (${matchedLocality.replace(/\b\w/g, (c) => c.toUpperCase())})`
      );
    }

    // 4. City / Service City match
    const cityMatches =
      Boolean(leadCity && officerCity) &&
      (leadCity === officerCity || leadCity.includes(officerCity) || officerCity.includes(leadCity));
    if (cityMatches) {
      rawGeoScore += 32;
      if (geoTier === 'general') geoTier = 'city_branch';
      hasPositiveGeoMatch = true;
      geoMatchReasons.push(`Service City (${officer.serviceCity || officer.branchCity})`);
    }

    // 5. Branch match
    if (leadBranchId && officer.branchId === leadBranchId) {
      rawGeoScore += 18;
      if (geoTier === 'general') geoTier = 'city_branch';
      hasPositiveGeoMatch = true;
      geoMatchReasons.push(`Same Branch (${officer.branchName})`);
    }

    // 6. State match
    if (leadState && officerState && (leadState === officerState || leadState.includes(officerState))) {
      rawGeoScore += 10;
      if (geoTier === 'general') geoTier = 'state';
      geoMatchReasons.push(`Same State (${officer.branchState})`);
    }

    // 7. Recent GPS location proximity bonus (< 45 km of lead city hub)
    if (leadHubCoords && officer.lastGpsLat != null && officer.lastGpsLng != null) {
      const distKm = Math.round(haversineKm(officer.lastGpsLat, officer.lastGpsLng, leadHubCoords.lat, leadHubCoords.lng));
      if (distKm <= 45) {
        rawGeoScore += 12;
        hasPositiveGeoMatch = true;
        geoMatchReasons.push(`Live GPS Nearby (${distKm} km)`);
      }
    }

    // 8. Cross-region mismatch check: if lead explicitly has a city or PIN belonging to a DIFFERENT territory
    const leadHasExplicitGeo = Boolean(leadCity || leadPinPrefix.length === 3);
    if (leadHasExplicitGeo && !hasPositiveGeoMatch && officerCity) {
      rawGeoScore -= 42;
      geoTier = 'cross_region';
      geoMatchReasons.push(`Outside Territory (${officer.serviceCity || officer.branchCity})`);
    } else if (geoMatchReasons.length === 0) {
      geoMatchReasons.push(`Pool Coverage (${officer.serviceCity || officer.branchCity || 'All Areas'})`);
    }

    // Workload penalty calculation
    const overloadPenalty = officer.activeLeadCount >= maxActiveLeads ? 65 : 0;
    const rawWorkloadPenalty =
      officer.activeLeadCount * 6 +
      officer.urgentPendingCount * 2.5 +
      officer.assignedTodayCount * 3 +
      overloadPenalty;

    const weightedGeoScore = Math.round(rawGeoScore * geoScale * 10) / 10;
    const weightedWorkloadPenalty = Math.round(rawWorkloadPenalty * workScale * 10) / 10;
    const fairnessBonus = fairnessRankMap.get(officer.id) ?? 0;
    const compositeScore = Math.round((weightedGeoScore - weightedWorkloadPenalty + fairnessBonus) * 10) / 10;

    return {
      officer,
      compositeScore,
      geoScore: weightedGeoScore,
      workloadPenalty: weightedWorkloadPenalty,
      fairnessBonus,
      geoTier,
      geoMatchReasons,
      recommended: false,
    };
  });

  candidates.sort((a, b) => {
    if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
    if (a.officer.activeLeadCount !== b.officer.activeLeadCount) {
      return a.officer.activeLeadCount - b.officer.activeLeadCount;
    }
    const aTime = a.officer.lastAssignedAt || '';
    const bTime = b.officer.lastAssignedAt || '';
    if (aTime !== bTime) return aTime.localeCompare(bTime);
    return a.officer.employeeCode.localeCompare(b.officer.employeeCode);
  });

  if (candidates.length > 0) {
    candidates[0]!.recommended = true;
  }

  return {
    best: candidates[0] ?? null,
    candidates,
    settingsUsed: {
      autoAssignIncomingLeads: Boolean(settings.autoAssignIncomingLeads ?? true),
      maxActiveLeads,
      geoWeight,
    },
  };
}
