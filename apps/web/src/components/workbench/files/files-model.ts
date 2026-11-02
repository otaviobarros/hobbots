import type { AttemptActivity, TaskFile, TaskFileId } from "@hobbots/domain";

/**
 * What changes whenever an Attempt's records do: a recorded change or result, or the Attempt
 * moving on. The Files tab reads its list again when it changes.
 */
export const filesStamp = (activity: AttemptActivity): string => {
  const latest = activity.changes
    .map((change) => change.recordedAt)
    .sort()
    .at(-1);
  return [activity.attempt.state, activity.changes.length, activity.artifacts.length, latest].join("|");
};

/**
 * The file the tab shows: the one picked, else the one another tab pointed at by where it is on the
 * hub, else the first. Null when the Task listed none.
 */
export const shownFile = (
  files: ReadonlyArray<TaskFile>,
  picked: TaskFileId | null,
  focus: string | undefined,
): TaskFile | null =>
  files.find((file) => file.id === picked) ??
  (focus === undefined ? undefined : files.find((file) => file.location === focus)) ??
  files[0] ??
  null;

/** The file's own name, the last part of its path. */
export const fileName = (file: Pick<TaskFile, "path">): string => file.path.slice(file.path.lastIndexOf("/") + 1);

/** The folder inside the hob's folder it sits in, or empty at the top. */
export const fileDirectory = (file: Pick<TaskFile, "path">): string => {
  const slash = file.path.lastIndexOf("/");
  return slash < 0 ? "" : file.path.slice(0, slash);
};

/** How the tab can show the file: its preview, or why only its name, size and kind are shown. */
export type FileView =
  | { readonly kind: "preview"; readonly preview: Exclude<TaskFile["preview"], "none"> }
  | { readonly kind: "gone" }
  | { readonly kind: "secret" }
  | { readonly kind: "too-large" }
  | { readonly kind: "no-preview" };

export const fileView = (file: TaskFile): FileView => {
  if (file.now === "gone") return { kind: "gone" };
  if (file.notServed !== null) return { kind: file.notServed };
  if (file.preview === "none") return { kind: "no-preview" };
  return { kind: "preview", preview: file.preview };
};

/** Whether the file can be downloaded through the hub: it is there and the hub serves it. */
export const canDownload = (file: TaskFile): boolean => file.now !== "gone" && file.notServed === null;
