import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentId,
  ancestorsOf,
  answerHow,
  CHECKPOINT_WORDS,
  Checkpoint,
  CheckpointId,
  choicesText,
  DEFAULT_QUEST_LIMITS,
  FINISH_RULE,
  isTaskToolName,
  LEAN_CHAT_RULE,
  optionNamed,
  pickedOption,
  Quest,
  QuestId,
  Question,
  questChain,
  questPlacement,
  TASK_TOOLS,
  Task,
  TaskId,
  TaskToolInputs,
  TaskToolRefused,
  taskToolJsonSchema,
  taskToolText,
} from "../src/index.ts";

const at = "2026-11-01T00:00:00.000Z";
const task = (id: string, owner: string, parent: string | null) =>
  new Task({
    id: TaskId.make(id),
    ownerId: AgentId.make(owner),
    parentId: parent === null ? null : TaskId.make(parent),
    rootId: TaskId.make("top"),
    threadId: null,
    brief: id,
    state: "active",
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });
const quest = (id: string, taskId: string, lead: string, depth: number, parent: string | null) =>
  new Quest({
    id: QuestId.make(id),
    taskId: TaskId.make(taskId),
    leadId: AgentId.make(lead),
    parentQuestId: parent === null ? null : QuestId.make(parent),
    threadId: null,
    goal: id,
    acceptance: [],
    limits: DEFAULT_QUEST_LIMITS,
    depth,
    state: "active",
    createdAt: at,
    endedAt: null,
    revision: 1,
  });

// Aldric's Quest on the top Task; Rook's Task under it with his own step.
const top = task("top", "aldric", null);
const rook = task("rook", "rook", "top");
const step = task("step", "rook", "rook");
const pip = task("pip", "pip", "step");
const tree = [top, rook, step, pip];
const aldrics = quest("q1", "top", "aldric", 1, null);

