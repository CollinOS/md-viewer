import { defineConfig } from "vite";

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebView2 is evergreen Chromium, so no down-leveling is needed.
    target: "esnext",
    modulePreload: { polyfill: false },
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
