import type { Agent, Message, WebUsage } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@hobbots/ui/components/sheet";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { toolLogUrl } from "../../api/client.ts";
import { formatWhen } from "../../lib/time.ts";
import { useCopy } from "../../lib/use-copy.ts";
import { ReplyMarkdown } from "../markdown/reply-markdown.tsx";
import { messages } from "./messages.ts";
import {
  foundBy,
  fromCache,
  hostOf,
  type PageAnswer,
  parsePageAnswer,
  type ReplyWeb,
  type WebStep,
  wasRead,
} from "./web-model.ts";

const copy = messages;

type PageStep = Extract<WebStep, { readonly _tag: "Page" }>;
type SearchStep = Extract<WebStep, { readonly _tag: "Search" }>;

/** The line icons a step line and a sheet's eyebrow show, drawn on a 16×16 grid. */
export const WebIcon = ({ kind, size = 14 }: { kind: "search" | "page" | "globe"; size?: number }) => (
  <svg
    aria-hidden
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="flex-none"
  >
    {kind === "search" ? (
      <>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" />
      </>
    ) : kind === "page" ? (
      <>
        <path d="M4 1.5h5.5L12.5 4.5v10h-8.5z" />
        <path d="M9.5 1.5v3h3M6 8h4.5M6 10.5h4.5" />
      </>
    ) : (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6s-.8 4.3-2.6 6c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2z" />
      </>
    )}
  </svg>
);

/** A pill around a step line, as the reply's quiet steps are drawn. */
const pill =
  "flex max-w-full min-w-0 items-center gap-2 self-start rounded-dot border-(length:--edge) border-line px-3 py-1 text-detail text-text-secondary";

/**
 * A reply's searches and pages (ADR 036): quiet step lines under the hob's name, its sources under
 * its text, and the sheet Open shows beside the chat. `lines` and `sources` go where the reply puts
 * them; `sheet` once anywhere in it.
 */
