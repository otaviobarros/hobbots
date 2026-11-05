import type { MemoryScopeCount } from "@hobbots/api";
import { type Agent, type MemoryPageSummary, type MemoryScope, memoryKindOf } from "@hobbots/domain";
import { scopeName } from "../memory/memory-model.ts";
import { messages } from "./messages.ts";

const copy = messages.memory;

/** How many pages Learned lately lists. */
const LATELY_SHOWN = 3;

/** The pages the hob changed last, newest first, pinned or not, with each one's kind. */
export const learnedLately = (pages: ReadonlyArray<MemoryPageSummary>, shown = LATELY_SHOWN) =>
  [...pages]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, shown)
    .map((page) => ({ ...page, kind: memoryKindOf(page.path) }));

/** A scope the hob reads, as What it can read lists it. */
export interface ReadRow {
  readonly scope: MemoryScope;
  readonly title: string;
  readonly hint: string;
  readonly pages: number;
}

/** What the hob reads, in the hub's order: its own memory, About you, then each of its projects. */
export const readRows = (scopes: ReadonlyArray<MemoryScopeCount>, hob: Agent): ReadonlyArray<ReadRow> =>
  scopes.map(({ scope, pages }) => ({ scope, pages, ...wording(scope, hob.name) }));

/** A scope's title and hint, as What it can read words them for the hob `name`. */
const wording = (scope: MemoryScope, name: string): { readonly title: string; readonly hint: string } => {
  switch (scope._tag) {
    case "Hob":
      return { title: copy.own, hint: copy.ownHint({ name }) };
    case "Everyone":
      return { title: copy.about, hint: copy.aboutHint({ name }) };
    case "Project":
      return { title: copy.project({ project: scopeName(scope, new Map()) }), hint: copy.projectHint({ name }) };
  }
};

/** How many pages the hob's own memory holds, or undefined until the hub says. */
export const ownCount = (scopes: ReadonlyArray<MemoryScopeCount> | undefined): number | undefined =>
  scopes?.find((row) => row.scope._tag === "Hob")?.pages;
