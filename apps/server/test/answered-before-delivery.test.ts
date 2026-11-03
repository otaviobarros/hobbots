import type { BackpackItem } from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { Effect, Schedule } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { continuations, FRODO, hub, messagesWhen, ownedBy, partyHub, QUILL, send, treeWhen } from "./party-hub.ts";

// Issue #573, review of #636: wait_for tells a lead to answer a question from an awaited Task in the
// turn it is in. When it does, before its copy of the question was delivered, that copy settles
// with the answer, and no later turn hands the lead the question again.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("answering a question before it is delivered", () => {
  // covers OR-002, OR-003, IN-004
  it("[TC-OR-255] a lead that answers in the turn that waited gets no later turn asking it again", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, answers, gates } = party;

    // Frodo waits only once Quill's question waits in his backpack, undelivered, while his turn runs.
    let copy: BackpackItem | undefined;
    gates.set("wait", () =>
      run(
        Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: FRODO })).pipe(
          Effect.flatMap((open) => {
            copy = open.find((item) => item.kind === "question" && item.state === "pending");
            return copy === undefined ? Effect.fail("not yet" as const) : Effect.void;
          }),
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 1000 }),
        ),
      ),
    );

    await run(
      send([
        "Plan the release",
        hub("delegate_task", {
          key: "copy",
          hob: "Quill",
          brief: [
            "Draft the copy",
            hub("ask", { key: "tone", question: "Playful or formal?" }),
            `fake:then ${hub("complete_task", { key: "copy-done", summary: "Playful copy drafted" })}`,
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
        hub("answer", { key: "reply", question_id: "$tone.question_id", answer: "Playful" }),
        `fake:then ${hub("complete_task", { key: "wrap", summary: "Release planned" })}`,
      ]),
    );

    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    const [question] = done.questions;
    expect(answers.get("wait")).toContain("A question from them waits for you");
    expect(answers.get("reply")).not.toContain("Refused");
    expect(question?.answeredBy).toEqual({ _tag: "Lead", agentId: FRODO });
    expect(ownedBy(done, QUILL)?.result?.summary).toBe("Playful copy drafted");

    // His copy settled with his answer, and the one turn after his carried Quill's result, not the question.
    const settled = await run(Backpack.use((backpack) => backpack.find(copy?.id as BackpackItem["id"])));
    expect(settled).toMatchObject({ state: "resolved", disposition: { _tag: "answered" } });
    const all = await run(messagesWhen((each) => continuations(each).length >= 1));
    const later = continuations(all);
    expect(later).toHaveLength(1);
    expect(later[0]?.content).not.toContain(`question ${question?.id}`);
    expect(later[0]?.content).toContain("Playful copy drafted");
  }, 20_000);
});
