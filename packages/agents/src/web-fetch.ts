import {
  blockedSiteFor,
  estimatedTokens,
  type Task,
  type TaskId,
  type ThreadId,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_LABEL,
  WEB_FETCH_TOOL,
  WEB_PAGE_PART_CHARS,
  WebFetchInput,
  WebFetchRecord,
  WebRecordId,
  webFetchJsonSchema,
  webTurnKey,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import type { AskableVerdict } from "./asking.ts";
import { type CharmTurn, WebTools } from "./charms.ts";
import {
  type HubActionsOptions,
  type HubPlanContext,
  HubRefusal,
  hubAction,
  offerHubActions,
  outsideDataLine,
} from "./hub-actions.ts";
import { HobbotsRepository } from "./repository.ts";
import type { HubTool, ToolAccess, TurnApprovals, WebSearchedEvent } from "./runtime.ts";
import type { Redactor } from "./secrets.ts";
import { WebRecords, webAnnouncer, webLimitReason, webLimitsOf } from "./web-usage.ts";

/**
 * Reading a web page for a hob on the hub (ADR 036): `web_fetch`, the ports the hub reads pages and
 * keeps found URLs through, and the pure rules of where a URL came from. The HTTP client, the
 * address guard and page to text are `@hobbots/web-access`, which the server composes behind
 * `WebFetcher`; nothing here reaches the network.
 */

/** A link on a page, made absolute, as the hob is shown it. */
export interface WebLink {
  readonly url: string;
  readonly text: string;
}

/** A page the hub read, as text a hob can act on. */
export interface WebPage {
  /** The URL the page was read from, after any redirect. */
  readonly url: string;
  readonly title: string | null;
  /** The status the site answered with, a 2xx. */
  readonly status: number;
  /** The media type the site sent, such as `text/html`. */
  readonly contentType: string;
  /** Its readable text: Markdown for HTML, as the site sent it for the rest. */
  readonly text: string;
  readonly links: ReadonlyArray<WebLink>;
  /** How many bytes the site sent. */
  readonly bytes: number;
  /** When it was read (ISO 8601): earlier than now when it came from the hub's cache. */
  readonly fetchedAt: string;
}

/** What one request answered: the page, or a redirect the hub decides as a new URL. */
export type WebFetched =
  | { readonly _tag: "Page"; readonly page: WebPage }
  | { readonly _tag: "Redirect"; readonly status: number; readonly location: string };

/** Why a page was not read, in words a hob can act on. */
export const WebFetchFailure = Schema.Literals([
  "invalid-url",
  "not-found",
  "blocked-address",
  "unreachable",
  "timed-out",
  "too-large",
  "not-readable",
  "refused-by-site",
  "status",
]);
export type WebFetchFailure = typeof WebFetchFailure.Type;

export class WebFetchFailed extends Schema.TaggedError<WebFetchFailed>()("WebFetchFailed", {
  reason: WebFetchFailure,
  message: Schema.String,
}) {}

/** A host and the addresses it resolved to, once: the request is decided on them and connects to them alone. */
export interface WebTarget {
  readonly host: string;
  readonly addresses: ReadonlyArray<string>;
}

/**
 * Reads public web pages from the hub (ADR 036). `resolve` looks a host up once; `fetch` sends one
 * GET to exactly those addresses, with no cookie, credential or body, and follows no redirect.
 */
export class WebFetcher extends Context.Service<
  WebFetcher,
  {
    readonly resolve: (url: URL) => Effect.Effect<WebTarget, WebFetchFailed>;
    readonly fetch: (url: URL, target: WebTarget) => Effect.Effect<WebFetched, WebFetchFailed>;
  }
>()("@hobbots/agents/WebFetcher") {}

/** A URL a session found, and where it came from, such as "a link on https://example.com/". */
export interface FoundUrl {
  readonly url: string;
  readonly source: string;
}

/**
 * Each session's found set (ADR 036): the URLs it may read under the site rules alone. Kept by the
 * work they belong to, `thread:<id>` for a chat or `task:<id>` for a Task's own sessions, as
 * `webWorkOf` names it. URLs are stored as `foundUrlKey` gives them.
 */
export class WebFoundUrls extends Context.Service<
  WebFoundUrls,
  {
    /** Where each of `urls` was found in the work, for those that were. */
    readonly sources: (work: string, urls: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, string>>;
    /** Adds URLs to the work's set; a URL already there keeps where it was found first. */
    readonly add: (work: string, found: ReadonlyArray<FoundUrl>) => Effect.Effect<void>;
  }
>()("@hobbots/agents/WebFoundUrls") {
  /** A found set in the hub's memory, for tests and hubs without a database. */
  static readonly memory = Layer.sync(WebFoundUrls, () => {
    const sets = new Map<string, Map<string, string>>();
    return WebFoundUrls.of({
      sources: (work, urls) =>
        Effect.sync(() => {
          const set = sets.get(work);
          return new Map(urls.flatMap((url) => (set?.has(url) ? [[url, set.get(url) as string] as const] : [])));
        }),
      add: (work, found) =>
        Effect.sync(() => {
          const set = sets.get(work) ?? new Map<string, string>();
          for (const one of found) if (!set.has(one.url)) set.set(one.url, one.source);
          sets.set(work, set);
        }),
    });
  });
}

/**
 * A URL as found URLs compare: parsed, so the host is lowercase and the default port dropped, and
 * without its fragment. Null for anything that is not an http or https URL.
 */
export const foundUrlKey = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

/** Closing marks a URL in prose often ends with, which belong to the sentence rather than the URL. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*", "_"]);

/** Each closing bracket and the bracket that opens it. */
const OPENS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

const BRACKETS = new Set(["(", ")", "[", "]", "{", "}"]);

/**
 * A URL cut from prose without the marks after it, keeping a closing bracket the URL itself opened.
 * It counts the brackets once and reads back from the end, so it stays linear on any text (STD-SEC-005).
 */
const trimUrl = (raw: string): string => {
  const count = new Map<string, number>();
  for (const char of raw) if (BRACKETS.has(char)) count.set(char, (count.get(char) ?? 0) + 1);
  let end = raw.length;
  while (end > 0) {
    const last = raw.charAt(end - 1);
    const open = OPENS[last];
    if (TRAILING.has(last)) end -= 1;
    else if (open !== undefined && (count.get(last) ?? 0) > (count.get(open) ?? 0)) {
      count.set(last, (count.get(last) ?? 0) - 1);
      end -= 1;
    } else break;
  }
  return raw.slice(0, end);
};

/** The http and https URLs written in `text`, each once, as `foundUrlKey` gives them. */
export const urlsIn = (text: string): ReadonlyArray<string> => [
  ...new Set(
    (text.match(/\bhttps?:\/\/[^\s<>"'`]+/gi) ?? []).flatMap((raw) => {
      const key = foundUrlKey(trimUrl(raw));
      return key === null ? [] : [key];
    }),
  ),
];

/** The longest query a search's source quotes, so a long query keeps the source short. */
const SOURCE_QUERY_CHARS = 200;

/**
 * The URLs a search the runtime reported makes found (ADR 036): only the hits of its own structured
 * result, never the model's text or the query, so a search that reported none adds nothing.
 */
export const searchFound = (searched: Pick<WebSearchedEvent, "query" | "results">): ReadonlyArray<FoundUrl> => {
  const query =
    searched.query.length > SOURCE_QUERY_CHARS ? `${searched.query.slice(0, SOURCE_QUERY_CHARS)}…` : searched.query;
  const source = `a result of the search "${query}"`;
  return (searched.results ?? []).flatMap((result) => {
    const url = foundUrlKey(result.url);
    return url === null ? [] : [{ url, source }];
  });
};

/** The session a call belongs to, as found sets are kept. */
export interface WebSession {
  readonly threadId: ThreadId | null;
  readonly taskId?: TaskId;
}

/**
 * The work a session's found set is kept under: a chat's thread, or the Task a session outside any
 * chat works on, whose every Attempt reads the set its brief passed on. Null for neither.
 */
export const webWorkOf = (session: WebSession): string | null => {
  if (session.threadId !== null) return `thread:${session.threadId}`;
  if (session.taskId !== undefined) return `task:${session.taskId}`;
  return null;
};

/**
 * The session that wrote a Task's brief: a step or a member of the Task you asked for was written in
 * your chat with its hob, and any other in the session of its parent Task. Null for the Task you
 * asked for, whose brief is your own message.
 */
export const briefWriterOf = (task: Pick<Task, "parentId" | "rootId" | "threadId">): WebSession | null => {
  if (task.parentId === null) return null;
  return task.parentId === task.rootId ? { threadId: task.threadId } : { threadId: null, taskId: task.parentId };
};

/**
 * Where URLs came from in a session (ADR 036): its found set, and in a chat the messages you wrote.
 * Text a hob wrote never makes a URL found.
 */
export const makeWebProvenance = Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WebFoundUrls);
  const repo = yield* Effect.serviceOption(HobbotsRepository);

  /** Where each of `urls` was found in the session, for those that were. */
  const sources = (session: WebSession, urls: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const found = new Map<string, string>();
      if (urls.length === 0) return found;
      const work = webWorkOf(session);
      if (work !== null && Option.isSome(store)) {
        for (const [url, source] of yield* store.value.sources(work, urls)) found.set(url, source);
      }
      const rest = urls.filter((url) => !found.has(url));
      if (rest.length > 0 && session.threadId !== null && Option.isSome(repo)) {
        const yours = new Set(
          (yield* repo.value.listMessages(session.threadId))
            .filter((message) => message.role === "user")
            .flatMap((message) => urlsIn(message.content)),
        );
        for (const url of rest) if (yours.has(url)) found.set(url, "a message of yours");
      }
      return found;
    });

  /** Adds URLs to the session's found set. */
  const add = (session: WebSession, found: ReadonlyArray<FoundUrl>) => {
    const work = webWorkOf(session);
    return work === null || found.length === 0 || Option.isNone(store) ? Effect.void : store.value.add(work, found);
  };

  /**
   * Passes on with a new Task the URLs in its brief that the session which wrote it had found, so a
   * URL a hob put into a brief is found in the child's session only when it was found already.
   */
  const passOn = (task: Pick<Task, "id" | "parentId" | "rootId" | "threadId" | "brief">) =>
    Effect.gen(function* () {
      const writer = briefWriterOf(task);
      if (writer === null) return;
      const found = yield* sources(writer, urlsIn(task.brief));
      yield* add(
        { threadId: null, taskId: task.id },
        [...found].map(([url, source]) => ({ url, source: `passed on with the Task (${source})` })),
      );
    });

  /**
   * The session's `recordSearch` (ADR 036): adds the results of each search its runtime reports to
   * its found set, with the query redacted in their source. It is the same for every runtime, which
   * only waits for it, so no adapter writes to the found set.
   */
  const searched = (session: WebSession, redactor: Redactor) => (event: WebSearchedEvent) =>
    add(session, searchFound({ results: event.results, query: redactor.text(event.query) }));

  return { sources, add, passOn, searched };
});

