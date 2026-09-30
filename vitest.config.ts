import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = {
  '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
  '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
  '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
  '@tests': fileURLToPath(new URL('./tests', import.meta.url)),
  '@main': fileURLToPath(new URL('./src/main', import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/core/**', 'src/shared/**'],
      reporter: ['text-summary', 'json-summary'],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['tests/ui/**/*.test.tsx'],
          setupFiles: ['tests/ui/setup.ts'],
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'stress',
          environment: 'node',
          include: ['tests/stress/**/*.test.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 900_000,
          hookTimeout: 900_000,
        },
      },
    ],
  },
});
