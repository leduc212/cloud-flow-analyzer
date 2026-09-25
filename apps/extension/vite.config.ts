import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Plain multi-entry build: the service worker and each extension page are separate entries.
// Files in public/ (manifest, icons) are copied as they are. The content script can't load
// shared chunks, so it has its own single-file build (vite.content.config.ts).
export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    modulePreload: false,
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    rollupOptions: {
      input: {
        background: resolve(import.meta.dirname, 'src/background.ts'),
        capture: resolve(import.meta.dirname, 'capture.html'),
        popup: resolve(import.meta.dirname, 'popup.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
