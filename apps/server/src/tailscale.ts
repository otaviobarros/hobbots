import { readFileSync } from "node:fs";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import { runTool, type ToolRun, toolEnv } from "@hobbots/charms";
import type { TailscaleState, TailscaleStatus } from "@hobbots/domain";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { TailnetOwner, TailnetPeer } from "./devices.ts";

/**
 * Tailscale on the hub, read through its command line (ADR 021). The hub only reads: it never
 * changes Tailscale's settings.
 */

/** What one `tailscale status` tells the hub: its own node, and the addresses of every peer it lists. */
export interface TailnetSnapshot {
  readonly status: TailscaleStatus;
  readonly peers: ReadonlySet<string>;
}

export class Tailscale extends Context.Service<
  Tailscale,
  {
    readonly snapshot: Effect.Effect<TailnetSnapshot>;
    /** The node behind a tailnet address, or none when Tailscale does not know it. */
    readonly whois: (address: string) => Effect.Effect<Option.Option<TailnetPeer>>;
    /** Whether a connection from this address can come from the tailnet at all. */
    readonly isTailnetAddress: (address: string) => boolean;
  }
>()("@hobbots/server/Tailscale") {}

const stripDot = (name: string) => (name.endsWith(".") ? name.slice(0, -1) : name);

const notListed = (state: TailscaleState): TailnetSnapshot => ({
  status: { state, dnsName: null, addresses: [] },
  peers: new Set(),
});

// The fields of `tailscale status --json` the hub reads (ipnstate.Status in Tailscale's source).
const StatusJson = Schema.Struct({
  BackendState: Schema.String,
  Self: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        DNSName: Schema.optional(Schema.String),
        TailscaleIPs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  ),
  Peer: Schema.optional(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.Struct({ TailscaleIPs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))) }),
      ),
    ),
  ),
});
const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(StatusJson));

const stateOf = (backend: string): TailscaleState => {
  if (backend === "Running") return "running";
  // A sign-in, or the tailnet admin's approval of this computer, comes first.
  if (backend === "NeedsLogin" || backend === "NeedsMachineAuth") return "signedOut";
  return "notRunning";
};

/** The hub's node and its peers' addresses from `tailscale status --json`; not running when it cannot be read. */
export const readStatus = (json: string): TailnetSnapshot =>
  Option.match(decodeStatus(json), {
    onNone: () => notListed("notRunning"),
    onSome: (raw) => {
      const state = stateOf(raw.BackendState);
      if (state !== "running") return notListed(state);
      const addresses = [...(raw.Self?.TailscaleIPs ?? [])].sort((a, b) => Number(isIPv6(a)) - Number(isIPv6(b)));
      const dnsName = raw.Self?.DNSName ? stripDot(raw.Self.DNSName) : null;
      const peers = new Set(Object.values(raw.Peer ?? {}).flatMap((peer) => peer.TailscaleIPs ?? []));
      return { status: { state, dnsName: dnsName === "" ? null : dnsName, addresses }, peers };
    },
  });

// The fields of `tailscale whois --json` the hub reads (apitype.WhoIsResponse in Tailscale's source).
const WhoIsJson = Schema.Struct({
  Node: Schema.Struct({
    StableID: Schema.String,
    Name: Schema.String,
    Tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
  UserProfile: Schema.optional(Schema.NullOr(Schema.Struct({ LoginName: Schema.String }))),
});
const decodeWhoIs = Schema.decodeUnknownOption(Schema.fromJsonString(WhoIsJson));

/**
 * The node `tailscale whois --json` names. A tagged node belongs to its tags, not to a person, so
 * its tags name it; any other node names its owner's login.
 */
export const readWhoIs = (json: string): Option.Option<TailnetPeer> =>
  decodeWhoIs(json).pipe(
    Option.flatMap((raw): Option.Option<TailnetPeer> => {
      const tags = raw.Node.Tags ?? [];
      const owner: TailnetOwner | null =
        tags.length > 0
          ? { _tag: "Tagged", tags }
          : raw.UserProfile
            ? { _tag: "User", login: raw.UserProfile.LoginName }
            : null;
      if (owner === null || raw.Node.StableID === "") return Option.none();
      return Option.some({ nodeId: raw.Node.StableID, nodeName: stripDot(raw.Node.Name), owner });
    }),
  );

/** Address ranges as a set a connection's address can be checked against. */
export const addressRanges = (ranges: ReadonlyArray<string>) => {
  const list = new BlockList();
  for (const range of ranges) {
    const [address = "", prefix] = range.split("/");
    const type = isIPv6(address) ? "ipv6" : "ipv4";
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return (address: string) =>
    (isIPv4(address) && list.check(address, "ipv4")) || (isIPv6(address) && list.check(address, "ipv6"));
};

/** Every address Tailscale gives a node: its CGNAT range and its IPv6 prefix. */
export const TAILNET_RANGES = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"] as const;

/**
 * Where the `tailscale` command is: on the `PATH`, as the standalone app's optional command and
 * Homebrew install it, or else inside the Mac app, whose own command line is its main binary.
 */
const commandsFor = (platform: NodeJS.Platform) =>
  platform === "darwin" ? ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] : ["tailscale"];

/** Tailscale through its command line on the hub. */
export const TailscaleLive = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
  Layer.effect(
    Tailscale,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // The Mac app's binary opens its window unless it is told to act as the command line.
      const run = runTool(spawner, toolEnv(env, { TAILSCALE_BE_CLI: "1" }));
      // What the first command that starts answers; none when none starts, as without Tailscale.
      const tailscale = (args: ReadonlyArray<string>): Effect.Effect<Option.Option<ToolRun>> =>
        Effect.reduce(
          commandsFor(platform),
          () => Option.none<ToolRun>(),
          (found, command) => (Option.isSome(found) ? Effect.succeed(found) : run(command, args).pipe(Effect.option)),
        );
      const isTailnetAddress = addressRanges(TAILNET_RANGES);
      return Tailscale.of({
        snapshot: tailscale(["status", "--json"]).pipe(
          Effect.map(
            Option.match({
              onNone: () => notListed("notInstalled"),
              // A stopped Tailscale still answers; one whose service is not running answers no status.
              onSome: ({ out }) => readStatus(out),
            }),
          ),
        ),
        whois: (address) =>
          tailscale(["whois", "--json", address]).pipe(
            Effect.map(Option.flatMap((result) => (result.code === 0 ? readWhoIs(result.out) : Option.none()))),
          ),
        isTailnetAddress,
      });
    }),
  );

