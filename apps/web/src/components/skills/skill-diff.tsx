import { cn } from "@hobbots/ui/lib/utils";
import { diffLines } from "diff";
import { messages } from "./messages.ts";

const copy = messages.history;

/** The lines of two SKILL.md texts, each marked as added, removed or the same. */
const linesOf = (before: string, after: string) =>
  diffLines(before, after).flatMap((part) =>
    part.value
      .replace(/\n$/, "")
      .split("\n")
      .map((text) => ({ op: part.added ? "add" : part.removed ? "remove" : "same", text }) as const),
  );

/** Two texts line by line: added lines marked +, removed ones − and struck through. */
export function DiffLines({ before, after }: { before: string; after: string }) {
  return (
    <ul className="m-0 list-none p-0 py-1">
      {linesOf(before, after).map((line, at) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines have no identity but their place (STD-REACT-020).
          key={at}
          className={cn(
            // Only the lines near the viewport are laid out, however long the diff (STD-REACT-024).
            "flex gap-2.5 px-3 py-1 font-mono text-detail [contain-intrinsic-size:auto_26px] [content-visibility:auto]",
            line.op === "add" && "bg-[color-mix(in_srgb,var(--color-mint)_12%,transparent)] text-text-strong",
            line.op === "remove" &&
              "bg-[color-mix(in_srgb,var(--color-rose)_10%,transparent)] text-text-secondary line-through",
            line.op === "same" && "text-text-secondary",
          )}
        >
          <span aria-hidden className={cn("w-2.5 flex-none", line.op === "add" ? "text-mint" : "text-rose")}>
            {line.op === "add" ? "+" : line.op === "remove" ? "−" : " "}
          </span>
          <span className="sr-only">
            {line.op === "add" ? `${copy.added}: ` : line.op === "remove" ? `${copy.removed}: ` : ""}
          </span>
          <span className="min-w-0 break-words whitespace-pre-wrap">{line.text}</span>
        </li>
      ))}
    </ul>
  );
}
