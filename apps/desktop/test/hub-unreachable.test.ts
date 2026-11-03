import { CONNECT_PROTOCOL } from "@hobbots/api";
import type { TailnetSnapshot } from "@hobbots/server/tailscale";
import { describe, expect, it } from "vitest";
import { connectionStateOf } from "../src/main/connection-state.ts";
import {
  connectedHub,
  type HubNodeState,
  type HubOrigins,
  hubNodeState,
  hubOrigins,
  makeNodeCheck,
  type TailnetNode,
} from "../src/main/hub-connection.ts";
import { checkNewAddress, followedAddress } from "../src/main/hub-move.ts";

// A connected desktop whose hub goes away and comes back (ADR 025, #448): why it cannot be reached,
// trying again with the same token, and following the hub to another port of the same computer.

const HUB_ADDRESS = "100.64.0.7";
const ME = { _tag: "User", login: "you@example.com" } as const;
const STUDIO: TailnetNode = { nodeId: "nSTUDIO", nodeName: "studio.example.ts.net", owner: ME };
const OTHER: TailnetNode = { nodeId: "nOTHER", nodeName: "other.example.ts.net", owner: ME };
const ORIGINS = hubOrigins("http://studio.example.ts.net:4317") as HubOrigins;
const HEALTH = { app: "hobbots", name: "Studio", version: "0.5.0", connect: CONNECT_PROTOCOL };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A hub that can be stopped and started again, on the ports given; it counts pairing requests. */
const switchableHub = (ports: ReadonlyArray<number> = [4317]) => {
  let running = true;
  const paths: Array<string> = [];
  const fetch = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    if (!running || !ports.includes(Number(parsed.port))) throw new TypeError("fetch failed");
    paths.push(parsed.pathname);
    if (parsed.pathname === "/api/health") return json(HEALTH);
    if (parsed.pathname === "/api/activity") return json({ working: [] });
    return json({}, 404);
  }) as typeof globalThis.fetch;
  return {
    fetch,
    paths,
    stop: () => {
      running = false;
    },
    start: () => {
      running = true;
    },
  };
};

/** This computer's Tailscale, which the test turns off, and whose view of the hub's node it changes. */
const thisTailnet = () => {
  const tailnet = { running: true, online: true, node: STUDIO };
  const nodeState = async (nodeId: string): Promise<HubNodeState> =>
    hubNodeState(
      {
        status: { state: tailnet.running ? "running" : "notRunning" },
        nodes: [{ nodeId: tailnet.node.nodeId, online: tailnet.online }],
      },
      nodeId,
    );
  const lookup = {
    resolve: async () => (tailnet.running ? [HUB_ADDRESS] : []),
    whois: async () => (tailnet.running ? tailnet.node : null),
  };
  return { tailnet, nodeState, lookup };
};

/** The connection as connected-mode.ts runs it, with the keychain as a variable. */
const connection = (hub: ReturnType<typeof switchableHub>, here: ReturnType<typeof thisTailnet>) => {
  let token: string | undefined = "hbd_token";
  const nodeCheck = makeNodeCheck(here.lookup);
  const connected = connectedHub({
    origins: ORIGINS,
    nodeId: STUDIO.nodeId,
    fallbackName: STUDIO.nodeName,
    nodeCheck,
    nodeState: here.nodeState,
    token: async () => token,
    fetch: hub.fetch,
  });
  const state = connectionStateOf({
    hub: () => connected,
    forgetNode: nodeCheck.forget,
    forgetToken: async () => {
      token = undefined;
    },
  });
  return { state, token: () => token };
};