/**
 * The fake Tailscale's state (ADR 021): what `status` reports, a tailnet address a test can bind,
 * such as `127.0.0.2`, and the whois table. `ranges` are the addresses its tailnet connections come
 * from, in place of Tailscale's own.
 */
export const FakeTailnet = Schema.Struct({
  state: Schema.Literals(["notInstalled", "notRunning", "signedOut", "running"]),
  dnsName: Schema.NullOr(Schema.String),
  addresses: Schema.Array(Schema.String),
  peers: Schema.Record(
    Schema.String,
    Schema.Struct({
      nodeId: Schema.String,
      nodeName: Schema.String,
      owner: Schema.Union([
        Schema.TaggedStruct("User", { login: Schema.String }),
        Schema.TaggedStruct("Tagged", { tags: Schema.Array(Schema.String) }),
      ]),
    }),
  ),
  ranges: Schema.Array(Schema.String),
});
export type FakeTailnet = typeof FakeTailnet.Type;

/** A tailnet with one peer, the computer the hub runs on, served on 127.0.0.2. */
export const DEFAULT_FAKE_TAILNET: FakeTailnet = {
  state: "running",
  dnsName: "hub.example.ts.net",
  addresses: ["127.0.0.2"],
  peers: {
    "127.0.0.1": {
      nodeId: "nFAKEHUB",
      nodeName: "hub.example.ts.net",
      owner: { _tag: "User", login: "you@example.com" },
    },
  },
  ranges: ["127.0.0.0/8"],
};

const fakeFrom = (read: Effect.Effect<FakeTailnet>, ranges: ReadonlyArray<string>) =>
  Tailscale.of({
    snapshot: Effect.map(read, (fake) =>
      fake.state === "running"
        ? {
            status: { state: fake.state, dnsName: fake.dnsName, addresses: fake.addresses },
            peers: new Set(Object.keys(fake.peers)),
          }
        : notListed(fake.state),
    ),
    whois: (address) =>
      Effect.map(read, (fake) =>
        fake.state === "running" ? Option.fromNullishOr(fake.peers[address]) : Option.none(),
      ),
    isTailnetAddress: addressRanges(ranges),
  });

/** A fake Tailscale for tests, which the test changes through the `Ref`. */
export const TailscaleFake = (
  tailnet: Ref.Ref<FakeTailnet>,
  ranges: ReadonlyArray<string> = DEFAULT_FAKE_TAILNET.ranges,
) => Layer.succeed(Tailscale, fakeFrom(Ref.get(tailnet), ranges));

const decodeFake = Schema.decodeUnknownOption(Schema.fromJsonString(FakeTailnet));

/**
 * A fake Tailscale for development (`HOBBOTS_FAKE_TAILSCALE=on`). It reads `fake-tailscale.json`
 * in the data folder on every check, so editing the file turns the fake tailnet off or on while the
 * hub runs; without the file it is `DEFAULT_FAKE_TAILNET`, and a file it cannot read is not installed.
 */
export const TailscaleFakeFile = (dataDir: string) => {
  const file = join(dataDir, "fake-tailscale.json");
  const read = Effect.sync((): FakeTailnet => {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return DEFAULT_FAKE_TAILNET;
    }
    return Option.getOrElse(decodeFake(raw), () => ({ ...DEFAULT_FAKE_TAILNET, state: "notInstalled" as const }));
  });
  return Layer.effect(
    Tailscale,
    Effect.map(read, (start) => fakeFrom(read, start.ranges)),
  );
};
