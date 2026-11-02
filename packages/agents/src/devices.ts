import {
  CannotRevokeWindow,
  DeviceNotFound,
  DeviceRequired,
  DeviceRevoked,
  type OpenPairingPayload,
  PairingClosed,
  PairingNotFound,
  PairingRefused,
  type PairingStatus,
  PairingThrottled,
  UserSession,
  type WaitingDevice,
} from "@hobbots/api";
import {
  type Committed,
  DEVICE_TOKEN_PREFIX,
  Device,
  DeviceId,
  deviceName,
  PAIRING_DEFERRED_MS,
  PAIRING_LIFETIME_MS,
  PAIRING_SECRET_PREFIX,
  PairingRequest,
  pairingExpired,
  type TailscaleIdentity,
  WINDOW_DEVICE_ID,
  WINDOW_KEY_PREFIX,
} from "@hobbots/domain";
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Semaphore } from "effect";
import { EventPublisher } from "./ports.ts";

/**
 * Where a request reached the hub (ADR 021): a local request on loopback, or a tailnet request
 * from a Tailscale node. A token is accepted only where it was approved.
 */
export type DevicePlace = { readonly _tag: "Local" } | { readonly _tag: "Tailnet"; readonly peer: TailscaleIdentity };

export const LOCAL: DevicePlace = { _tag: "Local" };

const nodeOf = (place: DevicePlace) => (place._tag === "Tailnet" ? place.peer.nodeId : null);

/** Runs a write only while a device is still approved, as a user session's `whileApproved` does. */
export type WriteGuard<X = DeviceRevoked> = <A, E, R>(write: Effect.Effect<A, E, R>) => Effect.Effect<A, E | X, R>;

/** The hub's own writes, such as an expiry, need no device. */
export const unguarded: WriteGuard<never> = (write) => write;

/** The devices and pairing requests the hub keeps (migration 0029), with only hashes of their secrets. */
export class DeviceRepository extends Context.Service<
  DeviceRepository,
  {
    readonly findByTokenHash: (hash: string) => Effect.Effect<Option.Option<Device>>;
    readonly find: (id: DeviceId) => Effect.Effect<Option.Option<Device>>;
    /** Every device, the hub's window first and then oldest first. */
    readonly list: Effect.Effect<ReadonlyArray<Device>>;
    /** Adds the hub's window when the installation has none yet; it keeps one for good. */
    readonly ensureWindow: (at: string) => Effect.Effect<void>;
    readonly touch: (id: DeviceId, at: string) => Effect.Effect<void>;
    /**
     * Marks a device revoked with its DeviceRevoked event, in one transaction that first checks, and
     * on PostgreSQL locks, the revoking device `by` and the target's rows, in one order, before the
     * journal: a decision the target already started is saved first. None when there is no such
     * device, it was already revoked, or it is the hub's window, which is never revoked.
     */
    readonly revoke: (
      id: DeviceId,
      by: DeviceId,
      at: string,
    ) => Effect.Effect<Option.Option<Committed<Device>>, DeviceRevoked>;
    /**
     * Runs `write` in one transaction that first checks, and on PostgreSQL locks, the device's row,
     * so a Revoke either lands before and refuses it, or waits until it is saved.
     */
    readonly whileApproved: (id: DeviceId) => WriteGuard;
    /** Stores a new request with its PairingRequested event. */
    readonly openPairing: (request: PairingRequest, secretHash: string) => Effect.Effect<Committed<PairingRequest>>;
    readonly findPairing: (id: string) => Effect.Effect<Option.Option<PairingRequest>>;
    readonly findPairingBySecret: (hash: string) => Effect.Effect<Option.Option<PairingRequest>>;
    /** Pending requests whose time has not run out at `now`, oldest first. */
    readonly listOpenPairing: (now: string) => Effect.Effect<ReadonlyArray<PairingRequest>>;
    /**
     * Moves a pending request that has not expired at `now` to allowed and creates its device, in one
     * transaction with its PairingChanged event. Each pairing change below journals the same way, and
     * none changes anything when the request no longer stands as it expects.
     */
    readonly allowPairing: (
      id: string,
      device: Device,
      now: string,
    ) => Effect.Effect<Option.Option<Committed<PairingRequest>>>;
    readonly denyPairing: (id: string, now: string) => Effect.Effect<Option.Option<Committed<PairingRequest>>>;
    /** Moves a pending request's expiry later, to `expiresAt`: Decide later. */
    readonly deferPairing: (
      id: string,
      expiresAt: string,
      now: string,
    ) => Effect.Effect<Option.Option<Committed<PairingRequest>>>;
    /** Moves an allowed request to claimed and gives its device the token's hash; none when it was claimed already. */
    readonly claimPairing: (
      id: string,
      tokenHash: string,
      now: string,
    ) => Effect.Effect<Option.Option<Committed<PairingRequest>>>;
  }
