import { defineConfig } from 'vite';
/**
 * `base` is the URL prefix the built page expects to be served from.
 *
 * GitHub Pages serves a project site at /<repo>/, so the Pages workflow sets
 * PAGES_BASE=/remoteviewtrainer/. Everything else — the dev server, the
 * published artifact build — is served from the root and leaves it alone.
 * Hard-coding the repo path here would break both of those.
 */
export default defineConfig({
  base: process.env.PAGES_BASE || '/',
  server: { host: '0.0.0.0', port: 5173, strictPort: false },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Stable names: the artifact republishes to the same paths, so a
        // content hash would leave an orphaned bundle behind every time.
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/app.[ext]',
      },
    },
  },
});
