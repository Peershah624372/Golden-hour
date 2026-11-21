import type { Ambulance, Hospital, HospitalUnit, Incident } from '@gh/shared';
import type { ambulances, hospitalUnits, hospitals, incidents } from '../db/schema';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toIncident(r: typeof incidents.$inferSelect): Incident {
  return {
    id: r.id,
    refCode: r.refCode,
    status: r.status,
    priority: r.priority,
    prioritySource: r.prioritySource,
    priorityLocked: r.priorityLocked,
    priorityReasons: r.priorityReasons,
    aiSuggestion: r.aiSuggestion ?? null,
    type: r.type,
    lat: r.lat,
    lng: r.lng,
    accuracyM: r.accuracyM,
    locationIsApprox: r.locationIsApprox,
    channel: r.channel,
    patientsCount: r.patientsCount,
    symptomFlags: r.symptomFlags,
    description: r.description,
    summary: r.summary,
    reportCount: r.reportCount,
    mergedInto: r.mergedInto,
    createdAt: r.createdAt.toISOString(),
    triagedAt: iso(r.triagedAt),
    dispatchedAt: iso(r.dispatchedAt),
    onSceneAt: iso(r.onSceneAt),
    closedAt: iso(r.closedAt),
  };
}

export function toAmbulance(r: typeof ambulances.$inferSelect): Ambulance {
  return {
    id: r.id,
    callSign: r.callSign,
    type: r.type,
    status: r.status,
    lat: r.lat,
    lng: r.lng,
    lastSeen: r.lastSeen.toISOString(),
    baseStationId: r.baseStationId,
    currentIncidentId: r.currentIncidentId,
  };
}

export function toHospital(h: typeof hospitals.$inferSelect, units: (typeof hospitalUnits.$inferSelect)[]): Hospital {
  return {
    id: h.id,
    name: h.name,
    lat: h.lat,
    lng: h.lng,
    level: h.level,
    units: units.filter((u) => u.hospitalId === h.id).map(toHospitalUnit),
  };
}

export function toHospitalUnit(u: typeof hospitalUnits.$inferSelect): HospitalUnit {
  return {
    hospitalId: u.hospitalId,
    unitType: u.unitType,
    bedsFree: u.bedsFree,
    status: u.status,
    updatedAt: u.updatedAt.toISOString(),
  };
}
