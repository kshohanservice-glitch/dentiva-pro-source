import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const DEV_BRIDGE_PORT = process.env.DENTIVA_DEV_BRIDGE_PORT ?? '4319';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The renderer is also opened through a proxied preview host during
    // development, so that hostname has to be accepted by Vite as well.
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
    // The browser preview talks to the locally running Dentiva core service.
    // Relative /api URLs keep the browser independent of sandbox networking details.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${DEV_BRIDGE_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
          if (id.includes('node_modules/lucide-react')) return 'icons';
          if (id.includes('node_modules/@fontsource')) return 'fonts';
          return undefined;
        },
      },
    },
  },
});
