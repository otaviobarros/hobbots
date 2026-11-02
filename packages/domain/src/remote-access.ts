import { Schema } from "effect";

/**
 * Tailscale on the hub, as the hub last saw it (ADR 021). `notInstalled`: no `tailscale` command
 * was found. `notRunning`: the command could not reach Tailscale, or Tailscale is stopped or still
 * starting. `signedOut`: Tailscale waits for a sign-in or for the tailnet admin to approve this
 * computer. `running`: connected to the tailnet.
 */
export const TailscaleState = Schema.Literals(["notInstalled", "notRunning", "signedOut", "running"]);
export type TailscaleState = typeof TailscaleState.Type;

/** What Tailscale reports about the hub's own node. */
export const TailscaleStatus = Schema.Struct({
  state: TailscaleState,
  /** The hub's MagicDNS name, without its trailing dot, such as `hub.example.ts.net`; null when it has none. */
  dnsName: Schema.NullOr(Schema.String),
  /** The hub's tailnet addresses, IPv4 first. Empty unless Tailscale is running. */
  addresses: Schema.Array(Schema.String),
});
export type TailscaleStatus = typeof TailscaleStatus.Type;

/**
 * Why the hub is not listening on its tailnet. `off`: remote access is off. `paused`: the user
 * paused it from the menu-bar icon until they resume it. `tailscale`: Tailscale
 * is not running on the hub; `tailscale.state` says how. `noAddress`: Tailscale runs but gave the hub
 * no tailnet address. `cannotListen`: the hub could not open its port on a tailnet address; `detail`
 * says why.
 */
export const RemoteAccessProblem = Schema.Literals(["off", "paused", "tailscale", "noAddress", "cannotListen"]);
export type RemoteAccessProblem = typeof RemoteAccessProblem.Type;

/** The port the hub listens on unless the user chose another. */
export const DEFAULT_HUB_PORT = 4317;

/** A port the hub may listen on: never a privileged one. */
export const HubPort = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 }));

/** The loopback port `tailscale serve` forwards HTTPS to, unless the user's hub already uses another (ADR 021). */
export const DEFAULT_SERVE_PORT = 4318;

/**
 * HTTPS through `tailscale serve` (ADR 021). Tailscale serves the hub at `https://<MagicDNS name>`
 * and forwards each request to the hub's serve listener, a separate port on loopback.
 */
export const HttpsStatus = Schema.Struct({
  /** Whether the user turned HTTPS on in Settings › Devices. Off by default. */
  enabled: Schema.Boolean,
  /** The serve listener's port on loopback. It stays when the hub's own port changes. */
  port: Schema.Int,
  /** Whether the serve listener is open: only while HTTPS and remote access are on and not paused. */
  listening: Schema.Boolean,
  /**
   * Whether `tailscale serve status` says Tailscale forwards HTTPS to the serve port. Null when the
   * hub could not read it, as without Tailscale.
   */
  forwarding: Schema.NullOr(Schema.Boolean),
  /** Why the serve listener could not open, in the system's words; null when it opened or is closed. */
  detail: Schema.NullOr(Schema.String),
});
export type HttpsStatus = typeof HttpsStatus.Type;

/** Where `tailscale serve` forwards to: the serve listener, on loopback only. */
export const serveTarget = (port: number) => `http://127.0.0.1:${port}`;

/** The `tailscale` arguments that serve the hub over HTTPS on its MagicDNS name, in the background. */
export const serveOnArgs = (port: number): ReadonlyArray<string> => ["serve", "--bg", serveTarget(port)];

/** The `tailscale` arguments that remove what `serveOnArgs` set up. */
export const SERVE_OFF_ARGS: ReadonlyArray<string> = ["serve", "--https=443", "off"];

/** A `tailscale` command as the user types it. */
export const tailscaleCommand = (args: ReadonlyArray<string>) => ["tailscale", ...args].join(" ");

/** Remote access on the hub (ADR 021): the setting, the port, Tailscale and where the hub listens. */
export const RemoteAccessStatus = Schema.Struct({
  /** Whether the user turned remote access on. Off by default. */
  enabled: Schema.Boolean,
  /**
   * Whether the user paused remote access from the menu-bar icon. While paused the hub listens only
   * on loopback; the setting stays on, survives a restart and lasts until Resume.
   */
  paused: Schema.Boolean,
  /** The hub's port, on loopback and on the tailnet. */
  port: Schema.Int,
  /** Null until the hub first asked Tailscale. */
  tailscale: Schema.NullOr(TailscaleStatus),
  /** The tailnet addresses the hub listens on now, beside loopback. */
  listening: Schema.Array(Schema.String),
  /** Why the hub listens on no tailnet address, or on fewer than Tailscale gave it; null when it listens on all. */
  problem: Schema.NullOr(RemoteAccessProblem),
  /** The system's words for a `cannotListen` problem, such as the error a bind failed with. */
  detail: Schema.NullOr(Schema.String),
  /** HTTPS through `tailscale serve`. */
  https: HttpsStatus,
});
export type RemoteAccessStatus = typeof RemoteAccessStatus.Type;

/**
 * The hub's HTTPS address, `https://<MagicDNS name>`, while Tailscale serves it there: HTTPS is
 * on, the serve listener is open and `tailscale serve` forwards to it. Null otherwise.
 */
export const httpsAddress = (status: RemoteAccessStatus): string | null => {
  const name = status.tailscale?.dnsName;
  const { enabled, listening, forwarding } = status.https;
  return enabled && listening && forwarding === true && name ? `https://${name}` : null;
};

/**
 * Remote access changed: it was turned on or off, paused or resumed, Tailscale changed, the hub started or stopped
 * listening on its tailnet, or the port changed. Transient: the status lives in the hub's process.
 */
export const RemoteAccessChanged = Schema.TaggedStruct("RemoteAccessChanged", { status: RemoteAccessStatus });
export type RemoteAccessChanged = typeof RemoteAccessChanged.Type;
