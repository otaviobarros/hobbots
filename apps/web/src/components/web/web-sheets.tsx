import type { Agent, Message, WebSearchRecord, WebUsage } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { SheetCloseButton, SheetHeader, SheetTitle } from "@hobbots/ui/components/sheet";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toolLogUrl } from "../../api/client.ts";
import { formatWhen } from "../../lib/time.ts";
import { useCopy } from "../../lib/use-copy.ts";
import { ReplyMarkdown } from "../markdown/reply-markdown.tsx";
import { messages } from "./messages.ts";
import { WebIcon } from "./web-icon.tsx";
import { foundBy, fromCache, hostOf, type PageAnswer, parsePageAnswer, type WebStep } from "./web-model.ts";

/** The sheets Open shows beside the chat for a reply's page or search (ADR 036). */

const copy = messages;

type PageStep = Extract<WebStep, { readonly _tag: "Page" }>;
type SearchStep = Extract<WebStep, { readonly _tag: "Search" }>;

export function Eyebrow({ kind, children }: { kind: "search" | "page"; children: ReactNode }) {
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
export const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-label">{label}</dt>
    <dd className="m-0 text-text">{children}</dd>
  </>
);

/** The line that says the text is other people's, or where a search went. */
export const Notice = ({ children }: { children: ReactNode }) => (
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

export function PageSheet({
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
  const search = foundBy(page.url, usage?.searches ?? []);
  return (
    <>
      <Eyebrow kind="page">{copy.sheet.page.eyebrow({ name: hob.name })}</Eyebrow>
      <div className="flex flex-col gap-1.5">
        <SheetTitle>{got?.title ?? step.title ?? hostOf(page.finalUrl)}</SheetTitle>
        <p className="m-0 font-mono text-meta break-all text-text-secondary">{page.finalUrl}</p>
      </div>
      <PageFacts page={page} got={got} search={search} />
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
      <PageText step={step} got={got} pending={answer.isPending} name={hob.name} />
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

/** What the sheet knows of a page: when it was read and from where, where its link came from, and how much came back. */
function PageFacts({
  page,
  got,
  search,
}: {
  page: PageStep["page"];
  got: PageAnswer | undefined;
  search: WebSearchRecord | null;
}) {
  const cached = got === undefined ? null : fromCache(got, page.at);
  const when = formatWhen(page.at);
  const redirected = got?.redirectedFrom ?? (page.url === page.finalUrl ? [] : [page.url]);
  return (
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
  );
}

/** The text the hob got, as it reads, or why it is not shown. */
function PageText({
  step,
  got,
  pending,
  name,
}: {
  step: PageStep;
  got: PageAnswer | undefined;
  pending: boolean;
  name: string;
}) {
  const { page } = step;
  return (
    <section aria-label={copy.sheet.page.textLabel({ name: name })} className="flex flex-col gap-2">
      <span className="flex items-center justify-between gap-2 text-meta text-label">
        <span className="lbl">{copy.sheet.page.textLabel({ name: name })}</span>
        <span>{copy.sheet.page.part({ part: page.part, parts: page.parts })}</span>
      </span>
      <div className="cut flex flex-col gap-2 bg-card px-4 py-3">
        {pending && step.stepId !== null ? (
          <span role="status" className="text-detail text-text-secondary">
            {copy.sheet.page.reading}
          </span>
        ) : got === undefined ? (
          <p className="m-0 text-detail text-text-secondary">{copy.sheet.page.unkept({ name: name })}</p>
        ) : got.text === "" ? (
          <p className="m-0 text-detail text-text-secondary">{copy.sheet.page.noText}</p>
        ) : (
          <ReplyMarkdown content={got.text} streaming={false} caret={false} />
        )}
      </div>
    </section>
  );
}
