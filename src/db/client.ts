import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';

/**
 * Postgres access wired through Drizzle ORM (AD-30 / AD-3): every query goes
 * through Drizzle's query builder or tagged `sql` template, which are
 * parameterized by construction — no hand-built/concatenated SQL strings
 * anywhere in this codebase. No domain tables/schema are defined yet (those
 * land with the stories that need them); this module only establishes the
 * connection and proves it works.
 */
export function createDb(env: Pick<Env, 'DATABASE_URL'>) {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool);
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
