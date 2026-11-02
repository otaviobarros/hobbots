import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  type ApprovalAction,
  type ApprovalOutcome,
  actionDigest,
  CharmTools,
  type HubToolAnswer,
  makeRedactor,
  type RuntimeEvent,
  type ToolAccess,
  type TurnApprovals,
} from "@hobbots/agents";
import {
  AgentId,
  ApprovalId,
  CharmCall,
  EMPTY_HOB_POLICY,
  type GitHubRepository,
  MessageId,
  type PolicyDecision,
  type SafetyPreset,
  ThreadId,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubApi, GitHubCharmTools, GitPushLive, GitRemotes } from "../src/index.ts";
import { type FakeGitHubGit, startFakeGitHubGit } from "./fake-github-git.ts";
import { directSandbox, fixedToken, memoryCharmCalls } from "./support.ts";

const TOKEN = "ghu_pushtoken0123456789abcdefghijklmnopqrstuv";

let root = "";
let github: FakeGitHubGit;

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Hob",
      GIT_AUTHOR_EMAIL: "hob@example.com",
      GIT_COMMITTER_NAME: "Hob",
      GIT_COMMITTER_EMAIL: "hob@example.com",
    },
  }).trim();

const remoteOf = (repository: GitHubRepository) =>
  path.join(root, "github", repository.owner, `${repository.name}.git`);

/** The hob's folder and its repository on the fake GitHub, where `main` already has the first commit. */
const setUp = async (name: string) => {
  const folder = path.join(root, name);
  await fs.mkdir(folder);
  git(folder, "init", "--quiet", "--initial-branch=main");
  await fs.writeFile(path.join(folder, "a.txt"), "a\n");
  git(folder, "add", "a.txt");
  git(folder, "commit", "--quiet", "--no-gpg-sign", "-m", "First");
  const repository = { owner: "octo", name };
  const remote = remoteOf(repository);
  await fs.mkdir(path.dirname(remote), { recursive: true });
  git(root, "clone", "--quiet", "--bare", folder, remote);
  git(remote, "config", "http.receivepack", "true");
  git(folder, "checkout", "--quiet", "-b", "feat/x");
  await fs.writeFile(path.join(folder, "b.txt"), "b\n");
  git(folder, "add", "b.txt");
  git(folder, "commit", "--quiet", "--no-gpg-sign", "-m", "Add b");
  return { folder, repository, remote, commit: git(folder, "rev-parse", "feat/x") };
};

const headOf = (remote: string, branch: string) => {
  try {
    return git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return null;
  }
};

/** GitHub's API as the fake GitHub's repositories show it. */
const fakeApi = Layer.succeed(
  GitHubApi,
  GitHubApi.of({
    repository: (repository) =>
      Effect.succeed({
        fullName: `${repository.owner}/${repository.name}`,
        description: null,
        defaultBranch: "main",
        visibility: "private",
        url: `https://github.com/${repository.owner}/${repository.name}`,
        openIssuesAndPullRequests: 0,
      }),
    search: () => Effect.die("not used"),
    item: () => Effect.die("not used"),
    branchHead: (repository, branch) => Effect.sync(() => headOf(remoteOf(repository), branch)),
    viewer: Effect.succeed("otaviobarros"),
  }),
);

const accessFor = (folder: string, preset: SafetyPreset = "balanced", push?: PolicyDecision): ToolAccess => ({
  policy: {
    preset,
    sharedFolders: [folder],
    hob: { ...EMPTY_HOB_POLICY, overrides: push === undefined ? {} : { push } },
    dataFolder: path.join(root, "data"),
    restrictions: [],
  },
  folders: [folder],
  runtimeFolder: path.join(root, "runtimes", "hob"),
});

/** The user, as the test plays them: they answer each request the way `answer` says, and are recorded. */
const userApprovals = (
  access: ToolAccess,
  asked: Array<ApprovalAction>,
  answer: "approve" | "deny" = "approve",
): TurnApprovals => ({
  request: (action) =>
    Effect.gen(function* () {
      asked.push(action);
      const digest = yield* actionDigest(action);
      const decision: ApprovalOutcome =
        answer === "approve"
          ? { _tag: "Approved", actionDigest: digest, policyVersion: action.policyVersion, lifetime: "once" }
          : { _tag: "Denied", reason: "Not yet." };
      return { approvalId: ApprovalId.make(`approval-${asked.length}`), decision: Effect.succeed(decision) };
    }),
  currentAccess: Effect.succeed(access),
  grants: Effect.succeed([]),
  used: () => Effect.void,
});

interface Turn {
  readonly access: ToolAccess;
  readonly asked?: Array<ApprovalAction>;
  readonly answer?: "approve" | "deny";
  readonly events?: Array<RuntimeEvent>;
  readonly rows?: Map<string, CharmCall>;
  readonly step?: string;
}

