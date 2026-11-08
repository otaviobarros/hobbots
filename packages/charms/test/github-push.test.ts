import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  type ApprovalAction,
  type ApprovalOutcome,
  actionDigest,
  Charms,
  type HubToolAnswer,
  hubCallStep,
  makeRedactor,
  type RuntimeEvent,
  type ToolAccess,
  type TurnApprovals,
  UNRECORDED_TOOL_CALL,
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
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitHubApi,
  GitHubCharm,
  GitHubCredential,
  GitHubError,
  GitHubPushSettings,
  GitPush,
  GitPushLive,
  GitRemotes,
  type PushTransport,
} from "../src/index.ts";
import { type FakeGitHub, startFakeGitHub } from "../src/testing.ts";
import { charmToolsFor, directSandbox, fixedCredential, memoryCharmCalls } from "./support.ts";

const TOKEN = "ghu_pushtoken0123456789abcdefghijklmnopqrstuv";
/** Shaped like a GitHub token, so the turn's redactor takes it out wherever it appears. */
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

let root = "";
let github: FakeGitHub;

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
      // Fixed, so a commit, and the card that names it, is the same on every run.
      GIT_AUTHOR_DATE: "2026-11-01T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-11-01T12:00:00Z",
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
    repository: (_agentId, repository) =>
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
    branchHead: (_agentId, repository, branch) => Effect.sync(() => headOf(remoteOf(repository), branch)),
    viewer: () => Effect.succeed("otaviobarros"),
    user: () => Effect.die("not read in these tests"),
    pullRequests: () => Effect.die("not used"),
    commentsSince: () => Effect.die("not used"),
    openPullRequest: () => Effect.die("not used"),
    gitObject: () => Effect.die("not used"),
    rateLimit: () => Effect.die("not used"),
    comment: () => Effect.die("not used"),
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
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

/** The user, as the test plays them: they answer each request the way `answer` says, and are recorded. */
const userApprovals = (
  access: ToolAccess,
  asked: Array<ApprovalAction>,
  answer: "approve" | "deny" = "approve",
  whileAsking: () => void = () => {},
): TurnApprovals => ({
  request: (action) =>
    Effect.gen(function* () {
      asked.push(action);
      whileAsking();
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
  /** The hob's sign-in: the fake GitHub's own token unless a test gives another. */
  readonly credential?: ReturnType<typeof fixedCredential>;
  /** What happens while the card waits, before the user answers. */
  readonly whileAsking?: () => void;
  /** Records the step, as the runtime's `recordToolStart` would, and says whether it was; reported when absent. */
  readonly records?: () => boolean;
}

const charmLayer = (
  folder: string,
  repository: GitHubRepository,
  rows: Map<string, CharmCall>,
  credential: ReturnType<typeof fixedCredential>,
) =>
  Charms.layer([GitHubCharm]).pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeApi,
        Layer.succeed(
          GitRemotes,
          GitRemotes.of({ repositoryOf: (f) => Effect.succeed(f === folder ? repository : null) }),
        ),
        PolicyEngine.node,
        memoryCharmCalls(rows),
        credential.layer,
        GitPushLive({ folder: path.join(root, "data", "charms", "github"), httpsBase: github.base }).pipe(
          Layer.provide(Layer.mergeAll(directSandbox, NodeServices.layer)),
        ),
      ),
    ),
  );

const pushIn = (folder: string, repository: GitHubRepository, turn: Turn, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const events = turn.events ?? [];
    const tools = yield* charmToolsFor({
      agentId: AgentId.make("hob"),
      threadId: ThreadId.make("t1"),
      messageId: MessageId.make("m1"),
      scope: () => "reply:m1",
      currentAccess: Effect.succeed(turn.access),
      redactor: makeRedactor(),
      approvals: userApprovals(turn.access, turn.asked ?? [], turn.answer, turn.whileAsking),
    });
    if (tools === null) throw new Error("The turn was offered no GitHub tools");
    const answer: HubToolAnswer = yield* tools.call(
      "github_push",
      input,
      hubCallStep(
        turn.step ?? "toolu_1",
        (event: RuntimeEvent) => events.push(event),
        turn.records === undefined
          ? undefined
          : (event) =>
              Effect.sync(() => {
                events.push(event);
                return turn.records?.() ?? true;
              }),
      ),
    );
    return answer;
  }).pipe(
    Effect.provide(charmLayer(folder, repository, turn.rows ?? new Map(), turn.credential ?? fixedCredential(TOKEN))),
  );

