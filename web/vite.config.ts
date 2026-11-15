import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';

// Vite 8 + @vitejs/plugin-react v6, React Compiler enabled via the
// `reactCompilerPreset` babel preset. The babel plugin is listed BEFORE
// react() so the compiler runs ahead of react()'s own transform, per the
// pinned stack decision (stack.md / ARCHITECTURE-SPINE.md).
//
// Dev server port and `/api` proxy target are read from env (`WEB_PORT` /
// `API_PROXY_TARGET`), defaulting to the original hardcoded values (`5173`
// / `http://localhost:3000`) when unset — so a parallel worktree can run its
// own frontend+backend pair on different ports without editing source
// (Design Notes: "Parallel-worktree dev ports"). Dev-only, code-defaulted —
// not part of src/config/env.ts's required startup validation.
//
// envDir can't be `process.cwd()`: `npm run dev --workspace=web` (how this
// is normally started) runs with cwd set to `web/`, not the repo root, so
// the root `.env` (where WEB_PORT/API_PROXY_TARGET actually live) would be
// silently missed. Walk up to the workspace root instead, same approach as
// src/config/loadDotenv.ts.
function findWorkspaceRoot(startDir: string): string {
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
    if (parent === dir) return startDir;
    dir = parent;
  }
}

export default defineConfig(({ mode }) => {
  const repoRoot = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
  const env = loadEnv(mode, repoRoot, '');
  const webPort = env.WEB_PORT ? Number(env.WEB_PORT) : 5173;
  const apiProxyTarget = env.API_PROXY_TARGET || 'http://localhost:3000';

  return {
    envDir: repoRoot,
    plugins: [babel({ presets: [reactCompilerPreset()] }), react(), tailwindcss()],
    server: {
      port: webPort,
      proxy: {
        // Same-origin in production (served from the same Express service);
        // this proxy is the local-dev stand-in so the browser only ever talks
        // to one origin (AD-30).
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
