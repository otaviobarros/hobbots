import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalService, QuestionService } from "@hobbots/agents";
import type { RuntimeKind } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { firstPending, hub, partyHub, send, treeWhen } from "./party-hub.ts";

// Issue #1215: you asked for a summary at a path its member could not write. The member asked its
// lead where to save it instead, the lead answered itself ("save it in the source folder") and
// completed the Quest with delivered: true, and the Quest read done with a file where you never
// agreed. complete_task on a Quest's top Task now holds the lead to the files you named: each must
// be there, unless the work took it away, as a rename or a deletion does, or you answered a question
// that named it. The hub checks the call, so it holds for every runtime.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

const file = (value: string) => ({ kind: "file", label: "skills-check.html", value });

/**
 * Frodo hands Rook the summary and waits, then wraps up the Quest with `wrapUp` in the turn Rook's
 * result starts: his next one, or, with `turns` 2, the one after it, when Rook's question comes first.
 */
const quest = (request: string, rook: ReadonlyArray<string>, wrapUp: object, turns: 1 | 2 = 1) =>
  send([
    request,
    hub("delegate_task", { key: "summary", hob: "Rook", brief: ["Write the summary", ...rook].join("\n") }),
    hub("wait_for", { key: "wait", tasks: ["$summary.task_id"] }),
    `${"fake:then ".repeat(turns)}${hub("complete_task", wrapUp)}`,
  ]);

/** Rook asks `question`, then completes once it hears back. */
const asking = (question: string) => [
  hub("ask", { key: "where", question }),
  `fake:then ${hub("complete_task", { key: "rook", summary: "Saved in the source folder" })}`,
];

/** Rook asks where to save the page it could not write at `wanted`, naming it. */
const askedWhere = (wanted: string) => asking(`I can't write ${wanted} there. Where should I save it instead?`);

/** Once Frodo has passed Rook's question up to you, you answer it with `answer`. */
const escalatedAndAnswered = async (party: ReturnType<typeof partyHub>, answer: string) => {
  const { run } = party;
  const escalated = await run(treeWhen((tree) => tree.questions[0]?.recipientId === null));
  const question = escalated.questions[0];
  if (question === undefined) throw new Error("no question for you");
  await run(QuestionService.use((questions) => questions.answer(question.id, answer)));
};

const ESCALATES = {
  on: "asks, as question",
  lines: [hub("escalate", { key: "up", question_id: "$where.question_id" })],
};

