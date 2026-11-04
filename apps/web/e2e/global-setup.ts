import { resolve } from "node:path";
import { build } from "vite";

const server = resolve(import.meta.dirname, "../../server");

/**
 * Builds the server from source once per run, so every hub a test starts runs the current code
 * without transpiling it again (see `startHub` in hub.ts).
 */
export default async () => {
  await build({ root: server, configFile: resolve(server, "vite.config.ts"), logLevel: "warn" });
};
