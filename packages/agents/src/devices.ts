import {
  DeviceRequired,
  DeviceRevoked,
  type OpenPairingPayload,
  PairingClosed,
  PairingNotFound,
  PairingRefused,
  type PairingStatus,
  UserSession,
} from "@hobbots/api";
import {
  DEVICE_TOKEN_PREFIX,
  Device,
  DeviceId,
  deviceName,
  PAIRING_LIFETIME_MS,
  PAIRING_SECRET_PREFIX,
  PairingRequest,
  pairingExpired,
  type TailscaleIdentity,
  WINDOW_DEVICE_ID,
  WINDOW_KEY_PREFIX,
} from "@hobbots/domain";
import { Clock, Context, DateTime, Effect, Layer, Option } from "effect";

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
    /** Marks a device revoked; none when there is no such device or it was already revoked. */
    readonly revoke: (id: DeviceId, at: string) => Effect.Effect<Option.Option<Device>>;
    /**
     * Runs `write` in one transaction that first checks, and on PostgreSQL locks, the device's row,
     * so a Revoke either lands before and refuses it, or waits until it is saved.
     */
    readonly whileApproved: (id: DeviceId) => WriteGuard;
    readonly openPairing: (request: PairingRequest, secretHash: string) => Effect.Effect<void>;
    readonly findPairing: (id: string) => Effect.Effect<Option.Option<PairingRequest>>;
    readonly findPairingBySecret: (hash: string) => Effect.Effect<Option.Option<PairingRequest>>;
    /** Pending requests whose time has not run out at `now`, oldest first. */
    readonly listOpenPairing: (now: string) => Effect.Effect<ReadonlyArray<PairingRequest>>;
    /** Moves a pending request that has not expired at `now` to allowed and creates its device, in one transaction. */
    readonly allowPairing: (id: string, device: Device, now: string) => Effect.Effect<Option.Option<PairingRequest>>;
    readonly denyPairing: (id: string, now: string) => Effect.Effect<Option.Option<PairingRequest>>;
    /** Moves an allowed request to claimed and gives its device the token's hash; none when it was claimed already. */
    readonly claimPairing: (id: string, tokenHash: string) => Effect.Effect<Option.Option<PairingRequest>>;
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

/** The hash of the window key this start of the hub wrote; only the hub's window can read the key. */
export class WindowKey extends Context.Service<WindowKey, { readonly hash: string }>()("@hobbots/agents/WindowKey") {}

/** The most open pairing requests the hub keeps at once (ADR 021). */
export const MAX_OPEN_PAIRING = 20;

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
    /** Opens a pairing request and returns it with the secret that alone can claim its token. */
    readonly openPairing: (
      payload: OpenPairingPayload,
      place: DevicePlace,
    ) => Effect.Effect<{ readonly status: PairingStatus; readonly secret: string }, PairingRefused>;
    /**
     * Where the request the secret names stands, from where it was opened. Once allowed, the first
     * call hands out the device token and the secret stops working.
     */
    readonly pairingStatus: (secret: string, place: DevicePlace) => Effect.Effect<PairingStatus, PairingNotFound>;
    readonly listOpenPairing: Effect.Effect<ReadonlyArray<PairingRequest>>;
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
  }
>()("@hobbots/agents/DeviceService") {
  static readonly layer = Layer.effect(
    DeviceService,
    Effect.gen(function* () {
      const repo = yield* DeviceRepository;
      const secrets = yield* DeviceSecrets;
      const window = yield* WindowKey;
      yield* repo.ensureWindow(yield* nowIso);
      const windowDevice = Option.getOrThrow(yield* repo.find(WINDOW_DEVICE_ID));
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

      const openPairing = (payload: OpenPairingPayload, place: DevicePlace) =>
        Effect.gen(function* () {
          const name = deviceName(payload.name);
          if (name === "") return yield* new PairingRefused({ reason: "name" });
          const now = yield* DateTime.now;
          const at = DateTime.formatIso(now);
          const open = yield* repo.listOpenPairing(at);
          if (open.length >= MAX_OPEN_PAIRING) return yield* new PairingRefused({ reason: "full" });
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
          yield* repo.openPairing(request, yield* secrets.hash(secret));
          return { status: statusOf(request, at), secret };
        });

      const pairingStatus = (secret: string, place: DevicePlace) =>
        Effect.gen(function* () {
          const missing = new PairingNotFound();
          if (!secret.startsWith(PAIRING_SECRET_PREFIX)) return yield* missing;
          const found = yield* repo.findPairingBySecret(yield* secrets.hash(secret));
          // A secret from another place is refused like an unknown one.
          if (Option.isNone(found) || !samePlace(found.value.tailscale?.nodeId ?? null, place)) {
            return yield* missing;
          }
          const request = found.value;
          const now = yield* nowIso;
          if (request.state === "claimed") return yield* missing;
          // An allowed request is claimed within its lifetime too, so an old secret never turns into a token.
          if (request.state !== "allowed" || pairingExpired(request, now)) return statusOf(request, now);
          const token = yield* secrets.generate(DEVICE_TOKEN_PREFIX);
          const claimed = yield* repo.claimPairing(request.id, yield* secrets.hash(token));
          // Another status call claimed it first: only one of them gets the token.
          if (Option.isNone(claimed)) return yield* missing;
          return statusOf(claimed.value, now, token);
        });

      const decide = (id: string, decision: "allow" | "deny") =>
        Effect.gen(function* () {
          const session = yield* UserSession;
          const found = yield* repo.findPairing(id);
          if (Option.isNone(found)) return yield* new PairingNotFound();
          const request = found.value;
          const now = yield* nowIso;
          if (request.state !== "pending" || pairingExpired(request, now)) {
            return yield* new PairingClosed({ state: pairingExpired(request, now) ? "expired" : request.state });
          }
          const device = new Device({
            id: DeviceId.make(crypto.randomUUID()),
            name: request.name,
            kind: request.kind,
            platform: request.platform,
            tailscale: request.tailscale,
            approvedAt: now,
            lastActiveAt: null,
            revokedAt: null,
          });
          const saved = yield* session.whileApproved(
            decision === "allow" ? repo.allowPairing(id, device, now) : repo.denyPairing(id, now),
          );
          // Decided or expired meanwhile.
          if (Option.isNone(saved)) return yield* new PairingClosed({ state: "expired" });
          return saved.value;
        });

      return DeviceService.of({
        authenticate,
        openPairing,
        pairingStatus,
        listOpenPairing: Effect.flatMap(nowIso, repo.listOpenPairing),
        allow: (id) => decide(id, "allow"),
        deny: (id) => decide(id, "deny"),
      });
    }),
  );
}