>()("@hobbots/agents/DeviceRepository") {}

/** The hub's secrets, from the system's secure random source, and their SHA-256 hashes. */
export class DeviceSecrets extends Context.Service<
  DeviceSecrets,
  {
    /** `prefix` and 32 random bytes in base64url. */
    readonly generate: (prefix: string) => Effect.Effect<string>;
    /** The SHA-256 hash of a secret, as lowercase hex: all the hub ever stores of it. */
    readonly hash: (secret: string) => Effect.Effect<string>;
    /** Six random digits. */
    readonly code: Effect.Effect<string>;
  }
>()("@hobbots/agents/DeviceSecrets") {}

/**
 * Counts requests against a limit by key, in a fixed window (ADR 021): over it, `PairingThrottled`
 * with how long to wait. The hub keeps the counts in memory.
 */
export class PairingLimiter extends Context.Service<
  PairingLimiter,
  {
    readonly consume: (key: string, limit: number, window: Duration.Duration) => Effect.Effect<void, PairingThrottled>;
  }
>()("@hobbots/agents/PairingLimiter") {}

/** The hash of the window key this start of the hub wrote; only the hub's window can read the key. */
export class WindowKey extends Context.Service<WindowKey, { readonly hash: string }>()("@hobbots/agents/WindowKey") {}

/** The most open pairing requests the hub keeps at once (ADR 021). */
export const MAX_OPEN_PAIRING = 20;

/**
 * The pairing limits of ADR 021, keyed by the Tailscale node a request comes from, or by "this
 * computer" for a local one. Anything over a limit creates nothing.
 */
export const PAIRING_LIMITS = {
  /** Open requests per key, deferred ones included. */
  openPerKey: 3,
  /** New requests per key in `newWindow`. */
  newPerKey: 5,
  newWindow: Duration.minutes(10),
  /** How long a key waits to ask again after a Deny. */
  afterDeny: Duration.minutes(1),
  /** Status checks per request per second. */
  statusPerSecond: 1,
  /** Requests a tailnet node without a device may make a minute, pairing and health included. */
  anonymousPerMinute: 60,
} as const;

const ACTIVITY_INTERVAL_MS = 60_000;

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const statusOf = (request: PairingRequest, now: string, token?: string): PairingStatus => ({
  id: request.id,
  code: request.code,
  state: pairingExpired(request, now) ? "expired" : request.state,
  expiresAt: request.expiresAt,
  ...(token === undefined ? {} : { token }),
});

const samePlace = (approvedOn: string | null, place: DevicePlace) => approvedOn === nodeOf(place);

/** What the pairing limits count a request against: its Tailscale node, or this computer. */
const limitKey = (place: DevicePlace) => (place._tag === "Tailnet" ? `node:${place.peer.nodeId}` : "local");

const keyOfRequest = (request: PairingRequest) =>
  request.tailscale === null ? "local" : `node:${request.tailscale.nodeId}`;

