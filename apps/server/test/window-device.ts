import { DeviceService } from "@hobbots/agents";
import { DeviceRepositoryLive } from "@hobbots/persistence";
import { Layer } from "effect";
import {
  DeviceGate,
  DeviceSecretsLive,
  InProcessRequests,
  knownWindowKey,
  LocalPeers,
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
    Layer.provideMerge(DeviceRepositoryLive),
    Layer.provideMerge(peers),
    Layer.provideMerge(Layer.succeed(InProcessRequests, true)),
  );

export const TestDevices = testDevicesWith(LocalPeers);
