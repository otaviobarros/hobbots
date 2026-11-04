import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { type CodeDiff, codeDiff, type DiffLine } from "./changes-model.ts";
import { messages } from "./messages.ts";

const rowTone: Record<DiffLine["kind"], string> = {
  added: "bg-mint/15 text-text",
  removed: "bg-rose/15 text-text",
  same: "text-text-secondary",
};

const signTone: Record<DiffLine["kind"], string> = { added: "text-mint", removed: "text-rose", same: "text-label" };

const sign: Record<DiffLine["kind"], string> = { added: "+", removed: "−", same: " " };

/**
 * A text file's change as a line diff: each added and removed line marked, with its numbers before
 * and after. Long unchanged runs fold to "Show N unchanged lines", each opening on its own, and
 * "Show the whole file" opens them all. With one side only, as when the earlier version was not
 * kept, it shows that side whole and unmarked.
 */
export function CodeDiffView({
  path,
  before,
  after,
  onlyOneSide,
}: {
  path: string;
  before: string | null;
  after: string | null;
  /** Only one version could be read, so the other is not compared against. */
  onlyOneSide: boolean;
}) {
  // The folds opened, by their place among the diff's rows.
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const text = after ?? before ?? "";
  const diff: CodeDiff = onlyOneSide ? codeDiff(text, text, Number.POSITIVE_INFINITY) : codeDiff(before, after, 3);
  const folds = diff.rows.flatMap((row, index) => (row.kind === "folded" ? [index] : []));
  const allOpen = folds.length > 0 && folds.every((index) => opened.has(index));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {!onlyOneSide && (
        <div className="flex flex-wrap items-center gap-2 text-detail text-label">
          <span>{messages.lines({ added: diff.added, removed: diff.removed })}</span>
          {folds.length > 0 && (
            <>
              <span aria-hidden>·</span>
              <Button variant="text" size="xs" onClick={() => setOpened(new Set(allOpen ? [] : folds))}>
                {allOpen ? messages.fold : messages.whole}
              </Button>
            </>
          )}
        </div>
      )}
      {diff.rows.length === 0 ? (
        <p className="m-0 text-detail text-label">{messages.noLines}</p>
      ) : (
        <section
          aria-label={messages.diff({ path })}
          className="min-w-0 overflow-x-auto rounded-card border border-line bg-panel py-1.5 font-mono text-[12.5px] leading-5"
        >
          <table className="w-full border-collapse">
            <tbody>
              {diff.rows.map((row, index) =>
                row.kind === "folded" ? (
                  opened.has(index) ? (
                    row.hidden.map((line) => <Row key={key(line)} row={line} />)
                  ) : (
                    // A fold is named by the first line it hides.
                    <Fold
                      key={`folded-${key(row.hidden[0])}`}
                      lines={row.lines}
                      onOpen={() => setOpened(new Set([...opened, index]))}
                    />
                  )
                ) : (
                  <Row key={key(row)} row={row} />
                ),
              )}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const key = (row: DiffLine | undefined) => (row === undefined ? "" : `${row.before}:${row.after}`);

function Fold({ lines, onOpen }: { lines: number; onOpen: () => void }) {
  return (
    <tr>
      <td colSpan={4} className="py-0.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full cursor-pointer items-center gap-2.5 border-0 bg-[color-mix(in_srgb,var(--color-star)_9%,transparent)] py-0.5 ps-[60px] text-start font-sans text-label hover:bg-hover hover:text-text-strong"
        >
          <span aria-hidden>⋯</span>
          {messages.folded(lines)}
        </button>
      </td>
    </tr>
  );
}

function Row({ row }: { row: DiffLine }) {
  return (
    <tr className={rowTone[row.kind]}>
      <td className="w-[38px] pe-2 text-end align-top text-label select-none">{row.before ?? ""}</td>
      <td className="w-[38px] pe-2 text-end align-top text-label select-none">{row.after ?? ""}</td>
      <td className={cn("w-[18px] text-center align-top select-none", signTone[row.kind])}>
        <span aria-hidden="true">{sign[row.kind]}</span>
        {row.kind !== "same" && (
          <span className="sr-only">{row.kind === "added" ? messages.added : messages.removed}</span>
        )}
      </td>
      <td className="pe-4 align-top whitespace-pre-wrap break-all">{row.text}</td>
    </tr>
  );
}