export type WebProvenance = Effect.Success<typeof makeWebProvenance>;

const WEB_FETCH: HubTool = {
  name: WEB_FETCH_TOOL,
  description: WEB_FETCH_DESCRIPTION,
  inputSchema: webFetchJsonSchema(),
  label: WEB_FETCH_LABEL,
};

/** The built-in request a page is decided as: Use the web for its host (ADR 014, ADR 036). */
export interface WebRequest {
  readonly _tag: "Web";
  readonly host: string;
  readonly addresses: ReadonlyArray<string>;
  readonly page: { readonly url: string; readonly found: boolean };
}

/** A verdict as `web_fetch` reads it: with the reason's code, so a private address is told from a site's Ask. */
export interface WebVerdict extends AskableVerdict {
  readonly reason: { readonly code: string; readonly message: string };
}

/** The most redirects one call follows, each decided as a new URL. */
export const WEB_REDIRECT_LIMIT = 5;

/** The most links an answer lists; every link on the page is found all the same. */
const LINKS_SHOWN = 300;

/** The page's text cut into parts of at most `WEB_PAGE_PART_CHARS`, each ending at a line where it can. */
export const pageParts = (text: string, size = WEB_PAGE_PART_CHARS): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size);
    const at = cut > size / 2 ? cut + 1 : size;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  parts.push(rest);
  return parts;
};

