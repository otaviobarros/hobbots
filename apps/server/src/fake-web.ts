import { type WebFetched, WebFetcher, WebFetchFailed, type WebPage } from "@hobbots/agents";
import { DateTime, Effect, Layer } from "effect";

/**
 * A stand-in for the web (ADR 036), to try the web screens with the fake runtime and no network.
 * Only `HOBBOTS_FAKE_WEB` turns it on. Every name under `hobbots.test` is a public site that answers
 * a short page about its path, with links to two more pages; `nas.hobbots.test` stands for a box on
 * your local network, and any other name is not found. Nothing leaves the hub.
 */

/** The test domain the fake's search results and pages live on. */
const FAKE_DOMAIN = "hobbots.test";

/** A name on the test domain that resolves to a private network address, as a NAS's would. */
const FAKE_LOCAL_HOST = `nas.${FAKE_DOMAIN}`;

/** A public address no one answers on (TEST-NET-3, RFC 5737). */
const PUBLIC_ADDRESS = "203.0.113.10";
const LOCAL_ADDRESS = "192.168.1.20";

const words = (path: string) =>
  decodeURIComponent(path)
    .split("/")
    .filter((part) => part !== "")
    .join(" ")
    .replace(/[-_]+/g, " ")
    .trim();

/** The page a fake site answers for `url`: its path as a title, a few paragraphs and two links. */
export const fakePage = (url: URL, fetchedAt: string): WebPage => {
  const topic = words(url.pathname) || url.hostname;
  const title = topic.charAt(0).toUpperCase() + topic.slice(1);
  const links = [
    { url: new URL("details", url.href.endsWith("/") ? url.href : `${url.href}/`).href, text: `More on ${topic}` },
    { url: `https://docs.${FAKE_DOMAIN}/${encodeURIComponent(topic.replace(/ /g, "-"))}`, text: "The docs" },
  ];
  const text = [
    `# ${title}`,
    "",
    `This test page on ${url.hostname} is about ${topic}. Hobbots made it up to stand in for a real site.`,
    "",
    `- It has a list.`,
    `- And a [link](${links[0]?.url}).`,
    "",
    "The end of the page.",
  ].join("\n");
  return {
    url: url.href,
    title,
    status: 200,
    contentType: "text/html",
    text,
    links,
    bytes: 2_048 + text.length * 3,
    fetchedAt,
  };
};

export const WebFetcherFake = Layer.sync(WebFetcher, () => {
  const cache = new Map<string, WebPage>();
  return WebFetcher.of({
    resolve: (url) => {
      const host = url.hostname.toLowerCase();
      if (host === FAKE_LOCAL_HOST) return Effect.succeed({ host, addresses: [LOCAL_ADDRESS] });
      if (host === FAKE_DOMAIN || host.endsWith(`.${FAKE_DOMAIN}`)) {
        return Effect.succeed({ host, addresses: [PUBLIC_ADDRESS] });
      }
      return Effect.fail(new WebFetchFailed({ reason: "not-found", message: `Hobbots could not find ${host}.` }));
    },
    fetch: (url) =>
      Effect.gen(function* () {
        const kept = cache.get(url.href);
        if (kept !== undefined) return { _tag: "Page", page: kept } satisfies WebFetched;
        const page = fakePage(url, DateTime.formatIso(yield* DateTime.now));
        cache.set(url.href, page);
        return { _tag: "Page", page } satisfies WebFetched;
      }),
    cache: {
      held: Effect.sync(() => ({
        pages: cache.size,
        bytes: [...cache.values()].reduce((sum, page) => sum + page.bytes, 0),
      })),
      clear: Effect.sync(() => cache.clear()),
    },
  });
});