/**
 * Who may ask (ADR 021): a local request always may; a tailnet device only when the same Tailscale
 * user as the hub owns it. A tagged node, or another user's, may not.
 */
export const mayAsk = (place: DevicePlace, hub: Option.Option<TailscaleIdentity>): boolean => {
  if (place._tag === "Local") return true;
  const owner = place.peer.owner;
  return Option.exists(
    hub,
    (self) => owner._tag === "User" && self.owner._tag === "User" && owner.login === self.owner.login,
  );
};

/** Whether a request came from the hub itself: locally, or from the hub's own Tailscale node. */
export const fromHub = (request: PairingRequest, hub: Option.Option<TailscaleIdentity>): boolean =>
  request.tailscale === null || Option.exists(hub, (self) => self.nodeId === request.tailscale?.nodeId);

const seconds = (duration: Duration.Duration) => Math.max(1, Math.ceil(Duration.toSeconds(duration)));

/** A refusal over a pairing limit, saying how long to wait in whole seconds. */
export const throttled = (retryAfter: Duration.Duration) =>
  new PairingThrottled({ retryAfterSeconds: seconds(retryAfter) });

/** What a device presents when it asks: where it is, and the pairing secret it already holds, if any. */
export interface PairingAsker {
  readonly place: DevicePlace;
  /** The hub's own Tailscale node, while it knows it, for who may ask. */
  readonly hub: Option.Option<TailscaleIdentity>;
  /** A pairing secret the device already holds: asking again with it returns the same request. */
  readonly secret: Option.Option<string>;
}

/**
 * Devices and pairing (ADR 021, DP-004). Every request names a device by its token; the hub's
 * window by the key the hub writes on each start. A device without a token asks to pair, and the
 * user allows it once from a device that already has one.
 */
export class DeviceService extends Context.Service<
  DeviceService,
  {
    /**
     * The approved device a token names in a request from `place`. Unknown, missing or from another
     * place: `DeviceRequired`. Revoked: `DeviceRevoked`.
     */
    readonly authenticate: (token: string, place: DevicePlace) => Effect.Effect<Device, DeviceRequired | DeviceRevoked>;
    /**
     * Opens a pairing request and returns it with the secret that alone can claim its token. A
     * device that asks again with the secret of a request still open gets that request back.
     */
    readonly openPairing: (
      payload: OpenPairingPayload,
      asker: PairingAsker,
    ) => Effect.Effect<{ readonly status: PairingStatus; readonly secret: string }, PairingRefused | PairingThrottled>;
    /**
     * Where the request the secret names stands, from where it was opened. Once allowed, the first
     * call hands out the device token and the secret stops working. Only a secret whose request still
     * waits, or is just allowed, is spared the node's limit for requests without a device: an unknown,
     * misplaced, claimed, denied or expired one counts against it.
     */
    readonly pairingStatus: (
      secret: string,
      place: DevicePlace,
    ) => Effect.Effect<PairingStatus, PairingNotFound | PairingThrottled>;
    /** The requests still waiting, deferred ones included, oldest first. */
    readonly listOpenPairing: (hub: Option.Option<TailscaleIdentity>) => Effect.Effect<ReadonlyArray<WaitingDevice>>;
    /**
     * Counts a request from a tailnet node that has no device yet, such as a health check, against
     * the node's limit; local requests are never counted.
     */
    readonly throttleAnonymous: (place: DevicePlace) => Effect.Effect<void, PairingThrottled>;
    /**
     * Only the user decides who may pair (PE-006): it needs a `UserSession`, which no hob, Charm or
     * runtime tool has.
     */
    readonly allow: (
      id: string,
    ) => Effect.Effect<PairingRequest, PairingNotFound | PairingClosed | DeviceRevoked, UserSession>;
    readonly deny: (
      id: string,
    ) => Effect.Effect<PairingRequest, PairingNotFound | PairingClosed | DeviceRevoked, UserSession>;
    /** Decide later: keeps the request open 24 hours from when it was opened, out of the prompt. */
    readonly later: (
      id: string,
    ) => Effect.Effect<PairingRequest, PairingNotFound | PairingClosed | DeviceRevoked, UserSession>;
    /** Every device, the hub's window first and then oldest first, revoked ones included. */
    readonly list: Effect.Effect<ReadonlyArray<Device>>;
    /**
     * Revokes a device for good (ADR 021): its next request is refused as revoked, and its open event
     * streams close. Only the user does it (PE-006), from any approved device, the one in use
     * included. A device already revoked is answered as it is. The hub's window cannot be revoked.
     */
    readonly revoke: (
      id: DeviceId,
    ) => Effect.Effect<Device, DeviceNotFound | CannotRevokeWindow | DeviceRevoked, UserSession>;
  }
