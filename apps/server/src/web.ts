import { HubHosts, normalizeHost } from "@hobbots/permissions";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http";

/**
 * Serves the built web client next to the API. Paths without a file extension fall back to
 * index.html, so the client's own routes load on a refresh; the API routes are more specific and
 * win over this catch-all.
 */
export const WebClientRoutes = (root: string) => HttpStaticServer.layer({ root, spa: true });

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The host name a Host header names, lowercase and without its port; IPv6 addresses keep their brackets. */
const hostName = (host: string) =>
  (host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "")).toLowerCase();

/** True when a Host header names this machine's loopback interface, with or without a port. */
export const isLoopbackHost = (host: string | undefined) => host !== undefined && LOOPBACK_HOSTS.has(hostName(host));

/**
 * True when a Host header names the hub: loopback, or one of the hub's tailnet names, such as its
 * MagicDNS name or a tailnet address (ADR 021), with or without a port.
 */
export const isOwnHost = (host: string | undefined, tailnetNames: ReadonlyArray<string>) => {
  if (host === undefined) return false;
  if (isLoopbackHost(host)) return true;
  const name = hostName(host);
  return name !== "" && tailnetNames.some((own) => normalizeHost(own) === name);
};

/**
 * Refuses requests addressed to any other host name. The server listens only on loopback and the
 * tailnet, but a web page could still point its own domain at 127.0.0.1 (DNS rebinding) and read
 * the API as a same-origin client; checking the Host header closes that gap.
 */
export const OwnHostsOnly = HttpRouter.middleware(
  Effect.gen(function* () {
    const hub = yield* HubHosts;
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (isOwnHost(request.headers.host, yield* hub.current)) return yield* effect;
        return HttpServerResponse.text("Hobbots only answers on its own addresses.", { status: 421 });
      });
  }),
  { global: true },
);
