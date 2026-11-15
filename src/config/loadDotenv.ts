import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/**
 * Loads the repo-root `.env` regardless of the folder the process starts in.
 *
 * npm workspaces start the backend (and drizzle-kit) with `src/` as the working
 * directory, so `dotenv/config` alone never finds the root `.env`. Instead this
 * walks up from this file to the workspace root (the first `package.json` that
 * declares `workspaces`) and loads `<root>/.env`. It works the same from
 * `src/config` (tsx) and `src/dist/config` (compiled), and per git worktree.
 *
 * - Variables already set in the environment are never overridden, so values
 *   injected by the host (e.g. Secret Manager on Cloud Run) always win.
 * - A missing `.env` (or no workspace root, as in a production image) is a no-op.
 * - Skipped when NODE_ENV=test, so tests never read a developer's real secrets.
 */
function findWorkspaceRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
        if (pkg.workspaces) return dir;
      } catch {
        // unreadable/invalid package.json: keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadDotenv(): void {
  if (process.env.NODE_ENV === 'test') return;
  const root = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root) return;
  const envPath = join(root, '.env');
  if (existsSync(envPath)) config({ path: envPath, override: false, quiet: true });
}

// Side-effect on import, like `dotenv/config`: import this module first.
loadDotenv();