/** What the hob is told of a page: its part `part`, what comes next, and the links on the first. */
export const pageAnswer = (page: WebPage, part: number, hops: ReadonlyArray<string>): string => {
  const parts = pageParts(page.text);
  const host = new URL(page.url).hostname;
  const head = [
    outsideDataLine(host),
    `Title: ${page.title ?? "(none)"}`,
    `URL: ${page.url}`,
    ...(hops.length > 0 ? [`Redirected from: ${hops.join(" → ")}`] : []),
    `Fetched: ${page.fetchedAt}`,
    parts.length === 1
      ? null
      : part < parts.length
        ? `Part ${part} of ${parts.length}. Read the next with web_fetch, the same url and part ${part + 1}.`
        : `Part ${part} of ${parts.length}, the last.`,
  ].filter((line) => line !== null);
  const text = parts[part - 1] ?? "";
  if (part !== 1 || page.links.length === 0) return [...head, "", text.trim() || "(no text)"].join("\n");
  const shown = page.links.slice(0, LINKS_SHOWN);
  const more = page.links.length - shown.length;
  const links = [
    "Links:",
    ...shown.map((link, index) => `${index + 1}. ${link.text === "" ? link.url : `${link.text}: ${link.url}`}`),
    ...(more > 0 ? [`… and ${more} more on the page.`] : []),
  ];
  return [...head, "", text.trim() || "(no text)", "", ...links].join("\n");
};

