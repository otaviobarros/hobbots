import { mkdtempSync, rmSync } from "node:fs";
import { type ClientRequest, createServer, type IncomingMessage, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  DeviceService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PermissionSummary,
} from "@hobbots/agents";
import { type Device, type RemoteAccessStatus, STREAM_FRAME } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  DeviceRepositoryLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Clock, type Duration, Effect, Layer, ManagedRuntime, Ref } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceGate, DeviceSecretsLive, knownWindowKey, PairingLimiterLive } from "../src/devices.ts";
import { EventBus } from "../src/event-bus.ts";
import { EventStream, EventStreamRoute } from "../src/event-stream.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { HubListenersLive } from "../src/listeners.ts";
import { readNetworkSettings } from "../src/network-settings.ts";
import {
  HubHostsLive,
  KnownTailnetPeersOnly,
  NoFunnelRequests,
  RemoteAccess,
  RemoteAccessLive,
  RemoteAccessStateLive,
} from "../src/remote-access.ts";
import { DEFAULT_FAKE_TAILNET, type FakeTailnet, TailscaleFake } from "../src/tailscale.ts";
import { HobToolsLive } from "../src/tools.ts";
import { OwnHostsOnly } from "../src/web.ts";
import { movableClock } from "./movable-clock.ts";
import { AS_WINDOW, TEST_WINDOW_KEY } from "./window-device.ts";

// Slice 13's done-when checks (ADR 021, the deployment contract's DP-004), end to end: the hub's
// own routes and event stream behind its device check, on its real loopback, tailnet and serve
// listeners, over a fake Tailscale that serves the tailnet on 127.0.0.2. Devices are plain HTTP
// clients that keep their cookies as a browser does. CI runs these on SQLite and on PostgreSQL.
// The browser side of interaction check 10 is in apps/web/e2e/remote-access-end-to-end.e2e.ts.

// The fake tailnet serves on 127.0.0.2 and its peers come from 127.0.0.5 and 127.0.0.6, so these
// need a host that routes all of 127.0.0.0/8 to loopback, as Linux does. macOS skips them.
let spareLoopback = false;
beforeAll(async () => {
  spareLoopback = await new Promise<boolean>((done) => {
    const probe = createNetServer();
    probe.once("error", () => done(false));
    probe.listen({ host: "127.0.0.2", port: 0 }, () => probe.close(() => done(true)));
  });
});

const TAILNET_ADDRESS = "127.0.0.2";
const MAGIC_DNS = "hub.example.ts.net";
const PHONE = "127.0.0.5";
const LAPTOP = "127.0.0.6";
const yours = (nodeId: string, nodeName: string) =>
  ({ nodeId, nodeName, owner: { _tag: "User", login: "you@example.com" } }) as const;

/** The hub and two more of the user's own devices on the tailnet. */
const TAILNET: FakeTailnet = {
  ...DEFAULT_FAKE_TAILNET,
  peers: {
    ...DEFAULT_FAKE_TAILNET.peers,
    [PHONE]: yours("nPHONE", "phone.example.ts.net"),
    [LAPTOP]: yours("nLAPTOP", "laptop.example.ts.net"),
  },
};

const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createNetServer().once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("No port"))));
    });
  });

/** Where a request goes: the connection's address and port, where it comes from, and its `Host`. */
interface Route {
  readonly host: string;
  readonly port: number;
  readonly from?: string;
  readonly hostHeader: string;
}

interface Answer {
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: the hub's JSON, read by each case.
  readonly body: any;
  readonly headers: IncomingMessage["headers"];
}

/** The hub's JSON answer, or its text when it answered something else, such as a refused peer. */
const parsed = (text: string): unknown => {
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    return text;
  }
};

const send = (
  route: Route,
  method: string,
  path: string,
  headers: Readonly<Record<string, string>>,
  body?: unknown,
): Promise<Answer> =>
  new Promise((done, fail) => {
    const sent = request(
      {
        host: route.host,
        port: route.port,
        method,
        path,
        agent: false,
        ...(route.from === undefined ? {} : { localAddress: route.from }),
        headers: {
          ...headers,
          host: route.hostHeader,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () =>
          done({ status: response.statusCode ?? 0, body: parsed(text), headers: response.headers }),
        );
      },
    );
    sent.once("error", fail);
    sent.end(body === undefined ? undefined : JSON.stringify(body));
  });

/** The error a connection to `route` fails with, or null when the hub answers it. */
const refusal = (route: Route) =>
  send(route, "GET", "/api/health", {}).then(
    () => null,
    (error: NodeJS.ErrnoException) => error.code ?? "error",
  );

