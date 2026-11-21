// Core domain types shared by the API and the web app.

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABEL: Record<Priority, string> = {
  P1: 'Critical',
  P2: 'Serious',
  P3: 'Urgent',
  P4: 'Minor',
};

/** Demo-default dispatch targets in seconds (configurable per region later). */
export const PRIORITY_TARGET_S: Record<Priority, number> = {
  P1: 60,
  P2: 180,
  P3: 900,
  P4: 3600,
};

export type PrioritySource = 'rules' | 'ai' | 'dispatcher';

export const INCIDENT_TYPES = ['ACC', 'MED', 'CRD', 'BRT', 'BRN', 'MAT', 'OTH'] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_TYPE_LABEL: Record<IncidentType, string> = {
  ACC: 'Accident',
  MED: 'Medical',
  CRD: 'Chest pain',
  BRT: 'Breathing',
  BRN: 'Burn',
  MAT: 'Maternity',
  OTH: 'Other',
};

export const SYMPTOM_FLAGS = ['UNR', 'NBR', 'BLD', 'SEZ', 'CHP', 'BRD', 'BRN', 'FRC', 'HED', 'PRG'] as const;
export type SymptomFlag = (typeof SYMPTOM_FLAGS)[number];

export const SYMPTOM_LABEL: Record<SymptomFlag, string> = {
  UNR: 'Not responding',
  NBR: 'Not breathing',
  BLD: 'Heavy bleeding',
  SEZ: 'Seizure',
  CHP: 'Chest pain',
  BRD: 'Breathing difficulty',
  BRN: 'Burns',
  FRC: 'Fracture',
  HED: 'Head injury',
  PRG: 'Pregnancy complication',
};

