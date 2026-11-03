import type { FilePreview, TaskFileNow, TaskFileOrigin } from "@hobbots/domain";
import { formatCount } from "../../../lib/format.ts";

/** Copy for the Workbench's Files tab (ADR 023, STD-I18N-001). */
export const messages = {
  list: "Files from this task",
  made: "Made in this task",
  touched: "Changed in this task",
  origin: {
    made: "Made",
    added: "Added",
    edited: "Edited",
    moved: "Moved",
  } satisfies Record<TaskFileOrigin, string>,
  kind: {
    image: "Image",
    pdf: "PDF",
    markdown: "Markdown",
    text: "Text",
    none: "File",
  } satisfies Record<FilePreview, string>,
  now: {
    same: null,
    changed: "Changed since this task",
    unchecked: "Too large to check for changes",
    gone: "No longer there",
  } satisfies Record<TaskFileNow, string | null>,
  showInFinder: "Show in Finder",
  showInFinderFor: ({ name }: { name: string }) => `Show ${name} in Finder`,
  notShown: "Finder could not find this file. It may have moved since.",
  download: "Download",
  downloadFor: ({ name }: { name: string }) => `Download ${name}`,
  preview: ({ name }: { name: string }) => `Preview of ${name}`,
  loading: "Reading the files…",
  failed: "Hobbots could not read this task's files.",
  tryAgain: "Try again",
  previewLoading: "Opening the file…",
  previewFailed: "Hobbots could not open this file.",
  cut: ({ size }: { size: string }) => `Showing the first ${size}.`,
  noPreview: "Hobbots cannot preview this kind of file. Download it, or show it in Finder.",
  secret: "Contents not kept: this file may hold secrets.",
  tooLarge: "This file is too large to open here. Show it in Finder on the hub.",
  gone: "This file is no longer there. It was moved or deleted after the task.",
  count: (count: number) => formatCount(count),
};