/** One open event stream, as a client's `EventSource` holds it. */
interface Stream {
  readonly status: number;
  /** The `_tag` of each event's data, in order, journal entries and transient events alike. */
  readonly tags: () => ReadonlyArray<string>;
  /** Each `RemoteAccessChanged` event's status. */
  readonly remoteAccess: () => ReadonlyArray<RemoteAccessStatus>;
  readonly text: () => string;
  /** Whether the hub has ended the connection. */
  readonly ended: () => boolean;
  readonly close: () => void;
}

const openStreams = new Set<ClientRequest>();

const openStream = (route: Route, headers: Readonly<Record<string, string>>) =>
  new Promise<Stream>((done, fail) => {
    const sent = request(
      {
        host: route.host,
        port: route.port,
        path: "/api/events",
        agent: false,
        ...(route.from === undefined ? {} : { localAddress: route.from }),
        headers: { ...headers, host: route.hostHeader, accept: "text/event-stream" },
      },
      (response) => {
        let text = "";
        let ended = false;
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("close", () => {
          ended = true;
          openStreams.delete(sent);
        });
        // Each frame's name (`ready`, `remote-access`, …; a journal entry has none) and its data.
        const frames = () =>
          text
            .split("\n\n")
            .map((frame) => frame.split("\n"))
            .flatMap((lines) => {
              const data = lines.find((line) => line.startsWith("data: "));
              if (data === undefined) return [];
              const name = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
              return [{ name, data: JSON.parse(data.slice("data: ".length)) as Record<string, unknown> }];
            });
        done({
          status: response.statusCode ?? 0,
          tags: () =>
            frames().map(({ name, data }) => (name === STREAM_FRAME.ready ? "Ready" : String(data._tag ?? data.type))),
          remoteAccess: () =>
            frames()
              .filter(({ name }) => name === STREAM_FRAME.remoteAccess)
              .map(({ data }) => data.status as RemoteAccessStatus),
          text: () => text,
          ended: () => ended,
          close: () => sent.destroy(),
        });
      },
    );
    openStreams.add(sent);
    sent.once("error", fail);
    sent.end();
  });

/** The cookies a response set, and the names it cleared. */
const cookiesOf = (answer: Answer) => {
  const set = new Map<string, string>();
  const cleared = new Set<string>();
  for (const line of answer.headers["set-cookie"] ?? []) {
    const pair = line.split(";")[0] ?? "";
    const equals = pair.indexOf("=");
    const name = pair.slice(0, equals);
    if (/max-age=0/i.test(line)) cleared.add(name);
    else set.set(name, pair.slice(equals + 1));
  }
  return { set, cleared };
};

interface Hub {
  readonly port: () => number;
  readonly servePort: number;
  readonly tailnet: Ref.Ref<FakeTailnet>;
  readonly dataDir: string;
  /** Asks Tailscale now and listens where it says, as the hub's 10 second check does. */
  readonly check: () => Promise<RemoteAccessStatus>;
  /** Stops the hub as a quit does; the data folder and the database stay. */
  readonly stop: () => Promise<void>;
}

/** The hub's window, on loopback with its key, as the desktop app's main process sends it. */
const windowRoute = (hub: Hub): Route => ({
  host: "127.0.0.1",
  port: hub.port(),
  hostHeader: `127.0.0.1:${hub.port()}`,
});
const asWindow = (hub: Hub, method: string, path: string, body?: unknown) =>
  send(windowRoute(hub), method, path, AS_WINDOW, body);

/**
 * A browser on another of the user's devices: it opens the hub's tailnet address, or its HTTPS
 * address through `tailscale serve`, and keeps the cookies the hub sets as a browser would.
 */
