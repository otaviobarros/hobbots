import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import * as NodeDns from "@effect/platform-node/NodeDns";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { type WebFetched, WebFetcher, WebFetchFailed, type WebPage, type WebTarget } from "@hobbots/agents";
import { isBlockedHost, normalizeHost } from "@hobbots/permissions";
import { Cache, Context, DateTime, Duration, Effect, Exit, Layer, Stream } from "effect";
import { HttpClientRequest, type HttpClientResponse } from "effect/http";
import { Dns, NetAddress } from "effect/net";
import { Agent } from "undici";
import { contentTypeOf, decodeBody, pageKind, readPage } from "./page.ts";
import { robotsAllow } from "./robots.ts";

/**
 * The hub's HTTP client for `web_fetch` (ADR 036): Effect's HTTP client over undici, one GET at a
 * time to the addresses the hub checked and nothing else. Each request gets its own undici agent
 * whose `connect.lookup` answers only the host it was made for, with only those addresses, so a
 * site cannot switch to another address after the check. It sends no cookie, credential or body,
 * follows no redirect, honors robots.txt rules that name Hobbots and skips generic ones, and keeps
 * what it read for 15 minutes in the hub's memory, never on disk.
 */

/** The most bytes a page may be before it is read into text. */
export const WEB_PAGE_MAX_BYTES = 10 * 1024 * 1024;

/** How long one page may take, from connecting to its last byte. */
export const WEB_FETCH_TIMEOUT = Duration.seconds(20);

/** How long a page or robots.txt read stays in the cache, shared by every hob since no cookie is sent. */
export const WEB_CACHE_TIME = Duration.minutes(15);

export interface WebAccessOptions {
  /** The app's version, for the user agent `Hobbots/<version> (+https://hobbots.ai)`. */
  readonly version: string;
  /**
   * For tests only: the address a checked address is dialed as, so a test site on loopback can
   * stand for a public address the policy decides. The hub itself never sets it.
   */
  readonly dialAs?: (address: string) => string;
}

/** The address a request may connect to, set for each request. */
class Pinned extends Context.Service<Pinned, WebTarget>()("@hobbots/web-access/Pinned") {}

/** An address as `connect.lookup` hands it to the socket: bare, with its family. */
const lookupAddress = (address: string, dialAs: (address: string) => string): LookupAddress => {
  const bare = dialAs(address.startsWith("[") ? address.slice(1, -1) : address);
  return { address: bare, family: isIP(bare) === 6 ? 6 : 4 };
};

/**
 * The `lookup` a request's agent connects with: the host it was made for resolves to the checked
 * addresses, and any other name fails, so nothing else is ever reached.
 */
const pinnedLookup =
  (target: WebTarget, dialAs: (address: string) => string) =>
  (
    hostname: string,
    options: { readonly all?: boolean | undefined },
    callback: (error: Error | null, address: string | Array<LookupAddress>, family?: number) => void,
  ): void => {
    const addresses = target.addresses.map((address) => lookupAddress(address, dialAs));
    const [first] = addresses;
    if (normalizeHost(hostname) !== target.host || first === undefined) {
      callback(new Error(`${hostname} is not the host Hobbots checked.`), []);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  };

/**
 * The undici agent a request connects through, closed with its scope. It is made here from undici's
 * own `Agent` rather than through `NodeHttpClient.makeDispatcherOptions`, whose dynamic import of
 * undici loses its named exports when the server is bundled (the desktop app, the server's build).
 */
const pinnedAgent = (target: WebTarget, dialAs: (address: string) => string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Agent({ connect: { lookup: pinnedLookup(target, dialAs) } })),
    (agent) => Effect.promise(() => agent.destroy()),
  );

const failed = (reason: WebFetchFailed["reason"], message: string) => new WebFetchFailed({ reason, message });

/** The body, read up to the cap: a larger one is refused before it is read into text. */
const boundedBody = (response: HttpClientResponse.HttpClientResponse, url: URL) =>
  Effect.gen(function* () {
    const tooLarge = failed(
      "too-large",
      `${url.href} is over ${WEB_PAGE_MAX_BYTES / 1024 / 1024} MB, too large for web_fetch to read.`,
    );
    const declared = Number(response.headers["content-length"] ?? Number.NaN);
    if (declared > WEB_PAGE_MAX_BYTES) return yield* tooLarge;
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* response.stream.pipe(
      Stream.mapError(() => failed("unreachable", `${url.hostname} stopped sending ${url.href} before it ended.`)),
      Stream.runForEach((chunk) => {
        size += chunk.byteLength;
        if (size > WEB_PAGE_MAX_BYTES) return Effect.fail(tooLarge);
        chunks.push(chunk);
        return Effect.void;
      }),
    );
    const body = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.byteLength;
    }
    return body;
  });

