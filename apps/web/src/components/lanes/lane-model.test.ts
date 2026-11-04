import {
  AgentId,
  ArtifactId,
  ArtifactRef,
  Attempt,
  AttemptActivity,
  AttemptId,
  Checkpoint,
  CommandId,
  CommandRecord,
  Delegation,
  FileChange,
  FileChangeId,
  HandOff,
  Quest,
  QuestId,
  RefusedCall,
  RefusedCallId,
  type ReplyStep,
  Task,
  TaskId,
  type TaskTree,
  TaskWait,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ADA,
  ALDRIC,
  attempt,
  BUILD,
  blackFriday,
  CAMPAIGN,
  COPY,
  checkpoint,
  delegation,
  QUILL,
  quest,
  question,
  task,
  tree,
} from "../../test/quests.ts";
import { foldMarks, type Lane, type LaneItem, laneRoom, SHOWN_MARKS, shortPath } from "./lane-model.ts";

const AT = (second: number) => `2026-11-01T10:00:${String(second).padStart(2, "0")}.000Z`;
const PIP = AgentId.make("pip");
const BRAM = AgentId.make("bram");
const EMAIL = TaskId.make("email");
const IMAGES = TaskId.make("images");

const command = (taskId: TaskId, line: string, second: number, fields: Partial<CommandRecord> = {}) =>
  new CommandRecord({
    id: CommandId.make(`cmd-${taskId}-${second}`),
    attemptId: AttemptId.make(`a-${taskId}`),
    taskId,
    stepId: `s-${second}`,
    command: line,
    folder: "/work/site",
    sandboxed: true,
    liveOutput: false,
    state: "succeeded",
    exitCode: 0,
    startedAt: AT(second),
    endedAt: AT(second),
    output: null,
    log: null,
    logNotKept: null,
    ...fields,
  });

const change = (taskId: TaskId, path: string, kind: FileChange["kind"], second: number) =>
  new FileChange({
    id: FileChangeId.make(`f-${taskId}-${second}`),
    attemptId: AttemptId.make(`a-${taskId}`),
    taskId,
    folder: "/work/site",
    path,
    kind,
    movedFrom: null,
    before: null,
    after: kind === "deleted" ? null : { hash: "h", size: 3, kind: "text", contentId: null, notKept: null },
    sharedWith: [],
    settled: true,
    recordedAt: AT(second),
  });

const read = (path: string, second: number): ReplyStep => ({
  id: `read-${second}`,
  kind: "tool",
  label: `Reading ${path}`,
  state: "done",
  call: { tool: "Read", operation: "read-files", targets: [path] },
  startedAt: AT(second),
});

const activity = (
  taskId: TaskId,
  fields: Partial<ConstructorParameters<typeof AttemptActivity>[0]> = {},
): AttemptActivity =>
  new AttemptActivity({
    attempt: attempt(taskId, "completed"),
    commands: [],
    changes: [],
    scans: [],
    artifacts: [],
    steps: [],
    sharedWithHobs: [],
    detailsClearedAt: null,
    ...fields,
  });

const report = (taskId: TaskId, summary: string, revision: number, fields: Partial<Checkpoint> = {}) =>
  new Checkpoint({ ...checkpoint(taskId, "progress", summary, revision), ...fields });

/** The lane of `hobId`, which the test knows is there. */
const laneOf = (room: ReturnType<typeof laneRoom>, hobId: AgentId): Lane => {
  const found = room.order.find((lane) => lane.hobId === hobId);
  if (found === undefined) throw new Error(`No lane for ${hobId}`);
  return found;
};

const kinds = (lane: Lane) => lane.items.map((item) => item.kind);

/** Each item as a short line, to compare a lane at a glance. */
const line = (item: LaneItem): string => {
  switch (item.kind) {
    case "read":
    case "delete":
      return `${item.kind} ${item.path}`;
    case "edit":
      return `edit ${item.path}`;
    case "run":
      return `run ${item.command.command}`;
    case "beat":
      return `beat ${item.text}`;
    case "refused":
      return `refused ${item.what}: ${item.reason}`;
    case "folded":
      return `folded ${item.marks.length}`;
    case "hand-out":
      return `out ${item.label} → ${item.to}`;
    case "hand-in":
      return `in ${item.label} ← ${item.from}`;
    case "briefed":
      return `briefed ${item.members.join(", ")}`;
    case "task":
      return `task ${item.title}`;
    case "wait":
      return `wait ${item.on.map((each) => (each.kind === "you" ? "you" : each.id)).join(", ")}`;
    case "now":
      return `now ${item.label ?? "-"}`;
    case "result":
      return `${item.outcome} ${item.text ?? "-"}`;
  }
};

