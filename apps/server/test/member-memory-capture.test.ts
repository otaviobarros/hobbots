import { MemoryCapture, MemoryStore } from "@hobbots/agents";
import type { AgentId, MemoryCaptureItem, TaskTree } from "@hobbots/domain";
import { makeMemoryStoreFake } from "@hobbots/memory/testing";
import { MemoryCaptureLive } from "@hobbots/persistence";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, NETTLE, ownedBy, PIP, partyHub, send, threadId, treeWhen } from "./party-hub.ts";

// Memory capture of a party's work outside any chat (ADR 028, #1012): each member keeps what it did
// on its Task in its own memory, a sub-Quest's member included, through the hub's own journal.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/** The Attempt a hob ran on its Task in `tree`. */
const attemptOf = (tree: TaskTree, agentId: AgentId) => {
  const attempt = tree.attempts.find((each) => each.agentId === agentId && each.taskId === ownedBy(tree, agentId)?.id);
  if (attempt === undefined) throw new Error(`no Attempt for ${agentId}`);
  return attempt.id;
};

const kinds = (items: ReadonlyArray<MemoryCaptureItem>) => items.map((item) => item.kind);

describe("memory capture of a party's work", () => {
  // covers OR-004, ADR 028 (Capture and summaries)
  it("[TC-OR-598] a member's and a sub-Quest member's Attempts reach their own memory, never their lead's", async () => {
    const memory = makeMemoryStoreFake();
    const party = partyHub({ memory: memory.store, activity: true });
    dispose = party.dispose;
    const { run } = party;
    // The capture worker over the hub's own journal, as the hub runs it while memory is on.
    const captureRound = () =>
      run(
        MemoryCapture.use((capture) => capture.runOnce).pipe(
          Effect.provide(
            MemoryCapture.make.pipe(
              Layer.provide(Layer.merge(MemoryCaptureLive, Layer.succeed(MemoryStore, memory.store))),
            ),
          ),
        ),
      );
    // Memory is on from the start: the worker holds the journal from its head.
    expect(await captureRound()).toBe(true);
    await run(
      send([
        "Ship the release",
        hub("delegate_task", {
          key: "review",
          hob: "Pip",
          brief: [
            "Review the release",
            hub("delegate_task", {
              key: "lint",
              hob: "Nettle",
              brief: ["Lint the project", hub("complete_task", { key: "linted", summary: "Lint is clean" })].join("\n"),
            }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
      ]),
    );
    const tree = await run(treeWhen((each) => ownedBy(each, PIP)?.state === "completed"));
    const pips = attemptOf(tree, PIP);
    const nettles = attemptOf(tree, NETTLE);

    const caught = await captureRound();
    expect(caught).toBe(true);

    // Pip, Frodo's member, keeps his goal, the delegation he made and his replies.
    const pip = memory.controls.captured({ _tag: "Hob", agentId: PIP }, pips);
    expect(kinds(pip).slice(0, 2)).toEqual(["start", "message"]);
    expect(pip[1]?.text).toContain("Review the release");
    expect(pip.some((item) => item.kind === "tool" && item.text.includes("Delegating a Task"))).toBe(true);
    expect(pip.some((item) => item.kind === "reply")).toBe(true);
    expect(new Set(pip.map((item) => item.key)).size).toBe(pip.length);

    // Nettle, the member of Pip's own Quest, keeps hers, in her memory alone.
    const nettle = memory.controls.captured({ _tag: "Hob", agentId: NETTLE }, nettles);
    expect(nettle[1]?.text).toContain("Lint the project");
    expect(kinds(nettle)).toContain("tool");
    expect(memory.controls.captured({ _tag: "Hob", agentId: PIP }, nettles)).toEqual([]);

    // Frodo's memory has his thread, and none of his members' work.
    expect(memory.controls.captured({ _tag: "Hob", agentId: FRODO }, threadId).length).toBeGreaterThan(0);
    for (const attempt of [pips, nettles]) {
      expect(memory.controls.captured({ _tag: "Hob", agentId: FRODO }, attempt)).toEqual([]);
    }
  }, 30_000);
});