const charmLayer = (folder: string, repository: GitHubRepository, rows: Map<string, CharmCall>) =>
  GitHubCharmTools.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeApi,
        Layer.succeed(
          GitRemotes,
          GitRemotes.of({ repositoryOf: (f) => Effect.succeed(f === folder ? repository : null) }),
        ),
        PolicyEngine.node,
        memoryCharmCalls(rows),
        fixedToken(TOKEN),
        GitPushLive({ folder: path.join(root, "data", "charms", "github"), httpsBase: github.base }).pipe(
          Layer.provide(Layer.mergeAll(directSandbox, NodeServices.layer)),
        ),
      ),
    ),
  );

const pushIn = (folder: string, repository: GitHubRepository, turn: Turn, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const charms = yield* CharmTools;
    const events = turn.events ?? [];
    const tools = charms.forTurn({
      agentId: AgentId.make("hob"),
      threadId: ThreadId.make("t1"),
      messageId: MessageId.make("m1"),
      currentAccess: Effect.succeed(turn.access),
      redactor: makeRedactor(),
      approvals: userApprovals(turn.access, turn.asked ?? [], turn.answer),
    });
    const answer: HubToolAnswer = yield* tools.call("github_push", input, {
      id: turn.step ?? "toolu_1",
      report: (event) => events.push(event),
    });
    return answer;
  }).pipe(Effect.provide(charmLayer(folder, repository, turn.rows ?? new Map())));

