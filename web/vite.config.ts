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
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const webPort = env.WEB_PORT ? Number(env.WEB_PORT) : 5173;
  const apiProxyTarget = env.API_PROXY_TARGET || 'http://localhost:3000';

  return {
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
