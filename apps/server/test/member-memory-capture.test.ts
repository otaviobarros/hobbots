import { HobbotsRepository, MemoryCapture, MemoryStore } from "@hobbots/agents";
import { type AgentId, type MemoryCaptureItem, type TaskTree, Thread } from "@hobbots/domain";
import { makeMemoryStoreFake } from "@hobbots/memory/testing";
import { MemoryCaptureLive } from "@hobbots/persistence";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  continuations,
  FRODO,
  hub,
  messagesWhen,
  NETTLE,
  ownedBy,
  PIP,
  partyHub,
  QUILL,
  send,
  threadId,
  treeWhen,
} from "./party-hub.ts";

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

/** The capture worker over the party hub's own journal, as the hub runs it while memory is on. */
const captureOver = (party: ReturnType<typeof partyHub>, memory: ReturnType<typeof makeMemoryStoreFake>) => () =>
  party.run(
    MemoryCapture.use((capture) => capture.runOnce).pipe(
      Effect.provide(
        MemoryCapture.make.pipe(
          Layer.provide(Layer.merge(MemoryCaptureLive, Layer.succeed(MemoryStore, memory.store))),
        ),
      ),
    ),
  );

describe("memory capture of a party's work", () => {
  // covers OR-003, ADR 028 (Capture and summaries), #1028
  it("[TC-OR-600] the answer that wakes a member reaches its memory, and its result reaches its lead's thread", async () => {
    const memory = makeMemoryStoreFake();
    const party = partyHub({ memory: memory.store, activity: true });
    dispose = party.dispose;
    const captureRound = captureOver(party, memory);
    expect(await captureRound()).toBe(true);
    await party.run(
      send([
        "Plan the release",
        hub("delegate_task", {
          key: "copy",
          hob: "Quill",
          brief: [
            "Draft the copy",
            hub("ask", { key: "tone", question: "Playful or formal?" }),
            `fake:then ${hub("complete_task", { delivered: true, key: "copy-done", summary: "Playful copy drafted" })}`,
          ].join("\n"),
        }),
        // Quill's question wakes Frodo, who answers it; Quill's result wakes him again.
        `fake:then ${hub("answer", { key: "reply", question_id: "$tone.question_id", answer: "Playful" })}`,
      ]),
    );
    const tree = await party.run(treeWhen((each) => ownedBy(each, QUILL)?.state === "completed"));
    await party.run(
      messagesWhen((all) => continuations(all).some((reply) => reply.content.includes("Playful copy drafted"))),
    );
    expect(await captureRound()).toBe(true);

    // Quill's session has the answer that woke it, once, before the reply of the turn it woke.
    const quill = memory.controls.captured({ _tag: "Hob", agentId: QUILL }, attemptOf(tree, QUILL));
    const answers = quill.filter((item) => item.kind === "message" && item.text.startsWith('Answer: "Playful"'));
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toContain('"Playful or formal?"');
    expect(quill.indexOf(answers[0] as MemoryCaptureItem)).toBeLessThan(
      quill.findLastIndex((item) => item.kind === "reply"),
    );
    expect(quill.some((item) => item.text.includes("Answer it with answer"))).toBe(false);

    // Frodo's thread has Quill's result, which woke him, and Quill's answer stays in Quill's memory.
    const frodo = memory.controls.captured({ _tag: "Hob", agentId: FRODO }, threadId);
    expect(frodo.some((item) => item.kind === "message" && item.text.includes("Playful copy drafted"))).toBe(true);
    expect(frodo.some((item) => item.text.startsWith("Answer:"))).toBe(false);
  }, 30_000);

  // covers OR-004, ADR 028 (Capture and summaries)
  it("[TC-OR-598] a member's and a sub-Quest member's Attempts reach their own memory, never their lead's", async () => {
    const memory = makeMemoryStoreFake();
    const party = partyHub({ memory: memory.store, activity: true });
    dispose = party.dispose;
    const { run } = party;
    const captureRound = captureOver(party, memory);
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
              brief: [
                "Lint the project",
                hub("complete_task", { delivered: true, key: "linted", summary: "Lint is clean" }),
              ].join("\n"),
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

  // covers ADR 037 (A camp is a thread with a kind), ADR 028 (Capture and summaries)
  it("[TC-GEN-1377-04] nothing of a private camp reaches memory, its Quest's members' work included", async () => {
    const memory = makeMemoryStoreFake();
    const party = partyHub({ memory: memory.store, activity: true });
    dispose = party.dispose;
    const captureRound = captureOver(party, memory);
    expect(await captureRound()).toBe(true);
    await party.run(
      HobbotsRepository.use((repo) =>
        Effect.flatMap(repo.findThread(threadId), (thread) =>
          repo.upsertThread(new Thread({ ...Option.getOrThrow(thread), kind: "camp", private: true })),
        ),
      ),
    );
    await party.run(
      send([
        "Plan the surprise party",
        hub("delegate_task", {
          key: "venue",
          hob: "Quill",
          brief: [
            "Book the venue",
            hub("complete_task", { delivered: true, key: "booked", summary: "The garden is booked" }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$venue.task_id"] }),
      ]),
    );
    const tree = await party.run(treeWhen((each) => ownedBy(each, QUILL)?.state === "completed"));
    await party.run(
      messagesWhen((all) => continuations(all).some((reply) => reply.content.includes("The garden is booked"))),
    );
    expect(await captureRound()).toBe(true);

    expect(memory.controls.captured({ _tag: "Hob", agentId: FRODO }, threadId)).toEqual([]);
    expect(memory.controls.captured({ _tag: "Hob", agentId: QUILL }, attemptOf(tree, QUILL))).toEqual([]);
  }, 30_000);
});
