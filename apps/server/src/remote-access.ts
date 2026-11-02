import type { Socket } from "node:net";
import { NodeHttpServerRequest } from "@effect/platform-node";
import { HobbotsApi, PortUnavailable, type UpdateRemoteAccessPayload } from "@hobbots/api";
import type { RemoteAccessStatus, TailscaleStatus } from "@hobbots/domain";
import { HubHosts } from "@hobbots/permissions";
import { Cache, Context, Effect, Exit, Layer, Option, Ref, Schedule, Semaphore } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { type TailnetPeer, TailnetPeers } from "./devices.ts";
import { EventBus } from "./event-bus.ts";
import { arrivedOnTailnet, HubListeners, type ListenFailure } from "./listeners.ts";
import { writeNetworkSettings } from "./network-settings.ts";
import { Tailscale } from "./tailscale.ts";
import { UserSessionOnlyLive } from "./user-session.ts";

/**
 * Remote access (ADR 021): while it is on, the hub asks Tailscale every 10 seconds where it is on
 * the tailnet and listens there beside loopback. When Tailscale stops, loses the hub's addresses or
 * remote access turns off, the hub closes its tailnet listeners and their connections, and the
 * status says why. Tailscale's settings are only read, never changed.
 */

/** How often the hub asks Tailscale while remote access is on. */
const CHECK_EVERY = "10 seconds";
/** How long the hub trusts `tailscale whois` about a peer that `tailscale status` still lists. */
const WHOIS_FOR = "1 minute";

/** The hub's remote access as last seen, shared by the routes, the checks and the sandbox's blocked hosts. */
export class RemoteAccessState extends Context.Service<RemoteAccessState, Ref.Ref<RemoteAccessStatus>>()(
  "@hobbots/server/RemoteAccessState",
) {}

export const RemoteAccessStateLive = (start: { readonly enabled: boolean; readonly port: number }) =>
  Layer.effect(
    RemoteAccessState,
    Ref.make<RemoteAccessStatus>({
      enabled: start.enabled,
      port: start.port,
      tailscale: null,
      listening: [],
      problem: start.enabled ? null : "off",
      detail: null,
    }),
  );

/** The hub's names on the tailnet that Tailscale reported: its addresses and its MagicDNS name. */
const hubHostsOf = (status: RemoteAccessStatus): ReadonlyArray<string> =>
  status.tailscale === null
    ? []
    : [...status.tailscale.addresses, ...(status.tailscale.dnsName === null ? [] : [status.tailscale.dnsName])];

/** The hub's own tailnet names, for the sandbox and web tools to block and the host check to accept. */
export const HubHostsLive = Layer.effect(
  HubHosts,
  Effect.map(RemoteAccessState, (state) => ({ current: Effect.map(Ref.get(state), hubHostsOf) })),
);

/**
 * What the hub listens on, given the setting and what Tailscale reports: a pure function, so every
 * reason can be tested without a tailnet.
 */
export const remoteAccessStatus = (input: {
  readonly enabled: boolean;
  readonly port: number;
  readonly tailscale: TailscaleStatus | null;
  readonly listening: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<ListenFailure>;
}): RemoteAccessStatus => {
  const { enabled, port, tailscale, listening, failed } = input;
  const base = { enabled, port, tailscale, listening, detail: null };
  if (!enabled) return { ...base, listening: [], problem: "off" };
  if (tailscale === null || tailscale.state !== "running") return { ...base, problem: "tailscale" };
  if (tailscale.addresses.length === 0) return { ...base, problem: "noAddress" };
  const failure = failed[0];
  if (failure !== undefined) {
    return { ...base, problem: "cannotListen", detail: `${failure.address}:${port}: ${failure.detail}` };
  }
  return { ...base, problem: null };
};

/** What the log says when the hub starts or stops listening on its tailnet. */
const listeningChange = (before: RemoteAccessStatus, after: RemoteAccessStatus): string | null => {
  const was = before.listening.join(", ");
  const now = after.listening.join(", ");
  if (was === now && before.port === after.port) return null;
  if (now !== "") return `Listening on the tailnet at ${now}, port ${after.port}`;
  if (was === "") return null;
  return `Stopped listening on the tailnet (${after.problem ?? "no address"})`;
};

