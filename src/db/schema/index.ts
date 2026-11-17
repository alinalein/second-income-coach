/**
 * Drizzle schema entry point: one file per domain, re-exported here for
 * `src/db/client.ts` and `src/drizzle.config.ts` to import (Code Map:
 * "Schema layout"). Splitting the single `src/db/schema.ts` placeholder from
 * Story 1.1 into this folder is a pure reorganization — it must not change
 * the SQL `db:generate` produces (verified: identical migration before/after
 * the split).
 */
export * from './users.js';
export * from './userSettings.js';
export * from './intake.js';
export * from './ideas.js';
export * from './plans.js';
export * from './usageLimits.js';
