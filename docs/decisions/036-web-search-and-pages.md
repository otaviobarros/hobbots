# ADR 036 — Searching and reading the web

Status: **Accepted.** Amends the operations, presets and Charms of [ADR 014](014-tool-policy-and-enforcement.md) (a new built-in Search the web operation, and web search is built in rather than a future Charm), the tools Codex keeps off in [ADR 024](024-codex-adapter.md) (cached web search can be on), and the outside-data label of [ADR 031](031-charm-actions-and-registry.md) (built-in reads of the web carry it too). Refines the [permissions contract](../architecture/permissions.md) and the [runtime adapters](../architecture/runtime-adapters.md). Records the design of the web search slice ([#1264](https://github.com/otaviobarros/hobbots/issues/1264)) for [#1265](https://github.com/otaviobarros/hobbots/issues/1265).

## Context

A hob cannot search the web, and the reason is policy, not the sandbox. ADR 014 keeps a runtime tool closed until the policy knows it. So Claude Code is started without `WebSearch` and `WebFetch`, and each hob's Codex configuration says `web_search = "disabled"` (ADR 024). A hob with commands can `curl` a page through the sandbox proxy, which decides each host under Use the web. But it gets raw HTML and cannot search, so hobs tell you they can't look things up.

Each runtime ships its own search, and they differ:

- **Claude Code** has `WebSearch`, which runs on Anthropic's servers and returns links: the query, and for each hit a title and a URL, with no snippet. The policy hook sees every call with its `query` and optional `allowed_domains` and `blocked_domains`, so the hub can decide each search before it runs. A real search on Claude Code 2.1.316 put the hits in the tool's structured result (`results[].content[]` with `title` and `url`, and `searchCount`); the text the model gets is one string. The search runs in a side call on a smaller model, so the turn's `usage.server_tool_use.web_search_requests` reads 0 and the count shows only in that model's `modelUsage[].webSearchRequests`. It also has `WebFetch`, which fetches a page and hands it to a second model to summarize, so neither you nor the hub sees what the hob read.
- **Codex** has a hosted `web_search` tool that runs on OpenAI's servers inside the model's turn. It cannot pause for an approval. Codex 0.167.0 has four modes: `disabled`, `cached` (OpenAI's index only), `indexed` and `live`. Its App Server reports each search as a `webSearch` item with the `query` and an `action` (`search`, `openPage` or `findInPage`), and `results`. In a real cached search on 0.166.0 and 0.167.0, `results` was null on `item/started` and filled on `item/completed`, each entry with `title`, `url`, `domain` and `snippet`, and the action held its queries in `action.query` or `action.queries`; `item.query` can be a shortened display string. No `openPage` or `findInPage` action appeared. Codex has no tool that fetches a page. Its token usage has no search count.

Codex's documentation warns that a full-access sandbox makes its search live by default. Hobbots runs Codex with its own sandbox off inside Hobbots' sandbox (ADR 024), so the [probe](../evidence/2026-11-08-codex-web-search-modes.md) checked what each setting sends to the model with a stand-in model. With Hobbots' App Server settings, `web_search = "cached"` sends `external_web_access: false` on Codex 0.166.0 and 0.167.0. `live` and `indexed` send `external_web_access: true`. But the same `cached` setting under `codex exec --sandbox danger-full-access` sends `external_web_access: true`, which is live. So the setting alone does not hold the mode: how Codex is started decides it, and a later Codex could change that. Codex's `allowed_web_search_modes` requirement does hold the mode, but only from the system's `/etc/codex/requirements.toml` or managed configuration. A `requirements.toml` in the hob's `CODEX_HOME` is ignored.

Other agent apps put together the same parts: the runtime's own search or a search provider's API (Brave, Exa, Tavily, Firecrawl, SearXNG), and `@mozilla/readability` with `linkedom` to read a page. No library covers the per-site policy, recording each step, or asking before data leaves. Those parts are Hobbots' own.

The risk that shapes this ADR is a page that tells a hob to send your data somewhere. A hob that has read a page carries its text in its context, so the safeguard cannot be the model ignoring it. It has to be the hub closing the ways out.

## Decision

### Built in, not a Charm

Searching and reading public pages are **built-in operations**, like files, commands and memory. They act on no account and hold no credential, and Use the web already decides a site. A hob's Charms tab lists them under Built in, with how each runtime enforces them. This replaces "later web search" in ADR 014's list of Charms.

Web work becomes a Charm when it needs your credentials. A search provider that needs your API key, such as Brave, Exa or Tavily, is a Charm (an MCP Charm first, ADR 031), and so is signed-in browsing. For the provider, `@hobbots/agents` holds a **search-provider port**, `WebSearchProvider`: a query in, a list of results with title, URL and snippet out, with the usage the provider reports. Nothing implements it in this slice. A runtime that has no search of its own will be offered a hub `web_search` tool backed by a provider once one exists. Until then it shows Search the web as not offered.

### Search the web

A new built-in operation, **Search the web** (`search-web`), in a new Web group with Use the web.

| Operation | Careful | Balanced | Trusting |
| --- | --- | --- | --- |
| Search the web | Allow | Allow | Allow |

- **Allow or Never only.** A hob override can set Never, and a Quest can narrow it to Never like any operation (ADR 018), which stops a running turn. It has no Ask: Codex's search runs inside the model's turn and cannot pause, and the same setting must act the same way on every runtime. An override of Ask is refused when saved.
- **Allow under every preset.** A search sends a query to the provider the runtime already sends the whole conversation to, and reaches no host from your computer. The risk of a search is the text it brings back, which the read-the-web mark below handles.
- **Delivery.** `PromptRequest.webSearch: boolean`, settled by the hub from the policy for each turn, as tools are. Each adapter maps it:
  - **Claude Code** adds `WebSearch` to the offered tools, and `tool-calls.ts` maps it to Search the web so the policy hook decides each call. `WebFetch` stays closed.
  - **Codex** keeps `web_search = "disabled"` in the hob's `CODEX_HOME/config.toml`, and a turn that may search starts its own App Server with `-c web_search="cached"`. Turns of one hob share that home and can run at once with different answers, as a Task under a Quest's Never beside a chat, so the setting belongs to the process, never the shared file. `live` and `indexed` are never written, nor `[tools.web_search]`, and the `standalone_web_search` feature stays off. Hobbots never writes `/etc/codex` or managed configuration, which would change your own Codex too. The clean-runtime contract test holds the mode instead (Validation): for each supported Codex version, the first model request of a new and of a resumed thread carries `web_search` with `external_web_access: false`. If a Codex version fails that test, the adapter reports search as not offered for it, rather than offering live search.
  - **The fake runtime** runs a scripted search, so tests need no network.
  - **A runtime with no search of its own** reports search unsupported in its enforcement, and the hob's Permissions shows Search the web as not offered.
- **Why not `live` or `indexed` on Codex.** Both let OpenAI's servers open any page the model names (`openPage`, `findInPage`). That is outside the hub, outside your site rules and outside the read-the-web mark, and a URL the model wrote can carry your data out. `[tools.web_search] allowed_domains` would limit which sites search finds, not which pages open, and would make search useless for general questions.
- **Why the two runtimes still feel the same.** Claude Code's search returns links only, so a Claude Code hob reads pages with `web_fetch`. A Codex hob does the same: cached search finds pages, and `web_fetch` reads them as they are now. Both runtimes read every page through the same tool and the same rules.

### Reading a page: `web_fetch`

`web_fetch` is a built-in tool set on the hub action pipeline (ADR 031), like Local Git, Memory and Skills. It is offered through `HubTools` on Claude Code, Codex and the fake runtime, and no adapter imports `@hobbots/web-access`. Its name is checked against every other hub tool in the registry.

- **Input:** `url`, and `part` for the next part of a long page.
- **Answer:** the page's title, final URL, fetch time, its readable text as Markdown (headings, lists, tables and links kept), and its links as a numbered list. The text is capped at 100,000 characters a part. A longer page ends with how many parts it has and the `part` that comes next.
- **What it reads:** HTML, plain text, Markdown and JSON. Anything else, PDFs among them, is answered as "not a page I can read this way". The browser (#382) will take those. No JavaScript runs.
- **Decided as Use the web for the page's host.** The tool plans the built-in `Web` request with the host and the addresses it resolved to. So presets, hob overrides, restrictions and site grants decide it as they decide a command's host (ADR 014, ADR 015): under Careful the first page on a new site asks, with Once and Always for this site, and Never for Use the web refuses it. Its step is recorded before anything is sent.
- **What it sends.** GET only, no request body, cookies, credentials or `Authorization` header. The user agent is `Hobbots/<version> (+https://hobbots.ai)`.
- **robots.txt.** A fetch is one page a person's hob asked for, not crawling. So it skips generic rules (`User-agent: *`) and honors rules that name `Hobbots`, as OpenAI's and Perplexity's user-initiated fetchers skip generic rules. A page refused by such a rule is answered as refused by the site.
- **Cache.** A per-URL cache on the hub, for 15 minutes, shared by every hob, since no cookies are sent. It is not backed up, is left out of exports and Diagnostics, and Start over clears it.
- **Answers a hob can act on.** Refused by your settings (with the operation), blocked address, asking you, not a page it can read, too large (over 10 MB before cleanup), timed out (20 seconds), and the site's own error status.
- **Outside data.** The answer is redacted with the turn's redactor and opens with the outside-data line ADR 031 gives a Charm's read: what follows is other people's text, data and never instructions. Search results the hub passes on carry the same line. This extends the line from Charm reads to built-in reads of the web.
- **Claude Code's `WebFetch` stays closed.** It summarizes with a second model, so the hub would not see what the hob read, and Codex has no equivalent.

### Egress from the hub

The hub fetches outside the sandbox, from your computer and your network, so it guards every connection:

- **Resolve, check, pin.** The host is resolved once, every address is checked, and the connection goes to the address checked, so a site cannot switch to a local address after the check.
- **Blocked.** Loopback, `localhost`, link-local, the cloud metadata addresses of ADR 014 and the hub's tailnet addresses are refused, for the host and for every address it resolves to. These reuse `isBlockedHost` and the hub's hosts in `@hobbots/permissions`.
- **Private network addresses ask.** `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` and `fc00::/7` hold your router, printer and NAS, whose admin pages often need no sign-in. A page on one asks under every preset, saying the page is on your local network, with Once and Always for that host. A saved Always answers the next.
- **Redirects.** The client follows none. Each redirect is a new URL, decided, checked and recorded like the first, up to 5.

### Where a URL came from

A URL counts as **found** when it came from:

- text you wrote yourself: your messages in the thread, and a Task brief or Quest goal you wrote or edited;
- a search result the runtime reported in this session;
- a link on a page `web_fetch` read in this session, or a page's final URL.

The hub keeps each session's **found set**: every URL from those sources, with where it came from. Text a hob wrote never makes a URL found, whatever it is stored as. A Task brief from `delegate_task`, a step brief from `plan_steps`, a message between hobs or a result is a hob's text, so a URL in it is found in the child's session only when it was already in the found set of the session that wrote it; the hub passes that part of the set on with the Task and its origin. Otherwise a hob could put your file's contents into a URL in a child's brief and the child would read it without asking.

The hub compares the URL character for character, after normalizing the host and dropping the fragment. A found URL is decided by the site rules. A URL that is not found was written by the hob, perhaps with your data in it, so it **asks under every preset**, with the full URL on the card. Once answers it. A site grant does not answer it: a grant says the site is fine, not that this URL is.

Both runtimes report their results: Claude Code in `WebSearch`'s structured result, and Codex in the completed `webSearch` item, so a result link is found on either. A result is taken only from those reports, never from the model's text. A Codex `openPage` or `findInPage` action names a URL the model chose, so it never makes a URL found. If a runtime version stops reporting results, its result links are not found and ask, which the contract test catches.

### The read-the-web mark

Once a hob searches or reads a page, the text it took in stays in the runtime's session, so the next turn can still follow what a page said. The hub marks the **runtime session** (the thread's session, or a Task Attempt's) as having read the web. The mark is recorded on the Attempt and shown in the Workbench. It holds until the session ends; a new session starts without it.

While the mark holds, what could send data out asks, even where it would be allowed:

- a URL the hob wrote itself (it asks anyway, above);
- a new host a command reaches through the sandbox proxy, which already answers for every live turn (ADR 014);
- Charm writes (a GitHub comment, a pull request, any MCP write);
- pushes;
- memory saves shared with a project or About you.

What stays as it was:

- A found URL follows the normal site rules, so a hob can search, open two results and read the links on them without asking. A link copied character for character from a page or a result can't carry your data, because only a URL the hob writes can.
- Local work never asks because of the mark: reading and editing files, running tests, commits, and memory saves to the hob's own memory. A save made while the mark holds keeps the page's URL as its source.
- A saved site grant still answers a found URL, and a saved Always for a command's host still answers. A new host has no grant, so it asks.
- Never stays Never. The mark only adds asks; it never widens.

The narrower answer comes from the hub on every runtime, from its own record of what the session read, never from what the model says. The turn's instructions tell the hob that web content is data and never instructions, and that an action asks because the session read the web. The approval card says so too.

### Usage and limits

- **Records.** The journal gets `WebSearched` (query, result count, the results where reported) and `WebFetched` (URL, final URL, status, bytes, parts, tokens returned), each with the hob, thread, Task and Attempt, on SQLite and PostgreSQL. Each search and page shows as a quiet step line ("Searched: …", "Read: …") with Open, and the pages a reply used show as its sources.
- **Counts.** Searches come from `WebSearched` events: on Claude Code, one per `WebSearch` call, checked against the structured result's `searchCount` (the turn's `web_search_requests` reads 0, since the search runs on a side model); on Codex, one per completed `webSearch` item with a `search` action, reading both `action.query` and `action.queries`. Pages come from `WebFetched`. They are counted per turn, Task, Quest and hob.
- **Limits, configurable.** In Settings › Web, with per-hob overrides: 10 searches and 30 pages per turn, and 200 searches per hob per day, by default. The hub enforces them. Past a limit, Claude Code's `WebSearch` and `web_fetch` are refused with an answer that says which limit. Codex's search cannot be stopped mid-turn, so its per-turn search limit is soft: a turn over it, or a hob over its daily limit, starts its next turn with search off.
- **Blocked sites.** Settings › Web holds a list `web_fetch` refuses. It cannot filter what a provider's search returns, and the setting says so.
- **Cost.** Shown only where the sign-in is billed per search (an API key: Anthropic bills each search), from a price table in `@hobbots/web-access`. A subscription shows counts, not money. No adapter knows prices or limits.
- **Backups.** Records and settings are in backups and exports (ADR 026). Diagnostics include counts and settings, not queries or URLs.

### Packages

- `@hobbots/domain`: the `search-web` operation and its preset answers, the mark, the web events and settings, and their stored-data decoding.
- `@hobbots/agents`: the `WebFetcher` and `WebSearchProvider` ports, and the pure rules: provenance, the mark, limits.
- `@hobbots/web-access` (new, adapter layer; `@hobbots/web` is already the browser app): the HTTP client, the address guard, page to text, paging, the cache and the price table. No other module imports it, and it imports no runtime and no Charm; the layer check holds that. `@hobbots/server` composes it behind the ports.
- **Libraries, not our own.** Effect's HTTP client over undici (`NodeHttpClient.layerUndiciOptions` from `@effect/platform-node` 4.1.0), with undici's `connect.lookup` resolving once, checking and pinning the address, and redirects handled by the hub. `undici` 8.12.4 if a guard needs it directly. For the text, `@mozilla/readability` 0.6.0 on `linkedom` 0.18.15 with `turndown` 7.2.5 for Markdown, or `defuddle` 0.19.6, which returns Markdown itself. #1267 compares the two on a fixed set of real pages (articles, docs, release notes, a license file, a GitHub page) and records the pick and its reasons. Each is added at its latest stable release, as an exact version, after reading its current documentation.

### Browser use (#382)

The browser reuses this slice: its traffic goes through the sandbox proxy and is decided by the same Use the web site rules and grants; it uses the same provenance rule, the same read-the-web mark and the same records, with `BrowserNavigated` beside them. The Workbench's Browser tab stays Coming soon until #382 fills it. `web_fetch` is its baseline: the browser earns its place on pages `web_fetch` cannot read.

### Privacy

What leaves your computer, for `PRIVACY.md`, `SECURITY.md` and the Permissions tab: search queries go to Anthropic or OpenAI, which run the search with their partners; pages are requested from your own address, with the Hobbots user agent and nothing else of yours.

## Rationale

**Built in, with a port.** A Charm is a connection with an account and credentials (ADR 031). A search through a provider you already use, and a GET of a public page, have neither. Making them a Charm would add a grant step and a row for something every hob should have. The port keeps a key-based provider a small change later.

**Cached on Codex.** Live search would match Claude Code's freshness, but it is the one path where a page opens outside the hub, its site rules and the mark. Cached search plus `web_fetch` gives fresh pages on both runtimes through one tool, so the experience is the same and the rules are too.

**Holding the mode by test.** The probe shows Codex's mode depends on how it is started, and the only setting that holds it changes your own Codex. A contract test on each supported version is the check we can own. Failing closed keeps a regression from turning into live search.

**The mark on the session.** A turn boundary does not clear what the model read. Tying the mark to the session matches where the text lives. Exempting found URLs keeps the common case quiet: search, read the results, answer. The ways data could leave still ask.

**Private addresses ask rather than block.** Blocking them would break reading your own dev server or NAS docs. Asking with the host on the card lets you allow the ones you mean, once.

**robots.txt.** Honoring generic rules would make a hob fail on pages you could open yourself. Skipping them while sending an honest user agent, and honoring rules that name Hobbots, lets a site still opt out.

## Consequences

- [#1266](https://github.com/otaviobarros/hobbots/issues/1266) adds Search the web, `PromptRequest.webSearch`, `WebSearch` on Claude Code, `"cached"` on Codex, the fake runtime's scripted search, `WebSearched` and the not-offered state, and probes both runtimes' search with a real sign-in.
- [#1267](https://github.com/otaviobarros/hobbots/issues/1267) creates `@hobbots/web-access` and `web_fetch`: the address guard, provenance, robots.txt, the cache and the library comparison.
- [#1268](https://github.com/otaviobarros/hobbots/issues/1268) adds the read-the-web mark and what asks while it holds.
- [#1269](https://github.com/otaviobarros/hobbots/issues/1269) records searches and pages, enforces the limits and adds Settings › Web.
- [#1270](https://github.com/otaviobarros/hobbots/issues/1270) and [#1271](https://github.com/otaviobarros/hobbots/issues/1271) design and build the step lines, sources, approval card variants, the Web group in Permissions, Built in rows in the Charms tab, Settings › Web and usage. No Browser tab history in this slice.
- [#1272](https://github.com/otaviobarros/hobbots/issues/1272) proves it end to end and updates `PRIVACY.md` and `SECURITY.md`.
- ADR 024's list of tools Codex keeps off no longer includes cached web search. Live and indexed search stay off.
- Out of scope: the browser (#382), signed-in browsing, search providers with your API key, Codex's live and indexed modes, and PDFs.

## Amendment: records and limits ([#1269](https://github.com/otaviobarros/hobbots/issues/1269))

Building Usage and limits settled these details.

- **Records.** Migration `0089_web_usage` keeps `web_searches` and `web_fetches`, one row per search a runtime reported and per page `web_fetch` read, each with its hob, chat, reply, Task, Attempt and turn, on SQLite and PostgreSQL. Each row commits with its journal event, `WebSearched` or `WebFetched`. A search keeps its query, result count, each result's title and URL (not its snippet) and where the turn was billed. A page keeps the URL asked for, the URL read after redirects, the status, the bytes the site sent, its parts and the part read, and the answer's tokens, estimated at one per four characters. A page that was refused or failed is not a page read and has no row.
- **The turn.** A turn is a chat reply (`reply:<id>`) or an Attempt's turn outside a chat (`attempt:<id>`). Counts per Task and Quest come from the rows' Task, and a Quest counts every Task in its tree. The daily limit counts the hob's searches in the last 24 hours.
- **Enforcement without the adapters knowing a limit.** The hub settles each turn's search and hands the adapter `PromptRequest.checkWebSearch`, which it asks before each search. Claude Code asks it in the policy hook and the fake runtime before its scripted search, and a search it refuses is denied with the hub's words, such as "This turn reached its limit of 10 web searches, set in Settings › Web." Codex cannot stop a search inside a turn, so it never asks. A turn that ran more searches than its limit holds search off for the next turn of the same session (the thread, or the Task outside a chat), kept in `web_search_holds` and taken once. A hob at its daily limit starts every turn with search off, on every runtime. When a limit turns search off, the turn's briefing says which one.
- **Pages.** `web_fetch` counts a page as its send starts, so calls that run at once cannot pass the limit together, and refuses one past it with words that name the limit.
- **Blocked sites** are kept as host names: a URL or a `*.` you enter is cut to its host, and an entry that names no host is refused. A site blocks every name under it. `web_fetch` refuses a blocked site before it looks the name up, and a redirect to one too.
- **Settings.** Settings › Web is one row in `web_settings`, and a hob's own limits are its row in `agent_web_limits`, where a null limit follows Settings › Web. Each change is journaled as `WebSettingsChanged` or `HobWebLimitsChanged`. Only a user session reaches `GET` and `PUT /api/web/settings` and `/api/agents/:agentId/web-limits`, and `GET /api/web/usage`, which lists a hob's, chat's, reply's, Task's, Attempt's or Quest's newest records with totals over all of them.
- **Cost.** `@hobbots/web-access` holds the price table: Anthropic's $10 per 1,000 searches for Claude Code on an API key or the Claude API. Codex has no price, since Hobbots signs it in with a ChatGPT plan. The total's estimated cost is null when no search was billed per search, or when a billed runtime has no price, so a subscription never shows money and Hobbots never guesses one.
- **Backups, exports and Diagnostics.** The tables are in the database, so a backup and a restore keep them. An export holds the records of its thread or hob, and an export of everything also holds Settings › Web and each hob's own limits. Diagnostics hold the limits, how many sites are blocked, and how many searches and pages all hobs made in the last 24 hours, never a query, a URL or a site. The page cache lives in the hub's memory, so it is in none of them, and Start over, which ends the hub, clears it.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- With Hobbots' App Server settings and a stand-in model, Codex 0.166.0 and 0.167.0 send `external_web_access: false` for `web_search = "cached"`, and no search tool for `"disabled"`. Under `codex exec --sandbox danger-full-access` the same `"cached"` sends `external_web_access: true`, and a `requirements.toml` in `CODEX_HOME` does not hold it ([evidence](../evidence/2026-11-08-codex-web-search-modes.md)).
- In the clean-runtime contract tests, a hob allowed to search is offered its runtime's search and one set to Never is not, on Claude Code and Codex. Codex's first request of a new and a resumed thread carries `external_web_access: false`, and a version that does not is reported as not offering search. Neither runtime reads a web setting from `~/.claude` or `~/.codex`: `[TC-RT-1266-09]`, `[TC-RT-1266-10]`, `[TC-RT-1266-11]`, on Claude Code 2.1.319 and Codex 0.166.0 and 0.167.0. A Codex turn under Never that starts beside one of the same hob that may search does not search: `[TC-RT-1266-12]`. A Codex version the test did not hold is reported as not offering search, and Permissions shows Search the web as not offered: `[TC-RT-1266-01]`, `[TC-RT-1266-04]`, `[TC-PE-1266-03]`.
- A real search on Claude Code 2.1.316 with a claude.ai sign-in, and on Codex 0.166.0 and 0.167.0 in cached mode with a ChatGPT sign-in, on macOS, reported its query and its results with titles and URLs; Claude Code counted it only in the side model's usage, and Codex's token usage had no search count ([evidence](../evidence/2026-11-08-codex-web-search-modes.md#real-searches-on-macos)). The adapters report each search as `WebSearched` with its query and the hits from the runtime's structured result, label the results as other people's text, and count each search in the turn's usage, on Claude Code, Codex and the fake runtime: `[TC-RT-1266-02]`, `[TC-RT-1266-03]`, `[TC-RT-1266-05]`, `[TC-RT-1266-06]`, `[TC-RT-1266-07]`, `[TC-RT-1266-08]`. That they do so on a real search is not proven yet ([#1272](https://github.com/otaviobarros/hobbots/issues/1272)).
- Narrowing Search the web to Never stops a running turn. An override of Ask is refused, by the hub and by the policy engine: `[TC-PE-021]`, `[TC-PE-1266-01]`, `[TC-PE-1266-02]`, `[TC-PE-1266-04]`, `[TC-AG-1266-01]`.
- A hob reads a page and gets its title, final URL, text and links, and a long page in parts; a PDF is answered as not readable this way. Proven at hub level with the fake runtime and a local test site: `[TC-PE-1267-10]`, and in the fetcher `[TC-PE-1267-01]` to `[TC-PE-1267-08]` ([evidence](../evidence/2026-11-08-web-fetch.md)).
- Under Careful the first page on a new site asks and Always for the site answers the next; Never for Use the web refuses it. Proven at hub level: `[TC-PE-1267-11]` ([evidence](../evidence/2026-11-08-web-fetch.md)).
- `localhost`, `127.0.0.1`, `169.254.169.254`, a host that resolves to one and a redirect to one are refused; a private address asks with Once and Always for its host. Proven at hub level: `[TC-PE-1267-12]`, the pinned connection in `[TC-PE-1267-07]`, and the engine in `[TC-PE-1267-18]` ([evidence](../evidence/2026-11-08-web-fetch.md)).
- A URL the hob built with data in it asks under every preset, while a link from a page it read does not. A URL with data in it that a hob put into a child's Task brief or step brief asks in the child's session, while a URL the parent had found passes on as found. Proven at hub level: `[TC-PE-1267-13]`, `[TC-PE-1267-19]`, for a Task brief in a party member's turn `[TC-PE-1267-20]`, and for a step brief `[TC-PE-1267-14]`, where the step, which cannot ask (ADR 018), holds the written URL for you instead ([evidence](../evidence/2026-11-08-web-fetch.md)).
- A search's results are found URLs in its session before the hob can act on them: the hub records them through the turn's `recordSearch`, in a chat turn, a step or a party member's turn, and each adapter only waits for it, before Claude Code's search hook returns, before Codex's next request after the search is handled and before the fake runtime's next call, so no adapter writes to the found set and a slow event reader cannot let a later `web_fetch` or Task brief miss them: `[TC-RT-1289-01]`, `[TC-RT-1289-02]`, `[TC-RT-1289-03]`, `[TC-RT-1289-04]`. Only the runtime's structured results count, never the model's text or the query; a URL that is not http or https is left out, and a search with no structured results adds nothing: `[TC-PE-1289-01]`, `[TC-PE-1289-02]`. After a search, `web_fetch` on a result follows the site rules, while a URL the hob wrote on the same site asks: `[TC-PE-1289-03]`. A step reads its own search's results and those its parent's chat found, which pass on with its brief, and a result the parent never found is held for you: `[TC-PE-1289-04]`. Proven at hub level with the fake runtime and a local test site standing in for its search host, on SQLite and PostgreSQL ([#1289](https://github.com/otaviobarros/hobbots/issues/1289)).
- On Claude Code, Codex and the fake runtime, a `web_fetch` call is recorded before it is sent. Proven in the clean-runtime contract tests: `[TC-PE-1267-15]` on the fake runtime, `[TC-PE-1267-16]` on Claude Code 2.1.319 and `[TC-PE-1267-17]` on Codex 0.167.0 ([evidence](../evidence/2026-11-08-web-fetch.md)).
- After a hob reads a page that tells it to send a file's contents elsewhere, the request asks, whether it goes through a built URL, `curl` to a new host, a GitHub comment or a memory share, on Claude Code and Codex, also in the session's next turn. Not proven yet ([#1268](https://github.com/otaviobarros/hobbots/issues/1268)).
- A hob that searches, opens two result links, edits files and runs tests is asked nothing under Balanced, and a thread that never touched the web is not affected. Not proven yet ([#1268](https://github.com/otaviobarros/hobbots/issues/1268)).
- A memory save made after reading a page names that page as its source. Not proven yet ([#1268](https://github.com/otaviobarros/hobbots/issues/1268)).
- Searches and pages read are recorded with their journal events and counted per turn, hob and day, and Settings › Web, a hob's own limits and a session's hold on search are kept, on SQLite and PostgreSQL: `[TC-PE-1269-01]`, `[TC-PE-1269-02]`. Through the hub, a turn's searches and pages show for the turn and the hob with no cost on a sign-in not billed per search: `[TC-PE-1269-03]`; a cost is estimated only for searches billed per search: `[TC-PE-1269-05]`. Past a hob's limits a search and a page are refused with words that name the limit, and past its daily limit its next turn has search off: `[TC-PE-1269-04]`, `[TC-AG-1269-01]`. Claude Code and the fake runtime ask the hub's limits before each search: `[TC-RT-1269-01]`, `[TC-RT-1269-02]`. A turn over its search limit, as Codex's can be, starts the session's next turn with search off: `[TC-AG-1269-02]`; that a real Codex turn does so is not proven yet ([#1272](https://github.com/otaviobarros/hobbots/issues/1272)). A blocked site, and a name under it, is refused: `[TC-PE-1269-06]`. A restored backup keeps the records and settings: `[TC-OP-1269-01]` ([evidence](../evidence/2026-11-08-web-usage.md)).
- A Claude Code hob and a Codex hob each search, read two pages from the results and answer with them as sources, on the packaged Mac app with real models. Not proven yet ([#1272](https://github.com/otaviobarros/hobbots/issues/1272)).
- Each scenario above runs at hub level with the fake runtime and a local test site on SQLite and PostgreSQL, against an installed Claude Code and an installed Codex in the clean-runtime contract tests, and in the browser. Not proven yet ([#1272](https://github.com/otaviobarros/hobbots/issues/1272)).
