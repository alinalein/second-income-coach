import { z } from 'zod';

/**
 * Story 1.1 placeholder schema.
 *
 * This is the one shared Zod schema location importable by both the Express
 * backend (`src/`) and the React frontend (`web/`) via the `@app/shared`
 * package — proving the workspace wiring end to end. It is intentionally
 * domain-free: no idea/plan/check-in/settings shapes belong here yet (those
 * land with the stories that introduce them). The backend's health route and
 * the frontend's status indicator both import and validate against this same
 * schema, with its TypeScript type derived via `z.infer` — never hand-written.
 */
export const healthStatusSchema = z.object({
  status: z.enum(['ok', 'error']),
  service: z.string().min(1),
  timestamp: z.iso.datetime(),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
