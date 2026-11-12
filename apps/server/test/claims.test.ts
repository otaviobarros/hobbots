import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ClaimRegister, HobbotsRepository, HobTools, TaskRepository } from "@hobbots/agents";
import {
  Agent,
  AgentId,
  AttemptId,
  type Claim,
  ClaimId,
  type ClaimScope,
  type TaskId,
  TaskId as TaskIds,
  type TaskToolDone,
  TaskToolRefused,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { MemoryProjectsLive } from "@hobbots/memory";
import { TaskTools } from "@hobbots/orchestration";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  ClaimRegisterLive,
  EventJournal,
  HobbotsRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { GitWorkspaceLive } from "@hobbots/workbench";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/sql";
import * as fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";

// #1388: the claims register across chats and camps. Two hobs work in two camps, each on a clone of
// one repository (a checkout and a linked worktree, which share its `origin`): the hub hands each
// of them its own migration number, read from `main` and from every claim, and on a path clash each
// lead hears of it through its backpack while neither Task stops. Against a real database: SQLite
// here, and PostgreSQL under `pnpm test:pg` (STD-TEST-006).

const now = "2026-11-11T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const SAM = AgentId.make("sam");
// Merry works only in the repository's docs folder.
const MERRY = AgentId.make("merry");
const MIGRATIONS = "packages/persistence/src/migrations";

let root: string;
let checkout: string;
let worktree: string;
let outside: string;

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd, stdio: "pipe" });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-claims-")));
  checkout = join(root, "app");
  worktree = join(root, "app-camp");
  mkdirSync(join(checkout, MIGRATIONS), { recursive: true });
  mkdirSync(join(checkout, "docs", "decisions"), { recursive: true });
  writeFileSync(join(checkout, MIGRATIONS, "0001_initial.ts"), "export {};\n");
  writeFileSync(join(checkout, MIGRATIONS, "0002_more.ts"), "export {};\n");
  writeFileSync(join(checkout, "docs", "decisions", "001-first.md"), "# First\n");
  git(root, "init", "-q", "-b", "main", checkout);
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "first");
  git(checkout, "remote", "add", "origin", "https://github.com/me/app.git");
  git(checkout, "worktree", "add", "-q", "-b", "camp", worktree);
  // A repository beside the checkout that no hob was given, and a link to it from inside the checkout.
  outside = join(root, "private");
  mkdirSync(join(outside, "docs", "decisions"), { recursive: true });
  writeFileSync(join(outside, "docs", "decisions", "001-secret.md"), "# Secret\n");
  git(root, "init", "-q", "-b", "main", outside);
  git(outside, "add", ".");
  git(outside, "commit", "-q", "-m", "first");
  symlinkSync(outside, join(checkout, "private-link"));
});

const folderOf: Record<string, () => string> = {
  [FRODO]: () => checkout,
  [SAM]: () => worktree,
  [MERRY]: () => join(checkout, "docs"),
};

const TestHobTools = Layer.sync(HobTools, () =>
  HobTools.of({
    access: (agent) =>
      Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [],
          hob: agent.policy,
          dataFolder: join(root, "data"),
          restrictions: [],
        },
        folders: [folderOf[agent.id]?.() ?? checkout],
        runtimeFolder: join(root, "runtimes", agent.id),
        commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
      }),
  }),
);

const App = TaskTools.layer(sep === "\\" ? "\\" : "/").pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mergeAll(
        HobbotsRepositoryLive,
        TaskRepositoryLive,
        TaskToolCallsLive,
        ApprovalRepositoryLive,
        BackpackLive,
        ClaimRegisterLive,
        EventJournal.layer,
      ).pipe(Layer.provideMerge(TestDatabase)),
      EventBus.layer,
      NodeFolderChecks,
      TestHobTools,
      GitWorkspaceLive,
      MemoryProjectsLive,
    ),
  ),
);
type Services = Layer.Success<typeof App>;

