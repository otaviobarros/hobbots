/**
 * This computer's Tailscale and keychain for a connected desktop (ADR 025), read through the same
 * services the hub uses: `tailscale` only to read, never to change its settings, and the device
 * token's keychain item. `HOBBOTS_FAKE_TAILSCALE=on` and `HOBBOTS_FAKE_KEYCHAIN=memory` swap in the
 * fakes, as on the hub. The hub's name is resolved from `tailscale status`, never from another resolver.
 */
import { isIP } from "node:net";
import { NodeServices } from "@effect/platform-node";
import { DeviceTokenKeychain, DeviceTokenKeychainLive, DeviceTokenKeychainMemory } from "@hobbots/server/device-token";
import {
  type AddressRefused,
  findHubs,
  type HubScan,
  type HubTarget,
  resolveHubAddress,
} from "@hobbots/server/hub-discovery";
import { type TailnetSnapshot, Tailscale, TailscaleFakeFile, TailscaleLive } from "@hobbots/server/tailscale";
import { Effect, Layer, ManagedRuntime, Option, Redacted, Result } from "effect";
import { FetchHttpClient } from "effect/http";
import { type HubNodeState, hubNodeState, type NodeLookup, type TailnetNode } from "./hub-connection.ts";

/** Where the device token lives: the keychain item, read and written as plain promises. */
export interface DeviceTokenStore {
  readonly read: () => Promise<string | undefined>;
  /** Keeps the token, or rejects with the keychain's reason; never writes a file. */
  readonly write: (token: string) => Promise<void>;
  /** Deletes the token, or rejects with the keychain's reason; a missing item counts as deleted. */
  readonly remove: () => Promise<void>;
}

/** A typed address as the hub it names, or why it was refused before any request (ADR 025). */
export type ResolvedAddress =
  | { readonly kind: "hub"; readonly target: HubTarget }
  | { readonly kind: "refused"; readonly refused: AddressRefused };

/** This computer's Tailscale, as connecting needs it. */
export interface ThisTailnet extends NodeLookup {
  /** This computer's own Tailscale user, or null when Tailscale is not running or signed in. */
  readonly ownLogin: () => Promise<string | null>;
  /** The Hobbots hubs on the user's own online computers, or why Tailscale could not be read. */
  readonly findHubs: () => Promise<HubScan>;
  /** What the user typed, completed from `tailscale status`, or why it is not one of their computers. */
  readonly resolveAddress: (typed: string) => Promise<ResolvedAddress>;
  /** What `tailscale status` says now: this computer's state and its peers. */
  readonly snapshot: () => Promise<TailnetSnapshot>;
  /** Whether Tailscale runs here and the hub's node is online, from a fresh `tailscale status`. */
  readonly nodeState: (nodeId: string) => Promise<HubNodeState>;
}

/**
 * The addresses a host has on the tailnet: a tailnet address is itself, and a MagicDNS name is the
 * node `tailscale status` lists under it, so no resolver outside Tailscale is asked.
 */
const tailnetAddresses = (
  nodes: ReadonlyArray<{ readonly nodeName: string; readonly addresses: ReadonlyArray<string> }>,
  host: string,
) => {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) return [bare];
  const name = bare.toLowerCase().replace(/\.$/, "");
  return nodes.find((node) => node.nodeName.toLowerCase() === name)?.addresses ?? [];
};

export interface TailnetOptions {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** What asks each computer for a hub's health answer; the platform's own unless a test gives one. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Builds the services once for the app's lifetime; `dispose` releases them on quit. */
export const thisComputer = ({ dataDir, env, platform, fetch }: TailnetOptions) => {
  const tailscale =
    env.HOBBOTS_FAKE_TAILSCALE === "on"
      ? TailscaleFakeFile(dataDir)
      : TailscaleLive(platform, env).pipe(Layer.provide(NodeServices.layer));
  const keychain =
    env.HOBBOTS_FAKE_KEYCHAIN === "memory"
      ? DeviceTokenKeychainMemory
      : DeviceTokenKeychainLive(platform, env).pipe(Layer.provide(NodeServices.layer));
  const http =
    fetch === undefined
      ? FetchHttpClient.layer
      : FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));
  const runtime = ManagedRuntime.make(Layer.mergeAll(tailscale, keychain, http));
  const readSnapshot = Tailscale.use((service) => service.snapshot);

  const snapshot = () => runtime.runPromise(readSnapshot);
  const tailnet: ThisTailnet = {
    snapshot,
    nodeState: async (nodeId) => hubNodeState(await snapshot(), nodeId),
    resolve: (host) =>
      runtime.runPromise(Effect.map(readSnapshot, (snapshot) => tailnetAddresses(snapshot.nodes, host))),
    whois: (address) =>
      runtime.runPromise(
        Effect.map(
          Tailscale.use((service) => service.whois(address)),
          (found) => Option.getOrNull(found as Option.Option<TailnetNode>),
        ),
      ),
    ownLogin: () =>
      runtime.runPromise(
        Effect.map(readSnapshot, (snapshot) =>
          snapshot.self?.owner._tag === "User" ? snapshot.self.owner.login : null,
        ),
      ),
    findHubs: () => runtime.runPromise(findHubs),
    resolveAddress: (typed) =>
      runtime.runPromise(
        Effect.map(readSnapshot, (snapshot) =>
          Result.match(resolveHubAddress(typed, snapshot), {
            onSuccess: (target): ResolvedAddress => ({ kind: "hub", target }),
            onFailure: (refused): ResolvedAddress => ({ kind: "refused", refused }),
          }),
        ),
      ),
  };

  const token: DeviceTokenStore = {
    read: () =>
      runtime.runPromise(
        DeviceTokenKeychain.use((item) => item.read).pipe(
          Effect.map((found) => Option.getOrUndefined(Option.map(found, Redacted.value))),
          // A keychain that cannot be read holds no token this app can use.
          Effect.orElseSucceed(() => undefined),
        ),
      ),
    write: (value) =>
      runtime.runPromise(
        DeviceTokenKeychain.use((item) => item.write(Redacted.make(value))).pipe(
          Effect.mapError((error) => new Error(error.message)),
        ),
      ),
    // A missing item counts as removed; any other failure reaches the caller, so Disconnect never
    // reports a token gone that is still in the keychain.
    remove: () =>
      runtime.runPromise(
        DeviceTokenKeychain.use((item) => item.remove).pipe(Effect.mapError((error) => new Error(error.message))),
      ),
  };

  return { tailnet, token, dispose: () => runtime.dispose() };
};
