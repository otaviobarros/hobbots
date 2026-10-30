import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from "electron";

/** The one channel the preload bridge calls to pick a folder. */
export const folderDialogChannel = "hobbots:folder-dialog:choose";

/** What the dialog shows; the page cannot change it, so the bridge only ever picks folders. */
export const folderDialogOptions: OpenDialogOptions = {
  title: "Choose a folder for your hobs",
  buttonLabel: "Let hobs work here",
  properties: ["openDirectory", "createDirectory"],
};

/**
 * Answers the bridge with the folder the user picked, or null when they cancelled. The call takes
 * no arguments, answers only pages the window is allowed to show, and returns a path the user
 * chose in the system dialog; the hub checks the folder again before storing it.
 */
export const handleFolderDialogIpc = (options: {
  readonly ipcMain: Pick<IpcMain, "handle">;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
  readonly windowOf: (event: IpcMainInvokeEvent) => BrowserWindow | null;
  readonly showOpenDialog: (
    window: BrowserWindow | null,
    options: OpenDialogOptions,
  ) => Promise<{ canceled: boolean; filePaths: ReadonlyArray<string> }>;
}) => {
  const { ipcMain, isTrusted, windowOf, showOpenDialog } = options;
  ipcMain.handle(folderDialogChannel, async (event: IpcMainInvokeEvent) => {
    if (!isTrusted(event)) throw new Error("Not allowed from this page");
    const result = await showOpenDialog(windowOf(event), folderDialogOptions);
    const [folder] = result.filePaths;
    return result.canceled || folder === undefined ? null : folder;
  });
};
