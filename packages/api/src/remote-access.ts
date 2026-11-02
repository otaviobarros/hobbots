import { HubPort, RemoteAccessStatus } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/**
 * A change to remote access; fields left out keep their value. A new port moves the hub's loopback
 * and tailnet listeners to it at once, and clients follow the `RemoteAccessChanged` event (ADR 021).
 */
export const UpdateRemoteAccessPayload = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  // Pause remote access in the menu-bar icon, and Resume. Pausing revokes no device.
  paused: Schema.optionalKey(Schema.Boolean),
  // Ports below 1024 need system privileges the hub does not have.
  port: Schema.optionalKey(HubPort),
  // HTTPS through `tailscale serve`: opens or closes the hub's serve listener. It never runs
  // `tailscale serve` itself; that takes the user's consent (`serve` below).
  https: Schema.optionalKey(Schema.Boolean),
});
export type UpdateRemoteAccessPayload = typeof UpdateRemoteAccessPayload.Type;

/** The hub could not open the new port, so nothing changed. `detail` says why, such as another program using it. */
export class PortUnavailable extends Schema.TaggedError<PortUnavailable>()(
  "PortUnavailable",
  { port: Schema.Int, detail: Schema.String },
  { httpApiStatus: 409 },
) {}

/**
 * Runs `tailscale serve` in the background on the hub, after the user consented in Settings:
 * `forward` serves the hub over HTTPS on its MagicDNS name, and false removes that (ADR 021).
 */
export const ServePayload = Schema.Struct({ forward: Schema.Boolean });

/** `tailscale serve` did not run or refused; `detail` gives Tailscale's words. */
export class ServeFailed extends Schema.TaggedError<ServeFailed>()(
  "ServeFailed",
  { detail: Schema.String },
  { httpApiStatus: 502 },
) {}

export class RemoteAccessGroup extends HttpApiGroup.make("remoteAccess")
  .add(
    HttpApiEndpoint.get("get", "/remote-access", { success: RemoteAccessStatus }),
    HttpApiEndpoint.patch("update", "/remote-access", {
      payload: UpdateRemoteAccessPayload,
      success: RemoteAccessStatus,
      error: PortUnavailable,
    }),
    HttpApiEndpoint.post("serve", "/remote-access/serve", {
      payload: ServePayload,
      success: RemoteAccessStatus,
      error: ServeFailed,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
