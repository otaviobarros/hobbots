import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Layer, Ref, Result } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";
import { findHubs, judgeHubHealth, resolveHubAddress } from "../src/hub-discovery.ts";
import { type FakeTailnet, fakeTailnetFetch, readStatus, Tailscale, TailscaleFake } from "../src/tailscale.ts";

const you = { _tag: "User", login: "you@example.com" } as const;

describe("findHubs", () => {
  const servers: Array<Server> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });

  /** A program on a fake node's port that answers health with `body`, and remembers each request. */
  const listen = async (body: unknown, status = 200) => {
    const asked: Array<string> = [];
    const server = createServer((request, response) => {
      asked.push(`${request.headers.host}${request.url}`);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return { reach: `127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
  };

  /** A port nothing listens on: a computer on the tailnet with no Hobbots running. */
  const closedPort = async () => {
    const { reach } = await listen({});
    await new Promise((done) => servers.pop()?.close(done));
    return reach;
  };

  const hub = (name: string, connect?: number) => ({
    app: "hobbots",
    name,
    version: "0.4.0",
    ...(connect === undefined ? {} : { connect }),
  });

  // covers DP-002, DP-004
  it("[TC-DP-163] lists both hubs on a fake tailnet by their Tailscale names, asks only the user's own online computers, and changes nothing in Tailscale", async () => {
    const studio = await listen(hub("Studio", 1));
    const attic = await listen(hub("Attic", 1));
    const older = await listen(hub("Old desk"));
    const printer = await listen("<html>printer</html>");
    const tagged = await listen(hub("Tagged server", 1));
    const someoneElse = await listen(hub("Their hub", 1));
    const asleep = await listen(hub("Asleep", 1));
    const nothing = await closedPort();

    const node = (
      nodeId: string,
      nodeName: string,
      reach: string,
      extra: Partial<FakeTailnet["peers"][string]> = {},
    ) => ({
      nodeId,
      nodeName,
      owner: you,
      reach,
      ...extra,
    });
    const start: FakeTailnet = {
      state: "running",
      dnsName: "laptop.example.ts.net",
      addresses: ["127.0.0.2"],
      self: { nodeId: "nLAPTOP", nodeName: "laptop.example.ts.net", owner: you },
      peers: {
        "127.0.0.11": node("nSTUDIO", "studio.example.ts.net", studio.reach),
        "127.0.0.12": node("nATTIC", "attic.example.ts.net", attic.reach),
        "127.0.0.13": node("nOLD", "old-desk.example.ts.net", older.reach),
        "127.0.0.14": node("nPRINTER", "printer.example.ts.net", printer.reach),
        "127.0.0.15": node("nIDLE", "idle.example.ts.net", nothing),
        "127.0.0.16": node("nTAGGED", "server.example.ts.net", tagged.reach, {
          owner: { _tag: "Tagged", tags: ["tag:server"] },
        }),
        "127.0.0.17": node("nTHEIRS", "theirs.example.ts.net", someoneElse.reach, {
          owner: { _tag: "User", login: "someone@example.com" },
        }),
        "127.0.0.18": node("nASLEEP", "asleep.example.ts.net", asleep.reach, { online: false }),
      },
      ranges: ["127.0.0.0/8"],
    };
    const tailnet = Ref.makeUnsafe(start);
    let current = start;
    let served = 0;
    // The fake Tailscale, counting every call that could change Tailscale's settings.
    const tailscale = Layer.effect(
      Tailscale,
      Effect.gen(function* () {
        const inner = yield* Tailscale;
        return Tailscale.of({
          ...inner,
          serve: (args) =>
            Effect.andThen(
              Effect.sync(() => served++),
              inner.serve(args),
            ),
        });
      }),
    ).pipe(Layer.provide(TailscaleFake(tailnet)));
    // Tailscale's DNS stands in for the fake tailnet; record what the app asked for before it.
    const requested: Array<string> = [];
    const reachTailnet = fakeTailnetFetch(() => current);
    const recordingFetch: typeof fetch = (input, init) => {
      requested.push(new Request(input, init).url);
      return reachTailnet(input, init);
    };
    const http = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, recordingFetch)));

    const scan = await Effect.runPromise(findHubs.pipe(Effect.provide(Layer.mergeAll(tailscale, http))));
    current = Ref.getUnsafe(tailnet);

    expect(scan._tag).toBe("Scanned");
    const hubs = scan._tag === "Scanned" ? scan.hubs : [];
    expect(hubs.map(({ node: { nodeName }, origin, name, support }) => ({ nodeName, origin, name, support }))).toEqual([
      {
        nodeName: "attic.example.ts.net",
        origin: "http://attic.example.ts.net:4317",
        name: "Attic",
        support: "supported",
      },
      // A hub from before the connect protocol is listed with the reason, not offered.
      {
        nodeName: "old-desk.example.ts.net",
        origin: "http://old-desk.example.ts.net:4317",
        name: "Old desk",
        support: "hubOlder",
      },
      {
        nodeName: "studio.example.ts.net",
        origin: "http://studio.example.ts.net:4317",
        name: "Studio",
        support: "supported",
      },
    ]);
    // Each of the user's own online computers is asked once, by its MagicDNS name on the default port.
    expect(requested.sort()).toEqual(
      ["studio", "attic", "old-desk", "printer", "idle"]
        .map((name) => `http://${name}.example.ts.net:4317/api/health`)
        .sort(),
    );
    expect([studio, attic, older, printer].map(({ asked }) => asked.length)).toEqual([1, 1, 1, 1]);
    // Tagged nodes, other users' nodes and offline nodes are never asked.
    expect([...tagged.asked, ...someoneElse.asked, ...asleep.asked]).toEqual([]);
    // Only read: Tailscale is as it was.
    expect(served).toBe(0);
    expect(current).toEqual(start);
  });

  /** A tailnet of `count` of the user's own computers, each reached only through `fetch`. */
  const ownComputers = (count: number): FakeTailnet => ({
    state: "running",
    dnsName: "laptop.example.ts.net",
    addresses: ["127.0.0.2"],
    self: { nodeId: "nLAPTOP", nodeName: "laptop.example.ts.net", owner: you },
    peers: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `127.0.1.${i + 1}`,
        { nodeId: `nPEER${i}`, nodeName: `peer-${i}.example.ts.net`, owner: you },
      ]),
    ),
    ranges: ["127.0.0.0/8"],
  });
  const scanWith = (tailnet: FakeTailnet, fetch: typeof globalThis.fetch) =>
    Effect.runPromise(
      findHubs.pipe(
        Effect.provide(
          Layer.mergeAll(
            TailscaleFake(Ref.makeUnsafe(tailnet)),
            FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
          ),
        ),
      ),
    );

  it("asks at most eight computers at once", async () => {
    let inFlight = 0;
    let most = 0;
    const slow: typeof fetch = async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((done) => setTimeout(done, 20));
      inFlight--;
      return Response.json({ app: "hobbots", version: "0.4.0", connect: 1 });
    };
    const scan = await scanWith(ownComputers(20), slow);
    expect(scan._tag === "Scanned" && scan.hubs.length).toBe(20);
    expect(most).toBe(8);
  });

  it("gives up on a computer that does not answer within two seconds", async () => {
    const started = Date.now();
    const silent: typeof fetch = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    expect(await scanWith(ownComputers(3), silent)).toEqual({ _tag: "Scanned", hubs: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - started).toBeLessThan(3500);
  });

  it("says why it cannot look when Tailscale is not running here", async () => {
    const tailnet = Ref.makeUnsafe<FakeTailnet>({
      state: "signedOut",
      dnsName: null,
      addresses: [],
      peers: {},
      ranges: [],
    });
    const scan = await Effect.runPromise(
      findHubs.pipe(Effect.provide(Layer.mergeAll(TailscaleFake(tailnet), FetchHttpClient.layer))),
    );
    expect(scan).toEqual({ _tag: "TailscaleNotReady", state: "signedOut" });
  });
});

