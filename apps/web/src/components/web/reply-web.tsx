import type { Agent, Message, WebUsage } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Sheet, SheetContent } from "@hobbots/ui/components/sheet";
import { type ReactNode, useState } from "react";
import { messages } from "./messages.ts";
import { WebIcon } from "./web-icon.tsx";
import { hostOf, type ReplyWeb, shownAsWebLine, type WebStep } from "./web-model.ts";
import { PageSheet, SearchSheet } from "./web-sheets.tsx";

const copy = messages;

type PageStep = Extract<WebStep, { readonly _tag: "Page" }>;
type SearchStep = Extract<WebStep, { readonly _tag: "Search" }>;

/** A pill around a step line, as the reply's quiet steps are drawn. */
const pill =
  "flex max-w-full min-w-0 items-center gap-2 self-start rounded-dot border-(length:--edge) border-line px-3 py-1 text-detail text-text-secondary";

/**
 * A reply's searches and pages (ADR 036): quiet step lines under the hob's name, its sources under
 * its text, and the sheet Open shows beside the chat. `lines` and `sources` go where the reply puts
 * them; `sheet` once anywhere in it.
 */
function useReplyWeb({
  web,
  usage,
  message,
  hob,
}: {
  web: ReplyWeb;
  usage: WebUsage | undefined;
  message: Message;
  hob: Agent;
}): { readonly lines: ReactNode; readonly sources: ReactNode; readonly sheet: ReactNode } {
  const [open, setOpen] = useState<WebStep | null>(null);
  if (web.steps.length === 0) return { lines: null, sources: null, sheet: null };
  const lines = (
    <ul aria-label={copy.lines.list({ name: hob.name })} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {web.steps.map((step) => (
        <li key={step._tag === "Search" ? step.search.id : step.page.id} className={pill}>
          {step._tag === "Search" ? <SearchLine step={step} /> : <PageLine step={step} />}
          <Button
            variant="ghost"
            size="xs"
            className="ms-1 shrink-0"
            aria-label={
              step._tag === "Search"
                ? copy.lines.openSearch({ query: step.search.query })
                : copy.lines.openPage({ site: hostOf(step.page.finalUrl) })
            }
            onClick={() => setOpen(step)}
          >
            {copy.lines.open}
          </Button>
        </li>
      ))}
    </ul>
  );
  const sources =
    web.sources.length === 0 ? null : (
      <section aria-label={copy.sources.label} className="flex flex-col gap-1.5 pt-1">
        <span className="lbl text-meta text-label">{copy.sources.label}</span>
        <ol className="m-0 flex list-none flex-wrap gap-2 p-0">
          {web.sources.map((source, index) => {
            const title = source.title ?? hostOf(source.page.finalUrl);
            return (
              <li key={source.page.id}>
                <button
                  type="button"
                  onClick={() => setOpen(source)}
                  className="flex max-w-72 cursor-pointer items-center gap-2 rounded-control border-(length:--edge) border-line bg-transparent px-2 py-1.5 text-start hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus-ring"
                >
                  <span aria-hidden className="rounded-tag bg-line px-1.5 text-meta text-text-secondary">
                    {index + 1}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <b className="truncate text-detail text-text-strong">{title}</b>
                    <span className="truncate text-meta text-label">{hostOf(source.page.finalUrl)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
    );
  const sheet = (
    <Sheet open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
      {open !== null && (
        <SheetContent aria-describedby={undefined}>
          {open._tag === "Page" ? (
            <PageSheet step={open} usage={usage} message={message} hob={hob} />
          ) : (
            <SearchSheet step={open} usage={usage} hob={hob} />
          )}
        </SheetContent>
      )}
    </Sheet>
  );
  return { lines, sources, sheet };
}

function SearchLine({ step }: { step: SearchStep }) {
  const { query, resultCount } = step.search;
  return (
    <>
      <WebIcon kind="search" />
      <span className="truncate">
        {copy.lines.searched} <span className="text-text-strong">{query}</span>{" "}
        <span className="text-meta text-label">
          {resultCount === null ? copy.lines.noResults : copy.lines.results({ count: resultCount })}
        </span>
      </span>
    </>
  );
}

function PageLine({ step }: { step: PageStep }) {
  const host = hostOf(step.page.finalUrl);
  return (
    <>
      <WebIcon kind="page" />
      <span className="truncate">
        {copy.lines.read} <b className="text-text-strong">{host}</b>
        {step.title !== null && <> · {step.title}</>}
      </span>
    </>
  );
}

/** The sheet's top row: what it shows, as an eyebrow, and its close button. */

/** What a reply searched and read, and every record of its chat, which its sheets read (ADR 036). */
export interface ReplyWebParts {
  readonly reply: ReplyWeb;
  readonly usage: WebUsage | undefined;
}

const NO_REPLY_WEB: ReplyWeb = { steps: [], sources: [] };

/**
 * A reply row's web parts, with the steps it still lists: a search or a page that went through
 * shows as its step line instead.
 */
export const useReplyRowWeb = (web: ReplyWebParts | undefined, message: Message, hob: Agent) => {
  const searched = useReplyWeb({ web: web?.reply ?? NO_REPLY_WEB, usage: web?.usage, message, hob });
  const steps = searched.lines === null ? message.steps : message.steps.filter((step) => !shownAsWebLine(step));
  return { ...searched, steps };
};
