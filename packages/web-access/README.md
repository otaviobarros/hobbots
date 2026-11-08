# packages/web-access

The hub's HTTP client for `web_fetch` ([ADR 036](../../docs/decisions/036-web-search-and-pages.md)). It implements the `WebFetcher` port of `@hobbots/agents`, and `apps/server` composes it behind that port: no runtime, Charm or other package imports it, and the layer check holds that.

- **Resolve, check, pin.** `resolve` looks a host up once, through Effect's `Dns` service, and returns every address. The hub decides the page on those addresses, and `fetch` then connects only to them: each request gets its own undici agent, through Effect's HTTP client (`NodeHttpClient.makeUndici`), whose `connect.lookup` answers only the host it was made for, with only the checked addresses. A blocked address is refused again before anything is sent.
- **What it sends.** One GET, with the user agent `Hobbots/<version> (+https://hobbots.ai)`, and no cookie, credential or body. It follows no redirect: a redirect is handed back, and the hub decides the new URL like the first.
- **robots.txt.** A fetch is one page a hob asked for, not crawling, so it honors rules that name Hobbots and skips the generic `User-agent: *` ones (`robots-parser`).
- **Page to text.** HTML goes through `@mozilla/readability` on `linkedom`, then `turndown` with the GFM tables plugin, keeping headings, lists, tables and links, made absolute. No script on the page ever runs. Plain text, Markdown and JSON are kept as the site sent them, in the charset it names. Anything else, a PDF among them, is answered as not a page `web_fetch` can read.
- **Limits.** 10 MB a page, declared or sent, and 20 seconds from connecting to the last byte.
- **Cache.** A page read, and each site's robots.txt, stay in the hub's memory for 15 minutes, shared by every hob since no cookie is sent. A refusal or a timeout is asked again next time. Nothing is written to disk.

Why Readability rather than Defuddle is in the [evidence record](../../docs/evidence/2026-11-08-web-fetch.md).

The tests read pages from a local test site whose names resolve, through a static resolver, to addresses from TEST-NET-3, so the policy decides what it would in use. Only the test-only `dialAs` option maps a checked address to the loopback server.
