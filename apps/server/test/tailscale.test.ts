import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { remoteAccessStatus } from "../src/remote-access.ts";
import { addressRanges, forwardsTo, readServeStatus, readStatus, readWhoIs, TAILNET_RANGES } from "../src/tailscale.ts";

// Shaped like `tailscale status --json` (ipnstate.Status), trimmed to a few of its fields.
const runningStatus = JSON.stringify({
  Version: "1.90.0",
  BackendState: "Running",
  TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
  Self: {
    ID: "nHUB",
    HostName: "studio-desk",
    DNSName: "studio-desk.example.ts.net.",
    TailscaleIPs: ["fd7a:115c:a1e0::1", "100.101.102.103"],
    Online: true,
  },
  Peer: {
    "nodekey:abc": {
      ID: "nPHONE",
      DNSName: "phone.example.ts.net.",
      TailscaleIPs: ["100.80.1.2", "fd7a:115c:a1e0::2"],
    },
    "nodekey:def": { ID: "nLAPTOP", DNSName: "laptop.example.ts.net.", TailscaleIPs: null },
  },
  User: { "1": { ID: 1, LoginName: "you@example.com", DisplayName: "You" } },
  CurrentTailnet: { Name: "example.com", MagicDNSSuffix: "example.ts.net", MagicDNSEnabled: true },
});

describe("readStatus", () => {
  it("reads the hub's addresses, IPv4 first, its MagicDNS name without the dot, and its peers' addresses", () => {
    const { status, peers } = readStatus(runningStatus);
    expect(status).toEqual({
      state: "running",
      dnsName: "studio-desk.example.ts.net",
      addresses: ["100.101.102.103", "fd7a:115c:a1e0::1"],
    });
    expect([...peers]).toEqual(["100.80.1.2", "fd7a:115c:a1e0::2"]);
  });

  it("lists each peer with an owner as a node: its name, addresses, whether it is online and whose it is", () => {
    const status = JSON.parse(runningStatus);
    status.Self.UserID = 1;
    status.User["2"] = { ID: 2, LoginName: "tagged-devices" };
    status.Peer["nodekey:abc"] = { ...status.Peer["nodekey:abc"], Online: true, UserID: 1 };
    status.Peer["nodekey:def"] = { ...status.Peer["nodekey:def"], UserID: 2, Tags: ["tag:server"] };
    // A peer Tailscale names no owner for, or no MagicDNS name, is not listed.
    status.Peer["nodekey:ghi"] = { ID: "nGHOST", DNSName: "ghost.example.ts.net.", TailscaleIPs: ["100.80.1.9"] };
    status.Peer["nodekey:jkl"] = { ID: "nNONAME", DNSName: "", UserID: 1, TailscaleIPs: ["100.80.1.10"] };
    const { self, nodes } = readStatus(JSON.stringify(status));
    expect(self).toEqual({
      nodeId: "nHUB",
      nodeName: "studio-desk.example.ts.net",
      owner: { _tag: "User", login: "you@example.com" },
    });
    expect(nodes).toEqual([
      {
        nodeId: "nPHONE",
        nodeName: "phone.example.ts.net",
        owner: { _tag: "User", login: "you@example.com" },
        addresses: ["100.80.1.2", "fd7a:115c:a1e0::2"],
        online: true,
      },
      {
        nodeId: "nLAPTOP",
        nodeName: "laptop.example.ts.net",
        owner: { _tag: "Tagged", tags: ["tag:server"] },
        addresses: [],
        online: false,
      },
    ]);
  });

  it("uses the tailnet only while Tailscale is running", () => {
    const status = (BackendState: string) =>
      readStatus(JSON.stringify({ ...JSON.parse(runningStatus), BackendState })).status;
    expect(status("NeedsLogin")).toEqual({ state: "signedOut", dnsName: null, addresses: [] });
    expect(status("NeedsMachineAuth").state).toBe("signedOut");
    expect(status("Stopped").state).toBe("notRunning");
    expect(status("Starting").state).toBe("notRunning");
    expect(status("NoState").state).toBe("notRunning");
  });

  it("reads anything else, such as the error a stopped service prints, as not running", () => {
    expect(readStatus("failed to connect to local tailscaled; it doesn't appear to be running").status.state).toBe(
      "notRunning",
    );
    expect(readStatus("{}").status.state).toBe("notRunning");
    expect(readStatus(JSON.stringify({ BackendState: "Running", Self: null })).status).toEqual({
      state: "running",
      dnsName: null,
      addresses: [],
    });
  });
});

describe("readWhoIs", () => {
  // Shaped like `tailscale whois --json` (apitype.WhoIsResponse).
  const whois = (node: Record<string, unknown>, user: Record<string, unknown> | null) =>
    JSON.stringify({
      Node: { ID: 7, StableID: "nPHONE", Name: "phone.example.ts.net.", Addresses: ["100.80.1.2/32"], ...node },
      UserProfile: user,
      CapMap: {},
    });

  it("names the node and its owner's login", () => {
    expect(readWhoIs(whois({}, { ID: 1, LoginName: "you@example.com", DisplayName: "You" }))).toEqual(
      Option.some({
        nodeId: "nPHONE",
        nodeName: "phone.example.ts.net",
        owner: { _tag: "User", login: "you@example.com" },
      }),
    );
  });

  it("names a tagged node by its tags, not by the user Tailscale files it under", () => {
    const tagged = whois({ Tags: ["tag:server"] }, { ID: 2, LoginName: "tagged-devices", DisplayName: "Tagged" });
    expect(Option.getOrThrow(readWhoIs(tagged)).owner).toEqual({ _tag: "Tagged", tags: ["tag:server"] });
  });

  it("knows nobody from an answer it cannot read or one without an owner", () => {
    expect(readWhoIs("peer not found")).toEqual(Option.none());
    expect(readWhoIs(whois({}, null))).toEqual(Option.none());
    expect(readWhoIs(whois({ StableID: "" }, { ID: 1, LoginName: "you@example.com" }))).toEqual(Option.none());
  });
});

