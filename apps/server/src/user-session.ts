import { UserSession, UserSessionOnly, UserSessionRequired } from "@hobbots/api";
import { Context, Effect, Layer } from "effect";
import { HttpServerRequest } from "effect/http";

/** Client origins besides the hub's own, such as the Vite dev server's: the CORS allow list. */
export const ClientOrigins = Context.Reference<ReadonlyArray<string>>("@hobbots/server/ClientOrigins", {
  defaultValue: () => [],
});

type RequestHeaders = Readonly<Record<string, string | undefined>>;

/**
 * The client origin of a request from a user session, or why it is not one (PE-006). A browser
 * names the page's origin on every request that changes something, and marks a same-origin read
 * with `Sec-Fetch-Site`, so the hub's own web client, Electron's window and an allowed client
 * origin pass. A request without either, as a runtime's HTTP client, a script or a command sends
 * it, is refused, and so is one from another web page.
 *
 * This is not authentication: a process on the hub that sends the headers passes. A sandboxed hob
 * never reaches the hub's address (ADR 014), so this holds for it whatever it sends; for an
 * unsandboxed hob it is checked, not enforced. Device tokens will replace it (deployment contract).
 */
export const userSessionOrigin = (
  headers: RequestHeaders,
  allowed: ReadonlyArray<string>,
): { readonly origin: string } | { readonly refused: string } => {
  const own = headers.host === undefined ? undefined : `http://${headers.host}`;
  const { origin } = headers;
  if (origin !== undefined) {
    return origin === own || allowed.includes(origin)
      ? { origin }
      : { refused: `the request came from ${origin}, which is not a Hobbots client` };
  }
  if (headers["sec-fetch-site"] === "same-origin" && own !== undefined) return { origin: own };
  return { refused: "the request names no client origin, so it is not from the Hobbots app" };
};

const REFUSED = "Only you can decide approvals and manage grants, from the Hobbots app.";

/**
 * Admits only user sessions to the approval and grant routes, and records every other attempt in
 * the hub's log with the route and what the request said about itself.
 */
export const UserSessionOnlyLive = Layer.effect(
  UserSessionOnly,
  Effect.gen(function* () {
    const allowed = yield* ClientOrigins;
    return UserSessionOnly.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const verdict = userSessionOrigin(request.headers, allowed);
        if ("origin" in verdict) return yield* Effect.provideService(effect, UserSession, { origin: verdict.origin });
        yield* Effect.logWarning(`Refused ${request.method} ${request.url}: ${verdict.refused}`).pipe(
          Effect.annotateLogs({
            event: "user-session-refused",
            origin: request.headers.origin ?? null,
            userAgent: request.headers["user-agent"] ?? null,
          }),
        );
        return yield* new UserSessionRequired({ message: REFUSED });
      }),
    );
  }),
);
