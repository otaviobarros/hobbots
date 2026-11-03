import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECT_PROTOCOL } from "@hobbots/api";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startMode } from "../src/main/app-mode.ts";
import { pairAsDesktop } from "../src/main/desktop-pairing.ts";
import { disconnectFromHub } from "../src/main/disconnect.ts";
import {
  type ConnectionState,
  connectedHub,
  type HubOrigins,
  hubOrigins,
  isHubPage,
  makeNodeCheck,
  type NodeLookup,
  type TailnetNode,
  windowRequestGate,
} from "../src/main/hub-connection.ts";
import { followHub } from "../src/main/hub-events.ts";
import { desktopMode, fileSettingsStore, type HubConnection } from "../src/main/settings.ts";
import { thisComputer } from "../src/main/tailnet.ts";
import {
  type BeforeSendHeaders,
  DEVICE_COOKIE,
  deviceCookies,
  guardWindowRequests,
  SECURE_DEVICE_COOKIE,
  withoutDeviceCookies,
} from "../src/main/window-cookies.ts";
import { readyFrame } from "./fake-event-stream.ts";

// A connected desktop (ADR 025) against a fake hub: the main process's own requests, pairing as a
// desktop, the node check and the window's cookies, with this computer's Tailscale and keychain
// faked. The Electron wiring around them is in src/main/connected-mode.ts.

