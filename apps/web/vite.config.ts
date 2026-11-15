import { resolve } from "node:path";
import babel, { type RolldownBabelPreset } from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { appFrame } from "./app-frame-plugin.ts";
import { hubProxy } from "./hub-proxy.ts";

// The React Compiler's preset as plain data, so Babel can run it in worker threads: its own preset
// is a function, which cannot be sent to a worker. Its filters and hooks stay as they are.
const reactCompiler = reactCompilerPreset();
const compilerPreset: RolldownBabelPreset = {
  ...reactCompiler,
  preset: (reactCompiler.preset as () => RolldownBabelPreset["preset"])(),
};

export default defineConfig({
  // Root-relative asset paths: the server serves index.html for nested client paths too, where
  // relative paths would resolve below them. Every client, Electron included, loads the build from
  // the server (ADR 012).
  base: "/",
  // The React Compiler memoizes components and hooks, so the code has no useMemo, useCallback or
  // memo (STD-REACT-010).
  plugins: [
    react(),
    babel({
      presets: [compilerPreset],
      // Every module goes through the compiler, which is most of the time a first load takes in
      // development; workers share it across the computer's cores.
      parallel: true,
    }),
    tailwindcss(),
    appFrame(),
  ],
  // Two entries: the hub's pages, and setup's local pages that the desktop app serves from its own
  // resources before this computer is a hub or connected to one (ADR 025).
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        local: resolve(import.meta.dirname, "local.html"),
      },
    },
  },
  // The dev server forwards what the hub answers to the hub on loopback (see hub-proxy.ts).
  server: {
    // 127.0.0.1, not `localhost`: the hub links its pages, and GitHub sends the user back, at
    // 127.0.0.1 (ADR 022), while macOS resolves `localhost` to ::1, where IPv4 never reaches.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Transforms both entries and everything they import as soon as the dev server starts, while the
    // desktop app is still starting the hub. Without it the first window waits while every module
    // goes through Babel and the React Compiler on request, which takes many seconds.
    warmup: { clientFiles: ["./src/main.tsx", "./src/local.tsx"] },
    proxy: hubProxy(process.env.HOBBOTS_PORT ?? 4317),
  },
});
