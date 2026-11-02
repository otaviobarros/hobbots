import { DeviceService } from "@hobbots/agents";
import { DeviceBearer, ForeignOrigin, HobbotsApi, PairingCookie, PairingNotFound } from "@hobbots/api";
import { PAIRING_SECRET_PREFIX } from "@hobbots/domain";
import { type Duration, Effect, Option, Redacted } from "effect";
import { HttpServerRequest } from "effect/http";
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

    return handlers.handleAll({
      open: ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // A request that names an origin must name its own; the desktop app's names none.
          const origin = request.headers.origin?.toLowerCase();
          if (origin !== undefined && origin !== ownOrigin(request)) return yield* foreign;
          const place = yield* gate.placeOf(request);
          if (Option.isNone(place)) return yield* foreign;
          const opened = yield* devices.openPairing(payload, place.value);
          if (payload.kind === "browser") {
            yield* pairingCookie(opened.secret, PAIRING_COOKIE_MAX_AGE);
            return { status: opened.status };
          }
          return opened;
        }),
      status: () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const bearer = Redacted.value(yield* HttpApiBuilder.securityDecode(DeviceBearer));
          const viaCookie = !bearer.startsWith(PAIRING_SECRET_PREFIX);
          const secret = viaCookie ? Redacted.value(yield* HttpApiBuilder.securityDecode(PairingCookie)) : bearer;
          if (viaCookie && foreignOrigin(request) !== null) return yield* foreign;
          const status = yield* devices.pairingStatus(secret, yield* placeOrMissing(request));
          if (status.token === undefined || !viaCookie) return status;
          // A browser takes its token as the device cookie, never in the body, and drops the pairing secret.
          yield* setDeviceCookie(status.token);
          yield* pairingCookie("", "0 seconds");
          const { token: _, ...rest } = status;
          return rest;
        }),
    });
  }),
);

/** Who may pair, decided from a device that already has a token (PE-006). */
export const PairingRequestsHandlers = HttpApiBuilder.group(HobbotsApi, "pairingRequests", (handlers) =>
  Effect.gen(function* () {
    const devices = yield* DeviceService;
    return handlers.handleAll({
      list: () => devices.listOpenPairing,
      allow: ({ params }) => devices.allow(params.requestId),
      deny: ({ params }) => devices.deny(params.requestId),
    });
  }),
);
