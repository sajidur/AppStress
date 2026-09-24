import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev:web` serves the UI on :5173 and proxies the API to the server on :4100.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:4100', changeOrigin: false } },
  },
});