const temp = mkdtempSync(join(tmpdir(), "hobbots-connected-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

const HUB_ADDRESS = "100.64.0.7";
const STUDIO: TailnetNode = {
  nodeId: "nSTUDIO",
  nodeName: "studio.example.ts.net",
  owner: { _tag: "User", login: "you@example.com" },
};
const OTHER: TailnetNode = { ...STUDIO, nodeId: "nOTHER", nodeName: "other.example.ts.net" };
const ORIGINS = hubOrigins("http://studio.example.ts.net:4317") as HubOrigins;
const DEVICE = { name: "Hobbots on MacBook Air", platform: "macOS" };

/** This computer's Tailscale: the hub's name resolves to its tailnet address, and whois names the node there. */
const tailnet = () => {
  const nodes = new Map<string, TailnetNode>([[HUB_ADDRESS, STUDIO]]);
  const lookup: NodeLookup = {
    resolve: async () => [HUB_ADDRESS],
    whois: async (address) => nodes.get(address) ?? null,
  };
  return { nodes, lookup };
};

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly origin: string | null;
  readonly body: unknown;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * A hub that answers health, pairing and the device's reads. `decide` says what the user does on the
 * hub; a pretender answers Allow with a token of its own before anyone was asked.
 */
const fakeHub = (options: { health?: unknown; pretend?: boolean } = {}) => {
  const sent: Array<Sent> = [];
  let decision: "pending" | "allowed" = options.pretend ? "allowed" : "pending";
  let revoked = false;
  let reachable = true;
  /** This computer's device as the hub lists it. */
  const device = () => ({
    id: "dev1",
    name: DEVICE.name,
    kind: "desktop",
    revokedAt: revoked ? "2026-11-03T09:00:00.000Z" : null,
  });
  /** The hub's device list, and this device's own revoke with its token. */
  const deviceRoute = (route: string, headers: Headers) => {
    if (route === "GET /api/devices") return json([device()]);
    if (route !== "POST /api/devices/dev1/revoke") return json({}, 404);
    if (headers.get("authorization") !== "Bearer hbd_token") return json({ _tag: "DeviceRequired" }, 401);
    if (revoked) return json({ _tag: "DeviceRevoked", message: "This device was removed from this hub." }, 401);
    revoked = true;
    return json(device());
  };
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    if (!reachable) throw new TypeError("fetch failed");
    sent.push({
      method,
      path: parsed.pathname,
      authorization: headers.get("authorization"),
      origin: headers.get("origin"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const status = { id: "p1", code: "042317", expiresAt: "2026-11-03T02:00:00.000Z" };
    switch (`${method} ${parsed.pathname}`) {
      case "GET /api/health":
        return json(options.health ?? { app: "hobbots", name: "Studio", version: "0.5.0", connect: CONNECT_PROTOCOL });
      case "POST /api/pairing":
        return json({ status: { ...status, state: "pending" }, secret: "hbp_secret" });
      case "GET /api/pairing":
        if (headers.get("authorization") !== "Bearer hbp_secret") return json({ _tag: "PairingNotFound" }, 404);
        return json(
          decision === "allowed"
            ? { ...status, state: "allowed", token: options.pretend ? "hbd_pretender" : "hbd_token", deviceId: "dev1" }
            : { ...status, state: decision },
        );
      case "GET /api/activity":
        if (revoked) return json({ _tag: "DeviceRevoked", message: "This device was removed from this hub." }, 401);
        return json({ working: [] });
      case "GET /api/events":
        return new Response(readyFrame, { headers: { "content-type": "text/event-stream" } });
      default:
        return deviceRoute(`${method} ${parsed.pathname}`, headers);
    }
  }) as typeof globalThis.fetch;
  return {
    fetch,
    sent,
    allow: () => {
      decision = "allowed";
    },
    revoke: () => {
      revoked = true;
    },
    /** Turns the hub's computer off, or on again: nothing answers while it is off. */
    setReachable: (on: boolean) => {
      reachable = on;
    },
    /** The requests that carried a token or a pairing secret. */
    withSecrets: () => sent.filter((request) => request.authorization !== null),
  };
};

/** This computer's keychain in memory, through the same service the app uses. */
const keychain = () => {
  const computer = thisComputer({
    dataDir: temp,
    env: { HOBBOTS_FAKE_KEYCHAIN: "memory", HOBBOTS_FAKE_TAILSCALE: "on" },
    platform: process.platform,
  });
  stops.push(() => computer.dispose());
  return computer.token;
};

/** Pairs with the fake hub; the user answers on the hub while the app waits. */
const pair = (hub: ReturnType<typeof fakeHub>, lookup: NodeLookup, keepToken: (token: string) => Promise<void>) => {
  const waiting: Array<{ readonly nodeName: string; readonly hubName: string; readonly code: string }> = [];
  const outcome = pairAsDesktop({
    origins: ORIGINS,
    device: DEVICE,
    nodeCheck: makeNodeCheck(lookup),
    ownLogin: "you@example.com",
    fetch: hub.fetch,
    keepToken,
    onWaiting: ({ node, hubName, code }) => void waiting.push({ nodeName: node.nodeName, hubName, code }),
    intervalMs: 1,
    sleep: async () => {
      // The user allows on the hub after the app asked once.
      if (hub.sent.filter((request) => request.path === "/api/pairing").length >= 2) hub.allow();
    },
  });
  return { outcome, waiting };
};

const CONNECTION: HubConnection = {
  address: ORIGINS.origin,
  name: "Studio",
  nodeId: STUDIO.nodeId,
  nodeName: STUDIO.nodeName,
  deviceId: "dev1",
};

describe("the connected desktop", () => {
  // covers DP-001, DP-002
  it("[TC-DP-157] starts with no server and keeps only its settings here, with the token only in the keychain", async () => {
    const dataDir = mkdtempSync(join(temp, "data-"));
    const settings = fileSettingsStore(join(dataDir, "desktop-settings.json"));
    const hub = fakeHub();
    const { lookup } = tailnet();
    const token = keychain();
    const { outcome } = pair(hub, lookup, token.write);
    const paired = await outcome;
    expect(paired.kind).toBe("allowed");
    if (paired.kind !== "allowed") return;
    settings.update({ mode: "connected", connection: paired.connection });

    // Pairing asked as the desktop app: `kind: "desktop"`, no `Origin`, the secret as a bearer token.
    const opened = hub.sent.find((request) => request.method === "POST" && request.path === "/api/pairing");
    expect(opened).toMatchObject({ origin: null, body: { ...DEVICE, kind: "desktop" } });
    expect(paired.connection).toEqual(CONNECTION);

    // The token is in the keychain, and nowhere in this computer's data folder.
    expect(await token.read()).toBe("hbd_token");
    expect(readdirSync(dataDir)).toEqual(["desktop-settings.json"]);
    expect(readFileSync(join(dataDir, "desktop-settings.json"), "utf8")).not.toContain("hbd_");

    // Every later start is a connected desktop's, which runs no server, even beside an installation ID.
    expect(startMode(fileSettingsStore(join(dataDir, "desktop-settings.json")), { installationId: "id" })).toEqual({
      start: "connected",
      connection: CONNECTION,
    });
    // An existing hub stays a hub, and writes that down without asking.
    const hubSettings = fileSettingsStore(join(dataDir, "hub-settings.json"));
    expect(startMode(hubSettings, { installationId: "id", connectTo: ORIGINS.origin })).toEqual({ start: "hub" });
    expect(hubSettings.read().mode).toBe("hub");
    // A computer that chose nothing pairs before it becomes a connected desktop.
    expect(
      startMode(fileSettingsStore(join(dataDir, "new.json")), { installationId: undefined, connectTo: "x" }),
    ).toEqual({ start: "pair", address: "x" });
  });

  // covers DP-001
  it("[TC-DP-158] keeps the hub's 400-day refresh of the device cookie out of the window's cookie store, and every other cookie in", () => {
    const answer = {
      "content-type": ["application/json"],
      "Set-Cookie": [
        "hobbots_device=hbd_token; Max-Age=34560000; Path=/; HttpOnly; SameSite=Strict",
        "__Host-hobbots_device=hbd_token; Max-Age=34560000; Path=/; HttpOnly; Secure; SameSite=Strict",
        "hobbots_pairing=; Max-Age=0; Path=/api/pairing",
      ],
    };
    expect(withoutDeviceCookies(answer)).toEqual({
      "content-type": ["application/json"],
      "Set-Cookie": ["hobbots_pairing=; Max-Age=0; Path=/api/pairing"],
    });
    // An answer that only refreshes the device cookie loses the header entirely.
    expect(withoutDeviceCookies({ "set-cookie": [answer["Set-Cookie"][0] as string] })).toEqual({});
    // The page's own storage is the browser engine's, untouched: only response headers are filtered.
    expect(withoutDeviceCookies({ "cache-control": ["no-store"] })).toEqual({ "cache-control": ["no-store"] });
  });

  // covers DP-001, DP-002
  it("[TC-DP-159] the window carries the token as two session cookies, and the main process sends it as a bearer token", async () => {
    // Both of the hub's origins, HttpOnly and SameSite=Strict, with no expiry and no Domain.
    const cookies = deviceCookies(ORIGINS, "hbd_token");
    expect(cookies).toEqual([
      expect.objectContaining({ url: "http://studio.example.ts.net/", name: DEVICE_COOKIE, secure: false }),
      expect.objectContaining({ url: "https://studio.example.ts.net/", name: SECURE_DEVICE_COOKIE, secure: true }),
    ]);
    for (const cookie of cookies) {
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/" });
      expect(cookie).not.toHaveProperty("expirationDate");
      expect(cookie).not.toHaveProperty("domain");
    }
    // The window may show the hub's two origins, HTTP on its port and HTTPS, and nothing else:
    // another port on the same host is another service.
    expect(isHubPage(ORIGINS, "http://studio.example.ts.net:4317/threads/t1")).toBe(true);
    expect(isHubPage(ORIGINS, "https://studio.example.ts.net/")).toBe(true);
    expect(isHubPage(ORIGINS, "http://studio.example.ts.net:8080/")).toBe(false);
    expect(isHubPage(ORIGINS, "http://studio.example.ts.net/")).toBe(false);
    expect(isHubPage(ORIGINS, "https://studio.example.ts.net:8443/")).toBe(false);
    expect(isHubPage(ORIGINS, "https://example.com/")).toBe(false);
    expect(isHubPage(ORIGINS, "file:///etc/passwd")).toBe(false);

    const hub = fakeHub();
    const connected = connectedHub({
      origins: ORIGINS,
      nodeId: STUDIO.nodeId,
      fallbackName: STUDIO.nodeName,
      nodeCheck: makeNodeCheck(tailnet().lookup),
      token: async () => "hbd_token",
      fetch: hub.fetch,
    });
    expect(await connected.verify()).toEqual({ state: "connected", version: "0.5.0" });
    // The menu bar's and notifications' reads, and the event stream, all carry the bearer token.
    await connected.fetchAsDevice("/api/approvals");
    let connects = 0;
    const events = followHub({
      url: () => `${ORIGINS.origin}/api/events`,
      headers: connected.headers,
      canConnect: () => true,
      onConnected: () => void connects++,
      onChange: () => {},
      onLost: () => {},
      fetch: hub.fetch,
    });
    stops.push(events.stop);
    await expect.poll(() => connects).toBeGreaterThan(0);
    const reads = hub.sent.filter((request) => request.path === "/api/approvals" || request.path === "/api/events");
    expect(reads.map((request) => request.authorization)).toEqual(["Bearer hbd_token", "Bearer hbd_token"]);
    // Health is the one request without it.
    expect(hub.sent.find((request) => request.path === "/api/health")?.authorization).toBeNull();

    // A device the hub revoked is told apart from a hub that cannot say.
    hub.revoke();
    expect(await connected.refusal()).toBe("revoked");
  });

  // covers DP-001, DP-004
  it("[TC-DP-176] the window's requests reach the hub's origins only while its address is the pinned node's", async () => {
    const { nodes, lookup } = tailnet();
    let now = 0;
    // The window's session, as Electron's webRequest hands each request to the guard.
    let listener: Parameters<BeforeSendHeaders["onBeforeSendHeaders"]>[0] | undefined;
    let refused = 0;
    guardWindowRequests(
      {
        onBeforeSendHeaders: (next) => {
          listener = next;
        },
      },
      windowRequestGate({ origins: ORIGINS, nodeId: STUDIO.nodeId, nodeCheck: makeNodeCheck(lookup, () => now) }),
      () => {
        refused++;
      },
    );
    const send = (url: string, cookie = "hobbots_device=hbd_token; theme=dark") =>
      new Promise<{ cancel?: boolean; requestHeaders?: Record<string, string> }>((answer) =>
        listener?.({ url, requestHeaders: { cookie, accept: "text/html" } }, answer),
      );

    // The pinned node: page loads and the hub's calls go out untouched.
    expect(await send("http://studio.example.ts.net:4317/")).toEqual({});
    expect(await send("https://studio.example.ts.net/api/threads")).toEqual({});
    // Another port of the hub's host is another service: it never sees the device cookies.
    expect(await send("http://studio.example.ts.net:8080/")).toEqual({
      requestHeaders: { cookie: "theme=dark", accept: "text/html" },
    });
    expect(
      await send("http://studio.example.ts.net:8080/", "__Host-hobbots_device=hbd_token; hobbots_device=hbd_token"),
    ).toEqual({ requestHeaders: { accept: "text/html" } });
    // Other hosts get none of the hub's cookies anyway.
    expect(await send("https://example.com/")).toEqual({});
    expect(refused).toBe(0);

    // The address moves to another computer: a reload, a link and a call of the page are all cancelled
    // before they are sent, and each one checks the connection again.
    nodes.set(HUB_ADDRESS, OTHER);
    now += 61_000;
    expect(await send("http://studio.example.ts.net:4317/")).toEqual({ cancel: true });
    expect(await send("https://studio.example.ts.net/threads/t1")).toEqual({ cancel: true });
    expect(await send("http://studio.example.ts.net:4317/api/activity")).toEqual({ cancel: true });
    expect(refused).toBe(3);
    // A Tailscale that cannot answer is not the pinned node either.
    const broken = windowRequestGate({
      origins: ORIGINS,
      nodeId: STUDIO.nodeId,
      nodeCheck: makeNodeCheck({ resolve: async () => [HUB_ADDRESS], whois: () => Promise.reject(new Error("down")) }),
    });
    expect(await broken("http://studio.example.ts.net:4317/")).toBe("cancel");
  });

  // covers DP-001, DP-004
  it("[TC-DP-161] an address that now belongs to another Tailscale node gets no token and no page", async () => {
    const hub = fakeHub();
    const { nodes, lookup } = tailnet();
    let now = 0;
    const connected = connectedHub({
      origins: ORIGINS,
      nodeId: STUDIO.nodeId,
      fallbackName: STUDIO.nodeName,
      nodeCheck: makeNodeCheck(lookup, () => now),
      token: async () => "hbd_token",
      fetch: hub.fetch,
    });
    expect((await connected.verify()).state).toBe("connected");
    // The address moves to another computer; the answer about the node is kept for a minute.
    nodes.set(HUB_ADDRESS, OTHER);
    now += 61_000;
    const before = hub.sent.length;
    expect(await connected.verify()).toEqual({ state: "otherNode" });
    await expect(connected.fetchAsDevice("/api/approvals")).rejects.toThrow(/otherNode/);
    await expect(connected.headers()).rejects.toThrow(/otherNode/);
    // Nothing at all was sent to the address, health included.
    expect(hub.sent.length).toBe(before);

    // Pairing stops too, before the pairing secret is sent, when the node changes while waiting.
    const waitingHub = fakeHub();
    const moving = tailnet();
    const outcome = await pairAsDesktop({
      origins: ORIGINS,
      device: DEVICE,
      nodeCheck: makeNodeCheck(moving.lookup),
      ownLogin: "you@example.com",
      fetch: waitingHub.fetch,
      keepToken: async () => {
        throw new Error("no token should be kept");
      },
      onWaiting: () => {
        moving.nodes.set(HUB_ADDRESS, OTHER);
      },
      intervalMs: 1,
      sleep: async () => waitingHub.allow(),
    });
    // The minute-long answer from before the wait still names the hub, so the change is found
    // once Allow hands over a token: it is never kept.
    expect(outcome.kind).toBe("otherNode");
  });

  // covers DP-001
  it("[TC-DP-162] never pairs with a hub outside the connect protocol range, and says which side to update", async () => {
    const { lookup } = tailnet();
    const tryHub = async (health: unknown) => {
      const hub = fakeHub({ health });
      const { outcome } = pair(hub, lookup, async () => {});
      return { outcome: await outcome, opened: hub.sent.some((request) => request.method === "POST") };
    };
    const hobbots = { app: "hobbots", name: "Studio", version: "0.3.0" };
    expect(await tryHub(hobbots)).toEqual({
      outcome: { kind: "unsupported", side: "hubOlder", version: "0.3.0" },
      opened: false,
    });
    expect(await tryHub({ ...hobbots, version: "9.0.0", connect: CONNECT_PROTOCOL + 1 })).toEqual({
      outcome: { kind: "unsupported", side: "appOlder", version: "9.0.0" },
      opened: false,
    });
    expect(await tryHub({ hello: "world" })).toEqual({ outcome: { kind: "notHobbots" }, opened: false });
    // Another version inside the range works.
    const other = await tryHub({ ...hobbots, version: "0.9.1", connect: CONNECT_PROTOCOL });
    expect(other.outcome.kind).toBe("allowed");

    // A hub that moves outside the range while connected is checked on the next connection.
    const hub = fakeHub({ health: { ...hobbots, connect: CONNECT_PROTOCOL + 1 } });
    const connected = connectedHub({
      origins: ORIGINS,
      nodeId: STUDIO.nodeId,
      fallbackName: STUDIO.nodeName,
      nodeCheck: makeNodeCheck(lookup),
      token: async () => "hbd_token",
      fetch: hub.fetch,
    });
    expect(await connected.verify()).toEqual({ state: "unsupported", side: "appOlder", version: "0.3.0" });
  });

  // covers DP-001, DP-004
  it("[TC-DP-174] a program that pretends to be a hub is trusted only as the node the user chose, and never gets a real token", async () => {
    const pretender = fakeHub({
      pretend: true,
      health: { app: "hobbots", name: "Your Hub", version: "0.5.0", connect: 1 },
    });
    const { lookup } = tailnet();
    const kept: Array<string> = [];
    const { outcome, waiting } = pair(pretender, lookup, async (token) => void kept.push(token));
    const paired = await outcome;
    // It answered Allow before anyone was asked: the app cannot tell, so it names the computer by
    // what Tailscale says, with the name the program reports only beside it.
    expect(waiting).toEqual([{ nodeName: STUDIO.nodeName, hubName: "Your Hub", code: "042317" }]);
    expect(paired).toMatchObject({ kind: "allowed", connection: { nodeId: STUDIO.nodeId, nodeName: STUDIO.nodeName } });
    // The only token it can hand over is its own; no real one was ever sent to it.
    expect(kept).toEqual(["hbd_pretender"]);
    expect(pretender.withSecrets().every((request) => request.authorization === "Bearer hbp_secret")).toBe(true);

    // A node of another Tailscale user, or a tagged one, is never asked.
    for (const owner of [
      { _tag: "User", login: "someone@example.com" },
      { _tag: "Tagged", tags: ["tag:server"] },
    ] as const) {
      const elsewhere = tailnet();
      elsewhere.nodes.set(HUB_ADDRESS, { ...STUDIO, owner });
      const hub = fakeHub();
      expect((await pair(hub, elsewhere.lookup, async () => {}).outcome).kind).toBe("notYourNode");
      expect(hub.sent).toEqual([]);
    }
  });
});

describe("Disconnect on a connected desktop", () => {
  /** A connected desktop with its token in the keychain, its settings, and Disconnect against `hub`. */
  const connectedTo = async (hub: ReturnType<typeof fakeHub>, lookup: NodeLookup) => {
    const dataDir = mkdtempSync(join(temp, "disconnect-"));
    const settings = fileSettingsStore(join(dataDir, "desktop-settings.json"));
    settings.update({ openAtLogin: true, mode: "connected", connection: CONNECTION });
    const token = keychain();
    await token.write("hbd_token");
    const cookies = { cleared: 0 };
    const connected = connectedHub({
      origins: ORIGINS,
      nodeId: STUDIO.nodeId,
      fallbackName: STUDIO.nodeName,
      nodeCheck: makeNodeCheck(lookup),
      token: token.read,
      fetch: hub.fetch,
    });
    const disconnect = (state: ConnectionState = { state: "connected", version: "0.5.0" }) =>
      disconnectFromHub({
        connection: CONNECTION,
        state: () => state,
        hub: connected,
        token,
        clearCookies: async () => void cookies.cleared++,
        settings,
      });
    return { settings, token, cookies, disconnect };
  };

  /** What is left on this computer after Disconnect: the token, the mode and the cookies cleared. */
  const forgotten = async ({ settings, token, cookies }: Awaited<ReturnType<typeof connectedTo>>) => {
    expect(await token.read()).toBeUndefined();
    expect(cookies.cleared).toBe(1);
    // No mode is chosen, and this Mac's own choices stay.
    expect(desktopMode(settings.read())).toBeUndefined();
    expect(settings.read()).toEqual({ openAtLogin: true, leftHub: true });
    // The next start asks what this Mac is for: it never starts a hub, which would make it one for good.
    expect(startMode(settings, { installationId: undefined })).toEqual({ start: "choose" });
    // Choosing again still works: pairing with a hub, or a hub's own installation.
    expect(startMode(settings, { installationId: undefined, connectTo: ORIGINS.origin })).toMatchObject({
      start: "pair",
    });
  };

  // covers DP-001, DP-004
  it("[TC-DP-167] revokes this device on the hub as itself, deletes the keychain item and clears the mode", async () => {
    const hub = fakeHub();
    const { lookup } = tailnet();
    const desktop = await connectedTo(hub, lookup);
    expect(await desktop.disconnect()).toEqual({ stillListed: false });

    // The revoke went to the pinned node with this device's own token, and the hub lists it as revoked.
    expect(hub.withSecrets()).toEqual([
      {
        method: "POST",
        path: "/api/devices/dev1/revoke",
        authorization: "Bearer hbd_token",
        origin: null,
        body: undefined,
      },
    ]);
    const listed = (await (await hub.fetch(`${ORIGINS.origin}/api/devices`)).json()) as Array<{ revokedAt: unknown }>;
    expect(listed).toMatchObject([{ id: "dev1", revokedAt: expect.any(String) }]);
    await forgotten(desktop);

    // A device the hub already removed asks nothing more of it, and nothing is left listed there.
    const again = fakeHub();
    again.revoke();
    const removed = await connectedTo(again, tailnet().lookup);
    expect(await removed.disconnect({ state: "revoked" })).toEqual({ stillListed: false });
    expect(again.sent).toEqual([]);
    await forgotten(removed);
  });

  // covers DP-001, DP-004
  it("[TC-DP-168] with the hub out of reach, still forgets the hub here and says the device stays listed there", async () => {
    const hub = fakeHub();
    hub.setReachable(false);
    const desktop = await connectedTo(hub, tailnet().lookup);
    expect(await desktop.disconnect({ state: "unreachable" })).toEqual({ stillListed: true });
    await forgotten(desktop);

    // An address that now belongs to another node gets no token, even to revoke it.
    const moved = tailnet();
    moved.nodes.set(HUB_ADDRESS, OTHER);
    const elsewhere = fakeHub();
    const other = await connectedTo(elsewhere, moved.lookup);
    expect(await other.disconnect({ state: "otherNode" })).toEqual({ stillListed: true });
    expect(elsewhere.withSecrets()).toEqual([]);
    await forgotten(other);
  });

  // covers DP-001, DP-004
  it("[TC-DP-218] a keychain that cannot delete the token fails Disconnect before the hub revokes anything, so it can be asked again", async () => {
    const hub = fakeHub();
    const { lookup } = tailnet();
    const desktop = await connectedTo(hub, lookup);
    const connected = connectedHub({
      origins: ORIGINS,
      nodeId: STUDIO.nodeId,
      fallbackName: STUDIO.nodeName,
      nodeCheck: makeNodeCheck(lookup),
      token: desktop.token.read,
      fetch: hub.fetch,
    });
    const attempt = (token: Pick<typeof desktop.token, "read" | "remove">) =>
      disconnectFromHub({
        connection: CONNECTION,
        state: () => ({ state: "connected", version: "0.5.0" }),
        hub: connected,
        token,
        clearCookies: async () => void desktop.cookies.cleared++,
        settings: desktop.settings,
      });
    const stuck = { read: desktop.token.read, remove: async () => Promise.reject(new Error("The keychain is locked")) };

    // The hub is reachable, yet nothing was sent to it: it still knows this Mac, whose pages keep working.
    await expect(attempt(stuck)).rejects.toThrow("The keychain is locked");
    expect(hub.withSecrets()).toEqual([]);
    expect(await desktop.token.read()).toBe("hbd_token");
    expect(desktop.cookies.cleared).toBe(0);
    expect(desktopMode(desktop.settings.read())).toEqual({ mode: "connected", connection: CONNECTION });

    // Asked again with the keychain working, it finishes, and the hub revokes the token it held.
    expect(await attempt(desktop.token)).toEqual({ stillListed: false });
    expect(hub.withSecrets()).toMatchObject([{ path: "/api/devices/dev1/revoke", authorization: "Bearer hbd_token" }]);
    await forgotten(desktop);
  });
});
