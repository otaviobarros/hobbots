import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";
import { handleShowFileIpc, showFileChannel } from "../src/main/show-file.ts";

const trusted = { senderFrame: { url: "http://127.0.0.1:4317/" } } as IpcMainInvokeEvent;
const stranger = { senderFrame: { url: "https://example.com/" } } as IpcMainInvokeEvent;

const LISTED = {
  attemptId: "a1",
  files: [
    { id: "report", location: "/Users/me/shop/report.md", now: "same" },
    { id: "old", location: "/Users/me/shop/old.md", now: "gone" },
    { id: "replaced", location: "/Users/me/shop/replaced.md", now: "changed" },
  ],
};

const setup = (files: Readonly<Record<string, boolean>> = { "/Users/me/shop/report.md": true }) => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const read: Array<string> = [];
  const shown: Array<string> = [];
  handleShowFileIpc({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
    isTrusted: (event) => event.senderFrame?.url === "http://127.0.0.1:4317/",
    readHub: async (path) => {
      read.push(path);
      return path === "/api/attempts/a1/files" ? LISTED : null;
    },
    isFile: async (path) => files[path] ?? false,
    showItemInFolder: (path) => void shown.push(path),
  });
  const show = (event: IpcMainInvokeEvent, ...args: unknown[]) => handlers.get(showFileChannel)?.(event, ...args);
  return { handlers, read, shown, show };
};

describe("the Show in Finder bridge", () => {
  // covers UX-002, PE-005
  it("[#388] shows only a file the hub lists for the Attempt, found by its ids", async () => {
    const { handlers, read, shown, show } = setup();
    expect([...handlers.keys()]).toEqual([showFileChannel]);
    await expect(show(trusted, "a1", "report")).resolves.toBe(true);
    expect(read).toEqual(["/api/attempts/a1/files"]);
    expect(shown).toEqual(["/Users/me/shop/report.md"]);
  });

  // covers PE-005
  it("[#388] shows nothing the hub does not list, a gone file, or one no longer a regular file", async () => {
    const { read, shown, show } = setup();
    await expect(show(trusted, "a1", "/etc/passwd")).resolves.toBe(false);
    await expect(show(trusted, "../a1", "report")).resolves.toBe(false);
    await expect(show(trusted, "a1", { id: "report" })).resolves.toBe(false);
    await expect(show(trusted, "a2", "report")).resolves.toBe(false);
    await expect(show(trusted, "a1", "old")).resolves.toBe(false);
    // Listed, but now a link or a folder at that place.
    await expect(show(trusted, "a1", "replaced")).resolves.toBe(false);
    expect(read).toEqual(["/api/attempts/a2/files", "/api/attempts/a1/files", "/api/attempts/a1/files"]);
    expect(shown).toEqual([]);
  });

  // covers PE-005
  it("[#388] refuses a page the window is not allowed to show", async () => {
    const { read, shown, show } = setup();
    await expect(show(stranger, "a1", "report")).rejects.toThrow("Not allowed from this page");
    expect(read).toEqual([]);
    expect(shown).toEqual([]);
  });
});