const browserAt = (hub: () => Hub, from: string) => {
  const jar = new Map<string, string>();
  const routeOf = (via: "tailnet" | "https"): Route =>
    via === "tailnet"
      ? { host: TAILNET_ADDRESS, port: hub().port(), from, hostHeader: `${TAILNET_ADDRESS}:${hub().port()}` }
      : { host: "127.0.0.1", port: hub().servePort, hostHeader: MAGIC_DNS };
  const headersOf = (via: "tailnet" | "https", method: string, extra: Readonly<Record<string, string>> = {}) => {
    const route = routeOf(via);
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    return {
      ...(cookie === "" ? {} : { cookie }),
      // A page's change names its own origin; a read does not.
      ...(method === "GET"
        ? {}
        : { origin: via === "tailnet" ? `http://${route.hostHeader}` : `https://${MAGIC_DNS}` }),
      // Through serve, Tailscale names the peer the request came from.
      ...(via === "https" ? { "x-forwarded-for": from, "tailscale-user-login": "you@example.com" } : {}),
      ...extra,
    };
  };
  const browser = {
    jar,
    route: routeOf,
    send: async (
      method: string,
      path: string,
      options: {
        readonly body?: unknown;
        readonly via?: "tailnet" | "https";
        readonly headers?: Record<string, string>;
      } = {},
    ) => {
      const via = options.via ?? "tailnet";
      const answer = await send(routeOf(via), method, path, headersOf(via, method, options.headers), options.body);
      const { set, cleared } = cookiesOf(answer);
      for (const name of cleared) jar.delete(name);
      for (const [name, value] of set) jar.set(name, value);
      return answer;
    },
    stream: (via: "tailnet" | "https" = "tailnet") => openStream(routeOf(via), headersOf(via, "GET")),
    /** Asks to pair as the pairing screen does, and answers the request's id and code. */
    ask: async (name: string) => {
      const opened = await browser.send("POST", "/api/pairing", { body: { name, platform: "test", kind: "browser" } });
      expect(opened.status).toBe(200);
      return opened.body.status as { readonly id: string; readonly code: string; readonly state: string };
    },
    /** Asks to pair and is allowed from the hub's window, then holds its device cookie. */
    pair: async (name: string) => {
      const asked = await browser.ask(name);
      expect((await asWindow(hub(), "POST", `/api/pairing/requests/${asked.id}/allow`)).status).toBe(200);
      expect((await browser.send("GET", "/api/pairing")).body).toMatchObject({ state: "claimed" });
      expect(jar.get("hobbots_device")).toMatch(/^hbd_/);
      return asked;
    },
  };
  return browser;
};

// One database for each case, kept across a restart of the hub as the hub's file is.
let database:
  | ManagedRuntime.ManagedRuntime<Layer.Success<typeof TestDatabase>, Layer.Error<typeof TestDatabase>>
  | undefined;
let dataDir = "";
let current: Hub | undefined;
let clock = movableClock();

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hobbots-remote-e2e-"));
  clock = movableClock();
});

