import { afterEach, describe, expect, it, vi } from "vitest";
import { followHub } from "../src/main/hub-events.ts";
import { frameChange } from "../src/main/hub-events-model.ts";
import {
  deviceNotices,
  failedTaskNotices,
  finishedNotices,
  questionNotices,
  requestNotices,
  shareNotices,
} from "../src/main/request-notices.ts";
import {
  deviceNoticeText,
  devicePairings,
  failedNoticeText,
  failedTasks,
  noticeChanges,
  noticeText,
  pendingRequests,
  questionNoticeText,
  waitingQuestions,
} from "../src/main/request-notices-model.ts";
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

const asking = (id: string, state = "pending", minutes = 10) => ({
  request: {
    id,
    code: "482913",
    name: "Safari on iPhone",
    state,
    createdAt: "2026-11-02T10:00:00.000Z",
    expiresAt: new Date(Date.parse("2026-11-02T10:00:00.000Z") + minutes * 60_000).toISOString(),
  },
  fromHub: false,
});

describe("device notifications", () => {
  // covers DP-004
  it("[TC-DP-111] announces a device asking to pair with its code, and closes it once the device was answered", async () => {
    let waiting: Array<unknown> = [];
    const notices: Array<{ title: string; body: string; closed: boolean; click: () => void }> = [];
    const opened: Array<string> = [];
    const { check } = deviceNotices({
      read: async (path) => (path === "/api/pairing/requests" ? waiting : null),
      isFocused: () => false,
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
    });
    await check();
    waiting = [asking("p1"), asking("later", "pending", 24 * 60)];
    await check();
    expect(notices).toEqual([
      expect.objectContaining({
        title: "Safari on iPhone wants to use Hobbots",
        body: "Check that it shows 482 913, then Allow or Deny.",
      }),
    ]);
    waiting = [];
    await check();
    expect(notices[0]?.closed).toBe(true);
    // Clicking one opens the window, where the prompt shows.
    notices[0]?.click();
    expect(opened).toEqual(["p1"]);
  });

  it("reads only devices still prompted, and keeps a long name within what macOS shows", () => {
    expect(devicePairings([asking("a"), asking("b", "denied"), asking("c", "pending", 60), { request: null }])).toEqual(
      [{ id: "a", name: "Safari on iPhone", code: "482913", expiresAt: "2026-11-02T10:10:00.000Z" }],
    );
    expect(devicePairings({ error: "nope" })).toBeNull();
    const { title, body } = deviceNoticeText({
      id: "a",
      name: "é".repeat(300),
      code: "482913",
      expiresAt: "2026-11-02T10:10:00.000Z",
    });
    expect(new TextEncoder().encode(title + body).length).toBeLessThanOrEqual(256);
    expect(title).toContain("…");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // covers DP-004
  it("[TC-DP-119] closes a device's notification once its request runs out, with no event to say so", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-02T10:00:00.000Z") });
    const all = [asking("p1")];
    // The hub lists only requests that have not run out.
    const waiting = () => all.filter((item) => Date.parse(item.request.expiresAt) > Date.now());
    const notices: Array<{ closed: boolean }> = [];
    let reads = 0;
    const { check } = deviceNotices({
      read: async () => {
        reads += 1;
        return reads === 1 ? [] : waiting();
      },
      isFocused: () => false,
      notify: () => {
        const notice = { closed: false };
        notices.push(notice);
        return {
          close: () => {
            notice.closed = true;
          },
        };
      },
      open: () => undefined,
    });
    await check();
    await check();
    expect(notices).toEqual([{ closed: false }]);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000);
    expect(notices).toEqual([{ closed: true }]);
  });
});

