import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { ApprovalService, Charms, FolderSandbox, GrantService, type PromptRequest } from "@hobbots/agents";
import {
  GITHUB_CHARM,
  GitHubAccountLive,
  GitHubApiNode,
  GitHubCharm,
  GitHubCredentialPerHob,
  GitHubSignInNode,
  GitPushLive,
  GitRemotes,
  HobAppKeysMemory,
  HobGitHubAppNode,
  HobGitHubAppService,
  KeychainMemory,
  LocalGitHubSignInsNone,
} from "@hobbots/charms";
import { type FakeGitHub, startFakeGitHub } from "@hobbots/charms/testing";
import {
  type ApprovalRequest,
  declaredOperations,
  EMPTY_HOB_POLICY,
  type HobPolicy,
  type RuntimeKind,
  type TaskTree,
} from "@hobbots/domain";
import { waitToFind, waitUntil } from "@hobbots/domain/testing";
import { PolicyEngine } from "@hobbots/permissions";
import {
  CharmCallsLive,
  DeviceRepositoryLive,
  EventJournal,
  GitHubAccountRepository,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  HobGitHubAppRepository,
} from "@hobbots/persistence";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import {
  ALDRIC,
  givePolicy,
  hub,
  memberTask,
  messagesWhen,
  project,
  promptsTo,
  ROOK,
  send,
  sharedDatabase,
  startHub,
  threadId,
  treeWhen,
} from "./dependency-hub.ts";

// #1353 (slice #1342): a Quest runs on its own, end to end, at hub level. Aldric leads and hands
// Rook, a reviewer with the GitHub Charm, its own GitHub App, Comment on Ask and Edit files on Never,
// "review pull request #2 and post the review as a comment". The delegation lists Rook's tools and
// answers before his Task starts. Rook runs `git diff` and the tests as read-only commands, Aldric
// steers him mid-turn and the note reaches the same turn, and Rook posts the review after one
// approval card, as his app's bot, against a fake GitHub on a local port. Then you ask Aldric to stop,
// and the Quest ends stopped, never delivered. The one approval and your stop are all that reached
// you. Every hob runs on the fake runtime, as Claude Code and as Codex; CI runs it on SQLite and on
// PostgreSQL (TestDatabase). The real runtimes run the same scenario by hand, in
// docs/evidence/checklists/quests-run-on-their-own.md.

const TOKEN = "github_pat_quests_on_their_own";
const SLUG = "otaviobarros/workshop";
const BRANCH = "feat/parser";
const STOP = { reason: "You asked me to stop", summary: "Rook posted his review; the rest was not needed" };

const git = (...args: Array<string>) =>
  execFileSync("git", args, {
    cwd: project,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: project,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.com",
    },
  }).trim();

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** Stands in for the hob's sandbox, which CI cannot start: the Charm's fence is proven in @hobbots/charms git-push.test.ts. */
const PlainSandbox = Layer.succeed(
  FolderSandbox,
  FolderSandbox.of({
    readOnly: (_folders, program, args) =>
      Effect.succeed({ commandLine: `sh -c ${quote(`exec ${[program, ...args].map(quote).join(" ")}`)}`, env: {} }),
  }),
);

let github: FakeGitHub;
/** Rook's own app on the fake GitHub, which he is linked to when each hub starts (ADR 022). */
let rookApp: ReturnType<FakeGitHub["makeAppByHand"]>;
/** The pull request Rook reviews. */
let pullRequest: number;

