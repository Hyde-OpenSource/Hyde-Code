import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The hub serves the built files; in dev, Vite proxies the API to a running hub.
// `@/` and `react-i18next` point at the Munder Difflin port in src/md, so its files keep
// their original imports (see src/md/README.md).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./src/md/', import.meta.url)),
      'react-i18next': fileURLToPath(new URL('./src/md/i18n/shim.ts', import.meta.url)),
    },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:7420', '/login': 'http://127.0.0.1:7420' } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