export const INCIDENT_STATUSES = [
  'REPORTED',
  'TRIAGED',
  'DISPATCHED',
  'EN_ROUTE',
  'ON_SCENE',
  'TRANSPORTING',
  'AT_HOSPITAL',
  'HANDED_OVER',
  'CLOSED',
  'MERGED',
  'CANCELLED',
  'NO_TRANSPORT',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const CHANNELS = ['app', 'sms', 'voice', 'queued'] as const;
export type Channel = (typeof CHANNELS)[number];

export type UnitType = 'ALS' | 'BLS';

export const AMBULANCE_STATUSES = [
  'AVAILABLE',
  'ASSIGNED',
  'EN_ROUTE',
  'ON_SCENE',
  'TRANSPORTING',
  'AT_HOSPITAL',
  'RETURNING',
  'OUT_OF_SERVICE',
] as const;
export type AmbulanceStatus = (typeof AMBULANCE_STATUSES)[number];

export const HOSPITAL_UNIT_TYPES = ['TRAUMA', 'ICU', 'BURNS', 'MATERNITY', 'CARDIAC', 'PAEDIATRIC'] as const;
export type HospitalUnitType = (typeof HOSPITAL_UNIT_TYPES)[number];

export type HospitalUnitStatus = 'ACCEPTING' | 'LIMITED' | 'DIVERTING';

export type StartTag = 'RED' | 'YELLOW' | 'GREEN' | 'BLACK';

/** Answers to the three red-flag questions on the SOS screen. null = unknown / skipped. */
export interface RedFlagAnswers {
  breathing: boolean | null;
  responding: boolean | null;
  heavyBleeding: boolean | null;
}

export interface TriageResult {
  priority: Priority;
  source: PrioritySource;
  reasons: string[];
  /** True when a hard red flag forced the priority (AI may not lower it). */
  locked: boolean;
}

// ---- API DTOs ---------------------------------------------------------------

export interface Incident {
  id: string;
  refCode: string;
  status: IncidentStatus;
  priority: Priority;
  prioritySource: PrioritySource;
  priorityLocked: boolean;
  priorityReasons: string[];
  aiSuggestion: { priority: Priority; reasons: string[]; model: string } | null;
  type: IncidentType;
  lat: number;
  lng: number;
  accuracyM: number | null;
  locationIsApprox: boolean;
  channel: Channel;
  patientsCount: number;
  symptomFlags: SymptomFlag[];
  description: string | null;
  summary: string | null;
  reportCount: number;
  mergedInto: string | null;
  createdAt: string;
  triagedAt: string | null;
  dispatchedAt: string | null;
  onSceneAt: string | null;
  closedAt: string | null;
}

export interface Ambulance {
  id: string;
  callSign: string;
  type: UnitType;
  status: AmbulanceStatus;
  lat: number;
  lng: number;
  lastSeen: string;
  baseStationId: string;
  currentIncidentId: string | null;
}

export interface HospitalUnit {
  hospitalId: string;
  unitType: HospitalUnitType;
  bedsFree: number;
  status: HospitalUnitStatus;
  updatedAt: string;
}

export interface Hospital {
  id: string;
  name: string;
  lat: number;
  lng: number;
  level: number; // 1 = major trauma/specialist centre, 3 = basic
  units: HospitalUnit[];
}

export interface SosRequest {
  clientId: string; // client-generated id for idempotency (offline queue retries)
  type: IncidentType;
  patientsCount: number;
  answers: RedFlagAnswers;
  symptomFlags?: SymptomFlag[];
  description?: string;
  lat: number;
  lng: number;
  accuracyM?: number;
  channel?: Channel;
  createdAt?: string; // when the SOS was made on the phone (offline queue)
  lang?: string;
}

export interface SosResponse {
  incidentId: string;
  refCode: string;
  priority: Priority;
  status: IncidentStatus;
}

export type DispatchStatus = 'ASSIGNED' | 'EN_ROUTE' | 'ON_SCENE' | 'TRANSPORTING' | 'AT_HOSPITAL' | 'HANDED_OVER' | 'CLEARED' | 'CANCELLED';

export interface Dispatch {
  id: string;
  incidentId: string;
  ambulanceId: string;
  callSign: string;
  unitType: UnitType;
  status: DispatchStatus;
  accepted: boolean;
  etaMin: number | null;
  /** Live ETA target while moving (ISO). */
  etaAt: string | null;
  assignedAt: string;
  destinationHospitalId: string | null;
  route: [number, number][] | null;
  preemptedFrom: string | null;
}

export interface DispatchOption {
  ambulanceId: string;
  callSign: string;
  type: UnitType;
  status: AmbulanceStatus;
  etaMin: number;
  distanceKm: number;
  etaSource: 'osrm' | 'estimate';
  uncertain: boolean;
  reasons: string[];
  /** Set when this unit is currently assigned to a lower-priority incident (pre-emption candidate). */
  preemptFrom?: { incidentId: string; refCode: string; priority: Priority } | null;
}

export interface DispatchOptions {
  incidentId: string;
  priority: Priority;
  options: DispatchOption[];
  suggestion: { ambulanceIds: string[]; reason: string } | null;
  preemption: DispatchOption[];
  note: string | null;
}

/** Crew one-tap actions, in order. */
export const CREW_ACTIONS = ['ACCEPT', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING', 'AT_HOSPITAL', 'HANDED_OVER', 'AVAILABLE'] as const;
export type CrewAction = (typeof CREW_ACTIONS)[number] | 'NO_TRANSPORT' | 'OUT_OF_SERVICE';

// ---- Socket.IO events ---------------------------------------------------------

export const EVENTS = {
  incidentNew: 'incident:new',
  incidentUpdated: 'incident:updated',
  incidentMerged: 'incident:merged',
  dispatchAssigned: 'dispatch:assigned',
  dispatchStatus: 'dispatch:status',
  ambulanceLocation: 'ambulance:location',
  hospitalCapacity: 'hospital:capacity',
  handoverRequest: 'handover:request',
  handoverAck: 'handover:ack',
  alertEscalation: 'alert:escalation',
  mciActivated: 'mci:activated',
} as const;
