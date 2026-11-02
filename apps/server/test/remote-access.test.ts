import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import type { RemoteAccessStatus } from "@hobbots/domain";
import { HubHosts } from "@hobbots/permissions";
import { Effect, Layer, ManagedRuntime, Option, PubSub, Ref, Scope } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TailnetPeers } from "../src/devices.ts";
import { EventBus } from "../src/event-bus.ts";
import { HubListenersLive } from "../src/listeners.ts";
import { readNetworkSettings } from "../src/network-settings.ts";
import {
  HubHostsLive,
  KnownTailnetPeersOnly,
  RemoteAccess,
  RemoteAccessLive,
  RemoteAccessStateLive,
  TailnetClosedUntilPairing,
} from "../src/remote-access.ts";
import { DEFAULT_FAKE_TAILNET, type FakeTailnet, TailscaleFake } from "../src/tailscale.ts";
import { OwnHostsOnly } from "../src/web.ts";

// The fake tailnet serves on 127.0.0.2, so these need a host that routes all of 127.0.0.0/8 to
// loopback, as Linux does. macOS has only 127.0.0.1 unless an alias is added, and skips them.
let spareLoopback = false;
beforeAll(async () => {
  spareLoopback = await new Promise<boolean>((done) => {
    const probe = createNetServer();
    probe.once("error", () => done(false));
    probe.listen({ host: "127.0.0.2", port: 0 }, () => probe.close(() => done(true)));
  });
});

const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createNetServer().once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("No port"))));
    });
  });

interface Answer {
  readonly status: number;
  readonly body: string;
}

