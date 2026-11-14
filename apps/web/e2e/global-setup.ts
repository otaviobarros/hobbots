import { resolve } from "node:path";
import { build } from "vite";

const server = resolve(import.meta.dirname, "../../server");

/**
 * Builds the server from source once per run, so every hub a test starts runs the current code
 * without transpiling it again (see `startHub` in hub.ts). This build alone has the hub's test
 * seams: `src/test-seams.ts`, which adds nothing, is replaced by `src/testing/people.ts`, so a test
 * can play several people (`HOBBOTS_TEST_PEOPLE=on`) and no other build carries them.
 */
export default async () => {
  await build({
    root: server,
    configFile: resolve(server, "vite.config.ts"),
    logLevel: "warn",
    resolve: { alias: [{ find: /^\.\/test-seams\.ts$/, replacement: resolve(server, "src/testing/people.ts") }] },
  });
};
