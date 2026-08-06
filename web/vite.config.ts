import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Builds to ../web-dist, which rc.ts serves as static files.
 *
 * Everything is inlined into as few files as possible and referenced relatively:
 * the bundle is served from a plain node http server with no base path, over a
 * WireGuard link, by a phone that may be on a flaky connection. Fewer requests
 * is worth more here than optimal caching granularity.
 */
export default defineConfig({
  plugins: [react()],
  // Absolute under /rc/, not './'. The page is served at BOTH /rc and /rc/, and
  // a relative asset path resolves differently for each — the trailing slash
  // would silently 404 every asset.
  base: '/rc/',
  build: {
    // Inside dist/, so `npm run install:local` — which copies dist/. — deploys
    // the UI along with everything else. A sibling directory would be silently
    // left behind and the phone would keep getting the old inline page.
    outDir: '../dist/web',
    emptyOutDir: true,
    assetsInlineLimit: 100_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
});
