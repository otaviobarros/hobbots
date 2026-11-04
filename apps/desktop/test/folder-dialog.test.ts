import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { describe, expect, it } from "vitest";
import {
  backupDialogChannels,
  backupDialogOptions,
  folderDialogChannel,
  folderDialogOptions,
  handleFolderDialogIpc,
} from "../src/main/folder-dialog.ts";

const trusted = { senderFrame: { url: "http://127.0.0.1:4317/" } } as IpcMainInvokeEvent;
const stranger = { senderFrame: { url: "https://example.com/" } } as IpcMainInvokeEvent;
const window = {} as BrowserWindow;

const setup = (answer: { canceled: boolean; filePaths: ReadonlyArray<string> }) => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const shown: Array<{ window: BrowserWindow | null; options: OpenDialogOptions }> = [];
  handleFolderDialogIpc({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
    isTrusted: (event) => event.senderFrame?.url === "http://127.0.0.1:4317/",
    windowOf: () => window,
    showOpenDialog: async (parent, options) => {
      shown.push({ window: parent, options });
      return answer;
    },
  });
  const choose = (event: IpcMainInvokeEvent, ...args: unknown[]) => handlers.get(folderDialogChannel)?.(event, ...args);
  const chooseOn = (channel: string, event: IpcMainInvokeEvent) => handlers.get(channel)?.(event);
  return { handlers, shown, choose, chooseOn };
};

describe("the folder dialog bridge", () => {
  // covers OP-001, DP-001
  it("[TC-DP-024] opens a folder-only dialog and ignores anything the page sends", async () => {
    const { handlers, shown, choose } = setup({ canceled: false, filePaths: ["/Users/me/code"] });
    expect([...handlers.keys()]).toEqual([
      folderDialogChannel,
      backupDialogChannels.save,
      backupDialogChannels.restore,
    ]);
    await expect(choose(trusted, { properties: ["openFile"], defaultPath: "/etc" })).resolves.toBe("/Users/me/code");
    expect(shown).toEqual([{ window, options: folderDialogOptions }]);
    expect(folderDialogOptions.properties).not.toContain("openFile");
    expect(folderDialogOptions.properties).not.toContain("multiSelections");
  });

  // covers OP-001
  it("[TC-DP-025] answers null when the user cancels", async () => {
    const { choose } = setup({ canceled: true, filePaths: [] });
    await expect(choose(trusted)).resolves.toBeNull();
  });

  // covers DP-001
  it("[TC-DP-026] refuses pages the window is not allowed to show", async () => {
    const { shown, choose } = setup({ canceled: false, filePaths: ["/"] });
    await expect(choose(stranger)).resolves.toEqual({ refused: "notAllowed" });
    expect(shown).toEqual([]);
  });

  // covers OP-003
  it("[TC-OP-038] picks a backup's folder with its own fixed dialogs, never a file", async () => {
    const { shown, chooseOn } = setup({ canceled: false, filePaths: ["/Users/me/Backups"] });
    await expect(chooseOn(backupDialogChannels.save, trusted)).resolves.toBe("/Users/me/Backups");
    await expect(chooseOn(backupDialogChannels.restore, trusted)).resolves.toBe("/Users/me/Backups");
    expect(shown.map((each) => each.options)).toEqual([backupDialogOptions.save, backupDialogOptions.restore]);
    for (const options of Object.values(backupDialogOptions)) expect(options.properties).not.toContain("openFile");
    await expect(chooseOn(backupDialogChannels.restore, stranger)).resolves.toEqual({ refused: "notAllowed" });
  });
});
