import { isIP, type Socket } from "node:net";
import { HobbotsApi, PortUnavailable, ServeFailed, type UpdateRemoteAccessPayload } from "@hobbots/api";
import {
  type HttpsStatus,
  httpsAddress,
  type RemoteAccessStatus,
  SERVE_OFF_ARGS,
  serveOnArgs,
  type TailscaleStatus,
  tailscaleCommand,
} from "@hobbots/domain";
import { HubHosts } from "@hobbots/permissions";
import { Cache, Context, Effect, Exit, Layer, Option, Ref, Schedule, Semaphore } from "effect";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { arrivedOnTailnet, arrivedThroughServe, socketOf } from "./arrival.ts";
import { type TailnetPeer, TailnetPeers } from "./devices.ts";
import { EventBus } from "./event-bus.ts";
import { HubListeners, type ListenFailure } from "./listeners.ts";
import { writeNetworkSettings } from "./network-settings.ts";
import { forwardsTo, Tailscale } from "./tailscale.ts";

/**
 * Remote access (ADR 021): while it is on, the hub asks Tailscale every 10 seconds where it is on
 * the tailnet and listens there beside loopback. When Tailscale stops, loses the hub's addresses, or
 * remote access turns off or is paused, the hub closes its tailnet listeners and their connections,
 * and the status says why. Loopback is never affected. Tailscale's settings are only read, except
 * that the hub runs `tailscale serve` for HTTPS when the user consents in Settings.
 *
 * HTTPS (ADR 021): while it is on and remote access is on and not paused, the hub opens its serve
 * listener on loopback, which `tailscale serve` forwards to. Every request there is a tailnet
 * request, and only there does the hub read the identity headers Tailscale adds.
 */

/** How often the hub asks Tailscale while remote access is on. */
const CHECK_EVERY = "10 seconds";
/** How long the hub trusts `tailscale whois` about a peer that `tailscale status` still lists. */
const WHOIS_FOR = "1 minute";

/** The hub's remote access as last seen, shared by the routes, the checks and the sandbox's blocked hosts. */
export class RemoteAccessState extends Context.Service<RemoteAccessState, Ref.Ref<RemoteAccessStatus>>()(
  "@hobbots/server/RemoteAccessState",
) {}