describe.each(RUNTIMES)("a Quest that delivers a file you named, on %s", (runtime) => {
  // covers OR-004, OR-002
  it("[TC-OR-664] stays open when its lead answers a question about where else to save it and says it delivered", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project, temp, reactions, requests } = party;
    const system = join(temp, "System");
    mkdirSync(system, { recursive: true });
    const wanted = join(system, "skills-check.html");
    const saved = join(project, "skills-check.html");
    writeFileSync(join(project, "skills.md"), "# Skills\n");
    writeFileSync(saved, "<!doctype html>\n");
    // Frodo answers Rook's question himself, as the lead in #1215 did, rather than pass it up to you.
    reactions.push({
      on: "asks, as question",
      lines: [
        hub("answer", { key: "elsewhere", question_id: "$where.question_id", answer: "Save it in the source folder" }),
      ],
    });
    await run(
      quest(
        `Have Rook save a short summary of ${join(project, "skills.md")} as ${wanted}`,
        askedWhere(wanted),
        { key: "wrap", delivered: true, summary: "The summary is saved", artifacts: [file(saved)] },
        2,
      ),
    );
    const refused = await run(treeWhen((tree) => tree.refusals.some((each) => each.reason === "not-at-destination")));
    expect(answers.get("elsewhere")).not.toContain("Refused");
    expect(answers.get("wrap")).toContain("Refused (not-at-destination)");
    expect(answers.get("wrap")).toContain(wanted);
    expect(answers.get("wrap")).toContain("ask the user with ask where it should go");
    // The source it only reads is there, so it is not named as missing.
    expect(answers.get("wrap")).not.toContain("skills.md");
    expect(refused.tasks[0]?.state).not.toBe("completed");
    expect(refused.quests[0]?.state).toBe("active");
    // The turn the question started told Frodo that where you asked for the work is yours to change.
    const asked = requests.find((each) => each.prompt.includes("asks, as question"));
    expect(asked?.prompt).toContain("is never yours to answer. Pass it up with escalate.");
    expect(asked?.briefing).toContain("never choose another place yourself");
  }, 30_000);

  // covers OR-004
  it("[TC-OR-665] completes once the file is where you asked, with the file it reads there too", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project } = party;
    mkdirSync(join(project, "docs"), { recursive: true });
    const wanted = join(project, "docs", "skills-check.html");
    writeFileSync(join(project, "skills.md"), "# Skills\n");
    writeFileSync(wanted, "<!doctype html>\n");
    await run(
      quest(
        `Have Rook save a short summary of ${join(project, "skills.md")} as ${wanted}, in ${join(project, "docs")}/`,
        [hub("complete_task", { key: "rook", summary: "Saved" })],
        { key: "wrap", delivered: true, summary: "The summary is saved where you asked", artifacts: [file(wanted)] },
      ),
    );
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(answers.get("wrap")).toContain("is complete");
    expect(done.quests[0]?.state).not.toBe("active");
  }, 30_000);

  // covers OR-004, OR-002, IN-004
  it("[TC-OR-666] completes somewhere else once you answer the question its lead passed up about where to save it", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project, temp, reactions } = party;
    const wanted = join(temp, "System", "skills-check.html");
    const saved = join(project, "skills-check.html");
    writeFileSync(saved, "<!doctype html>\n");
    reactions.push(ESCALATES);
    await run(
      quest(
        `Have Rook save a short summary as ${wanted}`,
        askedWhere(wanted),
        { key: "wrap", delivered: true, summary: "Saved in the source folder, as you said", artifacts: [file(saved)] },
        2,
      ),
    );
    await escalatedAndAnswered(party, "Save it in the source folder");
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(answers.get("wrap")).toContain("is complete");
    expect(done.questions[0]?.answeredBy).toEqual({ _tag: "User" });
  }, 30_000);

  // covers OR-004, OR-002
  it("[TC-OR-667] stays open when the question you answered was about something else", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project, temp, reactions } = party;
    const wanted = join(temp, "System", "skills-check.html");
    const saved = join(project, "skills-check.html");
    writeFileSync(saved, "<!doctype html>\n");
    reactions.push(ESCALATES);
    await run(
      quest(
        `Have Rook save a short summary as ${wanted}`,
        asking("Should the summary be short or long?"),
        { key: "wrap", delivered: true, summary: "Saved in the source folder", artifacts: [file(saved)] },
        2,
      ),
    );
    await escalatedAndAnswered(party, "Short");
    const refused = await run(treeWhen((tree) => tree.refusals.some((each) => each.reason === "not-at-destination")));
    expect(answers.get("wrap")).toContain(wanted);
    expect(refused.quests[0]?.state).toBe("active");
  }, 30_000);

  // covers OR-004, OR-002
  it("[TC-OR-668] stays open when the place you answered with has nothing in it", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project, temp, reactions } = party;
    const wanted = join(temp, "System", "skills-check.html");
    const instead = join(project, "out", "skills-check.html");
    mkdirSync(join(project, "out"), { recursive: true });
    const saved = join(project, "skills-check.html");
    writeFileSync(saved, "<!doctype html>\n");
    reactions.push(ESCALATES);
    await run(
      quest(
        `Have Rook save a short summary as ${wanted}`,
        askedWhere(wanted),
        { key: "wrap", delivered: true, summary: "Saved in the source folder", artifacts: [file(saved)] },
        2,
      ),
    );
    await escalatedAndAnswered(party, `Save it as ${instead}`);
    const refused = await run(treeWhen((tree) => tree.refusals.some((each) => each.reason === "not-at-destination")));
    expect(answers.get("wrap")).toContain(instead);
    expect(answers.get("wrap")).not.toContain(wanted);
    expect(refused.quests[0]?.state).toBe("active");
  }, 30_000);

  // covers OR-004, UX-002
  it("[TC-OR-669] completes once the work renamed and deleted the files you asked it to", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true, activity: true });
    dispose = party.dispose;
    const { run, answers, project } = party;
    writeFileSync(join(project, "old.html"), "<p>Skills</p>\n");
    writeFileSync(join(project, "scratch.txt"), "draft\n");
    const tidy = JSON.stringify({
      command: "mv old.html new.html && rm scratch.txt",
      writes: { "new.html": "<p>Skills</p>\n", "old.html": null, "scratch.txt": null },
    });
    await run(
      quest(
        `Rename ${join(project, "old.html")} to ${join(project, "new.html")} and delete ${join(project, "scratch.txt")}`,
        [`fake:run ${tidy}`, hub("complete_task", { key: "rook", summary: "Renamed and deleted" })],
        { key: "wrap", delivered: true, summary: "Renamed and deleted as you asked" },
      ),
    );
    // Balanced asks you before the work deletes files; you approve.
    const pending = await run(firstPending);
    await run(
      ApprovalService.use((approvals) =>
        approvals.decide(pending.id, { decision: "approve", actionDigest: pending.actionDigest }),
      ),
    );
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(answers.get("wrap")).toContain("is complete");
    expect(done.quests[0]?.state).not.toBe("active");
  }, 30_000);
});