>()("@hobbots/agents/DeviceService") {
  static readonly layer = Layer.effect(
    DeviceService,
    Effect.gen(function* () {
      const repo = yield* DeviceRepository;
      const publisher = yield* EventPublisher;
      const secrets = yield* DeviceSecrets;
      const window = yield* WindowKey;
      const limiter = yield* PairingLimiter;
      // When each key may ask again after a Deny, in milliseconds.
      const deniedUntil = new Map<string, number>();
      const announce = <A>(committed: Committed<A>) => Effect.as(publisher.publish(committed.entries), committed.value);
      const consume = (key: string, limit: number, window: Duration.Input) =>
        limiter.consume(key, limit, Duration.fromInputUnsafe(window));
      yield* repo.ensureWindow(yield* nowIso);
      const windowDevice = Option.getOrThrow(yield* repo.find(WINDOW_DEVICE_ID));
      // Opening is one step at a time, so the open-request limits are checked against the requests
      // already saved: two devices asking at once cannot both pass with the last free place.
      const opening = yield* Semaphore.make(1);
      // When each device's last activity was written, so it is written at most once a minute.
      const touched = new Map<DeviceId, number>();

      const touch = (device: Device) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (now - (touched.get(device.id) ?? 0) < ACTIVITY_INTERVAL_MS) return;
          touched.set(device.id, now);
          yield* repo.touch(device.id, DateTime.formatIso(DateTime.makeUnsafe(now)));
        });

      const required = new DeviceRequired({ message: "This device is not approved on this hub." });

      const authenticate = (token: string, place: DevicePlace) =>
        Effect.gen(function* () {
          if (token.startsWith(WINDOW_KEY_PREFIX)) {
            // The window key is accepted only in local requests.
            if (place._tag === "Local" && (yield* secrets.hash(token)) === window.hash) return windowDevice;
            return yield* required;
          }
          if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return yield* required;
          const found = yield* repo.findByTokenHash(yield* secrets.hash(token));
          if (Option.isNone(found)) return yield* required;
          const device = found.value;
          if (device.revokedAt !== null) {
            return yield* new DeviceRevoked({ message: "This device was removed from this hub." });
          }
          if (!samePlace(device.tailscale?.nodeId ?? null, place)) return yield* required;
          yield* touch(device);
          return device;
        });

      const uniqueCode = (open: ReadonlyArray<PairingRequest>): Effect.Effect<string> =>
        Effect.flatMap(secrets.code, (code) =>
          open.some((request) => request.code === code) ? uniqueCode(open) : Effect.succeed(code),
        );

      // The request a secret names while it still waits, from the place it was opened.
      const openWithSecret = (secret: Option.Option<string>, place: DevicePlace, at: string) =>
        Effect.gen(function* () {
          if (Option.isNone(secret) || !secret.value.startsWith(PAIRING_SECRET_PREFIX)) return Option.none();
          const found = yield* repo.findPairingBySecret(yield* secrets.hash(secret.value));
          return Option.filter(
            found,
            (request) =>
              request.state === "pending" &&
              !pairingExpired(request, at) &&
              samePlace(request.tailscale?.nodeId ?? null, place),
          );
        });

      const checkLimits = (key: string, open: ReadonlyArray<PairingRequest>) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const until = deniedUntil.get(key) ?? 0;
          if (until > now) return yield* throttled(Duration.millis(until - now));
          if (open.length >= MAX_OPEN_PAIRING) return yield* new PairingRefused({ reason: "full" });
          if (open.filter((request) => keyOfRequest(request) === key).length >= PAIRING_LIMITS.openPerKey) {
            return yield* throttled(Duration.millis(PAIRING_LIFETIME_MS));
          }
          yield* consume(`pairing:new:${key}`, PAIRING_LIMITS.newPerKey, PAIRING_LIMITS.newWindow);
        });

      const openPairing = (payload: OpenPairingPayload, { place, hub, secret: held }: PairingAsker) =>
        Effect.gen(function* () {
          if (!mayAsk(place, hub)) return yield* new PairingRefused({ reason: "notYours" });
          const now = yield* DateTime.now;
          const at = DateTime.formatIso(now);
          const again = yield* openWithSecret(held, place, at);
          if (Option.isSome(again) && Option.isSome(held)) {
            return { status: statusOf(again.value, at), secret: held.value };
          }
          const name = deviceName(payload.name);
          if (name === "") return yield* new PairingRefused({ reason: "name" });
          return yield* Semaphore.withPermit(opening, create(name, payload, place, now));
        });

      // Checks the limits against the requests saved now and saves the new one, under `opening`.
      const create = (name: string, payload: OpenPairingPayload, place: DevicePlace, now: DateTime.Utc) =>
        Effect.gen(function* () {
          const at = DateTime.formatIso(now);
          const open = yield* repo.listOpenPairing(at);
          yield* checkLimits(limitKey(place), open);
          const secret = yield* secrets.generate(PAIRING_SECRET_PREFIX);
          const request = new PairingRequest({
            id: crypto.randomUUID(),
            code: yield* uniqueCode(open),
            name,
            kind: payload.kind,
            platform: deviceName(payload.platform),
            tailscale: place._tag === "Tailnet" ? place.peer : null,
            state: "pending",
            createdAt: at,
            expiresAt: DateTime.formatIso(DateTime.add(now, { milliseconds: PAIRING_LIFETIME_MS })),
            decidedAt: null,
            deviceId: null,
          });
          const opened = yield* announce(yield* repo.openPairing(request, yield* secrets.hash(secret)));
          return { status: statusOf(opened, at), secret };
        });

      const throttleAnonymous = (place: DevicePlace) =>
        place._tag === "Local"
          ? Effect.void
          : consume(`pairing:anonymous:${limitKey(place)}`, PAIRING_LIMITS.anonymousPerMinute, "1 minute");

      const pairingStatus = (secret: string, place: DevicePlace) =>
        Effect.gen(function* () {
          const missing = new PairingNotFound();
          // A missing, malformed, unknown or misplaced secret is a request without a device, so it counts
          // against the node's limit; only a secret that names a request from here is spared (ADR 021).
          const unknown = Effect.andThen(throttleAnonymous(place), Effect.fail(missing));
          if (!secret.startsWith(PAIRING_SECRET_PREFIX)) return yield* unknown;
          const found = yield* repo.findPairingBySecret(yield* secrets.hash(secret));
          if (Option.isNone(found) || !samePlace(found.value.tailscale?.nodeId ?? null, place)) {
            return yield* unknown;
          }
          const request = found.value;
          const now = yield* nowIso;
          // Only a device still waiting is held to one check a second; a decision is always answered.
          if (request.state === "pending" && !pairingExpired(request, now)) {
            yield* consume(`pairing:status:${request.id}`, PAIRING_LIMITS.statusPerSecond, "1 second");
          }
          // A claimed secret stopped working: it is refused, and counted, like an unknown one.
          if (request.state === "claimed") return yield* unknown;
          // An allowed request is claimed within its lifetime too, so an old secret never turns into a token.
          if (request.state !== "allowed" || pairingExpired(request, now)) {
            // Denied or expired, the answer no longer changes, so asking again counts like any request
            // without a device; only a request still waiting is spared.
            if (request.state !== "pending" || pairingExpired(request, now)) yield* throttleAnonymous(place);
            return statusOf(request, now);
          }
          const token = yield* secrets.generate(DEVICE_TOKEN_PREFIX);
          const claimed = yield* repo.claimPairing(request.id, yield* secrets.hash(token), now);
          // Another status call claimed it first: only one of them gets the token.
          if (Option.isNone(claimed)) return yield* unknown;
          return statusOf(yield* announce(claimed.value), now, token);
        });

      const decide = (id: string, decision: "allow" | "deny" | "later") =>
        Effect.gen(function* () {
          const session = yield* UserSession;
          const found = yield* repo.findPairing(id);
          if (Option.isNone(found)) return yield* new PairingNotFound();
          const request = found.value;
          const now = yield* nowIso;
          if (request.state !== "pending" || pairingExpired(request, now)) {
            return yield* new PairingClosed({ state: pairingExpired(request, now) ? "expired" : request.state });
          }
          const write = () => {
            switch (decision) {
              case "allow":
                return repo.allowPairing(
                  id,
                  new Device({
                    id: DeviceId.make(crypto.randomUUID()),
                    name: request.name,
                    kind: request.kind,
                    platform: request.platform,
                    tailscale: request.tailscale,
                    approvedAt: now,
                    lastActiveAt: null,
                    revokedAt: null,
                  }),
                  now,
                );
              case "deny":
                return repo.denyPairing(id, now);
              default: {
                const until = DateTime.add(DateTime.makeUnsafe(request.createdAt), {
                  milliseconds: PAIRING_DEFERRED_MS,
                });
                return repo.deferPairing(id, DateTime.formatIso(until), now);
              }
            }
          };
          const saved = yield* session.whileApproved(write());
          // Decided or expired meanwhile. Deciding later twice leaves it as the first time did.
          if (Option.isNone(saved)) {
            if (decision !== "later") return yield* new PairingClosed({ state: "expired" });
            return Option.getOrElse(yield* repo.findPairing(id), () => request);
          }
          if (decision === "deny") {
            const millis = yield* Clock.currentTimeMillis;
            deniedUntil.set(keyOfRequest(request), millis + Duration.toMillis(PAIRING_LIMITS.afterDeny));
          }
          return yield* announce(saved.value);
        });

      const revoke = (id: DeviceId) =>
        Effect.gen(function* () {
          const session = yield* UserSession;
          if (id === WINDOW_DEVICE_ID) return yield* new CannotRevokeWindow();
          const found = yield* repo.find(id);
          if (Option.isNone(found)) return yield* new DeviceNotFound();
          if (found.value.revokedAt !== null) return found.value;
          // Checked in the same transaction, so a device revoked meanwhile revokes nothing.
          const saved = yield* repo.revoke(id, session.deviceId, yield* nowIso);
          if (Option.isNone(saved)) return Option.getOrElse(yield* repo.find(id), () => found.value);
          yield* publisher.publish(saved.value.entries);
          return saved.value.value;
        });

      return DeviceService.of({
        authenticate,
        openPairing,
        pairingStatus,
        listOpenPairing: (hub) =>
          nowIso.pipe(
            Effect.flatMap(repo.listOpenPairing),
            Effect.map((open) => open.map((request) => ({ request, fromHub: fromHub(request, hub) }))),
          ),
        throttleAnonymous,
        allow: (id) => decide(id, "allow"),
        deny: (id) => decide(id, "deny"),
        later: (id) => decide(id, "later"),
        list: repo.list,
        revoke,
      });
    }),
  );
}
