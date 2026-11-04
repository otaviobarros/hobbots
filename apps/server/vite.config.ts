import { resolve } from "node:path";
import { defineConfig } from "vite";

// Bundles the server and its workspace packages into one file that Node runs as it is, without
// transpiling TypeScript at every start. The browser tests start a hub from it for each test.
export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, "src/main.ts"),
    outDir: "dist",
    target: "node26",
    minify: false,
  },
  // Bundle every dependency, as the desktop app does, so the build runs from any folder.
  ssr: { noExternal: true },
});
