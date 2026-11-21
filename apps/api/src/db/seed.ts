import { sql } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { db, closeDb, type DB } from './client';
import * as s from './schema';
import { AMBULANCES, HOSPITALS, STATIONS, USERS } from './seedData';

const ALL_TABLES = [
  'incidents', 'reports', 'patients', 'stations', 'ambulances', 'dispatches',
  'hospitals', 'hospital_units', 'handovers', 'messages', 'users', 'audit_log',
];

/** Wipes everything and loads the simulated demo world. */
export async function seed(d: DB = db): Promise<void> {
  await d.execute(sql.raw(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY`));

  await d.insert(s.stations).values(STATIONS);

  const station = Object.fromEntries(STATIONS.map((st) => [st.id, st]));
  await d.insert(s.ambulances).values(
    AMBULANCES.map((a) => ({
      id: a.id,
      callSign: a.callSign,
      type: a.type,
      status: 'AVAILABLE' as const,
      lat: station[a.station].lat + a.dLat,
      lng: station[a.station].lng + a.dLng,
      baseStationId: a.station,
      crewContact: `+92-300-000${a.id.slice(-1)}${a.type === 'ALS' ? '1' : '2'}`,
    })),
  );

  await d.insert(s.hospitals).values(
    HOSPITALS.map(({ units: _u, ...h }) => ({ ...h, dutyPhone: '+92-71-0000000' })),
  );
  await d.insert(s.hospitalUnits).values(
    HOSPITALS.flatMap((h) =>
      h.units.map(([unitType, bedsFree, status]) => ({ hospitalId: h.id, unitType, bedsFree, status, updatedBy: 'seed' })),
    ),
  );

  await d.insert(s.users).values([
    ...USERS,
    ...AMBULANCES.map((a) => ({ id: `u-crew-${a.id}`, name: `${a.callSign} crew`, role: 'crew' as const, ambulanceId: a.id })),
    ...HOSPITALS.map((h) => ({ id: `u-er-${h.id}`, name: `${h.name} ER`, role: 'er' as const, hospitalId: h.id })),
  ]);

  await d.insert(s.auditLog).values({ actor: 'system', action: 'seed', entity: 'system', entityId: 'demo', reason: 'Demo data loaded' });
}

export async function seedIfEmpty(d: DB = db): Promise<boolean> {
  const rows = await d.select({ id: s.hospitals.id }).from(s.hospitals).limit(1);
  if (rows.length) return false;
  await seed(d);
  return true;
}

// CLI: pnpm db:seed
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await seed();
  console.log('Seeded demo data: %d hospitals, %d ambulances', HOSPITALS.length, AMBULANCES.length);
  await closeDb();
}
