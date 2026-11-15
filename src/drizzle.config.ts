import './config/loadDotenv.js';
import { defineConfig } from 'drizzle-kit';
import { EnvValidationError, loadEnv } from './config/env.js';

function loadEnvOrExit() {
  try {
    return loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(`[drizzle-kit] startup failed:\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

const env = loadEnvOrExit();

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema',
  out: './db/migrations',
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
