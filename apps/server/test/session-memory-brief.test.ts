import type { PromptRequest } from "@hobbots/agents";
import { MemoryPath, type MemoryScope } from "@hobbots/domain";
import { makeMemoryStoreFake } from "@hobbots/memory/testing";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, ownedBy, PIP, partyHub, send, treeWhen } from "./party-hub.ts";

// The memory brief (ADR 028) in sessions that work a Task outside any chat: a party member's and a step's.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const lesson = (store: ReturnType<typeof makeMemoryStoreFake>["store"], scope: MemoryScope, text: string) =>
  Effect.runPromise(
    store.write(
      { _tag: "You" },
      scope,
      { path: MemoryPath.make("notes/lesson.md"), markdown: `# Lesson\n\n${text}`, tags: [], pinned: false },
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
});
