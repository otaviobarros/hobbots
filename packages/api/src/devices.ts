import { Device, DeviceId, PairingKind, PairingRequest, PairingState } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession, ForeignOrigin } from "./user-session.ts";

/** A device asks to pair: what to call it, what it runs on, and whether it is the Hobbots app or a browser. */
export const OpenPairingPayload = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(256)),
  platform: Schema.String.check(Schema.isMaxLength(64)),
  kind: PairingKind,
});
export type OpenPairingPayload = typeof OpenPairingPayload.Type;

/**
 * Where a device's pairing request stands, as the waiting device sees it. `expired` once its time
 * ran out undecided. The device token comes only once, after Allow: as the device cookie for a
 * browser, in `token` and with `deviceId` for the desktop app.
 */
export const PairingStatus = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  state: Schema.Union([PairingState, Schema.Literal("expired")]),
  expiresAt: Schema.String,
  token: Schema.optionalKey(Schema.String),
  /** The new device's ID, with the token, so the desktop app can revoke itself on Disconnect (ADR 025). */
  deviceId: Schema.optionalKey(DeviceId),
});
export type PairingStatus = typeof PairingStatus.Type;

/** A new pairing request; the desktop app gets its pairing secret here, a browser as a cookie. */
export const OpenedPairing = Schema.Struct({
  status: PairingStatus,
  secret: Schema.optionalKey(Schema.String),
});

/**
 * Why the hub opened no request: the name left nothing to show once cleaned, the hub already holds
 * as many open requests as it keeps, or the device is not one of the hub owner's own on Tailscale
 * (ADR 021).
 */
export class PairingRefused extends Schema.TaggedError<PairingRefused>()(
  "PairingRefused",
  { reason: Schema.Literals(["name", "full", "notYours"]) },
  { httpApiStatus: 422 },
) {}

/**
 * Over one of the pairing limits (ADR 021): nothing was created, and no prompt shows. The answer
 * also carries `Retry-After`.
 */
export class PairingThrottled extends Schema.TaggedError<PairingThrottled>()(
  "PairingThrottled",
  { retryAfterSeconds: Schema.Int },
  { httpApiStatus: 429 },
) {}

/**
 * A device waiting for the user's answer, as the hub's prompt, Needs you and Settings › Devices
 * show it. `fromHub` when it asked from the hub itself: locally, or from the hub's own Tailscale node.
 */
export const WaitingDevice = Schema.Struct({ request: PairingRequest, fromHub: Schema.Boolean });
export type WaitingDevice = typeof WaitingDevice.Type;

/** No pairing request answers to the secret the device presented, or none was presented. */
export class PairingNotFound extends Schema.TaggedError<PairingNotFound>()(
  "PairingNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** The request was decided already, or its time ran out, so it can no longer be allowed or denied. */
export class PairingClosed extends Schema.TaggedError<PairingClosed>()(
  "PairingClosed",
  { state: Schema.Union([PairingState, Schema.Literal("expired")]) },
  { httpApiStatus: 409 },
) {}

/**
 * A device without a token asks to pair and waits (ADR 021). These routes need no device: the
 * pairing secret, never the matching code, is what claims the token.
 */
export class PairingGroup extends HttpApiGroup.make("pairing")
  .add(
    HttpApiEndpoint.post("open", "/pairing", {
      payload: OpenPairingPayload,
      success: OpenedPairing,
      error: [PairingRefused, PairingThrottled, ForeignOrigin],
    }),
    // The device asks every 2 seconds; the secret comes as the pairing cookie or a bearer token.
    HttpApiEndpoint.get("status", "/pairing", {
      success: PairingStatus,
      error: [PairingNotFound, PairingThrottled, ForeignOrigin],
    }),
  )
  .prefix("/api") {}

/** Deciding who may pair, which needs an approved device (PE-006). */
export class PairingRequestsGroup extends HttpApiGroup.make("pairingRequests")
  .add(
    // The requests still waiting, deferred ones included, oldest first.
    HttpApiEndpoint.get("list", "/pairing/requests", { success: Schema.Array(WaitingDevice) }),
    HttpApiEndpoint.post("allow", "/pairing/requests/:requestId/allow", {
      params: { requestId: Schema.String },
      success: PairingRequest,
      error: [PairingNotFound, PairingClosed],
    }),
    HttpApiEndpoint.post("deny", "/pairing/requests/:requestId/deny", {
      params: { requestId: Schema.String },
      success: PairingRequest,
      error: [PairingNotFound, PairingClosed],
    }),
    // Decide later: the request leaves the prompt and waits in Settings › Devices for 24 hours from when it was opened.
    HttpApiEndpoint.post("later", "/pairing/requests/:requestId/later", {
      params: { requestId: Schema.String },
      success: PairingRequest,
      error: [PairingNotFound, PairingClosed],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}

/** No device has this id. */
export class DeviceNotFound extends Schema.TaggedError<DeviceNotFound>()(
  "DeviceNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** The hub's window is never revoked: quitting the hub ends its key, and the next start writes another. */
export class CannotRevokeWindow extends Schema.TaggedError<CannotRevokeWindow>()(
  "CannotRevokeWindow",
  {},
  { httpApiStatus: 409 },
) {}

/** The approved devices, and Revoke (ADR 021), which needs an approved device (PE-006). */
export class DevicesGroup extends HttpApiGroup.make("devices")
  .add(
    // Every device, the hub's window first and then oldest first, revoked ones included.
    HttpApiEndpoint.get("list", "/devices", { success: Schema.Array(Device) }),
    HttpApiEndpoint.post("revoke", "/devices/:deviceId/revoke", {
      params: { deviceId: DeviceId },
      success: Device,
      error: [DeviceNotFound, CannotRevokeWindow],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
