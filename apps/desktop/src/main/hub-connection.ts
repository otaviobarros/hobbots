/**
 * A connected desktop's view of its hub (ADR 025): the hub's two origins, what its health answer
 * says, whether its address still belongs to the node the user chose, and the main process's own
 * requests with the device token. Electron stays out of this file; connected-mode.ts passes the
 * keychain, Tailscale and `fetch` in.
 */
import { connectSupport, PublicServerIdentity } from "@hobbots/api";
import { Option, Schema } from "effect";

/** The default port a hub listens on, used when an `http://` address names none. */
const DEFAULT_HUB_PORT = 4317;

/** The hub's addresses: plain HTTP on its port and HTTPS through `tailscale serve`, on one host. */
export interface HubOrigins {
  /** The MagicDNS name or tailnet address, lowercase. */
  readonly host: string;
  /** The origin the app uses, as stored. */
  readonly origin: string;
  /** `http://<host>`: cookies are kept per host, whatever the port. */
  readonly http: string;
  /** `https://<host>`, where the secure cookie lives. */
  readonly https: string;
}

/** The hub's origins from its stored address, or undefined when it is not an `http` or `https` origin. */
export const hubOrigins = (address: string): HubOrigins | undefined => {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const port = url.protocol === "http:" ? `:${url.port || DEFAULT_HUB_PORT}` : url.port ? `:${url.port}` : "";
  return { host, origin: `${url.protocol}//${host}${port}`, http: `http://${host}`, https: `https://${host}` };
};

/** The hub's two origins: its stored address, and its HTTPS address through `tailscale serve`. */
const hubPageOrigins = (origins: HubOrigins) => new Set([origins.origin, origins.https]);

/**
 * Whether a URL is on one of the hub's two origins: the only pages the window may show and the only
 * senders the bridge answers. Another port on the same host is another service, so it is not the hub.
 */
export const isHubPage = (origins: HubOrigins, url: string) => {
  try {
    return hubPageOrigins(origins).has(new URL(url).origin);
  } catch {
    return false;
  }
};

/** Whether a URL is on the hub's host, on any port: the browser engine sends the host's cookies to all of them. */
const isHubHost = (origins: HubOrigins, url: string) => {
  try {
    return new URL(url).hostname.toLowerCase() === origins.host;
  } catch {
    return false;
  }
};

/** What the hub's health endpoint says, as far as connecting needs it. */
export type HubAnswer =
  | { readonly kind: "ready"; readonly name: string; readonly version: string; readonly connect: number }
  /** A hub outside the connect protocols this app supports, and which side must update. */
  | { readonly kind: "unsupported"; readonly side: "hubOlder" | "appOlder"; readonly version: string }
  | { readonly kind: "notHobbots" }
  | { readonly kind: "noAnswer" };

const decodeHealth = Schema.decodeUnknownOption(PublicServerIdentity);

/** Reads a health answer: only one that says Hobbots, a version and a supported connect protocol is ready. */
const judgeHubHealth = (body: unknown, fallbackName: string): HubAnswer =>
  Option.match(decodeHealth(body), {
    onNone: (): HubAnswer => ({ kind: "notHobbots" }),
    onSome: (identity): HubAnswer => {
      const side = connectSupport(identity.connect);
      if (side !== "ok") return { kind: "unsupported", side, version: identity.version };
      return {
        kind: "ready",
        name: identity.name ?? fallbackName,
        version: identity.version,
        connect: identity.connect ?? 0,
      };
    },
  });

