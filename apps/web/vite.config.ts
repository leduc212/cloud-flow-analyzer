import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Static multi-page site for GitHub Pages (served from /cloud-flow-analyzer/, so paths are
// relative). Everything runs in the browser: no server, nothing uploaded.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        rules: resolve(import.meta.dirname, 'rules.html'),
        privacy: resolve(import.meta.dirname, 'privacy.html'),
      },
    },
  },
});
