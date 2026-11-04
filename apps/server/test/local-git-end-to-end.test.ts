import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import {
  ActivityRecorder,
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PermissionSummary,
  SecretRedaction,
  TaskFiles,
} from "@hobbots/agents";
import type { AttemptActivityRead, ThreadTasksRead } from "@hobbots/api";
import { LocalGitToolsLive } from "@hobbots/charms";
import {
  type Agent,
  type ApprovalRequest,
  GIT_INIT_LABEL,
  isInProgress,
  type Message,
  roleFields,
  type Thread,
} from "@hobbots/domain";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ActivityRepositoryLive,
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer, userCommits } from "@hobbots/runtimes";
import { ActivityStoreLive, FolderScannerLive, HobFilesLive } from "@hobbots/workbench";
import { Effect, Layer, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { ToolLogsLive } from "../src/tool-logs.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// #578 at hub level: a hob on a Quest creates a Git repository in its empty folder and commits in
// it, with the hub's own composition (the local Git tools beside the Task tools), the fake runtime
// making the scripted calls, and the records on SQLite or PostgreSQL (TestDatabase). A `git init`
// command is pointed to `git_init`, the hub creates the repository, and the Workbench shows the
// commit command as succeeded. The fake runs no command, so the commit inside the real sandbox is
// TC-PE-320's.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-local-git-e2e-")));
const project = join(temp, "nettle-project");
const frodoProject = join(temp, "frodo-project");
const earlier = join(temp, "earlier-run");
const dataDir = join(temp, "data");
for (const folder of [project, frodoProject, earlier, dataDir]) mkdirSync(folder, { recursive: true });

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const LocalGit = LocalGitToolsLive({ stagingFolder: join(dataDir, "charms", "local-git") }).pipe(
    Layer.provide(Layer.mergeAll(PolicyEngine.node, NodeServices.layer)),
  );
  const App = HobLifecycle.layer
    .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer)))
    .pipe(Layer.provideMerge(ChatService.layer))
    .pipe(
      Layer.provideMerge(
        StepRunnerLive().pipe(Layer.provideMerge(TaskTools.layer("/")), Layer.provideMerge(TaskSignal.layer)),
      ),
    )
    .pipe(
      Layer.provideMerge(
        Layer.merge(ActivityRecorder.layer(), TaskFiles.layer.pipe(Layer.provide(HobFilesLive))).pipe(
          Layer.provideMerge(Layer.merge(FolderScannerLive, ActivityStoreLive(join(dataDir, "activity")))),
        ),
      ),
    )
    .pipe(Layer.provideMerge(ApprovalService.layer))
    .pipe(Layer.provideMerge(GrantService.layer))
    .pipe(Layer.provideMerge(HobToolsLive))
    .pipe(Layer.provideMerge(LocalGit))
    .pipe(Layer.provideMerge(CanonicalSharedFolders))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mergeAll(
            HobbotsRepositoryLive,
            ApprovalRepositoryLive,
            GrantRepositoryLive,
            TaskRepositoryLive,
            TaskToolCallsLive,
            ActivityRepositoryLive,
            EventJournal.layer,
            BackpackLive,
            SetupRepository.layer,
            SearchIndex.layer,
          ).pipe(Layer.provideMerge(TestDatabase)),
          EventBus.layer,
          HobAdmission.layer,
          NodeFolderChecks,
          FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)),
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
          SecretRedaction.layer([]),
          ToolLogsLive(join(dataDir, "tool-logs")),
        ),
      ),
    );
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(Layer.provide(TestDevices), Layer.provide(App), Layer.provide(NodeHttpServer.layerHttpServices)),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});

afterAll(async () => {
  await dispose();
  rmSync(temp, { recursive: true, force: true });
});

