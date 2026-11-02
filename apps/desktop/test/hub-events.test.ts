import { afterEach, describe, expect, it } from "vitest";
import { coalesce } from "../src/main/coalesce.ts";
import { hubAddress } from "../src/main/hub-address.ts";
import { followHub, type HubEventsOptions } from "../src/main/hub-events.ts";
import { frameChange } from "../src/main/hub-events-model.ts";
import { entryFrame, fakeEventStream, readyFrame, resumedFrame, turnFrame } from "./fake-event-stream.ts";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

/** Follows a fake hub and records what the main process hears. */
const follow = (options: Partial<HubEventsOptions> = {}, opening?: string) => {
  const hub = fakeEventStream(opening);
  const heard: Array<string> = [];
  const following = followHub({
    url: () => "http://127.0.0.1:4317/api/events",
    canConnect: () => true,
    onConnected: (resumed) => void heard.push(resumed ? "resumed" : "connected"),
    onChange: (change) => void heard.push(change._tag === "Approvals" ? "approvals" : "activity"),
    onLost: () => void heard.push("lost"),
    fetch: hub.fetch,
    firstRetryMs: 5,
    maxRetryMs: 20,
    ...options,
  });
  stops.push(following.stop);
  return { hub, heard, ...following };
};

const reply = (role: string, status = "streaming") => ({
  _tag: "MessageUpserted",
  message: { id: "m", threadId: "t1", role, status },
});