/** A hub on a fresh database, with Frodo and Sam each working on a request in a camp of their own. */
const hub = () => {
  const runtime = ManagedRuntime.make(App);
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
  const claim = (agentId: AgentId, taskId: TaskId, input: Record<string, unknown>) =>
    Effect.flatMap(Effect.service(TaskTools), (tools) => tools.call({ agentId, taskId }, "claim", input));
  const call = (agentId: AgentId, taskId: TaskId, input: Record<string, unknown>) => run(claim(agentId, taskId, input));
  const refused = (agentId: AgentId, taskId: TaskId, input: Record<string, unknown>) =>
    run(Effect.flip(claim(agentId, taskId, input)));
  /** A hob's request in a camp of its own, with its turn started unless `started` is false. */
  const request = (agentId: AgentId, taskId: TaskId, started = true, parentId: TaskId | null = null) =>
    run(
      Effect.gen(function* () {
        const repo = yield* HobbotsRepository;
        const threadId = ThreadId.make(`camp-${taskId}`);
        yield* repo.upsertThread(
          new Thread({ id: threadId, agentId, title: "Work", kind: "camp", createdAt: now, updatedAt: now }),
        );
        const tasks = yield* TaskRepository;
        const created = yield* tasks.createTask({
          task: {
            id: taskId,
            ownerId: agentId,
            parentId,
            threadId,
            brief: "Build",
            dependsOn: [],
            createdAt: now,
          },
          delegation: null,
          milestones: [],
        });
        if (!started) return;
        yield* tasks.startAttempt(taskId, created.value.revision, {
          id: AttemptId.make(`${taskId}-1`),
          runtime: "claude-code",
          sessionId: null,
          configVersion: 1,
          policyVersion: null,
          startedAt: now,
        });
      }),
    );
  const seed = run(
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      for (const [id, name] of [
        [FRODO, "Frodo"],
        [SAM, "Sam"],
        [MERRY, "Merry"],
      ] as const) {
        yield* repo.insertAgent(
          new Agent({
            id,
            name,
            roleTitle: "Engineer",
            runtime: "claude-code",
            model: null,
            effort: null,
            instructions: "",
            lookSeed: 1,
            lookColor: "moss",
            configVersion: 1,
            createdAt: now,
          }),
        );
      }
    }),
  );
  /** The claim-clash items in the backpack, by recipient and Task. */
  const clashItems = () =>
    run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{
          readonly recipientId: string;
          readonly taskId: string;
          readonly actionable: number | boolean;
        }>`SELECT recipient_id, task_id, actionable FROM backpack_items WHERE kind = 'claim-clash'
          ORDER BY recipient_id, task_id`,
      ),
    );
  const claimsOf = (taskId: TaskId) => run(Effect.flatMap(Effect.service(ClaimRegister), (r) => r.ofTask(taskId)));
  /** The Heads-ups a camp shows: each open clash, by who holds each side and on what. */
  const clashesIn = (threadId: string) =>
    run(Effect.flatMap(Effect.service(ClaimRegister), (r) => r.clashesIn(ThreadId.make(threadId)))).then((clashes) =>
      clashes.map((clash) => clash.sides.map((side) => [side.ownerId, side.claim.key, side.threadId])),
    );
  /** Ends a Task that never started a turn: you cancelled it. */
  const end = (taskId: TaskId) =>
    run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const task = Option.getOrThrow(yield* tasks.readTree(taskId)).tasks[0];
        if (task === undefined) throw new Error(`no Task ${taskId}`);
        yield* Effect.orDie(tasks.moveTask(taskId, task.revision, "cancelled", now));
      }),
    );
  /** Fails a member Task, then retries it: the same Task, open again. */
  const failAndRetry = (taskId: TaskId) =>
    run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const latest = Effect.gen(function* () {
          const task = Option.getOrThrow(yield* tasks.readTree(taskId)).tasks.find((each) => each.id === taskId);
          if (task === undefined) throw new Error(`no Task ${taskId}`);
          return task;
        });
        yield* tasks.updateAttempt(AttemptId.make(`${taskId}-1`), {
          _tag: "Ended",
          end: { _tag: "Failed", reason: "The build broke" },
          at: now,
        });
        const ended = yield* latest;
        if (ended.state !== "failed") yield* Effect.orDie(tasks.moveTask(taskId, ended.revision, "failed", now));
        yield* Effect.orDie(tasks.retryTask(taskId, (yield* latest).revision, now));
      }),
    );
  const taskOf = (taskId: TaskId) =>
    run(Effect.flatMap(Effect.service(TaskRepository), (tasks) => tasks.readTree(taskId))).then(
      (tree) => Option.getOrThrow(tree).tasks[0],
    );
  return {
    run,
    call,
    refused,
    request,
    seed,
    clashItems,
    claimsOf,
    clashesIn,
    end,
    failAndRetry,
    taskOf,
    dispose: () => runtime.dispose(),
  };
};