const lines = (lane: Lane) => lane.items.map(line);

/** Quill finished the copy and handed it to Ada, who builds the page and waits on nothing. */
const handedOn = (): TaskTree => {
  const base = blackFriday();
  const copyArtifact = new ArtifactRef({
    id: ArtifactId.make("art-copy"),
    taskId: COPY,
    attemptId: AttemptId.make(`a-${COPY}`),
    kind: "file",
    label: "Landing copy",
    value: "/work/site/docs/copy.md",
    createdAt: AT(10),
  });
  return tree({
    ...base,
    tasks: [
      task(CAMPAIGN, { brief: "Plan a Black Friday campaign" }),
      new Task({
        ...task(COPY, { ownerId: QUILL, brief: "Draft the landing copy", state: "completed", second: 2 }),
        result: { summary: "Hero and three sections", attemptId: AttemptId.make(`a-${COPY}`) },
      }),
      new Task({
        ...task(BUILD, { ownerId: ADA, brief: "Build the campaign", second: 3 }),
        currentAttemptId: AttemptId.make(`a-${BUILD}`),
      }),
    ],
    attempts: [attempt(CAMPAIGN, "running"), attempt(COPY, "completed"), attempt(BUILD, "running")],
    artifacts: [copyArtifact],
    handOffs: [new HandOff({ artifactId: copyArtifact.id, toTaskId: BUILD, createdAt: AT(11) })],
    checkpoints: [
      report(COPY, "Three headlines drafted", 3),
      checkpoint(COPY, "started", "Started", 2),
      report(BUILD, "Page scaffolded", 12),
    ],
  });
};

