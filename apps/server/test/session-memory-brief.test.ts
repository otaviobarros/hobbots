import { MEMORY_UNAVAILABLE, type PromptRequest } from "@hobbots/agents";
import { MemoryPath, type MemoryScope } from "@hobbots/domain";
import { makeMemoryStoreFake } from "@hobbots/memory/testing";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, isLive, NETTLE, ownedBy, PIP, partyHub, send, treeWhen } from "./party-hub.ts";

// The memory brief (ADR 028) in sessions that work a Task outside any chat: a party member's and a step's.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const lesson = (
  store: ReturnType<typeof makeMemoryStoreFake>["store"],
  scope: MemoryScope,
  text: string,
  path = "notes/lesson.md",
) =>
  Effect.runPromise(
    store.write(
      { _tag: "You" },
      scope,
      { path: MemoryPath.make(path), markdown: `# Lesson\n\n${text}`, tags: [], pinned: false },
      { _tag: "Any" },
    ),
  );

describe("the memory brief outside chats", () => {
  // covers OR-004, CH-001
  it("[TC-OR-561] a member's and a step's fresh sessions start with their own hob's memory brief", async () => {
    const memory = makeMemoryStoreFake();
    await lesson(memory.store, { _tag: "Hob", agentId: PIP }, "Pip runs the fast suite first.");
    await lesson(memory.store, { _tag: "Hob", agentId: FRODO }, "Frodo plans before he delegates.");
    const party = partyHub({ memory: memory.store });
    dispose = party.dispose;
    const { run, requests } = party;
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: ["Review the project", hub("complete_task", { key: "done", summary: "Reviewed" })].join("\n"),
        }),
        hub("plan_steps", {
          key: "plan",
          steps: [
            { brief: ["Draft the notes", hub("complete_task", { key: "noted", summary: "Drafted" })].join("\n") },
          ],
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    await run(treeWhen((each) => ownedBy(each, PIP)?.state === "completed"));
    const opening = (match: (request: PromptRequest) => boolean) =>
      requests.find((request) => request.sessionId === null && match(request));

    // Pip's session as a member of Frodo's Quest: his memory, never Frodo's.
    const member = opening((request) => request.prompt.startsWith("Review the project\nfake:hub complete_task"));
    expect(member?.briefing).toMatch(/^## From your memory/);
    expect(member?.briefing).toContain("Pip runs the fast suite first.");
    expect(member?.briefing).not.toContain("Frodo plans");

    // Frodo's step runs in a fresh session of his own, briefed from his memory.
    const step = opening((request) => request.prompt.startsWith("Draft the notes\n"));
    expect(step?.briefing).toContain("Frodo plans before he delegates.");
    expect(step?.briefing).not.toContain("Pip runs");
  });
  // covers OR-004, CH-001, EX-005
  it("[TC-OR-562] a member's resumed session hears the brief again only when it changed, or after an outage", async () => {
    const memory = makeMemoryStoreFake();
    await lesson(memory.store, { _tag: "Hob", agentId: PIP }, "Pip runs the fast suite first.");
    // Memory is down when Pip's session starts, so it is told only that.
    memory.controls.setDown(true);
    const party = partyHub({ memory: memory.store });
    dispose = party.dispose;
    const { run, requests, gates } = party;
    // Nettle reports each finding only once the test lets her, so each wakes Pip in a turn of its own.
    const opens = new Map<string, () => void>();
    for (const key of ["second", "third", "done"]) {
      const opened = new Promise<void>((resolve) => opens.set(key, resolve));
      gates.set(key, () => opened);
    }
    const finding = (key: string, summary: string) => hub("report_checkpoint", { key, kind: "finding", summary });
    await run(
      send([
        "Review the project",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: [
            "Review the project",
            hub("delegate_task", {
              key: "lint",
              hob: "Nettle",
              brief: [
                "Lint the project",
                finding("first", "core.py has an unused import"),
                finding("second", "app.py has a long line"),
                finding("third", "tests.py has a typo"),
                hub("complete_task", { key: "done", summary: "Three lint findings" }),
              ].join("\n"),
            }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const started = await run(treeWhen((tree) => ownedBy(tree, PIP) !== undefined));
    const pip = ownedBy(started, PIP);
    if (pip === undefined) throw new Error("no Task for Pip");
    // Pip's turns on his Task: each runs in his own runtime folder.
    const pips = () => requests.filter((each) => each.tools?.runtimeFolder.endsWith(`/${PIP}`));
    const idle = () =>
      run(
        treeWhen(
          (tree) =>
            ownedBy(tree, NETTLE) !== undefined &&
            !tree.attempts.some((each) => each.taskId === pip.id && isLive(each.state)),
        ),
      );
    const woken = async (count: number) => {
      await run(treeWhen(() => pips().length >= count + 1));
      await idle();
      return pips()[count] as PromptRequest;
    };

    const first = await woken(0);
    expect(first.sessionId).toBeNull();
    expect(first.briefing).toBe(MEMORY_UNAVAILABLE);

    // Memory is back: the resumed session is told what it missed.
    memory.controls.setDown(false);
    const recovered = await woken(1);
    expect(recovered.sessionId).not.toBeNull();
    expect(recovered.briefing).toContain("Pip runs the fast suite first.");

    // Unchanged: nothing is told again.
    opens.get("second")?.();
    const unchanged = await woken(2);
    expect(unchanged.sessionId).toBe(recovered.sessionId);
    expect(unchanged.briefing).toBeNull();

    // Changed: the new brief is told.
    await lesson(memory.store, { _tag: "Hob", agentId: PIP }, "Pip reads the lint report twice.", "notes/lint.md");
    opens.get("third")?.();
    const changed = await woken(3);
    expect(changed.briefing).toContain("Pip reads the lint report twice.");
    opens.get("done")?.();
  }, 30_000);
});
