import { Schema } from "effect";

/**
 * Devices (ADR 021, DP-004): every client of the hub is an approved device. The hub's window is
 * trusted without asking; a connected desktop and every browser ask once, on the hub.
 */
export const DeviceId = Schema.String.pipe(Schema.brand("DeviceId"));
export type DeviceId = typeof DeviceId.Type;

/** The hub's window has one device for the life of the installation; its key changes on every start. */
export const WINDOW_DEVICE_ID = DeviceId.make("window");

/** `window` is the desktop app's own window on the hub, `desktop` a connected desktop app, `browser` any browser. */
export const DeviceKind = Schema.Literals(["window", "desktop", "browser"]);
export type DeviceKind = typeof DeviceKind.Type;

/** What a device that asks to pair says it is: never the hub's window, which never asks. */
export const PairingKind = Schema.Literals(["desktop", "browser"]);
export type PairingKind = typeof PairingKind.Type;

/** Who owns a Tailscale node: a user's login, or the tags of a tagged node. */
export const TailscaleOwner = Schema.Union([
  Schema.TaggedStruct("User", { login: Schema.String }),
  Schema.TaggedStruct("Tagged", { tags: Schema.Array(Schema.String) }),
]);
export type TailscaleOwner = typeof TailscaleOwner.Type;

/**
 * The Tailscale node a device asked from. A token is accepted only in requests from the node it
 * was approved on; one approved in a local request has none and is accepted only in local requests.
 */
export const TailscaleIdentity = Schema.Struct({
  /** Tailscale's stable node ID, which survives renames and address changes. */
  nodeId: Schema.String,
  nodeName: Schema.String,
  owner: TailscaleOwner,
});
export type TailscaleIdentity = typeof TailscaleIdentity.Type;

/** An approved device, as the hub keeps it. Its token is never part of it: only its hash is stored. */
export class Device extends Schema.Class<Device>("Device")({
  id: DeviceId,
  /** Untrusted text the device chose, cleaned by `deviceName`; always shown as plain text. */
  name: Schema.String,
  kind: DeviceKind,
  platform: Schema.String,
  tailscale: Schema.NullOr(TailscaleIdentity),
  approvedAt: Schema.String,
  /** Written at most once a minute while the device is used. */
  lastActiveAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
}) {}

/**
 * Where a pairing request stands. A pending request past its expiry is expired, whatever its row
 * says; `claimed` means the device took its token and the pairing secret stopped working.
 */
export const PairingState = Schema.Literals(["pending", "allowed", "denied", "claimed"]);
export type PairingState = typeof PairingState.Type;

/** A device asking to pair. Its pairing secret is never part of it: only its hash is stored. */
export class PairingRequest extends Schema.Class<PairingRequest>("PairingRequest")({
  id: Schema.String,
  /** Six digits the device and the hub both show, so the user can match the two screens. Not a secret. */
  code: Schema.String,
  name: Schema.String,
  kind: PairingKind,
  platform: Schema.String,
  tailscale: Schema.NullOr(TailscaleIdentity),
  state: PairingState,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  /** The device Allow created; null until then. */
  deviceId: Schema.NullOr(DeviceId),
}) {}

/** The prefixes of the hub's own secrets, which the hub redacts wherever they appear (ADR 021). */
export const DEVICE_TOKEN_PREFIX = "hbd_";
export const PAIRING_SECRET_PREFIX = "hbp_";
export const WINDOW_KEY_PREFIX = "hbw_";

/** A pairing request lasts this long, unless the user decides later (#339). */
export const PAIRING_LIFETIME_MS = 10 * 60 * 1000;

const NAME_LIMIT = 64;

/**
 * A device's name as the hub keeps it: control characters removed, spaces trimmed, at most 64
 * characters. Empty when nothing is left, so the caller can refuse it.
 */
export const deviceName = (raw: string): string => {
  const printable = Array.from(raw)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("")
    .trim();
  // By code point, so a name is never cut inside a character.
  return Array.from(printable).slice(0, NAME_LIMIT).join("").trim();
};

/**
 * True for a request still open whose time has run out at `now`: a pending one can no longer be
 * allowed, and an allowed one can no longer be claimed.
 */
export const pairingExpired = (request: PairingRequest, now: string): boolean =>
  (request.state === "pending" || request.state === "allowed") && request.expiresAt <= now;
