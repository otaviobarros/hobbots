import { PairingKind, PairingRequest, PairingState } from "@hobbots/domain";
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
 * browser, in `token` for the desktop app.
 */
export const PairingStatus = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  state: Schema.Union([PairingState, Schema.Literal("expired")]),
  expiresAt: Schema.String,
  token: Schema.optionalKey(Schema.String),
});
export type PairingStatus = typeof PairingStatus.Type;

/** A new pairing request; the desktop app gets its pairing secret here, a browser as a cookie. */
export const OpenedPairing = Schema.Struct({
  status: PairingStatus,
  secret: Schema.optionalKey(Schema.String),
});

/** The name left nothing to show once cleaned, or the hub already holds as many open requests as it keeps. */
export class PairingRefused extends Schema.TaggedError<PairingRefused>()(
  "PairingRefused",
  { reason: Schema.Literals(["name", "full"]) },
  { httpApiStatus: 422 },
) {}

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
      error: [PairingRefused, ForeignOrigin],
    }),
    // The device asks every 2 seconds; the secret comes as the pairing cookie or a bearer token.
    HttpApiEndpoint.get("status", "/pairing", {
      success: PairingStatus,
      error: [PairingNotFound, ForeignOrigin],
    }),
  )
  .prefix("/api") {}

/** Deciding who may pair, which needs an approved device (PE-006). */
export class PairingRequestsGroup extends HttpApiGroup.make("pairingRequests")
  .add(
    // The requests still waiting, oldest first.
    HttpApiEndpoint.get("list", "/pairing/requests", { success: Schema.Array(PairingRequest) }),
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
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
