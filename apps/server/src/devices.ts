import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { type DevicePlace, DeviceSecrets, DeviceService, LOCAL, WindowKey } from "@hobbots/agents";
import {
  DeviceBearer,
  DeviceCookie,
  DeviceRequired,
  type DeviceRevoked,
  ForeignOrigin,
  SecureDeviceCookie,
} from "@hobbots/api";
import { DEVICE_TOKEN_PREFIX, type Device, type TailscaleOwner, WINDOW_KEY_PREFIX } from "@hobbots/domain";
import { Clock, Context, Effect, Layer, Option, Redacted } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";
import type { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { windowKeyFile } from "./window-key.ts";

/** Who owns a tailnet node: a Tailscale user, or the tags a tagged node carries instead. */
export type TailnetOwner = TailscaleOwner;

/** A Tailscale node, as `tailscale whois` names it (ADR 021). */
export interface TailnetPeer {
  /** Tailscale's stable ID for the node, which a device approved over the tailnet is bound to. */
  readonly nodeId: string;
  /** The node's MagicDNS name, without its trailing dot. */
  readonly nodeName: string;
  readonly owner: TailnetOwner;
}

/**
 * Where a request came from (ADR 021): Some for a tailnet request, with the peer Tailscale names,
 * and None for a local one. Which listener a connection arrived on decides it, not the peer's
 * address: the fake Tailscale serves its tailnet on loopback addresses. A peer Tailscale does not
 * know never gets this far; the hub answers it `403` first. Without this service the hub has only
 * loopback listeners, and a request from any other address is refused.
 */
export class TailnetPeers extends Context.Service<
  TailnetPeers,
  { readonly peerOf: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Option.Option<TailnetPeer>> }
>()("@hobbots/server/TailnetPeers") {}

/** No request comes from the tailnet, as on a hub with only loopback listeners. */
export const LocalPeers = Layer.succeed(TailnetPeers, { peerOf: () => Effect.succeedNone });

/**
 * Whether a request with no peer address at all counts as local. Only tests that call the routes
 * in process, with no connection, set it; a hub refuses such a request.
 */
export const InProcessRequests = Context.Reference<boolean>("@hobbots/server/InProcessRequests", {
  defaultValue: () => false,
});

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Where a request reached the hub, or none when it came from an address the hub does not serve. */
const placeOf = (
  peers: Option.Option<TailnetPeers["Service"]>,
  inProcess: boolean,
  request: HttpServerRequest.HttpServerRequest,
) => {
  // A request no tailnet peer claims is local only when it came over loopback, so a failed lookup
  // never makes a remote request local.
  const loopback = Option.match(request.peerAddress, {
    onNone: () => inProcess,
    onSome: (address) => LOOPBACK_ADDRESSES.has(address),
  });
  const local = loopback ? Option.some<DevicePlace>(LOCAL) : Option.none<DevicePlace>();
  return Option.match(peers, {
    onSome: (tailnet) =>
      Effect.map(
        tailnet.peerOf(request),
        Option.match({
          onNone: () => local,
          onSome: (peer): Option.Option<DevicePlace> => Option.some({ _tag: "Tailnet", peer }),
        }),
      ),
    onNone: () => Effect.succeed(local),
  });
};

const SECRET_BYTES = 32;

/** The hub's secrets from the system's secure random source (Web Crypto), and their SHA-256 hashes. */
export const DeviceSecretsLive = Layer.effect(
  DeviceSecrets,
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const digest = yield* Digest.Digest;
    return DeviceSecrets.of({
      generate: (prefix) =>
        Effect.map(random.randomBytes(SECRET_BYTES), (bytes) => `${prefix}${Base64Url.encode(bytes)}`),
      hash: (secret) => digest.digestHex(Digest.sha256, new TextEncoder().encode(secret)),
      code: Effect.map(random.intBetween(0, 999_999), (code) => String(code).padStart(6, "0")),
    });
  }),
).pipe(Layer.provide([SecureRandom.layerWebCrypto, Digest.layerWebCrypto]));

/**
 * Writes a fresh window key for this start of the hub to the data folder, readable only by the
 * user (mode 0600), and keeps only its hash. The desktop app reads it for its window; quitting the
 * hub ends it, since the next start writes another.
 */
export const WindowKeyLive = (dataDir: string) =>
  Layer.effect(
    WindowKey,
    Effect.gen(function* () {
      const secrets = yield* DeviceSecrets;
      const key = yield* secrets.generate(WINDOW_KEY_PREFIX);
      const file = windowKeyFile(dataDir);
      const temporary = `${file}.${process.pid}`;
      yield* Effect.sync(() => {
        writeFileSync(temporary, `${key}\n`, { mode: 0o600 });
        // The mode is also set explicitly, whatever the process's umask.
        chmodSync(temporary, 0o600);
        renameSync(temporary, file);
      });
      return WindowKey.of({ hash: yield* secrets.hash(key) });
    }),
  );

