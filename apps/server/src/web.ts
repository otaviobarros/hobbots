import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http";

/**
 * Serves the built web client next to the API. Paths without a file extension fall back to
 * index.html, so the client's own routes load on a refresh; the API routes are more specific and
 * win over this catch-all.
 */
export const WebClientRoutes = (root: string) => HttpStaticServer.layer({ root, spa: true });

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True when a Host header names this machine's loopback interface, with or without a port. */
export const isLoopbackHost = (host: string | undefined) => {
  if (host === undefined) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK_HOSTS.has(name?.toLowerCase() ?? "");
};

/**
 * Refuses requests addressed to any other host name. The server only listens on loopback, but a
 * web page could still point its own domain at 127.0.0.1 (DNS rebinding) and read the API as a
 * same-origin client; checking the Host header closes that gap.
 */
export const LoopbackHostOnly = HttpRouter.middleware(
  (effect) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      isLoopbackHost(request.headers.host)
        ? effect
        : Effect.succeed(HttpServerResponse.text("Hobbots only answers on localhost.", { status: 421 })),
    ),
  { global: true },
);