describe("judgeHubHealth", () => {
  it("reads a hub's answer and which side needs an update, and anything else as not Hobbots", () => {
    const answer = (connect?: number) => ({ app: "hobbots", name: "Studio", version: "0.4.0", connect });
    expect(judgeHubHealth(answer(1))).toEqual({
      _tag: "Hub",
      name: "Studio",
      version: "0.4.0",
      connect: 1,
      support: "supported",
    });
    expect(judgeHubHealth({ app: "hobbots", version: "0.3.0" })).toMatchObject({ connect: 0, support: "hubOlder" });
    expect(judgeHubHealth(answer(2))).toMatchObject({ support: "appOlder" });
    expect(judgeHubHealth(answer(2), { min: 1, max: 2 })).toMatchObject({ support: "supported" });
    expect(judgeHubHealth({ app: "other", version: "1" })).toEqual({ _tag: "NotHobbots" });
    expect(judgeHubHealth("ok")).toEqual({ _tag: "NotHobbots" });
  });
});

describe("resolveHubAddress", () => {
  // Shaped like `tailscale status --json` on the laptop that wants to connect.
  const snapshot = readStatus(
    JSON.stringify({
      BackendState: "Running",
      Self: {
        ID: "nLAPTOP",
        DNSName: "laptop.example.ts.net.",
        TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
        UserID: 1,
      },
      User: { "1": { LoginName: "you@example.com" }, "2": { LoginName: "someone@example.com" } },
      Peer: {
        "nodekey:a": {
          ID: "nSTUDIO",
          DNSName: "studio.example.ts.net.",
          TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"],
          Online: true,
          UserID: 1,
        },
        "nodekey:b": {
          ID: "nTHEIRS",
          DNSName: "theirs.example.ts.net.",
          TailscaleIPs: ["100.64.0.3"],
          Online: true,
          UserID: 2,
        },
        "nodekey:c": {
          ID: "nTAGGED",
          DNSName: "server.example.ts.net.",
          TailscaleIPs: ["100.64.0.4"],
          Online: true,
          UserID: 1,
          Tags: ["tag:server"],
        },
      },
    }),
  );
  const resolve = (typed: string) => {
    const result = resolveHubAddress(typed, snapshot);
    return Result.isSuccess(result)
      ? { origin: result.success.origin, nodeId: result.success.node.nodeId }
      : result.failure._tag;
  };
  const studio = (origin: string) => ({ origin, nodeId: "nSTUDIO" });

  // covers DP-002, DP-004
  it("[TC-DP-164] resolves a short or full name, a port, an HTTPS address or a tailnet address, and refuses anything off the user's tailnet before a request", () => {
    expect(resolve("studio")).toEqual(studio("http://studio.example.ts.net:4317"));
    expect(resolve("  Studio.example.ts.net.  ")).toEqual(studio("http://studio.example.ts.net:4317"));
    expect(resolve("studio:5000")).toEqual(studio("http://studio.example.ts.net:5000"));
    expect(resolve("http://studio.example.ts.net:4317/")).toEqual(studio("http://studio.example.ts.net:4317"));
    expect(resolve("https://studio")).toEqual(studio("https://studio.example.ts.net"));
    expect(resolve("https://studio.example.ts.net:443")).toEqual(studio("https://studio.example.ts.net"));
    // A tailnet address gets its node's MagicDNS name, so the address and its cookies are the same.
    expect(resolve("100.64.0.2")).toEqual(studio("http://studio.example.ts.net:4317"));
    expect(resolve("100.64.0.2:4400")).toEqual(studio("http://studio.example.ts.net:4400"));
    expect(resolve("fd7a:115c:a1e0::2")).toEqual(studio("http://studio.example.ts.net:4317"));
    expect(resolve("[fd7a:115c:a1e0::2]:4317")).toEqual(studio("http://studio.example.ts.net:4317"));

    // Loopback, local network and public addresses are refused before any request.
    for (const typed of ["localhost", "localhost:4317", "127.0.0.1", "http://[::1]:4317", "0.0.0.0"]) {
      expect(resolve(typed)).toBe("Loopback");
    }
    for (const typed of ["192.168.1.20", "10.0.0.5:4317", "172.16.4.1", "169.254.1.1", "fe80::1", "fd00::5"]) {
      expect(resolve(typed)).toBe("LocalNetwork");
    }
    for (const typed of ["8.8.8.8", "https://1.1.1.1", "2001:4860:4860::8888"]) {
      expect(resolve(typed)).toBe("Public");
    }
    // Names and tailnet addresses Tailscale does not know, including public names.
    for (const typed of ["attic", "attic.example.ts.net", "example.com", "100.64.0.99"]) {
      expect(resolve(typed)).toBe("NotOnTailnet");
    }
    // Not the user's own computer: another user's node, a tagged node, or this computer itself.
    expect(resolve("theirs")).toBe("NotYours");
    expect(resolve("100.64.0.4")).toBe("NotYours");
    expect(resolve("laptop")).toBe("ThisComputer");
    expect(resolve("100.64.0.1")).toBe("ThisComputer");
    // What is not an address at all.
    for (const typed of [
      "",
      "   ",
      "ftp://studio",
      "studio/api",
      "user@studio",
      "studio:80",
      "studio:99999",
      "http://",
    ]) {
      expect(resolve(typed)).toMatch(/^(Empty|Malformed)$/);
    }
  });

  it("checks nothing against the tailnet while Tailscale is not running here", () => {
    const off = readStatus(JSON.stringify({ BackendState: "Stopped" }));
    expect(resolveHubAddress("studio", off)).toEqual(Result.fail({ _tag: "TailscaleNotReady", state: "notRunning" }));
    // An address that could never be a peer is refused for that reason first.
    expect(resolveHubAddress("127.0.0.1", off)).toEqual(Result.fail({ _tag: "Loopback" }));
  });
});
