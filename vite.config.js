import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for WebXR on any origin other than localhost.
// `host: true` exposes the dev server on your LAN so the Quest can reach it.
export default defineConfig({
  plugins: [basicSsl()],
  // Relative paths, so the build works from a GitHub Pages project sub-folder.
  base: './',
  server: { host: true, port: 5180 },
  preview: { host: true, port: 5181 },
  build: {
    // The pages use top-level await.
    target: 'esnext',
    rollupOptions: {
      input: { index: 'index.html', viewfinder: 'viewfinder.html' },
    },
  },
});
