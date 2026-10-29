import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The hub serves the built files; in dev, Vite proxies the API to a running hub.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:7420', '/login': 'http://127.0.0.1:7420' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
