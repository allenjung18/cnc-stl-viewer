import { defineConfig } from 'vite';

// Local only: the dev server and preview bind to the loopback interface.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  // The STL parser runs in a module worker (src/io/load.ts).
  worker: { format: 'es' },
  // three.js alone is ~550 kB minified; the app is a single local bundle.
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 800 },
});
