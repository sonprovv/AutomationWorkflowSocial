import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the local API (same-origin in production: the API serves dist/).
const apiPort = process.env.APP_PORT ?? process.env.API_PORT ?? '18966';
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
  build: { outDir: 'dist', emptyOutDir: true },
});