/** The URL a hob asked for, or a refusal that says what to give instead. */
const pageUrl = (raw: string) =>
  Effect.gen(function* () {
    const key = foundUrlKey(raw);
    if (key === null) {
      return yield* new HubRefusal({ message: `${raw} is not an http or https URL web_fetch can read.` });
    }
    const url = new URL(key);
    if (url.username !== "" || url.password !== "") {
      return yield* new HubRefusal({
        message: "web_fetch sends no credentials, so it does not read a URL with a user name or password in it.",
      });
    }
    return url;
  });

const refused = (failed: WebFetchFailed) => new HubRefusal({ message: failed.message });

/**
 * The `web_fetch` tool set (ADR 036) on the hub action pipeline: each call is decided as Use the web
 * for the page's host, with the addresses it resolved to and whether its URL was found, recorded
 * before anything is sent, and answered redacted, opening with the outside-data line. A redirect is
 * decided as a new URL: followed when the policy allows it, handed back to the hob otherwise.
 */
export const makeWebTools = <V extends WebVerdict>(
  decide: HubActionsOptions<WebRequest, V>["decide"],
): Effect.Effect<WebTools["Service"], never, WebFetcher> =>
  Effect.gen(function* () {
    const fetcher = yield* WebFetcher;
    const provenance = yield* makeWebProvenance;
    const records = yield* Effect.serviceOption(WebRecords);
    const announce = yield* webAnnouncer;

    /** Refuses a URL on a site Settings › Web blocks (ADR 036, Blocked sites). */
    const unblocked = (url: URL, blockedSites: ReadonlyArray<string>) => {
      const site = blockedSiteFor(url.hostname, blockedSites);
      return site === null ? Effect.void : Effect.fail(new HubRefusal({ message: webLimitReason.blockedSite(site) }));
    };

    /** Records a page the turn read, with the answer's estimated tokens (ADR 036, Usage and limits). */
    const recordPage = (turn: CharmTurn, asked: URL, page: WebPage, part: number, answer: string) =>
      Option.match(records, {
        onNone: () => Effect.void,
        onSome: (store) =>
          Effect.gen(function* () {
            const messageId = turn.messageId;
            const attemptId = turn.attemptId ?? null;
            const entries = yield* store.recordFetch(
              new WebFetchRecord({
                id: WebRecordId.make(crypto.randomUUID()),
                agentId: turn.agentId,
                threadId: turn.threadId,
                messageId,
                taskId: turn.taskId ?? null,
                attemptId,
                turn: webTurnKey({ messageId, attemptId }),
                at: DateTime.formatIso(yield* DateTime.now),
                url: asked.href,
                finalUrl: page.url,
                status: page.status,
                bytes: page.bytes,
                parts: pageParts(page.text).length,
                part,
                tokens: estimatedTokens(answer.length),
              }),
            );
            yield* announce(entries);
          }),
      });

    const request = (url: URL, target: WebTarget, found: boolean): WebRequest => ({
      _tag: "Web",
      host: target.host,
      addresses: target.addresses,
      page: { url: url.href, found },
    });

    /** Decides a URL the hub reaches inside a call that was already decided: an address it resolved, or a redirect. */
    const decideAgain = (approvals: TurnApprovals | null, access: ToolAccess, url: URL, target: WebTarget) =>
      decide(approvals, access, request(url, target, true))(null);

    /** What the hob is told when the next URL waits for the user, which a new call asks about. */
    const handBack = (url: URL, why: string, hops: ReadonlyArray<string>) =>
      new HubRefusal({
        message: [
          ...(hops.length > 0 ? [`Redirected from: ${hops.join(" → ")}`] : []),
          `${url.href} waits for the user: ${why} To read it, call web_fetch with that url, which asks them.`,
        ].join("\n"),
      });

    /** Reads `url` from `target`, following the redirects the policy allows, and the page's part. */
    const read = (
      turn: CharmTurn,
      session: WebSession,
      access: ToolAccess,
      first: { readonly url: URL; readonly target: WebTarget },
      part: number,
      blockedSites: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const approvals = turn.approvals;
        let { url, target } = first;
        const hops: Array<string> = [];
        for (;;) {
          const fetched = yield* fetcher.fetch(url, target).pipe(Effect.mapError(refused));
          if (fetched._tag === "Page") {
            const { page } = fetched;
            const source = `a link on ${page.url}`;
            yield* provenance.add(session, [
              { url: page.url, source: hops.length > 0 ? `a redirect from ${hops[0]}` : source },
              ...page.links.map((link) => ({ url: link.url, source })),
            ]);
            const parts = pageParts(page.text).length;
            if (part > parts) {
              return yield* new HubRefusal({
                message: `${page.url} has ${parts === 1 ? "1 part" : `${parts} parts`}, so there is no part ${part}.`,
              });
            }
            const answer = pageAnswer(page, part, hops);
            yield* recordPage(turn, first.url, page, part, answer);
            return answer;
          }
          hops.push(url.href);
          const next = yield* pageUrl(new URL(fetched.location, url).href);
          // The site sent it, so it is found: a URL only the hob writes can carry your data.
          yield* provenance.add(session, [{ url: next.href, source: `a redirect from ${url.href}` }]);
          if (hops.length > WEB_REDIRECT_LIMIT) {
            return yield* new HubRefusal({
              message: `${hops[0]} redirects more than ${WEB_REDIRECT_LIMIT} times, so web_fetch stopped at ${next.href}.`,
            });
          }
          yield* unblocked(next, blockedSites);
          const nextTarget = yield* fetcher.resolve(next).pipe(Effect.mapError(refused));
          const verdict = yield* decideAgain(approvals, access, next, nextTarget);
          if (verdict.decision === "deny") {
            return yield* new HubRefusal({
              message: `Redirected from: ${hops.join(" → ")}\n${next.href} is refused: ${verdict.reason.message}`,
            });
          }
          if (verdict.decision === "ask") return yield* handBack(next, verdict.reason.message, hops);
          url = next;
          target = nextTarget;
        }
      });

    /**
     * A URL the hob wrote, which you approved on its own card: its host is resolved only now, so no
     * lookup of a name the hob made up went out before you said yes. What it resolved to is checked
     * as the card could not show: a blocked address is refused, and a private one is handed back to
     * ask for that host. A site's own Ask is the one you just answered.
     */
    const approvedTarget = (session: WebSession, approvals: TurnApprovals | null, access: ToolAccess, url: URL) =>
      Effect.gen(function* () {
        yield* provenance.add(session, [{ url: url.href, source: "a URL you approved" }]);
        const target = yield* fetcher.resolve(url).pipe(Effect.mapError(refused));
        const verdict = yield* decideAgain(approvals, access, url, target);
        if (verdict.decision === "deny") return yield* new HubRefusal({ message: verdict.reason.message });
        if (verdict.decision === "ask" && verdict.reason.code === "private-address") {
          return yield* handBack(url, verdict.reason.message, []);
        }
        return target;
      });

    const actionsFor = (charmTurn: CharmTurn) => {
      const approvals = charmTurn.approvals;
      // The pages this turn started reading, which its pages-per-turn limit counts.
      let pages = 0;
      return [
        hubAction({
          tool: WEB_FETCH,
          input: WebFetchInput,
          effect: "read",
          operation: "use-web",
          otherwise: "no web page can be read",
          unreadable: () => "Give the page's full URL as `url`, and a part number from 1 as `part` if you want one.",
          plan: (input, { turn, access }: HubPlanContext) =>
            Effect.gen(function* () {
              const url = yield* pageUrl(input.url);
              const { limits, blockedSites } = yield* webLimitsOf(turn.agentId);
              yield* unblocked(url, blockedSites);
              if (pages >= limits.pagesPerTurn) {
                return yield* new HubRefusal({ message: webLimitReason.pagesPerTurn(limits) });
              }
              const session: WebSession = { threadId: turn.threadId, ...(turn.taskId ? { taskId: turn.taskId } : {}) };
              const found = (yield* provenance.sources(session, [url.href])).has(url.href);
              // A URL the hob wrote is not looked up before you approve it: its name could carry your data.
              const target = found ? yield* fetcher.resolve(url).pipe(Effect.mapError(refused)) : null;
              const part = input.part ?? 1;
              return {
                request: request(url, target ?? { host: url.hostname, addresses: [] }, found),
                card: {
                  arguments: { url: url.href, ...(input.part === undefined ? {} : { part: input.part }) },
                  summary: found
                    ? `Reads the web page ${url.href}.`
                    : `Reads ${url.href}, a URL the hob wrote itself rather than copied from you, a search result or a page it read.`,
                },
                send: Effect.gen(function* () {
                  // Counted as it starts, so calls that run at once cannot pass the limit together.
                  if (pages >= limits.pagesPerTurn) {
                    return yield* new HubRefusal({ message: webLimitReason.pagesPerTurn(limits) });
                  }
                  pages += 1;
                  const pinned = target ?? (yield* approvedTarget(session, approvals, access, url));
                  return yield* read(charmTurn, session, access, { url, target: pinned }, part, blockedSites);
                }),
              };
            }),
        }),
      ];
    };

    return WebTools.of({
      forTurn: (turn: CharmTurn) =>
        offerHubActions({ owner: { _tag: "BuiltIn" }, actions: actionsFor(turn), decide })(turn),
    });
  });