/** The window key's hash in tests that send a known key, without writing a file. */
export const knownWindowKey = (key: string) =>
  Layer.effect(
    WindowKey,
    Effect.gen(function* () {
      const secrets = yield* DeviceSecrets;
      return WindowKey.of({ hash: yield* secrets.hash(key) });
    }),
  );

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** How many times each cookie name appears in a `Cookie` header. */
const cookieCounts = (header: string | undefined) => {
  const counts = new Map<string, number>();
  for (const part of (header ?? "").split(";")) {
    const equals = part.indexOf("=");
    const name = (equals === -1 ? part : part.slice(0, equals)).trim();
    if (name !== "") counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
};

/** The request's own origin: `http` and the `Host` it was sent to. */
export const ownOrigin = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.host === undefined ? undefined : `http://${request.headers.host.toLowerCase()}`;

/**
 * Why a request carrying a cookie of the hub could have come from another page, or null when it
 * could not (ADR 021): a change must carry its own `Origin`, and a read must not be marked
 * cross-site or same-site.
 */
export const foreignOrigin = (request: HttpServerRequest.HttpServerRequest): string | null => {
  if (SAFE_METHODS.has(request.method)) {
    const site = request.headers["sec-fetch-site"];
    return site === "cross-site" || site === "same-site" ? `a ${site} read` : null;
  }
  const origin = request.headers.origin?.toLowerCase();
  if (origin === undefined) return "a change without an Origin";
  return origin === ownOrigin(request) ? null : `a change from ${origin}`;
};

/** Refusals name the route and the peer, never a token (ADR 021). */
const logRefusal = (request: HttpServerRequest.HttpServerRequest, why: string) =>
  Effect.logWarning(`Refused ${request.method} ${request.url.split("?")[0]}: ${why}`).pipe(
    Effect.annotateLogs({
      event: "device-refused",
      peer: Option.getOrNull(request.peerAddress),
      origin: request.headers.origin ?? null,
    }),
  );

const COOKIE_REFRESH_MS = 24 * 60 * 60 * 1000;

/** How long a browser keeps the device cookie: 400 days, the longest browsers allow. */
const DEVICE_COOKIE_MAX_AGE = "400 days";

/**
 * Sets the browser's device cookie: `HttpOnly`, `SameSite=Strict`, for the whole host and no other.
 * Over plain HTTP it cannot be `Secure`; over HTTPS it is `__Host-hobbots_device` (#341).
 */
export const setDeviceCookie = (token: string) =>
  HttpApiBuilder.securitySetCookie(DeviceCookie, Redacted.make(token), {
    secure: false,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });

/**
 * The check every route but health and pairing runs before its handler (ADR 021): the request must
 * carry an approved device's token or the window key, from where it was approved, and a cookie
 * request must come from the hub's own page.
 */
export class DeviceGate extends Context.Service<
  DeviceGate,
  {
    readonly admit: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      Device,
      DeviceRequired | DeviceRevoked | ForeignOrigin,
      HttpServerRequest.HttpServerRequest | HttpServerRequest.ParsedSearchParams
    >;
    /** Where a request reached the hub; none when it came from an address the hub does not serve. */
    readonly placeOf: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Option.Option<DevicePlace>>;
  }
>()("@hobbots/server/DeviceGate") {
  static readonly layer = Layer.effect(
    DeviceGate,
    Effect.gen(function* () {
      const devices = yield* DeviceService;
      const peers = yield* Effect.serviceOption(TailnetPeers);
      const inProcess = yield* InProcessRequests;
      // When each browser's cookie was last set, so it is set again at most once a day while used.
      const refreshed = new Map<string, number>();

      const refuse = <E>(request: HttpServerRequest.HttpServerRequest, why: string, error: E) =>
        Effect.andThen(logRefusal(request, why), Effect.fail(error));

      const required = new DeviceRequired({ message: "This device is not approved on this hub." });

      const refresh = (device: Device, token: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (now - (refreshed.get(device.id) ?? 0) < COOKIE_REFRESH_MS) return;
          refreshed.set(device.id, now);
          yield* setDeviceCookie(token);
        });

      const admit = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          const place = yield* placeOf(peers, inProcess, request);
          if (Option.isNone(place)) return yield* refuse(request, "it came from outside the hub", required);
          const counts = cookieCounts(request.headers.cookie);
          if ((counts.get(DeviceCookie.key) ?? 0) > 1 || (counts.get(SecureDeviceCookie.key) ?? 0) > 1) {
            return yield* refuse(request, "it carried two device cookies of one name", required);
          }
          const bearer = Redacted.value(yield* HttpApiBuilder.securityDecode(DeviceBearer));
          const cookie =
            Redacted.value(yield* HttpApiBuilder.securityDecode(SecureDeviceCookie)) ||
            Redacted.value(yield* HttpApiBuilder.securityDecode(DeviceCookie));
          const token = bearer || cookie;
          if (token === "") return yield* refuse(request, "it carried no device token", required);
          // A bearer token is sent by a program, never a page, so only a cookie needs its origin checked.
          if (bearer === "") {
            const foreign = foreignOrigin(request);
            if (foreign !== null) {
              return yield* refuse(request, foreign, new ForeignOrigin({ message: "This page is not the hub's own." }));
            }
          }
          const device = yield* devices
            .authenticate(token, place.value)
            .pipe(Effect.tapError((error) => logRefusal(request, `its device token was refused (${error._tag})`)));
          if (bearer === "" && token.startsWith(DEVICE_TOKEN_PREFIX)) yield* refresh(device, token);
          return device;
        });

      return DeviceGate.of({ admit, placeOf: (request) => placeOf(peers, inProcess, request) });
    }),
  );
}
