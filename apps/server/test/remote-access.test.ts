import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { DeviceService } from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import { type RemoteAccessStatus, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { HubHosts } from "@hobbots/permissions";
import { DeviceRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Layer, ManagedRuntime, Option, PubSub, Ref, Result, Scope } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DeviceGate,
  DeviceSecretsLive,
  knownWindowKey,
  PairingLimiterLive,
  type TailnetPeer,
  TailnetPeers,
} from "../src/devices.ts";
import { EventBus } from "../src/event-bus.ts";
import { claimHubPresence, readHubPresence } from "../src/hub-presence.ts";
import { HubListenersLive } from "../src/listeners.ts";
import { readNetworkSettings } from "../src/network-settings.ts";
import {
  HubHostsLive,
  KnownTailnetPeersOnly,
  NoFunnelRequests,
  RemoteAccess,
  RemoteAccessLive,
  RemoteAccessStateLive,
  updateFromRequest,
} from "../src/remote-access.ts";
import { DEFAULT_FAKE_TAILNET, type FakeTailnet, Tailscale, TailscaleFake } from "../src/tailscale.ts";
import { OwnHostsOnly } from "../src/web.ts";
import { AS_WINDOW, TEST_WINDOW_KEY } from "./window-device.ts";

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
  readonly location?: string;
  readonly cookies?: ReadonlyArray<string>;
  readonly connection?: string;
}