export class RemoteAccess extends Context.Service<
  RemoteAccess,
  {
    /** Remote access now. While it is off, it asks Tailscale once, so Settings can say what turning it on would find. */
    readonly status: Effect.Effect<RemoteAccessStatus>;
    readonly update: (change: UpdateRemoteAccessPayload) => Effect.Effect<RemoteAccessStatus, PortUnavailable>;
    /** Asks Tailscale now and listens where it says, as the 10 second check does. */
    readonly check: Effect.Effect<RemoteAccessStatus>;
  }
>()("@hobbots/server/RemoteAccess") {}

/**
 * The connection's socket, when the request came over Node's HTTP server; a request from a web
 * handler, as in tests, has none and counts as local.
 */
const socketOf = (request: HttpServerRequest.HttpServerRequest): Socket | undefined =>
  (NodeHttpServerRequest.toIncomingMessage(request) as { readonly socket?: Socket } | undefined)?.socket;

/**
 * Remote access, and who a tailnet request comes from. The settings are kept in the data folder;
 * every check and change runs one at a time, so the listeners always match the last one.
 */
export const RemoteAccessLive = (dataDir: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const state = yield* RemoteAccessState;
      const tailscale = yield* Tailscale;
      const listeners = yield* HubListeners;
      const bus = yield* EventBus;
      const oneAtATime = yield* Semaphore.make(1);
      const whois = yield* Cache.make({ lookup: tailscale.whois, capacity: 1024, timeToLive: WHOIS_FOR });

      const settle = (next: RemoteAccessStatus) =>
        Effect.gen(function* () {
          const before = yield* Ref.getAndSet(state, next);
          const change = listeningChange(before, next);
          if (change !== null) yield* Effect.log(change);
          if (JSON.stringify(before) !== JSON.stringify(next)) {
            yield* bus.publishTransient({ _tag: "RemoteAccessChanged", status: next });
          }
          return next;
        });

      // Answers that no longer hold are dropped before their minute is up: who a peer was once
      // `tailscale status` no longer lists it, and that Tailscale did not know a peer it now lists.
      const forget = (peers: ReadonlySet<string>) =>
        Cache.keys(whois).pipe(
          Effect.flatMap((addresses) =>
            Effect.forEach(
              addresses,
              (address) =>
                peers.has(address)
                  ? Cache.invalidateWhen(whois, address, Option.isNone)
                  : Cache.invalidate(whois, address),
              { discard: true },
            ),
          ),
        );

      const reconcile = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const port = yield* listeners.port;
        if (!current.enabled) {
          yield* listeners.listenOnTailnet([]);
          yield* Cache.invalidateAll(whois);
          return yield* settle(remoteAccessStatus({ ...current, port, listening: [], failed: [] }));
        }
        const snapshot = yield* tailscale.snapshot;
        yield* forget(snapshot.peers);
        const wanted = snapshot.status.state === "running" ? snapshot.status.addresses : [];
        const { listening, failed } = yield* listeners.listenOnTailnet(wanted);
        return yield* settle(
          remoteAccessStatus({ enabled: true, port, tailscale: snapshot.status, listening, failed }),
        );
      }).pipe(oneAtATime.withPermits(1));

      const change = (change: UpdateRemoteAccessPayload) =>
        Effect.gen(function* () {
          if (change.port !== undefined) {
            const port = change.port;
            yield* listeners.movePort(port).pipe(Effect.mapError((detail) => new PortUnavailable({ port, detail })));
            yield* Effect.log(`Moved the hub to port ${port}`);
          }
          if (change.enabled !== undefined) {
            const enabled = change.enabled;
            yield* Ref.update(state, (status) => ({ ...status, enabled }));
          }
          writeNetworkSettings(dataDir, {
            ...(change.enabled === undefined ? {} : { remoteAccess: change.enabled }),
            ...(change.port === undefined ? {} : { port: change.port }),
          });
        }).pipe(oneAtATime.withPermits(1));

      // The listeners and the status follow whatever the change did, also when saving it failed.
      const update = (payload: UpdateRemoteAccessPayload) =>
        Effect.gen(function* () {
          const changed = yield* Effect.exit(change(payload));
          const status = yield* reconcile;
          if (Exit.isFailure(changed)) return yield* Effect.failCause(changed.cause);
          return status;
        });

      const status = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.enabled) return current;
        const snapshot = yield* tailscale.snapshot;
        return yield* Ref.updateAndGet(state, (status) =>
          status.enabled ? status : { ...status, tailscale: snapshot.status },
        );
      });

      yield* reconcile.pipe(Effect.repeat(Schedule.spaced(CHECK_EVERY)), Effect.forkScoped);

      const peerOf = (request: HttpServerRequest.HttpServerRequest) => {
        const socket = socketOf(request);
        if (!arrivedOnTailnet(socket)) return Effect.succeedNone;
        return Cache.get(whois, socket?.remoteAddress ?? "");
      };

      return Context.make(RemoteAccess, RemoteAccess.of({ status, update, check: reconcile })).pipe(
        Context.add(TailnetPeers, TailnetPeers.of({ peerOf })),
        Context.add(TailnetRequests, { peerOf, arrivedOnTailnet: (request) => arrivedOnTailnet(socketOf(request)) }),
      );
    }),
  );