export const RemoteAccessStateLive = (start: {
  readonly enabled: boolean;
  readonly paused?: boolean;
  readonly port: number;
  readonly https?: boolean;
  readonly servePort: number;
}) =>
  Layer.effect(
    RemoteAccessState,
    Ref.make<RemoteAccessStatus>({
      enabled: start.enabled,
      paused: start.paused ?? false,
      port: start.port,
      tailscale: null,
      listening: [],
      problem: start.enabled ? (start.paused ? "paused" : null) : "off",
      detail: null,
      https: { enabled: start.https ?? false, port: start.servePort, listening: false, forwarding: null, detail: null },
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
  readonly paused: boolean;
  readonly port: number;
  readonly tailscale: TailscaleStatus | null;
  readonly listening: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<ListenFailure>;
  readonly https: HttpsStatus;
}): RemoteAccessStatus => {
  const { enabled, paused, port, tailscale, listening, failed, https } = input;
  const base = { enabled, paused, port, tailscale, listening, detail: null, https };
  if (!enabled) return { ...base, listening: [], problem: "off" };
  if (paused) return { ...base, listening: [], problem: "paused" };
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
    /**
     * `from` is the connection the change came in on, when it came through `tailscale serve`: a
     * change that closes the serve listener keeps it for its answer (see `HubListeners.serveOn`).
     */
    readonly update: (
      change: UpdateRemoteAccessPayload,
      from?: Socket,
    ) => Effect.Effect<RemoteAccessStatus, PortUnavailable>;
    /** Asks Tailscale now and listens where it says, as the 10 second check does. */
    readonly check: Effect.Effect<RemoteAccessStatus>;
    /**
     * Runs `tailscale serve` after the user consented in Settings: to forward HTTPS to the serve
     * listener, or to remove that again. Fails with Tailscale's words.
     */
    readonly serve: (forward: boolean) => Effect.Effect<RemoteAccessStatus, ServeFailed>;
  }
>()("@hobbots/server/RemoteAccess") {}

/**
 * The one address `X-Forwarded-For` names, as `tailscale serve` sets it: never a list, and never
 * anything but an address Tailscale's peers come from.
 */
const forwardedFor = (request: HttpServerRequest.HttpServerRequest, isTailnetAddress: (address: string) => boolean) => {
  const addresses = (request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
  const [address] = addresses;
  return addresses.length === 1 && address !== undefined && isIP(address) !== 0 && isTailnetAddress(address)
    ? Option.some(address)
    : Option.none();
};

/**
 * Whether `Tailscale-User-Login`, when Tailscale sent it, names the peer's owner. Tailscale sends it
 * only for a node a person owns, and encodes a login that is not plain ASCII (RFC 2047), which the
 * hub leaves unchecked: `whois` already named the node.
 */
const loginMatches = (login: string | undefined, peer: TailnetPeer) => {
  if (login === undefined || login.startsWith("=?")) return true;
  return peer.owner._tag === "User" && peer.owner.login === login;
};

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
      // The hub's own node, while remote access is on; tailnet requests arrive only then.
      const hub = yield* Ref.make(Option.none<TailnetPeer>());

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

      // Whether `tailscale serve` forwards to the serve listener, as Tailscale says now; null when it cannot say.
      const forwarding = (servePort: number) =>
        Effect.map(
          tailscale.served,
          Option.match({ onNone: () => null, onSome: (routes) => forwardsTo(routes, servePort) }),
        );

      // The serve listener is open only while HTTPS and remote access are on and not paused.
      const reconcileHttps = (current: RemoteAccessStatus, watching: boolean, spare: Socket | undefined) =>
        Effect.gen(function* () {
          const open = current.enabled && !current.paused && current.https.enabled;
          const serve = yield* listeners.serveOn(open ? current.https.port : null, spare);
          // While remote access is off the hub stops watching Tailscale, and keeps the last answer.
          const forwards = watching ? yield* forwarding(current.https.port) : current.https.forwarding;
          return { ...current.https, listening: serve.listening, detail: serve.detail, forwarding: forwards };
        });

      const reconcileFor = (spare?: Socket) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const port = yield* listeners.port;
          if (!current.enabled) {
            yield* listeners.listenOnTailnet([]);
            const https = yield* reconcileHttps(current, false, spare);
            yield* Cache.invalidateAll(whois);
            yield* Ref.set(hub, Option.none());
            return yield* settle(remoteAccessStatus({ ...current, port, listening: [], failed: [], https }));
          }
          const snapshot = yield* tailscale.snapshot;
          yield* forget(snapshot.peers);
          yield* Ref.set(hub, Option.fromNullishOr(snapshot.self));
          // Paused, the hub still watches Tailscale, so Settings can say what Resume would find.
          const wanted = snapshot.status.state === "running" && !current.paused ? snapshot.status.addresses : [];
          const { listening, failed } = yield* listeners.listenOnTailnet(wanted);
          const https = yield* reconcileHttps(current, true, spare);
          return yield* settle(
            remoteAccessStatus({
              enabled: true,
              paused: current.paused,
              port,
              tailscale: snapshot.status,
              listening,
              failed,
              https,
            }),
          );
        }).pipe(oneAtATime.withPermits(1));
      const reconcile = reconcileFor();

      // A new port moves every listener but the serve listener, whose port it may not take.
      const movePort = (port: number) =>
        Effect.gen(function* () {
          if (port === (yield* Ref.get(state)).https.port) {
            return yield* new PortUnavailable({ port, detail: "Hobbots uses it for HTTPS through Tailscale" });
          }
          yield* listeners.movePort(port).pipe(Effect.mapError((detail) => new PortUnavailable({ port, detail })));
          yield* Effect.log(`Moved the hub to port ${port}`);
        });

      const setHttps = (https: boolean) =>
        Effect.gen(function* () {
          const before = yield* Ref.getAndUpdate(state, (status) => ({
            ...status,
            https: { ...status.https, enabled: https },
          }));
          if (before.https.enabled !== https) yield* Effect.log(https ? "Turned HTTPS on" : "Turned HTTPS off");
          // The serve port is kept once HTTPS is on, so `tailscale serve` keeps forwarding to it.
          return https ? { https, servePort: before.https.port } : { https };
        });

      const change = (change: UpdateRemoteAccessPayload) =>
        Effect.gen(function* () {
          if (change.port !== undefined) yield* movePort(change.port);
          if (change.enabled !== undefined) {
            const enabled = change.enabled;
            yield* Ref.update(state, (status) => ({ ...status, enabled }));
          }
          // Turning remote access on in Settings also resumes it, unless the change says otherwise.
          const resumes = change.enabled === true && (yield* Ref.get(state)).paused;
          const paused = change.paused ?? (resumes ? false : undefined);
          if (paused !== undefined) {
            const before = yield* Ref.getAndUpdate(state, (status) => ({ ...status, paused }));
            if (before.paused !== paused) yield* Effect.log(paused ? "Paused remote access" : "Resumed remote access");
          }
          const https = change.https === undefined ? {} : yield* setHttps(change.https);
          writeNetworkSettings(dataDir, {
            ...(change.enabled === undefined ? {} : { remoteAccess: change.enabled }),
            ...(paused === undefined ? {} : { remoteAccessPaused: paused }),
            ...(change.port === undefined ? {} : { port: change.port }),
            ...https,
          });
        }).pipe(oneAtATime.withPermits(1));

      // The listeners and the status follow whatever the change did, also when saving it failed.
      const update = (payload: UpdateRemoteAccessPayload, from?: Socket) =>
        Effect.gen(function* () {
          const changed = yield* Effect.exit(change(payload));
          const status = yield* reconcileFor(from);
          if (Exit.isFailure(changed)) return yield* Effect.failCause(changed.cause);
          return status;
        });

      // Off, the hub asks Tailscale only when asked, so Settings can say what turning it on would
      // find, and whether `tailscale serve` still forwards to the hub.
      const status = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.enabled) return current;
        const snapshot = yield* tailscale.snapshot;
        const forwards = yield* forwarding(current.https.port);
        return yield* Ref.updateAndGet(state, (status) =>
          status.enabled
            ? status
            : { ...status, tailscale: snapshot.status, https: { ...status.https, forwarding: forwards } },
        );
      });

      const serve = (forward: boolean) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const args = forward ? serveOnArgs(current.https.port) : SERVE_OFF_ARGS;
          yield* Effect.log(`Running ${tailscaleCommand(args)}, as the user asked in Settings`);
          yield* tailscale.serve(args).pipe(
            Effect.tapError((detail) => Effect.logWarning(`${tailscaleCommand(args)} failed: ${detail}`)),
            Effect.mapError((detail) => new ServeFailed({ detail })),
          );
          yield* reconcile;
          return yield* status;
        });

      yield* reconcile.pipe(Effect.repeat(Schedule.spaced(CHECK_EVERY)), Effect.forkScoped);

      const peerOf = (request: HttpServerRequest.HttpServerRequest) => {
        const socket = socketOf(request);
        if (arrivedThroughServe(socket)) {
          // Only here do the headers `tailscale serve` sets count; Tailscale replaces any a client sent.
          return Option.match(forwardedFor(request, tailscale.isTailnetAddress), {
            onNone: () => Effect.succeedNone,
            onSome: (address) =>
              Effect.map(
                Cache.get(whois, address),
                Option.filter((peer) => loginMatches(request.headers["tailscale-user-login"], peer)),
              ),
          });
        }
        if (!arrivedOnTailnet(socket)) return Effect.succeedNone;
        return Cache.get(whois, socket?.remoteAddress ?? "");
      };
      const remote = (request: HttpServerRequest.HttpServerRequest) => {
        const socket = socketOf(request);
        return arrivedOnTailnet(socket) || arrivedThroughServe(socket);
      };

      return Context.make(RemoteAccess, RemoteAccess.of({ status, update, check: reconcile, serve })).pipe(
        Context.add(TailnetPeers, TailnetPeers.of({ peerOf, remote, hub: Ref.get(hub) })),
        Context.add(TailnetRequests, { peerOf, arrivedOnTailnet: remote, status: Ref.get(state) }),
      );
    }),
  );

