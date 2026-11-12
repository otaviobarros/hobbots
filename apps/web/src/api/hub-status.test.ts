import { AgentId, type HobPresence, type StatusSnapshot, ThreadId, type ThreadRunStatus } from "@hobbots/domain";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// Each snapshot read waits until the test answers it, so a test decides what arrives first.
const pending: Array<(snapshot: StatusSnapshot) => void> = [];
vi.mock("./client.ts", () => ({
  call: () => new Promise<StatusSnapshot>((resolve) => pending.push(resolve)),
}));

const { applyStatusFrame, hubStatusQuery, statusReady } = await import("./hub-status.ts");

const wren = AgentId.make("wren");
const chat = ThreadId.make("t1");

const run = (revision: number, reply: ThreadRunStatus["reply"] = "working"): ThreadRunStatus => ({
  threadId: chat,
  run: reply === null ? "idle" : "running",
  reply,
  revision,
});
const presence = (revision: number, state: HobPresence["state"]): HobPresence => ({ agentId: wren, state, revision });
const snapshot = (over: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  runsRevision: 0,
  runs: [],
  presenceRevision: 0,
  hobs: [],
  ...over,
});
const frame = (event: unknown) => JSON.stringify(event);
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The status on screen, as a sidebar following it holds it. */
const watched = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(client, hubStatusQuery);
  const unsubscribe = observer.subscribe(() => {});
  const shown = () => {
    const view = observer.getCurrentResult().data;
    return { runs: view?.runs[chat]?.reply ?? null, hob: view?.hobs[wren]?.state ?? null };
  };
  return { client, shown, unsubscribe };
};

afterEach(() => {
  pending.length = 0;
});

describe("the hub's status in the window", () => {
  // covers UX-002
  it("[TC-UX-1374-01] keeps a status event that came while the snapshot was read, over the older snapshot", async () => {
    const status = watched();
    await settled();
    applyStatusFrame(status.client, frame({ _tag: "ThreadRunChanged", run: run(5, "thinking") }));
    applyStatusFrame(status.client, frame({ _tag: "HobPresenceChanged", presence: presence(3, "thinking") }));
    pending[0]?.(snapshot({ runsRevision: 4, runs: [run(4)], presenceRevision: 2, hobs: [presence(2, "idle")] }));
    await settled();
    expect(status.shown()).toEqual({ runs: "thinking", hob: "thinking" });
    status.unsubscribe();
  });

  it("[TC-UX-1374-02] drops what it held on a Ready and reads the snapshot again, since revisions start again", async () => {
    const status = watched();
    await settled();
    pending[0]?.(
      snapshot({ runsRevision: 40, runs: [run(40)], presenceRevision: 40, hobs: [presence(40, "working")] }),
    );
    await settled();
    expect(status.shown()).toEqual({ runs: "working", hob: "working" });

    // A hub that started again counts from 0: its low revisions still win.
    statusReady(status.client);
    expect(status.shown()).toEqual({ runs: null, hob: null });
    await settled();
    applyStatusFrame(status.client, frame({ _tag: "HobPresenceChanged", presence: presence(1, "needs-you") }));
    pending[1]?.(snapshot({ presenceRevision: 0, hobs: [presence(0, "idle")] }));
    await settled();
    expect(status.shown()).toEqual({ runs: null, hob: "needs-you" });
    status.unsubscribe();
  });

  it("reads again a snapshot that was on its way when a Ready came", async () => {
    const status = watched();
    await settled();
    statusReady(status.client);
    await settled();
    // The read from before the Ready answers with the old hub's status, which is not taken.
    pending[0]?.(snapshot({ presenceRevision: 9, hobs: [presence(9, "working")] }));
    await settled();
    expect(status.shown().hob).toBeNull();
    // The read the Ready started, and the stale read made again, answer with the new hub's status.
    for (const read of pending.slice(1)) read(snapshot({ presenceRevision: 1, hobs: [presence(1, "paused")] }));
    await settled();
    expect(status.shown().hob).toBe("paused");
    status.unsubscribe();
  });

  it("takes a hob's removal and an idle run, which shows nothing", async () => {
    const status = watched();
    await settled();
    pending[0]?.(snapshot({ runsRevision: 1, runs: [run(1)], presenceRevision: 1, hobs: [presence(1, "working")] }));
    await settled();
    applyStatusFrame(status.client, frame({ _tag: "ThreadRunChanged", run: run(2, null) }));
    applyStatusFrame(status.client, frame({ _tag: "HobPresenceRemoved", agentId: wren, revision: 2 }));
    expect(status.shown()).toEqual({ runs: null, hob: null });
    status.unsubscribe();
  });

  it("refuses a frame it cannot read", () => {
    expect(() => applyStatusFrame(new QueryClient(), frame({ _tag: "Nonsense" }))).toThrow();
  });
});
