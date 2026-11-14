import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  ApprovalService,
  CharmCallService,
  Charms,
  FolderSandbox,
  type PromptRequest,
  TaskRepository,
} from "@hobbots/agents";
import { UserSession } from "@hobbots/api";
import {
  GITHUB_CHARM,
  GitHubAccountLive,
  GitHubApiNode,
  GitHubCharm,
  GitHubSignInNode,
  GitPushLive,
  GitRemotes,
  KeychainMemory,
  LocalGitHubSignInsNone,
} from "@hobbots/charms";
import { type FakeGitHub, startFakeGitHub } from "@hobbots/charms/testing";
import {
  type ApprovalRequest,
  declaredOperations,
  EMPTY_HOB_POLICY,
  type HobPolicy,
  OWNER_ACTOR,
  OWNER_USER_ID,
  type Task,
  WINDOW_DEVICE_ID,
} from "@hobbots/domain";
import { waitToFind, waitUntil } from "@hobbots/domain/testing";
import { PolicyEngine } from "@hobbots/permissions";
import { CharmCallsLive, EventJournal, GitHubAccountRepository, TaskRepositoryLive } from "@hobbots/persistence";
import { type HubCallRuntime, hubCallRuntimes } from "@hobbots/runtimes/testing";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  givePolicy,
  hub,
  memberTask,
  messagesWhen,
  PIP,
  project,
  promptsTo,
  QUILL,
  ROOK,
  send,
  sharedDatabase,
  startHub,
  taskOf,
  threadId,
  treeWhen,
} from "./dependency-hub.ts";

// #1343 (ADR 038): a party member that holds the GitHub Charm is offered its writes in its Task's
// session, as the lead is in its chat. It comments after one approval card, pushes and opens a pull
// request under Allow, each once, against a fake GitHub on a local port. A write whose answer is lost
// is read back, and one that stays uncertain waits on its Task until you settle it there. A write the
// member's authority answers Never for is not offered and never reaches GitHub. On SQLite and
// PostgreSQL (TestDatabase). The member's session runs on the fake runtime, and in TC-OR-1343-01 also
// on an installed Claude Code and Codex where HOBBOTS_CLAUDE_CODE and HOBBOTS_CODEX name them, each
// with a stand-in model that makes the calls, so no account or real model is used.

const TOKEN = "github_pat_member_writes";
const SLUG = "octo/workshop";

const git = (...args: Array<string>) =>
  execFileSync("git", args, {
    cwd: project,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: project,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Rook",
      GIT_AUTHOR_EMAIL: "rook@example.com",
      GIT_COMMITTER_NAME: "Rook",
      GIT_COMMITTER_EMAIL: "rook@example.com",
    },
  }).trim();

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** Stands in for the hob's sandbox, which CI cannot start: the Charm's fence is proven in TC-PE-152. */
const PlainSandbox = Layer.succeed(
  FolderSandbox,
  FolderSandbox.of({
    readOnly: (_folders, program, args) =>
      Effect.succeed({ commandLine: `sh -c ${quote(`exec ${[program, ...args].map(quote).join(" ")}`)}`, env: {} }),
  }),
);

let github: FakeGitHub;