describe("a hub that is off or cannot be reached", () => {
  // covers DP-001, DP-002
  it("[TC-DP-170] says the hub is off, and reconnects with the same token once it starts again", async () => {
    const hub = switchableHub();
    const here = thisTailnet();
    const { state, token } = connection(hub, here);
    await state.check();
    expect(state.current).toEqual({ state: "connected", version: "0.5.0" });
    expect(state.retries).toBe(false);

    // The hub stops: the lost stream checks again, and the hub's computer is online but nothing answers.
    hub.stop();
    await state.check();
    expect(state.current).toEqual({ state: "unreachable" });
    // Trying again leaves it as it is while the hub stays off, and keeps the token.
    expect(state.retries).toBe(true);
    await state.check();
    expect(state.current).toEqual({ state: "unreachable" });

    // The hub starts again: the next try connects, with the same token and no new pairing.
    hub.start();
    await state.check();
    expect(state.current).toEqual({ state: "connected", version: "0.5.0" });
    expect(token()).toBe("hbd_token");
    expect(hub.paths.filter((path) => path.startsWith("/api/pairing"))).toEqual([]);
  });

  // covers DP-001
  it("[TC-DP-169] tells Tailscale off here from the hub's computer offline, and finds each one back at once", async () => {
    const hub = switchableHub();
    const here = thisTailnet();
    const { state } = connection(hub, here);
    await state.check();
    expect(state.current.state).toBe("connected");
    const changes: Array<string> = [];
    state.onChange((next) => void changes.push(next.state));

    // Tailscale stops on this Mac: no address can be checked, and nothing is sent to the hub.
    here.tailnet.running = false;
    const sent = hub.paths.length;
    hub.stop();
    await state.check();
    expect(state.current).toEqual({ state: "tailscaleOff" });
    hub.start();
    // It comes back: the answer about the hub's node that Tailscale could not give is not kept.
    here.tailnet.running = true;
    await state.check();
    expect(state.current.state).toBe("connected");

    // The hub's computer goes offline on the tailnet, as when it sleeps or its own Tailscale is off.
    here.tailnet.online = false;
    hub.stop();
    await state.check();
    expect(state.current).toEqual({ state: "hubOffline" });
    here.tailnet.online = true;
    hub.start();
    await state.check();
    expect(state.current.state).toBe("connected");
    expect(changes).toEqual(["tailscaleOff", "connected", "hubOffline", "connected"]);
    expect(hub.paths.length).toBeGreaterThan(sent);

    // A node Tailscale no longer lists counts as offline too.
    expect(hubNodeState({ status: { state: "running" }, nodes: [] }, STUDIO.nodeId)).toBe("offline");
  });

  // covers DP-001
  it("[TC-DP-169] keeps a device the hub refused waiting for the user, and stops trying", async () => {
    const hub = switchableHub();
    const here = thisTailnet();
    const revoking = {
      ...hub,
      fetch: (async (url: string | URL | Request, init?: RequestInit) =>
        new URL(String(url)).pathname === "/api/activity"
          ? json({ _tag: "DeviceRevoked", message: "Removed" }, 401)
          : hub.fetch(url, init)) as typeof globalThis.fetch,
    };
    const { state, token } = connection(revoking, here);
    await state.check();
    await state.check();
    expect(state.current).toEqual({ state: "revoked" });
    expect(token()).toBeUndefined();
    expect(state.retries).toBe(false);
  });
});

/** This Mac's view of the tailnet: the hub's computer and another of the user's computers. */
const snapshot = (running = true): TailnetSnapshot => ({
  status: running
    ? { state: "running", dnsName: "air.example.ts.net", addresses: ["100.64.0.9"] }
    : { state: "notRunning", dnsName: null, addresses: [] },
  peers: new Set([HUB_ADDRESS, "100.64.0.8"]),
  self: { nodeId: "nAIR", nodeName: "air.example.ts.net", owner: ME },
  nodes: [
    { ...STUDIO, addresses: [HUB_ADDRESS], online: true },
    { ...OTHER, addresses: ["100.64.0.8"], online: true },
  ],
});

const remoteAccess = (port: number, servesHttps: boolean | null = false) =>
  ({ _tag: "RemoteAccess", port, enabled: true, paused: false, servesHttps }) as const;

describe("a hub that moved to another address", () => {
  // covers DP-001
  it("[TC-DP-171] follows a port changed while connected, and an HTTPS address that stops answering", () => {
    expect(followedAddress(ORIGINS.origin, remoteAccess(4400))).toBe("http://studio.example.ts.net:4400");
    expect(followedAddress(ORIGINS.origin, remoteAccess(4317))).toBeNull();
    // An HTTPS address does not change with the port, and falls back to HTTP when HTTPS turns off.
    expect(followedAddress("https://studio.example.ts.net", remoteAccess(4400, true))).toBeNull();
    expect(followedAddress("https://studio.example.ts.net", remoteAccess(4400, null))).toBeNull();
    expect(followedAddress("https://studio.example.ts.net", remoteAccess(4400, false))).toBe(
      "http://studio.example.ts.net:4400",
    );
  });

  // covers DP-001, DP-004
  it("[TC-DP-171] takes a typed address on the same computer, and refuses another computer or a port nothing answers on", async () => {
    const hub = switchableHub([4400]);
    const check = (typed: string, tailnet = snapshot()) =>
      checkNewAddress({ typed, nodeId: STUDIO.nodeId, nodeName: STUDIO.nodeName, snapshot: tailnet, fetch: hub.fetch });

    // A short name with the new port, or the tailnet address, is the same computer: no new approval.
    expect(await check("studio:4400")).toEqual({ _tag: "Moved", address: "http://studio.example.ts.net:4400" });
    expect(await check(`${HUB_ADDRESS}:4400`)).toEqual({ _tag: "Moved", address: "http://studio.example.ts.net:4400" });
    // Another of the user's computers never allowed this device: nothing is sent to it.
    const sent = hub.paths.length;
    expect(await check("other:4400")).toEqual({
      _tag: "Refused",
      message: "other.example.ts.net is a different computer. To use the hub there, disconnect first.",
    });
    expect(hub.paths.length).toBe(sent);
    expect(await check("studio:4500")).toEqual({
      _tag: "Refused",
      message: "Nothing answers at http://studio.example.ts.net:4500. Check the port on the hub.",
    });
    expect((await check("192.168.1.4:4400"))._tag).toBe("Refused");
    expect(await check("studio:4400", snapshot(false))).toEqual({
      _tag: "Refused",
      message: "Tailscale is off on this Mac. Turn it on, then try again.",
    });
  });
});
