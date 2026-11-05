import { QuestionService } from "@hobbots/agents";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, ownedBy, partyHub, QUILL, send, treeWhen } from "./party-hub.ts";

// Issue #740, review of #936: a member asks with choices through its tools, its lead reads them and
// passes the question up through its tools, you pick one the way the card does, and the member's
// own next turn is told which choice you picked. The fake runtime plays every hob.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const PLAYFUL = { label: "Playful", consequence: "Puns welcome" };
const FORMAL = { label: "Formal", consequence: "No jokes" };

describe("a question with choices, through the tools", () => {
  // covers OR-003, OR-004, IN-004
  it("[TC-OR-561] reaches the lead with its choices, climbs to you, and tells the member which one you picked", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, answers, requests, reactions } = party;

    // Frodo passes the question up once he reads its choices, and Quill finishes once your pick reaches him.
    reactions.push(
      {
        on: '"Which tone?" Choices: 1. Playful: Puns welcome; 2. Formal (recommended): No jokes',
        lines: [hub("escalate", { key: "up", question_id: "$tone.question_id" })],
      },
      {
        on: 'was answered by the user: "Formal" (choice 2 of 2)',
        lines: [hub("complete_task", { key: "copy-done", summary: "Formal copy drafted" })],
      },
    );
    await run(
      send([
        "Plan the release",
        hub("delegate_task", {
          key: "copy",
          hob: "Quill",
          brief: [
            "Draft the copy",
            hub("ask", { key: "tone", question: "Which tone?", options: [PLAYFUL, FORMAL], recommended: 2 }),
          ].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
      ]),
    );

    // The question keeps its choices as it climbs to you.
    const asked = await run(
      treeWhen((tree) => tree.questions.some((each) => each.recipientId === null && each.state === "open")),
    );
    const question = asked.questions[0];
    if (question === undefined) throw new Error("Quill asked nothing");
    expect(answers.get("tone")).not.toContain("Refused");
    expect(answers.get("up")).toContain("Passed the question to the user");
    expect(question).toMatchObject({ options: [PLAYFUL, FORMAL], recommended: 1, chain: [FRODO], picked: null });

    // You pick a choice as its button does, sending its label; any case names it.
    const answered = await run(QuestionService.use((questions) => questions.answer(question.id, "formal", "chat")));
    expect(answered).toMatchObject({ state: "answered", answer: "Formal", picked: 1, answeredVia: "chat" });

    // Quill's own next turn hears which choice you picked, and finishes with it.
    const done = await run(treeWhen((tree) => ownedBy(tree, QUILL)?.state === "completed"));
    expect(ownedBy(done, QUILL)?.result?.summary).toBe("Formal copy drafted");
    const told = requests.filter((request) => request.prompt.includes(`Your question ${question.id} was answered`));
    expect(told).toHaveLength(1);
    expect(told[0]?.prompt).toContain(
      "Your question " + question.id + ' was answered by the user: "Formal" (choice 2 of 2)',
    );
  }, 30_000);
});
