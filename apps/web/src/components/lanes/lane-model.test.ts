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
  memberApproval,
  QUILL,
  quest,
  question,
  task,
  tree,
} from "../../test/quests.ts";
import { foldMarks, type Lane, type LaneItem, laneAttempts, laneRoom, SHOWN_MARKS, shortPath } from "./lane-model.ts";

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
const LINES: { [K in LaneItem["kind"]]: (item: Extract<LaneItem, { kind: K }>) => string } = {
  read: (item) => `read ${item.path}`,
  delete: (item) => `delete ${item.path}`,
  edit: (item) => `edit ${item.path}`,
  run: (item) => `run ${item.command.command}`,
  step: (item) => `step ${item.outcome} ${item.text}`,
  beat: (item) => `beat ${item.text}`,
  refused: (item) => `refused ${item.what}: ${item.reason}`,
  folded: (item) => `folded ${item.marks.length}`,
  "hand-out": (item) => `out ${item.label} → ${item.to}`,
  "hand-in": (item) => `in ${item.label} ← ${item.from}`,
  briefed: (item) => `briefed ${item.members.join(", ")}`,
  task: (item) => `task ${item.title}`,
  wait: (item) => `wait ${item.on.map((each) => (each.kind === "you" ? "you" : each.id)).join(", ")}`,
  now: (item) => `now ${item.label ?? "-"}`,
  result: (item) => `${item.outcome} ${item.text ?? "-"}`,
};

