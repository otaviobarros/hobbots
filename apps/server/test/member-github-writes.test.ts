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
import { CharmCallsLive, GitHubAccountRepository, TaskRepositoryLive } from "@hobbots/persistence";
import { type HubCallRuntime, hubCallRuntimes } from "@hobbots/runtimes/testing";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  givePolicy,
  hub,
  memberTask,
  PIP,
  project,
  promptsTo,
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
const startGitHubHub = async (members: HubCallRuntime | null = null) => {
  const database = await sharedDatabase();
  const started = await startHub(
    database,
    [],
    githubCharm(),
    { preset: "trusting", charmOperations: declaredOperations([GITHUB_CHARM]) },
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
    expect.arrayContaining(["github_push", "github_open_pull_request", "github_comment"]),
  );
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
  expect(await run(ApprovalService.use((approvals) => approvals.listForThread(threadId))), name).toHaveLength(1);
  expect(tree.refusals, name).toEqual([]);
};

describe("GitHub Charm writes in a member's Task session (ADR 038)", () => {
  // covers PE-003, PE-005, OR-002, ADR 038 (every runtime: Claude Code, Codex, fake)
  it("[TC-OR-1343-01] on each runtime, a member comments after one approval card, pushes and opens a pull request under Allow, each once, and a git push is steered to github_push", async () => {
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
    expect(tree.refusals).toEqual([
      expect.objectContaining({ agentId: PIP, taskId: pip.id, tool: "github_comment", reason: "unknown-tool" }),
    ]);
    expect(github.requests.slice(before).filter((sent) => sent.path.endsWith("/comments"))).toEqual([]);
  }, 60_000);
});
