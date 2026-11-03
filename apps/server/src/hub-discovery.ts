import { isIPv6 } from "node:net";
import { connectSupport, SUPPORTED_CONNECT } from "@hobbots/api";
import { HubPort, type TailscaleState } from "@hobbots/domain";
import { Duration, Effect, Option, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { addressRanges, TAILNET_RANGES, type TailnetNode, type TailnetSnapshot, Tailscale } from "./tailscale.ts";

/**
 * Finding Hobbots hubs on the tailnet from a computer that wants to connect to one (ADR 025). It only
 * reads this computer's Tailscale and asks each of the user's own computers for the hub's health
 * answer. It never changes Tailscale's settings.
 */

/** The port a hub listens on unless the user moved it (ADR 021); the scan asks only this one. */
export const DEFAULT_HUB_PORT = 4317;

/** At most this many health requests at once in a scan, each given this long to answer. */
export const SCAN_CONCURRENCY = 8;
export const HEALTH_TIMEOUT = Duration.seconds(2);

/** A hub the app can talk to: the node Tailscale names and the address the app uses for it. */
export interface HubTarget {
  readonly node: TailnetNode;
  /** `http://<MagicDNS name>:<port>`, or `https://<MagicDNS name>` for the hub's HTTPS address. */
  readonly origin: string;
}

/** Why a typed address was refused before any request was sent. */
export type AddressRefused =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Malformed" }
  /** Tailscale is not running and signed in here, so no name or address can be checked. */
  | { readonly _tag: "TailscaleNotReady"; readonly state: TailscaleState }
  | { readonly _tag: "Loopback" }
  | { readonly _tag: "LocalNetwork" }
  | { readonly _tag: "Public" }
  /** A name or tailnet address this computer's Tailscale does not list. */
  | { readonly _tag: "NotOnTailnet" }
  | { readonly _tag: "ThisComputer" }
  /** A tagged node or another user's node: not one of the user's own computers. */
  | { readonly _tag: "NotYours"; readonly node: TailnetNode };

/** What a hub's health answer says, or why the app will not use it. */
export type HubAnswer =
  | {
      readonly _tag: "Hub";
      /** The name the hub reports about itself, shown only beside its Tailscale name. */
      readonly name: string | null;
      readonly version: string;
      /** The hub's connect protocol; 0 for a hub from before it had one. */
      readonly connect: number;
      /** Whether this app can use the hub, or which side needs an update. */
      readonly support: "supported" | "hubOlder" | "appOlder";
    }
  | { readonly _tag: "NotHobbots" }
  /** Nothing answered in time: no hub on the port, or the node is unreachable. */
  | { readonly _tag: "NoAnswer" }
  /** The hub answered that this computer asks too often; it may be a hub, but it said nothing more. */
  | { readonly _tag: "Throttled" };

export type FoundHub = HubTarget & Extract<HubAnswer, { readonly _tag: "Hub" }>;

/** One scan of the tailnet: the hubs found, or why Tailscale could not be read. */
export type HubScan =
  | { readonly _tag: "TailscaleNotReady"; readonly state: TailscaleState }
  | { readonly _tag: "Scanned"; readonly hubs: ReadonlyArray<FoundHub> };

const isTailnetIp = addressRanges(TAILNET_RANGES);
const isLoopbackIp = addressRanges(["127.0.0.0/8", "::1/128", "0.0.0.0/8", "::/128"]);
const isLocalNetworkIp = addressRanges([
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "fc00::/7",
  "fe80::/10",
]);

const stripBrackets = (host: string) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);
const isIp = (host: string) => isIPv6(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

interface TypedAddress {
  readonly host: string;
  readonly https: boolean;
  readonly port: number | null;
}

/** The host, scheme and port of what the user typed, or none when it is not an address at all. */
const parseTyped = (typed: string): Option.Option<TypedAddress> => {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    // A bare IPv6 address, which the URL parser only takes in brackets.
    return isIPv6(typed) ? Option.some({ host: typed.toLowerCase(), https: false, port: null }) : Option.none();
  }
  const https = url.protocol === "https:";
  const host = stripBrackets(url.hostname.toLowerCase()).replace(/\.$/, "");
  if ((!https && url.protocol !== "http:") || host === "" || !isBareOrigin(url)) return Option.none();
  return Option.some({ host, https, port: typedPort(url, withScheme, https) });
};

