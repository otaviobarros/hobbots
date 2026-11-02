import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Root-relative asset paths: the server serves index.html for nested client paths too, where
  // relative paths would resolve below them. Every client, Electron included, loads the build from
  // the server (ADR 012).
  base: "/",
  plugins: [react(), tailwindcss()],
  // The dev server forwards the API, the event stream included, to the hub on loopback without
  // changing the Host, so the client calls its own origin as the served build does (ADR 021).
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.HOBBOTS_PORT ?? 4317}`, changeOrigin: false },
    },
  },
});
