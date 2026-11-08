import type { TaskFile } from "@hobbots/domain";

/** The file's own name, the last part of its path. */
export const fileName = (file: Pick<TaskFile, "path">): string => file.path.slice(file.path.lastIndexOf("/") + 1);

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
