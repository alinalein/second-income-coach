import { Router } from 'express';
import { healthStatusSchema } from '@app/shared';
import { checkDbConnection } from '../../db/client.js';
import type { createDb } from '../../db/client.js';

export interface HealthRouterDeps {
  db: ReturnType<typeof createDb>['db'];
}

/**
 * `/api/health` — proves the Express backend is up and that the shared Zod
 * schema package is actually used (not just importable) by the backend.
 * `/api/health/db` — proves the Drizzle/Postgres wiring is live.
 */
export function createHealthRouter({ db }: HealthRouterDeps) {
  const router = Router();

  router.get('/', (_req, res) => {
    const payload = healthStatusSchema.parse({
      status: 'ok',
      service: 'api',
      timestamp: new Date().toISOString(),
    });
    res.json(payload);
  });

  router.get('/db', async (_req, res) => {
    try {
      await checkDbConnection(db);
      res.json(
        healthStatusSchema.parse({
          status: 'ok',
          service: 'db',
          timestamp: new Date().toISOString(),
        }),
      );
    } catch (error) {
      console.error('[health] db connectivity check failed:', error);
      res.status(503).json(
        healthStatusSchema.parse({
          status: 'error',
          service: 'db',
          timestamp: new Date().toISOString(),
        }),
      );
    }
  });

  return router;
}
