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
  // Ports below 1024 need system privileges the hub does not have.
  port: Schema.optionalKey(HubPort),
});
export type UpdateRemoteAccessPayload = typeof UpdateRemoteAccessPayload.Type;

/** The hub could not open the new port, so nothing changed. `detail` says why, such as another program using it. */
export class PortUnavailable extends Schema.TaggedError<PortUnavailable>()(
  "PortUnavailable",
  { port: Schema.Int, detail: Schema.String },
  { httpApiStatus: 409 },
) {}

export class RemoteAccessGroup extends HttpApiGroup.make("remoteAccess")
  .add(
    HttpApiEndpoint.get("get", "/remote-access", { success: RemoteAccessStatus }),
    HttpApiEndpoint.patch("update", "/remote-access", {
      payload: UpdateRemoteAccessPayload,
      success: RemoteAccessStatus,
      error: PortUnavailable,
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
