import { Button } from "@hobbots/ui/components/button";
import { useState } from "react";
import { type CodeDiff, codeDiff, type DiffRow } from "./changes-model.ts";
import { messages } from "./messages.ts";

const rowTone: Record<Exclude<DiffRow["kind"], "folded">, string> = {
  added: "bg-mint/12 text-text-strong",
  removed: "bg-rose/14 text-text-strong",
  same: "text-text-secondary",
};

const sign: Record<Exclude<DiffRow["kind"], "folded">, string> = { added: "+", removed: "−", same: " " };

/**
 * A text file's change as a line diff: each added and removed line marked, with its numbers before
 * and after, and long unchanged runs folded until the whole file is asked for. With one side only,
 * as when the earlier version was not kept, it shows that side whole and unmarked.
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
  const [whole, setWhole] = useState(false);
  const text = after ?? before ?? "";
  const diff: CodeDiff = onlyOneSide
    ? codeDiff(text, text, Number.POSITIVE_INFINITY)
    : codeDiff(before, after, whole ? Number.POSITIVE_INFINITY : 3);
  const folded = diff.rows.some((row) => row.kind === "folded");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {!onlyOneSide && (
        <div className="flex flex-wrap items-center gap-3 text-detail text-label">
          <span>{messages.lines({ added: diff.added, removed: diff.removed })}</span>
          {folded && (
            <Button variant="link" size="xs" onClick={() => setWhole(true)}>
              {messages.whole}
            </Button>
          )}
        </div>
      )}
      {diff.rows.length === 0 ? (
        <p className="m-0 text-detail text-label">{messages.noLines}</p>
      ) : (
        <section
          aria-label={messages.diff({ path })}
          className="cut min-w-0 overflow-x-auto border-2 border-line bg-deep py-2 font-mono text-detail leading-relaxed"
        >
          <table className="w-full border-collapse">
            <tbody>
              {diff.rows.map((row, index) => (
                // A folded run has no line numbers of its own, so its place in the diff names it.
                <Row key={row.kind === "folded" ? `folded-${index}` : `${row.before}:${row.after}`} row={row} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Row({ row }: { row: DiffRow }) {
  if (row.kind === "folded") {
    return (
      <tr className="bg-card text-label">
        <td colSpan={4} className="px-3 py-0.5 font-sans">
          {messages.folded(row.lines)}
        </td>
      </tr>
    );
  }
  return (
    <tr className={rowTone[row.kind]}>
      <td className="w-10 pe-2 text-end align-top text-label select-none">{row.before ?? ""}</td>
      <td className="w-10 pe-2 text-end align-top text-label select-none">{row.after ?? ""}</td>
      <td className="w-4 align-top select-none">
        <span aria-hidden="true">{sign[row.kind]}</span>
        {row.kind !== "same" && (
          <span className="sr-only">{row.kind === "added" ? messages.added : messages.removed}</span>
        )}
      </td>
      <td className="pe-3 align-top whitespace-pre-wrap break-all">{row.text}</td>
    </tr>
  );
}
