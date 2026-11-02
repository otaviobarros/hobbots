import { DeviceRepository } from "@hobbots/agents";
import { DeviceSession, UserSession } from "@hobbots/api";
import { Effect, Layer } from "effect";
import { HttpServerRequest } from "effect/http";
import { DeviceGate } from "./devices.ts";

/**
 * Admits only approved devices to the routes behind it and gives each request the user session of
 * its device (ADR 021, PE-006). It is the only code that provides `UserSession`: a hob, a Charm or a
 * runtime tool has no device token, so it has no user session. Every refusal is logged with the
 * route and the peer, never the token.
 */
export const DeviceSessionLive = Layer.effect(
  DeviceSession,
  Effect.gen(function* () {
    const gate = yield* DeviceGate;
    const repo = yield* DeviceRepository;
    return DeviceSession.of((effect) =>
      Effect.gen(function* () {
        const device = yield* gate.admit(yield* HttpServerRequest.HttpServerRequest);
        return yield* Effect.provideService(effect, UserSession, {
          deviceId: device.id,
          name: device.name,
          kind: device.kind,
          whileApproved: repo.whileApproved(device.id),
        });
      }),
    );
  }),
);
