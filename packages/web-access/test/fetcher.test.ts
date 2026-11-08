import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebFetched, WebFetcher, type WebFetchFailed, type WebTarget } from "@hobbots/agents";
import { Effect, Layer, Result } from "effect";
import { Dns } from "effect/net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WEB_PAGE_MAX_BYTES, WebAccessWith } from "../src/fetcher.ts";

// The hub's fetcher against a local test site (ADR 036). The test site stands for public addresses
// from TEST-NET-3: names resolve to them through a static resolver, and only the fetcher's dialing
// maps a checked address to the loopback server, so the policy decides what it would in use.

const SITE = "203.0.113.7";
const OTHER = "203.0.113.9";

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
}

const seen: Array<Seen> = [];
const html = (body: string, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
};

const ARTICLE = `<!doctype html><html><head><title>The Lamp | Site</title></head><body>
<nav><a href="/">Home</a></nav>
<article><h1>The Lamp</h1>
<p>${"A lamp burns in the workshop all night long, and the hobs read by it. ".repeat(12)}</p>
<h2>Parts</h2><ul><li>Wick</li><li>Oil</li></ul>
<table><thead><tr><th>Part</th><th>Cost</th></tr></thead><tbody><tr><td>Wick</td><td>2</td></tr></tbody></table>
<p>See <a href="/oil?kind=olive#top">the oil page</a> and <a href="https://elsewhere.test/b">another site</a>.</p>
<script>document.write("never run")</script>
</article></body></html>`;

const server = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, headers: req.headers });
  switch (req.url) {
    case "/robots.txt":
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /\n\nUser-agent: Hobbots\nDisallow: /private\n");
      return;
    case "/article":
      return html(ARTICLE, res);
    case "/notes.txt":
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Plain notes. More at https://example.test/more.");
      return;
    case "/data.json":
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"name":"lamp","url":"https://example.test/lamp"}');
      return;
    case "/paper.pdf":
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.7");
      return;
    case "/huge":
      res.writeHead(200, { "content-type": "text/plain", "content-length": String(WEB_PAGE_MAX_BYTES + 1) });
      res.end();
      return;
    case "/endless":
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(WEB_PAGE_MAX_BYTES + 10));
      return;
    case "/moved":
      res.writeHead(301, { location: "/article" });
      res.end();
      return;
    case "/private/page":
      return html("<p>hidden</p>", res);
    default:
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
  }
});

let port = 0;
const site = (path: string) => `http://site.test:${port}${path}`;
const at = (addresses: ReadonlyArray<string> = [SITE]): WebTarget => ({ host: "site.test", addresses });

const layer = () =>
  WebAccessWith({
    version: "0.0.4",
    // Only the site's checked address reaches the test server. Any other is dialed as ::1, where
    // nothing listens, so it fails at once rather than waiting on a route to TEST-NET-3.
    dialAs: (address) => (address === SITE ? "127.0.0.1" : "::1"),
  }).pipe(Layer.provide(Dns.layerStatic({ hosts: { "site.test": [OTHER], "both.test": [SITE, "10.0.0.8"] } })));

const run = <A>(effect: Effect.Effect<A, WebFetchFailed, WebFetcher>) =>
  Effect.runPromise(effect.pipe(Effect.result, Effect.provide(layer())));

const fetchPage = (path: string, target = at()) =>
  run(Effect.flatMap(WebFetcher, (fetcher) => fetcher.fetch(new URL(site(path)), target)));

const page = (result: Result.Result<WebFetched, WebFetchFailed>) => {
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  if (result.success._tag !== "Page") throw new Error("a redirect");
  return result.success.page;
};

const failure = (result: Result.Result<WebFetched, WebFetchFailed>) => {
  if (Result.isSuccess(result)) throw new Error("read");
  return result.failure;
};

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
});

