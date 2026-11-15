import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';

// Vite 8 + @vitejs/plugin-react v6, React Compiler enabled via the
// `reactCompilerPreset` babel preset. The babel plugin is listed BEFORE
// react() so the compiler runs ahead of react()'s own transform, per the
// pinned stack decision (stack.md / ARCHITECTURE-SPINE.md).
export default defineConfig({
  plugins: [babel({ presets: [reactCompilerPreset()] }), react(), tailwindcss()],
  server: {
    proxy: {
      // Same-origin in production (served from the same Express service);
      // this proxy is the local-dev stand-in so the browser only ever talks
      // to one origin (AD-30).
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