describe("readServeStatus", () => {
  // Shaped like `tailscale serve status --json` (ipn.ServeConfig) after `tailscale serve --bg http://127.0.0.1:4318`.
  const serving = JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: { "studio-desk.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4318" } } } },
  });

  // covers DP-004
  it("[TC-DP-136] reads where serve forwards, and whether it forwards HTTPS at its root to the serve port", () => {
    const routes = Option.getOrThrow(readServeStatus(serving));
    expect(routes).toEqual([
      { host: "studio-desk.example.ts.net:443", path: "/", proxy: "http://127.0.0.1:4318", funnel: false },
    ]);
    expect(forwardsTo(routes, 4318)).toBe(true);
    expect(forwardsTo(routes, 4317)).toBe(false);
    // However the target was spelled, and only at the root of port 443.
    const route = (proxy: string, host = "hub.example.ts.net:443", path = "/") => [
      { host, path, proxy, funnel: false },
    ];
    expect(forwardsTo(route("localhost:4318"), 4318)).toBe(true);
    expect(forwardsTo(route("http://localhost:4318/"), 4318)).toBe(true);
    expect(forwardsTo(route("http://192.168.1.4:4318"), 4318)).toBe(false);
    expect(forwardsTo(route("https+insecure://127.0.0.1:4318"), 4318)).toBe(false);
    expect(forwardsTo(route("http://127.0.0.1:4318", "hub.example.ts.net:8443"), 4318)).toBe(false);
    expect(forwardsTo(route("http://127.0.0.1:4318", undefined, "/hobbots"), 4318)).toBe(false);
    // Funnel allowed on the host is read too.
    const funneled = Option.getOrThrow(
      readServeStatus(
        JSON.stringify({ ...JSON.parse(serving), AllowFunnel: { "studio-desk.example.ts.net:443": true } }),
      ),
    );
    expect(funneled[0]?.funnel).toBe(true);
    // Nothing served, and output that is not a serve configuration.
    expect(readServeStatus("{}")).toEqual(Option.some([]));
    expect(readServeStatus("serve: not running")).toEqual(Option.none());
  });
});

describe("addressRanges", () => {
  it("accepts Tailscale's CGNAT and IPv6 ranges and nothing else", () => {
    const tailnet = addressRanges(TAILNET_RANGES);
    for (const address of ["100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12::5"]) {
      expect(tailnet(address)).toBe(true);
    }
    for (const address of ["100.63.255.255", "100.128.0.1", "127.0.0.1", "192.168.1.2", "fd7a:115c:a1e1::1", "", "x"]) {
      expect(tailnet(address)).toBe(false);
    }
  });
});

describe("remoteAccessStatus", () => {
  const running = { state: "running", dnsName: "hub.example.ts.net", addresses: ["100.101.102.103"] } as const;
  const base = {
    enabled: true,
    paused: false,
    port: 4317,
    tailscale: running,
    listening: ["100.101.102.103"],
    failed: [],
    https: { enabled: false, port: 4318, listening: false, forwarding: null, detail: null },
  };

  it("has no problem while it listens on every address Tailscale gave it", () => {
    expect(remoteAccessStatus(base)).toMatchObject({ problem: null, detail: null, listening: ["100.101.102.103"] });
  });

  it("says why it does not listen on the tailnet", () => {
    expect(remoteAccessStatus({ ...base, enabled: false }).problem).toBe("off");
    expect(remoteAccessStatus({ ...base, enabled: false }).listening).toEqual([]);
    // Paused, it keeps what Tailscale said but listens nowhere on the tailnet; off wins over paused.
    expect(remoteAccessStatus({ ...base, paused: true })).toMatchObject({
      problem: "paused",
      listening: [],
      tailscale: running,
    });
    expect(remoteAccessStatus({ ...base, enabled: false, paused: true }).problem).toBe("off");
    expect(remoteAccessStatus({ ...base, tailscale: null, listening: [] }).problem).toBe("tailscale");
    expect(
      remoteAccessStatus({ ...base, tailscale: { state: "signedOut", dnsName: null, addresses: [] }, listening: [] })
        .problem,
    ).toBe("tailscale");
    expect(remoteAccessStatus({ ...base, tailscale: { ...running, addresses: [] }, listening: [] }).problem).toBe(
      "noAddress",
    );
    expect(
      remoteAccessStatus({
        ...base,
        listening: [],
        failed: [{ address: "100.101.102.103", detail: "another program is using the port" }],
      }),
    ).toMatchObject({ problem: "cannotListen", detail: "100.101.102.103:4317: another program is using the port" });
  });
});
