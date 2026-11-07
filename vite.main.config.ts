import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    rollupOptions: {
      external: ['node-pty', 'electron-store'],
      // Vite 8 (Rolldown) omits "use strict" from CJS output by default; Vite 5
      // emitted it, so keep the main process in strict mode as before.
      output: { strict: true },
    },
  },
});
