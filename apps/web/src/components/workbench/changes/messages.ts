import type { FileChangeKind, NotKept } from "@hobbots/domain";
import { formatCount, formatList } from "../../../lib/format.ts";

/** Copy for the Workbench's Changes tab (ADR 023, STD-I18N-001). */
export const messages = {
  files: "Changed files",
  noneYet: "No files changed yet. Changes show here as the hob makes them.",
  summary: ({ total, parts }: { total: number; parts: ReadonlyArray<string> }) =>
    `${formatCount(total)} ${total === 1 ? "file" : "files"} changed: ${formatList(parts)}`,
  count: {
    added: (count: number) => `${formatCount(count)} added`,
    edited: (count: number) => `${formatCount(count)} edited`,
    deleted: (count: number) => `${formatCount(count)} deleted`,
    moved: (count: number) => `${formatCount(count)} moved`,
    link: (count: number) => `${formatCount(count)} ${count === 1 ? "link" : "links"}`,
  } satisfies Record<FileChangeKind, (count: number) => string>,
  kind: {
    added: "Added",
    edited: "Edited",
    deleted: "Deleted",
    moved: "Moved",
    link: "Link",
  } satisfies Record<FileChangeKind, string>,
  lines: ({ added, removed }: { added: number; removed: number }) =>
    `${formatCount(added)} ${added === 1 ? "line" : "lines"} added, ${formatCount(removed)} removed`,
  movedFrom: ({ path }: { path: string }) => `Moved from ${path}`,
  shared: ({ names }: { names: ReadonlyArray<string> }) =>
    `Changed while ${formatList(names)} ${names.length === 1 ? "was" : "were"} also working here.`,
  sharedUnknown: "Changed while another hob was also working here.",
  soFar: "So far: this turn is still running, so this file may change again.",
  showAs: "Show as",
  openInFiles: "Open in Files",
  before: "Before",
  after: "After",
  rendered: "Rendered",
  source: "Source",
  whole: "Show the whole file",
  fold: "Fold unchanged lines",
  folded: (count: number) => `Show ${formatCount(count)} unchanged ${count === 1 ? "line" : "lines"}`,
  deletedHeld: "Deleted in this task. This is what it held.",
  diff: ({ path }: { path: string }) => `Changes to ${path}`,
  added: "Added:",
  removed: "Removed:",
  noLines: "This file is empty.",
  reading: "Reading this file…",
  image: {
    before: ({ path }: { path: string }) => `${path} before`,
    after: ({ path }: { path: string }) => `${path} after`,
    failed: "Hobbots could not show this image.",
  },
  other: ({ kind, size }: { kind: string | null; size: string }) => (kind === null ? size : `${kind} file · ${size}`),
  sizes: ({ before, after }: { before: string; after: string }) => `${before} before, ${after} after`,
  link: "A link. Hobbots records where links point but never follows them.",
  /** Why one version of a file is not shown; the earlier version says so as ADR 023 words it. */
  notKept: {
    before: {
      cleared: "Earlier version not kept: details were cleared after 30 days.",
      "too-large": "Earlier version not kept: too large.",
      "not-shown": "Earlier version not kept: not a kind Hobbots can show.",
      secret: "Contents not kept: this file may hold secrets.",
      "attempt-limit": "Earlier version not kept: this task had already kept all it may.",
      unreadable: "Earlier version not kept: Hobbots could not read it.",
    },
    after: {
      cleared: "This version is no longer kept: details were cleared after 30 days.",
      "too-large": "This version not kept: too large.",
      "not-shown": "This version not kept: not a kind Hobbots can show.",
      secret: "Contents not kept: this file may hold secrets.",
      "attempt-limit": "This version not kept: this task had already kept all it may.",
      unreadable: "This version not kept: Hobbots could not read it.",
    },
  } satisfies Record<"before" | "after", Record<NotKept, string>>,
  unread: "Hobbots could not read this file's contents.",
  tryAgain: "Try again",
};
