import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/api, whether running from src/db (tsx, tests) or from the compiled dist/ bundle.
const apiRoot = [path.resolve(here, '../..'), path.resolve(here, '..')].find((d) => existsSync(path.join(d, 'drizzle'))) ?? path.resolve(here, '../..');
const migrationsFolder = path.join(apiRoot, 'drizzle');

export type DB = NodePgDatabase<typeof schema>;

/**
 * DATABASE_URL set  -> real Postgres (Neon in the cloud).
 * DATABASE_URL unset -> embedded Postgres (PGlite) stored in apps/api/.pglite,
 * so the API runs with zero setup on any laptop.
 */
async function connect(): Promise<{ db: DB; kind: 'postgres' | 'pglite'; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
    return { db, kind: 'postgres', close: () => pool.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  // PGLITE_DIR=memory gives a throwaway in-memory database (automated tests).
  const dir = process.env.PGLITE_DIR;
  const client = dir === 'memory' ? new PGlite() : new PGlite(dir ? path.resolve(dir) : path.join(apiRoot, '.pglite'));
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as DB, kind: 'pglite', close: () => client.close() };
}

const conn = await connect();
export const db = conn.db;
export const dbKind = conn.kind;
export const closeDb = conn.close;
export { schema };
