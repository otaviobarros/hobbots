import { WebFetcher } from "@hobbots/agents";
import { WebAccessWith } from "@hobbots/web-access";
import { Effect, Layer } from "effect";
import { Dns } from "effect/net";

// The entry the bundled web_fetch test builds: one page read through the hub's fetcher, as the
// desktop app and the server's build run it, from one bundled file.

/** Reads `url` once, with `site.test` standing for the public address that is dialed as loopback. */
export const readOnce = (url: string) =>
  Effect.flatMap(WebFetcher, (fetcher) =>
    fetcher.fetch(new URL(url), { host: "site.test", addresses: ["203.0.113.7"] }),
  ).pipe(
    Effect.provide(
      WebAccessWith({ version: "0.0.0", dialAs: () => "127.0.0.1" }).pipe(
        Layer.provide(Dns.layerStatic({ hosts: {} })),
      ),
    ),
    Effect.runPromise,
  );