/** A request to `host` from the loopback address `from`, so a test can play a tailnet peer. */
const ask = (
  host: string,
  port: number,
  options: { readonly from?: string; readonly hostHeader?: string; readonly path?: string } = {},
) =>
  new Promise<Answer>((done, fail) => {
    const sent = request(
      {
        host,
        port,
        path: options.path ?? "/peer",
        agent: false,
        ...(options.from ? { localAddress: options.from } : {}),
        headers: { host: options.hostHeader ?? `${host}:${port}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => done({ status: response.statusCode ?? 0, body }));
      },
    );
    sent.once("error", fail);
    sent.end();
  });

/** The error a connection fails with, or null when the server answers it. */
const refusal = (host: string, port: number, from?: string) =>
  ask(host, port, from ? { from } : {}).then(
    () => null,
    (error: NodeJS.ErrnoException) => error.code ?? "error",
  );

interface Hub {
  readonly port: () => number;
  readonly tailnet: Ref.Ref<FakeTailnet>;
  readonly dataDir: string;
  readonly events: Array<RemoteAccessStatus>;
  readonly check: () => Promise<RemoteAccessStatus>;
  readonly update: (change: { enabled?: boolean; port?: number }) => Promise<RemoteAccessStatus>;
  readonly status: () => Promise<RemoteAccessStatus>;
  readonly hosts: () => Promise<ReadonlyArray<string>>;
}

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

/** Holds every `/hold` request until a test releases it. */
const latch = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let held = latch();
let holding = 0;

/**
 * A hub with the real listeners, checks and remote access over a fake Tailscale, serving one route
 * that answers who sent the request.
 */
const startHub = async (
  options: {
    readonly enabled?: boolean;
    readonly tailnet?: FakeTailnet;
    readonly ranges?: ReadonlyArray<string>;
    /** Whether tailnet requests are refused until devices can pair, as the hub does today. */
    readonly untilPairing?: boolean;
  } = {},
): Promise<Hub> => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "hobbots-remote-"));
  const tailnet = Ref.makeUnsafe(options.tailnet ?? DEFAULT_FAKE_TAILNET);
  const server: Server = createServer();
  const Remote = HubHostsLive.pipe(
    Layer.provideMerge(RemoteAccessStateLive({ enabled: options.enabled ?? true, port })),
  );
  const PeerRoute = HttpRouter.add(
    "GET",
    "/peer",
    Effect.gen(function* () {
      const peers = yield* TailnetPeers;
      const peer = yield* peers.peerOf(yield* HttpServerRequest.HttpServerRequest);
      return HttpServerResponse.text(Option.match(peer, { onNone: () => "local", onSome: (p) => p.nodeId }));
    }),
  );
  // Answers once the test lets it, as a request still under way, such as the event stream, would.
  const HoldRoute = HttpRouter.add(
    "GET",
    "/hold",
    Effect.sync(() => (holding += 1)).pipe(
      Effect.andThen(Effect.promise(() => held.promise)),
      Effect.as(HttpServerResponse.text("held")),
    ),
  );
  const Checks = Layer.mergeAll(OwnHostsOnly, KnownTailnetPeersOnly);
  const Routes = Layer.mergeAll(
    PeerRoute,
    HoldRoute,
    options.untilPairing ? Layer.merge(Checks, TailnetClosedUntilPairing) : Checks,
  );
  const hub = HttpRouter.serve(Routes, {
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(RemoteAccessLive(dataDir).pipe(Layer.provideMerge(HubListenersLive(server, port)))),
    Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port })),
    Layer.provideMerge(
      Layer.mergeAll(EventBus.layer, Remote, TailscaleFake(tailnet, options.ranges ?? DEFAULT_FAKE_TAILNET.ranges)),
    ),
  );
  const runtime = ManagedRuntime.make(hub);
  const events: Array<RemoteAccessStatus> = [];
  // Subscribed before the hub's first check is awaited, so no event is missed.
  await runtime.runPromise(
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const scope = yield* Scope.make();
      const subscription = yield* bus.subscribe.pipe(Scope.provide(scope));
      yield* PubSub.take(subscription).pipe(
        Effect.tap((event) =>
          Effect.sync(() => {
            if (event._tag === "Transient" && event.event._tag === "RemoteAccessChanged") {
              events.push(event.event.status);
            }
          }),
        ),
        Effect.forever,
        Effect.forkDetach,
      );
    }),
  );
  const access = <A, E>(use: (access: RemoteAccess["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(RemoteAccess, use));
  stop = async () => {
    server.closeAllConnections();
    await runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  };
  let current = port;
  const hubState: Hub = {
    port: () => current,
    tailnet,
    dataDir,
    events,
    check: () => access((a) => a.check),
    update: (change) =>
      access((a) => a.update(change)).then((status) => {
        current = status.port;
        return status;
      }),
    status: () => access((a) => a.status),
    hosts: () => runtime.runPromise(Effect.flatMap(HubHosts, (hosts) => hosts.current)),
  };
  // The first check runs while the hub starts; wait for it to settle.
  await hubState.check();
  return hubState;
};

describe("remote access over a fake Tailscale", () => {
  // covers DP-004
  it("[TC-DP-060] listens on loopback and the hub's tailnet address only, and serves tailnet peers", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    const status = await hub.status();
    expect(status).toMatchObject({ enabled: true, listening: ["127.0.0.2"], problem: null });
    expect(status.tailscale).toEqual({ state: "running", dnsName: "hub.example.ts.net", addresses: ["127.0.0.2"] });

    // A local request, and a tailnet one from the peer Tailscale names.
    expect(await ask("127.0.0.1", hub.port())).toEqual({ status: 200, body: "local" });
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).toEqual({ status: 200, body: "nFAKEHUB" });
    // Never another address, even another loopback one.
    expect(await refusal("127.0.0.3", hub.port())).toBe("ECONNREFUSED");
  });

  // covers DP-004
  it("[TC-DP-061] closes a connection from outside the tailnet's addresses at once", async ({ skip }) => {
    if (!spareLoopback) skip();
    // Only 127.0.0.1 and 127.0.0.2 count as tailnet addresses here, as 100.64.0.0/10 does on a real tailnet.
    const hub = await startHub({ ranges: ["127.0.0.1", "127.0.0.2"] });
    expect(await refusal("127.0.0.2", hub.port(), "127.0.0.3")).toBe("ECONNRESET");
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).toEqual({ status: 200, body: "nFAKEHUB" });
  });

  // covers DP-004
  it("[TC-DP-062] answers 403 to a peer Tailscale does not know, before any route runs", async ({ skip }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.3" })).toEqual({
      status: 403,
      body: "Tailscale does not know this device.",
    });
  });

  // covers DP-004
  it("[TC-DP-063] stops listening on the tailnet and closes its connections when Tailscale stops, and says why", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    const open = connect(hub.port(), "127.0.0.2");
    await new Promise((done) => open.once("connect", done));
    const closed = new Promise((done) => open.once("close", done));

    await Effect.runPromise(Ref.update(hub.tailnet, (fake) => ({ ...fake, state: "notRunning" as const })));
    const status = await hub.check();
    expect(status).toMatchObject({ enabled: true, listening: [], problem: "tailscale" });
    expect(status.tailscale?.state).toBe("notRunning");
    await closed;
    expect(await refusal("127.0.0.2", hub.port(), "127.0.0.1")).toBe("ECONNREFUSED");
    // Loopback keeps working, and every client heard why.
    expect(await ask("127.0.0.1", hub.port())).toEqual({ status: 200, body: "local" });
    await vi.waitFor(() => expect(hub.events.at(-1)).toMatchObject({ listening: [], problem: "tailscale" }));

    // Back on, it listens again.
    await Effect.runPromise(Ref.set(hub.tailnet, DEFAULT_FAKE_TAILNET));
    expect(await hub.check()).toMatchObject({ listening: ["127.0.0.2"], problem: null });
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).toEqual({ status: 200, body: "nFAKEHUB" });
  });

  // covers DP-004
  it("[TC-DP-064] is off by default; turning it on listens, turning it off stops listening and is kept", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub({ enabled: false });
    // Off, it still says what Tailscale would give it, so Settings can show it.
    expect(await hub.status()).toMatchObject({ enabled: false, listening: [], problem: "off" });
    expect((await hub.status()).tailscale?.state).toBe("running");
    expect(await refusal("127.0.0.2", hub.port(), "127.0.0.1")).toBe("ECONNREFUSED");

    expect(await hub.update({ enabled: true })).toMatchObject({ enabled: true, listening: ["127.0.0.2"] });
    expect(readNetworkSettings(hub.dataDir)).toEqual({ remoteAccess: true });
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).toMatchObject({ status: 200 });

    expect(await hub.update({ enabled: false })).toMatchObject({ enabled: false, listening: [], problem: "off" });
    expect(readNetworkSettings(hub.dataDir)).toEqual({ remoteAccess: false });
    expect(await refusal("127.0.0.2", hub.port(), "127.0.0.1")).toBe("ECONNREFUSED");
  });

  // covers DP-004
  it("[TC-DP-065] says why it is not on the tailnet: signed out, no address, or a port it cannot open", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    const set = (fake: Partial<FakeTailnet>) =>
      Effect.runPromise(Ref.set(hub.tailnet, { ...DEFAULT_FAKE_TAILNET, ...fake }));

    await set({ state: "signedOut" });
    expect(await hub.check()).toMatchObject({ problem: "tailscale", tailscale: { state: "signedOut" } });
    await set({ state: "notInstalled" });
    expect(await hub.check()).toMatchObject({ problem: "tailscale", tailscale: { state: "notInstalled" } });
    await set({ addresses: [] });
    expect(await hub.check()).toMatchObject({ problem: "noAddress", listening: [] });

    // Another program holds the port on the tailnet address.
    const squatter: NetServer = createNetServer();
    await new Promise<void>((done) => squatter.listen({ host: "127.0.0.4", port: hub.port() }, done));
    try {
      await set({ addresses: ["127.0.0.4"] });
      const status = await hub.check();
      expect(status).toMatchObject({ problem: "cannotListen", listening: [] });
      expect(status.detail).toBe(`127.0.0.4:${hub.port()}: another program is using the port`);
    } finally {
      await new Promise((done) => squatter.close(done));
    }
  });

  // covers DP-004
  it("[TC-DP-066] moves loopback and the tailnet to a changed port, tells every client, and keeps it", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    const before = hub.port();
    const next = await freePort();

    // A tailnet request still under way, as the event stream or the change itself is, stays and is
    // answered, so its client hears where the hub went. Node closes idle connections.
    held = latch();
    holding = 0;
    const underWay = ask("127.0.0.2", before, { from: "127.0.0.1", path: "/hold" });
    await vi.waitFor(() => expect(holding).toBe(1));

    const moved = await hub.update({ port: next });
    expect(moved).toMatchObject({ port: next, listening: ["127.0.0.2"], problem: null });
    await vi.waitFor(() => expect(hub.events.at(-1)?.port).toBe(next));
    expect(readNetworkSettings(hub.dataDir)).toEqual({ port: next });
    expect(await ask("127.0.0.1", next)).toEqual({ status: 200, body: "local" });
    expect(await ask("127.0.0.2", next, { from: "127.0.0.1" })).toEqual({ status: 200, body: "nFAKEHUB" });
    expect(await refusal("127.0.0.1", before)).toBe("ECONNREFUSED");
    expect(await refusal("127.0.0.2", before, "127.0.0.1")).toBe("ECONNREFUSED");
    held.resolve();
    expect(await underWay).toEqual({ status: 200, body: "held" });
  });

  // covers DP-004
  it("[TC-DP-073] refuses every tailnet request until devices can pair, and still serves loopback", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub({ untilPairing: true });
    expect(await ask("127.0.0.1", hub.port())).toEqual({ status: 200, body: "local" });
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).toEqual({
      status: 403,
      body: "This device is not paired with Hobbots yet.",
    });
  });

  // covers DP-004
  it("[TC-DP-067] refuses a port another program holds and changes nothing", async ({ skip }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    const taken = createNetServer();
    const takenPort = await freePort();
    await new Promise<void>((done) => taken.listen({ host: "127.0.0.1", port: takenPort }, done));
    try {
      await expect(hub.update({ port: takenPort })).rejects.toMatchObject({
        _tag: "PortUnavailable",
        port: takenPort,
        detail: "another program is using the port",
      });
      expect((await hub.status()).port).toBe(hub.port());
      expect(readNetworkSettings(hub.dataDir)).toEqual({});
      expect(await ask("127.0.0.1", hub.port())).toEqual({ status: 200, body: "local" });
      expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).toMatchObject({ status: 200 });
    } finally {
      await new Promise((done) => taken.close(done));
    }
  });

  // covers DP-004
  it("[TC-DP-068] answers only on its own host names: loopback, its MagicDNS name and its tailnet addresses", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    const port = hub.port();
    const viaTailnet = (hostHeader: string) => ask("127.0.0.2", port, { from: "127.0.0.1", hostHeader });
    expect((await viaTailnet(`hub.example.ts.net:${port}`)).status).toBe(200);
    expect((await viaTailnet(`127.0.0.2:${port}`)).status).toBe(200);
    expect((await viaTailnet(`attacker.example:${port}`)).status).toBe(421);
    expect((await ask("127.0.0.1", port, { hostHeader: `attacker.example:${port}` })).status).toBe(421);
  });

  // covers DP-004
  it("[TC-DP-069] forgets who a peer is once Tailscale no longer lists it", async ({ skip }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    expect((await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).body).toBe("nFAKEHUB");

    // The node behind the address changes. Within the minute the hub keeps the answer it has...
    const other = {
      nodeId: "nOTHER",
      nodeName: "laptop.example.ts.net",
      owner: { _tag: "User", login: "you@example.com" },
    } as const;
    await Effect.runPromise(Ref.update(hub.tailnet, (fake) => ({ ...fake, peers: { "127.0.0.1": other } })));
    expect((await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).body).toBe("nFAKEHUB");

    // ...until a check no longer lists the peer.
    await Effect.runPromise(Ref.update(hub.tailnet, (fake) => ({ ...fake, peers: {} })));
    await hub.check();
    expect((await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).status).toBe(403);
    // A peer Tailscale lists again is asked about again at the next check, not a minute later.
    await Effect.runPromise(Ref.update(hub.tailnet, (fake) => ({ ...fake, peers: { "127.0.0.1": other } })));
    await hub.check();
    expect((await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).body).toBe("nOTHER");
  });

  // covers DP-004, PE-001
  it("[TC-DP-070] names the hub's tailnet addresses and MagicDNS name as hosts a hob never reaches", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    expect(await hub.hosts()).toEqual(["127.0.0.2", "hub.example.ts.net"]);
    // Without Tailscale the hub has no tailnet names, and nothing there to reach.
    await Effect.runPromise(Ref.update(hub.tailnet, (fake) => ({ ...fake, state: "notRunning" as const })));
    await hub.check();
    expect(await hub.hosts()).toEqual([]);
  });
});
