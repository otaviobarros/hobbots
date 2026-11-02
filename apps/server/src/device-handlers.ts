import { DeviceService } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/**
 * The approved devices, and Revoke (ADR 021), from any approved device (PE-006). The event stream
 * closes a revoked device's connections when it hears the device's DeviceRevoked event.
 */
export const DevicesHandlers = HttpApiBuilder.group(HobbotsApi, "devices", (handlers) =>
  Effect.gen(function* () {
    const devices = yield* DeviceService;
    return handlers.handleAll({
      list: () => devices.list,
      revoke: ({ params }) => devices.revoke(params.deviceId),
    });
  }),
);
