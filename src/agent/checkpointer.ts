import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Env } from '../config/env.js';

/**
 * Checkpointing (Intent): "`@langchain/langgraph-checkpoint-postgres`'s
 * `PostgresSaver` against the existing `DATABASE_URL`". Code Map: "pass the
 * same connection string into `PostgresSaver.fromConnString` rather than
 * opening a second pool" — `env.DATABASE_URL` is the one connection string
 * the whole app uses (see `src/db/client.ts`'s `createDb`); this doesn't
 * invent a second, checkpointer-specific one.
 *
 * `.setup()` is idempotent but must still be awaited once at process startup
 * (Intent: "`PostgresSaver.setup()` runs once, idempotently, at API
 * startup") — that happens in `src/api/index.ts`, not here, so this factory
 * stays a pure construction step that tests can call without touching the DB.
 */
export function createCheckpointer(env: Pick<Env, 'DATABASE_URL'>): PostgresSaver {
  return PostgresSaver.fromConnString(env.DATABASE_URL);
}
