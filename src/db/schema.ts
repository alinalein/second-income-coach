/**
 * Drizzle schema entry point.
 *
 * Intentionally empty in Story 1.1: no domain Postgres tables/migrations
 * (ideas, plans, check-ins, settings) land here until the stories that need
 * them (per spec-1-1's "Never" boundary). This file exists so `drizzle-kit`
 * has a valid (if currently empty) schema module to point at from
 * `drizzle.config.ts`, proving the Drizzle/Postgres wiring without
 * introducing any domain state ahead of schedule.
 */
export {};
