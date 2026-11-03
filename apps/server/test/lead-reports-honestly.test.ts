import { QuestionService, TaskRepository } from "@hobbots/agents";
import { NoteId } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { FRODO, hub, messagesWhen, ownedBy, partyHub, ROOK, send, treeWhen } from "./party-hub.ts";

// Issue #569: your note on Rook's Task reached Frodo while Rook's question waited for you, and Frodo
// replied that your answer was on its way, with no tool call and no way to pass it on. A lead's turn
// now lists the questions only you can answer, says a note is not an answer, and asks the lead to
// report only what its Task tools did.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("a lead reports only what happened", () => {
  // covers OR-002, IN-004, UX-002
  it("[TC-OR-252] a note on a Task whose question waits for you starts a lead turn told the question is still open, and the question stays open", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, reactions } = party;
    // Frodo passes Rook's question up to you as soon as it reaches him.
    reactions.push({
      on: "asks, as question",
      lines: [hub("escalate", { key: "up", question_id: "$theme.question_id" })],
    });
    await run(
      send([
        "Build the frontend",
        hub("delegate_task", {
          key: "frontend",
          hob: "Rook",
          brief: ["Build the frontend", hub("ask", { key: "theme", question: "Light or dark theme?" })].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$frontend.task_id"] }),
      ]),
    );
    const escalated = await run(treeWhen((tree) => tree.questions[0]?.recipientId === null));
    const rook = ownedBy(escalated, ROOK);
    const question = escalated.questions[0];
    if (rook === undefined || question === undefined) throw new Error("no question for you");
    await run(messagesWhen(() => true));
    const before = requests.length;

    // You leave a note on Rook's Task instead of answering in the Inbox.
    await run(QuestionService.use((questions) => questions.leaveNote(rook.id, NoteId.make("dark"), "dark")));
    await run(messagesWhen(() => requests.slice(before).some((each) => each.prompt.includes("The user left a note"))));
    const turn = requests.slice(before).find((each) => each.prompt.includes("The user left a note"));
    expect(turn?.prompt).toContain(`about Task ${rook.id}: dark`);
    expect(turn?.briefing).toContain("Questions only the user can answer, waiting in the user's Inbox:");
    expect(turn?.briefing).toContain(
      `Question ${question.id} from hob ${ROOK} about Task ${rook.id}: "Light or dark theme?"`,
    );
    expect(turn?.briefing).toContain("a note or message from the user is not an answer to them");
    expect(turn?.briefing).toContain("Tell the user only what your Task tools did in this turn");

    // The question still waits for you, once, and nothing answered it.
    const waiting = await run(TaskRepository.use((tasks) => tasks.listWaitingQuestions));
    expect(waiting.map((each) => each.question.id)).toEqual([question.id]);
    const after = await run(treeWhen(() => true));
    expect(after.questions).toEqual([expect.objectContaining({ id: question.id, state: "open", answer: null })]);
    expect(after.tasks[0]?.ownerId).toBe(FRODO);
  }, 30_000);

  // covers OR-002, UX-002
  it("[TC-OR-253] a lead's turn always asks it to report only what its tools did, and lists no question once you answered it", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, reactions } = party;
    reactions.push({
      on: "asks, as question",
      lines: [hub("escalate", { key: "up", question_id: "$theme.question_id" })],
    });
    await run(
      send([
        "Build the frontend",
        hub("delegate_task", {
          key: "frontend",
          hob: "Rook",
          brief: ["Build the frontend", hub("ask", { key: "theme", question: "Light or dark theme?" })].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$frontend.task_id"] }),
      ]),
    );
    const escalated = await run(treeWhen((tree) => tree.questions[0]?.recipientId === null));
    const question = escalated.questions[0];
    if (question === undefined) throw new Error("no question for you");
    await run(messagesWhen(() => true));
    await run(QuestionService.use((questions) => questions.answer(question.id, "Dark")));
    await run(treeWhen((tree) => tree.questions[0]?.state === "answered"));
    const before = requests.length;
    await run(send(["How is it going?"]));
    await run(messagesWhen(() => requests.slice(before).some((each) => each.prompt.includes("How is it going?"))));
    const next = requests.slice(before).find((each) => each.prompt.includes("How is it going?"));
    expect(next?.briefing).toContain("Tell the user only what your Task tools did in this turn");
    expect(next?.briefing).not.toContain("Questions only the user can answer");
  }, 30_000);
});

describe("a lead hears the answer to a question it passed up", () => {
  // covers OR-002, IN-004
  it("[TC-OR-470] once you answer a question the lead passed up, each later turn of the lead lists it with its answer, and read_tasks shows it answered", async () => {
    const party = partyHub();
    dispose = party.dispose;
    const { run, requests, reactions, answers } = party;
    reactions.push({
      on: "asks, as question",
      lines: [hub("escalate", { key: "up", question_id: "$theme.question_id" })],
    });
    await run(
      send([
        "Build the frontend",
        hub("delegate_task", {
          key: "frontend",
          hob: "Rook",
          brief: ["Build the frontend", hub("ask", { key: "theme", question: "Light or dark theme?" })].join("\n"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$frontend.task_id"] }),
      ]),
    );
    const escalated = await run(treeWhen((tree) => tree.questions[0]?.recipientId === null));
    const question = escalated.questions[0];
    if (question === undefined) throw new Error("no question for you");
    await run(messagesWhen(() => true));

    await run(QuestionService.use((questions) => questions.answer(question.id, "Dark")));
    await run(treeWhen((tree) => tree.questions[0]?.state === "answered"));
    const before = requests.length;
    await run(send(["How is it going?", hub("read_tasks", { key: "read" })]));
    await run(messagesWhen(() => requests.slice(before).some((each) => each.prompt.includes("How is it going?"))));
    const next = requests.slice(before).find((each) => each.prompt.includes("How is it going?"));
    expect(next?.briefing).toContain("Questions you passed up that are answered, latest last");
    expect(next?.briefing).toContain(
      `Question ${question.id} from hob ${ROOK} about Task ${question.taskId}: "Light or dark theme?" Answered by the user: "Dark"`,
    );
    expect(next?.briefing).not.toContain("Questions only the user can answer");

    // What Frodo reads back is the question as the hub records it, with its answer.
    const read = answers.get("read") ?? "";
    expect(read).toContain('"state":"answered"');
    expect(read).toContain('"answer":"Dark"');
    expect(read).toContain('"answered_by":"the user"');
  }, 30_000);
});
