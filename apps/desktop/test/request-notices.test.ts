import { describe, expect, it } from "vitest";
import { followHub } from "../src/main/hub-events.ts";
import { requestNotices } from "../src/main/request-notices.ts";
import { noticeChanges, noticeText, pendingRequests } from "../src/main/request-notices-model.ts";
import { entryFrame, fakeEventStream, readyFrame } from "./fake-event-stream.ts";

const approval = (id: string, state: string, command = "git push origin feature") => ({
  id,
  agentId: "pip",
  state,
  label: "Push",
  arguments: { command },
});

/** A hub whose Inbox answers what `inbox` holds, and a system that records its notifications. */
const setup = () => {
  // `answers` are given to the next Inbox reads, one each, before `inbox`.
  const hub = {
    inbox: [] as Array<unknown> | null,
    answers: [] as Array<Array<unknown> | null>,
    focused: false,
    reads: 0,
  };
  const notices: Array<{ title: string; body: string; closed: boolean; click: () => void }> = [];
  const opened: Array<string> = [];
  const { check } = requestNotices({
    read: async (path) => {
      if (path === "/api/agents") return [{ id: "pip", name: "Pip" }];
      hub.reads += 1;
      return hub.answers.length > 0 ? hub.answers.shift() : hub.inbox;
    },
    isFocused: () => hub.focused,
    notify: ({ title, body }, onClick) => {
      const notice = { title, body, closed: false, click: onClick };
      notices.push(notice);
      return {
        close: () => {
          notice.closed = true;
        },
      };
    },
    open: (id) => void opened.push(id),
    retry: { firstRetryMs: 1, maxRetryMs: 4 },
  });
  return { hub, notices, opened, check };
};

describe("request notifications", () => {
  // covers UX-001, UX-005
  it("[TC-IN-012] announces a new request with no window open, and clicking it opens the request", async () => {
    const { hub, notices, opened, check } = setup();
    await check();
    hub.inbox = [approval("a", "pending")];
    await check();
    expect(notices).toEqual([
      expect.objectContaining({ title: "Pip asks permission", body: "git push origin feature" }),
    ]);
    notices[0]?.click();
    expect(opened).toEqual(["a"]);
    await check();
    expect(notices).toHaveLength(1);
  });

  // covers UX-001, UX-005
  it("[TC-IN-013] closes a notification once its request no longer waits, however the change was missed", async () => {
    const { hub, notices, check } = setup();
    hub.inbox = [];
    await check();
    hub.inbox = [approval("a", "pending"), approval("b", "pending")];
    await check();
    // Decided elsewhere, or gone from the Inbox's window, while no event reached the app.
    hub.inbox = [approval("a", "approved")];
    await check();
    expect(notices.map((notice) => notice.closed)).toEqual([true, true]);
  });

  // covers UX-001
  it("[TC-IN-015] keeps what is shown while the hub does not answer", async () => {
    const { hub, notices, check } = setup();
    hub.inbox = [];
    await check();
    hub.inbox = [approval("a", "pending")];
    await check();
    hub.inbox = null;
    const reading = check();
    await expect.poll(() => hub.reads).toBeGreaterThan(5);
    expect(notices[0]?.closed).toBe(false);
    hub.inbox = [approval("a", "pending")];
    await reading;
    expect(notices[0]?.closed).toBe(false);
  });

  // covers UX-001
  it("[TC-IN-016] learns what waits once the event stream connects, then announces what a request event brings", async () => {
    const { hub, notices, check } = setup();
    const stream = fakeEventStream();
    hub.inbox = [approval("a", "pending")];
    const following = followHub({
      url: () => "http://127.0.0.1:4317/api/events",
      canConnect: () => true,
      onConnected: () => void check(),
      onChange: (change) => void (change._tag === "Approvals" && check()),
      onLost: () => {},
      fetch: stream.fetch,
    });
    try {
      await expect.poll(() => stream.connections.length).toBe(1);
      stream.last().write(readyFrame);
      await expect.poll(() => hub.reads).toBe(1);
      hub.inbox = [approval("a", "pending"), approval("b", "pending", "git push origin main")];
      stream.last().write(entryFrame("ApprovalRequested", { _tag: "ApprovalRequested" }));
      await expect.poll(() => notices.map((notice) => notice.body)).toEqual(["git push origin main"]);
    } finally {
      await following.stop();
    }
  });

  // covers UX-001
  it("[TC-IN-019] reads the Inbox again until a read answers, however long that takes, since no later event may come", async () => {
    const { hub, notices, check } = setup();
    hub.inbox = [];
    await check();
    // The request event arrives, and the hub answers only after more failed reads than the first
    // version of this retry allowed.
    hub.answers = Array.from({ length: 8 }, () => null);
    hub.inbox = [approval("a", "pending")];
    await check();
    expect(hub.reads).toBe(10);
    expect(notices.map((notice) => notice.body)).toEqual(["git push origin feature"]);
  });

  it("checks again after a check asked for while one was under way", async () => {
    const { hub, notices, check } = setup();
    hub.inbox = [];
    await check();
    const first = check();
    hub.inbox = [approval("a", "pending")];
    await Promise.all([first, check()]);
    expect(notices).toHaveLength(1);
  });

  it("announces nothing on the first read, nor while a Hobbots window is focused", async () => {
    const { hub, notices, check } = setup();
    hub.inbox = [approval("a", "pending")];
    await check();
    hub.focused = true;
    hub.inbox = [approval("a", "pending"), approval("b", "pending")];
    await check();
    hub.focused = false;
    await check();
    expect(notices).toEqual([]);
  });
});

describe("the request notification model", () => {
  it("reads only pending requests, with their exact action", () => {
    expect(pendingRequests([approval("a", "pending"), approval("b", "denied"), { id: 3 }])).toEqual([
      { id: "a", agentId: "pip", action: "git push origin feature" },
    ]);
    expect(pendingRequests([{ ...approval("a", "pending"), arguments: {} }])?.[0]?.action).toBe("Push");
    expect(pendingRequests({ error: "nope" })).toBeNull();
  });

  it("learns what waits on the first read without announcing it", () => {
    const pending = [{ id: "a", agentId: "pip", action: "x" }];
    expect(noticeChanges({ known: undefined, shown: new Set() }, pending, false)).toEqual({
      show: [],
      close: [],
      known: new Set(["a"]),
    });
  });

  it("keeps a notification within the 256 bytes macOS shows, whatever the characters", () => {
    const { title, body } = noticeText({ id: "a", agentId: "pip", action: `echo ${"é".repeat(400)}` }, "Pip");
    expect(new TextEncoder().encode(title + body).length).toBeLessThanOrEqual(256);
    expect(body.endsWith("…")).toBe(true);
  });
});
