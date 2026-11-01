import { afterEach, describe, expect, it } from "vitest";
import { coalesce } from "../src/main/coalesce.ts";
import { followHub, type HubEventsOptions } from "../src/main/hub-events.ts";
import { frameChange } from "../src/main/hub-events-model.ts";
import { entryFrame, fakeEventStream, readyFrame } from "./fake-event-stream.ts";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

/** Follows a fake hub and records what the main process hears. */
const follow = (options: Partial<HubEventsOptions> = {}, opening?: string) => {
  const hub = fakeEventStream(opening);
  const heard: Array<string> = [];
  const following = followHub({
    url: "http://127.0.0.1:4317/api/events",
    canConnect: () => true,
    onConnected: () => void heard.push("connected"),
    onChange: (change) => void heard.push(change),
    onLost: () => void heard.push("lost"),
    fetch: hub.fetch,
    firstRetryMs: 5,
    maxRetryMs: 20,
    ...options,
  });
  stops.push(following.stop);
  return { hub, heard, ...following };
};

const reply = (role: string) => ({ _tag: "MessageUpserted", message: { id: "m", role, status: "streaming" } });

describe("following the hub's event stream", () => {
  // covers DP-002, UX-001
  it("[TC-DP-042] reads again only on a change it shows, and reconnects after the hub drops it", async () => {
    const { hub, heard } = follow();
    await expect.poll(() => hub.connections.length).toBe(1);
    hub.last().write(readyFrame);
    hub.last().write(": keep-alive\n\n");
    hub.last().write(entryFrame("ApprovalRequested", { _tag: "ApprovalRequested" }, 1));
    hub.last().write(entryFrame("MessageUpserted", reply("user"), 2));
    hub.last().write(entryFrame("MessageUpserted", reply("assistant"), 3));
    hub.last().write(entryFrame("GrantCreated", { _tag: "GrantCreated" }, 4));
    // A frame split across chunks is read once it is complete.
    const resolved = entryFrame("ApprovalResolved", { _tag: "ApprovalResolved" }, 5);
    hub.last().write(resolved.slice(0, 9));
    hub.last().write(resolved.slice(9));
    await expect.poll(() => heard).toEqual(["connected", "approvals", "activity", "approvals"]);

    hub.last().close();
    await expect.poll(() => hub.connections.length).toBe(2);
    hub.last().write(readyFrame);
    await expect.poll(() => heard.slice(4)).toEqual(["lost", "connected"]);
  });

  // covers DP-002
  it("[TC-DP-043] counts a silent stream as lost, so a hub that stopped answering shows", async () => {
    const { hub, heard } = follow({ silenceMs: 30, maxRetryMs: 60_000, firstRetryMs: 60_000 }, readyFrame);
    await expect.poll(() => heard).toEqual(["connected", "lost"]);
    expect(hub.connections).toHaveLength(1);
    expect(hub.connections[0]?.aborted).toBe(true);
  });

  it("follows only while the hub may answer, connects at once when it may again, and stops for good", async () => {
    let running = false;
    const { hub, heard, sync, stop } = follow({ canConnect: () => running, maxRetryMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hub.connections).toHaveLength(0);
    running = true;
    sync();
    await expect.poll(() => hub.connections.length).toBe(1);
    hub.last().write(readyFrame);
    await expect.poll(() => heard).toEqual(["connected"]);
    running = false;
    sync();
    await expect.poll(() => hub.connections[0]?.aborted).toBe(true);
    running = true;
    sync();
    await expect.poll(() => hub.connections.length).toBe(2);
    await stop();
    await expect.poll(() => hub.connections[1]?.aborted).toBe(true);
    expect(heard).toEqual(["connected"]);
  });

  it("does not report a connection that never connected as lost", async () => {
    const { hub, heard } = follow();
    await expect.poll(() => hub.connections.length).toBe(1);
    hub.last().close();
    await expect.poll(() => hub.connections.length).toBe(2);
    expect(heard).toEqual([]);
  });
});

describe("the event stream model", () => {
  it("names the read each entry makes stale", () => {
    const message = (data: string) => frameChange({ event: "message", data });
    expect(frameChange({ event: "ready", data: "{}" })).toBe("connected");
    expect(frameChange({ event: "delta", data: "{}" })).toBeNull();
    expect(message(JSON.stringify({ type: "ApprovalResolved" }))).toBe("approvals");
    expect(message(JSON.stringify({ type: "MessageUpserted", payload: reply("assistant") }))).toBe("activity");
    expect(message(JSON.stringify({ type: "MessageUpserted", payload: reply("user") }))).toBeNull();
    expect(message("not json")).toBeNull();
  });
});

describe("coalesce", () => {
  it("never overlaps runs and runs once more for calls made during a run", async () => {
    let runs = 0;
    let release: () => void = () => {};
    const task = coalesce(async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = task();
    void task();
    const third = task();
    expect(runs).toBe(1);
    release();
    await expect.poll(() => runs).toBe(2);
    release();
    await Promise.all([first, third]);
    expect(runs).toBe(2);
  });
});
