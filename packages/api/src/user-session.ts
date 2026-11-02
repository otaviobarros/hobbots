import type { DeviceId, DeviceKind } from "@hobbots/domain";
import { Context, type Effect, Schema } from "effect";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";

/** A device that was revoked: it decides nothing, and its requests are refused (ADR 021). */
export class DeviceRevoked extends Schema.TaggedError<DeviceRevoked>()(
  "DeviceRevoked",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/**
 * The person using Hobbots, behind a request from an approved device (PE-006, ADR 015, ADR 021).
 * Only the hub's device middleware provides it, so a hob, a Charm or a runtime tool, which has no
 * device token, has no way to decide a request, save a grant or remove one: the services that do
 * require it.
 */
export class UserSession extends Context.Service<
  UserSession,
  {
    readonly deviceId: DeviceId;
    readonly name: string;
    readonly kind: DeviceKind;
    /**
     * Runs a write in one transaction that first checks the device is still approved, so a decision
     * that raced a Revoke is refused instead of saved.
     */
    readonly whileApproved: <A, E, R>(write: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DeviceRevoked, R>;
  }
>()("@hobbots/api/UserSession") {}

/** A request without a device token the hub accepts here: none, an unknown one, or one from another place. */
export class DeviceRequired extends Schema.TaggedError<DeviceRequired>()(
  "DeviceRequired",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/**
 * A request carrying the device cookie that another page could have sent: a change without its own
 * `Origin`, or a read the browser marks cross-site or same-site (ADR 021).
 */
export class ForeignOrigin extends Schema.TaggedError<ForeignOrigin>()(
  "ForeignOrigin",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** The browser's device cookie over plain HTTP. Page scripts never see it, and it never goes in a URL. */
export const DeviceCookie = HttpApiSecurity.apiKey({ key: "hobbots_device", in: "cookie" });

/** The browser's device cookie over HTTPS through `tailscale serve`, `Secure` and bound to its host. */
export const SecureDeviceCookie = HttpApiSecurity.apiKey({ key: "__Host-hobbots_device", in: "cookie" });

/** A pairing secret a waiting browser holds as a cookie until its token is handed over. */
export const PairingCookie = HttpApiSecurity.apiKey({ key: "hobbots_pairing", in: "cookie" });

/**
 * A device token or the window key sent by the desktop app's main process, the allow command and
 * tests. A web page cannot attach it to a request, so it skips the `Origin` check.
 */
export const DeviceBearer = HttpApiSecurity.bearer;

/**
 * Admits only approved devices to a route and provides `UserSession` to it. Every group carries it
 * except the health endpoint and the routes a device uses to ask for pairing, and the event stream
 * runs the same check.
 */
export class DeviceSession extends HttpApiMiddleware.Service<DeviceSession, { provides: UserSession }>()(
  "@hobbots/api/DeviceSession",
  { error: [DeviceRequired, DeviceRevoked, ForeignOrigin] },
) {}