describe("hob tools for Tasks and Quests", () => {
  it("names every tool once, with an input that needs a key", () => {
    expect(TASK_TOOLS.map((tool) => tool.name)).toEqual(Object.keys(TaskToolInputs));
    expect(isTaskToolName("plan_steps")).toBe(true);
    expect(isTaskToolName("toString")).toBe(false);
    for (const tool of TASK_TOOLS) {
      expect((taskToolJsonSchema(tool.name) as { required: ReadonlyArray<string> }).required).toContain("key");
    }
  });

  it("asks for a checkpoint summary of about eight words, with anything more in an optional detail (#901)", () => {
    const description = (name: string) => TASK_TOOLS.find((tool) => tool.name === name)?.description ?? "";
    expect(description("report_checkpoint")).toContain(
      `about ${CHECKPOINT_WORDS} words, like "Three headlines drafted"`,
    );
    expect(description("report_checkpoint")).toContain("put anything more in detail");
    const schema = taskToolJsonSchema("report_checkpoint") as {
      properties: Record<string, { description?: string }>;
      required: ReadonlyArray<string>;
    };
    expect(schema.properties.summary?.description).toContain("about 8 words");
    expect(schema.properties.detail?.description).toContain("The Workbench shows it; a lane never does.");
    expect(schema.required).not.toContain("detail");
    const decode = Schema.decodeUnknownSync(TaskToolInputs.report_checkpoint);
    expect(decode({ key: "k", kind: "progress", summary: "Three headlines drafted" })).not.toHaveProperty("detail");
    expect(
      decode({ key: "k", kind: "finding", summary: "Two headlines too long", detail: "Both run past 60 characters." })
        .detail,
    ).toBe("Both run past 60 characters.");
  });

  it("tells a lead what it writes in the chat: the plan, a question no lead can answer and the finish (#901)", () => {
    const description = (name: string) => TASK_TOOLS.find((tool) => tool.name === name)?.description ?? "";
    expect(description("delegate_task")).toContain(LEAN_CHAT_RULE);
    expect(description("complete_task")).toContain(FINISH_RULE);
  });

  it("decodes a checkpoint journaled before it had a detail as one with none (#901)", () => {
    const decode = Schema.decodeUnknownSync(Checkpoint);
    const old = decode({
      id: "c",
      taskId: "t",
      attemptId: null,
      source: "unplanned",
      kind: "progress",
      milestoneId: null,
      summary: "Three headlines drafted",
      createdAt: at,
      revision: 1,
    });
    expect(old.detail).toBeNull();
    expect(old.id).toBe(CheckpointId.make("c"));
  });

  it("[TC-GEN-158] takes a question with no choices or 2 to 4, and a recommended one among them (#740)", () => {
    const decode = Schema.decodeUnknownSync(TaskToolInputs.ask);
    const choice = (label: string) => ({ label, consequence: `${label} it is.` });
    expect(decode({ key: "k", question: "Which theme?" })).not.toHaveProperty("options");
    expect(
      decode({ key: "k", question: "Which theme?", options: [choice("Light"), choice("Dark")], recommended: 1 }),
    ).toMatchObject({ options: [{ label: "Light" }, { label: "Dark" }], recommended: 1 });
    expect(() => decode({ key: "k", question: "Which theme?", options: [choice("Light")] })).toThrow();
    expect(() => decode({ key: "k", question: "Which?", options: ["A", "B", "C", "D", "E"].map(choice) })).toThrow();
    expect(() => decode({ key: "k", question: "Which?", options: [choice("A"), choice("B")], recommended: 3 })).toThrow(
      "recommended is the number of one of the 2 options.",
    );
    expect(() =>
      decode({ key: "k", question: "Which?", options: [choice("A"), choice("B")], recommended: 0 }),
    ).toThrow();
    expect(() => decode({ key: "k", question: "Which?", recommended: 1 })).toThrow(
      "recommended needs options to recommend one of.",
    );
    expect(() => decode({ key: "k", question: "Which?", options: [choice(""), choice("B")] })).toThrow();
  });

  it("[TC-GEN-159] reads a question's choices and how it was answered, and an old question as one without (#740)", () => {
    const old = Schema.decodeUnknownSync(Question)({
      id: "q",
      taskId: "t",
      askerId: "ada",
      recipientId: null,
      chain: [],
      text: "Which theme?",
      state: "open",
      answer: null,
      answeredBy: null,
      createdAt: at,
      answeredAt: null,
      revision: 1,
    });
    expect([old.options, old.recommended, old.picked]).toEqual([[], null, null]);
    expect(choicesText(old)).toBe("");
    expect(answerHow(old)).toBe("");
    const options = [
      { label: "Light", consequence: "Matches the brand guide" },
      { label: "Dark", consequence: "" },
    ];
    const asked = new Question({ ...old, options, recommended: 0 });
    expect(choicesText(asked)).toBe(" Choices: 1. Light (recommended): Matches the brand guide; 2. Dark");
    expect(optionNamed(options, "  dark ")).toBe(1);
    expect(optionNamed(options, "Dark, but softer")).toBeNull();
    const picked = new Question({ ...asked, state: "answered", answer: "Dark", picked: 1 });
    expect(answerHow(picked)).toBe(" (choice 2 of 2)");
    expect(pickedOption(picked)?.label).toBe("Dark");
    const typed = new Question({ ...asked, state: "answered", answer: "Both", picked: null });
    expect(answerHow(typed)).toBe(" (written in words, not one of the choices)");
    expect(pickedOption(typed)).toBeUndefined();
  });

  it("decodes what a model sends and refuses what it leaves out", () => {
    const decode = Schema.decodeUnknownSync(TaskToolInputs.delegate_task);
    expect(
      decode({ key: "k", hob: "Quill", brief: "Draft", authority: { decisions: { push: "deny" } } }),
    ).toMatchObject({
      authority: { decisions: { push: "deny" } },
    });
    expect(() => decode({ key: "k", hob: "Quill" })).toThrow();
    expect(() => decode({ key: "", hob: "Quill", brief: "Draft" })).toThrow();
    expect(() =>
      decode({ key: "k", hob: "Quill", brief: "Draft", authority: { decisions: { push: "always" } } }),
    ).toThrow();
  });

  it("takes a step's milestones as titles and refuses the id of an existing one", () => {
    const decode = Schema.decodeUnknownSync(TaskToolInputs.plan_steps);
    expect(decode({ key: "k", steps: [{ brief: "Styles", milestones: ["Page renders"] }] })).toMatchObject({
      steps: [{ milestones: ["Page renders"] }],
    });
    expect(() =>
      decode({ key: "k", steps: [{ brief: "Styles", milestones: ["db8065be-d145-4ff1-8b6e-f822c8d67643"] }] }),
    ).toThrow(/never the id of an existing milestone/);
  });

  it("reads back a result or a refusal as text the hob can act on", () => {
    expect(taskToolText({ message: "Done.", details: {} })).toBe("Done.");
    expect(taskToolText({ message: "Asked.", details: { question_id: "q" } })).toBe('Asked.\n{"question_id":"q"}');
    expect(taskToolText(new TaskToolRefused({ reason: "cycle", message: "Aldric leads it." }))).toBe(
      "Refused (cycle): Aldric leads it.",
    );
  });

  it("finds the Tasks above a Task, nearest first", () => {
    expect(ancestorsOf(pip, tree).map((each) => each.id)).toEqual(["step", "rook", "top"]);
    expect(ancestorsOf(top, tree)).toEqual([]);
  });

  it("places a new Quest by counting Quests, never steps", () => {
    expect(questPlacement(top, tree, [])).toEqual({ outer: null, depth: 1 });
    expect(questPlacement(rook, tree, [aldrics])).toEqual({ outer: aldrics, depth: 2 });
    const rooks = quest("q2", "rook", "rook", 2, "q1");
    // A Quest on Rook's own step sits at his Quest's depth.
    expect(questPlacement(step, tree, [aldrics, rooks])).toEqual({ outer: rooks, depth: 2 });
    expect(questPlacement(pip, tree, [aldrics, rooks])).toEqual({ outer: rooks, depth: 3 });
    expect(questChain(rooks, [aldrics, rooks]).map((each) => each.id)).toEqual(["q2", "q1"]);
  });
});
