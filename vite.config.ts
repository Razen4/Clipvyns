import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const isTauriBuild = Boolean(process.env.TAURI_ENV_PLATFORM)

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      disable: isTauriBuild,
      registerType: 'autoUpdate',
      includeAssets: ['icon.png'],
      manifest: {
        name: 'Clipvyn',
        short_name: 'Clipvyn',
        description: 'Your private clipboard, synced across devices.',
        theme_color: '#0b1020',
        background_color: '#070c1b',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
      },
    }),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_STORAGE_BUCKET',
    'VITE_FIREBASE_MESSAGING_SENDER_ID',
    'VITE_FIREBASE_APP_ID',
    'TAURI_ENV_',
  ],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'oxc',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
})