const request = async <A>(method: string, path: string, body?: unknown): Promise<{ status: number; body: A }> => {
  const response = await handler(
    new Request(`http://localhost:4578${path}`, {
      method,
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const eventually = <A>(read: () => Promise<A | undefined>) =>
  Effect.runPromise(
    Effect.tryPromise(read).pipe(
      Effect.flatMap((value) => (value === undefined ? Effect.fail("waiting" as const) : Effect.succeed(value))),
      Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 2_000 }),
    ),
  );

const messages = async (thread: Thread) =>
  (await request<ReadonlyArray<Message>>("GET", `/api/threads/${thread.id}/messages`)).body;

/** Sends `lines` as one message and waits until its reply has ended. */
const exchange = async (thread: Thread, ...lines: Array<string>) => {
  const before = (await messages(thread)).length;
  const sent = await request("POST", `/api/threads/${thread.id}/messages`, { content: lines.join("\n") });
  expect(sent.status).toBe(200);
  return eventually(async () => {
    const all = await messages(thread);
    const last = all.at(-1);
    return all.length >= before + 2 && last?.role === "assistant" && !isInProgress(last.status) ? last : undefined;
  });
};

const approvals = async (thread: Thread) =>
  (await request<ReadonlyArray<ApprovalRequest>>("GET", `/api/threads/${thread.id}/approvals`)).body;

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/** The thread's Quest attempts, once every one has ended. */
const endedAttempts = (thread: Thread, count: number) =>
  eventually(async () => {
    const [tree] = (await request<ThreadTasksRead>("GET", `/api/threads/${thread.id}/tasks`)).body.trees;
    const attempts = tree?.attempts ?? [];
    return attempts.length >= count && attempts.every((attempt) => attempt.state === "completed")
      ? attempts
      : undefined;
  });

describe("creating a Git repository from the sandbox, end to end", () => {
  // covers PE-005, UX-006
  it("[TC-PE-327] a hob initializes a repository in its empty folder and commits, and the Workbench shows the commit as succeeded", async () => {
    await request("PATCH", "/api/setup", {
      completed: true,
      safetyPreset: "balanced",
      approvedFolders: [project, frodoProject],
    });
    const nettle = (
      await request<Agent>("POST", "/api/agents", {
        name: "Nettle",
        ...roleFields("writer"),
        lookSeed: 578,
        lookColor: "moss",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
      })
    ).body;
    const thread = (await request<Thread>("POST", `/api/agents/${nettle.id}/threads`)).body;
    await exchange(thread, "Start a repository", hub("start_quest", { key: "quest", goal: "Start a repository" }));

    // A `git init` command is refused and points to git_init, which the hub runs.
    const created = await exchange(
      thread,
      "Make it a repository",
      "fake:tool Bash git init",
      hub("git_init", { folder: project }),
    );
    const refused = created.steps.find((step) => step.kind === "tool" && step.label.includes("git init"));
    expect(refused).toMatchObject({ state: "denied", reason: expect.stringContaining("git_init tool") });
    expect(created.steps.find((step) => step.label === GIT_INIT_LABEL)).toBeDefined();
    expect(existsSync(join(project, ".git", "HEAD"))).toBe(true);
    // Git's defaults and no hooks.
    expect(existsSync(join(project, ".git", "hooks"))).toBe(false);
    expect(
      execFileSync("git", ["-C", project, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).trim(),
    ).toBe("true");

    // Then it commits in the repository, as usual.
    await exchange(
      thread,
      "Commit the README",
      `fake:run ${JSON.stringify({
        command: "git add README.md && git commit -m 'First'",
        writes: { "README.md": "# Nettle's project\n" },
        output: "[main (root-commit) 1a2b3c4] First\n",
      })}`,
    );
    // The three turns on the Task share its one Attempt (#644), which ends after each reply.
    const attempts = await endedAttempts(thread, 1);
    const last = attempts.at(-1);
    if (last === undefined) throw new Error("no attempt");
    const { activity } = (await request<AttemptActivityRead>("GET", `/api/attempts/${last.id}/activity`)).body;
    expect(activity.commands.map(({ command, folder, state }) => ({ command, folder, state }))).toEqual([
      { command: "git add README.md && git commit -m 'First'", folder: project, state: "succeeded" },
    ]);
  });

  // covers PE-005, PE-003
  it("[TC-PE-442] a hob clears a folder holding an earlier repository and starts a new one, with no step for the user beyond approving the delete", async () => {
    await request("PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [earlier] });
    const git = (...args: Array<string>) =>
      execFileSync("git", ["-C", earlier, ...args], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      }).trim();
    git("init", "--quiet");
    writeFileSync(join(earlier, "README.md"), "# Earlier run\n");
    git("add", "README.md");
    git(
      "-c",
      "user.name=Frodo",
      "-c",
      "user.email=frodo@example.com",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "Earlier",
    );
    git("remote", "add", "origin", "https://example.com/earlier.git");
    writeFileSync(join(earlier, ".git", "hooks", "pre-commit"), "echo earlier\n");

    const frodo = (
      await request<Agent>("POST", "/api/agents", {
        name: "Frodo",
        ...roleFields("writer"),
        lookSeed: 663,
        lookColor: "moss",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
      })
    ).body;
    const thread = (await request<Thread>("POST", `/api/agents/${frodo.id}/threads`)).body;

    // A delete the hub can read is refused, since the repository's config and hooks are in it, and
    // the hob is told what it can do instead.
    const refused = await exchange(thread, "Start clean", `fake:tool Bash rm -rf ${earlier}`);
    expect(refused.steps.find((step) => step.kind === "tool")).toMatchObject({
      state: "denied",
      reason: expect.stringContaining("the git_init tool replaces it"),
    });
    expect(git("rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40}$/);

    // One the hub cannot read in full is asked about on Balanced: the user approves it, the one step they take.
    const sent = await request("POST", `/api/threads/${thread.id}/messages`, {
      content: [
        "Delete everything",
        `fake:run ${JSON.stringify({
          command: "rm -rf ./* ./.[!.]*",
          writes: { "README.md": null },
          output: `rm: ${earlier}/.git/config: Operation not permitted\n`,
          exitCode: 1,
        })}`,
      ].join("\n"),
    });
    expect(sent.status).toBe(200);
    const pending = await eventually(async () => {
      return (await approvals(thread)).find((approval) => approval.state === "pending");
    });
    await request("POST", `/api/approvals/${pending.id}/decision`, {
      decision: "approve",
      actionDigest: pending.actionDigest,
    });
    await eventually(async () => {
      const last = (await messages(thread)).at(-1);
      return last?.role === "assistant" && !isInProgress(last.status) ? last : undefined;
    });
    // The fake runs no command, so the test leaves what the real sandbox does (TC-PE-440): only the
    // repository's config and hooks.
    for (const name of readdirSync(join(earlier, ".git"))) {
      if (name !== "config" && name !== "hooks") rmSync(join(earlier, ".git", name), { recursive: true });
    }

    // git_init replaces that .git with a new repository, and asks nothing more.
    const created = await exchange(thread, "Make it a repository", hub("git_init", { folder: earlier }));
    expect(created.steps.find((step) => step.label === GIT_INIT_LABEL)).toMatchObject({ state: "done" });
    expect(git("rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(() => git("rev-parse", "--verify", "--quiet", "HEAD")).toThrow();
    expect(existsSync(join(earlier, ".git", "hooks"))).toBe(false);
    expect(readFileSync(join(earlier, ".git", "config"), "utf8")).not.toContain("earlier.git");
    expect(readdirSync(earlier)).toEqual([".git"]);
    expect(await approvals(thread)).toHaveLength(1);
  });

  // covers PE-005, OR-007
  it("[TC-PE-424] a refused git_init is recorded with its reason and fails its step, and one that created a repository is on the Task", async () => {
    await request("PATCH", "/api/setup", {
      completed: true,
      safetyPreset: "balanced",
      approvedFolders: [project, frodoProject],
    });
    const frodo = (
      await request<Agent>("POST", "/api/agents", {
        name: "Frodo",
        ...roleFields("writer"),
        lookSeed: 664,
        lookColor: "moss",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
      })
    ).body;
    const thread = (await request<Thread>("POST", `/api/agents/${frodo.id}/threads`)).body;
    await exchange(thread, "Start a repository", hub("start_quest", { key: "quest", goal: "Start a repository" }));
    // A repository is already there, so the first git_init is refused; the second makes one in a new folder.
    execFileSync("git", ["init", "--quiet", frodoProject], {
      env: { PATH: process.env.PATH, HOME: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    const inner = join(frodoProject, "app");
    const reply = await exchange(
      thread,
      "Make it a repository",
      hub("git_init", { folder: frodoProject }),
      hub("git_init", { folder: inner }),
    );
    const [refusedStep, createdStep] = reply.steps.filter((step) => step.label === GIT_INIT_LABEL);
    expect(refusedStep).toMatchObject({ state: "failed" });
    expect(JSON.stringify(refusedStep)).toContain("is already a Git repository");
    expect(createdStep).toMatchObject({ state: "done" });

    const [tree] = (await request<ThreadTasksRead>("GET", `/api/threads/${thread.id}/tasks`)).body.trees;
    expect(tree?.refusals).toEqual([
      expect.objectContaining({
        agentId: frodo.id,
        taskId: tree?.tasks[0]?.id,
        tool: "git_init",
        key: null,
        reason: "charm-refused",
        message: expect.stringContaining("is already a Git repository"),
      }),
    ]);
    // Whoever reads the work sees who created the repository.
    expect(tree?.checkpoints.map((checkpoint) => checkpoint.summary)).toContain(
      `git_init: Created an empty Git repository in ${inner}.`,
    );
  });

  // covers PE-005, PE-006
  it("[TC-PE-445] a member's commit as another hob is refused with the identity it commits as, and its plain commit runs", async () => {
    await request("PATCH", "/api/setup", {
      completed: true,
      safetyPreset: "balanced",
      approvedFolders: [project, frodoProject],
    });
    // Pip has no GitHub App of its own, so it commits as the user (ADR 018).
    const pip = (
      await request<Agent>("POST", "/api/agents", {
        name: "Pip",
        ...roleFields("writer"),
        lookSeed: 700,
        lookColor: "moss",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
      })
    ).body;
    const thread = (await request<Thread>("POST", `/api/agents/${pip.id}/threads`)).body;
    await exchange(thread, "Keep a ledger", hub("start_quest", { key: "quest", goal: "Keep a ledger" }));

    const bot = "frodo-hobbots[bot]";
    const asFrodo = `git -c user.name=${bot} -c user.email=351716127+${bot}@users.noreply.github.com commit -m 'chore: pocket ledger v0.1'`;
    const refused = await exchange(thread, "Commit the ledger as Frodo", `fake:tool Bash ${asFrodo}`);
    expect(refused.steps.find((step) => step.kind === "tool" && step.label.includes(`user.name=${bot}`))).toMatchObject(
      {
        state: "denied",
        reason: expect.stringContaining("made as the user, with the identity their Git config sets"),
      },
    );

    // Told why, it commits without the override, which runs.
    const committed = await exchange(
      thread,
      "Commit the ledger",
      `fake:run ${JSON.stringify({
        command: "git commit -m 'chore: pocket ledger v0.1'",
        output: "[main 1a2b3c4] chore: pocket ledger v0.1\n",
      })}`,
    );
    expect(committed.steps.find((step) => step.kind === "tool" && step.label.includes("git commit"))).toMatchObject({
      state: "done",
    });

    // The fake runs no command, so each one runs here as the hub runs a command of a hob on the
    // user's account (#586): the refused one would commit as Frodo's bot, and the retried one
    // commits as the user.
    const home = join(temp, "pip-home");
    const ledger = join(temp, "ledger");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Otavio\n\temail = otavio@example.com\n");
    const env = userCommits({}, home).env({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" });
    const run = (command: string) => execFileSync("sh", ["-c", command], { cwd: ledger, env, encoding: "utf8" });
    const author = () => run("git log -1 --format='%an <%ae>|%cn <%ce>'").trim();
    execFileSync("git", ["init", "--quiet", ledger], { env });
    run("git commit --quiet --allow-empty -m 'chore: start'");
    run(`${asFrodo.replace(" commit ", " commit --quiet --allow-empty ")}`);
    expect(author()).toBe(
      `${bot} <351716127+${bot}@users.noreply.github.com>|${bot} <351716127+${bot}@users.noreply.github.com>`,
    );
    run("git commit --quiet --allow-empty -m 'chore: pocket ledger v0.1'");
    expect(author()).toBe("Otavio <otavio@example.com>|Otavio <otavio@example.com>");
  });
});