afterEach(async () => {
  for (const stream of openStreams) stream.destroy();
  openStreams.clear();
  await current?.stop();
  current = undefined;
  await database?.dispose();
  database = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Starts the hub on the case's data folder and database as `main.ts` composes it: the settings
 * the user last chose, the device check above remote access, and the hub's listeners, with the
 * fake runtime and a fake Tailscale the case changes through `tailnet`.
 */
const startHub = async (tailnet: Ref.Ref<FakeTailnet> = Ref.makeUnsafe(TAILNET)): Promise<Hub> => {
  const db = database ?? ManagedRuntime.make(TestDatabase);
  database = db;
  const network = readNetworkSettings(dataDir);
  const port = network.port ?? (await freePort());
  const servePort = network.servePort ?? (await freePort());
  const Remote = HubHostsLive.pipe(
    Layer.provideMerge(
      RemoteAccessStateLive({
        enabled: network.remoteAccess ?? false,
        paused: network.remoteAccessPaused ?? false,
        port,
        https: network.https ?? false,
        servePort,
      }),
    ),
  );
  const App = HobLifecycle.layer
    .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer, EventStream.layer)))
    .pipe(Layer.provideMerge(ChatService.layer))
    .pipe(Layer.provideMerge(ApprovalService.layer))
    .pipe(Layer.provideMerge(GrantService.layer))
    .pipe(Layer.provideMerge(HobToolsLive))
    .pipe(Layer.provideMerge(CanonicalSharedFolders))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mergeAll(
            HobbotsRepositoryLive,
            ApprovalRepositoryLive,
            GrantRepositoryLive,
            TaskRepositoryLive,
            DeviceRepositoryLive,
            EventJournal.layer,
            BackpackLive,
            SetupRepository.layer,
            SearchIndex.layer,
          ).pipe(Layer.provideMerge(Layer.succeedContext(await db.context()))),
          EventBus.layer,
          HobAdmission.layer,
          NodeFolderChecks,
          FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node), Layer.provide(Remote)),
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
        ),
      ),
    );
  const server = createServer();
  const HubLayer = HttpRouter.serve(
    Layer.mergeAll(ApiRoutes, EventStreamRoute, OwnHostsOnly, KnownTailnetPeersOnly, NoFunnelRequests),
    { disableLogger: true },
  ).pipe(
    Layer.provideMerge(
      DeviceGate.layer.pipe(
        Layer.provideMerge(DeviceService.layer),
        Layer.provideMerge(knownWindowKey(TEST_WINDOW_KEY)),
        Layer.provideMerge(DeviceSecretsLive),
        Layer.provideMerge(PairingLimiterLive),
      ),
    ),
    Layer.provideMerge(RemoteAccessLive(dataDir).pipe(Layer.provideMerge(HubListenersLive(server, port)))),
    Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port })),
    Layer.provideMerge(Layer.mergeAll(App, Remote, TailscaleFake(tailnet, TAILNET.ranges))),
    Layer.provide(Layer.succeed(Clock.Clock, clock.clock)),
  );
  const runtime = ManagedRuntime.make(HubLayer);
  const access = <A, E>(use: (access: RemoteAccess["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(RemoteAccess, use));
  const hub: Hub = {
    port: () => readNetworkSettings(dataDir).port ?? port,
    servePort,
    tailnet,
    dataDir,
    check: () => access((remote) => remote.check),
    stop: async () => {
      for (const stream of openStreams) stream.destroy();
      server.closeAllConnections();
      await runtime.dispose();
    },
  };
  // The first check runs while the hub starts; wait for it to settle.
  await hub.check();
  current = hub;
  return hub;
};

const hubNow = () => {
  if (current === undefined) throw new Error("No hub is running");
  return current;
};

/** A hub with remote access turned on from the hub's window, as Settings does. */
const remoteHub = async (tailnet?: Ref.Ref<FakeTailnet>) => {
  const hub = await startHub(tailnet);
  const on = await asWindow(hub, "PATCH", "/api/remote-access", { enabled: true });
  expect(on.body).toMatchObject({ enabled: true, listening: [TAILNET_ADDRESS], problem: null });
  return hub;
};

const advance = (duration: Duration.Input) => clock.advance(duration);

/** Waits until a stream the hub was meant to end has ended, within the time `vi.waitFor` allows. */
const endedSoon = (stream: Stream) => vi.waitFor(() => expect(stream.ended()).toBe(true), { timeout: 2_000 });

const listDevices = async (hub: Hub) => (await asWindow(hub, "GET", "/api/devices")).body as ReadonlyArray<Device>;

describe("remote access end to end over a fake Tailscale", () => {
  // covers DP-004, PE-006
  it("[TC-DP-145] refuses a tailnet device that was never approved on every route and the event stream", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await remoteHub();
    const stranger = browserAt(hubNow, PHONE);
    const required = { status: 401, body: { _tag: "DeviceRequired" } };

    for (const [method, path, body] of [
      ["GET", "/api/agents", undefined],
      ["GET", "/api/devices", undefined],
      ["GET", "/api/pairing/requests", undefined],
      ["GET", "/api/remote-access", undefined],
      ["PATCH", "/api/remote-access", { paused: true }],
      ["POST", "/api/pairing/requests/anything/allow", undefined],
    ] as const) {
      expect(await stranger.send(method, path, { body })).toMatchObject(required);
    }
    const stream = await stranger.stream();
    expect(stream.status).toBe(401);
    expect(stream.text()).toContain("DeviceRequired");

    // A token the hub never issued, and the window key, which counts only on loopback.
    stranger.jar.set("hobbots_device", `hbd_${"x".repeat(43)}`);
    expect(await stranger.send("GET", "/api/agents")).toMatchObject(required);
    stranger.jar.clear();
    expect(await stranger.send("GET", "/api/agents", { headers: AS_WINDOW })).toMatchObject(required);

    // A device Tailscale does not know is refused before any route runs.
    const unknown = await send(
      { host: TAILNET_ADDRESS, port: hub.port(), from: "127.0.0.9", hostHeader: `${TAILNET_ADDRESS}:${hub.port()}` },
      "GET",
      "/api/agents",
      {},
    );
    expect(unknown.status).toBe(403);

    // Nothing changed: remote access is still on and not paused, and no device was added.
    expect((await asWindow(hub, "GET", "/api/remote-access")).body).toMatchObject({ enabled: true, paused: false });
    expect((await listDevices(hub)).map((device) => device.kind)).toEqual(["window"]);
  });

  // covers DP-004, PE-006
  it("[TC-DP-146] pairs a tailnet browser whose code matches the hub's prompt, and its token alone carries the right to decide", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await remoteHub();
    const window = await openStream(windowRoute(hub), AS_WINDOW);
    const phone = browserAt(hubNow, PHONE);

    const asked = await phone.ask("Safari on iPhone");
    expect(asked).toMatchObject({ state: "pending", code: expect.stringMatching(/^\d{6}$/) });
    expect(phone.jar.get("hobbots_pairing")).toMatch(/^hbp_/);
    expect((await phone.send("GET", "/api/pairing")).body).toMatchObject({ state: "pending", code: asked.code });

    // The hub's prompt shows the same code, from another device rather than the hub itself.
    const waiting = (await asWindow(hub, "GET", "/api/pairing/requests")).body;
    expect(waiting).toMatchObject([
      { request: { id: asked.id, code: asked.code, name: "Safari on iPhone" }, fromHub: false },
    ]);
    await vi.waitFor(() => expect(window.tags()).toContain("PairingRequested"));

    expect((await asWindow(hub, "POST", `/api/pairing/requests/${asked.id}/allow`)).status).toBe(200);
    const claimed = await phone.send("GET", "/api/pairing");
    expect(claimed.body).toMatchObject({ state: "claimed" });
    expect(claimed.body.token).toBeUndefined();
    const token = phone.jar.get("hobbots_device") ?? "";
    expect(token).toMatch(/^hbd_/);
    expect(phone.jar.has("hobbots_pairing")).toBe(false);
    expect((await phone.send("GET", "/api/agents")).status).toBe(200);
    expect((await phone.stream()).status).toBe(200);

    // The phone's own token lets it decide: it allows the laptop, which then gets in.
    const laptop = browserAt(hubNow, LAPTOP);
    const laptopAsked = await laptop.ask("Firefox on laptop");
    expect((await phone.send("GET", "/api/pairing/requests")).body).toMatchObject([
      { request: { id: laptopAsked.id, code: laptopAsked.code } },
    ]);
    expect((await phone.send("POST", `/api/pairing/requests/${laptopAsked.id}/allow`)).status).toBe(200);
    expect((await laptop.send("GET", "/api/pairing")).body).toMatchObject({ state: "claimed" });
    expect((await laptop.send("GET", "/api/agents")).status).toBe(200);

    // The phone's token is bound to its node: sent from the laptop it is refused.
    const borrowed = browserAt(hubNow, LAPTOP);
    borrowed.jar.set("hobbots_device", token);
    expect(await borrowed.send("GET", "/api/agents")).toMatchObject({ status: 401, body: { _tag: "DeviceRequired" } });

    expect((await listDevices(hub)).map((device) => device.name)).toEqual([
      "This computer's Hobbots window",
      "Safari on iPhone",
      "Firefox on laptop",
    ]);
    // What the hub told its clients about pairing, allowed and then claimed for each, never carried a secret.
    await vi.waitFor(() => expect(window.tags().filter((tag) => tag === "PairingChanged")).toHaveLength(4));
    expect(window.text()).not.toContain(token);
    expect(window.text()).not.toMatch(/hb[dp]_/);
  });

  // covers DP-004
  it("[TC-DP-147] a denied browser is told so, may not ask again within a minute, and may after it", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await remoteHub();
    const laptop = browserAt(hubNow, LAPTOP);
    const asked = await laptop.ask("Firefox on laptop");

    expect((await asWindow(hub, "POST", `/api/pairing/requests/${asked.id}/deny`)).status).toBe(200);
    expect((await laptop.send("GET", "/api/pairing")).body).toMatchObject({ state: "denied" });
    expect(laptop.jar.has("hobbots_device")).toBe(false);
    expect(await laptop.send("GET", "/api/agents")).toMatchObject({ status: 401 });
    // A denied request cannot be allowed afterwards.
    expect(await asWindow(hub, "POST", `/api/pairing/requests/${asked.id}/allow`)).toMatchObject({
      status: 409,
      body: { _tag: "PairingClosed", state: "denied" },
    });

    const tooSoon = await laptop.send("POST", "/api/pairing", {
      body: { name: "Firefox on laptop", platform: "test", kind: "browser" },
    });
    expect(tooSoon).toMatchObject({ status: 429, body: { _tag: "PairingThrottled" } });
    expect(Number(tooSoon.headers["retry-after"])).toBeGreaterThan(0);
    expect((await asWindow(hub, "GET", "/api/pairing/requests")).body).toEqual([]);

    advance("61 seconds");
    const again = await laptop.ask("Firefox on laptop");
    expect(again.id).not.toBe(asked.id);
    expect((await asWindow(hub, "GET", "/api/pairing/requests")).body).toMatchObject([{ request: { id: again.id } }]);
  });

  // covers DP-004
  it("[TC-DP-148] an expired request cannot be allowed, while one left for later is still allowed", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await remoteHub();
    const phone = browserAt(hubNow, PHONE);
    const laptop = browserAt(hubNow, LAPTOP);
    const expiring = await phone.ask("Safari on iPhone");
    const deferred = await laptop.ask("Firefox on laptop");
    expect((await asWindow(hub, "POST", `/api/pairing/requests/${deferred.id}/later`)).status).toBe(200);

    advance("11 minutes");
    expect((await phone.send("GET", "/api/pairing")).body).toMatchObject({ state: "expired" });
    expect(await asWindow(hub, "POST", `/api/pairing/requests/${expiring.id}/allow`)).toMatchObject({
      status: 409,
      body: { _tag: "PairingClosed", state: "expired" },
    });
    expect(phone.jar.has("hobbots_device")).toBe(false);
    expect(await phone.send("GET", "/api/agents")).toMatchObject({ status: 401 });

    // Decide later keeps the laptop's request open, and it can still be allowed.
    expect((await asWindow(hub, "GET", "/api/pairing/requests")).body).toMatchObject([
      { request: { id: deferred.id } },
    ]);
    expect((await laptop.send("GET", "/api/pairing")).body).toMatchObject({ state: "pending" });
    expect((await asWindow(hub, "POST", `/api/pairing/requests/${deferred.id}/allow`)).status).toBe(200);
    expect((await laptop.send("GET", "/api/pairing")).body).toMatchObject({ state: "claimed" });
    expect((await laptop.send("GET", "/api/agents")).status).toBe(200);
  });

  // covers DP-004
  it("[TC-DP-149] an approved browser keeps working without asking again, after the hub restarts too", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const tailnet = Ref.makeUnsafe(TAILNET);
    const hub = await remoteHub(tailnet);
    const phone = browserAt(hubNow, PHONE);
    await phone.pair("Safari on iPhone");
    const token = phone.jar.get("hobbots_device");
    for (let read = 0; read < 3; read += 1) expect((await phone.send("GET", "/api/agents")).status).toBe(200);

    // A quit and a new start on the same data: remote access is still on, and the phone still in.
    await hub.stop();
    const restarted = await startHub(tailnet);
    expect((await asWindow(restarted, "GET", "/api/remote-access")).body).toMatchObject({
      enabled: true,
      listening: [TAILNET_ADDRESS],
    });
    expect((await phone.send("GET", "/api/agents")).status).toBe(200);
    expect((await phone.stream()).status).toBe(200);
    expect(phone.jar.get("hobbots_device")).toBe(token);
    expect((await asWindow(restarted, "GET", "/api/pairing/requests")).body).toEqual([]);
  });

  // covers DP-004, PE-006
  it("[TC-DP-150] Revoke closes the device's open stream at once and refuses its next request, and it may ask again", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await remoteHub();
    const phone = browserAt(hubNow, PHONE);
    const laptop = browserAt(hubNow, LAPTOP);
    await phone.pair("Safari on iPhone");
    await laptop.pair("Firefox on laptop");
    const phoneStream = await phone.stream();
    const laptopStream = await laptop.stream();
    await vi.waitFor(() => expect(phoneStream.tags()).toContain("Ready"));

    const phoneDevice = (await listDevices(hub)).find((device) => device.name === "Safari on iPhone");
    expect((await asWindow(hub, "POST", `/api/devices/${phoneDevice?.id}/revoke`)).status).toBe(200);

    await endedSoon(phoneStream);
    // The laptop's stream stays open and hears of it.
    await vi.waitFor(() => expect(laptopStream.tags()).toContain("DeviceRevoked"));
    expect(laptopStream.ended()).toBe(false);

    // The next request is refused as revoked, once, and the cookie is dropped.
    expect(await phone.send("GET", "/api/agents")).toMatchObject({ status: 401, body: { _tag: "DeviceRevoked" } });
    expect(phone.jar.has("hobbots_device")).toBe(false);
    expect(await phone.send("GET", "/api/agents")).toMatchObject({ status: 401, body: { _tag: "DeviceRequired" } });
    expect((await phone.stream()).status).toBe(401);
    expect((await laptop.send("GET", "/api/agents")).status).toBe(200);

    // Asking again is a new request the user answers.
    const again = await phone.ask("Safari on iPhone");
    expect((await asWindow(hub, "GET", "/api/pairing/requests")).body).toMatchObject([{ request: { id: again.id } }]);
  });

  // covers DP-004
  it("[TC-DP-151] Pause closes the tailnet and serve listeners with their streams while this computer keeps working, and Resume lets the same devices back", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const hub = await remoteHub();
    const phone = browserAt(hubNow, PHONE);
    const laptop = browserAt(hubNow, LAPTOP);
    await phone.pair("Safari on iPhone");
    await laptop.pair("Firefox on laptop");
    expect((await asWindow(hub, "PATCH", "/api/remote-access", { https: true })).body.https).toMatchObject({
      listening: true,
    });
    const overTailnet = await phone.stream();
    const overHttps = await laptop.stream("https");
    const window = await openStream(windowRoute(hub), AS_WINDOW);
    expect([overTailnet.status, overHttps.status, window.status]).toEqual([200, 200, 200]);

    const paused = await asWindow(hub, "PATCH", "/api/remote-access", { paused: true });
    expect(paused.body).toMatchObject({ paused: true, listening: [], problem: "paused", https: { listening: false } });
    await endedSoon(overTailnet);
    await endedSoon(overHttps);
    expect(await refusal(phone.route("tailnet"))).toBe("ECONNREFUSED");
    expect(await refusal(laptop.route("https"))).toBe("ECONNREFUSED");

    // This computer keeps working, and its window hears of the pause.
    expect((await asWindow(hub, "GET", "/api/agents")).status).toBe(200);
    await vi.waitFor(() => expect(window.remoteAccess().at(-1)).toMatchObject({ paused: true }));
    expect(window.ended()).toBe(false);
    // Pausing revoked nothing.
    expect((await listDevices(hub)).filter((device) => device.revokedAt === null)).toHaveLength(3);

    const resumed = await asWindow(hub, "PATCH", "/api/remote-access", { paused: false });
    expect(resumed.body).toMatchObject({ paused: false, listening: [TAILNET_ADDRESS], https: { listening: true } });
    expect((await phone.send("GET", "/api/agents")).status).toBe(200);
    expect((await laptop.send("GET", "/api/agents", { via: "https" })).status).toBe(200);
  });

  // covers DP-004
  it("[TC-DP-152] Tailscale turning off closes the tailnet listener and its streams, says why, and the hub listens again once it is back", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const tailnet = Ref.makeUnsafe(TAILNET);
    const hub = await remoteHub(tailnet);
    const phone = browserAt(hubNow, PHONE);
    await phone.pair("Safari on iPhone");
    const stream = await phone.stream();
    const window = await openStream(windowRoute(hub), AS_WINDOW);

    await Effect.runPromise(Ref.update(tailnet, (fake) => ({ ...fake, state: "notRunning" as const })));
    expect(await hub.check()).toMatchObject({ enabled: true, listening: [], problem: "tailscale" });
    await endedSoon(stream);
    expect(await refusal(phone.route("tailnet"))).toBe("ECONNREFUSED");

    // Settings reads why, and the window heard it as it happened; this computer keeps working.
    expect((await asWindow(hub, "GET", "/api/remote-access")).body).toMatchObject({
      enabled: true,
      problem: "tailscale",
      tailscale: { state: "notRunning" },
    });
    await vi.waitFor(() => expect(window.remoteAccess().at(-1)).toMatchObject({ problem: "tailscale" }));
    expect((await asWindow(hub, "GET", "/api/agents")).status).toBe(200);

    await Effect.runPromise(Ref.set(tailnet, TAILNET));
    expect(await hub.check()).toMatchObject({ listening: [TAILNET_ADDRESS], problem: null });
    expect((await phone.send("GET", "/api/agents")).status).toBe(200);
    await vi.waitFor(() => expect(window.remoteAccess().at(-1)).toMatchObject({ problem: null }));
  });

  // covers DP-004
  it("[TC-DP-153] a changed port reaches every open client, which then finds the hub there, and is kept across a restart", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const tailnet = Ref.makeUnsafe(TAILNET);
    const hub = await remoteHub(tailnet);
    const before = hub.port();
    const phone = browserAt(hubNow, PHONE);
    await phone.pair("Safari on iPhone");
    const phoneStream = await phone.stream();
    const window = await openStream(windowRoute(hub), AS_WINDOW);
    await vi.waitFor(() => expect(phoneStream.tags()).toContain("Ready"));

    const next = await freePort();
    const moved = await asWindow(hub, "PATCH", "/api/remote-access", { port: next });
    expect(moved.body).toMatchObject({ port: next, listening: [TAILNET_ADDRESS] });

    // Both open streams, the phone's on the tailnet included, hear where the hub went.
    await vi.waitFor(() => expect(phoneStream.remoteAccess().at(-1)?.port).toBe(next));
    await vi.waitFor(() => expect(window.remoteAccess().at(-1)?.port).toBe(next));
    expect(hub.port()).toBe(next);
    expect((await phone.send("GET", "/api/agents")).status).toBe(200);
    expect((await asWindow(hub, "GET", "/api/agents")).status).toBe(200);
    const old = { host: TAILNET_ADDRESS, port: before, from: PHONE, hostHeader: `${TAILNET_ADDRESS}:${before}` };
    expect(await refusal(old)).toBe("ECONNREFUSED");
    expect(await refusal({ ...old, host: "127.0.0.1", hostHeader: `127.0.0.1:${before}` })).toBe("ECONNREFUSED");

    await hub.stop();
    const restarted = await startHub(tailnet);
    expect(restarted.port()).toBe(next);
    expect((await phone.send("GET", "/api/agents")).status).toBe(200);
  });

  // covers DP-004
  it("[TC-DP-154] HTTPS through tailscale serve: an HTTP-approved device keeps working, only serve's forwarded identity counts, funnel is refused, and serve left forwarding is reported", async ({
    skip,
  }) => {
    if (!spareLoopback) skip();
    const tailnet = Ref.makeUnsafe(TAILNET);
    const hub = await remoteHub(tailnet);
    const phone = browserAt(hubNow, PHONE);
    await phone.pair("Safari on iPhone");
    const token = phone.jar.get("hobbots_device") ?? "";

    expect((await asWindow(hub, "PATCH", "/api/remote-access", { https: true })).body.https).toMatchObject({
      enabled: true,
      listening: true,
    });
    const served = await asWindow(hub, "POST", "/api/remote-access/serve", { forward: true });
    expect(served.body.https).toMatchObject({ forwarding: true });
    expect((await Effect.runPromise(Ref.get(tailnet))).serve).toBe(`http://127.0.0.1:${hub.servePort}`);

    // Approved over HTTP, the phone gets in over HTTPS with the cookie it has, and moves to the secure one.
    expect((await phone.send("GET", "/api/agents", { via: "https" })).status).toBe(200);
    expect(phone.jar.get("__Host-hobbots_device")).toBe(token);
    expect((await phone.stream("https")).status).toBe(200);
    expect((await phone.send("GET", "/api/pairing/requests", { via: "https" })).status).toBe(200);

    // Forwarded identity counts only on the serve listener: sent to loopback with the phone's token,
    // the request stays local, and the token, bound to the phone's node, is refused there.
    const forged = {
      cookie: `hobbots_device=${token}`,
      "x-forwarded-for": PHONE,
      "tailscale-user-login": "you@example.com",
    };
    expect(await send(windowRoute(hub), "GET", "/api/agents", forged)).toMatchObject({ status: 401 });
    // Through serve, a token from another node is refused, and so is the window key.
    expect(
      await phone.send("GET", "/api/agents", { via: "https", headers: { "x-forwarded-for": LAPTOP } }),
    ).toMatchObject({ status: 401 });
    expect(
      await send(phone.route("https"), "GET", "/api/agents", { ...AS_WINDOW, "x-forwarded-for": PHONE }),
    ).toMatchObject({ status: 401, body: { _tag: "DeviceRequired" } });

    // A request that came through Funnel is refused on every listener, even with the phone's token.
    const funnel = { "tailscale-funnel-request": "?1" };
    expect((await phone.send("GET", "/api/agents", { via: "https", headers: funnel })).status).toBe(403);
    expect((await phone.send("GET", "/api/agents", { headers: funnel })).status).toBe(403);
    expect((await send(windowRoute(hub), "GET", "/api/agents", { ...AS_WINDOW, ...funnel })).status).toBe(403);

    // HTTPS off closes the serve listener, Settings says serve still forwards, and the phone keeps HTTP.
    const off = await asWindow(hub, "PATCH", "/api/remote-access", { https: false });
    expect(off.body.https).toMatchObject({ enabled: false, listening: false, forwarding: true });
    expect(await refusal(phone.route("https"))).toBe("ECONNREFUSED");
    expect((await phone.send("GET", "/api/agents")).status).toBe(200);
    expect((await asWindow(hub, "POST", "/api/remote-access/serve", { forward: false })).body.https).toMatchObject({
      forwarding: false,
    });
    expect((await Effect.runPromise(Ref.get(tailnet))).serve).toBeUndefined();
  });
});