/** Whether a request came in on a tailnet listener, and who Tailscale says sent it. */
class TailnetRequests extends Context.Service<
  TailnetRequests,
  {
    readonly arrivedOnTailnet: (request: HttpServerRequest.HttpServerRequest) => boolean;
    readonly peerOf: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Option.Option<TailnetPeer>>;
  }
>()("@hobbots/server/TailnetRequests") {}

/**
 * A check on every request that came in on the tailnet, before any route runs: it answers the
 * refusal, or None to let the request through. Local requests pass untouched.
 */
const tailnetCheck = (
  refusal: (
    request: HttpServerRequest.HttpServerRequest,
    requests: TailnetRequests["Service"],
  ) => Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>>,
) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const requests = yield* TailnetRequests;
      return (effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!requests.arrivedOnTailnet(request)) return yield* effect;
          const refused = yield* refusal(request, requests);
          return Option.isSome(refused) ? refused.value : yield* effect;
        });
    }),
    { global: true },
  );

/** Refuses a tailnet request from a peer Tailscale does not know. */
export const KnownTailnetPeersOnly = tailnetCheck((request, requests) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* requests.peerOf(request))) return Option.none();
    yield* Effect.logWarning(`Refused ${request.method} ${request.url}: Tailscale does not know this peer`).pipe(
      Effect.annotateLogs({ event: "tailnet-peer-unknown", peer: socketOf(request)?.remoteAddress ?? null }),
    );
    return Option.some(HttpServerResponse.text("Tailscale does not know this device.", { status: 403 }));
  }),
);

/**
 * Refuses every request that came in on the tailnet until devices can pair with the hub (#338): a
 * tailnet browser would otherwise pass the origin check and act as the user. Device tokens replace
 * it.
 */
export const TailnetClosedUntilPairing = tailnetCheck(() =>
  Effect.succeed(Option.some(HttpServerResponse.text("This device is not paired with Hobbots yet.", { status: 403 }))),
);

/** A hub without listeners of its own, as in tests, has remote access off and keeps it off. */
const WITHOUT_REMOTE_ACCESS: RemoteAccessStatus = {
  enabled: false,
  port: 0,
  tailscale: null,
  listening: [],
  problem: "off",
  detail: null,
};

export const RemoteAccessHandlers = HttpApiBuilder.group(HobbotsApi, "remoteAccess", (handlers) =>
  Effect.gen(function* () {
    const access = yield* Effect.serviceOption(RemoteAccess);
    const status = Option.match(access, {
      onNone: () => Effect.succeed(WITHOUT_REMOTE_ACCESS),
      onSome: (access) => access.status,
    });
    return handlers.handleAll({
      get: () => status,
      update: ({ payload }) =>
        Option.match(access, { onNone: () => status, onSome: (access) => access.update(payload) }),
    });
  }),
).pipe(Layer.provide(UserSessionOnlyLive));