/** Whether a request came in on a tailnet listener or through `tailscale serve`, and who Tailscale says sent it. */
class TailnetRequests extends Context.Service<
  TailnetRequests,
  {
    readonly arrivedOnTailnet: (request: HttpServerRequest.HttpServerRequest) => boolean;
    readonly peerOf: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Option.Option<TailnetPeer>>;
    /** Remote access as last seen, for where a page load goes while Tailscale serves the hub over HTTPS. */
    readonly status: Effect.Effect<RemoteAccessStatus>;
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

const PAGE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Where a page load on the tailnet's plain HTTP address goes while Tailscale serves the hub over
 * HTTPS (ADR 021), or none: API requests, the event stream included, keep working on HTTP, so
 * bearer requests from a connected desktop are never redirected.
 */
const httpsRedirect = (request: HttpServerRequest.HttpServerRequest, status: RemoteAccessStatus) => {
  const address = httpsAddress(status);
  if (address === null || !arrivedOnTailnet(socketOf(request)) || !PAGE_METHODS.has(request.method)) {
    return Option.none();
  }
  const path = request.url.startsWith("/") ? request.url : "/";
  if (path === "/api" || path.startsWith("/api/") || path.startsWith("/api?")) return Option.none();
  return Option.some(`${address}${path}`);
};

/**
 * Refuses a tailnet request from a peer Tailscale does not know, a request through `tailscale
 * serve` that does not name exactly one peer, and sends page loads on the tailnet's HTTP address
 * to the HTTPS one while Tailscale serves it.
 */
export const KnownTailnetPeersOnly = tailnetCheck((request, requests) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* requests.peerOf(request))) {
      return Option.map(httpsRedirect(request, yield* requests.status), (location) =>
        HttpServerResponse.redirect(location, { status: 307 }),
      );
    }
    yield* Effect.logWarning(`Refused ${request.method} ${request.url}: Tailscale does not know this peer`).pipe(
      Effect.annotateLogs({
        event: "tailnet-peer-unknown",
        peer: socketOf(request)?.remoteAddress ?? null,
        forwardedFor: request.headers["x-forwarded-for"] ?? null,
      }),
    );
    return Option.some(HttpServerResponse.text("Tailscale does not know this device.", { status: 403 }));
  }),
);

