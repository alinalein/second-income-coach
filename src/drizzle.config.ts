import { defineConfig } from 'drizzle-kit';
import { loadEnv } from './config/env.js';

const env = loadEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/migrations',
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
