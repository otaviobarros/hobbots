import {
  type Message,
  type MessageId,
  type ReplyStep,
  WEB_FETCH_TOOL,
  type WebFetchRecord,
  type WebSearchRecord,
  type WebUsage,
} from "@hobbots/domain";

/**
 * What a chat shows of the web (ADR 036): each reply's searches and pages as quiet step lines, the
 * pages it read as its sources, and what Open shows of a page, read back from the answer `web_fetch`
 * gave the hob. Pure, so the rules are tested apart from the screens.
 */

/** A search or a page a reply made, in the order it made them. */
export type WebStep =
  | { readonly _tag: "Search"; readonly search: WebSearchRecord }
  | {
      readonly _tag: "Page";
      readonly page: WebFetchRecord;
      readonly title: string | null;
      readonly stepId: string | null;
    };

/** What a reply searched and read, and the pages it can cite. */
export interface ReplyWeb {
  readonly steps: ReadonlyArray<WebStep>;
  /** The pages it read, each once, in the order it first read them. */
  readonly sources: ReadonlyArray<Extract<WebStep, { readonly _tag: "Page" }>>;
}

const NO_WEB: ReplyWeb = { steps: [], sources: [] };

/** Whether a reply step is a call of `web_fetch`, under any runtime's name for hub tools. */
const isWebFetchStep = (step: ReplyStep): boolean => step.call !== undefined && isWebFetchTool(step.call.tool);

/** Whether a runtime's tool name is the hub's page tool, bare or behind its MCP server's prefix. */
export const isWebFetchTool = (tool: string): boolean =>
  tool === WEB_FETCH_TOOL || tool.endsWith(`__${WEB_FETCH_TOOL}`);

/** Whether a reply step is a search the runtime ran. */
const isSearchStep = (step: ReplyStep): boolean => step.call?.operation === "search-web";

/**
 * A web step a step line already shows: a search or a page that went through. One that asks, was
 * refused or failed stays with the reply's other steps, which say why.
 */
export const shownAsWebLine = (step: ReplyStep): boolean =>
  step.state === "done" && (isSearchStep(step) || isWebFetchStep(step));

