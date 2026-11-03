import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HobbotsRepository, HobTools, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  EMPTY_HOB_POLICY,
  TaskId,
  type TaskToolDone,
  type TaskToolRefused,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { delegatedAccess, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import { EventJournal, HobbotsRepositoryLive, TaskRepositoryLive, TaskToolCallsLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer, toolTurn } from "@hobbots/runtimes";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #582: a lead that named no folders gave its member every folder it could reach, the
// Hobbots repository and an unrelated one among them. Now the member gets the folders its brief
// names, or else the folder its lead's Task works in, and the policy engine refuses the rest, with
// the hub's own delegation, member narrowing and engine, and the records on SQLite or PostgreSQL.

const now = "2026-11-03T01:06:00.000Z";
const FRODO = AgentId.make("frodo");
const QUILL = AgentId.make("quill");
const threadId = ThreadId.make("badge");
const LEAD = TaskId.make("site");

let work: string;
/** The lead's three folders: the test folder it works in, the Hobbots source and another repository. */
let test: string;
let hobbots: string;
let other: string;

/** Every hob works in the three folders under the Balanced preset. */
const ThreeFolders = Layer.sync(HobTools, () =>
  HobTools.of({
    access: (agent) =>
      Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [test, hobbots, other],
          hob: EMPTY_HOB_POLICY,
          dataFolder: join(work, "data"),
          restrictions: [],
        },
        folders: [test, hobbots, other],
        runtimeFolder: join(work, "runtime", agent.id),
      }),
  }),
);

const App = TaskTools.layer("/").pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      HobbotsRepositoryLive,
      TaskRepositoryLive,
      TaskToolCallsLive,
      EventJournal.layer,
      EventBus.layer,
      NodeFolderChecks,
      ThreeFolders,
      FakeRuntimeLayer(),
      PolicyEngine.node,
    ).pipe(Layer.provideMerge(TestDatabase)),
  ),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-folders-")));
  test = join(work, "test");
  hobbots = join(work, "hobbots");
  other = join(work, "other");
  for (const folder of [join(test, "site"), hobbots, other]) mkdirSync(folder, { recursive: true });
  runtime = ManagedRuntime.make(App);
});

afterEach(async () => {
  await runtime.dispose();
  rmSync(work, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof App>>) => runtime.runPromise(effect);

const hob = (id: AgentId, name: string) =>
  new Agent({
    id,
    name,
    roleTitle: "Builder",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: now,
  });

/** Frodo's own Task, which he leads Quill on. */
const seed = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(hob(FRODO, "Frodo"));
  yield* repo.insertAgent(hob(QUILL, "Quill"));
  yield* repo.upsertThread(new Thread({ id: threadId, agentId: FRODO, title: "Site", createdAt: now, updatedAt: now }));
  yield* (yield* TaskRepository).createTask({
    task: {
      id: LEAD,
      ownerId: FRODO,
      parentId: null,
      threadId,
      brief: "Build the site",
      dependsOn: [],
      createdAt: now,
    },
    delegation: null,
    milestones: [],
  });
});

/** Frodo delegates `brief` to Quill, with `authority` if given. */
const delegate = (key: string, brief: string, authority?: object) =>
  Effect.flatMap(Effect.service(TaskTools), (tools) =>
    tools.call({ agentId: FRODO, taskId: LEAD }, "delegate_task", {
      key,
      task_id: LEAD,
      hob: "Quill",
      brief,
      ...(authority === undefined ? {} : { authority }),
    }),
  ) as Effect.Effect<TaskToolDone, TaskToolRefused, Layer.Success<typeof App>>;

/** The folders Quill's Task holds, and how the policy engine answers his calls on files in it. */
const quillOn = (done: TaskToolDone) =>
  Effect.gen(function* () {
    const taskId = TaskId.make(String(done.details?.task_id));
    const tree = Option.getOrThrow(yield* (yield* TaskRepository).readTree(LEAD));
    const task = tree.tasks.find((each) => each.id === taskId);
    const quill = Option.getOrThrow(yield* (yield* HobbotsRepository).findAgent(QUILL));
    const access = delegatedAccess(yield* (yield* HobTools).access(quill), task as never, tree, "/");
    const turn = toolTurn(access, "on");
    const engine = yield* PolicyEngine;
    const decide = (operation: "read-files" | "edit-files", path: string) =>
      engine.decide(turn?.context as never, { _tag: "Files", operation, paths: [path], cwd: turn?.folders[0] ?? "/" });
    return { folders: access?.folders, cwd: turn?.folders[0], decide };
  });

describe("A member its lead names no folders for", () => {
  // covers PE-002
  it("[TC-PE-300] works only in the folder its lead's Task works in, and is refused anywhere else with the place named", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const quill = yield* quillOn(yield* delegate("badge", "Make the shop badge"));
        return {
          ...quill,
          inside: yield* quill.decide("edit-files", join(test, "site", "badge.png")),
          read: yield* quill.decide("read-files", join(hobbots, "README.md")),
          edit: yield* quill.decide("edit-files", join(other, "notes.md")),
        };
      }),
    );
    expect(result.folders).toEqual([test]);
    expect(result.cwd).toBe(test);
    expect(result.inside.decision).toBe("allow");
    for (const [verdict, path] of [
      [result.read, join(hobbots, "README.md")],
      [result.edit, join(other, "notes.md")],
    ] as const) {
      expect(verdict).toMatchObject({
        decision: "deny",
        reason: { code: "outside-folders", message: `${path} is outside this hob's folders.` },
      });
    }
  });

  // covers PE-002
  it("[TC-PE-301] works in the folders its brief names inside the lead's, and in no other", async () => {
    const site = join(test, "site");
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const quill = yield* quillOn(yield* delegate("badge", `Make the shop badge.\nWork only in ${site}.`));
        return { ...quill, beside: yield* quill.decide("read-files", join(test, "budget.md")) };
      }),
    );
    expect(result.folders).toEqual([site]);
    expect(result.beside).toMatchObject({ decision: "deny", reason: { code: "outside-folders" } });
  });

  // covers PE-002
  it("[TC-PE-304] works in a quoted folder its brief names with a space in it, not the folder its first word names", async () => {
    const spaced = join(test, "my site");
    for (const folder of [spaced, join(test, "my")]) mkdirSync(folder, { recursive: true });
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        return yield* quillOn(yield* delegate("spaced", `Make the shop badge.\nWork only in "${spaced}".`));
      }),
    );
    expect(result.folders).toEqual([spaced]);
  });

  // covers PE-002
  it("[TC-PE-302] gets all of its lead's folders only when the lead asks for all, and never one the lead does not have", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed;
        const all = yield* quillOn(yield* delegate("all", "Tidy every repository", { folders: "all" }));
        const wider = yield* Effect.flip(delegate("wider", "Tidy the temp folder", { folders: [tmpdir()] }));
        return { all: all.folders, wider };
      }),
    );
    expect(result.all).toEqual([test, hobbots, other]);
    expect(result.wider).toMatchObject({ reason: "authority-wider" });
  });
});
