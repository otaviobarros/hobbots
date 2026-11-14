import type { PackPart, PackPartName, PackReport } from "@hobbots/domain";

// The Focus chip's rows (ADR 037, #1382): the parts of the turn's `PackReport`, grouped as the
// design names them. Sizes are the report's, as the hub measured them; nothing here recounts them.

/**
 * A row of the Focus chip. `always`: what every turn of the hob reads, its memory brief. `here`:
 * what this chat or camp holds. `carried`: what came along from elsewhere. `archived`: an earlier
 * chat this one was started fresh from, which nothing reads.
 */
export type FocusGroup = "always" | "here" | "carried" | "archived";

const GROUP_OF: Readonly<Record<PackPartName, FocusGroup>> = {
  "memory-brief": "always",
  members: "here",
  "camp-brief": "here",
  decisions: "here",
  "open-work": "here",
  carried: "carried",
  artifacts: "here",
  chapters: "here",
  "live-chapter": "here",
};

const ORDER: ReadonlyArray<FocusGroup> = ["always", "here", "carried", "archived"];

export interface FocusRow {
  readonly group: FocusGroup;
  /** The report's parts in this row, in the report's order. */
  readonly parts: ReadonlyArray<PackPart>;
  /** The row's size in tokens: its parts' sizes added up. */
  readonly tokens: number;
}

/**
 * The report's parts as the chip's rows, in order, each row with its parts and size. `archived`
 * adds the Archived row, which reads nothing, for a chat started fresh from an earlier one.
 */
export const focusRows = (report: PackReport, archived: boolean): ReadonlyArray<FocusRow> =>
  ORDER.flatMap((group): ReadonlyArray<FocusRow> => {
    const parts = report.parts.filter((part) => GROUP_OF[part.part] === group);
    if (group === "archived") return archived ? [{ group, parts, tokens: 0 }] : [];
    if (parts.length === 0) return [];
    return [
      {
        group,
        parts,
        tokens: parts.reduce((sum, part) => sum + part.tokens, 0),
      },
    ];
  });

/**
 * What a trimmed part says it left out: how many of its items it kept, by title or not at all,
 * when it left any out, and how many characters it cut from a long message. Nothing for a part
 * that was not trimmed.
 */
export const trimNotes = (
  trim: PackPart["trimmed"],
): {
  readonly kept: { readonly full: number; readonly titlesOnly: number; readonly leftOut: number } | null;
  readonly cut: number;
} => {
  if (trim === null) return { kept: null, cut: 0 };
  const { full, titlesOnly, leftOut, cutCharacters } = trim;
  return { kept: titlesOnly > 0 || leftOut > 0 ? { full, titlesOnly, leftOut } : null, cut: cutCharacters };
};
