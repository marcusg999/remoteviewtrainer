import { defineConfig } from 'vite';
export default defineConfig({
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
