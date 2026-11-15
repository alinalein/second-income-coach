import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import * as schema from './schema/index.js';

/**
 * Postgres access wired through Drizzle ORM (AD-30 / AD-3): every query goes
 * through Drizzle's query builder or tagged `sql` template, which are
 * parameterized by construction — no hand-built/concatenated SQL strings
 * anywhere in this codebase. Domain tables live under `./schema/` (Story 1.2
 * onward), imported here so `drizzle()` knows about them.
 */
export function createDb(env: Pick<Env, 'DATABASE_URL'>) {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  // An idle pooled client can emit a connection-level error (DB restart,
  // network blip) outside of any query; without a listener, Node treats that
  // as an unhandled 'error' event and crashes the whole process.
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error);
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

/**
 * Minimal connectivity check used by the `/api/health/db` route. Uses
 * Drizzle's parameterized `sql` helper (not a raw concatenated string).
 */
export async function checkDbConnection(db: ReturnType<typeof createDb>['db']): Promise<boolean> {
  const result = await db.execute(sql`select 1 as ok`);
  return result.rows.length > 0;
}