/**
 * Refuses any request that `tailscale funnel` brought in from the internet (ADR 021). Hobbots never
 * runs funnel, but someone could turn it on by hand for the hub's HTTPS address.
 */
export const NoFunnelRequests = HttpRouter.middleware(
  Effect.succeed((effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers["tailscale-funnel-request"] === undefined) return yield* effect;
      yield* Effect.logWarning(`Refused ${request.method} ${request.url}: it came through Tailscale Funnel`).pipe(
        Effect.annotateLogs({ event: "funnel-refused" }),
      );
      return HttpServerResponse.text("Hobbots is never served on the public internet.", { status: 403 });
    }),
  ),
  { global: true },
);

/** A hub without listeners of its own, as in tests, has remote access off and keeps it off. */
const WITHOUT_REMOTE_ACCESS: RemoteAccessStatus = {
  enabled: false,
  paused: false,
  port: 0,
  tailscale: null,
  listening: [],
  problem: "off",
  detail: null,
  https: { enabled: false, port: 0, listening: false, forwarding: null, detail: null },
};

/**
 * Applies a change from the request under way. One that came through `tailscale serve` keeps its
 * connection for its answer and closes it after, so turning HTTPS off from the HTTPS address still
 * tells the page the new status, and the page moves to the HTTP address (ADR 021).
 */
export const updateFromRequest = (access: RemoteAccess["Service"], payload: UpdateRemoteAccessPayload) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = socketOf(request);
    if (!arrivedThroughServe(socket)) return yield* access.update(payload);
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, "connection", "close")),
    );
    return yield* access.update(payload, socket);
  });

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
        Option.match(access, { onNone: () => status, onSome: (access) => updateFromRequest(access, payload) }),
      serve: ({ payload }) =>
        Option.match(access, {
          onNone: () => Effect.fail(new ServeFailed({ detail: "This hub has no remote access." })),
          onSome: (access) => access.serve(payload.forward),
        }),
    });
  }),
);
