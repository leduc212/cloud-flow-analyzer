import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The content script is injected with chrome.scripting.executeScript, which can't load ES
// module chunks, so it is built on its own as one self-contained file after the main build.
export default defineConfig(({ mode }) => ({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: mode === 'development' ? 'inline' : false,
    minify: mode !== 'development',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'cloudFlowAnalyzerContent',
      fileName: () => 'content.js',
    },
  },
}));