describe("the hub's web fetcher (ADR 036)", () => {
  // covers ADR 036 (Reading a page)
  it("[TC-PE-1267-01] reads an article as Markdown with its title, absolute links and no script", async () => {
    const read = page(await fetchPage("/article"));
    expect(read.url).toBe(site("/article"));
    expect(read.title).toBe("The Lamp | Site");
    expect(read.contentType).toBe("text/html");
    expect(read.text).toContain("A lamp burns in the workshop");
    expect(read.text).toMatch(/^- +Wick$/m);
    expect(read.text).toMatch(/\| Part +\| Cost +\|/);
    expect(read.text).toContain(`[the oil page](${site("/oil?kind=olive#top")})`);
    expect(read.text).not.toContain("never run");
    expect(read.links.map((link) => link.url)).toEqual([
      site("/"),
      site("/oil?kind=olive"),
      "https://elsewhere.test/b",
    ]);
    expect(read.links[1]?.text).toBe("the oil page");
  });

  // covers ADR 036 (What it sends)
  it("[TC-PE-1267-02] sends one GET with the Hobbots user agent and no cookie, credential or body", async () => {
    seen.length = 0;
    page(await fetchPage("/article"));
    const request = seen.find((one) => one.url === "/article");
    expect(request?.method).toBe("GET");
    expect(request?.headers["user-agent"]).toBe("Hobbots/0.0.4 (+https://hobbots.ai)");
    expect(request?.headers.cookie).toBeUndefined();
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.headers["content-length"]).toBeUndefined();
    expect(request?.headers.host).toBe(`site.test:${port}`);
  });

  // covers ADR 036 (What it reads)
  it("[TC-PE-1267-03] reads plain text and JSON as sent, and answers a PDF as not a page it can read", async () => {
    const notes = page(await fetchPage("/notes.txt"));
    expect(notes.text).toBe("Plain notes. More at https://example.test/more.");
    expect(notes.links).toEqual([{ url: "https://example.test/more", text: "" }]);
    const data = page(await fetchPage("/data.json"));
    expect(data.text).toBe('```json\n{\n  "name": "lamp",\n  "url": "https://example.test/lamp"\n}\n```');
    const pdf = failure(await fetchPage("/paper.pdf"));
    expect(pdf.reason).toBe("not-readable");
    expect(pdf.message).toContain("application/pdf, not a page web_fetch can read");
  });

  // covers ADR 036 (Answers a hob can act on)
  it("[TC-PE-1267-04] refuses a page over 10 MB, declared or sent, and answers the site's own error status", async () => {
    expect(failure(await fetchPage("/huge")).reason).toBe("too-large");
    expect(failure(await fetchPage("/endless")).reason).toBe("too-large");
    const missing = failure(await fetchPage("/nowhere"));
    expect(missing.reason).toBe("status");
    expect(missing.message).toBe(`site.test answered 404 for ${site("/nowhere")}.`);
  });

  // covers ADR 036 (Redirects)
  it("[TC-PE-1267-05] follows no redirect itself: it hands the hub the new URL to decide", async () => {
    const moved = await fetchPage("/moved");
    expect(Result.isSuccess(moved) && moved.success).toEqual({ _tag: "Redirect", status: 301, location: "/article" });
  });

  // covers ADR 036 (robots.txt)
  it("[TC-PE-1267-06] honors robots.txt rules that name Hobbots and skips the generic ones", async () => {
    expect(page(await fetchPage("/article")).title).toBe("The Lamp | Site");
    const refused = failure(await fetchPage("/private/page"));
    expect(refused.reason).toBe("refused-by-site");
    expect(refused.message).toContain("asks Hobbots not to read");
  });

  // covers ADR 036 (Egress from the hub)
  it("[TC-PE-1267-07] connects to the addresses it was given, never to what the name resolves to now", async () => {
    // The resolver says site.test is OTHER, which reaches nothing; the checked address is the site.
    expect(page(await fetchPage("/notes.txt", at([SITE]))).text).toContain("Plain notes");
    expect(failure(await fetchPage("/notes.txt", at([OTHER]))).reason).toBe("unreachable");
    const blocked = failure(await fetchPage("/notes.txt", at(["127.0.0.1"])));
    expect(blocked.reason).toBe("blocked-address");
  });

  // covers ADR 036 (Cache)
  it("[TC-PE-1267-08] keeps a page it read for every hob, and asks again after a refusal", async () => {
    const one = await run(
      Effect.gen(function* () {
        const fetcher = yield* WebFetcher;
        seen.length = 0;
        const first = yield* fetcher.fetch(new URL(site("/notes.txt")), at());
        const again = yield* fetcher.fetch(new URL(site("/notes.txt")), at());
        yield* fetcher.fetch(new URL(site("/nowhere")), at()).pipe(Effect.ignore);
        yield* fetcher.fetch(new URL(site("/nowhere")), at()).pipe(Effect.ignore);
        return { first, again, asked: seen.map((request) => request.url) };
      }),
    );
    if (Result.isFailure(one)) throw new Error(one.failure.message);
    expect(one.success.again).toEqual(one.success.first);
    expect(one.success.asked).toEqual(["/robots.txt", "/notes.txt", "/nowhere", "/nowhere"]);
  });

  it("resolves a name once to every address, and an address literal as itself", async () => {
    const resolved = await run(
      Effect.gen(function* () {
        const fetcher = yield* WebFetcher;
        return [
          yield* fetcher.resolve(new URL("http://both.test/")),
          yield* fetcher.resolve(new URL("http://[::ffff:10.0.0.1]/")),
          yield* fetcher.resolve(new URL("http://BOTH.test./x")),
        ];
      }),
    );
    expect(Result.isSuccess(resolved) && resolved.success).toEqual([
      { host: "both.test", addresses: [SITE, "10.0.0.8"] },
      { host: "[::ffff:a00:1]", addresses: ["[::ffff:a00:1]"] },
      { host: "both.test", addresses: [SITE, "10.0.0.8"] },
    ]);
    const missing = await run(
      Effect.flatMap(WebFetcher, (fetcher) => fetcher.resolve(new URL("http://nowhere.test/"))),
    );
    expect(Result.isFailure(missing) && missing.failure.reason).toBe("not-found");
  });
});
