import robotsParser from "robots-parser";

/**
 * robots.txt as `web_fetch` reads it (ADR 036): a fetch is one page a person's hob asked for, not
 * crawling, so it skips the generic rules (`User-agent: *`) and honors the rules that name Hobbots,
 * as OpenAI's and Perplexity's user-initiated fetchers do. The generic group is renamed before
 * robots-parser reads the file, so its own fallback to `*` finds nothing to fall back to.
 */
const GENERIC = /^(\s*user-agent\s*:\s*)\*(\s*(#.*)?)$/gim;

/** Whether the rules that name Hobbots in `robots` let it read `url`; no rules, or none for it, allow it. */
export const robotsAllow = (robots: string, url: URL, userAgent: string): boolean => {
  if (robots.trim() === "") return true;
  const rules = robotsParser(
    new URL("/robots.txt", url).href,
    robots.replace(GENERIC, "$1hobbots-skips-generic-rules$2"),
  );
  return rules.isAllowed(url.href, userAgent) !== false;
};
