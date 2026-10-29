import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Root-relative asset paths: the server serves index.html for nested client paths too, where
  // relative paths would resolve below them. Every client, Electron included, loads the build from
  // the server (ADR 012).
  base: "/",
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
});
