import { DeviceService } from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import { OWNER_ACTOR, OWNER_USER_ID, WINDOW_DEVICE_ID } from "@hobbots/domain";
import { DeviceRepositoryLive } from "@hobbots/persistence";
import { Effect, Layer } from "effect";
import {
  DeviceGate,
  DeviceSecretsLive,
  InProcessRequests,
  knownWindowKey,
  LocalPeers,
  PairingLimiterLive,
  type TailnetPeers,
} from "../src/devices.ts";

/** The window key tests send, as the desktop app's main process sends its own (ADR 021). */
export const TEST_WINDOW_KEY = `hbw_${"t".repeat(43)}`;

/** Headers that make a request the hub's window's. */
export const AS_WINDOW: Readonly<Record<string, string>> = { authorization: `Bearer ${TEST_WINDOW_KEY}` };

/**
 * The hub's device check over the test's own database, with in-process requests local and the
 * window key known. Provide it to `ApiRoutes` before the app, which holds the database.
 */
export const testDevicesWith = (peers: Layer.Layer<TailnetPeers>) =>
  DeviceGate.layer.pipe(
    Layer.provideMerge(DeviceService.layer),
    Layer.provideMerge(knownWindowKey(TEST_WINDOW_KEY)),
    Layer.provideMerge(DeviceSecretsLive),
    Layer.provideMerge(PairingLimiterLive),
    Layer.provideMerge(DeviceRepositoryLive),
    Layer.provideMerge(peers),
    Layer.provideMerge(Layer.succeed(InProcessRequests, true)),
  );

export const TestDevices = testDevicesWith(LocalPeers);

/** The owner on the hub's window, as the device middleware would name them, with no revoke to race. */
export const WINDOW_SESSION = UserSession.of({
  deviceId: WINDOW_DEVICE_ID,
  name: "This computer's Hobbots window",
  kind: "window",
  userId: OWNER_USER_ID,
  actor: OWNER_ACTOR,
  whileApproved: (write) => write,
});

/** Runs a person's command as the owner on the hub's window. */
export const asOwner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, UserSession, WINDOW_SESSION);