/** What a response is to the hob: a page, a redirect, or the site's own refusal. */
const answerOf = (response: HttpClientResponse.HttpClientResponse, url: URL) =>
  Effect.gen(function* () {
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location !== undefined) {
      return { _tag: "Redirect", status: response.status, location } satisfies WebFetched;
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* failed("status", `${url.hostname} answered ${response.status} for ${url.href}.`);
    }
    const { mediaType, charset } = contentTypeOf(response.headers["content-type"]);
    const kind = pageKind(mediaType);
    if (kind === null) {
      return yield* failed(
        "not-readable",
        `${url.href} is ${mediaType}, not a page web_fetch can read: it reads HTML, plain text, Markdown and JSON.`,
      );
    }
    const body = yield* boundedBody(response, url);
    const read = readPage(decodeBody(body, kind, charset), kind, url.href);
    const page: WebPage = {
      url: url.href,
      title: read.title,
      contentType: mediaType,
      text: read.text,
      links: read.links,
      bytes: body.byteLength,
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    };
    return { _tag: "Page", page } satisfies WebFetched;
  });

/** The fetcher for the hub, on its own system resolver. */
export const WebAccessLive = (options: WebAccessOptions) => WebAccessWith(options).pipe(Layer.provide(NodeDns.layer));

/** The fetcher on the `Dns` in context, so a test can give it names of its own. */
export const WebAccessWith = (options: WebAccessOptions) =>
  Layer.effect(
    WebFetcher,
    Effect.gen(function* () {
      const dns = yield* Dns.Dns;
      const userAgent = `Hobbots/${options.version} (+https://hobbots.ai)`;
      const dialAs = options.dialAs ?? ((address: string) => address);

      /** One GET to the pinned addresses, through an agent made for it alone and closed with it. */
      const get = (url: URL, accept: string) =>
        Effect.gen(function* () {
          const target = yield* Pinned;
          if (target.addresses.some(isBlockedHost)) {
            return yield* failed("blocked-address", `${target.host} is an address web_fetch never reaches.`);
          }
          const client = yield* NodeHttpClient.makeUndici.pipe(
            Effect.provideServiceEffect(NodeHttpClient.Dispatcher, pinnedAgent(target, dialAs)),
          );
          return yield* client
            .execute(
              HttpClientRequest.get(url.href).pipe(HttpClientRequest.setHeaders({ "user-agent": userAgent, accept })),
            )
            .pipe(Effect.mapError(() => failed("unreachable", `Hobbots could not reach ${url.hostname}.`)));
        });

      /** What robots.txt rules that name Hobbots say of `url`; any other answer has none. */
      const robots = yield* Cache.makeWith(
        (origin: string) =>
          get(new URL("/robots.txt", origin), "text/plain").pipe(
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? Effect.map(boundedBody(response, new URL("/robots.txt", origin)), (body) =>
                    new TextDecoder().decode(body),
                  )
                : Effect.succeed(""),
            ),
            Effect.orElseSucceed(() => ""),
            Effect.scoped,
          ),
        { capacity: 200, timeToLive: () => WEB_CACHE_TIME, requireServicesAt: "lookup" },
      );

      const read = (key: string) =>
        Effect.gen(function* () {
          const url = new URL(key);
          const rules = yield* Cache.get(robots, url.origin);
          if (!robotsAllow(rules, url, userAgent)) {
            return yield* failed(
              "refused-by-site",
              `${url.hostname} asks Hobbots not to read ${url.href} (robots.txt).`,
            );
          }
          const response = yield* get(url, "text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.1");
          return yield* answerOf(response, url);
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: WEB_FETCH_TIMEOUT,
            orElse: () =>
              Effect.fail(failed("timed-out", `${key} took over ${Duration.format(WEB_FETCH_TIMEOUT)} to read.`)),
          }),
        );

      // Only what was read is kept: a refusal or a timeout is asked again next time.
      const pages = yield* Cache.makeWith(read, {
        capacity: 500,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? WEB_CACHE_TIME : Duration.zero),
        requireServicesAt: "lookup",
      });

      return WebFetcher.of({
        resolve: (url) =>
          Effect.gen(function* () {
            const host = normalizeHost(url.hostname);
            if (host === null) return yield* failed("invalid-url", `${url.hostname} is not a host name or address.`);
            const literal = host.startsWith("[") ? host.slice(1, -1) : host;
            if (isIP(literal) !== 0) return { host, addresses: [host] };
            // A name that is never reached, such as localhost, is refused by the policy as it is, unresolved.
            if (isBlockedHost(host)) return { host, addresses: [] };
            const found = yield* dns
              .lookup(host)
              .pipe(Effect.mapError(() => failed("not-found", `Hobbots could not find ${host}.`)));
            return { host, addresses: found.map((address) => normalizeHost(NetAddress.formatIp(address)) ?? "") };
          }),
        fetch: (url, target) => Cache.get(pages, url.href).pipe(Effect.provideService(Pinned, target)),
      });
    }),
  );
