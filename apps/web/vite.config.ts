import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const API = process.env.VITE_DEV_API ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Level 3: after the first visit the whole app (and every first-aid guide, which is
    // bundled in the JS) is cached on the phone and opens with no connection.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'GoldenHour',
        short_name: 'GoldenHour',
        description: "Help that reaches you, even when the internet doesn't.",
        theme_color: '#146357',
        background_color: '#f2f7f6',
        display: 'standalone',
        start_url: '/sos',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            // Map tiles seen while online stay available offline.
            urlPattern: /^https:\/\/[abc]\.tile\.openstreetmap\.org\/.*/,
            handler: 'CacheFirst',
            options: { cacheName: 'osm-tiles', expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 3600 } },
          },
          {
            // Chromium Background Sync: a failed SOS POST is replayed by the service worker
            // even if the page is closed. Safe because the server is idempotent on clientId.
            urlPattern: /\/api\/sos$/,
            method: 'POST',
            handler: 'NetworkOnly',
            options: { backgroundSync: { name: 'gh-sos', options: { maxRetentionTime: 24 * 60 } } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true },
    },
  },
});