describe("following the hub's event stream", () => {
  // covers DP-002, UX-001
  it("[TC-DP-042] reads again only on a change it shows, and reconnects after the hub drops it", async () => {
    const { hub, heard } = follow();
    await expect.poll(() => hub.connections.length).toBe(1);
    hub.last().write(readyFrame);
    hub.last().write(": keep-alive\n\n");
    hub.last().write(entryFrame("ApprovalRequested", { _tag: "ApprovalRequested" }, 1));
    // A reply's own events leave who is working to the turn frames.
    hub.last().write(entryFrame("MessageUpserted", reply("assistant"), 2));
    hub.last().write(turnFrame("TurnStarted"));
    hub.last().write(entryFrame("MessageUpserted", reply("assistant", "complete"), 3));
    hub.last().write(turnFrame("TurnEnded"));
    hub.last().write(entryFrame("GrantCreated", { _tag: "GrantCreated" }, 4));
    // A frame split across chunks is read once it is complete.
    const resolved = entryFrame("ApprovalResolved", { _tag: "ApprovalResolved" }, 5);
    hub.last().write(resolved.slice(0, 9));
    hub.last().write(resolved.slice(9));
    await expect.poll(() => heard).toEqual(["connected", "approvals", "activity", "activity", "approvals"]);

    hub.last().close();
    await expect.poll(() => hub.connections.length).toBe(2);
    hub.last().write(readyFrame);
    await expect.poll(() => heard.slice(5)).toEqual(["lost", "connected"]);
  });

  // covers DP-002
  it("[TC-DP-043] counts a silent stream as lost, so a hub that stopped answering shows", async () => {
    const { hub, heard } = follow({ silenceMs: 30, maxRetryMs: 60_000, firstRetryMs: 60_000 }, readyFrame);
    await expect.poll(() => heard).toEqual(["connected", "lost"]);
    expect(hub.connections).toHaveLength(1);
    expect(hub.connections[0]?.aborted).toBe(true);
  });

  // covers DP-004
  it("[TC-DP-071] follows the hub to the port it moved to", async () => {
    const address = hubAddress(4317);
    const moves: Array<number> = [];
    const following = follow({
      url: () => `${address.apiUrl}/api/events`,
      onChange: (change) => {
        if (change._tag !== "Port" || !address.move(change.port)) return;
        moves.push(change.port);
        void following.reconnect();
      },
    });
    const { hub } = following;
    await expect.poll(() => hub.connections.length).toBe(1);
    hub.last().write(readyFrame);
    const status = { enabled: false, port: 4400, tailscale: null, listening: [], problem: "off", detail: null };
    hub.last().write(`event: remote-access\ndata: ${JSON.stringify({ _tag: "RemoteAccessChanged", status })}\n\n`);
    await expect.poll(() => hub.connections.length).toBe(2);
    expect(moves).toEqual([4400]);
    expect(hub.connections[0]?.aborted).toBe(true);
    expect(hub.connections.map((connection) => connection.url)).toEqual([
      "http://127.0.0.1:4317/api/events",
      "http://127.0.0.1:4400/api/events",
    ]);
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

  // covers DP-002
  it("[TC-DP-045] checks the hub again after every failed try, so a hub that goes away while reconnecting shows", async () => {
    const { hub, heard } = follow();
    await expect.poll(() => hub.connections.length).toBe(1);
    hub.last().write(readyFrame);
    await expect.poll(() => heard).toEqual(["connected"]);
    // The hub drops the stream, then every try fails before it says Ready.
    hub.last().close();
    await expect.poll(() => hub.connections.length).toBe(2);
    hub.last().close();
    await expect.poll(() => hub.connections.length).toBe(3);
    hub.last().close();
    await expect.poll(() => heard).toEqual(["connected", "lost", "lost", "lost"]);
  });
});

// covers DP-002, UX-001
it("[TC-DP-049] resumes after the last entry it received, so the hub replays what it missed", async () => {
  const { hub, heard } = follow();
  await expect.poll(() => hub.connections.length).toBe(1);
  expect(hub.connections[0]?.lastEventId).toBeNull();
  hub.last().write(readyFrame);
  hub.last().write(entryFrame("ApprovalResolved", { _tag: "ApprovalResolved" }, 7));
  // A turn frame has no id, so the cursor stays at the last entry.
  hub.last().write(turnFrame("TurnEnded"));
  await expect.poll(() => heard).toEqual(["connected", "approvals", "activity"]);
  hub.last().close();
  await expect.poll(() => hub.connections.length).toBe(2);
  expect(hub.connections[1]?.lastEventId).toBe("e.7");
  hub.last().write(resumedFrame("e.7"));
  await expect.poll(() => heard).toEqual(["connected", "approvals", "activity", "lost", "resumed"]);
});

describe("the event stream model", () => {
  it("names the read each entry makes stale", () => {
    const message = (data: string) => frameChange({ event: "message", data });
    expect(frameChange({ event: "ready", data: "{}" })).toEqual({ _tag: "Connected", resumed: false });
    expect(frameChange({ event: "ready", data: '{"cursor":"e.3","resumed":true}' })).toEqual({
      _tag: "Connected",
      resumed: true,
    });
    expect(frameChange({ event: "delta", data: "{}" })).toBeNull();
    expect(message(JSON.stringify({ type: "ApprovalResolved" }))).toEqual({ _tag: "Approvals" });
    expect(frameChange({ event: "turn", data: "{}" })).toEqual({ _tag: "Activity" });
    expect(message(JSON.stringify({ type: "MessageUpserted", payload: reply("assistant") }))).toBeNull();
    expect(message("not json")).toBeNull();
  });

  it("reads the hub's new port from a remote access change", () => {
    const status = { enabled: true, port: 4400, tailscale: null, listening: [], problem: null, detail: null };
    expect(
      frameChange({ event: "remote-access", data: JSON.stringify({ _tag: "RemoteAccessChanged", status }) }),
    ).toEqual({ _tag: "Port", port: 4400 });
    expect(frameChange({ event: "remote-access", data: "{}" })).toBeNull();
  });
});

describe("hubAddress", () => {
  it("points every reader at a new port, and ignores the same port or one out of range", () => {
    const hub = hubAddress(4317);
    expect(hub.apiUrl).toBe("http://127.0.0.1:4317");
    expect(hub.move(4317)).toBe(false);
    expect(hub.move(0)).toBe(false);
    expect(hub.move(70000)).toBe(false);
    expect(hub.move(4400)).toBe(true);
    expect([hub.port, hub.apiUrl]).toEqual([4400, "http://127.0.0.1:4400"]);
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