/** Whether a URL is only a scheme, host and port: no credentials, path, query or fragment. */
const isBareOrigin = (url: URL) =>
  url.username === "" && url.password === "" && url.search === "" && url.hash === "" && url.pathname === "/";

/** The port the user typed; the URL parser drops one that is the scheme's default, which they still typed. */
const typedPort = (url: URL, typed: string, https: boolean): number | null => {
  if (url.port !== "") return Number(url.port);
  const defaultPort = https ? 443 : 80;
  return typed.split("/")[2]?.endsWith(`:${defaultPort}`) === true ? defaultPort : null;
};

/** The node a name or address names: a full MagicDNS name, its first label alone, or a tailnet address. */
const nodeFor = (snapshot: TailnetSnapshot, host: string): TailnetNode | undefined => {
  if (isIp(host)) return snapshot.nodes.find((node) => node.addresses.includes(host));
  if (host.includes(".")) return snapshot.nodes.find((node) => node.nodeName === host);
  return snapshot.nodes.find((node) => node.nodeName.split(".")[0] === host);
};

/** Whether a node belongs to the same Tailscale user as this computer (ADR 025). */
export const isOwnComputer = (snapshot: TailnetSnapshot, node: TailnetNode): boolean => {
  const self = snapshot.self;
  return (
    self !== null &&
    self.owner._tag === "User" &&
    node.owner._tag === "User" &&
    node.owner.login === self.owner.login &&
    node.nodeId !== self.nodeId
  );
};

/** The address the app uses for a node: its MagicDNS name, with the port over HTTP. */
export const hubOrigin = (node: TailnetNode, https: boolean, port: number | null): string => {
  if (https) return port === null || port === 443 ? `https://${node.nodeName}` : `https://${node.nodeName}:${port}`;
  return `http://${node.nodeName}:${port ?? DEFAULT_HUB_PORT}`;
};

const refuseIp = (host: string): AddressRefused | null => {
  if (isLoopbackIp(host)) return { _tag: "Loopback" };
  if (isTailnetIp(host)) return null;
  return isLocalNetworkIp(host) ? { _tag: "LocalNetwork" } : { _tag: "Public" };
};

const refuseName = (host: string): AddressRefused | null =>
  host === "localhost" || host.endsWith(".localhost") ? { _tag: "Loopback" } : null;

/**
 * The hub a typed address names, or why it was refused before any request (ADR 025): a MagicDNS name,
 * short or full, with or without a port; an `http://` or `https://` address; or a tailnet address.
 * Only one of the user's own computers on this tailnet resolves. A short name is completed from
 * `tailscale status`, a missing port means 4317 over HTTP, and the address is always the node's
 * MagicDNS name, so a typed tailnet address gets the same address as its name.
 */
export const resolveHubAddress = (
  typed: string,
  snapshot: TailnetSnapshot,
): Result.Result<HubTarget, AddressRefused> => {
  const text = typed.trim();
  if (text === "") return Result.fail({ _tag: "Empty" });
  const parsed = parseTyped(text);
  if (Option.isNone(parsed)) return Result.fail({ _tag: "Malformed" });
  const { host, https, port } = parsed.value;
  if (port !== null && !https && !Schema.is(HubPort)(port)) return Result.fail({ _tag: "Malformed" });
  const refused = isIp(host) ? refuseIp(host) : refuseName(host);
  if (refused !== null) return Result.fail(refused);
  if (snapshot.status.state !== "running")
    return Result.fail({ _tag: "TailscaleNotReady", state: snapshot.status.state });
  const isSelf =
    host === snapshot.status.dnsName ||
    host === snapshot.status.dnsName?.split(".")[0] ||
    snapshot.status.addresses.includes(host);
  if (isSelf) return Result.fail({ _tag: "ThisComputer" });
  const node = nodeFor(snapshot, host);
  if (node === undefined) return Result.fail({ _tag: "NotOnTailnet" });
  if (!isOwnComputer(snapshot, node)) return Result.fail({ _tag: "NotYours", node });
  return Result.succeed({ node, origin: hubOrigin(node, https, port) });
};

