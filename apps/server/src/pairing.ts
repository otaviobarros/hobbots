import { type DevicePlace, DeviceService } from "@hobbots/agents";
import {
  DeviceBearer,
  ForeignOrigin,
  HobbotsApi,
  PairingCookie,
  PairingNotFound,
  type PairingThrottled,
} from "@hobbots/api";
import { PAIRING_SECRET_PREFIX } from "@hobbots/domain";
import { type Duration, Effect, Option, Redacted } from "effect";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { DeviceGate, foreignOrigin, ownOrigin, setDeviceCookie } from "./devices.ts";

/** A waiting browser keeps its pairing secret for as long as a deferred request lasts (ADR 021). */
const PAIRING_COOKIE_MAX_AGE = "24 hours";

const pairingCookie = (secret: string, maxAge: Duration.Input) =>
  HttpApiBuilder.securitySetCookie(PairingCookie, Redacted.make(secret), {
    secure: false,
    httpOnly: true,
    sameSite: "strict",
    path: "/api/pairing",
    maxAge,
  });

const foreign = new ForeignOrigin({ message: "This page is not the hub's own." });

/** A refusal over a pairing limit also says, in `Retry-After`, how many seconds to wait (ADR 021). */
export const withRetryAfter = <A, E, R>(effect: Effect.Effect<A, E | PairingThrottled, R>) =>
  Effect.tapError(effect, (error) =>
    typeof error === "object" && error !== null && "_tag" in error && error._tag === "PairingThrottled"
      ? HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(
            HttpServerResponse.setHeader(
              response,
              "retry-after",
              String((error as PairingThrottled).retryAfterSeconds),
            ),
          ),
        )
      : Effect.void,
  );

/** The pairing secret a request presents: as a bearer token from the desktop app, or as a browser's cookie. */
const presentedSecret = Effect.gen(function* () {
  const bearer = Redacted.value(yield* HttpApiBuilder.securityDecode(DeviceBearer));
  if (bearer.startsWith(PAIRING_SECRET_PREFIX)) return { secret: bearer, viaCookie: false };
  return { secret: Redacted.value(yield* HttpApiBuilder.securityDecode(PairingCookie)), viaCookie: true };
});

/**
 * Pairing (ADR 021): a device without a token asks, waits and, once allowed, receives its token once.
 * A browser's pairing secret and token are `HttpOnly` cookies; the desktop app's main process sends
 * no `Origin` and gets both in the body. Deciding needs an approved device.
 */
export const PairingHandlers = HttpApiBuilder.group(HobbotsApi, "pairing", (handlers) =>
  Effect.gen(function* () {
    const devices = yield* DeviceService;
    const gate = yield* DeviceGate;

    // A request from outside the hub is refused like one without a pairing secret.
    const placeOrMissing = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.flatMap(
        gate.placeOf(request),
        Option.match({ onNone: () => Effect.fail(new PairingNotFound()), onSome: Effect.succeed }),
      );

    const open = (place: DevicePlace, payload: Parameters<typeof devices.openPairing>[0]) =>
      Effect.gen(function* () {
        yield* devices.throttleAnonymous(place);
        const { secret } = yield* presentedSecret;
        return yield* devices.openPairing(payload, {
          place,
          hub: yield* gate.hub,
          secret: secret === "" ? Option.none() : Option.some(secret),
        });
      });

    return handlers.handleAll({
      open: ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // A request that names an origin must name its own; the desktop app's names none.
          const origin = request.headers.origin?.toLowerCase();
          if (origin !== undefined && origin !== ownOrigin(request)) return yield* foreign;
          const place = yield* gate.placeOf(request);
          if (Option.isNone(place)) return yield* foreign;
          const opened = yield* open(place.value, payload);
          if (payload.kind === "browser") {
            yield* pairingCookie(opened.secret, PAIRING_COOKIE_MAX_AGE);
            return { status: opened.status };
          }
          return opened;
        }).pipe(withRetryAfter),
      status: () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { secret, viaCookie } = yield* presentedSecret;
          if (viaCookie && foreignOrigin(request) !== null) return yield* foreign;
          const place = yield* placeOrMissing(request);
          const status = yield* devices.pairingStatus(secret, place);
          if (status.token === undefined || !viaCookie) return status;
          // A browser takes its token as the device cookie, never in the body, and drops the pairing secret.
          yield* setDeviceCookie(status.token);
          yield* pairingCookie("", "0 seconds");
          const { token: _, ...rest } = status;
          return rest;
        }).pipe(withRetryAfter),
    });
  }),
);

/** Who may pair, decided from a device that already has a token (PE-006). */
export const PairingRequestsHandlers = HttpApiBuilder.group(HobbotsApi, "pairingRequests", (handlers) =>
  Effect.gen(function* () {
    const devices = yield* DeviceService;
    const gate = yield* DeviceGate;
    return handlers.handleAll({
      list: () => Effect.flatMap(gate.hub, devices.listOpenPairing),
      allow: ({ params }) => devices.allow(params.requestId),
      deny: ({ params }) => devices.deny(params.requestId),
      later: ({ params }) => devices.later(params.requestId),
    });
  }),
);
