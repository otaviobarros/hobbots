import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IPv6Loopback } from "../src/loopback.ts";
import { isLoopbackHost, LoopbackHostOnly, WebClientRoutes } from "../src/web.ts";

let webDir: string;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  webDir = mkdtempSync(join(tmpdir(), "hobbots-web-"));
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Hobbots</title>");
  writeFileSync(join(webDir, "assets", "app.js"), "console.log('hobs')");
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      HttpRouter.add("GET", "/api/health", HttpServerResponse.text("api")),
      WebClientRoutes(webDir),
      LoopbackHostOnly,
    ).pipe(Layer.provide(NodeHttpServer.layerHttpServices)),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});

afterAll(async () => {
  await dispose();
  rmSync(webDir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) =>
  handler(new Request(`http://localhost:4317${path}`, { headers: { host: "localhost:4317", ...headers } }));

describe("web client routes", () => {
  // covers DP-001
  it("[TC-DP-005] serves the web client's index and assets next to the API", async () => {
    const index = await get("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("<title>Hobbots</title>");

    const asset = await get("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    const api = await get("/api/health");
    expect(await api.text()).toBe("api");
  });

  // covers DP-001
  it("[TC-DP-006] falls back to index.html for client routes but not for missing files", async () => {
    const route = await get("/agents/aldric", { accept: "text/html" });
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("<title>Hobbots</title>");

    expect((await get("/assets/missing.js")).status).toBe(404);
    expect((await get("/../package.json")).status).toBe(404);
  });

  // covers DP-004
  it("[TC-DP-007] refuses requests addressed to a host name other than localhost", async () => {
    const response = await get("/", { host: "attacker.example:4317" });
    expect(response.status).toBe(421);
    expect((await get("/api/health", { host: "127.0.0.1:4317" })).status).toBe(200);
    expect((await get("/api/health", { host: "[::1]:4317" })).status).toBe(200);
  });
});

describe("isLoopbackHost", () => {
  it("accepts loopback names with or without a port and nothing else", () => {
    for (const host of ["localhost", "LOCALHOST:4317", "127.0.0.1:4317", "[::1]", "[::1]:4317"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of [undefined, "", "192.168.1.20:4317", "localhost.attacker.example", "[::2]:4317"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("IPv6Loopback", () => {
  // covers DP-004
  it("[TC-DP-008] answers on 127.0.0.1 and ::1 and on no other address", async () => {
    const server: Server = createServer((_, response) => response.end("hub"));
    await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const { port, address } = server.address() as AddressInfo;
    try {
      const body = await Effect.gen(function* () {
        const ipv4 = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()));
        const ipv6 = yield* Effect.promise(() => fetch(`http://[::1]:${port}/`).then((r) => r.text()));
        return [ipv4, ipv6];
      }).pipe(Effect.provide(IPv6Loopback(server, port)), Effect.scoped, Effect.runPromise);
      expect(body).toEqual(["hub", "hub"]);
      expect(address).toBe("127.0.0.1");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
