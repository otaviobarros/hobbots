import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { messages } from "../src/main/messages.ts";
import { type WatchedPage, type WindowPrompt, watchWindow } from "../src/main/window-recovery.ts";

const copy = messages.window;

/** A window's page as a plain emitter, recording what the watcher asks of it. */
const watched = (answer: (prompt: WindowPrompt) => Promise<number> = async () => 0) => {
  const emitter = new EventEmitter();
  const done: string[] = [];
  const asked: WindowPrompt[] = [];
  const logged: string[] = [];
  const pending: Array<() => void> = [];
  let clock = 0;
  let destroyed = false;
  const page = Object.assign(emitter, {
    reload: () => void done.push("reload"),
    loadURL: async (url: string) => void done.push(`load ${url}`),
    forcefullyCrashRenderer: () => void done.push("crash"),
    isDestroyed: () => destroyed,
  });
  watchWindow({
    page: page as unknown as WatchedPage,
    ask: (prompt) => {
      asked.push(prompt);
      return answer(prompt);
    },
    close: () => void done.push("close"),
    log: (message) => void logged.push(message),
    later: (_ms, run) => void pending.push(run),
    now: () => clock,
  });
  return {
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    done,
    asked,
    logged,
    runLater: () => {
      for (const run of pending.splice(0)) run();
    },
    tick: (ms: number) => {
      clock += ms;
    },
    destroy: () => {
      destroyed = true;
    },
  };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));
const crash = { reason: "crashed", exitCode: 11 };

describe("a window whose page fails", () => {
  it("reloads a crashed page, and asks once it keeps crashing", async () => {
    const page = watched(async () => 1);
    page.emit("render-process-gone", {}, crash);
    page.tick(10_000);
    page.emit("render-process-gone", {}, crash);
    expect(page.done).toEqual(["reload", "reload"]);
    expect(page.asked).toEqual([]);
    page.tick(10_000);
    page.emit("render-process-gone", {}, crash);
    await settle();
    expect(page.asked.map((prompt) => prompt.message)).toEqual([copy.stopped]);
    expect(page.asked[0]?.buttons).toEqual([copy.reload, copy.close]);
    // The user chose Close window.
    expect(page.done).toEqual(["reload", "reload", "close"]);
    expect(page.logged).toHaveLength(3);
  });

  it("counts crashes a minute apart as separate, so a rare crash only reloads", () => {
    const page = watched();
    for (let crashes = 0; crashes < 5; crashes++) {
      page.emit("render-process-gone", {}, crash);
      page.tick(61_000);
    }
    expect(page.done).toEqual(["reload", "reload", "reload", "reload", "reload"]);
    expect(page.asked).toEqual([]);
  });

  it("asks about a hung page, closes the question once it responds, and reloads only when asked", async () => {
    const answers: Array<(choice: number) => void> = [];
    // The question stays open until the user answers, or until it is closed unanswered.
    const page = watched(
      (prompt) =>
        new Promise((resolve) => {
          answers.push(resolve);
          prompt.signal?.addEventListener("abort", () => resolve(0));
        }),
    );
    page.emit("unresponsive");
    page.emit("unresponsive");
    expect(page.asked.map((prompt) => prompt.message)).toEqual([copy.notResponding]);
    expect(page.asked[0]?.buttons).toEqual([copy.wait, copy.reload]);
    page.emit("responsive");
    expect(page.asked[0]?.signal?.aborted).toBe(true);
    await settle();
    expect(page.done).toEqual([]);

    page.emit("unresponsive");
    answers.at(-1)?.(1);
    await settle();
    // Its page stops, and the crash handler loads it again.
    expect(page.done).toEqual(["crash"]);
  });

  it("tries a page that did not load again, then asks", async () => {
    const page = watched(async () => 0);
    const fail = () => page.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:4317/", true);
    fail();
    page.runLater();
    fail();
    page.runLater();
    expect(page.done).toEqual(["load http://127.0.0.1:4317/", "load http://127.0.0.1:4317/"]);
    expect(page.asked).toEqual([]);
    fail();
    await settle();
    expect(page.asked.map((prompt) => prompt.message)).toEqual([copy.notLoaded]);
    expect(page.asked[0]?.buttons).toEqual([copy.tryAgain, copy.close]);
    // The user chose Try again, which starts the count over.
    expect(page.done.at(-1)).toBe("load http://127.0.0.1:4317/");
    page.emit("did-finish-load");
  });

  it("ignores a load that was stopped, a frame inside the page, and a window that is gone", async () => {
    const page = watched();
    page.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://example.com/", true);
    page.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "https://example.com/frame", false);
    expect(page.logged).toEqual([]);
    page.destroy();
    page.emit("render-process-gone", {}, crash);
    page.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:4317/", true);
    page.runLater();
    await settle();
    expect(page.done).toEqual([]);
  });
});