describe("the Quest room's lanes", () => {
  it("TC-UX-905-01 gives the lead a lane and each member of its party one, side by side", () => {
    const room = laneRoom(blackFriday(), []);
    expect(room.order.map((lane) => lane.hobId)).toEqual([ALDRIC, QUILL, ADA]);
    expect(room.lanes.map((node) => node.party.length)).toEqual([0, 0, 0]);
    expect(laneOf(room, ALDRIC).role).toEqual({ kind: "lead" });
    expect(laneOf(room, QUILL).role).toEqual({ kind: "member" });
    expect(lines(laneOf(room, ALDRIC))).toEqual([`briefed ${QUILL}, ${ADA}`]);
  });

  it("names the Task in the header and where it stands", () => {
    const room = laneRoom(blackFriday(), []);
    expect(laneOf(room, QUILL)).toMatchObject({ title: "Draft the landing copy", status: "running" });
    expect(laneOf(room, ADA)).toMatchObject({ title: "Build the campaign", status: "waiting" });
  });

  it("shows a wait line while a Task waits on another hob's work", () => {
    expect(lines(laneOf(laneRoom(blackFriday(), []), ADA))).toEqual([`wait ${QUILL}`]);
  });

  it("shows hand-off chips in the giver's lane and the taker's, and the result once a Task ends", () => {
    const room = laneRoom(handedOn(), []);
    expect(lines(laneOf(room, QUILL))).toEqual([
      "beat Three headlines drafted",
      `out Landing copy → ${ADA}`,
      "completed Hero and three sections",
    ]);
    expect(lines(laneOf(room, ADA))).toEqual([`in Landing copy ← ${QUILL}`, "beat Page scaffolded", "now -"]);
  });

  it("TC-UX-905-02 marks what a hob did from its records, in the order it did it, with paths inside its folder", () => {
    const steps: ReadonlyArray<ReplyStep> = [
      read("/work/site/brief.md", 1),
      {
        id: "denied-1",
        kind: "tool",
        label: "Running rm -rf dist",
        state: "denied",
        call: { tool: "Bash", operation: "delete-files", targets: ["/work/site/dist"] },
        reason: "Deleting files is never allowed here.",
        startedAt: AT(6),
      },
      { id: "think", kind: "thinking", label: "Thinking", state: "done", startedAt: AT(2) },
    ];
    const records = activity(BUILD, {
      attempt: attempt(BUILD, "running"),
      steps: [...steps, { id: "now", kind: "tool", label: "Running pnpm build", state: "running", startedAt: AT(9) }],
      commands: [command(BUILD, "pnpm build", 5), command(BUILD, "pnpm test", 7, { state: "failed", exitCode: 1 })],
      changes: [change(BUILD, "src/page.astro", "added", 3), change(BUILD, "docs/old.md", "deleted", 4)],
      scans: [],
    });
    const base = handedOn();
    const lane = laneOf(laneRoom(base, [records]), ADA);
    expect(lines(lane)).toEqual([
      "read brief.md",
      "edit src/page.astro",
      "delete docs/old.md",
      "run pnpm build",
      "refused Running rm -rf dist: Deleting files is never allowed here.",
      "run pnpm test",
      `in Landing copy ← ${QUILL}`,
      "beat Page scaffolded",
      "now Running pnpm build",
    ]);
  });

  it("shows the Task tool calls the hub refused, with what it told the hob", () => {
    const refused = new RefusedCall({
      id: RefusedCallId.make("r1"),
      agentId: QUILL,
      taskId: COPY,
      tool: "complete_task",
      key: null,
      input: "{}",
      reason: "children-open",
      message: "Finish the steps under this Task first.",
      tries: 1,
      createdAt: AT(4),
      refusedAt: AT(4),
    });
    const lane = laneOf(laneRoom(tree({ ...blackFriday(), refusals: [refused] }), []), QUILL);
    expect(lines(lane)).toEqual(["refused complete_task: Finish the steps under this Task first."]);
  });

  it("leaves out the hub's routine checkpoints and keeps its findings", () => {
    const base = blackFriday();
    const finding = report(COPY, "Ada changed docs/copy.md too", 9, { source: "automatic", kind: "finding" });
    const room = laneRoom(
      tree({
        ...base,
        checkpoints: [checkpoint(COPY, "started", "Started", 2), finding, checkpoint(COPY, "done", "Done", 20)],
      }),
      [],
    );
    expect(lines(laneOf(room, QUILL))).toEqual(["beat Ada changed docs/copy.md too"]);
  });

  it("says why the hub stopped a Task that failed", () => {
    const base = blackFriday();
    const failed = new Checkpoint({
      ...checkpoint(COPY, "failed", "The template emails/base.mjml is missing.", 30),
      source: "automatic",
    });
    const room = laneRoom(
      tree({
        ...base,
        tasks: base.tasks.map((each) =>
          each.id === COPY ? task(COPY, { ownerId: QUILL, state: "failed", second: 2 }) : each,
        ),
        checkpoints: [failed],
      }),
      [],
    );
    const lane = laneOf(room, QUILL);
    expect(lane.status).toBe("failed");
    expect(lines(lane)).toEqual(["failed The template emails/base.mjml is missing."]);
  });

  it("lights the lane of the hob that asked you, not its lead's", () => {
    const base = blackFriday();
    const room = laneRoom(
      tree({ ...base, questions: [question(BUILD, ADA, "Light or dark theme?", { recipientId: null })] }),
      [],
    );
    expect(laneOf(room, ADA).status).toBe("needs-you");
    expect(laneOf(room, ALDRIC).status).toBe("running");
    expect(lines(laneOf(room, ADA))).toEqual([`wait ${QUILL}, you`]);
  });

  it("shows only what the latest try did once a Task was retried", () => {
    const first = attempt(COPY, "failed");
    const second = new Attempt({ ...first, id: AttemptId.make("a-copy-2"), number: 2, state: "running" });
    const base = blackFriday();
    const room = laneRoom(
      tree({
        ...base,
        tasks: base.tasks.map((each) => (each.id === COPY ? new Task({ ...each, currentAttemptId: second.id }) : each)),
        attempts: [first, second],
        checkpoints: [
          report(COPY, "First draft", 3, { attemptId: first.id }),
          report(COPY, "Trying again", 4, { attemptId: second.id }),
        ],
      }),
      [activity(COPY, { attempt: first, commands: [command(COPY, "pnpm old", 2)] })],
    );
    expect(lines(laneOf(room, QUILL))).toEqual(["beat Trying again", "now -"]);
  });

  it("TC-UX-905-03 folds the oldest marks into a count and keeps beats and chips in place", () => {
    const records = activity(COPY, {
      commands: Array.from({ length: SHOWN_MARKS + 3 }, (_, index) => command(COPY, `step ${index}`, index + 1)),
    });
    const base = blackFriday();
    const room = laneRoom(
      tree({ ...base, attempts: [attempt(COPY, "completed")], checkpoints: [report(COPY, "Halfway", 30)] }),
      [records],
    );
    const shown = lines(laneOf(room, QUILL));
    expect(shown[0]).toBe("folded 3");
    expect(shown.filter((each) => each.startsWith("run"))).toHaveLength(SHOWN_MARKS);
    expect(shown.at(-1)).toBe("beat Halfway");
  });

  it("folds nothing while a lane holds no more marks than it shows", () => {
    const items: ReadonlyArray<LaneItem> = [{ kind: "beat", key: "b", text: "Hi" }];
    expect(foldMarks(items)).toBe(items);
  });

  it("keeps a hob's steps in its own lane, never in a lane of their own", () => {
    const STEP = TaskId.make("copy-step");
    const base = blackFriday();
    const room = laneRoom(
      tree({
        ...base,
        tasks: [...base.tasks, task(STEP, { ownerId: QUILL, parentId: COPY, brief: "Outline", second: 5 })],
        checkpoints: [report(STEP, "Outline done", 8)],
      }),
      [],
    );
    expect(room.order.map((lane) => lane.hobId)).toEqual([ALDRIC, QUILL, ADA]);
    expect(lines(laneOf(room, QUILL))).toEqual(["beat Outline done"]);
  });

  it("keeps one lane for a hob with two Tasks on the Quest, with its Tasks in order", () => {
    const SIGNS = TaskId.make("signs");
    const base = blackFriday();
    const room = laneRoom(
      tree({
        ...base,
        tasks: [
          ...base.tasks.map((each) =>
            each.id === COPY
              ? task(COPY, { ownerId: QUILL, state: "completed", brief: "Draft the landing copy", second: 2 })
              : each,
          ),
          task(SIGNS, { ownerId: QUILL, brief: "Make the signs", second: 6 }),
        ],
        delegations: [...base.delegations, delegation(QUILL, SIGNS, "Make the signs")],
      }),
      [],
    );
    const lane = laneOf(room, QUILL);
    expect(room.order.filter((each) => each.hobId === QUILL)).toHaveLength(1);
    expect(lane.title).toBe("Make the signs");
    expect(kinds(lane)).toEqual(["task", "result", "task"]);
  });

  it("TC-UX-905-04 groups a nested Quest's lanes under its lead, who leads them", () => {
    const NESTED = QuestId.make("quest-build");
    const base = blackFriday();
    const nested = (member: AgentId, child: TaskId, brief: string) =>
      new Delegation({ ...delegation(member, child, brief), questId: NESTED, leadId: ADA, parentTaskId: BUILD });
    const room = laneRoom(
      tree({
        ...base,
        tasks: [
          ...base.tasks,
          task(EMAIL, { ownerId: PIP, parentId: BUILD, brief: "Write the launch email", second: 4 }),
          task(IMAGES, { ownerId: BRAM, parentId: BUILD, brief: "Resize the hero images", second: 5 }),
        ],
        quests: [...base.quests, new Quest({ ...quest(), id: NESTED, taskId: BUILD, leadId: ADA, depth: 2 })],
        delegations: [
          ...base.delegations,
          nested(PIP, EMAIL, "Write the launch email"),
          nested(BRAM, IMAGES, "Resize"),
        ],
        waits: [new TaskWait({ taskId: EMAIL, on: [IMAGES], mode: "all", createdAt: AT(6) })],
      }),
      [],
    );
    expect(room.order.map((lane) => lane.hobId)).toEqual([ALDRIC, QUILL, ADA, PIP, BRAM]);
    const group = room.lanes[2];
    expect(group?.lane.hobId).toBe(ADA);
    expect(group?.party.map((node) => node.lane.hobId)).toEqual([PIP, BRAM]);
    expect(group?.lane.role).toEqual({ kind: "leads", members: [PIP, BRAM] });
    expect(lines(laneOf(room, ADA))).toContain(`briefed ${PIP}, ${BRAM}`);
  });

  it("gives a Task alone one lane, with no role", () => {
    const room = laneRoom(tree(), []);
    expect(room.order).toHaveLength(1);
    expect(room.order[0]?.role).toEqual({ kind: "member" });
  });

  it("has no lanes for a tree with no Task", () => {
    expect(laneRoom(tree({ tasks: [] }), [])).toEqual({ lanes: [], order: [] });
  });
});

describe("a lane's paths", () => {
  it("shows a path from inside the deepest hob folder it is in", () => {
    expect(shortPath("/work/site/docs/a.md", ["/work", "/work/site"])).toBe("docs/a.md");
    expect(shortPath("/work/site/docs/a.md", ["/work/site/"])).toBe("docs/a.md");
    expect(shortPath("/elsewhere/a.md", ["/work"])).toBe("/elsewhere/a.md");
    expect(shortPath("/work-two/a.md", ["/work"])).toBe("/work-two/a.md");
  });
});