// What the app reads of a health answer: the public identity, and the connect protocol (ADR 025).
const HealthAnswer = Schema.Struct({
  app: Schema.Literal("hobbots"),
  name: Schema.optionalKey(Schema.String),
  version: Schema.String,
  connect: Schema.optionalKey(Schema.Int),
});
const decodeHealth = Schema.decodeUnknownOption(HealthAnswer);

/** A health answer as what the app can do with that hub; anything else is not Hobbots. */
export const judgeHubHealth = (
  body: unknown,
  range: { readonly min: number; readonly max: number } = SUPPORTED_CONNECT,
): HubAnswer =>
  Option.match(decodeHealth(body), {
    onNone: () => ({ _tag: "NotHobbots" }),
    onSome: (health) => {
      // A hub outside the connect protocols this app supports (ADR 025) is listed but never paired with.
      const side = connectSupport(health.connect, range);
      const support = side === "ok" ? "supported" : side;
      return { _tag: "Hub", name: health.name ?? null, version: health.version, connect: health.connect ?? 0, support };
    },
  });

/**
 * Asks the address for the hub's health answer, giving it two seconds. A redirect is never followed,
 * so the only computer asked is the one the user's tailnet names; a hub answers health directly.
 */
export const askHub = (origin: string): Effect.Effect<HubAnswer, never, HttpClient.HttpClient> =>
  HttpClient.get(`${origin}/api/health`, { acceptJson: true }).pipe(
    // `fetch` follows redirects itself unless told not to.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.flatMap((response) => {
      if (response.status === 429) return Effect.succeed<HubAnswer>({ _tag: "Throttled" });
      // Anything but a direct answer, a redirect included, is not a hub's health answer.
      if (response.status !== 200) return Effect.succeed<HubAnswer>({ _tag: "NotHobbots" });
      return response.json.pipe(
        Effect.map((body) => judgeHubHealth(body)),
        Effect.orElseSucceed((): HubAnswer => ({ _tag: "NotHobbots" })),
      );
    }),
    Effect.timeoutOption(HEALTH_TIMEOUT),
    Effect.map(Option.getOrElse((): HubAnswer => ({ _tag: "NoAnswer" }))),
    Effect.orElseSucceed((): HubAnswer => ({ _tag: "NoAnswer" })),
  );

/**
 * The user's own online computers, the only peers a scan asks (ADR 025). A tagged node or another
 * user's node is not the user's own computer, so it is never asked.
 */
export const scanTargets = (snapshot: TailnetSnapshot): ReadonlyArray<HubTarget> =>
  snapshot.nodes
    .filter((node) => node.online && isOwnComputer(snapshot, node))
    .map((node) => ({ node, origin: hubOrigin(node, false, null) }));

/**
 * Every Hobbots hub on the user's own online computers, by their Tailscale names (ADR 025). Each is
 * asked once on the default port, at most eight at once. A peer that answers something else, or
 * nothing, is left out; a hub whose connect protocol this app cannot use is listed with that reason.
 */
export const findHubs: Effect.Effect<HubScan, never, Tailscale | HttpClient.HttpClient> = Effect.gen(function* () {
  const snapshot = yield* (yield* Tailscale).snapshot;
  if (snapshot.status.state !== "running") return { _tag: "TailscaleNotReady", state: snapshot.status.state };
  const answers = yield* Effect.forEach(
    scanTargets(snapshot),
    (target) => Effect.map(askHub(target.origin), (answer) => ({ target, answer })),
    { concurrency: SCAN_CONCURRENCY },
  );
  const hubs = answers
    .flatMap(({ target, answer }): ReadonlyArray<FoundHub> => (answer._tag === "Hub" ? [{ ...target, ...answer }] : []))
    .sort((a, b) => a.node.nodeName.localeCompare(b.node.nodeName));
  return { _tag: "Scanned", hubs };
});
