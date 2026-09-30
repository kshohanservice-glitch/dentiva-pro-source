import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/preload',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: 'node22',
    ssr: 'src/preload/index.ts',
    rollupOptions: {
      external: ['electron'],
      output: {
        format: 'cjs',
        entryFileNames: 'index.cjs',
      },
    },
  },
});