beforeAll(async () => {
  github = await startFakeGitHub({ folder: join(project, "..", "github"), login: "otaviobarros", tokens: [TOKEN] });
  git("init", "--quiet", "--initial-branch=main");
  git("remote", "add", "origin", `https://github.com/${SLUG}.git`);
  git("commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "First");
  git("checkout", "--quiet", "-b", BRANCH);
  git("commit", "--quiet", "--allow-empty", "--no-gpg-sign", "-m", "Tidy the parser");
  git("checkout", "--quiet", "main");
  github.createRepository({ owner: "otaviobarros", name: "workshop", from: project });
  github.install(SLUG);
  github.addItem(SLUG, { title: "Review the parser", author: "ada" });
  pullRequest = github.addItem(SLUG, {
    title: "Tidy the parser",
    author: "ada",
    pullRequest: { head: BRANCH, base: "main" },
  });
  rookApp = github.makeAppByHand("Rook the reviewer");
  github.installApp(rookApp.app.slug, "all");
});

afterAll(async () => {
  await github.close();
});

/**
 * The GitHub Charm as `main.ts` composes it: each hob acts as its own app when it has one, as your
 * account otherwise. Rook is linked to his app as the hub starts, as you would from his Charms tab.
 */
const githubCharm = () => {
  const account = GitHubAccountLive({
    clientId: "Iv23liFakeHobbots",
    slug: "hobbots",
    environmentToken: Redacted.make(TOKEN),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(KeychainMemory, GitHubSignInNode(github.hosts), LocalGitHubSignInsNone, GitHubAccountRepository),
    ),
  );
  const grants = GrantService.layer.pipe(Layer.provideMerge(Layer.mergeAll(GrantRepositoryLive, EventBus.layer)));
  const hobApp = HobGitHubAppNode(github.hosts).pipe(
    Layer.provideMerge(HobAppKeysMemory),
    Layer.provideMerge(Layer.mergeAll(HobGitHubAppRepository, DeviceRepositoryLive)),
  );
  const credential = GitHubCredentialPerHob.pipe(Layer.provide(account), Layer.provideMerge(hobApp));
  const linked = Layer.effectDiscard(
    HobGitHubAppService.use((apps) =>
      apps.link(ROOK, { appId: String(rookApp.app.id), privateKey: Redacted.make(rookApp.pem) }),
    ).pipe(Effect.orDie),
  );
  return Charms.layer([GitHubCharm]).pipe(
    Layer.provide(
      Layer.mergeAll(
        GitHubApiNode(github.hosts.api),
        GitRemotes.layer,
        PolicyEngine.node,
        GitPushLive({ folder: join(project, "..", "charm"), httpsBase: github.base }).pipe(Layer.provide(PlainSandbox)),
        CharmCallsLive,
      ),
    ),
    Layer.provideMerge(linked),
    Layer.provideMerge(credential),
    Layer.provideMerge(grants),
    Layer.provideMerge(Layer.mergeAll(HobbotsRepositoryLive, EventJournal.layer)),
    Layer.provide(NodeServices.layer),
  );
};

/** Rook holds the GitHub Charm with Comment on Ask, and may not edit files. */
const POLICY: HobPolicy = {
  ...EMPTY_HOB_POLICY,
  overrides: { "edit-files": "deny" },
  charms: { granted: ["github"], overrides: { "github.comment": "ask" } },
};

/** The runtime's own tools a delegation lists beside the hub tools (#1348). */
const RUNTIME_TOOLS = ["file_reads", "file_edits", "commands", "read_only_commands"];

/** The tools a `delegate_task` answer lists for its member with their answers, and those it lacks with why. */
const listedIn = (answer: string) => {
  const details = JSON.parse(answer.slice(answer.lastIndexOf("\n{") + 1)) as {
    readonly tools: Readonly<Record<string, string>>;
    readonly dropped: Readonly<Record<string, string>>;
  };
  return { ...details, hub: Object.keys(details.tools).filter((tool) => !RUNTIME_TOOLS.includes(tool)) };
};

const offered = (request: PromptRequest) => request.hubTools?.tools.map((tool) => tool.name) ?? [];

/** Holds each call keyed `keys` until the returned function opens it by its key. */
const gated = (gates: Map<string, () => Promise<void>>, keys: ReadonlyArray<string>) => {
  const opens = new Map<string, () => void>();
  for (const key of keys) {
    const opened = new Promise<void>((resolve) => opens.set(key, resolve));
    gates.set(key, () => opened);
  }
  return (key: string) => opens.get(key)?.();
};

const isLive = (state: string) => state === "starting" || state === "running";

const rookTask = (tree: TaskTree) => memberTask(tree, ROOK);

/** Rook's Task's Attempts. */
const rookAttempts = (tree: TaskTree) => tree.attempts.filter((each) => each.taskId === rookTask(tree)?.id);

/** The journal's events in order, as `<type>` or `<type>:<detail>` for the ones this test follows. */
const journal = EventJournal.use((events) => events.readAfter(0, 10_000)).pipe(
  Effect.map((entries) =>
    entries.map((entry) => {
      const payload = entry.payload;
      if (payload._tag === "CheckpointRecorded") return `CheckpointRecorded:${payload.checkpoint.summary}`;
      return payload._tag;
    }),
  ),
);

const allCards = ApprovalService.use((approvals) => approvals.listForThread(threadId));

const pendingIn = (cards: ReadonlyArray<ApprovalRequest>) => cards.find((each) => each.state === "pending");

const REVIEW = "The parser reads well; the tests pass. Please cover the empty input too.";

/** The scenario, with every hob on `runtime`. */
const scenario = async (runtime: RuntimeKind) => {
  const database = await sharedDatabase(runtime);
  const { run, answers, requests, started, denied, callGates } = await startHub(database, [], githubCharm(), {
    preset: "trusting",
    charmOperations: declaredOperations([GITHUB_CHARM]),
  });
  await run(givePolicy(POLICY));
  const open = gated(callGates, ["read", "steer", "hold"]);
  const reviewBefore = github.items(SLUG).find((item) => item.number === pullRequest)?.comments.length ?? 0;

  // 1. Aldric delegates the review, and later steers Rook once Rook's turn runs.
  await run(
    send([
      `Have Rook review pull request #${pullRequest} and post the review as a comment`,
      hub("delegate_task", {
        key: "review",
        hob: "Rook",
        brief: [
          `Review pull request #${pullRequest} and post the review as a comment`,
          `fake:tool Bash git diff main...${BRANCH}`,
          "fake:tool Bash npm test",
          hub("report_checkpoint", { key: "read", kind: "progress", summary: "Read the diff; the tests pass" }),
          hub("github_comment", { key: "comment", folder: project, number: pullRequest, body: REVIEW }),
          hub("report_checkpoint", { key: "hold", kind: "progress", summary: "Posted the review" }),
          hub("complete_task", { key: "rook-done", delivered: true, summary: "Posted the review" }),
        ].join("\n"),
        authority: {
          decisions: {
            "read-files": "allow",
            "edit-files": "deny",
            "delete-files": "deny",
            "run-commands": "allow",
            "local-git": "allow",
            "github.comment": "ask",
          },
          folders: "all",
        },
      }),
      hub("message_task", {
        key: "steer",
        task_id: "$review.task_id",
        text: "Also ask for a test of the empty input.",
      }),
      hub("wait_for", { key: "wait", tasks: ["$review.task_id"] }),
    ]),
  );

  // 2. The delegation listed Rook's tools and answers, and his session was offered just those.
  const listed = listedIn(await run(waitToFind("the delegation's answer", () => answers.get("review"))));
  expect(listed.tools.github_comment, runtime).toBe("ask");
  expect(listed.tools.read_only_commands, runtime).toBeDefined();
  expect(Object.keys(listed.tools), runtime).not.toContain("file_edits");
  expect(Object.keys(listed.dropped), runtime).toContain("file_edits");
  const running = await run(treeWhen((tree) => rookAttempts(tree).some((each) => isLive(each.state))));
  const task = rookTask(running);
  if (task === undefined) throw new Error("expected Rook's Task");
  const first = await run(waitToFind("Rook's first prompt", () => promptsTo(requests, task)[0]));
  expect([...listed.hub].sort(), runtime).toEqual([...offered(first)].sort());

  // 4. Aldric steers Rook while Rook's turn runs, held before his first hub call.
  open("steer");
  await run(
    waitUntil(
      Effect.sync(() => answers.get("steer")),
      (answer) => answer !== undefined,
      { what: "steer" },
    ),
  );
  expect(answers.get("steer"), runtime).toContain('"delivery":"steer"');
  open("read");

  // 3. Rook ran git diff and the tests as read-only commands, and was refused nothing.
  // His comment asks: one card, under Aldric's thread, for Rook.
  const asked = await run(
    waitUntil(allCards, (cards) => pendingIn(cards) !== undefined, { what: "the comment's approval card" }),
  );
  expect(asked, runtime).toEqual([
    expect.objectContaining({ agentId: ROOK, taskId: task.id, tool: "github_comment", state: "pending" }),
  ]);
  const card = pendingIn(asked) as ApprovalRequest;
  await run(
    ApprovalService.use((approvals) =>
      approvals.decide(card.id, { decision: "approve", actionDigest: card.actionDigest }),
    ),
  );
  const comments = () => github.items(SLUG).find((item) => item.number === pullRequest)?.comments ?? [];
  await run(
    waitUntil(
      Effect.sync(() => answers.get("comment")),
      (answer) => answer !== undefined,
      { what: "the comment's answer" },
    ),
  );
  expect(comments().slice(reviewBefore), runtime).toEqual([
    expect.objectContaining({ author: `${rookApp.app.slug}[bot]`, body: expect.stringContaining(REVIEW) }),
  ]);

  // Each ran in the hob's sandbox, which Edit files Never closes to writes (ADR 014, #1344).
  const commands = started
    .filter((each) => each.tool === "Bash")
    .map((each) => [each.command?.line, each.command?.sandboxed]);
  expect(commands, runtime).toEqual([
    [`git diff main...${BRANCH}`, true],
    ["npm test", true],
  ]);
  expect(denied, runtime).toEqual([]);

  // 4. The note reached Rook's turn after his first call and before his comment, in the same Attempt.
  const steered = await run(treeWhen((tree) => tree.notes.some((note) => note.pickedUpBy !== null)));
  const [attempt, ...others] = rookAttempts(steered);
  expect(others, runtime).toEqual([]);
  expect(steered.notes, runtime).toEqual([
    expect.objectContaining({ taskId: task.id, delivery: "steer", pickedUpBy: attempt?.id }),
  ]);
  const events = await run(journal);
  const at = (event: string) => events.indexOf(event);
  expect(at("CheckpointRecorded:Read the diff; the tests pass"), runtime).toBeLessThan(at("NotePickedUp"));
  expect(at("NotePickedUp"), runtime).toBeLessThan(at("ApprovalRequested"));

  // 5. You ask Aldric to stop while Rook is still in his turn; the Quest ends stopped, not delivered.
  await run(messagesWhen((all) => all.length >= 2));
  await run(send(["Stop, the review is all we needed", hub("stop_quest", { key: "stop", ...STOP }), "Stopped."]));
  const done = await run(
    treeWhen(
      (tree) =>
        tree.quests[0]?.state === "stopped" &&
        tree.tasks[0]?.state === "cancelled" &&
        !tree.attempts.some((each) => isLive(each.state)),
    ),
  );
  expect(answers.get("stop"), runtime).toContain("stops at the user's request, without delivering it");
  expect(done.quests[0], runtime).toMatchObject({ state: "stopped", stop: STOP });
  expect(done.tasks[0], runtime).toMatchObject({ state: "cancelled", result: null });
  expect(rookTask(done)?.state, runtime).toBe("cancelled");
  expect(answers.has("rook-done"), runtime).toBe(false);
  expect(
    done.tasks.some((each) => each.state === "completed"),
    runtime,
  ).toBe(false);

  // 6. What reached you: the one approval card and your stop. No question, and nothing else.
  expect(await run(allCards), runtime).toEqual([expect.objectContaining({ id: card.id, state: "approved" })]);
  expect(done.questions, runtime).toEqual([]);
  expect(done.refusals, runtime).toEqual([]);
  const yours = (await run(messagesWhen(() => true))).filter((message) => message.role === "user");
  expect(yours, runtime).toHaveLength(2);
  expect(done.tasks[0]?.ownerId, runtime).toBe(ALDRIC);
};

describe("a Quest runs on its own, end to end (#1342)", () => {
  it.each<RuntimeKind>(["claude-code", "codex"])(
    "on the fake %s, a reviewer with its own app reviews after one approval, is steered mid-turn, and the Quest you stop ends stopped",
    async (runtime) => {
      await scenario(runtime);
    },
    60_000,
  );
});
