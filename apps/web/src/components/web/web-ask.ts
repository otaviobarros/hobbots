import type { ApprovalRequest } from "@hobbots/domain";
import { messages } from "./messages.ts";
import { hostOf, isWebFetchTool } from "./web-model.ts";

const copy = messages.ask;

/** Which web card an approval shows (ADR 036): a page on a new site, on your local network, or at an address the hob wrote. */
type WebAskKind = "site" | "local" | "written";

/** What an approval's card says when it asks about the web, or when it asks because its chat read the web. */
export interface WebAsk {
  /** Null for an ask that is not about a page, such as a command asked only because the chat read the web. */
  readonly kind: WebAskKind | null;
  readonly title: string | null;
  readonly why: string | null;
  /** The page's address, shown in place of the exact action. */
  readonly url: string | null;
  /** Whether it asks because the chat read the web, which the card's banner says. */
  readonly marked: boolean;
}

const KIND: Partial<Record<string, WebAskKind>> = { "private-address": "local", "written-url": "written" };

const pageKind = (approval: Pick<ApprovalRequest, "tool" | "reasonCode">): WebAskKind | null => {
  const coded = approval.reasonCode === null ? undefined : KIND[approval.reasonCode];
  if (coded !== undefined) return coded;
  return isWebFetchTool(approval.tool) ? "site" : null;
};

/**
 * The web words of an approval (ADR 036), from the code the policy asked with, or null for an ask
 * that has nothing to do with the web. Requests from before codes were recorded read as a new site
 * when they are a page, and say nothing of the mark.
 */
export const webAskOf = (
  approval: Pick<ApprovalRequest, "tool" | "reasonCode" | "arguments">,
  name: string,
): WebAsk | null => {
  const kind = pageKind(approval);
  const marked = approval.reasonCode === "read-the-web";
  if (kind === null && !marked) return null;
  const url = typeof approval.arguments.url === "string" ? approval.arguments.url : null;
  if (kind === null) return { kind, title: copy.title.readWeb({ name }), why: null, url, marked };
  const why =
    kind === "local"
      ? copy.why.local({ host: url === null ? "" : hostOf(url) })
      : kind === "written"
        ? copy.why.written({ name })
        : copy.why.siteAny;
  return { kind, title: copy.title[kind]({ name }), why, url, marked };
};
