import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it } from "vitest";
import { handleShowWindowIpc, showWindowChannel } from "../src/main/show-window.ts";

const trusted = { senderFrame: { url: "http://127.0.0.1:4317/" } } as IpcMainInvokeEvent;
const stranger = { senderFrame: { url: "https://example.com/" } } as IpcMainInvokeEvent;

const setup = (minimized: boolean) => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const calls: Array<string> = [];
  handleShowWindowIpc({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
    isTrusted: (event) => event.senderFrame?.url === "http://127.0.0.1:4317/",
    windowOf: () => ({
      isMinimized: () => minimized,
      restore: () => void calls.push("restore"),
      show: () => void calls.push("show"),
      focus: () => void calls.push("focus"),
    }),
  });
  const show = (event: IpcMainInvokeEvent) => handlers.get(showWindowChannel)?.(event);
  return { handlers, calls, show };
};

describe("the show-window bridge", () => {
  // covers UX-001, UX-005
  it("[TC-IN-012] brings the window that asked forward, restoring it when minimized", () => {
    const { handlers, calls, show } = setup(true);
    expect([...handlers.keys()]).toEqual([showWindowChannel]);
    show(trusted);
    expect(calls).toEqual(["restore", "show", "focus"]);
  });

  // covers UX-001, UX-005
  it("[TC-IN-013] answers only pages the window is allowed to show", () => {
    const { calls, show } = setup(false);
    expect(() => show(stranger)).toThrow("Not allowed from this page");
    expect(calls).toEqual([]);
  });
});
