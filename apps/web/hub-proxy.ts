import type { ProxyOptions } from "vite";

/**
 * What the dev server forwards to the hub on loopback, without changing the Host, so the client
 * calls its own origin as the served build does (ADR 021): the API, the event stream included, and
 * the two hub pages a hob's own GitHub app is made through (ADR 022). The hub builds those pages'
 * links from the Host it was reached at, so in development they point at the dev server and must
 * reach the hub from there.
 */
const HUB_PATHS = ["/api", "/github/hob-app"] as const;

export const hubProxy = (port: number | string): Record<string, ProxyOptions> =>
  Object.fromEntries(HUB_PATHS.map((path) => [path, { target: `http://127.0.0.1:${port}`, changeOrigin: false }]));
