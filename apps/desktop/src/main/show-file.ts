import type { IpcMain, IpcMainInvokeEvent } from "electron";

/** The one channel the preload bridge calls to show a Task's file in Finder. */
export const showFileChannel = "hobbots:files:show";

/** Ids as the hub makes them; anything else never reaches a request. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** What the hub's listing of an Attempt's files says of one file, as this bridge reads it. */
interface ListedFile {
  readonly id: unknown;
  readonly location: unknown;
  readonly now: unknown;
}

/**
 * Shows one of an Attempt's files in Finder, selected (ADR 023). The page names the file only by
 * the Attempt's and the file's ids: the bridge asks the hub, as the hub's window, for the files it
 * lists, so only a file the hub found inside the hob's folders is ever shown, and the page never
 * hands it a path. The file must still be a regular file there, not a link, when it is shown.
 * Answers whether it was shown.
 */
export const handleShowFileIpc = (options: {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
  /** Reads a path of the hub's API as the hub's window; null when it does not answer with JSON. */
  readonly readHub: (path: string) => Promise<unknown>;
  /** Whether `path` is a regular file now, reached without following a link at its name. */
  readonly isFile: (path: string) => Promise<boolean>;
  readonly showItemInFolder: (path: string) => void;
}) => {
  const { ipcMain, isTrusted, readHub, isFile, showItemInFolder } = options;
  ipcMain.handle(showFileChannel, async (event: IpcMainInvokeEvent, attemptId: unknown, fileId: unknown) => {
    if (!isTrusted(event)) throw new Error("Not allowed from this page");
    if (typeof attemptId !== "string" || typeof fileId !== "string" || !ID.test(attemptId) || !ID.test(fileId)) {
      return false;
    }
    const listed = await readHub(`/api/attempts/${attemptId}/files`).catch(() => null);
    const files: ReadonlyArray<ListedFile> =
      typeof listed === "object" && listed !== null && "files" in listed && Array.isArray(listed.files)
        ? listed.files
        : [];
    const file = files.find((each) => each.id === fileId);
    if (file === undefined || file.now === "gone" || typeof file.location !== "string") return false;
    if (!(await isFile(file.location).catch(() => false))) return false;
    showItemInFolder(file.location);
    return true;
  });
};
