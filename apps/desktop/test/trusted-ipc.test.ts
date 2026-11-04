import { Schema } from "effect";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTrusted, noArgs, withArgs } from "../src/main/trusted-ipc.ts";

const trusted = { senderFrame: { url: "http://127.0.0.1:4317/" } } as IpcMainInvokeEvent;
const stranger = { senderFrame: { url: "https://example.com/" } } as IpcMainInvokeEvent;

const register = (routes: Parameters<typeof handleTrusted>[1]) => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const channels = handleTrusted(
    {
      ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
      isTrusted: (event) => event.senderFrame?.url === "http://127.0.0.1:4317/",
    },
    routes,
  );
  const call = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) =>
    handlers.get(channel)?.(event, ...args);
  return { channels, call };
};

afterEach(() => vi.restoreAllMocks());

describe("the trusted IPC registration", () => {
  it("answers each channel only from a trusted page, and lists the channels it answers", async () => {
    const run = vi.fn(() => "done");
    const { channels, call } = register({ "test:run": noArgs(run), "test:other": noArgs(() => null) });
    expect(channels).toEqual(["test:run", "test:other"]);
    await expect(call("test:run", stranger)).resolves.toEqual({ refused: "notAllowed" });
    expect(run).not.toHaveBeenCalled();
    await expect(call("test:run", trusted, "ignored")).resolves.toBe("done");
    expect(run).toHaveBeenCalledWith(trusted);
  });

  it("parses the arguments before the handler sees them, and refuses any that do not parse", async () => {
    const run = vi.fn((args: readonly [string, number]) => `${args[0]}:${args[1]}`);
    const { call } = register({ "test:pair": withArgs(Schema.Tuple([Schema.String, Schema.Number]), run) });
    await expect(call("test:pair", trusted, "a", 1)).resolves.toBe("a:1");
    for (const args of [[], ["a"], [1, "a"], ["a", 1, "extra"], [{ toString: () => "a" }, 1]]) {
      await expect(call("test:pair", trusted, ...args)).resolves.toEqual({ refused: "malformed" });
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed handler with only the channel's name, and logs the cause", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = register({
      "test:fail": noArgs(async () => {
        throw new Error("secret path /Users/me/.hobbots/window-key");
      }),
    });
    const failure = await Promise.resolve(call("test:fail", trusted)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("test:fail failed");
    expect(logged).toHaveBeenCalledOnce();
  });
});
