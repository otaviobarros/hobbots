import type { FilePreview, TaskFileNow, TaskFileOrigin } from "@hobbots/domain";
import { formatCount } from "../../../lib/format.ts";

/** Copy for the Workbench's Files tab (ADR 023, STD-I18N-001). */
export const messages = {
  list: "Files the hobs made or changed",
  made: "Made",
  touched: "Changed",
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
  seeChanges: "See changes",
  downloadFor: ({ name }: { name: string }) => `Download ${name}`,
  preview: ({ name }: { name: string }) => `Preview of ${name}`,
  tryAgain: "Try again",
  previewFailed: "Hobbots could not open this file.",
  cut: ({ size }: { size: string }) => `Showing the first ${size}.`,
  unshownTag: {
    "no-preview": "No preview",
    secret: "Not shown",
    "too-large": "Too large to open here",
    gone: "No longer there",
  },
  unshown: {
    "no-preview": "Hobbots cannot preview this kind of file. Download it, or show it in Finder.",
    secret: "Contents not kept: this file may hold secrets.",
    "too-large": "Files over 64 MB are not previewed. Show it in Finder on the hub.",
    gone: "This file is no longer there. It was moved or deleted after the task.",
  },
  count: (count: number) => formatCount(count),
};
