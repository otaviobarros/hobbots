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
 * Why the hub is not listening on its tailnet. `off`: remote access is off. `tailscale`: Tailscale
 * is not running on the hub; `tailscale.state` says how. `noAddress`: Tailscale runs but gave the hub
 * no tailnet address. `cannotListen`: the hub could not open its port on a tailnet address; `detail`
 * says why.
 */
export const RemoteAccessProblem = Schema.Literals(["off", "tailscale", "noAddress", "cannotListen"]);
export type RemoteAccessProblem = typeof RemoteAccessProblem.Type;

/** A port the hub may listen on: never a privileged one. */
export const HubPort = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 }));

/** Remote access on the hub (ADR 021): the setting, the port, Tailscale and where the hub listens. */
export const RemoteAccessStatus = Schema.Struct({
  /** Whether the user turned remote access on. Off by default. */
  enabled: Schema.Boolean,
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
});
export type RemoteAccessStatus = typeof RemoteAccessStatus.Type;

/**
 * Remote access changed: it was turned on or off, Tailscale changed, the hub started or stopped
 * listening on its tailnet, or the port changed. Transient: the status lives in the hub's process.
 */
export const RemoteAccessChanged = Schema.TaggedStruct("RemoteAccessChanged", { status: RemoteAccessStatus });
export type RemoteAccessChanged = typeof RemoteAccessChanged.Type;