export function useReplyWeb({
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
function Eyebrow({ kind, children }: { kind: "search" | "page"; children: ReactNode }) {
  return (
    <SheetHeader>
      <span className="flex items-center gap-1.5 text-meta font-semibold text-star">
        <WebIcon kind={kind} size={13} />
        {children}
      </span>
      <SheetCloseButton label={copy.sheet.close} />
    </SheetHeader>
  );
}

/** A label and its value, as the sheets list what they know. */
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-label">{label}</dt>
    <dd className="m-0 text-text">{children}</dd>
  </>
);

/** The line that says the text is other people's, or where a search went. */
const Notice = ({ children }: { children: ReactNode }) => (
  <p className="m-0 flex gap-2 rounded-control bg-card px-3 py-2.5 text-detail text-text-secondary">
    <span className="mt-0.5 text-star">
      <WebIcon kind="globe" />
    </span>
    <span>{children}</span>
  </p>
);

/** What `web_fetch` answered for a page: its step's whole log when the hub kept one, else what the step shows. */
const usePageAnswer = (message: Message, step: PageStep) => {
  const reply = message.steps.find((each) => each.id === step.stepId);
  const output = reply?.output;
  return useQuery({
    queryKey: ["web", "page-answer", message.id, step.stepId],
    enabled: output !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }): Promise<PageAnswer> => {
      if (output === undefined || step.stepId === null) throw new Error("No answer");
      if (output.omittedBytes === 0) return parsePageAnswer(output.head);
      const response = await fetch(toolLogUrl(message.threadId, message.id, step.stepId), {
        signal,
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Log ${response.status}`);
      return parsePageAnswer(await response.text());
    },
  });
};

function PageSheet({
  step,
  usage,
  message,
  hob,
}: {
  step: PageStep;
  usage: WebUsage | undefined;
  message: Message;
  hob: Agent;
}) {
  const { page } = step;
  const answer = usePageAnswer(message, step);
  const [copied, copyLink] = useCopy();
  const got = answer.data;
  const cached = got === undefined ? null : fromCache(got, page.at);
  const search = foundBy(page.url, usage?.searches ?? []);
  const when = formatWhen(page.at);
  const redirected = got?.redirectedFrom ?? (page.url === page.finalUrl ? [] : [page.url]);
  return (
    <>
      <Eyebrow kind="page">{copy.sheet.page.eyebrow({ name: hob.name })}</Eyebrow>
      <div className="flex flex-col gap-1.5">
        <SheetTitle>{got?.title ?? step.title ?? hostOf(page.finalUrl)}</SheetTitle>
        <SheetDescription className="font-mono text-meta break-all">{page.finalUrl}</SheetDescription>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-detail">
        <Fact label={copy.sheet.page.read}>
          {cached === true && got?.fetchedAt
            ? copy.sheet.page.readCached({ when, cached: formatWhen(got.fetchedAt) })
            : cached === false
              ? copy.sheet.page.readAt({ when })
              : copy.sheet.page.readWhen({ when })}
        </Fact>
        {search !== null && (
          <Fact label={copy.sheet.page.foundIn}>{copy.sheet.page.foundBy({ query: search.query })}</Fact>
        )}
        {redirected.length > 0 && (
          <Fact label={copy.sheet.page.redirected}>
            <span className="break-all">{redirected.join(" → ")}</span>
          </Fact>
        )}
        <Fact label={copy.sheet.page.got}>
          {got === undefined
            ? copy.sheet.page.gotBytes({ part: page.part, parts: page.parts, bytes: page.bytes })
            : copy.sheet.page.gotText({
                characters: got.text.length,
                part: page.part,
                parts: page.parts,
                bytes: page.bytes,
              })}
        </Fact>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" asChild>
          <a href={page.finalUrl} target="_blank" rel="noreferrer noopener">
            {copy.sheet.page.openInBrowser}
          </a>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => copyLink(page.finalUrl)}>
          {copied === "copied" ? copy.sheet.page.copied : copy.sheet.page.copyLink}
        </Button>
      </div>
      <Notice>{copy.sheet.page.others({ name: hob.name })}</Notice>
      <section aria-label={copy.sheet.page.textLabel({ name: hob.name })} className="flex flex-col gap-2">
        <span className="flex items-center justify-between gap-2 text-meta text-label">
          <span className="lbl">{copy.sheet.page.textLabel({ name: hob.name })}</span>
          <span>{copy.sheet.page.part({ part: page.part, parts: page.parts })}</span>
        </span>
        <div className="cut flex flex-col gap-2 bg-card px-4 py-3">
          {answer.isPending && step.stepId !== null ? (
            <span role="status" className="text-detail text-text-secondary">
              {copy.sheet.page.reading}
            </span>
          ) : got === undefined ? (
            <p className="m-0 text-detail text-text-secondary">{copy.sheet.page.unkept({ name: hob.name })}</p>
          ) : got.text === "" ? (
            <p className="m-0 text-detail text-text-secondary">{copy.sheet.page.noText}</p>
          ) : (
            <ReplyMarkdown content={got.text} streaming={false} caret={false} />
          )}
        </div>
      </section>
      {got !== undefined && got.links.length > 0 && (
        <section aria-label={copy.sheet.page.links} className="flex flex-col gap-1.5">
          <span className="lbl text-meta text-label">{copy.sheet.page.links}</span>
          <ol className="m-0 flex flex-col gap-1 ps-5 text-detail marker:text-label">
            {got.links.map((link) => (
              <li key={link.url} className="break-all">
                {link.text === "" ? null : <span className="text-text">{link.text} </span>}
                <span className="font-mono text-meta text-text-secondary">{link.url}</span>
              </li>
            ))}
          </ol>
          {got.moreLinks > 0 && (
            <span className="text-meta text-label">{copy.sheet.page.moreLinks({ count: got.moreLinks })}</span>
          )}
        </section>
      )}
    </>
  );
}

function SearchSheet({ step, usage, hob }: { step: SearchStep; usage: WebUsage | undefined; hob: Agent }) {
  const { search } = step;
  const results = search.results ?? [];
  return (
    <>
      <Eyebrow kind="search">{copy.sheet.search.eyebrow({ name: hob.name })}</Eyebrow>
      <SheetTitle>{search.query}</SheetTitle>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-detail">
        <Fact label={copy.sheet.search.searched}>{formatWhen(search.at)}</Fact>
        <Fact label={copy.sheet.search.through}>{copy.sheet.search.through_[search.runtime]}</Fact>
        <Fact label={copy.sheet.search.results}>
          {search.resultCount === null
            ? copy.sheet.search.noResults
            : copy.sheet.search.resultCount({ count: search.resultCount })}
        </Fact>
      </dl>
      <Notice>{copy.sheet.search.went[search.runtime]}</Notice>
      <section aria-label={copy.sheet.search.list} className="flex flex-col gap-2">
        <span className="flex items-center justify-between text-meta text-label">
          <span className="lbl">{copy.sheet.search.list}</span>
          <span className="rounded-tag bg-line px-1.5">{results.length}</span>
        </span>
        {results.length === 0 ? (
          <p className="m-0 text-detail text-text-secondary">{copy.sheet.search.none}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {results.map((result) => {
              const read = wasRead(result.url, usage?.pages ?? []);
              return (
                <li key={result.url} className="cut flex flex-col bg-card px-3 py-2">
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-detail font-semibold text-text-strong no-underline hover:underline"
                  >
                    {result.title}
                  </a>
                  <span className="text-meta text-label">
                    {hostOf(result.url)}
                    {read && <span className={cn("ms-1 text-mint")}>{copy.sheet.search.readMark}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
