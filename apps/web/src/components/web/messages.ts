import { formatBytes, formatCount, formatMoney, plural } from "../../lib/format.ts";

/** User-facing copy for searching and reading the web (ADR 036), wherever it shows (STD-I18N-001). */

/** Who ran a search, by the runtime that ran it. */
const searchedThrough = {
  "claude-code": "Claude Code's search",
  codex: "Codex's search, from OpenAI's cached index",
  fake: "The test search, which reaches no network",
} as const;

/** Who a search's query went to, by the runtime that ran it. */
const queryWentTo = {
  "claude-code": "The query went to Anthropic, who ran the search. Nothing was sent from your computer.",
  codex: "The query went to OpenAI, who looked it up in its cached index. Nothing was sent from your computer.",
  fake: "The test search ran inside Hobbots. Nothing was sent from your computer.",
} as const;

const results = (count: number) => plural(count, { one: `${count} result`, other: `${formatCount(count)} results` });
const pages = (count: number) => plural(count, { one: "1 page", other: `${formatCount(count)} pages` });
const searches = (count: number) => plural(count, { one: "1 search", other: `${formatCount(count)} searches` });

export const messages = {
  retry: "Try again",
  reading: "Reading…",
  lines: {
    list: ({ name }: { name: string }) => `What ${name} looked up`,
    searched: "Searched:",
    results: ({ count }: { count: number }) => `· ${results(count)}`,
    noResults: "· no results reported",
    read: "Read:",
    open: "Open",
    openSearch: ({ query }: { query: string }) => `Open the search ${query}`,
    openPage: ({ site }: { site: string }) => `Open the page from ${site}`,
  },
  sources: {
    label: "Sources",
  },
  sheet: {
    close: "Close",
    page: {
      eyebrow: ({ name }: { name: string }) => `A page ${name} read`,
      read: "Read",
      readCached: ({ when, cached }: { when: string; cached: string }) =>
        `${when}, from the cache Hobbots read at ${cached}`,
      readWhen: ({ when }: { when: string }) => when,
      foundIn: "Found in",
      foundBy: ({ query }: { query: string }) => `A result of the search “${query}”`,
      redirected: "Redirected from",
      got: "Got",
      gotText: ({
        characters,
        part,
        parts,
        bytes,
      }: {
        characters: number;
        part: number;
        parts: number;
        bytes: number;
      }) =>
        `${plural(characters, { one: "1 character", other: `${formatCount(characters)} characters` })} of text · part ${part} of ${parts} · ${formatBytes(bytes)} downloaded`,
      gotBytes: ({ part, parts, bytes }: { part: number; parts: number; bytes: number }) =>
        `Part ${part} of ${parts} · ${formatBytes(bytes)} downloaded`,
      openInBrowser: "Open in your browser",
      copyLink: "Copy link",
      copied: "Copied",
      others: ({ name }: { name: string }) =>
        `This is the text ${name} got, not the page as your browser shows it. Pages are other people's words, so ${name} treats them as data, never as instructions.`,
      textLabel: ({ name }: { name: string }) => `Text ${name} got`,
      part: ({ part, parts }: { part: number; parts: number }) => `Part ${part} of ${parts}`,
      reading: "Reading what it got…",
      noText: "The page had no text to read.",
      textFailed: "Hobbots could not open the text it kept from this page.",
      unkept: ({ name }: { name: string }) =>
        `Hobbots no longer has the text ${name} got from this page. Open it in your browser to see the page as it is now.`,
      links: "Links on the page",
      moreLinks: ({ count }: { count: number }) =>
        plural(count, { one: "And 1 more link.", other: `And ${formatCount(count)} more links.` }),
    },
    search: {
      eyebrow: ({ name }: { name: string }) => `A search ${name} ran`,
      searched: "Searched",
      through: "Through",
      through_: searchedThrough,
      results: "Results",
      resultCount: ({ count }: { count: number }) => `${results(count)}, as the search returned them`,
      noResults: "None reported",
      went: queryWentTo,
      list: "Results",
      readMark: "· Read",
      none: "The search reported no results Hobbots could show.",
    },
  },
  ask: {
    title: {
      site: ({ name }: { name: string }) => `${name} asks to read a page on a new site`,
      local: ({ name }: { name: string }) => `${name} asks to read a page on your local network`,
      written: ({ name }: { name: string }) => `${name} asks to open an address it wrote itself`,
      readWeb: ({ name }: { name: string }) => `${name} asks after reading the web`,
    },
    why: {
      site: ({ preset }: { preset: string }) => `Under ${preset}, the first page on each site asks.`,
      siteAny: "The first page on each new site asks at your safety level.",
      local: ({ host }: { host: string }) =>
        `${host} is on your local network, where routers, printers and NAS boxes live and often need no sign-in. A page there asks under every safety level.`,
      written: ({ name }: { name: string }) =>
        `This address was not in your messages, a search result or a page ${name} read. An address a hob writes can carry your data in it, so it always asks.`,
    },
    readWeb: {
      title: "Asks because this chat read the web.",
      body: ({ name }: { name: string }) =>
        `${name} read the web in this chat. Until the chat ends, anything that could send your data out asks first: new addresses, new hosts for commands, Charm writes, pushes and shared memory.`,
    },
    alwaysSite: "Always for this site",
    alwaysHost: "Always for this host",
  },
  rules: {
    heading: "Site rules",
    intro: ({ preset, newSite }: { preset: string; newSite: "allow" | "ask" | "never" }) =>
      newSite === "allow"
        ? `Under ${preset} a new site is allowed. These are the sites you answered for this hob. A page on your local network always asks until you allow its host.`
        : newSite === "ask"
          ? `Under ${preset} a new site asks first. These are the sites you answered for this hob. A page on your local network always asks until you allow its host.`
          : `Under ${preset} no site is reached. These are the sites you answered for this hob.`,
    none: "No site rules yet. Answering Always for a site on an approval card adds one here.",
    always: "Always",
    allow: "Allow",
    savedInChat: ({ date }: { date: string }) => `Always · you allowed it in a chat, ${date}`,
    saved: ({ date }: { date: string }) => `Always · saved ${date}`,
    remove: "Remove",
    removeLabel: ({ host }: { host: string }) => `Remove the rule for ${host}`,
    removing: "Removing…",
    alwaysAsk: ({ name }: { name: string }) =>
      `Two things always ask, whatever these say: an address ${name} wrote itself, and, once a chat has read the web, anything that could send your data out of that chat.`,
    failed: "Hobbots could not remove the rule. Try again.",
    readFailed: "Hobbots could not read this hob's site rules.",
  },
  limits: {
    heading: "Web limits",
    summary: ({
      searchesPerTurn,
      pagesPerTurn,
      searchesPerDay,
    }: {
      searchesPerTurn: number;
      pagesPerTurn: number;
      searchesPerDay: number;
    }) => `${searches(searchesPerTurn)} and ${pages(pagesPerTurn)} a turn · ${searches(searchesPerDay)} a day`,
    shared: "The same as every hob, from Settings › Web.",
    own: ({ name }: { name: string }) => `Only ${name}. Everyone else uses Settings › Web.`,
    setFor: ({ name }: { name: string }) => `Set for ${name}`,
    useShared: "Use Settings › Web",
    save: "Save limits",
    cancel: "Cancel",
    saving: "Saving…",
    failed: "Hobbots could not save the limits. Try again.",
    readFailed: "Hobbots could not read this hob's web limits.",
    searchesPerTurn: "Searches in one turn",
    pagesPerTurn: "Pages read in one turn",
    searchesPerDay: "Searches a day",
  },
  builtIn: {
    heading: "Built in",
    intro: ({ name }: { name: string }) =>
      `Every hob has these. They act on no account and hold no sign-in, so there is nothing to connect. What ${name} may do with them is set in Permissions.`,
    inPermissions: "In Permissions",
    search: {
      name: "Web search",
      what: ({ answer }: { answer: string }) => `Looks things up and brings back links. Search the web: ${answer}.`,
      claude: "Its own search tool. Hobbots checks each search before it runs, and counts it.",
      codex:
        "Its own search, from OpenAI's cached index only. Hobbots turns it on or off for each turn; it cannot pause mid-turn, so it has no Ask.",
    },
    pages: {
      name: "Reading pages",
      what: ({ answer }: { answer: string }) =>
        `Reads a page as text, with its title, address and links. Use the web: ${answer}, with your site rules.`,
      claude:
        "Hobbots' own page tool. Claude Code's WebFetch stays off, since it summarizes pages where Hobbots cannot see them.",
      codex:
        "The same Hobbots tool, so every page follows the same rules on both. Codex has no page reader of its own.",
    },
    runtime: { "claude-code": "Claude Code", codex: "Codex" },
    thisHob: ({ name }: { name: string }) => name,
    notOffered: "Not offered",
  },
  settings: {
    title: "Web",
    intro:
      "How much your hobs search and read the web, the sites they never read, and what leaves your computer when they do. Which sites a hob may use is set by your safety level and its Permissions.",
    limits: "Limits for every hob",
    searchesPerTurn: { label: "Searches in one turn", note: "Per hob, per reply. Default 10." },
    pagesPerTurn: { label: "Pages read in one turn", note: "Per hob, per reply. Default 30." },
    searchesPerDay: { label: "Searches a hob makes in a day", note: "Counted over the last 24 hours. Default 200." },
    limitsNote:
      "A hob over a limit is told which one, and finishes its reply without more searches or pages. Codex runs its search inside the AI's turn and can't be stopped mid-turn, so on Codex the next turn starts with search off instead. Set a different limit for one hob in its Permissions.",
    reset: "Reset to 10, 30 and 200",
    saved: "Saved",
    saving: "Saving…",
    failed: "Hobbots could not save Settings › Web. Your changes are still here; try again.",
    readFailed: "Hobbots could not read Settings › Web.",
    invalidLimit: "Enter a whole number from 0.",
    blocked: "Sites hobs never read",
    blockedNone: "No sites are blocked.",
    blockPlaceholder: "A site, like example.com",
    blockLabel: "A site to block",
    block: "Block",
    remove: "Remove",
    removeLabel: ({ site }: { site: string }) => `Remove ${site} from the blocked sites`,
    blockedNote:
      "Blocking covers the site and every subdomain. A search can still list these sites, because the search runs at Anthropic or OpenAI, but a hob can't open them.",
    leaves: "What leaves your computer",
    leave: {
      search: {
        label: "A search",
        text: "The words a hob searches for go to the AI it thinks with: Anthropic for Claude Code, OpenAI for Codex. They run the search with their partners. Nothing goes out from your computer.",
      },
      page: {
        label: "A page",
        text: "Hobbots asks for the page from your own address and network, as Hobbots with its version and hobbots.ai. No cookies, sign-ins or anything else of yours. The page's text then goes to the hob's AI, like anything else it reads.",
      },
      never: {
        label: "Never reached",
        text: "This computer, its tailnet address, link-local and cloud metadata addresses, even through a redirect. Pages on your local network ask every time until you allow the host.",
      },
      robots: {
        label: "robots.txt",
        text: "A hob reads one page you asked for, so Hobbots skips rules meant for crawlers. A site can still keep hobs out with a rule that names Hobbots.",
      },
      kept: {
        label: "Kept here",
        text: "Searches and pages are recorded in each chat and in Usage, and are in your backups. Diagnostics hold only counts, never what was searched or read.",
      },
    },
    cache: "Page cache",
    cacheHeld: ({ count, bytes }: { count: number; bytes: number }) =>
      count === 0 ? "No pages cached" : `${pages(count)} cached · ${formatBytes(bytes)}`,
    cacheNote:
      "A page read in the last 15 minutes is shared by every hob, since no cookies are sent. Not backed up; Start over clears it.",
    clear: "Clear now",
    clearing: "Clearing…",
    clearFailed: "Hobbots could not clear the cache. Try again.",
    cacheFailed: "Hobbots could not read the page cache.",
  },
  usage: {
    heading: "Searches and pages",
    view: "Show",
    byHob: "By hob",
    busiest: "Busiest turns",
    searches: ({ count }: { count: number }) => formatCount(count),
    searchesLabel: ({ period }: { period: string }) => `searches · ${period}`,
    pagesLabel: ({ period }: { period: string }) => `pages read · ${period}`,
    noCost: "No extra cost",
    noCostNote: "searches are part of your Claude and ChatGPT plans",
    cost: ({ usd }: { usd: number }) => formatMoney(Math.round(usd * 100), "USD"),
    costNote: ({ count }: { count: number }) =>
      `for ${searches(count)} billed on an API key, at $10 per 1,000 on Claude Code`,
    columns: { hob: "Hob", turn: "Turn", searches: "Searches", pages: "Pages", limits: "Limits" },
    runtime: {
      "claude-code": "Claude Code",
      codex: "Codex · cached search",
      fake: "Test runtime",
    },
    noSearch: "No search",
    atLimit: ({ count }: { count: number }) =>
      plural(count, { one: "Reached a limit once", other: `Reached a limit ${formatCount(count)} times` }),
    within: "Within limits",
    notOffered: "Search not offered",
    reached: { searches: "At the search limit", pages: "At the page limit" },
    showAll: ({ count }: { count: number }) => `Show all ${formatCount(count)} hobs`,
    showTop: "Show the top 5",
    sortNote: "Most searches first. Open a hob to see its chats.",
    turnsNote: ({ count }: { count: number }) =>
      plural(count, {
        one: "The only turn that used the web. Open it to see its steps in the chat.",
        other: `The busiest of ${formatCount(count)} turns that used the web. Open one to see its steps in the chat.`,
      }),
    countedNote: "Counted from each search a runtime reports and each page Hobbots read.",
    limitsLink: "Limits are in Settings › Web.",
    none: "No hob searched or read a page in this time.",
    untitled: "A chat",
    taskTurn: "A step outside a chat",
    failed: "Hobbots could not read searches and pages.",
    turnBy: ({ name, when }: { name: string; when: string }) => `${name} · ${when}`,
  },
} as const;
