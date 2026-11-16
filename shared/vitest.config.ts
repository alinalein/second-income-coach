import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['schemas/**/*.test.ts', '*.test.ts'],
  },
});
