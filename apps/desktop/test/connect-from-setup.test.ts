import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectEnd, WaitingView } from "@hobbots/api";
import { CONNECT_PROTOCOL } from "@hobbots/api";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { chooseMode, startMode } from "../src/main/app-mode.ts";
import { connectToHub, listHubs } from "../src/main/connect-flow.ts";
import { isLocalPage, LOCAL_ORIGIN, localFile } from "../src/main/local-pages.ts";
import { fileSettingsStore, type HubConnection } from "../src/main/settings.ts";
import { handleSetupIpc, setupChannels } from "../src/main/setup-ipc.ts";
import { thisComputer } from "../src/main/tailnet.ts";

// Setup's first screen on a computer that is not a hub yet (ADR 025, #446): how the app starts, the
// local pages it serves, and Connect against fake hubs with this computer's Tailscale and keychain
// faked. The Electron wiring around them is in src/main/setup-mode.ts.

const temp = mkdtempSync(join(tmpdir(), "hobbots-setup-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

const you = { _tag: "User", login: "you@example.com" } as const;

/**
 * This computer's fake tailnet: it is `laptop`; `studio` and `attic` are the user's own computers,
 * `shared` belongs to someone else and `printer` is tagged.
 */
const TAILNET = {
  state: "running",
  dnsName: "laptop.example.ts.net",
  addresses: ["100.64.0.3"],
  self: { nodeId: "nLAPTOP", nodeName: "laptop.example.ts.net", owner: you },
  peers: {
    "100.64.0.7": { nodeId: "nSTUDIO", nodeName: "studio.example.ts.net", owner: you },
    "100.64.0.8": { nodeId: "nATTIC", nodeName: "attic.example.ts.net", owner: you },
    "100.64.0.9": {
      nodeId: "nSHARED",
      nodeName: "shared.example.ts.net",
      owner: { _tag: "User", login: "friend@example.com" },
    },
    "100.64.0.10": {
      nodeId: "nPRINTER",
      nodeName: "printer.example.ts.net",
      owner: { _tag: "Tagged", tags: ["tag:printer"] },
    },
  },
  ranges: ["100.64.0.0/10"],
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Answer = "pending" | "allowed" | "denied" | "expired";

/**
 * The computers on the fake tailnet: `studio` runs a hub, which answers pairing as the user decides on
 * it; `attic` answers something that is not Hobbots; nothing else answers. Every request is recorded.
 */
const fakeNetwork = (options: { decide?: Answer; opened?: () => Response } = {}) => {
  const asked: Array<string> = [];
  let answer: Answer = "pending";
  const status = { id: "p1", code: "042317", expiresAt: "2026-11-03T02:00:00.000Z" };
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    asked.push(`${request.method} ${url.host}${url.pathname}`);
    if (url.hostname === "attic.example.ts.net") return new Response("<html>a printer</html>", { status: 200 });
    if (url.host !== "studio.example.ts.net:4317") throw new TypeError("fetch failed");
    switch (`${request.method} ${url.pathname}`) {
      case "GET /api/health":
        return json({ app: "hobbots", name: "Studio", version: "0.5.0", connect: CONNECT_PROTOCOL });
      case "POST /api/pairing":
        return options.opened?.() ?? json({ status: { ...status, state: "pending" }, secret: "hbp_secret" });
      case "GET /api/pairing":
        return json(
          answer === "allowed"
            ? { ...status, state: "allowed", token: "hbd_token", deviceId: "dev1" }
            : { ...status, state: answer },
        );
      default:
        return json({}, 404);
    }
  }) as typeof globalThis.fetch;
  return {
    fetch,
    asked,
    /** The user answers on the hub once the app has asked where the request stands. */
    sleep: async () => {
      answer = options.decide ?? "allowed";
    },
  };
};

/** This computer, with the fake tailnet above, an in-memory keychain and `network` in place of the real one. */
const computer = (network: ReturnType<typeof fakeNetwork>, tailnet: unknown = TAILNET) => {
  const dataDir = mkdtempSync(join(temp, "data-"));
  writeFileSync(join(dataDir, "fake-tailscale.json"), JSON.stringify(tailnet));
  const made = thisComputer({
    dataDir,
    env: { HOBBOTS_FAKE_KEYCHAIN: "memory", HOBBOTS_FAKE_TAILSCALE: "on" },
    platform: process.platform,
    fetch: network.fetch,
  });
  stops.push(() => made.dispose());
  return made;
};

/** Connects to `typed` as setup does, recording the waiting screen and the connection kept after Allow. */
const connect = async (
  typed: string,
  network: ReturnType<typeof fakeNetwork>,
  made = computer(network),
  signal = new AbortController().signal,
) => {
  const waiting: Array<WaitingView> = [];
  const kept: Array<HubConnection> = [];
  const end: ConnectEnd = await connectToHub(typed, {
    tailnet: made.tailnet,
    fetch: network.fetch,
    keepToken: made.token.write,
    forgetToken: made.token.remove,
    onWaiting: (shown) => void waiting.push(shown),
    onAllowed: async (connection) => void kept.push(connection),
    signal,
    device: { name: "Hobbots on laptop", platform: "macOS" },
    intervalMs: 1,
    sleep: network.sleep,
  });
  return { end, waiting, kept, token: made.token };
};

describe("setup's first screen", () => {
  // covers DP-001
  it("[TC-DP-156] a new installation starts setup with no server; an installation ID or Run here makes it the hub; Disconnect returns to Where", () => {
    const dataDir = mkdtempSync(join(temp, "start-"));
    const fresh = fileSettingsStore(join(dataDir, "desktop-settings.json"));
    // Nothing chosen and no installation: setup's local pages, and nothing is written yet.
    expect(startMode(fresh, { installationId: undefined })).toEqual({ start: "setup", page: "welcome" });
    expect(readdirSync(dataDir)).toEqual([]);
    // A computer that left its hub with Disconnect opens at Where Hobbots runs, never as a hub, until
    // it chooses; the choice forgets that it left.
    const left = fileSettingsStore(join(dataDir, "left.json"));
    left.update({ openAtLogin: true, leftHub: true });
    expect(startMode(left, { installationId: undefined })).toEqual({ start: "setup", page: "where" });
    chooseMode(left, { mode: "hub" });
    expect(left.read()).toEqual({ openAtLogin: true, mode: "hub" });
    expect(startMode(left, { installationId: undefined })).toEqual({ start: "hub" });
    // An existing hub starts as a hub without asking, and says so in its settings.
    const existing = fileSettingsStore(join(dataDir, "existing.json"));
    expect(startMode(existing, { installationId: "id" })).toEqual({ start: "hub" });
    expect(existing.read().mode).toBe("hub");
    // A script that tests the hub on a new data folder starts it as Run here does.
    const scripted = fileSettingsStore(join(dataDir, "scripted.json"));
    expect(startMode(scripted, { installationId: undefined, asHub: true })).toEqual({ start: "hub" });
    expect(scripted.read().mode).toBe("hub");
    // Run here wrote the mode: every later start is the hub's, with no setup.
    expect(startMode(scripted, { installationId: "id" })).toEqual({ start: "hub" });
  });

  // covers DP-001
  it("[TC-DP-200] serves the local pages only from the web client's build, and trusts only them", () => {
    const root = "/app/web";
    expect(localFile(root, `${LOCAL_ORIGIN}/`)).toBe("/app/web/local.html");
    expect(localFile(root, `${LOCAL_ORIGIN}/connect`)).toBe("/app/web/local.html");
    expect(localFile(root, `${LOCAL_ORIGIN}/assets/local-1.js`)).toBe("/app/web/assets/local-1.js");
    // Nothing outside the build, however it is spelled, and nothing for another host.
    expect(localFile(root, `${LOCAL_ORIGIN}/../../etc/passwd.txt`)).toBe("/app/web/etc/passwd.txt");
    expect(localFile(root, `${LOCAL_ORIGIN}/assets/..%2F..%2F..%2Fetc%2Fpasswd.txt`)).toBeNull();
    expect(localFile(root, `${LOCAL_ORIGIN}/%E0%A4%A.js`)).toBeNull();
    expect(localFile(root, "hobbots://elsewhere/local.html")).toBeNull();
    expect(localFile(root, "https://app/local.html")).toBeNull();
    // The bridge answers the local pages, and the Vite dev server's local entry only in development.
    expect(isLocalPage(`${LOCAL_ORIGIN}/`, null)).toBe(true);
    expect(isLocalPage("http://127.0.0.1:5173/local.html", null)).toBe(false);
    expect(isLocalPage("http://127.0.0.1:5173/local.html", "http://127.0.0.1:5173")).toBe(true);
    expect(isLocalPage("http://127.0.0.1:5173/", "http://127.0.0.1:5173")).toBe(false);
    expect(isLocalPage("http://studio.example.ts.net:4317/", null)).toBe(false);
  });

  // covers DP-001, DP-002
  it("[TC-DP-165] finds the user's hubs by Tailscale name, waits with the hub's code and keeps the connection after Allow", async () => {
    const network = fakeNetwork();
    const made = computer(network);
    // Only the user's own computers are asked, and only a Hobbots answer is listed.
    expect(await listHubs(made.tailnet)).toEqual({
      kind: "hubs",
      hubs: [
        {
          computer: "studio",
          address: "http://studio.example.ts.net:4317",
          hubName: "Studio",
          version: "0.5.0",
          support: "supported",
        },
      ],
    });
    expect(network.asked.filter((request) => /shared|printer/.test(request))).toEqual([]);

    // The short name the user typed resolves to the computer's MagicDNS name.
    const { end, waiting, kept, token } = await connect("studio", network, made);
    expect(waiting).toEqual([
      {
        computer: "studio",
        owner: "you@example.com",
        hubName: "Studio",
        code: "042317",
        expiresAt: "2026-11-03T02:00:00.000Z",
      },
    ]);
    expect(end).toEqual({ kind: "allowed", computer: "studio" });
    expect(kept).toEqual([
      {
        address: "http://studio.example.ts.net:4317",
        name: "Studio",
        nodeId: "nSTUDIO",
        nodeName: "studio.example.ts.net",
        deviceId: "dev1",
      },
    ]);
    expect(await token.read()).toBe("hbd_token");
  });

  // covers DP-001, DP-002
  it("[TC-DP-166] Deny, an expired or throttled request, an unreachable hub and something that is not Hobbots each say why", async () => {
    const ended = async (typed: string, network: ReturnType<typeof fakeNetwork>) => {
      const { end, kept, token } = await connect(typed, network);
      // Nothing is kept unless the hub allowed this computer.
      expect(kept).toEqual([]);
      expect(await token.read()).toBeUndefined();
      return end;
    };
    const at = { computer: "studio", address: "http://studio.example.ts.net:4317" };
    expect(await ended("studio", fakeNetwork({ decide: "denied" }))).toEqual({
      kind: "ended",
      ...at,
      outcome: { kind: "denied" },
    });
    expect(await ended("http://studio:4317", fakeNetwork({ decide: "expired" }))).toEqual({
      kind: "ended",
      ...at,
      outcome: { kind: "expired" },
    });
    const throttled = fakeNetwork({ opened: () => json({ _tag: "PairingThrottled" }, 429, { "retry-after": "42" }) });
    expect(await ended("studio", throttled)).toEqual({
      kind: "ended",
      ...at,
      outcome: { kind: "throttled", retryAfterSeconds: 42 },
    });
    // On another port nothing answers.
    expect(await ended("studio:4400", fakeNetwork())).toEqual({
      kind: "ended",
      computer: "studio",
      address: "http://studio.example.ts.net:4400",
      outcome: { kind: "noAnswer" },
    });
    expect(await ended("attic", fakeNetwork())).toMatchObject({ kind: "ended", outcome: { kind: "notHobbots" } });
  });

  // covers DP-002
  it("[TC-DP-201] refuses an address that is not one of the user's own computers before sending anything, and Cancel stops waiting", async () => {
    const refused = async (typed: string) => {
      const network = fakeNetwork();
      const { end } = await connect(typed, network);
      expect(network.asked).toEqual([]);
      return end.kind === "refused" ? end.refusal : end;
    };
    expect(await refused("192.168.1.20")).toEqual({ reason: "LocalNetwork" });
    expect(await refused("8.8.8.8")).toEqual({ reason: "Public" });
    expect(await refused("localhost:4317")).toEqual({ reason: "Loopback" });
    expect(await refused("cellar")).toEqual({ reason: "NotOnTailnet" });
    expect(await refused("laptop")).toEqual({ reason: "ThisComputer" });
    expect(await refused("shared")).toEqual({ reason: "NotYours", computer: "shared" });
    expect(await refused("printer")).toEqual({ reason: "NotYours", computer: "printer" });
    expect(await refused("  ")).toEqual({ reason: "Empty" });

    // With Tailscale off here, nothing can be checked: Connect says so, and lists nothing.
    const off = fakeNetwork();
    const offComputer = computer(off, { ...TAILNET, state: "notRunning" });
    expect(await listHubs(offComputer.tailnet)).toEqual({ kind: "tailscale", state: "notRunning" });
    expect((await connect("studio", off, offComputer)).end).toEqual({
      kind: "refused",
      refusal: { reason: "TailscaleNotReady", state: "notRunning" },
    });

    // Cancel while the hub has a prompt up: the request ends as cancelled and nothing is kept.
    const controller = new AbortController();
    const waiting = fakeNetwork({ decide: "pending" });
    const cancelled = await connect(
      "studio",
      { ...waiting, sleep: async () => controller.abort() },
      undefined,
      controller.signal,
    );
    expect(cancelled.end).toEqual({ kind: "cancelled" });
    expect(cancelled.waiting).toHaveLength(1);
    expect(cancelled.kept).toEqual([]);
  });

  // covers DP-001, DP-004
  it("[TC-DP-206] Cancel wins over an answer already on its way: nothing is kept and nothing connects", async () => {
    // Cancel while the hub's Allow is in flight: the answer arrives after Cancel and is dropped.
    const allowedLate = fakeNetwork({ decide: "allowed" });
    const late = new AbortController();
    const inFlight = await connect(
      "studio",
      {
        ...allowedLate,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const answer = await allowedLate.fetch(input, init);
          const request = new Request(input, init);
          if (request.method === "GET" && new URL(request.url).pathname === "/api/pairing") late.abort();
          return answer;
        }) as typeof fetch,
      },
      undefined,
      late.signal,
    );
    expect(inFlight.end).toEqual({ kind: "cancelled" });
    expect(inFlight.kept).toEqual([]);
    expect(await inFlight.token.read()).toBeUndefined();

    // Cancel while the keychain is keeping the token: the token is deleted again and nothing is chosen.
    const keeping = new AbortController();
    const network = fakeNetwork({ decide: "allowed" });
    const made = computer(network);
    const kept: Array<HubConnection> = [];
    const whileKeeping = await connectToHub("studio", {
      tailnet: made.tailnet,
      fetch: network.fetch,
      keepToken: async (token) => {
        await made.token.write(token);
        keeping.abort();
      },
      forgetToken: made.token.remove,
      onWaiting: () => {},
      onAllowed: async (connection) => void kept.push(connection),
      signal: keeping.signal,
      device: { name: "Hobbots on laptop", platform: "macOS" },
      intervalMs: 1,
      sleep: network.sleep,
    });
    expect(whileKeeping).toEqual({ kind: "cancelled" });
    expect(kept).toEqual([]);
    expect(await made.token.read()).toBeUndefined();

    // Back or Cancel while the first request is still opening stops that request: it ends as cancelled,
    // not as a hub that did not answer, and it never shows a code.
    const opening = new AbortController();
    const slow = fakeNetwork({
      decide: "allowed",
      opened: () => {
        opening.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });
    const stopped = await connect("studio", slow, undefined, opening.signal);
    expect(stopped.end).toEqual({ kind: "cancelled" });
    expect(stopped.waiting).toEqual([]);
    expect(stopped.kept).toEqual([]);
  });

  // covers DP-001
  it("[TC-DP-202] answers setup's calls only from the local pages, and takes nothing from them but the typed address", async () => {
    const handlers = new Map<string, (event: unknown, arg: unknown) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (event: unknown, arg: unknown) => unknown) =>
        void handlers.set(channel, handler),
      removeHandler: (channel: string) => void handlers.delete(channel),
    };
    const sentToPage: Array<unknown> = [];
    const typed: Array<string> = [];
    const page = (url: string) => ({
      senderFrame: { url },
      sender: { isDestroyed: () => false, send: (_channel: string, waiting: unknown) => void sentToPage.push(waiting) },
    });
    const stop = handleSetupIpc({
      ipcMain: ipcMain as never,
      isTrusted: (event) => isLocalPage(event.senderFrame?.url ?? "", null),
      setup: {
        runHere: async () => {},
        findHubs: async () => ({ kind: "hubs", hubs: [] }),
        connect: async (address, onWaiting) => {
          typed.push(address);
          onWaiting({ computer: "studio", owner: null, hubName: "Studio", code: "042317", expiresAt: "" });
          return { kind: "cancelled" };
        },
        cancel: () => {},
      },
    });
    const call = (channel: string, url: string, arg?: unknown) => handlers.get(channel)?.(page(url), arg);

    // A hub's page, or any other, gets nothing.
    const notAllowed = { refused: "notAllowed" };
    expect(await call(setupChannels.findHubs, "http://studio.example.ts.net:4317/")).toEqual(notAllowed);
    expect(await call(setupChannels.runHere, "https://example.com/")).toEqual(notAllowed);
    // The local pages connect with the typed text, and the waiting screen goes back to the page that asked.
    expect(await call(setupChannels.connect, `${LOCAL_ORIGIN}/`, "studio")).toEqual({ kind: "cancelled" });
    expect(typed).toEqual(["studio"]);
    expect(sentToPage).toEqual([{ computer: "studio", owner: null, hubName: "Studio", code: "042317", expiresAt: "" }]);
    // Text too long to be an address is refused in Connect's words; anything but text is malformed.
    expect(await call(setupChannels.connect, `${LOCAL_ORIGIN}/`, "x".repeat(301))).toEqual({
      kind: "refused",
      refusal: { reason: "Malformed" },
    });
    for (const odd of [{ host: "studio" }, 42]) {
      expect(await call(setupChannels.connect, `${LOCAL_ORIGIN}/`, odd)).toEqual({ refused: "malformed" });
    }
    expect(typed).toEqual(["studio"]);
    // Once this computer chose, setup stops answering.
    stop();
    expect([...handlers.keys()]).toEqual([]);
  });
});