/** A hub that answers `lists` by path, and a system that records its notifications and what they open. */
const questSetup = () => {
  const hub = { lists: {} as Record<string, unknown>, focused: false };
  const notices: Array<{ title: string; body: string; closed: boolean; click: () => void }> = [];
  const tasks: Array<unknown> = [];
  const options = {
    read: async (path: string) =>
      path === "/api/agents"
        ? [
            { id: "aldric", name: "Aldric" },
            { id: "ada", name: "Ada" },
          ]
        : (hub.lists[path] ?? null),
    isFocused: () => hub.focused,
    notify: ({ title, body }: { title: string; body: string }, onClick: () => void) => {
      const notice = { title, body, closed: false, click: onClick };
      notices.push(notice);
      return {
        close: () => {
          notice.closed = true;
        },
      };
    },
    open: () => {},
    openTask: (link: unknown) => void tasks.push(link),
    retry: { firstRetryMs: 1, maxRetryMs: 4 },
  };
  return { hub, notices, tasks, options };
};

const asked = (id: string) => ({
  question: { id, askerId: "ada", chain: ["aldric"], text: "Which store should the campaign use?" },
  task: { id: "build", threadId: "t1", rootId: "campaign" },
});

const failedTask = (id: string) => ({
  task: { id, ownerId: "ada", threadId: "t1", brief: "Build the campaign\nin the shop's own store" },
  leadId: "aldric",
});

describe("Quest notifications", () => {
  // covers IN-007, UX-001
  it("[TC-IN-540] announces a question that reached you, opens the asking hob's lane in the lead's chat, and closes once answered", async () => {
    const { hub, notices, tasks, options } = questSetup();
    const { check } = questionNotices(options);
    hub.lists["/api/questions"] = { cursor: "e.1", questions: [] };
    await check();
    hub.lists["/api/questions"] = { cursor: "e.2", questions: [asked("q1")] };
    await check();
    expect(notices).toEqual([
      expect.objectContaining({ title: "Ada asks you", body: "Which store should the campaign use?" }),
    ]);
    hub.lists["/api/questions"] = { cursor: "e.3", questions: [] };
    await check();
    expect(notices[0]?.closed).toBe(true);
    notices[0]?.click();
    expect(tasks).toEqual([{ hobId: "aldric", threadId: "t1", taskId: "build" }]);
  });

  // covers IN-007, OR-006
  it("[TC-IN-541] announces a member's failed Task with its brief, and closes it once retried, reassigned or its work ended", async () => {
    const { hub, notices, tasks, options } = questSetup();
    const { check } = failedTaskNotices(options);
    hub.lists["/api/failed-tasks"] = { cursor: "e.1", tasks: [] };
    await check();
    hub.lists["/api/failed-tasks"] = { cursor: "e.2", tasks: [failedTask("build")] };
    await check();
    expect(notices).toEqual([expect.objectContaining({ title: "Ada's task failed", body: "Build the campaign" })]);
    hub.lists["/api/failed-tasks"] = { cursor: "e.3", tasks: [] };
    await check();
    expect(notices[0]?.closed).toBe(true);
    notices[0]?.click();
    expect(tasks).toEqual([{ hobId: "aldric", threadId: "t1", taskId: "build" }]);
  });

  // covers IN-005, UX-001
  it("[TC-IN-542] announces a top Quest that finished once, and nothing for a nested one, one that failed, or while a window is focused", async () => {
    const { hub, notices, tasks, options } = questSetup();
    const stream = fakeEventStream();
    const { finished } = finishedNotices(options);
    const quest = (id: string, state: string, parentQuestId: string | null = null) => ({
      quest: {
        id,
        taskId: `task-${id}`,
        leadId: "aldric",
        threadId: "t1",
        goal: "Spring launch\nwith a party",
        state,
        parentQuestId,
      },
    });
    const following = followHub({
      url: () => "http://127.0.0.1:4317/api/events",
      canConnect: () => true,
      onConnected: () => {},
      onChange: (change) => void (change._tag === "QuestFinished" && finished(change.quest)),
      onLost: () => {},
      fetch: stream.fetch,
    });
    try {
      await expect.poll(() => stream.connections.length).toBe(1);
      stream.last().write(readyFrame);
      stream
        .last()
        .write(entryFrame("QuestCompleted", { _tag: "QuestCompleted", ...quest("nested", "completed", "q0") }, 1));
      stream.last().write(entryFrame("QuestCompleted", { _tag: "QuestCompleted", ...quest("failed", "failed") }, 2));
      stream.last().write(entryFrame("QuestCompleted", { _tag: "QuestCompleted", ...quest("q1", "completed") }, 3));
      await expect.poll(() => notices.length).toBe(1);
      expect(notices[0]).toMatchObject({ title: "Spring launch is done", body: "Open Aldric's chat for the summary." });
      notices[0]?.click();
      expect(tasks).toEqual([{ hobId: "aldric", threadId: "t1", taskId: "task-q1" }]);
      await finished({ id: "q1", goal: "Spring launch", leadId: "aldric", link: null });
      hub.focused = true;
      await finished({ id: "q2", goal: "Summer launch", leadId: "aldric", link: null });
      expect(notices).toHaveLength(1);
    } finally {
      await following.stop();
    }
  });

  it("reads questions and failed Tasks from the hub's answers, and keeps a long question within what macOS shows", () => {
    expect(waitingQuestions({ questions: [asked("q1"), { question: { id: 3 } }] })).toEqual([
      {
        id: "q1",
        askerId: "ada",
        text: "Which store should the campaign use?",
        link: { hobId: "aldric", threadId: "t1", taskId: "build" },
      },
    ]);
    expect(waitingQuestions([])).toBeNull();
    expect(
      failedTasks({ tasks: [{ task: { id: "x", ownerId: "ada", threadId: null, brief: "" }, leadId: null }] }),
    ).toEqual([{ id: "x", ownerId: "ada", brief: "", link: null }]);
    const long = questionNoticeText({ id: "q", askerId: "ada", text: "é".repeat(400), link: null }, "Ada");
    expect(new TextEncoder().encode(long.title + long.body).length).toBeLessThanOrEqual(240);
    expect(failedNoticeText({ id: "x", ownerId: "ada", brief: "Build", link: null }, undefined).title).toBe(
      "A hob's task failed",
    );
  });
});

