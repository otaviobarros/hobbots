import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The dev server started from the real config, with a stand-in hub behind it that echoes what
 * reached it. A path the dev server keeps for itself answers with the client's index.html instead.
 */
describe("web dev server", () => {
  let hub: Server;
  let dev: ViteDevServer;
  let devUrl: string;

  beforeAll(async () => {
    hub = createHttpServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ hub: true, url: request.url, host: request.headers.host }));
    });
    await new Promise<void>((listening) => hub.listen(0, "127.0.0.1", listening));
    const previous = process.env.HOBBOTS_PORT;
    process.env.HOBBOTS_PORT = String((hub.address() as AddressInfo).port);
    try {
      dev = await createServer({
        configFile: fileURLToPath(new URL("vite.config.ts", import.meta.url)),
        logLevel: "silent",
        server: { port: 0, strictPort: false, hmr: false, ws: false },
      });
      await dev.listen();
    } finally {
      if (previous === undefined) delete process.env.HOBBOTS_PORT;
      else process.env.HOBBOTS_PORT = previous;
    }
    const address = dev.httpServer?.address() as AddressInfo | null | undefined;
    if (!address) throw new Error("The dev server is not listening.");
    devUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await dev?.close();
    await new Promise((closed) => hub?.close(closed));
  });

  const reach = async (path: string) => {
    const response = await fetch(`${devUrl}${path}`);
    expect(response.headers.get("content-type")).toContain("application/json");
    return (await response.json()) as { hub: boolean; url: string; host: string };
  };

  // covers DP-001, ADR 022
  it("[TC-GEN-122] listens on 127.0.0.1, where the hub's links to its own pages point", () => {
    // `localhost` would resolve to ::1 alone on macOS, and those links would reach nothing.
    expect(dev.config.server.host).toBe("127.0.0.1");
  });

  // covers DP-001, ADR 021
  it("[TC-GEN-119] forwards the API to the hub without changing the Host", async () => {
    expect(await reach("/api/health")).toEqual({ hub: true, url: "/api/health", host: new URL(devUrl).host });
  });

  // The hub links a hob's new GitHub app to these pages at the address it was reached at, which in
  // development is the dev server's: without forwarding them, the link opened the client instead.
  // covers DP-001, ADR 022
  it.each([
    { id: "TC-GEN-120", path: "/github/hob-app/new?state=s" },
    { id: "TC-GEN-121", path: "/github/hob-app/callback?state=s&code=c" },
  ])("[$id] forwards $path, a hub page for a hob's own GitHub app, to the hub", async ({ path }) => {
    expect(await reach(path)).toEqual({ hub: true, url: path, host: new URL(devUrl).host });
  });
});