const push = (folder: string, repository: GitHubRepository, turn: Turn, input: Record<string, unknown>) =>
  Effect.runPromise(pushIn(folder, repository, turn, input));

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hobbots-github-push-")));
  github = await startFakeGitHub({ folder: path.join(root, "github"), tokens: [TOKEN] });
});
afterAll(async () => {
  await github.close();
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * Each test here pushes for real: about 55 short-lived processes (the test's own Git setup, the hub's
 * Git calls, Git's helpers, and the fake GitHub's `git http-backend`), one after another. Alone on a
 * CI runner a test takes 0.1 to 0.4 s. While every other package tests on the same 4 cores, it
 * takes 3 to 5 times as long, and #655 saw two of them pass 5 s at the busiest moment. Nothing in
 * them waits on a timer, so the budget is set for that load rather than for the work.
 */
const REAL_GIT_TIMEOUT = 30_000;

/** The commit `setUp` makes on `feat/x`, with its fixed dates. */
const PUSHED_COMMIT = "b05beb9e959c75c153574049bc9c21b0ec56ac9e";
/** The card's summary, and the digest of the card in TC-PE-497, as the hub showed them before the pipeline (#619). */
const PUSH_SUMMARY = [
  "Push b05beb9e959c from feat/x to octo/same-card branch feat/x",
  "Creates the branch on GitHub.",
  "1 commit GitHub's branches do not have:",
  "  Add b",
  "As you (@otaviobarros).",
].join("\n");
const PUSH_CARD_DIGEST = "060f28d191dcd7749c0e496684fbda186e0572e4189cfe9d4ec007a35c4e6ccb";

describe("the GitHub Charm's Push", { timeout: REAL_GIT_TIMEOUT }, () => {
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
      actingAs: { _tag: "You", login: "otaviobarros" },
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

  // covers PE-003, PE-007 (#1219)
  it("[TC-PE-1219-01] refuses, without a card, a push that would create a branch with no commit GitHub lacks", async () => {
    const { folder, repository, remote } = await setUp("nothing-new");
    // The hob's commit was refused, so its new branch is still at main's commit, which GitHub has.
    git(folder, "branch", "feat/empty", "main");
    const main = git(folder, "rev-parse", "main");
    const asked: Array<ApprovalAction> = [];
    const answer = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting"), asked },
      { branch: "feat/empty", key: "empty-1" },
    );
    expect(answer.refused).toBe(true);
    expect(answer.text).toContain(`feat/empty is at ${main.slice(0, 12)}, which octo/nothing-new already has`);
    expect(answer.text).toContain("Nothing was pushed.");
    expect(answer.text).toContain("Commit your work first");
    expect(asked).toHaveLength(0);
    expect(headOf(remote, "feat/empty")).toBeNull();
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

  // covers PE-005, EX-004
  it("[TC-IN-055] pushes with a refreshed token when GitHub refused the sign-in, and disconnects when it refuses that too", async () => {
    const { folder, repository, remote, commit } = await setUp("refreshed");
    const refreshed = fixedCredential("ghu_expired", TOKEN);
    const pushed = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting"), credential: refreshed },
      { branch: "feat/x", key: "r-1" },
    );
    expect(pushed.refused).toBe(false);
    expect(headOf(remote, "feat/x")).toBe(commit);
    expect(refreshed.revoked).toEqual([]);

    const refused = fixedCredential("ghu_expired", "ghu_also_refused");
    const signedOut = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting"), credential: refused },
      { branch: "feat/x", remote_branch: "feat/z", key: "r-2" },
    );
    expect(signedOut).toMatchObject({ refused: true, text: expect.stringContaining("connect GitHub again") });
    expect(refused.revoked).toEqual(["ghu_also_refused"]);
    expect(headOf(remote, "feat/z")).toBeNull();
  });

  // covers ADR 022
  it("[TC-GEN-065] never retries a push over the user's SSH key once the hob's app it was checked under is gone", async () => {
    const { folder, repository, remote } = await setUp("app-gone");
    // The hob has its own app when the push is checked and first sent, and none from then on.
    let appConnected = true;
    const changed = new GitHubError({
      reason: "signed-out",
      message: "The hob's GitHub sign-in changed during this call, so it did not run. Try again.",
    });
    const credential = Layer.succeed(
      GitHubCredential,
      GitHubCredential.of({
        connected: Effect.succeed(true),
        hobApp: () =>
          appConnected
            ? Effect.succeed({ _tag: "HobApp", hob: "Pip", bot: "pip-hobbots[bot]" } as const)
            : Effect.fail(changed),
        tokenFor: () => Effect.succeed(Redacted.make(TOKEN)),
        refused: () => Effect.fail(changed),
        revoked: () => Effect.void,
        reaches: () => Effect.void,
        onRepository: (_agentId, _repository, use) => use,
      }),
    );
    // The first attempt never reaches GitHub, and the app is disconnected meanwhile.
    const transports: Array<PushTransport["_tag"]> = [];
    const gitPush = Layer.effect(
      GitPush,
      Effect.map(Effect.service(GitPush), (real) =>
        GitPush.of({
          ...real,
          // GitHub has the commit already, so the push only moves the branch.
          toSend: (staged) => Effect.succeed({ commits: [], tip: staged.commit, workflows: false }),
          push: (staged, target, transport) =>
            Effect.suspend(() => {
              transports.push(transport._tag);
              if (transports.length > 1) return real.push(staged, target, transport);
              appConnected = false;
              return Effect.succeed({ _tag: "NotSent", message: "The hub could not reach GitHub." } as const);
            }),
        }),
      ),
    ).pipe(
      Layer.provide(
        GitPushLive({ folder: path.join(root, "data", "charms", "github"), httpsBase: github.base }).pipe(
          Layer.provide(Layer.mergeAll(directSandbox, NodeServices.layer)),
        ),
      ),
    );
    const layer = Charms.layer([GitHubCharm]).pipe(
      Layer.provide(
        Layer.mergeAll(
          fakeApi,
          Layer.succeed(
            GitRemotes,
            GitRemotes.of({ repositoryOf: (f) => Effect.succeed(f === folder ? repository : null) }),
          ),
          PolicyEngine.node,
          memoryCharmCalls(new Map()),
          credential,
          gitPush,
        ),
      ),
    );
    const access = accessFor(folder, "trusting");
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tools = yield* charmToolsFor({
          agentId: AgentId.make("hob"),
          threadId: ThreadId.make("t1"),
          messageId: MessageId.make("m1"),
          scope: () => "reply:m1",
          currentAccess: Effect.succeed(access),
          redactor: makeRedactor(),
          approvals: userApprovals(access, []),
        });
        if (tools === null) throw new Error("The turn was offered no GitHub tools");
        return yield* tools.call(
          "github_push",
          { branch: "feat/x", key: "gone-1" },
          hubCallStep("toolu_1", () => {}),
        );
      }).pipe(
        Effect.provide(layer),
        // The hub pushes over SSH for the user's account; the hob's app always uses its token.
        Effect.provideService(GitHubPushSettings, { over: "ssh", agentSocket: "/nonexistent/agent.sock" }),
      ),
    );
    expect(transports).toEqual(["Https"]);
    expect(answer).toMatchObject({ refused: true, text: expect.stringContaining("sign-in changed") });
    expect(headOf(remote, "feat/x")).toBeNull();
  });

  // covers PE-003, PE-005
  it("[TC-IN-057] does not push under another GitHub account connected while the card waits, and asks again", async () => {
    const { folder, repository, remote, commit } = await setUp("switched");
    const credential = fixedCredential(TOKEN);
    const asked: Array<ApprovalAction> = [];
    const switched = await push(
      folder,
      repository,
      { access: accessFor(folder), asked, credential, whileAsking: credential.switchAccount },
      { branch: "feat/x", key: "s-1" },
    );
    expect(switched).toMatchObject({ refused: true, text: expect.stringContaining("sign-in changed") });
    expect(headOf(remote, "feat/x")).toBeNull();
    // Called again, the push is planned under the account connected now and asks again.
    const again = await push(
      folder,
      repository,
      { access: accessFor(folder), asked, credential },
      {
        branch: "feat/x",
        key: "s-1",
      },
    );
    expect(again.refused).toBe(false);
    expect(asked).toHaveLength(2);
    expect(headOf(remote, "feat/x")).toBe(commit);
  });

  // covers IN-003, EX-004
  it("[TC-IN-053] returns the first result for a retried key without asking or pushing again", async () => {
    const { folder, repository } = await setUp("retried");
    const rows = new Map<string, CharmCall>();
    const asked: Array<ApprovalAction> = [];
    const turn = { access: accessFor(folder), asked, rows };
    const first = await push(folder, repository, turn, { branch: "feat/x", key: "same" });
    const before = github.requests.length;
    const again = await push(folder, repository, turn, { branch: "feat/x", key: "same" });
    const other = await push(folder, repository, turn, { branch: "main", key: "same" });
    expect(first.refused).toBe(false);
    expect(again.text).toContain("You made this call before, so it was not sent again.");
    expect(other.text).toContain("You already used the key same for another call.");
    expect(asked).toHaveLength(1);
    expect(github.requests.length).toBe(before);
  });

  // covers EX-003, EX-004
  it("[TC-OR-070] settles a push whose answer was lost as applied when GitHub shows its commit", async () => {
    const { folder, repository, remote, commit } = await setUp("lost-applied");
    const rows = new Map<string, CharmCall>();
    github.drop = { after: github.requests.length, when: "after" };
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
    github.drop = { after: github.requests.length, when: "before" };
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
    const plan = { repository: "octo/restarted", remoteBranch: "feat/x", commit };
    const row = (key: string, overrides: Partial<CharmCall>) =>
      new CharmCall({
        agentId: AgentId.make("hob"),
        scope: "",
        key,
        attempt: `${key}-1`,
        charm: "GitHub",
        tool: "github_push",
        input: "{}",
        site: `github.com/octo/restarted refs/heads/${key}`,
        plan: JSON.stringify(plan),
        appliedText: "Pushed.",
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
      ["hob  found", row("found", {})],
      ["hob  missing", row("missing", { plan: JSON.stringify({ ...plan, commit: "f".repeat(40) }) })],
    ]);
    // The read-back runs in the background as the Charm starts.
    await Effect.gen(function* () {
      yield* Charms;
      yield* Effect.sleep("500 millis");
    }).pipe(Effect.provide(charmLayer(folder, repository, rows, fixedCredential(TOKEN))), Effect.runPromise);
    expect([...rows.values()].map((r) => [r.key, r.state, r.result])).toEqual([
      ["found", "applied", "Pushed."],
      ["missing", "uncertain", "The hub stopped while this call was being sent."],
    ]);
  });
  // covers PE-003, PE-007, ADR 020, ADR 031
  it("[TC-PE-497] shows the same card, with the same digest, for the same push as before the pipeline", async () => {
    const { folder, repository } = await setUp("same-card");
    const asked: Array<ApprovalAction> = [];
    await push(
      folder,
      repository,
      { access: accessFor(folder), asked, answer: "deny" },
      { branch: "feat/x", key: "card-1" },
    );
    // The hob's folder is the only part of a card that differs between machines.
    const cards = asked.map((card) => ({
      tool: card.tool,
      operation: card.operation,
      targets: card.targets,
      arguments: { ...card.arguments, folder: "<folder>" },
    }));
    expect(cards).toEqual([
      {
        tool: "github_push",
        operation: "push",
        targets: ["github.com/octo/same-card feat/x"],
        arguments: {
          repository: "octo/same-card",
          folder: "<folder>",
          branch: "feat/x",
          remoteBranch: "feat/x",
          commit: PUSHED_COMMIT,
          force: false,
          replaces: null,
          defaultBranch: "main",
          toDefaultBranch: false,
          commits: 1,
          subjects: ["Add b"],
          actingAs: { _tag: "You", login: "otaviobarros" },
          over: "https",
          summary: PUSH_SUMMARY,
        },
      },
    ]);
    const digests = await Effect.runPromise(Effect.forEach(cards, actionDigest));
    expect(digests).toEqual([PUSH_CARD_DIGEST]);
  });

  // covers PE-003, ADR 020, ADR 031
  it("[TC-PE-498] never stores or shows a secret the hob wrote in a push's input", async () => {
    const { folder, repository, remote } = await setUp("secret-branch");
    const branch = `feat/${SECRET}`;
    git(folder, "branch", branch, "feat/x");
    const rows = new Map<string, CharmCall>();
    const asked: Array<ApprovalAction> = [];
    const events: Array<RuntimeEvent> = [];
    const answer = await push(
      folder,
      repository,
      { access: accessFor(folder), asked, events, rows },
      { branch, key: "secret-1" },
    );
    // The push is planned on the redacted branch name, which is no branch, so nothing is sent.
    expect(answer.refused).toBe(true);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(JSON.stringify(asked)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify([...rows.values()])).not.toContain(SECRET);
    expect(headOf(remote, branch)).toBeNull();
  });

  // covers EX-004, ADR 031
  it("[TC-PE-499] records a push's step before it pushes, and pushes nothing when the step cannot be recorded", async () => {
    const { folder, repository, remote, commit } = await setUp("recorded");
    const rows = new Map<string, CharmCall>();
    const unrecorded = await push(
      folder,
      repository,
      { access: accessFor(folder, "trusting"), rows, records: () => false },
      { branch: "feat/x", key: "rec-1" },
    );
    expect(unrecorded).toEqual({ text: UNRECORDED_TOOL_CALL, refused: true });
    expect(headOf(remote, "feat/x")).toBeNull();
    expect(rows.size).toBe(0);

    // When the step is recorded, nothing has reached GitHub yet, and no call is on record.
    const seen: Array<[string | null, number]> = [];
    const events: Array<RuntimeEvent> = [];
    const pushed = await push(
      folder,
      repository,
      {
        access: accessFor(folder, "trusting"),
        rows,
        events,
        records: () => {
          seen.push([headOf(remote, "feat/x"), rows.size]);
          return true;
        },
      },
      { branch: "feat/x", key: "rec-2" },
    );
    expect(pushed.refused).toBe(false);
    expect(seen).toEqual([[null, 0]]);
    expect(events).toEqual([expect.objectContaining({ _tag: "ToolStarted", tool: "github_push", operation: "push" })]);
    expect(headOf(remote, "feat/x")).toBe(commit);
    expect([...rows.values()].map((row) => row.state)).toEqual(["applied"]);
  });
});
