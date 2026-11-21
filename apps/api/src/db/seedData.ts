import type { HospitalUnitStatus, HospitalUnitType, UnitType } from '@gh/shared';

/**
 * SIMULATED demo data around Sukkur, Pakistan. Hospital names are fictional;
 * no real hospital's capacity is represented.
 */
export const DEMO_CENTER = { lat: 27.7052, lng: 68.8574 };

export const STATIONS = [
  { id: 'st-city', name: 'City Station', lat: 27.7046, lng: 68.8541 },
  { id: 'st-rohri', name: 'Rohri Station', lat: 27.6946, lng: 68.8921 },
  { id: 'st-north', name: 'North Station', lat: 27.7262, lng: 68.8452 },
  { id: 'st-bypass', name: 'Bypass Station', lat: 27.6738, lng: 68.8392 },
];

export const AMBULANCES: { id: string; callSign: string; type: UnitType; station: string; dLat: number; dLng: number }[] = [
  { id: 'als-1', callSign: 'ALS-1', type: 'ALS', station: 'st-city', dLat: 0.0004, dLng: 0.0003 },
  { id: 'als-2', callSign: 'ALS-2', type: 'ALS', station: 'st-north', dLat: 0.0003, dLng: -0.0004 },
  { id: 'als-3', callSign: 'ALS-3', type: 'ALS', station: 'st-bypass', dLat: -0.0003, dLng: 0.0004 },
  { id: 'bls-1', callSign: 'BLS-1', type: 'BLS', station: 'st-city', dLat: -0.0004, dLng: -0.0003 },
  { id: 'bls-2', callSign: 'BLS-2', type: 'BLS', station: 'st-rohri', dLat: 0.0003, dLng: 0.0003 },
  { id: 'bls-3', callSign: 'BLS-3', type: 'BLS', station: 'st-north', dLat: -0.0004, dLng: 0.0004 },
  { id: 'bls-4', callSign: 'BLS-4', type: 'BLS', station: 'st-bypass', dLat: 0.0004, dLng: -0.0003 },
  { id: 'bls-5', callSign: 'BLS-5', type: 'BLS', station: 'st-rohri', dLat: -0.0003, dLng: -0.0004 },
];

type U = [HospitalUnitType, number, HospitalUnitStatus];

export const HOSPITALS: { id: string; name: string; lat: number; lng: number; level: number; units: U[] }[] = [
  {
    id: 'h-civic', name: 'Civic General Hospital', lat: 27.7018, lng: 68.8617, level: 2,
    // Nearest to the city centre, but trauma is DIVERTING in the demo, so the matcher skips it.
    units: [['TRAUMA', 0, 'DIVERTING'], ['ICU', 1, 'LIMITED'], ['MATERNITY', 2, 'ACCEPTING'], ['PAEDIATRIC', 3, 'ACCEPTING']],
  },
  {
    id: 'h-indus', name: 'Indus Trauma Centre', lat: 27.7163, lng: 68.8436, level: 1,
    units: [['TRAUMA', 2, 'ACCEPTING'], ['ICU', 1, 'ACCEPTING'], ['BURNS', 2, 'ACCEPTING'], ['CARDIAC', 1, 'LIMITED']],
  },
  {
    id: 'h-heart', name: 'Riverside Heart Institute', lat: 27.7295, lng: 68.8668, level: 1,
    units: [['CARDIAC', 2, 'ACCEPTING'], ['ICU', 2, 'ACCEPTING']],
  },
  {
    id: 'h-mother', name: 'Barrage Mother & Child Hospital', lat: 27.7198, lng: 68.8331, level: 2,
    units: [['MATERNITY', 3, 'ACCEPTING'], ['PAEDIATRIC', 4, 'ACCEPTING'], ['ICU', 1, 'ACCEPTING']],
  },
  {
    id: 'h-rohri', name: 'Rohri District Hospital', lat: 27.6893, lng: 68.8987, level: 3,
    units: [['TRAUMA', 3, 'ACCEPTING'], ['MATERNITY', 1, 'LIMITED'], ['PAEDIATRIC', 1, 'ACCEPTING']],
  },
  {
    id: 'h-bypass', name: 'Bypass Road Hospital', lat: 27.6688, lng: 68.8296, level: 3,
    units: [['TRAUMA', 1, 'LIMITED'], ['BURNS', 0, 'DIVERTING'], ['PAEDIATRIC', 2, 'ACCEPTING']],
  },
];

export const USERS = [
  { id: 'u-disp-1', name: 'Dispatcher Ayesha', role: 'dispatcher' as const },
  { id: 'u-lead-1', name: 'Shift Lead Bilal', role: 'shift_lead' as const },
  { id: 'u-admin-1', name: 'Regional Admin', role: 'admin' as const },
  { id: 'u-med-1', name: 'Medical Reviewer', role: 'medical_reviewer' as const },
];