const push = (folder: string, repository: GitHubRepository, turn: Turn, input: Record<string, unknown>) =>
  Effect.runPromise(pushIn(folder, repository, turn, input));

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hobbots-github-push-")));
  github = await startFakeGitHubGit(path.join(root, "github"), TOKEN);
});
afterAll(async () => {
  await github.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("the GitHub Charm's Push", () => {
  // covers PE-003, PE-007
  it("[TC-PE-155] pushes a branch under Balanced after the user approves exactly what the card showed", async () => {
    const { folder, repository, remote, commit } = await setUp("balanced");
    const asked: Array<ApprovalAction> = [];
    const events: Array<RuntimeEvent> = [];
    const answer = await push(
      folder,
      repository,
      { access: accessFor(folder), asked, events },
      {
        branch: "feat/x",
        key: "push-1",
      },
    );
    expect(answer.refused).toBe(false);
    expect(answer.text).toContain(`Pushed ${commit.slice(0, 12)} to octo/balanced branch feat/x`);
    expect(answer.text).toContain("They approved it just this once");
    expect(headOf(remote, "feat/x")).toBe(commit);
    expect(asked).toHaveLength(1);
    const [card] = asked as [ApprovalAction];
    expect(card).toMatchObject({
      stepId: "toolu_1",
      tool: "github_push",
      operation: "push",
      targets: ["github.com/octo/balanced feat/x"],
      onceOnly: false,
      grantable: true,
    });
    expect(card.arguments).toMatchObject({
      commit,
      replaces: null,
      commits: 1,
      subjects: ["Add b"],
      actingAs: "otaviobarros",
    });
    expect(card.arguments.summary).toContain(`Push ${commit.slice(0, 12)} from feat/x to octo/balanced branch feat/x`);
    expect(events.map((event) => event._tag)).toEqual(["ToolAwaitingApproval", "ToolStarted"]);
  });

  // covers PE-003, PE-007
  it("[TC-PE-156] asks once only for a force push or a push to the default branch, and never under Never", async () => {
    const { folder, repository, remote } = await setUp("risky");
    const asked: Array<ApprovalAction> = [];
    const forced = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting"), asked },
      {
        branch: "feat/x",
        force: true,
        key: "force-1",
      },
    );
    const toDefault = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting"), asked },
      {
        branch: "feat/x",
        remote_branch: "main",
        key: "main-1",
      },
    );
    const never = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting", "deny"), asked },
      {
        branch: "feat/x",
        remote_branch: "other",
        key: "never-1",
      },
    );
    expect(asked.map((card) => [card.onceOnly, card.grantable, card.arguments.toDefaultBranch])).toEqual([
      [true, false, false],
      [true, false, true],
    ]);
    expect(forced.refused).toBe(false);
    expect(toDefault.refused).toBe(false);
    expect(never).toMatchObject({ refused: true });
    expect(headOf(remote, "other")).toBeNull();
  });

  // covers PE-001, PE-003
  it("[TC-PE-157] pushes under Trusting without asking, and refuses a denied push or an option-shaped branch", async () => {
    const { folder, repository, remote, commit } = await setUp("trusting");
    const asked: Array<ApprovalAction> = [];
    const trusted = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting"), asked },
      {
        branch: "feat/x",
        key: "t-1",
      },
    );
    const denied = await push(
      folder,
      repository,
      { access: accessFor(folder), asked, answer: "deny" },
      {
        branch: "feat/x",
        remote_branch: "feat/y",
        key: "t-2",
      },
    );
    const optionShaped = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting") },
      {
        branch: "--upload-pack=touch",
        key: "t-3",
      },
    );
    const headRef = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting") },
      {
        branch: "feat/x",
        remote_branch: "refs/heads/main",
        key: "t-4",
      },
    );
    expect(trusted.refused).toBe(false);
    expect(headOf(remote, "feat/x")).toBe(commit);
    expect(asked).toHaveLength(1);
    expect(denied).toMatchObject({ refused: true, text: expect.stringContaining("Their reason: Not yet.") });
    expect(headOf(remote, "feat/y")).toBeNull();
    expect(optionShaped.refused).toBe(true);
    expect(headRef.refused).toBe(true);
  });

  // covers IN-003, EX-004
  it("[TC-IN-053] returns the first result for a retried key without asking or pushing again", async () => {
    const { folder, repository } = await setUp("retried");
    const rows = new Map<string, CharmCall>();
    const asked: Array<ApprovalAction> = [];
    const turn = { access: accessFor(folder), asked, rows };
    const first = await push(folder, repository, turn, { branch: "feat/x", key: "same" });
    const before = github.requests();
    const again = await push(folder, repository, turn, { branch: "feat/x", key: "same" });
    const other = await push(folder, repository, turn, { branch: "main", key: "same" });
    expect(first.refused).toBe(false);
    expect(again.text).toContain("You made this call before, so it was not sent again.");
    expect(other.text).toContain("You already used the key same for another call.");
    expect(asked).toHaveLength(1);
    expect(github.requests()).toBe(before);
  });

  // covers EX-003, EX-004
  it("[TC-OR-070] settles a push whose answer was lost as applied when GitHub shows its commit", async () => {
    const { folder, repository, remote, commit } = await setUp("lost-applied");
    const rows = new Map<string, CharmCall>();
    github.drop = { after: github.requests(), when: "after" };
    const events: Array<RuntimeEvent> = [];
    const answer = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting"), rows, events },
      {
        branch: "feat/x",
        key: "lost-1",
      },
    ).finally(() => {
      github.drop = null;
    });
    expect(headOf(remote, "feat/x")).toBe(commit);
    expect(answer).toMatchObject({ refused: false, text: expect.stringContaining("Pushed") });
    expect([...rows.values()].map((row) => row.state)).toEqual(["applied"]);
    expect(events.map((event) => event._tag)).toEqual(["ToolStarted"]);
  });

  // covers EX-003, EX-004
  it("[TC-OR-071] keeps a push uncertain when its effect is not found, and refuses another push to that branch", async () => {
    const { folder, repository, remote } = await setUp("lost-unknown");
    const rows = new Map<string, CharmCall>();
    github.drop = { after: github.requests(), when: "before" };
    const events: Array<RuntimeEvent> = [];
    const turn = { access: accessFor(folder, "trusting"), rows, events };
    const answer = await push(folder, repository, turn, { branch: "feat/x", key: "lost-2" }).finally(() => {
      github.drop = null;
    });
    // The branch on GitHub is still where it was, which proves nothing: the call stays uncertain.
    expect(headOf(remote, "feat/x")).toBeNull();
    expect(answer).toMatchObject({ refused: true, text: expect.stringContaining("Do not repeat it") });
    expect([...rows.values()].map((row) => row.state)).toEqual(["uncertain"]);
    expect(events.map((event) => event._tag)).toEqual(["ToolStarted", "ToolUncertain"]);
    const blocked = await push(folder, repository, { ...turn, step: "toolu_2" }, { branch: "feat/x", key: "lost-3" });
    expect(blocked).toMatchObject({ refused: true, text: expect.stringContaining("has not settled yet") });
    const sameKey = await push(folder, repository, { ...turn, step: "toolu_3" }, { branch: "feat/x", key: "lost-2" });
    expect(sameKey.text).toContain("Do not repeat it");
    expect(headOf(remote, "feat/x")).toBeNull();
  });

  // covers EX-003
  it("[TC-OR-072] reads back calls the hub left in flight when it starts, and settles them once their effect shows", async () => {
    const { folder, repository, remote, commit } = await setUp("restarted");
    git(folder, "push", "--quiet", remote, "feat/x");
    const plan = { repository: "octo/restarted", remoteBranch: "feat/x", commit, appliedText: "Pushed." };
    const row = (key: string, overrides: Partial<CharmCall>) =>
      new CharmCall({
        agentId: AgentId.make("hob"),
        key,
        tool: "github_push",
        input: "{}",
        site: `github.com/octo/restarted refs/heads/${key}`,
        plan: JSON.stringify(plan),
        state: "sending",
        result: null,
        threadId: null,
        messageId: null,
        stepId: null,
        createdAt: "2026-11-02T00:00:00.000Z",
        updatedAt: "2026-11-02T00:00:00.000Z",
        ...overrides,
      });
    const rows = new Map<string, CharmCall>([
      ["hob found", row("found", {})],
      ["hob missing", row("missing", { plan: JSON.stringify({ ...plan, commit: "f".repeat(40) }) })],
    ]);
    // The read-back runs in the background as the Charm starts.
    await Effect.gen(function* () {
      yield* CharmTools;
      yield* Effect.sleep("500 millis");
    }).pipe(Effect.provide(charmLayer(folder, repository, rows)), Effect.runPromise);
    expect([...rows.values()].map((r) => [r.key, r.state, r.result])).toEqual([
      ["found", "applied", "Pushed."],
      ["missing", "uncertain", "The hub stopped while this call was being sent."],
    ]);
  });
});