/** Asks the hub's health endpoint, without the device token: it answers without one. */
export const askHub = async (origin: string, fetcher: typeof fetch, fallbackName: string): Promise<HubAnswer> => {
  let response: Response;
  try {
    response = await fetcher(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return { kind: "noAnswer" };
  }
  if (!response.ok) return { kind: "notHobbots" };
  try {
    return judgeHubHealth(await response.json(), fallbackName);
  } catch {
    return { kind: "notHobbots" };
  }
};

/** A Tailscale node, as `tailscale whois` names it. */
export interface TailnetNode {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly owner:
    | { readonly _tag: "User"; readonly login: string }
    | { readonly _tag: "Tagged"; readonly tags: ReadonlyArray<string> };
}

/** How the app learns which node an address belongs to: name resolution, then `tailscale whois`. */
export interface NodeLookup {
  /** The addresses a host resolves to; a tailnet address resolves to itself. */
  readonly resolve: (host: string) => Promise<ReadonlyArray<string>>;
  readonly whois: (address: string) => Promise<TailnetNode | null>;
}

/** How long an answer about the hub's node is kept, as the hub keeps its own (ADR 025). */
const NODE_CHECK_MS = 60_000;

/**
 * The node behind each host, kept for a minute. A host whose addresses do not all belong to one
 * node Tailscale knows has none, so it gets no token and no page.
 */
export const makeNodeCheck = (lookup: NodeLookup, now: () => number = Date.now) => {
  const known = new Map<string, { readonly at: number; readonly node: TailnetNode | null }>();
  const ask = async (host: string): Promise<TailnetNode | null> => {
    const addresses = await lookup.resolve(host).catch(() => []);
    if (addresses.length === 0) return null;
    const nodes = await Promise.all(addresses.map((address) => lookup.whois(address).catch(() => null)));
    const first = nodes[0] ?? null;
    return nodes.every((node) => node !== null && node.nodeId === first?.nodeId) ? first : null;
  };
  const nodeOf = async (host: string): Promise<TailnetNode | null> => {
    const cached = known.get(host);
    if (cached !== undefined && now() - cached.at < NODE_CHECK_MS) return cached.node;
    const node = await ask(host);
    known.set(host, { at: now(), node });
    return node;
  };
  return {
    nodeOf,
    /** Whether the host still belongs to the pinned node. */
    isPinned: async (host: string, nodeId: string) => (await nodeOf(host))?.nodeId === nodeId,
    /** Drops what is kept, as when the network or Tailscale changes. */
    forget: () => known.clear(),
  };
};
export type NodeCheck = ReturnType<typeof makeNodeCheck>;

/**
 * Where the hub's node stands on this computer's Tailscale (ADR 025): Tailscale is not running here,
 * the node is not online in `tailscale status`, or it is online.
 */
export type HubNodeState = "tailscaleOff" | "offline" | "online";

/**
 * The hub's node in `tailscale status`: a node Tailscale no longer lists counts as offline, as does
 * one it lists as offline, which covers a hub whose own Tailscale is off.
 */
export const hubNodeState = (
  snapshot: {
    readonly status: { readonly state: string };
    readonly nodes: ReadonlyArray<{ readonly nodeId: string; readonly online: boolean }>;
  },
  nodeId: string,
): HubNodeState => {
  if (snapshot.status.state !== "running") return "tailscaleOff";
  return snapshot.nodes.some((node) => node.nodeId === nodeId && node.online) ? "online" : "offline";
};

/** Where the connection to the hub stands, for the menu bar and the bridge. */
export type ConnectionState =
  | { readonly state: "connected"; readonly version: string }
  | { readonly state: "connecting" }
  /** No device token in the keychain: this computer has to ask the hub again. */
  | { readonly state: "noToken" }
  /** Tailscale is not running on this computer, so no hub can be reached. */
  | { readonly state: "tailscaleOff" }
  /** The hub's computer is not online on the tailnet: asleep, shut down, or its Tailscale is off. */
  | { readonly state: "hubOffline" }
  | { readonly state: "otherNode" }
  /** The hub's computer is online, but nothing answers on the address: Hobbots is closed, remote access is off or paused, or the port changed. */
  | { readonly state: "unreachable" }
  | { readonly state: "notHobbots" }
  | { readonly state: "unsupported"; readonly side: "hubOlder" | "appOlder"; readonly version: string }
  | { readonly state: "revoked" }
  | { readonly state: "unknownDevice" };

/** The hub's refusal of this device, from a `401` answer's body. */
const refusalOf = (body: unknown): "revoked" | "unknownDevice" | null => {
  const tag = typeof body === "object" && body !== null ? (body as { _tag?: unknown })._tag : undefined;
  if (tag === "DeviceRevoked") return "revoked";
  return tag === "DeviceRequired" ? "unknownDevice" : null;
};

/** A request the app refused to send, because the hub's address no longer checks out. */
class HubNotVerified extends Error {
  constructor(readonly reason: ConnectionState) {
    super(`The hub cannot be used now (${reason.state})`);
  }
}

export interface ConnectedHubOptions {
  readonly origins: HubOrigins;
  /** The node the user chose, pinned after Allow. */
  readonly nodeId: string;
  readonly fallbackName: string;
  readonly nodeCheck: NodeCheck;
  /** Where the hub's node stands on this computer's Tailscale, read fresh on each check. */
  readonly nodeState: (nodeId: string) => Promise<HubNodeState>;
  /** The device token, read from the keychain. */
  readonly token: () => Promise<string | undefined>;
  readonly fetch: typeof fetch;
}

/**
 * The hub as the connected desktop's main process uses it: every connection first checks that the
 * address still belongs to the pinned node and that the hub speaks a connect protocol this app
 * supports. Only then is the token sent, as `Authorization: Bearer`.
 */
export const connectedHub = (options: ConnectedHubOptions) => {
  const { origins, nodeId, nodeCheck } = options;

  /**
   * Checks, in the order ADR 025 gives, this computer's Tailscale, the hub's node, that the address
   * is still that node's, then the hub's health; answers where the connection stands.
   */
  const verify = async (): Promise<ConnectionState> => {
    const node = await options.nodeState(nodeId).catch((): HubNodeState => "tailscaleOff");
    if (node === "tailscaleOff") return { state: "tailscaleOff" };
    if (node === "offline") return { state: "hubOffline" };
    if (!(await nodeCheck.isPinned(origins.host, nodeId))) return { state: "otherNode" };
    const answer = await askHub(origins.origin, options.fetch, options.fallbackName);
    if (answer.kind === "noAnswer") return { state: "unreachable" };
    if (answer.kind === "notHobbots") return { state: "notHobbots" };
    if (answer.kind === "unsupported") return { state: "unsupported", side: answer.side, version: answer.version };
    return (await options.token()) === undefined
      ? { state: "noToken" }
      : { state: "connected", version: answer.version };
  };

  /** The headers that make a request this device's, once the pinned node checks out. */
  const headers = async (held?: string): Promise<Record<string, string>> => {
    if (!(await nodeCheck.isPinned(origins.host, nodeId))) throw new HubNotVerified({ state: "otherNode" });
    const token = held ?? (await options.token());
    if (token === undefined) throw new HubNotVerified({ state: "noToken" });
    return { authorization: `Bearer ${token}` };
  };

  /**
   * Fetches a hub route as this device, never sending the token to another node. `held` is a token
   * already read from the keychain, as Disconnect holds it after deleting the keychain item.
   */
  const fetchAsDevice = async (path: string, init: RequestInit = {}, held?: string): Promise<Response> =>
    options.fetch(`${origins.origin}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(await headers(held)) },
    });

  /** Whether the hub still knows this device: `null` while it does or cannot say. */
  const refusal = async (): Promise<"revoked" | "unknownDevice" | null> => {
    try {
      const response = await fetchAsDevice("/api/activity", { signal: AbortSignal.timeout(2000) });
      return response.status === 401 ? refusalOf(await response.json().catch(() => null)) : null;
    } catch {
      return null;
    }
  };

  return { verify, headers, fetchAsDevice, refusal };
};
export type ConnectedHub = ReturnType<typeof connectedHub>;

/** The states only the user can change, such as a revoked device: trying again does not leave them. */
export const WAITS_FOR_USER: ReadonlySet<ConnectionState["state"]> = new Set(["noToken", "revoked", "unknownDevice"]);

/**
 * What happens to a request of the window, as the browser engine is about to send it: `cancel` when
 * it goes to the hub's origins while the address does not belong to the pinned node, `withoutToken`
 * when it goes to another port of the hub's host, which must not see the device cookies.
 */
export type WindowRequestVerdict = "send" | "withoutToken" | "cancel";

/** Judges each request of the window: a page or a call of the hub is sent only to the pinned node. */
export const windowRequestGate =
  ({ origins, nodeId, nodeCheck }: Pick<ConnectedHubOptions, "origins" | "nodeId" | "nodeCheck">) =>
  async (url: string): Promise<WindowRequestVerdict> => {
    if (!isHubHost(origins, url)) return "send";
    if (!isHubPage(origins, url)) return "withoutToken";
    return (await nodeCheck.isPinned(origins.host, nodeId).catch(() => false)) ? "send" : "cancel";
  };
