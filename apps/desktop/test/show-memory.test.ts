import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";
import { handleShowMemoryIpc, showMemoryChannel } from "../src/main/show-memory.ts";

const trusted = { senderFrame: { url: "http://127.0.0.1:4317/" } } as IpcMainInvokeEvent;
const stranger = { senderFrame: { url: "https://example.com/" } } as IpcMainInvokeEvent;
const FOLDER = "/Users/me/Library/Application Support/Hobbots/memory/wiki";

const setup = (folders: ReadonlySet<string>, openError = "") => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const opened: Array<string> = [];
  handleShowMemoryIpc({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
    isTrusted: (event) => event.senderFrame?.url === "http://127.0.0.1:4317/",
    folder: FOLDER,
    isFolder: async (path) => folders.has(path),
    openPath: async (path) => {
      opened.push(path);
      return openError;
    },
  });
  const show = (event: IpcMainInvokeEvent, ...args: unknown[]) => handlers.get(showMemoryChannel)?.(event, ...args);
  return { handlers, opened, show };
};

describe("the Show the files bridge for memory", () => {
  // covers ADR 028
  it("[TC-GEN-210] opens only the memory pages folder, whatever the page sends", async () => {
    const { handlers, opened, show } = setup(new Set([FOLDER]));
    expect([...handlers.keys()]).toEqual([showMemoryChannel]);
    await expect(show(trusted, "/etc")).resolves.toBe(true);
    expect(opened).toEqual([FOLDER]);
  });

  // covers ADR 028
  it("[TC-GEN-211] opens nothing for a stranger, before memory has pages, or when Finder fails", async () => {
    await expect(setup(new Set([FOLDER])).show(stranger)).resolves.toEqual({ refused: "notAllowed" });
    const missing = setup(new Set());
    await expect(missing.show(trusted)).resolves.toBe(false);
    expect(missing.opened).toEqual([]);
    await expect(setup(new Set([FOLDER]), "Not found").show(trusted)).resolves.toBe(false);
  });
});