const line = <K extends LaneItem["kind"]>(item: Extract<LaneItem, { kind: K }>): string =>
  (LINES[item.kind] as (each: typeof item) => string)(item);

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
    // In everyday words: no commands, the file it only read left out, and how each step went.
    expect(lane.plain.map(line)).toEqual([
      "step done Created page.astro",
      "step done Deleted old.md",
      "step done Built the project",
      "step blocked Not allowed to delete dist",
      "step failed Ran the tests",
      `in Landing copy ← ${QUILL}`,
      "beat Page scaffolded",
      "now Building the project",
    ]);
  });

  it("[TC-UX-1004-01] names the command a turn waits on while no step runs, and when the hob last did something", () => {
    // covers UX-004: a running lane says what the hob waits on, from records only (#1004)
    const records = activity(BUILD, {
      attempt: attempt(BUILD, "running"),
      steps: [{ id: "think", kind: "thinking", label: "Thinking", state: "done", startedAt: AT(13) }],
      commands: [
        command(BUILD, "pnpm dev", 14, { state: "running", exitCode: null, endedAt: null }),
        command(BUILD, "pnpm lint", 15, { endedAt: AT(16) }),
      ],
    });
    const lane = laneOf(laneRoom(handedOn(), [records]), ADA);
    expect(lane.items.at(-1)).toMatchObject({ kind: "now", label: "Waiting on pnpm dev", since: AT(16) });
    expect(lane.plain.at(-1)).toMatchObject({ kind: "now", label: "Waiting for dev to finish", since: AT(16) });
    // A step that runs is what the turn is on, even with a command left running beside it.
    const busy = activity(BUILD, {
      ...records,
      steps: [{ id: "edit", kind: "tool", label: "Editing page.astro", state: "running", startedAt: AT(17) }],
    });
    expect(laneOf(laneRoom(handedOn(), [busy]), ADA).items.at(-1)).toMatchObject({
      label: "Editing page.astro",
      since: AT(17),
    });
    // With nothing read yet, the turn's last sign is the newest the tree records: here its last beat.
    expect(laneOf(laneRoom(handedOn(), []), ADA).items.at(-1)).toMatchObject({ label: null, since: AT(12) });
  });

  it("says a step that was stopped once, however often the hob tried it again", () => {
    const denied = (id: string, second: number): ReplyStep => ({
      id,
      kind: "tool",
      label: "Running rm -- scratch.txt && cat > check.sh <<'EOF'",
      state: "denied",
      call: { tool: "Bash", operation: "outside-folders", targets: ["/work/site"] },
      reason: "Hobbots could not resolve the folder, so it stays closed.",
      decidedBy: "policy",
      startedAt: AT(second),
    });
    const records = activity(BUILD, {
      steps: [denied("d1", 2), denied("d2", 3), denied("d3", 6)],
      commands: [command(BUILD, "ls -la", 1), command(BUILD, "bash check.sh; echo done", 4)],
      changes: [change(BUILD, "src/index.ts", "edited", 7), change(BUILD, "test/index.ts", "edited", 8)],
    });
    const lane = laneOf(laneRoom(handedOn(), [records]), ADA);
    // The same stopped step tried again later still shows once; two files with one name keep a line each.
    expect(lane.plain.map(line)).toEqual([
      "step blocked Stopped a step that could reach outside its folders",
      "step done Ran check.sh",
      "step done Updated index.ts",
      "step done Updated index.ts",
      `in Landing copy ← ${QUILL}`,
      "beat Page scaffolded",
      "now -",
    ]);
  });

  it("shows the Task tool calls the hub refused in plain words, never the message meant for the hob", () => {
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
    expect(lines(lane)).toEqual(["refused Completing the Task: work under it was still open"]);
    // The hub keeping order is not news in everyday words: the hob goes on after it.
    expect(lane.plain).toEqual([]);
    const odd = new RefusedCall({ ...refused, id: RefusedCallId.make("r2"), reason: "claim-stale" });
    const quiet = laneOf(laneRoom(tree({ ...blackFriday(), refusals: [odd] }), []), QUILL);
    expect(lines(quiet)).toEqual(["refused Completing the Task: "]);
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

  it("lights a hob's lane for a question or an approval on any of its Tasks, not only the first", () => {
    const SIGNS = TaskId.make("signs");
    const base = blackFriday();
    const two = (fields: Partial<ConstructorParameters<typeof TaskTree>[0]>) =>
      tree({
        ...base,
        tasks: [...base.tasks, task(SIGNS, { ownerId: QUILL, brief: "Make the signs", state: "waiting", second: 6 })],
        delegations: [...base.delegations, delegation(QUILL, SIGNS, "Make the signs")],
        ...fields,
      });
    const asked = laneRoom(two({ questions: [question(SIGNS, QUILL, "Which font?", { recipientId: null })] }), []);
    expect(laneOf(asked, QUILL)).toMatchObject({ title: "Draft the landing copy", status: "needs-you" });
    expect(laneOf(asked, ALDRIC).status).toBe("running");
    expect(laneOf(asked, ADA).status).toBe("waiting");
    const approving = laneRoom(two({ approvals: [memberApproval(SIGNS, QUILL)] }), []);
    expect(laneOf(approving, QUILL).status).toBe("needs-you");
    expect(laneOf(approving, ADA).status).toBe("waiting");
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

  it("shows the try picked in the room in place of the latest, and reads the running one too", () => {
    const first = attempt(COPY, "failed");
    const second = new Attempt({ ...first, id: AttemptId.make("a-copy-2"), number: 2, state: "running" });
    const base = blackFriday();
    const retried = tree({
      ...base,
      tasks: base.tasks.map((each) => (each.id === COPY ? new Task({ ...each, currentAttemptId: second.id }) : each)),
      attempts: [...base.attempts.filter((each) => each.taskId !== COPY), first, second],
      checkpoints: [
        report(COPY, "First draft", 3, { attemptId: first.id }),
        report(COPY, "Trying again", 4, { attemptId: second.id }),
      ],
    });
    const picks = new Map([[COPY, first.id]]);
    const room = laneRoom(
      retried,
      [activity(COPY, { attempt: first, commands: [command(COPY, "pnpm old", 2)] })],
      picks,
    );
    expect(lines(laneOf(room, QUILL))).toEqual(["run pnpm old", "beat First draft", "now -"]);
    expect(laneAttempts(retried, picks)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(laneAttempts(retried)).not.toContain(first.id);
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

  it("folds a Task's older marks into one count where the first was, so no mark moves into another Task", () => {
    const mark = (key: string): LaneItem => ({ kind: "read", key, path: key });
    const items: ReadonlyArray<LaneItem> = [
      { kind: "task", key: "task-a", title: "A" },
      mark("a1"),
      { kind: "result", key: "result-a", outcome: "completed", text: "A done" },
      { kind: "task", key: "task-b", title: "B" },
      mark("b1"),
      { kind: "hand-in", key: "hand", label: "Copy", from: QUILL },
      mark("b2"),
      ...["r1", "r2"].map(mark),
    ];
    expect(foldMarks(items, 2).map(line)).toEqual([
      "task A",
      "folded 1",
      "completed A done",
      "task B",
      "folded 2",
      `in Copy ← ${QUILL}`,
      "read r1",
      "read r2",
    ]);
    const opened = foldMarks(items, 2).flatMap(
      (item): ReadonlyArray<LaneItem> => (item.kind === "folded" ? item.marks : [item]),
    );
    expect(opened).toEqual([...items.slice(0, 5), items[6], items[5], ...items.slice(7)]);
  });

  it("folds a hob's older marks inside the Task they belong to when it has two Tasks", () => {
    const SIGNS = TaskId.make("signs");
    const base = blackFriday();
    const signs = new Task({
      ...task(SIGNS, { ownerId: QUILL, brief: "Make the signs", second: 6 }),
      currentAttemptId: null,
    });
    const room = laneRoom(
      tree({
        ...base,
        tasks: [
          ...base.tasks.map((each) =>
            each.id === COPY
              ? task(COPY, { ownerId: QUILL, state: "completed", brief: "Draft the landing copy", second: 2 })
              : each,
          ),
          signs,
        ],
        attempts: [attempt(COPY, "completed"), attempt(SIGNS, "completed")],
        delegations: [...base.delegations, delegation(QUILL, SIGNS, "Make the signs")],
      }),
      [
        activity(COPY, { commands: [command(COPY, "pnpm copy", 1)] }),
        activity(SIGNS, {
          attempt: attempt(SIGNS, "completed"),
          commands: Array.from({ length: SHOWN_MARKS + 1 }, (_, index) => command(SIGNS, `sign ${index}`, index + 10)),
        }),
      ],
    );
    expect(lines(laneOf(room, QUILL)).slice(0, 6)).toEqual([
      "task Draft the landing copy",
      "folded 1",
      "completed -",
      "task Make the signs",
      "folded 1",
      "run sign 1",
    ]);
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

  it("says who each of a hob's unfinished Tasks waits on, in that Task's part of the lane", () => {
    const SIGNS = TaskId.make("signs");
    const base = blackFriday();
    const room = laneRoom(
      tree({
        ...base,
        tasks: [...base.tasks, task(SIGNS, { ownerId: QUILL, brief: "Make the signs", state: "waiting", second: 6 })],
        delegations: [...base.delegations, delegation(QUILL, SIGNS, "Make the signs")],
        waits: [new TaskWait({ taskId: SIGNS, on: [BUILD], mode: "all", createdAt: AT(7) })],
      }),
      [],
    );
    const lane = laneOf(room, QUILL);
    expect(lane.title).toBe("Draft the landing copy");
    expect(lines(lane)).toEqual(["task Draft the landing copy", "task Make the signs", `wait ${ADA}`]);
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
    expect(lane.tasks.map((each) => each.id)).toEqual([COPY, SIGNS]);
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

  it("names a member that started a Quest of its own its lead before it brought anyone in", () => {
    const base = blackFriday();
    const room = laneRoom(
      tree({
        ...base,
        quests: [
          ...base.quests,
          new Quest({ ...quest(), id: QuestId.make("quest-build"), taskId: BUILD, leadId: ADA, depth: 2 }),
        ],
      }),
      [],
    );
    expect(laneOf(room, ADA).role).toEqual({ kind: "leads", members: [] });
    expect(laneOf(room, QUILL).role).toEqual({ kind: "member" });
    expect(room.lanes.map((node) => node.party.length)).toEqual([0, 0, 0]);
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