const A = TaskIds.make("task-frodo");
const B = TaskIds.make("task-sam");
const C = TaskIds.make("task-merry");
const MEMBER = TaskIds.make("task-frodo-member");

describe("the claims register", () => {
  // covers OR-004
  it("[TC-OR-1388-01] gives two quests in different camps different migration numbers, past what main has", async () => {
    const h = hub();
    try {
      await h.seed;
      await h.request(FRODO, A);
      await h.request(SAM, B);
      const input = { scope: "sequence", directory: MIGRATIONS } as const;
      // Asked at once, from a checkout and from a worktree of the same repository.
      const [frodo, sam] = (await Promise.all([
        h.call(FRODO, A, { key: "m", ...input }),
        h.call(SAM, B, { key: "m", ...input }),
      ])) as [TaskToolDone, TaskToolDone];
      expect([frodo.details.number, sam.details.number].sort()).toEqual(["0003", "0004"]);
      // A number already on main, or already held, is settled to the next free one.
      const asked = await h.call(SAM, B, { key: "m-asked", ...input, number: 2 });
      expect(asked.details.number).toBe("0005");
      expect(asked.message).toContain("0002 is taken");
      // ADR numbers count in their own folder.
      const adr = await h.call(FRODO, A, { key: "adr", scope: "sequence", directory: "docs/decisions" });
      expect(adr.details.number).toBe("002");
      // The same key again answers as the first call did, and hands out nothing new.
      expect((await h.call(FRODO, A, { key: "m", ...input })).details.number).toBe(frodo.details.number);
      expect((await h.claimsOf(A)).map((claim) => claim.key).sort()).toEqual([
        "2",
        String(Number(frodo.details.number)),
      ]);
    } finally {
      await h.dispose();
    }
  });

  // covers OR-004
  it("[TC-OR-1388-02] tells each lead of a path clash through its backpack and stops neither Task", async () => {
    const h = hub();
    try {
      await h.seed;
      await h.request(FRODO, A);
      await h.request(SAM, B);
      const first = await h.call(FRODO, A, { key: "p", scope: "path", path: "packages/domain/src/claim.ts" });
      expect(first.details.state).toBe("held");
      // Sam claims the folder that holds it, from the worktree: the same repository.
      const second = await h.call(SAM, B, { key: "p", scope: "path", path: "./packages/domain/" });
      expect(second.details.state).toBe("contested");
      expect(second.message).toContain("Neither Task was stopped");
      expect(second.details.clashes_with).toEqual([{ task_id: A, key: "packages/domain/src/claim.ts" }]);
      const items = await h.clashItems();
      expect(items.map((item) => [item.recipientId, item.taskId, Boolean(Number(item.actionable))])).toEqual([
        [FRODO, A, true],
        [SAM, B, true],
      ]);
      // Both Tasks go on, and both claims are contested.
      expect((await h.taskOf(A))?.state).toBe("active");
      expect((await h.taskOf(B))?.state).toBe("active");
      expect((await h.claimsOf(A)).map((claim) => claim.state)).toEqual(["contested"]);
      // Claiming the same path again changes nothing.
      const again = await h.call(SAM, B, { key: "p-again", scope: "path", path: "packages/domain" });
      expect(again.message).toContain("already holds");
      expect(await h.clashItems()).toHaveLength(2);
    } finally {
      await h.dispose();
    }
  });

  // covers OR-004
  it("[TC-OR-1390-03] shows a path clash in each camp it touches, once, until a Task that holds it ends", async () => {
    const h = hub();
    try {
      await h.seed;
      // Frodo's request never started a turn, so it can be cancelled below.
      await h.request(FRODO, A, false);
      await h.request(SAM, B);
      await h.call(FRODO, A, { key: "p", scope: "path", path: "web/badge.png" });
      expect(await h.clashesIn(`camp-${A}`)).toEqual([]);
      await h.call(SAM, B, { key: "p", scope: "path", path: "web" });
      const clash = [
        [FRODO, "web/badge.png", `camp-${A}`],
        [SAM, "web", `camp-${B}`],
      ];
      expect(await h.clashesIn(`camp-${A}`)).toEqual([clash]);
      expect(await h.clashesIn(`camp-${B}`)).toEqual([clash]);
      // A number is never a clash, and a camp with none of the Tasks shows nothing.
      await h.call(FRODO, A, { key: "m", scope: "sequence", directory: MIGRATIONS });
      expect(await h.clashesIn("camp-elsewhere")).toEqual([]);
      await h.end(A);
      expect(await h.clashesIn(`camp-${B}`)).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  // covers OR-004, OR-006
  it("[TC-OR-1388-03] releases a Task's claims when it ends, clears the claims it contested and never hands out its number again", async () => {
    const h = hub();
    try {
      await h.seed;
      await h.request(FRODO, A, false);
      await h.request(SAM, B);
      const input = { scope: "sequence", directory: MIGRATIONS } as const;
      expect((await h.call(FRODO, A, { key: "m", ...input })).details.number).toBe("0003");
      await h.call(FRODO, A, { key: "p", scope: "branch", branch: "feat/claims" });
      await h.call(SAM, B, { key: "p", scope: "branch", branch: "refs/heads/feat/claims" });
      expect((await h.claimsOf(B)).map((claim) => claim.state)).toEqual(["contested"]);
      await h.end(A);
      expect((await h.claimsOf(A)).map((claim) => claim.state)).toEqual(["released", "released"]);
      expect((await h.claimsOf(B)).map((claim) => claim.state)).toEqual(["held"]);
      // Number 3 went with Frodo's Task, and stays his: Sam gets 4.
      expect((await h.call(SAM, B, { key: "m", ...input })).details.number).toBe("0004");
      expect((await h.call(SAM, B, { key: "m3", ...input, number: 3 })).details.number).toBe("0005");
    } finally {
      await h.dispose();
    }
  });

  // covers OR-004, OR-007
  it("[TC-OR-1388-05] lets a retried Task claim again the path and branch its failure released", async () => {
    const h = hub();
    try {
      await h.seed;
      await h.request(FRODO, A);
      await h.request(FRODO, MEMBER, true, A);
      await h.call(FRODO, MEMBER, { key: "p", scope: "path", path: "docs" });
      await h.call(FRODO, MEMBER, { key: "b", scope: "branch", branch: "feat/claims" });
      await h.failAndRetry(MEMBER);
      expect((await h.claimsOf(MEMBER)).map((claim) => claim.state)).toEqual(["released", "released"]);
      // The released claims stay in the register; the retried Task holds new ones on the same names.
      expect((await h.call(FRODO, MEMBER, { key: "p2", scope: "path", path: "docs" })).details.state).toBe("held");
      expect((await h.call(FRODO, MEMBER, { key: "b2", scope: "branch", branch: "feat/claims" })).details.state).toBe(
        "held",
      );
      expect((await h.claimsOf(MEMBER)).map((claim) => claim.state).sort()).toEqual([
        "held",
        "held",
        "released",
        "released",
      ]);
    } finally {
      await h.dispose();
    }
  });

  // covers PE-002, PE-004
  it("[TC-OR-1388-06] claims nothing outside the hob's folders, whatever the folder's spelling", async () => {
    const h = hub();
    try {
      await h.seed;
      await h.request(FRODO, A);
      await h.request(MERRY, C);
      const adr = { scope: "sequence", directory: "docs/decisions" } as const;
      // Climbing out with "..", or through a link inside the hob's folder, reaches a repository it was not given.
      for (const folder of [`${checkout}${sep}..${sep}private`, join(checkout, "private-link"), outside]) {
        const refusal = await h.refused(FRODO, A, { key: `out-${folder}`, folder, ...adr });
        expect(refusal).toBeInstanceOf(TaskToolRefused);
        expect((refusal as TaskToolRefused).reason).toBe("not-a-repository");
      }
      // A hob given one folder of a repository claims only inside it.
      expect((await h.call(MERRY, C, { key: "adr", ...adr })).details.number).toBe("002");
      for (const input of [
        { key: "migration", scope: "sequence", directory: MIGRATIONS },
        { key: "path", scope: "path", path: "packages/domain" },
      ]) {
        expect(((await h.refused(MERRY, C, input)) as TaskToolRefused).reason).toBe("not-a-repository");
      }
      expect(await h.claimsOf(A)).toEqual([]);
    } finally {
      await h.dispose();
    }
  });
});

/** A step of the register's model test: a claim, two claims at once, or a Task ending. */
type Step =
  | { readonly _tag: "Claim"; readonly task: number; readonly scope: ClaimScope; readonly key: string }
  | {
      readonly _tag: "Together";
      readonly tasks: readonly [number, number];
      readonly scope: ClaimScope;
      readonly key: string;
    }
  | { readonly _tag: "End"; readonly task: number };

const TASKS = 3;
const keys = fc.constantFrom("a", "a/b", "b", "c");
const scopes = fc.constantFrom<ClaimScope>("sequence", "path", "branch");
const steps: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ _tag: fc.constant("Claim" as const), task: fc.nat({ max: TASKS - 1 }), scope: scopes, key: keys }),
  fc.record({
    _tag: fc.constant("Together" as const),
    tasks: fc.tuple(fc.nat({ max: TASKS - 1 }), fc.nat({ max: TASKS - 1 })),
    scope: scopes,
    key: keys,
  }),
  fc.record({ _tag: fc.constant("End" as const), task: fc.nat({ max: TASKS - 1 }) }),
);

