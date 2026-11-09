import type { Agent, WebUsage } from "@hobbots/domain";
import { SheetTitle } from "@hobbots/ui/components/sheet";
import { cn } from "@hobbots/ui/lib/utils";
import { formatWhen } from "../../lib/time.ts";
import { messages } from "./messages.ts";
import { hostOf, type WebStep, wasRead } from "./web-model.ts";
import { Eyebrow, Fact, Notice } from "./web-sheets.tsx";

const copy = messages;

type SearchStep = Extract<WebStep, { readonly _tag: "Search" }>;

/** Open on a search (ADR 036): its query, who ran it and where it went, and its results with the ones read marked. */
export function SearchSheet({ step, usage, hob }: { step: SearchStep; usage: WebUsage | undefined; hob: Agent }) {
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
