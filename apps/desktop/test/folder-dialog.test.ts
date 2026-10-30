import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { describe, expect, it } from "vitest";
import { folderDialogChannel, folderDialogOptions, handleFolderDialogIpc } from "../src/main/folder-dialog.ts";

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
  return { handlers, shown, choose };
};

describe("the folder dialog bridge", () => {
  // covers OP-001, DP-001
  it("[TC-DP-024] opens a folder-only dialog and ignores anything the page sends", async () => {
    const { handlers, shown, choose } = setup({ canceled: false, filePaths: ["/Users/me/code"] });
    expect([...handlers.keys()]).toEqual([folderDialogChannel]);
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
    await expect(choose(stranger)).rejects.toThrow("Not allowed from this page");
    expect(shown).toEqual([]);
  });
});
