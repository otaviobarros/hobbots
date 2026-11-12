import type { Agent, AskAnswer } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { formatWhen } from "../../lib/time.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { type FindRow, rowOf } from "./find-model.ts";
import { messages as copy } from "./messages.ts";

/** The arrow on a citation, pointing back at where it came from. */
const CITE_GLYPH = "↖";

/** What Ask shows: running, failed, the answer with its sources, or why there is none. */
export type AskView =
  | { readonly step: "asking" }
  | { readonly step: "failed" }
  | { readonly step: "answered"; readonly answer: AskAnswer };

/**
 * The answer card at the top of Find's results: the hob's answer from the records, and a citation
 * for each record it rests on, which opens the message it came from. With no answer it says why,
 * and the matches show below it.
 */
export function AskAnswerCard({
  hob,
  view,
  everywhere,
  onCite,
  onRetry,
}: {
  hob: Agent;
  view: AskView;
  everywhere: boolean;
  onCite: (row: FindRow) => void;
  onRetry: () => void;
}) {
  return (
    <div
      role="status"
      className="mb-1 flex flex-col gap-2 rounded-control bg-star/8 p-3 text-body leading-[22px] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-star)_30%,var(--color-line))]"
    >
      <span className="flex items-center gap-2 text-meta text-label">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-[max(0px,calc(var(--corner-tile)-3px))] bg-tile">
          <HobSprite hob={hob} size={16} />
        </span>
        {copy.answerBy({ name: hob.name })}
      </span>
      <AskBody hob={hob} view={view} everywhere={everywhere} onCite={onCite} onRetry={onRetry} />
    </div>
  );
}

function AskBody({
  hob,
  view,
  everywhere,
  onCite,
  onRetry,
}: {
  hob: Agent;
  view: AskView;
  everywhere: boolean;
  onCite: (row: FindRow) => void;
  onRetry: () => void;
}) {
  if (view.step === "asking") return <span className="text-text-secondary">{copy.asking({ name: hob.name })}</span>;
  if (view.step === "failed")
    return (
      <span className="flex flex-wrap items-center gap-2 text-text-secondary">
        {copy.askFailed}
        <Button variant="text" size="xs" onClick={onRetry}>
          {copy.tryAgain}
        </Button>
      </span>
    );
  const { answer } = view;
  if (answer._tag === "Matches")
    return <span className="text-text-secondary">{copy.without({ reason: answer.reason, name: hob.name })}</span>;
  return (
    <>
      <span className="text-text-strong">{answer.text}</span>
      <ul aria-label={copy.sources} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {answer.cites.map((cite) => {
          const row = rowOf(cite, everywhere);
          return (
            <li key={row.key}>
              <button
                type="button"
                onClick={() => onCite(row)}
                className="inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-tag border border-line-2 bg-transparent px-2.5 text-meta text-text-secondary hover:border-control hover:text-text-strong"
              >
                <span aria-hidden className="text-star">
                  {CITE_GLYPH}
                </span>
                {copy.cite({ kind: row.kind, when: formatWhen(row.at) })}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
