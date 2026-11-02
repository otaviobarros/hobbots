import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { hubProxy } from "./hub-proxy.ts";

export default defineConfig({
  // Root-relative asset paths: the server serves index.html for nested client paths too, where
  // relative paths would resolve below them. Every client, Electron included, loads the build from
  // the server (ADR 012).
  base: "/",
  plugins: [react(), tailwindcss()],
  // The dev server forwards what the hub answers to the hub on loopback (see hub-proxy.ts).
  server: {
    // 127.0.0.1, not `localhost`: the hub links its pages, and GitHub sends the user back, at
    // 127.0.0.1 (ADR 022), while macOS resolves `localhost` to ::1, where IPv4 never reaches.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: hubProxy(process.env.HOBBOTS_PORT ?? 4317),
  },
});