/** The `Name: value` line an answer's head holds, or null. */
const headLine = (head: string, name: string): string | null => {
  const prefix = `${name}: `;
  const line = head.split("\n", 12).find((each) => each.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
};

/** The `web_fetch` step whose answer is the page read from `url`, with the page's title. */
const pageStep = (steps: ReadonlyArray<ReplyStep>, url: string, taken: ReadonlySet<string>) => {
  const step = steps.find(
    (each) =>
      isWebFetchStep(each) &&
      !taken.has(each.id) &&
      each.output !== undefined &&
      headLine(each.output.head, "URL") === url,
  );
  if (step?.output === undefined) return null;
  const title = headLine(step.output.head, "Title");
  return { stepId: step.id, title: title === null || title === "(none)" ? null : title };
};

const oldestFirst = (a: { readonly at: string }, b: { readonly at: string }) => a.at.localeCompare(b.at);

/** Each reply's searches and pages, from a chat's records and its replies' steps. */
export const repliesWeb = (
  usage: WebUsage | undefined,
  replies: ReadonlyArray<Pick<Message, "id" | "steps">>,
): ReadonlyMap<MessageId, ReplyWeb> => {
  const byReply = new Map<MessageId, ReplyWeb>();
  if (usage === undefined) return byReply;
  for (const reply of replies) {
    const searches = usage.searches.filter((search) => search.messageId === reply.id);
    const pages = usage.pages.filter((page) => page.messageId === reply.id);
    if (searches.length === 0 && pages.length === 0) continue;
    const taken = new Set<string>();
    const steps = [
      ...searches.map((search) => ({ _tag: "Search" as const, at: search.at, search })),
      ...pages.map((page) => {
        const found = pageStep(reply.steps, page.finalUrl, taken);
        if (found !== null) taken.add(found.stepId);
        return { _tag: "Page" as const, at: page.at, page, title: found?.title ?? null, stepId: found?.stepId ?? null };
      }),
    ]
      .sort(oldestFirst)
      .map(({ at: _, ...step }) => step as WebStep);
    const seen = new Set<string>();
    const sources = steps.flatMap((step) => {
      if (step._tag !== "Page" || seen.has(step.page.finalUrl)) return [];
      seen.add(step.page.finalUrl);
      return [step];
    });
    byReply.set(reply.id, { steps, sources });
  }
  return byReply;
};

export const replyWebOf = (web: ReadonlyMap<MessageId, ReplyWeb>, id: MessageId): ReplyWeb => web.get(id) ?? NO_WEB;

/** A URL's host, as a step line names the site; the URL itself when it has none. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** What `web_fetch` answered for a page, read back from its answer. */
export interface PageAnswer {
  readonly title: string | null;
  readonly url: string | null;
  /** When the hub read the page from its site: earlier than the record when it came from the cache. */
  readonly fetchedAt: string | null;
  readonly redirectedFrom: ReadonlyArray<string>;
  /** Which part this is, and of how many. */
  readonly part: number;
  readonly parts: number;
  /** The page's text as the hob got it. */
  readonly text: string;
  readonly links: ReadonlyArray<{ readonly text: string; readonly url: string }>;
  /** How many links the answer left out. */
  readonly moreLinks: number;
}

const PART = /^Part (\d+) of (\d+)/;
const LINK = /^\d+\. (?:(.*): )?(https?:\/\/\S+)$/;
const MORE_LINKS = /^… and (\d+) more on the page\.$/;

/**
 * The links at the end of an answer's body, after its last `Links:` line, and the body before them.
 * A `Links:` line the page itself wrote, followed by anything but links, stays in the text.
 */
const linksOf = (body: ReadonlyArray<string>) => {
  const at = body.lastIndexOf("Links:");
  const tail = at === -1 ? [] : body.slice(at + 1);
  if (at === -1 || !tail.every((line) => LINK.test(line) || MORE_LINKS.test(line))) {
    return { links: [], moreLinks: 0, before: body };
  }
  const links: Array<{ text: string; url: string }> = [];
  let moreLinks = 0;
  for (const line of tail) {
    const link = LINK.exec(line);
    if (link !== null) links.push({ text: link[1] ?? "", url: link[2] ?? "" });
    const more = MORE_LINKS.exec(line);
    if (more !== null) moreLinks = Number(more[1]);
  }
  return { links, moreLinks, before: body.slice(0, at) };
};

/**
 * The parts of a `web_fetch` answer: the head lines (the outside-data line, Title, URL, Redirected
 * from, Fetched, the part and the mark's note), then the text, then the links on a first part.
 */
export const parsePageAnswer = (answer: string): PageAnswer => {
  const lines = answer.split("\n");
  const blank = lines.indexOf("");
  const head = blank === -1 ? lines : lines.slice(0, blank);
  let rest: ReadonlyArray<string> = blank === -1 ? [] : lines.slice(blank + 1);
  const value = (name: string) => {
    const line = head.find((each) => each.startsWith(`${name}: `));
    return line === undefined ? null : line.slice(name.length + 2).trim();
  };
  const part = head.map((line) => PART.exec(line)).find((match) => match !== null);
  const { links, moreLinks, before } = linksOf(rest);
  rest = before;
  const title = value("Title");
  const redirected = value("Redirected from");
  const text = rest.join("\n").trim();
  return {
    title: title === null || title === "(none)" ? null : title,
    url: value("URL"),
    fetchedAt: value("Fetched"),
    redirectedFrom: redirected === null ? [] : redirected.split(" → "),
    part: part ? Number(part[1]) : 1,
    parts: part ? Number(part[2]) : 1,
    text: text === "(no text)" ? "" : text,
    links,
    moreLinks,
  };
};

/** How far apart a page's read and its record may be and still count as read fresh from the site. */
const FRESH_MS = 60_000;

/** Whether the page came from the hub's cache: read from its site well before the hob was answered. */
export const fromCache = (answer: Pick<PageAnswer, "fetchedAt">, recordedAt: string): boolean | null => {
  if (answer.fetchedAt === null) return null;
  const read = Date.parse(answer.fetchedAt);
  const recorded = Date.parse(recordedAt);
  if (Number.isNaN(read) || Number.isNaN(recorded)) return null;
  return recorded - read > FRESH_MS;
};

/** Where a page's link came from, as far as the chat's records tell: the search that found it. */
export const foundBy = (url: string, searches: ReadonlyArray<WebSearchRecord>): WebSearchRecord | null =>
  searches.find((search) => (search.results ?? []).some((result) => sameUrl(result.url, url))) ?? null;

/** Two URLs as found URLs compare them: without a fragment, host in lowercase. */
export const sameUrl = (a: string, b: string): boolean => {
  const key = (raw: string) => {
    try {
      const url = new URL(raw);
      url.hash = "";
      return url.href;
    } catch {
      return raw;
    }
  };
  return key(a) === key(b);
};

/** Whether a chat read a search result, asked for or after a redirect. */
export const wasRead = (url: string, pages: ReadonlyArray<WebFetchRecord>): boolean =>
  pages.some((page) => sameUrl(page.url, url) || sameUrl(page.finalUrl, url));
