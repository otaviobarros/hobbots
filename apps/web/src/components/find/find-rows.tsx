import type { Actor, SnippetPart } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { formatWhen } from "../../lib/time.ts";
import type { FindGroup, FindRow } from "./find-model.ts";
import { messages as copy } from "./messages.ts";

/** Names an author: you, the hub, or a hob by name. */
export type NameOf = (actor: Actor | null) => string;

const glyphs: Record<FindRow["glyph"], string> = {
  decision: "◆",
  code: "</>",
  file: "▭",
  chapter: "§",
  message: "“",
};

// The tile's tint follows its kind, as the design's: a star for decisions, mint for code.
const tile = {
  decision: "bg-star/15 text-star",
  code: "bg-mint/15 font-mono text-meta text-mint",
  file: "bg-text-strong/8 font-mono text-meta text-text-secondary",
  chapter: "bg-text-strong/8 text-text-secondary",
  message: "bg-text-strong/8 font-heading text-[18px] text-text-secondary",
} as const;

/** The line under a row's words: what it is, who, when, and where when Find looks everywhere. */
const metaOf = (row: FindRow, nameOf: NameOf) => {
  const who = nameOf(row.actor);
  const when = formatWhen(row.at);
  const line =
    row.artifact !== null
      ? copy.row.artifact({ ...row.artifact, who })
      : row.kind === "chapter"
        ? copy.row.chapter({ number: row.chapterNumber ?? 0, when })
        : row.kind === "decision"
          ? copy.row.decision({ who, when })
          : copy.row.message({ who, when });
  return row.where === null ? line : copy.row.in({ line, where: row.where });
};

/** Find's results, grouped by kind: each row opens where it came from. */
export function FindGroups({
  groups,
  nameOf,
  onPick,
}: {
  groups: ReadonlyArray<FindGroup>;
  nameOf: NameOf;
  onPick: (row: FindRow) => void;
}) {
  return groups.map((group) => (
    <section key={group.kind} aria-label={copy.group({ kind: group.kind, count: group.rows.length })}>
      <h3 className="m-0 px-2 pt-2 pb-0.5 text-meta font-bold tracking-[.05em] text-label uppercase">
        {copy.group({ kind: group.kind, count: group.rows.length })}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {group.rows.map((row) => (
          <li key={row.key}>
            <FindRowButton row={row} nameOf={nameOf} onPick={onPick} />
          </li>
        ))}
      </ul>
    </section>
  ));
}

/** One row: its tile, its words, crossed out when the decision no longer holds, and who and when. */
function FindRowButton({ row, nameOf, onPick }: { row: FindRow; nameOf: NameOf; onPick: (row: FindRow) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(row)}
      className="grid w-full cursor-pointer grid-cols-[30px_minmax(0,1fr)] items-center gap-2.5 rounded-control border-0 bg-transparent px-2 py-1.5 text-start text-text-strong hover:bg-hover focus-visible:bg-hover"
    >
      <span
        aria-hidden
        className={cn(
          "inline-flex size-[30px] items-center justify-center rounded-tile text-ui font-bold",
          tile[row.glyph],
        )}
      >
        {glyphs[row.glyph]}
      </span>
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            "text-ui leading-[19px] font-semibold",
            row.crossedOut && "font-normal text-text-secondary line-through",
          )}
        >
          {row.crossedOut && <span className="sr-only">{`${copy.crossedOut}: `}</span>}
          <Marked parts={row.title} />
        </span>
        <span className="text-meta text-label">{metaOf(row, nameOf)}</span>
      </span>
    </button>
  );
}

/** Words with the ones that matched marked in lantern. */
function Marked({ parts }: { parts: ReadonlyArray<SnippetPart> }) {
  return parts.map((part, index) =>
    part.match ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder
      <mark key={index} className="rounded-[3px] bg-lantern/35 px-0.5 text-inherit">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}