/** A request to `host` from the loopback address `from`, so a test can play a tailnet peer. */
const ask = (
  host: string,
  port: number,
  options: {
    readonly from?: string;
    readonly hostHeader?: string;
    readonly path?: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
) =>
  new Promise<Answer>((done, fail) => {
    const sent = request(
      {
        host,
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/peer",
        agent: false,
        ...(options.from ? { localAddress: options.from } : {}),
        headers: { ...options.headers, host: options.hostHeader ?? `${host}:${port}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            body,
            ...(response.headers.location === undefined ? {} : { location: response.headers.location }),
            ...(response.headers["set-cookie"] === undefined ? {} : { cookies: response.headers["set-cookie"] }),
            // Only a request that asked to keep its connection learns whether the hub closes it.
            ...(options.headers?.connection === "keep-alive" && response.headers.connection !== undefined
              ? { connection: response.headers.connection }
              : {}),
          }),
        );
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
  readonly servePort: number;
  readonly tailnet: Ref.Ref<FakeTailnet>;
  readonly dataDir: string;
  readonly events: Array<RemoteAccessStatus>;
  readonly check: () => Promise<RemoteAccessStatus>;
  readonly update: (change: {
    enabled?: boolean;
    paused?: boolean;
    port?: number;
    https?: boolean;
  }) => Promise<RemoteAccessStatus>;
  readonly serve: (forward: boolean) => Promise<RemoteAccessStatus>;
  /** Approves a device as if the user allowed it from `place`, and answers its token. */
  readonly approve: (peer: TailnetPeer) => Promise<string>;
  readonly status: () => Promise<RemoteAccessStatus>;
  readonly hosts: () => Promise<ReadonlyArray<string>>;
}

/** The user, deciding from the hub's window, as the hub's device middleware provides. */
const YOU = UserSession.of({
  deviceId: WINDOW_DEVICE_ID,
  name: "This computer's Hobbots window",
  kind: "window",
  whileApproved: (write) => write,
});

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  servedTakes = 0;
});

/** How long the fake `tailscale serve status` takes to answer, in milliseconds. */
let servedTakes = 0;

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
    readonly paused?: boolean;
    readonly tailnet?: FakeTailnet;
    readonly ranges?: ReadonlyArray<string>;
    readonly https?: boolean;
  } = {},
): Promise<Hub> => {
  const port = await freePort();
  const servePort = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "hobbots-remote-"));
  const tailnet = Ref.makeUnsafe(options.tailnet ?? DEFAULT_FAKE_TAILNET);
  const server: Server = createServer();
  const Remote = HubHostsLive.pipe(
    Layer.provideMerge(
      RemoteAccessStateLive({
        enabled: options.enabled ?? true,
        paused: options.paused ?? false,
        port,
        https: options.https ?? false,
        servePort,
      }),
    ),
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
  // Answers which device sent the request, as the hub's device check sees it (ADR 021).
  const DeviceRoute = HttpRouter.add(
    "GET",
    "/device",
    Effect.gen(function* () {
      const gate = yield* DeviceGate;
      const admitted = yield* Effect.result(gate.admit(yield* HttpServerRequest.HttpServerRequest));
      return Result.match(admitted, {
        onSuccess: (device) => HttpServerResponse.text(device.id),
        onFailure: (error) => HttpServerResponse.text(error._tag, { status: 401 }),
      });
    }),
  );
  // A page the hub serves, as the web client's files are.
  const PageRoute = HttpRouter.add("GET", "/page", Effect.succeed(HttpServerResponse.text("page")));
  // Turns HTTPS off as Settings' change does, from the request under way.
  const HttpsOffRoute = HttpRouter.add(
    "POST",
    "/https-off",
    Effect.flatMap(RemoteAccess, (access) => updateFromRequest(access, { https: false })).pipe(
      Effect.map((status) => HttpServerResponse.text(JSON.stringify(status.https))),
    ),
  );
  const Routes = Layer.mergeAll(
    PeerRoute,
    HoldRoute,
    DeviceRoute,
    PageRoute,
    HttpsOffRoute,
    OwnHostsOnly,
    KnownTailnetPeersOnly,
    NoFunnelRequests,
  );
  const hub = HttpRouter.serve(Routes, {
    disableLogger: true,
  }).pipe(
    // Above remote access, as on the hub, so the device check knows which requests came in on the tailnet.
    Layer.provideMerge(
      DeviceGate.layer.pipe(
        Layer.provideMerge(DeviceService.layer),
        Layer.provideMerge(knownWindowKey(TEST_WINDOW_KEY)),
        Layer.provideMerge(DeviceSecretsLive),
        Layer.provideMerge(PairingLimiterLive),
        Layer.provideMerge(DeviceRepositoryLive),
        Layer.provideMerge(TestDatabase),
      ),
    ),
    Layer.provideMerge(RemoteAccessLive(dataDir).pipe(Layer.provideMerge(HubListenersLive(server, port)))),
    Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port })),
    Layer.provideMerge(
      Layer.mergeAll(
        EventBus.layer,
        Remote,
        // `tailscale serve status` answers after `servedTakes`, as a slow Tailscale may.
        Layer.effect(
          Tailscale,
          Effect.map(Effect.service(Tailscale), (tailscale) => ({
            ...tailscale,
            served: Effect.suspend(() => Effect.andThen(Effect.sleep(servedTakes), tailscale.served)),
          })),
        ).pipe(Layer.provide(TailscaleFake(tailnet, options.ranges ?? DEFAULT_FAKE_TAILNET.ranges))),
      ),
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
    servePort,
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
    serve: (forward) => access((a) => a.serve(forward)),
    approve: (peer) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const devices = yield* DeviceService;
          const place = { _tag: "Tailnet", peer } as const;
          const opened = yield* devices.openPairing(
            { name: "Safari on iPhone", platform: "iOS", kind: "browser" },
            { place, hub: Option.some(peer), secret: Option.none() },
          );
          yield* devices.allow(opened.status.id).pipe(Effect.provideService(UserSession, YOU));
          const claimed = yield* devices.pairingStatus(opened.secret, place);
          return claimed.token ?? "";
        }),
      ),
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
  it("[TC-DP-095] Pause closes the tailnet listener and its connections, keeps loopback, survives a restart, and Resume restores it", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    const open = connect(hub.port(), "127.0.0.2");
    await new Promise((done) => open.once("connect", done));
    const closed = new Promise((done) => open.once("close", done));

    const paused = await hub.update({ paused: true });
    expect(paused).toMatchObject({ enabled: true, paused: true, listening: [], problem: "paused" });
    // Paused, the hub still says what Tailscale gives it, so Resume knows where it would listen.
    expect(paused.tailscale?.state).toBe("running");
    await closed;
    expect(await refusal("127.0.0.2", hub.port(), "127.0.0.1")).toBe("ECONNREFUSED");
    expect(await ask("127.0.0.1", hub.port())).toEqual({ status: 200, body: "local" });
    await vi.waitFor(() => expect(hub.events.at(-1)).toMatchObject({ paused: true, problem: "paused" }));
    expect(readNetworkSettings(hub.dataDir)).toEqual({ remoteAccessPaused: true });
    // The 10 second check keeps it paused.
    expect(await hub.check()).toMatchObject({ paused: true, listening: [] });

    expect(await hub.update({ paused: false })).toMatchObject({
      paused: false,
      listening: ["127.0.0.2"],
      problem: null,
    });
    expect(readNetworkSettings(hub.dataDir)).toEqual({ remoteAccessPaused: false });
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1" })).toEqual({ status: 200, body: "nFAKEHUB" });
  });

  // covers DP-004
  it("[TC-DP-096] a hub that starts paused stays off the tailnet until Resume, and turning remote access on resumes it", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub({ paused: true });
    expect(await hub.status()).toMatchObject({ enabled: true, paused: true, listening: [], problem: "paused" });
    expect(await refusal("127.0.0.2", hub.port(), "127.0.0.1")).toBe("ECONNREFUSED");

    // Turning it off and on again in Settings is a choice to be reachable, so it resumes too.
    expect(await hub.update({ enabled: false })).toMatchObject({ paused: true, problem: "off" });
    expect(await hub.update({ enabled: true })).toMatchObject({ paused: false, listening: ["127.0.0.2"] });
    expect(readNetworkSettings(hub.dataDir)).toEqual({ remoteAccess: true, remoteAccessPaused: false });
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

    // The hub's record of itself follows the move, so the command-line tools find it there (#999).
    await Effect.runPromise(claimHubPresence(hub.dataDir, before));
    const moved = await hub.update({ port: next });
    expect(moved).toMatchObject({ port: next, listening: ["127.0.0.2"], problem: null });
    expect(readHubPresence(hub.dataDir)).toEqual({ pid: process.pid, port: next });
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
  it("[TC-DP-086] the device check sees tailnet requests as the tailnet's, so the window key works only on loopback", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub();
    const asWindow = { path: "/device", headers: AS_WINDOW };
    expect(await ask("127.0.0.1", hub.port(), asWindow)).toEqual({ status: 200, body: WINDOW_DEVICE_ID });
    expect(await ask("127.0.0.2", hub.port(), { ...asWindow, from: "127.0.0.1" })).toEqual({
      status: 401,
      body: "DeviceRequired",
    });
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1", path: "/device" })).toEqual({
      status: 401,
      body: "DeviceRequired",
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

/** A phone on the tailnet, at 127.0.0.5 on the fake tailnet, owned by the same user as the hub. */
const PHONE: TailnetPeer = {
  nodeId: "nPHONE",
  nodeName: "phone.example.ts.net",
  owner: { _tag: "User", login: "you@example.com" },
};
const WITH_PHONE: FakeTailnet = {
  ...DEFAULT_FAKE_TAILNET,
  peers: { ...DEFAULT_FAKE_TAILNET.peers, "127.0.0.5": PHONE },
};

/** A request through `tailscale serve`: to the serve listener, for the MagicDNS name, from the peer `from`. */
const viaServe = (
  hub: Hub,
  options: {
    readonly from?: string;
    readonly path?: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
) =>
  ask("127.0.0.1", hub.servePort, {
    hostHeader: "hub.example.ts.net",
    path: options.path ?? "/peer",
    ...(options.method === undefined ? {} : { method: options.method }),
    headers: {
      ...(options.from === undefined ? {} : { "x-forwarded-for": options.from }),
      ...options.headers,
    },
  });

describe("HTTPS through tailscale serve", () => {
  // covers DP-004
  it("[TC-DP-130] opens the serve listener on loopback only while HTTPS and remote access are on and not paused", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub({ tailnet: WITH_PHONE });
    expect((await hub.status()).https).toMatchObject({ enabled: false, listening: false, port: hub.servePort });
    expect(await refusal("127.0.0.1", hub.servePort)).toBe("ECONNREFUSED");

    const on = await hub.update({ https: true });
    expect(on.https).toMatchObject({ enabled: true, listening: true, detail: null });
    expect(readNetworkSettings(hub.dataDir)).toEqual({ https: true, servePort: hub.servePort });
    expect(await viaServe(hub, { from: "127.0.0.5" })).toEqual({ status: 200, body: "nPHONE" });
    // Only on loopback, never on the tailnet address.
    expect(await refusal("127.0.0.2", hub.servePort, "127.0.0.1")).toBe("ECONNREFUSED");
    // The hub's own port cannot take the serve listener's.
    await expect(hub.update({ port: hub.servePort })).rejects.toMatchObject({ _tag: "PortUnavailable" });

    // Pause remote access closes it with its connections; Resume opens it again.
    const open = connect(hub.servePort, "127.0.0.1");
    await new Promise((done) => open.once("connect", done));
    const closed = new Promise((done) => open.once("close", done));
    expect((await hub.update({ paused: true })).https).toMatchObject({ enabled: true, listening: false });
    await closed;
    expect(await refusal("127.0.0.1", hub.servePort)).toBe("ECONNREFUSED");
    expect((await hub.update({ paused: false })).https.listening).toBe(true);

    // Remote access off closes it too, and HTTPS off keeps it closed once remote access is back.
    expect((await hub.update({ enabled: false })).https.listening).toBe(false);
    expect(await refusal("127.0.0.1", hub.servePort)).toBe("ECONNREFUSED");
    await hub.update({ https: false });
    expect((await hub.update({ enabled: true })).https).toMatchObject({ enabled: false, listening: false });
    expect(await refusal("127.0.0.1", hub.servePort)).toBe("ECONNREFUSED");
  });

  // covers DP-004
  it("[TC-DP-131] reads the forwarded identity only on the serve listener: one address, named by whois", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub({ tailnet: WITH_PHONE, https: true });
    expect(await viaServe(hub, { from: "127.0.0.5" })).toEqual({ status: 200, body: "nPHONE" });
    expect(await viaServe(hub, { from: "127.0.0.5", headers: { "tailscale-user-login": "you@example.com" } })).toEqual({
      status: 200,
      body: "nPHONE",
    });

    const unknown = { status: 403, body: "Tailscale does not know this device." };
    // Without X-Forwarded-For, with two addresses (Node joins repeated headers so), with something
    // else, or a peer whois does not know.
    expect(await viaServe(hub)).toEqual(unknown);
    expect(await viaServe(hub, { from: "127.0.0.5, 127.0.0.1" })).toEqual(unknown);
    expect(await viaServe(hub, { from: "phone" })).toEqual(unknown);
    expect(await viaServe(hub, { from: "127.0.0.9" })).toEqual(unknown);
    // A login that is not the node owner's.
    expect(
      await viaServe(hub, { from: "127.0.0.5", headers: { "tailscale-user-login": "someone@example.com" } }),
    ).toEqual(unknown);

    // A request through serve is never local: the window key is refused there.
    expect(await viaServe(hub, { from: "127.0.0.5", path: "/device", headers: AS_WINDOW })).toEqual({
      status: 401,
      body: "DeviceRequired",
    });

    // Elsewhere the headers count for nothing: loopback stays local, the tailnet listener names its own peer.
    const forged = { "x-forwarded-for": "127.0.0.5", "tailscale-user-login": "you@example.com" };
    expect(await ask("127.0.0.1", hub.port(), { headers: forged })).toEqual({ status: 200, body: "local" });
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1", headers: forged })).toEqual({
      status: 200,
      body: "nFAKEHUB",
    });
  });

  // covers DP-004
  it("[TC-DP-132] refuses a request that came through Tailscale Funnel, on every listener", async ({ skip }) => {
    if (!spareLoopback) skip();
    const hub = await startHub({ tailnet: WITH_PHONE, https: true });
    const funnel = { "tailscale-funnel-request": "?1" };
    const refused = { status: 403, body: "Hobbots is never served on the public internet." };
    expect(await viaServe(hub, { from: "127.0.0.5", headers: funnel })).toEqual(refused);
    expect(await ask("127.0.0.1", hub.port(), { headers: funnel })).toEqual(refused);
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1", headers: funnel })).toEqual(refused);
  });

  // covers DP-004
  it("[TC-DP-133] a device approved over HTTP keeps working over HTTPS and moves to the secure cookie", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub({ tailnet: WITH_PHONE, https: true });
    const token = await hub.approve(PHONE);
    expect(token).toMatch(/^hbd_/);

    // Over HTTPS with only the cookie it got over HTTP: admitted, and handed the secure cookie at once.
    const moved = await viaServe(hub, {
      from: "127.0.0.5",
      path: "/device",
      headers: { cookie: `hobbots_device=${token}` },
    });
    expect(moved.status).toBe(200);
    const secure = moved.cookies?.find((cookie) => cookie.startsWith("__Host-hobbots_device="));
    expect(secure).toBeDefined();
    expect(secure).toContain("Secure");
    expect(secure).toContain("HttpOnly");
    expect(secure).toContain("SameSite=Strict");
    expect(secure).toContain("Path=/");
    expect(secure).not.toContain("Domain");

    // With the secure cookie it is admitted without being set again.
    const after = await viaServe(hub, {
      from: "127.0.0.5",
      path: "/device",
      headers: { cookie: `__Host-hobbots_device=${token}; hobbots_device=${token}` },
    });
    expect(after.status).toBe(200);
    expect(after.cookies).toBeUndefined();

    // Bound to its node: from another peer through serve it is refused.
    expect(
      await viaServe(hub, {
        from: "127.0.0.1",
        path: "/device",
        headers: { cookie: `__Host-hobbots_device=${token}` },
      }),
    ).toEqual({ status: 401, body: "DeviceRequired" });
  });

  // covers DP-004
  it("[TC-DP-134] runs tailscale serve after consent, and then sends page loads on HTTP to the HTTPS address", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub({ tailnet: WITH_PHONE, https: true });
    expect((await hub.status()).https.forwarding).toBe(false);
    const page = { from: "127.0.0.1", path: "/page?x=1" } as const;
    // Not served yet: the HTTP address keeps serving pages.
    expect(await ask("127.0.0.2", hub.port(), page)).toEqual({ status: 200, body: "page" });

    const served = await hub.serve(true);
    expect(served.https).toMatchObject({ enabled: true, listening: true, forwarding: true });
    expect((await Effect.runPromise(Ref.get(hub.tailnet))).serve).toBe(`http://127.0.0.1:${hub.servePort}`);

    // Page loads on the tailnet's HTTP address go to the HTTPS one; the API and local pages stay.
    expect(await ask("127.0.0.2", hub.port(), page)).toMatchObject({
      status: 307,
      location: "https://hub.example.ts.net/page?x=1",
    });
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.1", path: "/api/agents" })).not.toMatchObject({
      status: 307,
    });
    expect(await ask("127.0.0.1", hub.port(), { path: "/page" })).toEqual({ status: 200, body: "page" });
    expect(await viaServe(hub, { from: "127.0.0.5", path: "/page" })).toEqual({ status: 200, body: "page" });

    // HTTPS off: no redirect, and Settings hears that serve still forwards until it is removed.
    const off = await hub.update({ https: false });
    expect(off.https).toMatchObject({ enabled: false, listening: false, forwarding: true });
    expect(await ask("127.0.0.2", hub.port(), page)).toEqual({ status: 200, body: "page" });
    expect((await hub.serve(false)).https.forwarding).toBe(false);
    expect((await Effect.runPromise(Ref.get(hub.tailnet))).serve).toBeUndefined();
  });

  // covers DP-004
  it("[TC-DP-135] says what Tailscale answered when tailscale serve refuses, and when remote access is off", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const refuses = "Serve is not enabled on your tailnet.";
    const hub = await startHub({ tailnet: { ...WITH_PHONE, serveRefuses: refuses }, https: true });
    await expect(hub.serve(true)).rejects.toMatchObject({ _tag: "ServeFailed", detail: refuses });
    expect((await hub.status()).https.forwarding).toBe(false);

    // Remote access off: serve that still forwards is reported when Settings asks.
    await Effect.runPromise(Ref.set(hub.tailnet, { ...WITH_PHONE, serve: `http://127.0.0.1:${hub.servePort}` }));
    await hub.update({ enabled: false });
    expect((await hub.status()).https).toMatchObject({ listening: false, forwarding: true });
  });

  // covers DP-004
  it("[TC-DP-143] turning HTTPS off through tailscale serve answers that request, then closes the serve listener", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub({ tailnet: WITH_PHONE, https: true });
    // Another request through serve still under way, as the page's event stream is.
    held = latch();
    holding = 0;
    const underWay = viaServe(hub, { from: "127.0.0.5", path: "/hold" }).then(
      () => "answered",
      (error: NodeJS.ErrnoException) => error.code ?? "error",
    );
    await vi.waitFor(() => expect(holding).toBe(1));

    // The change itself is answered with the new status, on a connection that then closes.
    const off = await viaServe(hub, {
      from: "127.0.0.5",
      path: "/https-off",
      method: "POST",
      headers: { connection: "keep-alive" },
    });
    expect(off.status).toBe(200);
    expect(off.connection).toBe("close");
    expect(JSON.parse(off.body)).toMatchObject({ enabled: false, listening: false });
    // Everything else on the serve listener closed, and it takes no new connection.
    expect(await underWay).toBe("ECONNRESET");
    held.resolve();
    expect(await refusal("127.0.0.1", hub.servePort)).toBe("ECONNREFUSED");
    // The tailnet's HTTP address, where the page goes next, keeps working.
    expect(await ask("127.0.0.2", hub.port(), { from: "127.0.0.5" })).toEqual({ status: 200, body: "nPHONE" });
  });

  it("[TC-DP-144] turning HTTPS off through tailscale serve is answered however long Tailscale takes to say what it serves", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await startHub({ tailnet: WITH_PHONE, https: true });
    // Longer than the few seconds a kept connection is given once the change is done.
    servedTakes = 6000;
    const off = await viaServe(hub, {
      from: "127.0.0.5",
      path: "/https-off",
      method: "POST",
      headers: { connection: "keep-alive" },
    });
    expect(off.status).toBe(200);
    expect(off.connection).toBe("close");
    expect(JSON.parse(off.body)).toMatchObject({ enabled: false, listening: false });
    expect(await refusal("127.0.0.1", hub.servePort)).toBe("ECONNREFUSED");
  }, 20_000);
});