/** The model: each claim by Task and key with its state, how many numbers were handed out, and which Tasks ended. */
interface Model {
  readonly claims: ReadonlyArray<{
    readonly task: number;
    readonly scope: ClaimScope;
    readonly key: string;
    state: string;
  }>;
  numbers: number;
  readonly ended: Set<number>;
}

const overlaps = (scope: ClaimScope, a: string, b: string) =>
  scope === "path" ? a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) : a === b;

/** Contested exactly while another Task's open claim on the same scope overlaps it. */
const settle = (model: Model) => {
  for (const claim of model.claims) {
    if (claim.state === "released" || claim.scope === "sequence") continue;
    const clashing = model.claims.some(
      (other) =>
        other !== claim &&
        other.state !== "released" &&
        other.task !== claim.task &&
        other.scope === claim.scope &&
        overlaps(claim.scope, claim.key, other.key),
    );
    claim.state = clashing ? "contested" : "held";
  }
};

const claimInModel = (model: Model, task: number, scope: ClaimScope, key: string) => {
  if (model.ended.has(task)) return;
  if (scope === "sequence") {
    model.numbers += 1;
    (model.claims as Array<Model["claims"][number]>).push({ task, scope, key: String(model.numbers), state: "held" });
    return;
  }
  if (
    model.claims.some(
      (each) => each.task === task && each.scope === scope && each.key === key && each.state !== "released",
    )
  )
    return;
  (model.claims as Array<Model["claims"][number]>).push({ task, scope, key, state: "held" });
  settle(model);
};

