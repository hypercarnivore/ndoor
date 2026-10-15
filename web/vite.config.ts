import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The UI is served by `ndoor ui` from dist/web. In development, `make dev`
// runs `ndoor ui --api-only` and this dev server proxies /api to it.
export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // The page sends its own x-ndoor-token header; the proxy only forwards it.
    proxy: { '/api': { target: 'http://127.0.0.1:4791', changeOrigin: true } },
  },
});
