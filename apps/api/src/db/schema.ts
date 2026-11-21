import { boolean, doublePrecision, integer, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import type {
  AmbulanceStatus,
  Channel,
  DispatchStatus,
  HospitalUnitStatus,
  HospitalUnitType,
  IncidentStatus,
  IncidentType,
  Priority,
  PrioritySource,
  StartTag,
  SymptomFlag,
  UnitType,
} from '@gh/shared';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const incidents = pgTable('incidents', {
  id: text('id').primaryKey(),
  refCode: text('ref_code').notNull().unique(),
  clientId: text('client_id').unique(), // idempotency key from the phone (offline queue retries)
  status: text('status').$type<IncidentStatus>().notNull().default('REPORTED'),
  priority: text('priority').$type<Priority>().notNull(),
  prioritySource: text('priority_source').$type<PrioritySource>().notNull().default('rules'),
  priorityLocked: boolean('priority_locked').notNull().default(false),
  priorityReasons: jsonb('priority_reasons').$type<string[]>().notNull().default([]),
  aiSuggestion: jsonb('ai_suggestion').$type<{ priority: Priority; reasons: string[]; model: string } | null>(),
  type: text('type').$type<IncidentType>().notNull(),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  accuracyM: doublePrecision('accuracy_m'),
  locationIsApprox: boolean('location_is_approx').notNull().default(false),
  channel: text('channel').$type<Channel>().notNull(),
  patientsCount: integer('patients_count').notNull().default(1),
  symptomFlags: jsonb('symptom_flags').$type<SymptomFlag[]>().notNull().default([]),
  description: text('description'),
  summary: text('summary'),
  lang: text('lang'),
  reporterHash: text('reporter_hash'),
  mergedInto: text('merged_into'),
  reportCount: integer('report_count').notNull().default(1),
  createdAt: ts('created_at').notNull().defaultNow(),
  triagedAt: ts('triaged_at'),
  dispatchedAt: ts('dispatched_at'),
  onSceneAt: ts('on_scene_at'),
  transportingAt: ts('transporting_at'),
  atHospitalAt: ts('at_hospital_at'),
  handedOverAt: ts('handed_over_at'),
  closedAt: ts('closed_at'),
});

/** One incident can have many reports (duplicates merged by the Verification Agent). */
export const reports = pgTable('reports', {
  id: text('id').primaryKey(),
  incidentId: text('incident_id').notNull(),
  channel: text('channel').$type<Channel>().notNull(),
  rawText: text('raw_text'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  reporterHash: text('reporter_hash'),
  receivedAt: ts('received_at').notNull().defaultNow(),
});

export const patients = pgTable('patients', {
  id: text('id').primaryKey(),
  incidentId: text('incident_id').notNull(),
  label: text('label').notNull(), // "A", "B", ...
  startTag: text('start_tag').$type<StartTag>(),
  ageEst: integer('age_est'),
  sex: text('sex'),
  vitals: jsonb('vitals').$type<Record<string, string | number>>(),
  injuries: text('injuries'),
  treatment: text('treatment'),
  requiredUnit: text('required_unit').$type<HospitalUnitType>(),
});

export const stations = pgTable('stations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
});

export const ambulances = pgTable('ambulances', {
  id: text('id').primaryKey(),
  callSign: text('call_sign').notNull().unique(),
  type: text('type').$type<UnitType>().notNull(),
  status: text('status').$type<AmbulanceStatus>().notNull().default('AVAILABLE'),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  lastSeen: ts('last_seen').notNull().defaultNow(),
  baseStationId: text('base_station_id').notNull(),
  crewContact: text('crew_contact'),
  currentIncidentId: text('current_incident_id'),
});

export const dispatches = pgTable('dispatches', {
  id: text('id').primaryKey(),
  incidentId: text('incident_id').notNull(),
  ambulanceId: text('ambulance_id').notNull(),
  etaMin: doublePrecision('eta_min'),
  status: text('status').$type<DispatchStatus>().notNull().default('ASSIGNED'),
  assignedBy: text('assigned_by'),
  preemptedFrom: text('preempted_from'),
  destinationHospitalId: text('destination_hospital_id'),
  assignedAt: ts('assigned_at').notNull().defaultNow(),
  acceptedAt: ts('accepted_at'),
  enRouteAt: ts('en_route_at'),
  onSceneAt: ts('on_scene_at'),
  transportingAt: ts('transporting_at'),
  atHospitalAt: ts('at_hospital_at'),
  handedOverAt: ts('handed_over_at'),
  clearedAt: ts('cleared_at'),
});

export const hospitals = pgTable('hospitals', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  level: integer('level').notNull(), // 1 = major trauma / specialist centre
  dutyPhone: text('duty_phone'),
});

export const hospitalUnits = pgTable('hospital_units', {
  id: serial('id').primaryKey(),
  hospitalId: text('hospital_id').notNull(),
  unitType: text('unit_type').$type<HospitalUnitType>().notNull(),
  bedsFree: integer('beds_free').notNull().default(0),
  status: text('status').$type<HospitalUnitStatus>().notNull().default('ACCEPTING'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

export const handovers = pgTable('handovers', {
  id: text('id').primaryKey(),
  incidentId: text('incident_id').notNull(),
  dispatchId: text('dispatch_id'),
  patientId: text('patient_id'),
  hospitalId: text('hospital_id').notNull(),
  atmist: jsonb('atmist').$type<Record<string, string>>().notNull(),
  etaMin: doublePrecision('eta_min'),
  sentAt: ts('sent_at').notNull().defaultNow(),
  ackAt: ts('ack_at'),
  decision: text('decision').$type<'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TIMEOUT'>().notNull().default('PENDING'),
  declineReason: text('decline_reason'),
});

export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  incidentId: text('incident_id'),
  direction: text('direction').$type<'IN' | 'OUT'>().notNull(),
  channel: text('channel').notNull(), // sms / app / push
  recipientRole: text('recipient_role'),
  address: text('address'), // phone number (demo only; hashed in analytics)
  body: text('body').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  deliveredAt: ts('delivered_at'),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').$type<'dispatcher' | 'shift_lead' | 'crew' | 'er' | 'medical_reviewer' | 'admin'>().notNull(),
  ambulanceId: text('ambulance_id'),
  hospitalId: text('hospital_id'),
});

export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  at: ts('at').notNull().defaultNow(),
  actor: text('actor').notNull(), // user id, or "system" / agent name
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  reason: text('reason'),
  data: jsonb('data'),
});