describe("ClaimRegister", () => {
  // covers OR-004
  it("[TC-OR-1388-04] agrees with a model of claims, clashes and releases over random runs, claims at once included", async () => {
    const taskIds = Array.from({ length: TASKS }, (_, index) => TaskIds.make(`model-${index}`));
    await fc.assert(
      fc.asyncProperty(fc.array(steps, { minLength: 1, maxLength: 10 }), async (run) => {
        const h = hub();
        try {
          await h.seed;
          for (const id of taskIds) await h.request(FRODO, id, false);
          const model: Model = { claims: [], numbers: 0, ended: new Set() };
          let made = 0;
          const claimOne = (task: number, scope: ClaimScope, key: string) => {
            made += 1;
            return h.run(
              Effect.flatMap(Effect.service(ClaimRegister), (register) =>
                register.claim({
                  id: ClaimId.make(`claim-${made}`),
                  scope,
                  repository: "github.com/me/app",
                  directory: scope === "sequence" ? MIGRATIONS : null,
                  key: scope === "sequence" ? null : key,
                  onMain: [],
                  asked: null,
                  taskId: taskIds[task] as TaskId,
                  actor: { kind: "hob", id: FRODO },
                  at: now,
                }),
              ),
            );
          };
          const open = (task: number) => !model.ended.has(task);
          for (const step of run) {
            if (step._tag === "Claim") {
              if (open(step.task)) await claimOne(step.task, step.scope, step.key);
              claimInModel(model, step.task, step.scope, step.key);
            } else if (step._tag === "Together") {
              const [x, y] = step.tasks;
              await Promise.all([x, y].filter(open).map((task) => claimOne(task, step.scope, step.key)));
              // Either order leaves the same claims and states.
              claimInModel(model, x, step.scope, step.key);
              claimInModel(model, y, step.scope, step.key);
            } else if (open(step.task)) {
              await h.end(taskIds[step.task] as TaskId);
              model.ended.add(step.task);
              for (const claim of model.claims) if (claim.task === step.task) claim.state = "released";
              settle(model);
            }
            const stored = (await Promise.all(taskIds.map((id) => h.claimsOf(id)))).flat();
            const shown = (claims: ReadonlyArray<{ task: number; scope: string; key: string; state: string }>) =>
              claims.map((each) => `${each.task} ${each.scope} ${each.key} ${each.state}`).sort();
            const index = (claim: Claim) => taskIds.indexOf(claim.taskId);
            // Numbers are compared as a set: two claims at once may take them in either order.
            expect(
              shown(stored.filter((each) => each.scope !== "sequence").map((each) => ({ ...each, task: index(each) }))),
            ).toEqual(shown(model.claims.filter((each) => each.scope !== "sequence")));
            const numbers = stored.filter((each) => each.scope === "sequence");
            expect(numbers.map((each) => Number(each.key)).sort((a, b) => a - b)).toEqual(
              Array.from({ length: model.numbers }, (_, n) => n + 1),
            );
            expect(numbers.map((each) => `${index(each)} ${each.state}`).sort()).toEqual(
              model.claims
                .filter((each) => each.scope === "sequence")
                .map((each) => `${each.task} ${each.state}`)
                .sort(),
            );
          }
        } finally {
          await h.dispose();
        }
      }),
      { numRuns: 25 },
    );
  }, 120_000);
});
