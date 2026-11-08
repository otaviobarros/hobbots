import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalService, QuestionService } from "@hobbots/agents";
import type { RuntimeKind } from "@hobbots/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { firstPending, hub, partyHub, send, treeWhen } from "./party-hub.ts";

// Issue #1215: you asked for a summary at a path its member could not write. The member asked its
// lead where to save it instead, the lead answered itself ("save it in the source folder") and
// completed the Quest with delivered: true, and the Quest read done with a file where you never
// agreed. complete_task on a Quest's top Task now holds the lead to the files you named: each must
// be there, unless you picked a choice whose consequence, worded by the hub, moves it or leaves it
// empty, or you approved the work deleting it. Typed answers, safety presets, and a move to another
// path you named let nothing go. The hub checks the call, so it holds
// for every runtime.

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

/** Rook asks where to save the page it could not write at `wanted`, naming it, with `options` to pick from. */
const askedWhere = (wanted: string, options?: ReadonlyArray<object>) => [
  hub("ask", {
    key: "where",
    question: `I can't write ${wanted}. Where should I save it instead?`,
    ...(options === undefined ? {} : { options }),
  }),
  `fake:then ${hub("complete_task", { key: "rook", summary: "Saved in the source folder" })}`,
];

/** The choices Rook offers: `to` instead of `wanted`, worded as Hobbots words it, or keep `wanted`. */
const insteadOrKeep = (to: string, wanted: string) => [
  { label: "Save it there instead", consequence: `Not delivered at ${wanted}: delivered at ${to} instead.` },
  { label: "Keep the place I asked for", consequence: "The Quest waits until it can go there." },
];

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
    expect(answers.get("wrap")).toContain("ask the user with ask, and leave the Quest open until they pick");
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
  it("[TC-OR-666] completes somewhere else once you pick the choice that delivers it there instead", async () => {
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
        askedWhere(wanted, insteadOrKeep(saved, wanted)),
        { key: "wrap", delivered: true, summary: "Saved in the source folder, as you said", artifacts: [file(saved)] },
        2,
      ),
    );
    await escalatedAndAnswered(party, "Save it there instead");
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
  it("[TC-OR-668] stays open when the place you picked instead has nothing in it", async () => {
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
        askedWhere(wanted, insteadOrKeep(instead, wanted)),
        { key: "wrap", delivered: true, summary: "Saved in the source folder", artifacts: [file(saved)] },
        2,
      ),
    );
    await escalatedAndAnswered(party, "Save it there instead");
    const refused = await run(treeWhen((tree) => tree.refusals.some((each) => each.reason === "not-at-destination")));
    expect(answers.get("wrap")).toContain(instead);
    expect(answers.get("wrap")).not.toContain(wanted);
    expect(refused.quests[0]?.state).toBe("active");
  }, 30_000);

  // covers OR-004, UX-002
  it("[TC-OR-669] completes once the work deleted the file you asked it to, as you approved", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true, activity: true });
    dispose = party.dispose;
    const { run, answers, project } = party;
    const scratch = join(project, "scratch.txt");
    writeFileSync(scratch, "draft\n");
    const remove = JSON.stringify({ command: "rm scratch.txt", writes: { "scratch.txt": null } });
    await run(
      quest(`Delete ${scratch}`, [`fake:run ${remove}`, hub("complete_task", { key: "rook", summary: "Deleted" })], {
        key: "wrap",
        delivered: true,
        summary: "Deleted as you asked",
      }),
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

  // covers OR-004, OR-002
  it("[TC-OR-670] stays open when you answer the question about where to save it by keeping the place you asked for", async () => {
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
        { key: "wrap", delivered: true, summary: "Saved in the source folder", artifacts: [file(saved)] },
        2,
      ),
    );
    await escalatedAndAnswered(party, "No, keep the original destination");
    const refused = await run(treeWhen((tree) => tree.refusals.some((each) => each.reason === "not-at-destination")));
    expect(answers.get("wrap")).toContain(wanted);
    expect(refused.quests[0]?.state).toBe("active");
  }, 30_000);

  // covers OR-004, UX-002
  it("[TC-OR-671] stays open when the work moved the file you asked to update somewhere you never named", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true, activity: true });
    dispose = party.dispose;
    const { run, answers, project } = party;
    const report = join(project, "report.html");
    writeFileSync(report, "<h1>Report</h1>\n");
    // A script moves it, which the safety preset does not ask about, as no command it can read deletes it.
    const archive = JSON.stringify({
      command: "python3 archive.py",
      writes: { "report.html": null, "archive/report.html": "<h1>Report</h1>\n" },
    });
    await run(
      quest(
        `Update ${report} with this week's numbers`,
        [`fake:run ${archive}`, hub("complete_task", { key: "rook", summary: "Updated and archived" })],
        { key: "wrap", delivered: true, summary: "The report is updated" },
      ),
    );
    const refused = await run(treeWhen((tree) => tree.refusals.some((each) => each.reason === "not-at-destination")));
    expect(answers.get("wrap")).toContain(report);
    expect(refused.quests[0]?.state).toBe("active");
  }, 30_000);

  // covers OR-004, OR-002
  it("[TC-OR-672] stays open when your typed answer turns down the place it names", async () => {
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
        { key: "wrap", delivered: true, summary: "Saved in the source folder", artifacts: [file(saved)] },
        2,
      ),
    );
    await escalatedAndAnswered(party, `Do not put it at ${saved}; keep the original destination`);
    const refused = await run(treeWhen((tree) => tree.refusals.some((each) => each.reason === "not-at-destination")));
    expect(answers.get("wrap")).toContain(wanted);
    expect(refused.quests[0]?.state).toBe("active");
  }, 30_000);

  // covers OR-004, UX-002
  it("[TC-OR-673] stays open when a hob that may delete without asking removed the file you asked to update", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true, activity: true, preset: "trusting" });
    dispose = party.dispose;
    const { run, answers, project } = party;
    const report = join(project, "report.html");
    writeFileSync(report, "<h1>Report</h1>\n");
    const archive = JSON.stringify({
      command: "mkdir -p archive && mv report.html archive/report.html",
      writes: { "report.html": null, "archive/report.html": "<h1>Report</h1>\n" },
    });
    await run(
      quest(
        `Update ${report} with this week's numbers`,
        [`fake:run ${archive}`, hub("complete_task", { key: "rook", summary: "Updated and archived" })],
        { key: "wrap", delivered: true, summary: "The report is updated" },
      ),
    );
    const refused = await run(treeWhen((tree) => tree.refusals.some((each) => each.reason === "not-at-destination")));
    expect(answers.get("wrap")).toContain(report);
    expect(refused.quests[0]?.state).toBe("active");
  }, 30_000);

  // covers OR-004, OR-002
  it("[TC-OR-674] completes once you pick the choice that leaves nothing at a file the work removed", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true, activity: true, preset: "trusting" });
    dispose = party.dispose;
    const { run, answers, project, reactions } = party;
    const scratch = join(project, "scratch.txt");
    writeFileSync(scratch, "draft\n");
    const remove = JSON.stringify({ command: "rm scratch.txt", writes: { "scratch.txt": null } });
    reactions.push(ESCALATES);
    await run(
      quest(
        `Clear out ${scratch}`,
        [
          `fake:run ${remove}`,
          hub("ask", {
            key: "where",
            question: `I removed ${scratch}. Is that what you wanted?`,
            options: [
              { label: "Yes, remove it", consequence: `Not delivered at ${scratch}: nothing is left there.` },
              { label: "No, put it back", consequence: "Rook restores the file." },
            ],
          }),
          `fake:then ${hub("complete_task", { key: "rook", summary: "Removed" })}`,
        ],
        { key: "wrap", delivered: true, summary: "Cleared out as you asked" },
        2,
      ),
    );
    await escalatedAndAnswered(party, "Yes, remove it");
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(answers.get("wrap")).toContain("is complete");
    expect(done.quests[0]?.state).not.toBe("active");
  }, 30_000);

  // covers OR-004, UX-002
  it("[TC-OR-675] stays open when the work moved the file you asked to copy, though the copy is where you asked", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true, activity: true });
    dispose = party.dispose;
    const { run, answers, project } = party;
    const source = join(project, "source.txt");
    const copy = join(project, "copy.txt");
    writeFileSync(source, "Original\n");
    // A script moves it, which the safety preset does not ask about, as no command it can read deletes it.
    const moved = JSON.stringify({
      command: "python3 copy.py",
      writes: { "source.txt": null, "copy.txt": "Original\n" },
    });
    await run(
      quest(
        `Copy ${source} to ${copy}, keeping the original`,
        [`fake:run ${moved}`, hub("complete_task", { key: "rook", summary: "Copied" })],
        { key: "wrap", delivered: true, summary: "Copied as you asked" },
      ),
    );
    const refused = await run(treeWhen((tree) => tree.refusals.some((each) => each.reason === "not-at-destination")));
    expect(answers.get("wrap")).toContain(source);
    expect(answers.get("wrap")).not.toContain(copy);
    expect(refused.quests[0]?.state).toBe("active");
  }, 30_000);

  // covers OR-004, OR-002, IN-004 (#1219)
  it("[TC-OR-1219-02] refuses a first question about the place you asked for whose choices none worded to let it go", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project, temp, requests } = party;
    const wanted = join(temp, "System", "skills-check.html");
    const saved = join(project, "skills-check.html");
    writeFileSync(saved, "<!doctype html>\n");
    // The lead's member asks with choices that leave the delivery to you, as the lead in #1219 did.
    const byHand = [
      { label: "Move it yourself", consequence: `Copy ${saved} to ${wanted} by hand.` },
      { label: "Keep the place I asked for", consequence: "The Quest waits until it can go there." },
    ];
    await run(
      quest(
        `Have Rook save a short summary as ${wanted}`,
        [
          // A question about the page itself, naming it while it is not written yet, is asked as it is.
          hub("ask", {
            key: "language",
            question: `Should ${wanted} be in English or Portuguese?`,
            options: [
              { label: "English", consequence: `${wanted} is written in English.` },
              { label: "Portuguese", consequence: `${wanted} is written in Portuguese.` },
            ],
          }),
          hub("ask", {
            key: "by-hand",
            question: `I can't write ${wanted}. What now?`,
            options: byHand,
            recommended: 1,
          }),
          hub("ask", {
            key: "worded",
            question: `I can't write ${wanted}. What now?`,
            options: insteadOrKeep(saved, wanted),
            recommended: 2,
          }),
        ],
        { key: "wrap", delivered: true, summary: "Saved", artifacts: [file(saved)] },
      ),
    );
    const asked = await run(treeWhen((tree) => tree.questions.length > 1));
    expect(answers.get("language")).not.toContain("Refused");
    expect(answers.get("by-hand")).toContain("Refused (destination-unworded)");
    expect(answers.get("by-hand")).toContain(`The user asked for ${wanted}, and nothing is there yet`);
    expect(answers.get("by-hand")).toContain("Never recommend a choice that leaves the delivery to the user");
    expect(answers.get("worded")).not.toContain("Refused");
    // The question about its content, and the one worded to let the place go, are asked.
    expect(asked.questions.map((each) => each.options.map((option) => option.label))).toEqual([
      ["English", "Portuguese"],
      ["Save it there instead", "Keep the place I asked for"],
    ]);
    // The question reaches the lead as a turn whose briefing says how such a question is worded.
    const lead = await vi.waitFor(() => {
      const found = requests.find((each) => each.prompt.includes("asks, as question"));
      if (found === undefined) throw new Error("the question has not reached the lead yet");
      return found;
    });
    expect(lead.briefing).toContain(
      `"Not delivered at <the path they asked for>: delivered at <new absolute path> instead."`,
    );
    expect(lead.briefing).toContain("pass their answer on to a member in their own words");
  }, 30_000);

  // covers OR-004, OR-002 (#1219)
  it("[TC-OR-1219-03] refuses a lead's answer that puts the work at a place of its own after you redirected it, whatever it quotes, and passes your words on", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project, temp, reactions } = party;
    const wanted = join(temp, "System", "skills-check.html");
    const saved = join(project, "skills-check.html");
    const redirect = "Save it in ~/Documents/Hobbots instead";
    const escalates = (asked: string) => ({
      on: "asks, as question",
      lines: [hub("escalate", { key: `up-${asked}`, question_id: `$${asked}.question_id` })],
    });
    reactions.push(escalates("style"), escalates("where"), {
      on: "asks, as question",
      lines: [
        hub("answer", { key: "mine", question_id: "$again.question_id", answer: `Save it at ${saved}` }),
        // "Yes" is your answer to another question: quoting it lets no place of the lead's own through.
        hub("answer", {
          key: "unrelated",
          question_id: "$again.question_id",
          answer: `Yes, save it at ${saved} instead`,
        }),
        hub("answer", {
          key: "quoted",
          question_id: "$again.question_id",
          answer: `The user said: "${redirect}". Save it at ${saved}`,
        }),
        hub("answer", { key: "theirs", question_id: "$again.question_id", answer: `The user said: "${redirect}"` }),
      ],
    });
    await run(
      quest(
        `Have Rook save a short summary as ${wanted}`,
        [
          hub("ask", { key: "style", question: "Should it have a table of contents?" }),
          `fake:then ${hub("ask", { key: "where", question: `I can't write ${wanted}. Where should I save it instead?` })}`,
          `fake:then fake:then ${hub("ask", { key: "again", question: `${wanted} is still out of reach. Where exactly?` })}`,
          `fake:then fake:then fake:then ${hub("complete_task", { key: "rook", summary: "Saved where the user said" })}`,
        ],
        { key: "wrap", delivered: true, summary: "Saved" },
        2,
      ),
    );
    const youAnswer = async (index: number, answer: string) => {
      const escalated = await run(treeWhen((tree) => tree.questions[index]?.recipientId === null));
      const question = escalated.questions[index];
      if (question === undefined) throw new Error("no question for you");
      await run(QuestionService.use((questions) => questions.answer(question.id, answer)));
    };
    await youAnswer(0, "Yes");
    await youAnswer(1, redirect);
    const answered = await run(
      treeWhen((tree) => tree.questions[2] !== undefined && tree.questions[2].answer !== null),
    );
    expect(answers.get("mine")).toContain("Refused (destination-theirs)");
    expect(answers.get("mine")).toContain(`your answer puts the work at ${saved} instead`);
    expect(answers.get("mine")).toContain(`"${redirect}"`);
    expect(answers.get("unrelated")).toContain("Refused (destination-theirs)");
    expect(answers.get("quoted")).toContain("Refused (destination-theirs)");
    expect(answers.get("theirs")).not.toContain("Refused");
    expect(answered.questions[2]?.answer).toBe(`The user said: "${redirect}"`);
  }, 30_000);
});