beforeAll(async () => {
  github = await startFakeGitHub({ folder: join(project, "..", "github"), login: "otaviobarros", tokens: [TOKEN] });
  git("init", "--quiet", "--initial-branch=main");
  git("remote", "add", "origin", `https://github.com/${SLUG}.git`);
  git("commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "First");
  github.createRepository({ owner: "octo", name: "workshop", from: project });
  github.install(SLUG);
  github.addItem(SLUG, { title: "Review the parser", author: "ada" });
});

afterAll(async () => {
  await github.close();
});

/** The GitHub Charm as the server registers it, reaching the fake GitHub with a token from the hub's environment. */
const githubCharm = () =>
  Charms.layer([GitHubCharm]).pipe(
    Layer.provide(
      Layer.mergeAll(
        GitHubApiNode(github.hosts.api),
        GitRemotes.layer,
        PolicyEngine.node,
        GitPushLive({ folder: join(project, "..", "charm"), httpsBase: github.base }).pipe(Layer.provide(PlainSandbox)),
        CharmCallsLive,
      ),
    ),
    Layer.provide(
      GitHubAccountLive({
        clientId: "Iv23liFakeHobbots",
        slug: "hobbots",
        environmentToken: Redacted.make(TOKEN),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            KeychainMemory,
            GitHubSignInNode(github.hosts),
            LocalGitHubSignInsNone,
            GitHubAccountRepository,
          ),
        ),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

/** Under Trusting, every hob holds the GitHub Charm: pushing and opening pull requests are allowed, commenting asks. */
const POLICY: HobPolicy = {
  ...EMPTY_HOB_POLICY,
  charms: { granted: ["github"], overrides: { "github.comment": "ask" } },
};

/** A hub over a new database whose members' Task sessions run on `members`, or the fake runtime. */
const startGitHubHub = async (members: HubCallRuntime | null = null, sandbox: "on" | "unavailable" = "on") => {
  const database = await sharedDatabase();
  const started = await startHub(
    database,
    [],
    githubCharm(),
    { preset: "trusting", charmOperations: declaredOperations([GITHUB_CHARM]), sandbox },
    members,
  );
  await started.run(givePolicy(POLICY));
  // You settle a Task's write as the user, through the same service the HTTP route calls.
  const user = Layer.succeed(UserSession, {
    deviceId: WINDOW_DEVICE_ID,
    name: "This computer's Hobbots window",
    kind: "window",
    userId: OWNER_USER_ID,
    actor: OWNER_ACTOR,
    whileApproved: (write) => write,
  });
  const settling = CharmCallService.layer.pipe(
    Layer.provide(Layer.mergeAll(CharmCallsLive, TaskRepositoryLive)),
    Layer.provide(database),
  );
  const asUser = <A, E>(effect: Effect.Effect<A, E, CharmCallService | UserSession>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(settling, user))));
  return { ...started, asUser };
};

const offered = (request: PromptRequest) => request.hubTools?.tools.map((tool) => tool.name) ?? [];

/** The runtime's own tools a delegation lists beside the hub tools (#1348). */
const RUNTIME_TOOLS = ["file_reads", "file_edits", "commands", "read_only_commands"];

/** The tools a `delegate_task` answer lists for its member with their answers, and those it lacks with why. */
const listedIn = (answer: string | undefined) => {
  if (answer === undefined) throw new Error("expected delegate_task's answer");
  const details = JSON.parse(answer.slice(answer.lastIndexOf("\n{") + 1)) as {
    readonly tools: Readonly<Record<string, string>>;
    readonly dropped: Readonly<Record<string, string>>;
  };
  return { ...details, hub: Object.keys(details.tools).filter((tool) => !RUNTIME_TOOLS.includes(tool)) };
};

const firstPrompt = (requests: ReadonlyArray<PromptRequest>, task: Task) =>
  waitToFind("the first prompt to the Task's session", () => promptsTo(requests, task)[0]);

/** Delegates `lines` to `hob`, which may push and open pull requests, and asks to comment, unless `decisions` say otherwise. */
const delegate = (hob: string, lines: ReadonlyArray<string>, decisions: Record<string, string> = {}) =>
  send([
    "Review the parser",
    hub("delegate_task", {
      key: `work-${hob}`,
      hob,
      brief: ["Review the parser and post the review", ...lines].join("\n"),
      authority: {
        decisions: {
          "read-files": "allow",
          "edit-files": "allow",
          push: "allow",
          "github.open-pull-request": "allow",
          "github.comment": "ask",
          "github.open-issue": "allow",
          ...decisions,
        },
        folders: "all",
      },
    }),
  ]);

const pendingIn = (requests: ReadonlyArray<ApprovalRequest>) => requests.find((each) => each.state === "pending");

/** The approval cards in the lead's thread once one waits. */
const cardsOnceAsked = waitUntil(
  ApprovalService.use((approvals) => approvals.listForThread(threadId)),
  (all) => pendingIn(all) !== undefined,
  { what: "an approval card" },
);

/** Allows the card that waits, just this once. */
const allowOnce = (cards: ReadonlyArray<ApprovalRequest>) =>
  ApprovalService.use((approvals) => {
    const pending = pendingIn(cards) as ApprovalRequest;
    return approvals.decide(pending.id, { decision: "approve", actionDigest: pending.actionDigest });
  });

const commentsOn = (number: number) => github.items(SLUG).find((item) => item.number === number)?.comments ?? [];

/** The runtimes this run covers: the fake runtime, and each installed one the environment names. */
const expectedRuntimes = [
  "fake",
  ...(process.env.HOBBOTS_CLAUDE_CODE === undefined ? [] : ["claude-code"]),
  ...(process.env.HOBBOTS_CODEX === undefined ? [] : ["codex"]),
];

/**
 * Rook, on `runtime`, comments after one approval card, pushes and opens a pull request under Allow,
 * in its Task's session. Each write reaches GitHub once, as your account.
 */
const writesOn = async (runtime: HubCallRuntime) => {
  const name = runtime.name;
  const branch = `feat/review-${name}`;
  const body = `The parser reads well on ${name}.`;
  git("checkout", "--quiet", "-B", branch, "main");
  git("commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", `Tidy the parser on ${name}`);
  const pushed = git("rev-parse", "HEAD");
  const { run, requests, answers } = await startGitHubHub(name === "fake" ? null : runtime);
  await run(
    delegate("Rook", [
      hub("github_comment", { key: `review-${name}`, folder: project, number: 1, body }),
      hub("github_push", { key: `push-${name}`, folder: project, branch }),
      hub("github_open_pull_request", { key: `pr-${name}`, folder: project, head: branch, title: `Tidy on ${name}` }),
      hub("github_open_issue", { key: `issue-${name}`, folder: project, title: `Parser notes on ${name}`, parent: 1 }),
      hub("complete_task", { delivered: true, key: `done-${name}`, summary: "Reviewed and opened a pull request" }),
    ]),
  );
  // The comment asks, as in chat: one card, under the lead's thread, for Rook.
  const cards = await run(cardsOnceAsked);
  expect(
    cards.filter((each) => each.state === "pending"),
    name,
  ).toEqual([expect.objectContaining({ agentId: ROOK, tool: "github_comment", operation: "github.comment" })]);
  const posted = () => commentsOn(1).filter((comment) => comment.body.startsWith(body));
  expect(posted(), name).toEqual([]);
  await run(allowOnce(cards));
  const tree = await run(treeWhen((each) => memberTask(each, ROOK)?.state === "completed"));
  const rook = taskOf(tree, ROOK);

  const request = await run(firstPrompt(requests, rook));
  // The session ran on this runtime: its model was handed Rook's brief.
  if (name !== "fake")
    expect(
      runtime.modelText().some((text) => text.includes(`review-${name}`)),
      name,
    ).toBe(true);
  expect(offered(request), name).toEqual(
    expect.arrayContaining(["github_push", "github_open_pull_request", "github_comment", "github_open_issue"]),
  );
  // What the delegation listed is what the session was offered, on this runtime (#1348).
  const listed = listedIn(answers.get("work-Rook"));
  expect([...listed.hub].sort(), name).toEqual([...offered(request)].sort());
  expect(listed.tools.github_comment, name).toBe("ask");
  // A `git push` from Rook's folder goes to github_push, as in chat.
  const steering = request.steering?.takeovers ?? [];
  expect(
    steering.map((each) => [each.operation, each.tool]),
    name,
  ).toEqual([["push", "github_push"]]);
  expect(await Effect.runPromise((steering[0] as (typeof steering)[number]).appliesIn(project)), name).toBe(true);

  // Each write reached GitHub once, as your account, and asked nothing else.
  expect(posted(), name).toEqual([expect.objectContaining({ author: "otaviobarros" })]);
  expect(github.headOf(SLUG, branch), name).toBe(pushed);
  expect(
    github.items(SLUG).filter((item) => item.pullRequest?.head === branch),
    name,
  ).toHaveLength(1);
  expect(answers.get(`push-${name}`), name).toContain("Pushed");
  expect(answers.get(`pr-${name}`), name).toContain("Opened draft pull request");
  // An issue under Allow opens as a sub-issue of #1, once (#1350).
  const notes = github.items(SLUG).filter((item) => item.title === `Parser notes on ${name}`);
  expect(notes, name).toEqual([expect.objectContaining({ author: "otaviobarros", pullRequest: null })]);
  expect(github.items(SLUG)[0]?.subIssues, name).toContain(notes[0]?.number);
  expect(answers.get(`issue-${name}`), name).toContain("It is a sub-issue of #1.");
  expect(await run(ApprovalService.use((approvals) => approvals.listForThread(threadId))), name).toHaveLength(1);
  expect(tree.refusals, name).toEqual([]);
};

describe("GitHub Charm writes in a member's Task session (ADR 038)", () => {
  // covers PE-003, PE-005, OR-002, ADR 038 (every runtime: Claude Code, Codex, fake)
  it("[TC-OR-1343-01] on each runtime, a member comments after one approval card, pushes, opens a pull request and a sub-issue under Allow, each once, and a git push is steered to github_push", async () => {
    const runtimes = await hubCallRuntimes();
    try {
      expect(runtimes.runtimes.map((runtime) => runtime.name)).toEqual(expectedRuntimes);
      for (const runtime of runtimes.runtimes) await writesOn(runtime);
    } finally {
      runtimes.close();
      git("checkout", "--quiet", "main");
    }
  }, 300_000);

  // covers EX-003, EX-004, PE-006
  it("[TC-OR-1343-02] a member's write whose answer is lost is read back as applied, and one still uncertain waits on its Task until you settle it there", async () => {
    git("checkout", "--quiet", "-B", "feat/lost");
    git("commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "Lost answer");
    const pushed = git("rev-parse", "HEAD");
    const { run, answers, asUser } = await startGitHubHub();
    // GitHub applies the push but its answer is lost; the comment's answer is lost before GitHub takes it.
    github.drop = { after: github.requests.length, when: "after" };
    github.answer = (sent) => (sent.method === "POST" && sent.path.endsWith("/comments") ? "drop" : undefined);
    try {
      await run(
        delegate("Rook", [
          hub("github_push", { key: "lost-push", folder: project, branch: "feat/lost" }),
          hub("github_comment", { key: "lost-comment", folder: project, number: 1, body: "Lost on the way." }),
          hub("complete_task", { delivered: true, key: "lost-done", summary: "Pushed; the comment is unclear" }),
        ]),
      );
      await run(allowOnce(await run(cardsOnceAsked)));
      const tree = await run(treeWhen((each) => memberTask(each, ROOK)?.state === "completed"));
      const rook = taskOf(tree, ROOK);

      // The push was found on GitHub at once, so it settled as applied without you.
      expect(github.headOf(SLUG, "feat/lost")).toBe(pushed);
      expect(answers.get("lost-push")).toContain("Pushed");
      // The comment is not there, which proves nothing: it waits on Rook's Task, where Rook is told you settle it.
      expect(answers.get("lost-comment")).toContain("the user can settle it from the Quest room or the Inbox");
      const waiting = await asUser(CharmCallService.use((calls) => calls.waitingOnTasks));
      expect(waiting).toEqual([
        {
          call: expect.objectContaining({ tool: "github_comment", state: "uncertain", messageId: null }),
          task: expect.objectContaining({ id: rook.id, ownerId: ROOK, threadId }),
        },
      ]);
      const attempt = waiting[0]?.call.attempt ?? "";

      // You looked on GitHub and settle it there; a second settlement is refused.
      const settled = await asUser(
        CharmCallService.use((calls) => calls.settle({ _tag: "Task", taskId: rook.id, attempt }, "not-sent")),
      );
      expect(settled).toMatchObject({
        state: "not-sent",
        result: expect.stringContaining("settled this call as not sent"),
      });
      const again = await asUser(
        CharmCallService.use((calls) => calls.settle({ _tag: "Task", taskId: rook.id, attempt }, "applied")).pipe(
          Effect.flip,
        ),
      );
      expect(again).toMatchObject({ _tag: "CharmCallSettled", state: "not-sent" });
      // Settled on another Task's name, it is not found.
      const tasks = await run(TaskRepository.use((each) => each.readThreadTrees(threadId)));
      const other = tasks[0]?.tasks.find((task) => task.id !== rook.id)?.id;
      if (other === undefined) throw new Error("expected the lead's Task");
      const elsewhere = await asUser(
        CharmCallService.use((calls) => calls.settle({ _tag: "Task", taskId: other, attempt }, "applied")).pipe(
          Effect.flip,
        ),
      );
      expect(elsewhere._tag).toBe("CharmCallNotFound");
      expect(await asUser(CharmCallService.use((calls) => calls.waitingOnTasks))).toEqual([]);
      expect(commentsOn(1).map((comment) => comment.body)).not.toContainEqual(expect.stringContaining("Lost on"));
    } finally {
      github.drop = null;
      github.answer = null;
    }
  }, 60_000);

  // covers PE-005, SEC-003
  it("[TC-OR-1343-03] a member whose authority answers Never for commenting is not offered it, and its call is refused on its Task without reaching GitHub", async () => {
    const { run, requests } = await startGitHubHub();
    const before = github.requests.length;
    await run(
      delegate(
        "Pip",
        [
          hub("github_comment", { key: "never-1", folder: project, number: 1, body: "Not allowed." }),
          hub("complete_task", { delivered: true, key: "never-done", summary: "Could not comment" }),
        ],
        { "github.comment": "deny" },
      ),
    );
    const tree = await run(treeWhen((each) => memberTask(each, PIP)?.state === "completed"));
    const pip = taskOf(tree, PIP);
    const tools = offered(await run(firstPrompt(requests, pip)));
    expect(tools).toEqual(expect.arrayContaining(["github_push", "github_open_pull_request"]));
    expect(tools).not.toContain("github_comment");
    // Its runtime refuses the call, and the hub records it with why (#1356).
    expect(tree.refusals).toEqual([
      expect.objectContaining({
        agentId: PIP,
        taskId: pip.id,
        tool: "github_comment",
        reason: "not-offered",
        message: expect.stringContaining("It is not offered because its answer is Never."),
      }),
    ]);
    expect(github.requests.slice(before).filter((sent) => sent.path.endsWith("/comments"))).toEqual([]);
  }, 60_000);
});

/**
 * Rook, on `runtime`, holds no GitHub Charm and is delegated a review to post: its session is not
 * offered `github_comment`, its runtime refuses the call, and the hub records it on Rook's Task with
 * why. The lead's read_tasks shows it (#1356).
 */
const notOfferedOn = async (runtime: HubCallRuntime) => {
  const name = runtime.name;
  const started = await startGitHubHub(name === "fake" ? null : runtime);
  const { run, answers } = started;
  await run(givePolicy({ ...POLICY, charms: { granted: [], overrides: {} } }));
  const before = github.requests.length;
  await run(
    delegate("Rook", [
      hub("github_comment", { key: `comment-${name}`, folder: project, number: 1, body: "Looks good." }),
      hub("complete_task", { delivered: false, key: `done-${name}`, summary: "Could not post the review" }),
    ]),
  );
  const tree = await run(treeWhen((each) => memberTask(each, ROOK)?.state === "completed"));
  const rook = taskOf(tree, ROOK);
  const why =
    "github_comment is not offered in this session, so it did not run. It is not offered because Rook does not hold the GitHub Charm.";
  expect(tree.refusals, name).toEqual([
    expect.objectContaining({
      agentId: ROOK,
      taskId: rook.id,
      tool: "github_comment",
      reason: "not-offered",
      message: why,
    }),
  ]);
  expect(
    github.requests.slice(before).filter((sent) => sent.path.endsWith("/comments")),
    name,
  ).toEqual([]);
  // The lead reads it with read_tasks, as it reads the member's state.
  await run(send(["Where does the review stand?", hub("read_tasks", { key: `read-${name}` })]));
  await run(messagesWhen(() => answers.has(`read-${name}`)));
  const read = answers.get(`read-${name}`) ?? "";
  const details = JSON.parse(read.slice(read.indexOf("\n{") + 1)) as {
    readonly tasks: ReadonlyArray<{ readonly task_id: string; readonly refused_calls?: ReadonlyArray<unknown> }>;
  };
  expect(details.tasks.find((task) => task.task_id === rook.id)?.refused_calls, name).toEqual([
    expect.objectContaining({ tool: "github_comment", reason: "not-offered", message: why }),
  ]);
};

describe("A call to a tool a member's session was not offered (#1356)", () => {
  // covers PE-001, OR-002, ADR 014 (Enforcement)
  it("[TC-OR-1356-01] on each runtime, a member's call to github_comment it holds no Charm for is refused on its Task with why, and read_tasks shows it", async () => {
    const runtimes = await hubCallRuntimes();
    try {
      expect(runtimes.runtimes.map((runtime) => runtime.name)).toEqual(expectedRuntimes);
      for (const runtime of runtimes.runtimes) await notOfferedOn(runtime);
    } finally {
      runtimes.close();
    }
  }, 300_000);

  // covers PE-001, PE-005, ADR 014 (Enforcement)
  it("[TC-OR-1356-03] a member's command, where its runtime cannot start its sandbox, is refused on its Task naming that, as its lead's delegation does", async () => {
    const { run } = await startGitHubHub(null, "unavailable");
    await run(
      delegate("Rook", [
        hub("Bash", { command: "pnpm test" }),
        hub("complete_task", { delivered: false, key: "no-box-done", summary: "Could not run the tests" }),
      ]),
    );
    const tree = await run(treeWhen((each) => memberTask(each, ROOK)?.state === "completed"));
    expect(tree.refusals).toEqual([
      expect.objectContaining({
        agentId: ROOK,
        taskId: taskOf(tree, ROOK).id,
        tool: "Bash",
        reason: "not-offered",
        message:
          "Bash is not offered in this session, so it did not run. It is not offered because Rook's runtime cannot start its sandbox on this hub.",
      }),
    ]);
  }, 60_000);

  // covers PE-001, ADR 014 (Enforcement)
  it("[TC-OR-1356-02] a lead's call in chat to a tool its turn was not offered shows as a refused step, recorded on the Task it works on", async () => {
    const { run } = await startGitHubHub();
    await run(
      send([
        "Review the parser",
        hub("delegate_task", {
          key: "chat-work",
          hob: "Rook",
          brief: ["Review the parser", hub("complete_task", { delivered: true, key: "cw", summary: "Read it" })].join(
            "\n",
          ),
          authority: { decisions: { "read-files": "allow" }, folders: "all" },
        }),
        hub("post_to_slack", { text: "Started the review." }),
      ]),
    );
    const said = "post_to_slack is not offered in this session, so it did not run.";
    const tree = await run(treeWhen((each) => each.refusals.length > 0));
    const top = tree.tasks[0] as Task;
    expect(tree.refusals).toEqual([
      expect.objectContaining({ taskId: top.id, tool: "post_to_slack", reason: "not-offered", message: said }),
    ]);
    const messages = await run(messagesWhen((all) => all.some((m) => m.steps.some((step) => step.state === "denied"))));
    const steps = messages.flatMap((m) => m.steps).filter((step) => step.state === "denied");
    expect(steps).toEqual([expect.objectContaining({ label: "post_to_slack", reason: said, decidedBy: "policy" })]);
  }, 60_000);
});

describe("gh in a member's commands (#1349)", () => {
  // covers PE-005, SEC-002, ADR 020
  it("[TC-OR-1349-01] a member's gh pr comment is refused at once with a pointer to github_comment, reaches nothing, and its turn goes on", async () => {
    const { run, answers, denied } = await startGitHubHub();
    const before = github.requests.length;
    await run(
      delegate("Rook", [
        `fake:tool Bash gh pr comment 1 --body 'Looks good'`,
        hub("complete_task", { delivered: true, key: "gh-done", summary: "Could not comment with gh" }),
      ]),
    );
    const tree = await run(treeWhen((each) => memberTask(each, ROOK)?.state === "completed"));
    expect(taskOf(tree, ROOK).state).toBe("completed");
    expect(denied).toEqual([
      expect.objectContaining({
        tool: "Bash",
        decidedBy: "policy",
        reason: expect.stringContaining("Use the github_comment tool instead of gh pr comment"),
      }),
    ]);
    // The lead was warned that the brief names gh, before the member started.
    expect(answers.get("work-Rook")).toContain("Warning: the brief names gh, which no hob can run");
    expect(github.requests.slice(before).filter((sent) => sent.path.endsWith("/comments"))).toEqual([]);
  }, 60_000);
});

/** The tree of the lead's request, or none while nothing started it. */
const threadTrees = TaskRepository.use((tasks) => tasks.readThreadTrees(threadId));

/** The member's first session prompt, once its Task completed, and the tools its delegation listed. */
const listedAndOffered = async (
  started: Awaited<ReturnType<typeof startGitHubHub>>,
  member: typeof ROOK,
  key: string,
) => {
  const tree = await started.run(treeWhen((each) => memberTask(each, member)?.state === "completed"));
  const request = await started.run(firstPrompt(started.requests, taskOf(tree, member)));
  return { listed: listedIn(started.answers.get(key)), offered: offered(request), tree };
};

describe("What a delegated member will be able to do, before it starts (#1348)", () => {
  // covers OR-002, PE-005, ADR 014 (Amendment: what a delegation tells its lead)
  it("[TC-OR-1348-01] a check lists the member's tools and answers, Charm tools included, and makes no Task and no records", async () => {
    const started = await startGitHubHub();
    const { run, answers } = started;
    const journal = await run(Effect.flatMap(Effect.service(EventJournal), (each) => each.head));
    const brief = "Review the parser and comment on issue 1";
    const authority = { decisions: { "read-files": "allow", "edit-files": "allow", push: "allow" }, folders: "all" };
    await run(send(["Check first", hub("delegate_task", { key: "same", hob: "Rook", brief, authority, check: true })]));
    await run(messagesWhen((all) => all.some((message) => message.role === "assistant")));
    const checked = answers.get("same") ?? "";
    expect(checked).toContain("Checked only: nothing was delegated, and no Task started.");
    expect(checked).toContain(
      "github_push, github_open_pull_request, and github_open_issue (Allow); github_comment (Ask).",
    );
    const { tools, dropped } = listedIn(checked);
    expect(tools).toMatchObject({
      file_reads: "allow",
      github_push: "allow",
      github_comment: "ask",
      github_open_pull_request: "allow",
      github_open_issue: "allow",
      github_search: "allow",
      delegate_task: "allow",
    });
    expect(Object.keys(dropped).filter((tool) => !RUNTIME_TOOLS.includes(tool))).toEqual([]);
    // Nothing started, and nothing about Tasks was recorded, not even the call's key.
    expect(await run(threadTrees)).toEqual([]);
    const since = await run(Effect.flatMap(Effect.service(EventJournal), (each) => each.readAfter(journal.sequence)));
    expect(since.filter((entry) => /^(Task|Quest|Delegation|ToolCall|Attempt)/.test(entry.type))).toEqual([]);

    // The same key then delegates, since the check kept none, and lists what Rook's session is offered.
    await run(
      send([
        "Delegate it",
        hub("delegate_task", {
          key: "same",
          hob: "Rook",
          brief: [brief, hub("complete_task", { delivered: true, key: "rook-done", summary: "Reviewed" })].join("\n"),
          authority,
        }),
      ]),
    );
    const { listed, offered: given } = await listedAndOffered(started, ROOK, "same");
    expect(answers.get("same")).toContain("Delegated Task");
    expect([...listed.hub].sort()).toEqual([...given].sort());
    expect(listed.tools).toEqual(listedIn(checked).tools);
  }, 60_000);

  // covers PE-005, SEC-003, ADR 038
  it("[TC-OR-1348-02] Never answers and a narrowing Delegation show as the session gets them, and a brief that needs a dropped tool warns", async () => {
    const started = await startGitHubHub();
    await started.run(
      delegate("Pip", [hub("complete_task", { delivered: true, key: "pip-done", summary: "Could not comment" })], {
        "github.comment": "deny",
        push: "ask",
      }),
    );
    const { listed, offered: given } = await listedAndOffered(started, PIP, "work-Pip");
    expect([...listed.hub].sort()).toEqual([...given].sort());
    expect(listed.tools.github_push).toBe("ask");
    expect(listed.dropped.github_comment).toBe("never");
    const answer = started.answers.get("work-Pip") ?? "";
    expect(answer).toContain("It will not be offered github_comment, since its answer is Never.");
    expect(answer).toContain(
      "Warning: the brief names commenting, but github_comment will not be offered: its answer is Never.",
    );
  }, 60_000);

  // covers PE-005, ADR 031
  it("[TC-OR-1348-03] a member that does not hold the GitHub Charm is told so before it starts, and its session is offered none of its tools", async () => {
    const started = await startGitHubHub();
    await started.run(givePolicy({ ...POLICY, charms: { granted: [], overrides: {} } }));
    await started.run(
      send([
        "Review the parser",
        hub("delegate_task", {
          key: "no-charm",
          hob: "Rook",
          brief: [
            "Review the parser and comment on it, then file an issue for each bug",
            hub("complete_task", { delivered: true, key: "nc", summary: "Read it" }),
          ].join("\n"),
          authority: { decisions: { "read-files": "allow", "edit-files": "allow" }, folders: "all" },
        }),
      ]),
    );
    const { listed, offered: given } = await listedAndOffered(started, ROOK, "no-charm");
    expect([...listed.hub].sort()).toEqual([...given].sort());
    expect(given.filter((tool) => tool.startsWith("github_"))).toEqual([]);
    expect(listed.dropped.github_comment).toBe("not-granted");
    const answer = started.answers.get("no-charm") ?? "";
    expect(answer.slice(0, answer.lastIndexOf("\n{"))).not.toContain("github_push");
    expect(answer).toContain("Warning: the brief names commenting, but github_comment will not be offered");
    expect(answer).toContain("opening an issue, but github_open_issue will not be offered");
  }, 60_000);

  // covers OR-004, ADR 014 (Amendment: what a delegation tells its lead)
  it("[TC-OR-1348-04] a check is refused as the delegation would be, past the depth limit or on a Task that is not a sibling, and keeps nothing", async () => {
    const started = await startGitHubHub();
    const { run, answers } = started;
    const check = { hob: "Rook", brief: "Review the parser", check: true };
    await run(send(["Check first", hub("delegate_task", { ...check, key: "outside", depends_on: ["nonexistent"] })]));
    await run(messagesWhen((all) => all.some((message) => message.role === "assistant")));
    expect(answers.get("outside")).toBe("Refused (dependency-outside-tree): A Task depends only on its siblings");
    expect(await run(threadTrees)).toEqual([]);

    // Pip, two Quests deep, checks bringing in Quill: a Quest 3 deep, as the delegation itself is refused.
    const pipBrief = [
      hub("delegate_task", { key: "deeper", hob: "Quill", brief: "Research some more", check: true }),
      hub("complete_task", { delivered: true, key: "pip-done", summary: "Did it myself" }),
    ].join("\n");
    await run(
      send([
        "Review the parser",
        hub("delegate_task", {
          key: "to-rook",
          hob: "Rook",
          brief: [hub("delegate_task", { key: "to-pip", hob: "Pip", brief: pipBrief })].join("\n"),
        }),
      ]),
    );
    const tree = await run(treeWhen((each) => memberTask(each, PIP)?.state === "completed"));
    expect(answers.get("deeper")).toBe(
      "Refused (depth-limit): This would be a Quest 3 deep, past the limit of 2. Do this work yourself, or split it into steps.",
    );
    expect(tree.tasks.map((task) => task.ownerId)).not.toContain(QUILL);
  }, 60_000);

  // covers PE-005, ADR 014
  it("[TC-OR-1348-05] where the member's runtime cannot start its sandbox, its commands are listed as dropped, as its session gets none, and a brief to run tests warns", async () => {
    const started = await startGitHubHub(null, "unavailable");
    const { run, answers } = started;
    const authority = { decisions: { "read-files": "allow", "edit-files": "allow" }, folders: "all" };
    await run(
      send([
        "Check first",
        hub("delegate_task", { key: "no-box", hob: "Rook", brief: "Run the tests", authority, check: true }),
      ]),
    );
    await run(messagesWhen((all) => all.some((message) => message.role === "assistant")));
    const answer = answers.get("no-box") ?? "";
    const { tools, dropped } = listedIn(answer);
    expect(tools.commands).toBeUndefined();
    expect(tools.file_edits).toBe("allow");
    expect(dropped.commands).toBe("no-sandbox");
    expect(answer).toContain(
      "Rook will have: file reads, file edits, git_init; no commands (its runtime has no sandbox here).",
    );
    expect(answer).toContain(
      "Warning: the brief names running commands, but commands will not be offered: Rook's runtime cannot start its sandbox on this hub.",
    );

    // Under Edit files Never its commands would be read-only: those are dropped and warned of too.
    const readOnly = { ...authority, decisions: { ...authority.decisions, "edit-files": "deny" } };
    await run(
      send([
        "Check again",
        hub("delegate_task", {
          key: "read-only",
          hob: "Rook",
          brief: "Run the tests",
          authority: readOnly,
          check: true,
        }),
      ]),
    );
    await run(messagesWhen((all) => all.filter((message) => message.role === "assistant").length >= 2));
    const again = answers.get("read-only") ?? "";
    expect(listedIn(again).dropped.read_only_commands).toBe("no-sandbox");
    expect(again).toContain(
      "Rook will have: file reads; no file edits, no read-only commands (its runtime has no sandbox here), no git_init.",
    );
    expect(again).toContain(
      "Warning: the brief names running commands, but read_only_commands will not be offered: Rook's runtime cannot start its sandbox on this hub.",
    );
    // The answer never promises commands the session will not have.
    for (const each of [answer, again]) expect(each).not.toMatch(/will have: [^;.]*commands/);
  }, 60_000);
});