const sharing = (id: string, state: string, scope: unknown = { _tag: "Project", identity: "github.com/me/site" }) => ({
  id,
  agentId: "ada",
  scope,
  state,
});

describe("memory share notifications", () => {
  // covers ADR 028 (Sharing), #960
  it("[TC-IN-560] announces a hob asking to share what it learned, opens it in the Inbox, and closes once decided", async () => {
    const { hub, notices, options } = questSetup();
    const opened: Array<string> = [];
    const { check } = shareNotices({ ...options, open: (id) => void opened.push(id) });
    hub.lists["/api/memory/shares"] = { shares: [] };
    await check();
    hub.lists["/api/memory/shares"] = {
      shares: [sharing("s1", "waiting"), sharing("s2", "waiting", { _tag: "Everyone" }), sharing("s3", "shared")],
    };
    await check();
    expect(notices).toEqual([
      expect.objectContaining({ title: "Ada wants to share what it learned", body: "With the site project" }),
      expect.objectContaining({ title: "Ada wants to share what it learned", body: "With every hob, in About you" }),
    ]);
    notices[1]?.click();
    expect(opened).toEqual(["memory:s2"]);
    hub.lists["/api/memory/shares"] = {
      shares: [sharing("s1", "kept"), sharing("s2", "waiting", { _tag: "Everyone" })],
    };
    await check();
    expect(notices.map((notice) => notice.closed)).toEqual([true, false]);
  });

  it("reads again on a share's journal entries", () => {
    for (const type of ["MemoryShareRequested", "MemoryShareChanged"]) {
      expect(frameChange({ event: "message", data: JSON.stringify({ type }) })).toEqual({ _tag: "Shares" });
    }
  });
});
