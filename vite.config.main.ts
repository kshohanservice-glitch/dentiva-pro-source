import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const nodeExternals = [
  'electron',
  'better-sqlite3',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@main': fileURLToPath(new URL('./src/main', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/main',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: 'node22',
    ssr: 'src/main/index.ts',
    rollupOptions: {
      external: nodeExternals,
      output: {
        format: 'cjs',
        entryFileNames: 'index.cjs',
        chunkFileNames: 'chunks/[name]-[hash].cjs',
      },
    },
  },
});
