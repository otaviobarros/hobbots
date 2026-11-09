import { MEMORY_PAGE_MAX, type MemoryPageSave } from "@hobbots/api";
import {
  MemoryForgetDay,
  type MemoryKind,
  type MemoryPage,
  type MemoryPath,
  type MemoryScope,
  type MemoryVersion,
  memoryPathFor,
  memoryScopeKey,
} from "@hobbots/domain";
import { Schema } from "effect";
import { formatDay } from "../../lib/format.ts";
import { type HobDirectory, pageBody, scopeName } from "./memory-model.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * What the Memory page's editor and actions write (#959): every change is the whole page, saved as a
 * new version by you over the version you read, so a hob's save made meanwhile is never overwritten
 * unseen.
 */

/** The kinds a page you write can be: a chat note is only ever memory's own summary. */
export const WRITABLE_KINDS: ReadonlyArray<Exclude<MemoryKind, "chat" | "note">> = [
  "rule",
  "howto",
  "gotcha",
  "decision",
  "fact",
];

/** The editor's fields. */
export interface EditorDraft {
  readonly title: string;
  readonly body: string;
  readonly kind: MemoryKind;
  readonly pinned: boolean;
  /** `YYYY-MM-DD`, or empty to keep the page. */
  readonly forgetOn: string;
}

/** The editor's fields for `page`, as it is now. */
export const draftOf = (page: MemoryPage, kind: MemoryKind): EditorDraft => ({
  title: page.title,
  body: pageBody(page.markdown),
  kind,
  pinned: page.pinned,
  forgetOn: page.forgetOn ?? "",
});

/** An empty page of `kind`. */
export const newDraft = (kind: MemoryKind): EditorDraft => ({ title: "", body: "", kind, pinned: false, forgetOn: "" });

/** A page's markdown from its title and body: the title as its `# ` heading. */
export const markdownOf = (draft: Pick<EditorDraft, "title" | "body">): string => {
  const body = draft.body.trim();
  return `# ${draft.title.trim().replace(/\s+/g, " ")}\n${body === "" ? "" : `\n${body}\n`}`;
};

/** Today in the reader's own calendar, `YYYY-MM-DD`, as a date field holds it. */
export const localDay = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** The day a date field suggests for Forget on a date: 30 days on. */
export const suggestedForgetDay = (now: Date): string =>
  localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30));

/** A forget day as the page says it, "Dec 5, 2026", read at noon so no time zone moves it a day. */
export const forgetDayLabel = (day: MemoryForgetDay): string => formatDay(`${day}T12:00:00`);

/** What is wrong with the editor's fields, by field: a title, a page that fits, and a day still to come. */
export interface EditorErrors {
  readonly title?: string;
  readonly body?: string;
  readonly forgetOn?: string;
}

const ForgetField = Schema.Union([Schema.Literal(""), MemoryForgetDay]);

/** The editor's rules (STD-REACT-017): what each field must hold before the page is saved. */
export const editorErrors = (draft: EditorDraft, now: Date): EditorErrors => {
  const errors: { title?: string; body?: string; forgetOn?: string } = {};
  if (draft.title.trim() === "") errors.title = copy.editor.titleMissing;
  if (markdownOf(draft).length > MEMORY_PAGE_MAX) errors.body = copy.editor.tooLong;
  const day = Schema.decodeUnknownOption(ForgetField)(draft.forgetOn);
  if (day._tag === "None" || (day.value !== "" && day.value <= localDay(now))) errors.forgetOn = copy.editor.dayPast;
  return errors;
};

/** Whether the fields can be saved as they are. */
export const editorValid = (errors: EditorErrors) => Object.keys(errors).length === 0;

/** What the hub is sent to save `draft`: over `page` when it edits one, as a new page in `scope` otherwise. */
export const saveOf = (
  draft: EditorDraft,
  target: { readonly scope: MemoryScope; readonly page: MemoryPage | null },
): MemoryPageSave => ({
  scope: memoryScopeKey(target.scope),
  path: target.page?.path ?? memoryPathFor(draft.kind, draft.title),
  markdown: markdownOf(draft),
  tags: target.page?.tags ?? [],
  pinned: draft.pinned,
  forgetOn: draft.forgetOn === "" ? null : MemoryForgetDay.make(draft.forgetOn),
  expected: target.page?.version ?? null,
});

/** `page` saved again as it is but for `change`: a pin, or a forget day. */
export const changedPage = (
  page: MemoryPage,
  change: Partial<Pick<MemoryPageSave, "pinned" | "forgetOn">>,
): MemoryPageSave => ({
  scope: memoryScopeKey(page.scope),
  path: page.path,
  markdown: page.markdown,
  tags: page.tags,
  pinned: change.pinned ?? page.pinned,
  forgetOn: change.forgetOn === undefined ? page.forgetOn : change.forgetOn,
  expected: page.version,
});

/** A version of a page, for a delete or a restore. */
export const versionRef = (scope: MemoryScope, path: MemoryPath, version: MemoryVersion) => ({
  scope: memoryScopeKey(scope),
  path,
  version,
});

/** Who reads a saved change first, as the editor's note says it. */
export const readersOf = (scope: MemoryScope, hobs: HobDirectory): string => {
  switch (scope._tag) {
    case "Hob":
      return copy.editor.readsHob({ name: scopeName(scope, hobs) });
    case "Project":
      return copy.editor.readsProject({ name: scopeName(scope, hobs) });
    case "Everyone":
      return copy.editor.readsEveryone;
  }
};

/** A house rule as a page of About you: its words are its title. */
export const houseRuleOf = (text: string): MemoryPageSave =>
  saveOf(
    { title: text, body: "", kind: "rule", pinned: false, forgetOn: "" },
    { scope: { _tag: "Everyone" }, page: null },
  );
