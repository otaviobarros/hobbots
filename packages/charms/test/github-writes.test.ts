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
  type CharmCall,
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
import {
  GitHubApi,
  GitHubCharmTools,
  type GitHubPostedComment,
  type GitHubPullRequest,
  type GitHubWrite,
  GitPushLive,
  GitRemotes,
} from "../src/index.ts";
import { directSandbox, fixedCredential, memoryCharmCalls } from "./support.ts";

const TOKEN = "ghu_writetoken0123456789abcdefghijklmnopqrstu";
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const ME = "otaviobarros";
const REPOSITORY: GitHubRepository = { owner: "octo", name: "app" };

let root = "";
let folder = "";

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hobbots-github-writes-")));
  folder = path.join(root, "app");
  await fs.mkdir(folder);
});
afterAll(() => fs.rm(root, { recursive: true, force: true }));

interface StoredPullRequest extends GitHubPullRequest {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

interface StoredComment extends GitHubPostedComment {
  readonly number: number;
  readonly createdAt: string;
}

/**
 * How the fake answers the next writes, in order: `ok` does what GitHub would; `lost` does it and then
 * drops the answer; `dropped` loses the request before GitHub does anything; the rest answer as named.
 */
type Script = "ok" | "lost" | "dropped" | "posted-by-other" | "not-sent" | "rate-limited" | "refused";

/** GitHub's REST API for one repository, in memory, with the writes it was sent. */
const makeFakeGitHub = () => {
  const pulls: Array<StoredPullRequest> = [];
  const comments: Array<StoredComment> = [];
  const sent: Array<string> = [];
  const script: Array<Script> = [];
  const branches = new Set(["main", "feat/x", "feat/y", "feat/z"]);
  const items = new Map([
    [7, { title: "Fix the login", pullRequest: false }],
    [8, { title: "Add charms", pullRequest: true }],
    [9, { title: "Write docs", pullRequest: false }],
  ]);
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  let author = ME;
  const writeWith = <A>(what: string, apply: () => A): Effect.Effect<GitHubWrite<A>> =>
    Effect.sync(() => {
      sent.push(what);
      const next = script.shift() ?? "ok";
      switch (next) {
        case "ok":
          return { _tag: "Done", value: apply() };
        case "lost":
          apply();
          return { _tag: "Uncertain", message: "GitHub did not answer in time, or the connection dropped." };
        case "dropped":
          return { _tag: "Uncertain", message: "GitHub did not answer in time, or the connection dropped." };
        case "posted-by-other":
          // Lands under another account, as a read-back must never take for the acting one's.
          author = "someone";
          apply();
          author = ME;
          return { _tag: "Uncertain", message: "GitHub did not answer in time, or the connection dropped." };
        case "not-sent":
          return { _tag: "NotSent", message: "The hub could not reach GitHub, so nothing was sent." };
        case "rate-limited":
          return {
            _tag: "RateLimited",
            message: "GitHub's rate limit is used up, so nothing was sent. Try again later.",
          };
        case "refused":
          return { _tag: "Refused", message: "GitHub refused it (422): Validation Failed" };
      }
    });

  const layer = Layer.succeed(
    GitHubApi,
    GitHubApi.of({
      repository: () =>
        Effect.succeed({
          fullName: "octo/app",
          description: null,
          defaultBranch: "main",
          visibility: "private",
          url: "https://github.com/octo/app",
          openIssuesAndPullRequests: 0,
        }),
      search: () => Effect.die("not used"),
      item: (_agentId, _repository, number) => {
        const item = items.get(number);
        return item === undefined
          ? Effect.die(`no item ${number}`)
          : Effect.succeed({
              number,
              title: item.title,
              state: "open",
              author: ME,
              updatedAt: now(),
              pullRequest: item.pullRequest,
              url: `https://github.com/octo/app/issues/${number}`,
              body: "",
              labels: [],
              commentCount: 0,
              comments: [],
            });
      },
      branchHead: (_agentId, _repository, branch) => Effect.succeed(branches.has(branch) ? "a".repeat(40) : null),
      viewer: () => Effect.succeed(ME),
      pullRequests: (_agentId, _repository, head, base) =>
        Effect.succeed(pulls.filter((pr) => pr.head === head && pr.base === base).toReversed()),
      commentsSince: (_agentId, _repository, number, since) =>
        Effect.succeed(comments.filter((c) => c.number === number && c.createdAt >= since)),
      openPullRequest: (_agentId, _repository, pr) =>
        writeWith(`pull ${pr.head} into ${pr.base}`, () => {
          const number = 100 + pulls.length;
          const stored = {
            ...pr,
            number,
            url: `https://github.com/octo/app/pull/${number}`,
            author,
            createdAt: now(),
          };
          pulls.push(stored);
          return stored;
        }),
      comment: (_agentId, _repository, number, body) =>
        writeWith(`comment #${number}`, () => {
          const stored = {
            number,
            body,
            author,
            createdAt: now(),
            url: `https://github.com/octo/app/issues/${number}#issuecomment-${comments.length + 1}`,
          };
          comments.push(stored);
          return stored;
        }),
    }),
  );
  return { layer, pulls, comments, sent, script, branches };
};

type FakeGitHub = ReturnType<typeof makeFakeGitHub>;

const accessFor = (preset: SafetyPreset = "balanced", overrides: Record<string, PolicyDecision> = {}): ToolAccess => ({
  policy: {
    preset,
    sharedFolders: [folder],
    hob: { ...EMPTY_HOB_POLICY, overrides },
    dataFolder: path.join(root, "data"),
    restrictions: [],
  },
  folders: [folder],
  runtimeFolder: path.join(root, "runtimes", "hob"),
});

interface Turn {
  readonly access?: ToolAccess;
  readonly asked?: Array<ApprovalAction>;
  readonly answer?: "approve" | "deny";
  readonly events?: Array<RuntimeEvent>;
  readonly step?: string;
  readonly whileAsking?: () => void;
}

/** The user, as the test plays them: they answer each request the way `answer` says, and are recorded. */
const userApprovals = (turn: Turn, access: ToolAccess): TurnApprovals => ({
  request: (action) =>
    Effect.gen(function* () {
      const asked = turn.asked ?? [];
      asked.push(action);
      turn.whileAsking?.();
      const digest = yield* actionDigest(action);
      const decision: ApprovalOutcome =
        (turn.answer ?? "approve") === "approve"
          ? { _tag: "Approved", actionDigest: digest, policyVersion: action.policyVersion, lifetime: "once" }
          : { _tag: "Denied", reason: "Not yet." };
      return { approvalId: ApprovalId.make(`approval-${asked.length}`), decision: Effect.succeed(decision) };
    }),
  currentAccess: Effect.succeed(access),
  grants: Effect.succeed([]),
  used: () => Effect.void,
});

/** A hub with the GitHub Charm over the fake GitHub, whose call records live in `rows`. */
const makeHub = (
  github: FakeGitHub = makeFakeGitHub(),
  rows = new Map<string, CharmCall>(),
  credential = fixedCredential(TOKEN),
) => {
  const layer = GitHubCharmTools.pipe(
    Layer.provide(
      Layer.mergeAll(
        github.layer,
        Layer.succeed(
          GitRemotes,
          GitRemotes.of({ repositoryOf: (f) => Effect.succeed(f === folder ? REPOSITORY : null) }),
        ),
        PolicyEngine.node,
        memoryCharmCalls(rows),
        credential.layer,
        GitPushLive({ folder: path.join(root, "data", "charms", "github") }).pipe(
          Layer.provide(Layer.mergeAll(directSandbox, NodeServices.layer)),
        ),
      ),
    ),
  );
  const call = (tool: string, input: Record<string, unknown>, turn: Turn = {}) =>
    Effect.gen(function* () {
      const charms = yield* CharmTools;
      const access = turn.access ?? accessFor();
      const tools = yield* charms.forTurn({
        agentId: AgentId.make("hob"),
        threadId: ThreadId.make("t1"),
        messageId: MessageId.make("m1"),
        currentAccess: Effect.succeed(access),
        redactor: makeRedactor(),
        approvals: userApprovals(turn, access),
      });
      if (tools === null) throw new Error("The turn was offered no GitHub tools");
      const events = turn.events ?? [];
      const answer: HubToolAnswer = yield* tools.call(tool, input, {
        id: turn.step ?? "toolu_1",
        report: (event: RuntimeEvent) => events.push(event),
      });
      return answer;
    }).pipe(Effect.provide(layer), Effect.runPromise);
  return { github, rows, credential, call };
};

const states = (rows: Map<string, CharmCall>) => [...rows.values()].map((row) => [row.key, row.state]);

describe("the GitHub Charm's pull requests and comments", () => {
  // covers PE-003, PE-007
  it("[TC-PE-202] opens a draft pull request under Balanced after the user approves exactly what the card showed", async () => {
    const hub = makeHub();
    const asked: Array<ApprovalAction> = [];
    const events: Array<RuntimeEvent> = [];
    const body = `Adds the thing.\n\n${"More words. ".repeat(150)}`;
    const answer = await hub.call(
      "github_open_pull_request",
      { head: "feat/x", title: "feat: add the thing", body, key: "pr-1" },
      { asked, events },
    );
    expect(answer).toMatchObject({
      refused: false,
      text: expect.stringContaining(
        "Opened draft pull request #100 from feat/x into main in octo/app: https://github.com/octo/app/pull/100",
      ),
    });
    expect(answer.text).toContain("They approved it just this once");
    expect(hub.github.pulls).toMatchObject([
      { head: "feat/x", base: "main", title: "feat: add the thing", body, draft: true },
    ]);
    const [card] = asked as [ApprovalAction];
    expect(asked).toHaveLength(1);
    expect(card).toMatchObject({
      tool: "github_open_pull_request",
      operation: "open-pull-request",
      targets: ["github.com/octo/app into main"],
      onceOnly: false,
      grantable: true,
      rules: [{ _tag: "PullRequest", cwd: folder, repository: "octo/app", base: "main" }],
    });
    expect(card.arguments).toMatchObject({
      head: "feat/x",
      base: "main",
      title: "feat: add the thing",
      body,
      draft: true,
    });
    const summary = String(card.arguments.summary);
    expect(summary).toContain("Open a draft pull request in octo/app from feat/x into main");
    expect(summary).toContain("Title: feat: add the thing");
    // The card shows the start of the body; its digest covers all of it.
    expect(summary).toContain("Adds the thing.");
    expect(summary).toContain("more characters]");
    expect(summary).toContain(`As you (@${ME}).`);
    expect(events.map((event) => event._tag)).toEqual(["ToolAwaitingApproval", "ToolStarted"]);
    expect(states(hub.rows)).toEqual([["pr-1", "applied"]]);
  });

  // covers PE-003, PE-007
  it("[TC-PE-203] comments after approval, ending the comment with a marker the hob never sees", async () => {
    const hub = makeHub();
    const asked: Array<ApprovalAction> = [];
    const answer = await hub.call("github_comment", { number: 8, body: "Looks good to me.", key: "c-1" }, { asked });
    expect(answer).toMatchObject({
      refused: false,
      text: expect.stringContaining("Commented on pull request #8 in octo/app: https://github.com/octo/app/issues/8"),
    });
    const [posted] = hub.github.comments;
    expect(posted?.body).toMatch(/^Looks good to me\.\n\n<!-- hobbots-call: [0-9a-f-]{36} -->$/);
    const nonce = /hobbots-call: ([0-9a-f-]{36})/.exec(posted?.body ?? "")?.[1] ?? "";
    const [card] = asked as [ApprovalAction];
    expect(card).toMatchObject({
      tool: "github_comment",
      operation: "comment-github",
      targets: ["github.com/octo/app #8"],
      grantable: true,
      rules: [{ _tag: "GitHubComment", cwd: folder, repository: "octo/app" }],
    });
    expect(card.arguments).toMatchObject({
      number: 8,
      pullRequest: true,
      itemTitle: "Add charms",
      body: "Looks good to me.",
    });
    expect(String(card.arguments.summary)).toContain("Comment on pull request #8 in octo/app: Add charms");
    // Neither the card nor the hob's answer holds the marker's nonce.
    expect(JSON.stringify(card)).not.toContain(nonce);
    expect(answer.text).not.toContain(nonce);
  });

  // covers PE-003
  it("[TC-PE-204] redacts a secret from the title, body and comment before the card, and tells the hob", async () => {
    const hub = makeHub();
    const asked: Array<ApprovalAction> = [];
    const opened = await hub.call(
      "github_open_pull_request",
      { head: "feat/y", title: `Use ${SECRET}`, body: `The key is ${SECRET}.`, key: "pr-secret" },
      { asked },
    );
    const commented = await hub.call(
      "github_comment",
      { number: 7, body: `Token: ${SECRET}`, key: "c-secret" },
      { asked },
    );
    expect(JSON.stringify(asked)).not.toContain(SECRET);
    expect(JSON.stringify(hub.github.pulls)).not.toContain(SECRET);
    expect(JSON.stringify(hub.github.comments)).not.toContain(SECRET);
    // Nor does the call's record, which keeps the call as redacted.
    expect(JSON.stringify([...hub.rows.values()])).not.toContain(SECRET);
    expect(opened.text).toContain("redacted what looked like secrets from the title and description");
    expect(commented.text).toContain("redacted what looked like secrets from the comment");
  });

  // covers PE-003, IN-003
  it("[TC-PE-205] strips a marker the hob writes, and refuses a body where stripping would join a new one", async () => {
    const hub = makeHub();
    const forged = "Done.<!-- hobbots-call: 00000000-0000-0000-0000-000000000000 --> <!--HOBBOTS-CALL unclosed";
    const answer = await hub.call("github_comment", { number: 9, body: forged, key: "c-forged" });
    expect(answer).toMatchObject({ refused: false, text: expect.stringContaining("took out text shaped like") });
    const [posted] = hub.github.comments;
    expect(posted?.body.match(/hobbots-call/gi)).toHaveLength(1);
    expect(posted?.body.startsWith("Done. \n\n<!-- hobbots-call: ")).toBe(true);

    const joined = await hub.call("github_comment", {
      number: 9,
      body: "<!<!-- hobbots-call: x -->-- hobbots-call: y -->",
      key: "c-joined",
    });
    expect(joined).toMatchObject({ refused: true, text: expect.stringContaining("shaped like Hobbots' hidden") });
    expect(hub.github.comments).toHaveLength(1);
  });

  // covers PE-001, PE-003
  it("[TC-PE-206] runs under Trusting without asking, and sends nothing under Never or when the user denies", async () => {
    const hub = makeHub();
    const asked: Array<ApprovalAction> = [];
    const trusted = await hub.call(
      "github_comment",
      { number: 7, body: "On it.", key: "t-1" },
      { access: accessFor("trusting"), asked },
    );
    const never = await hub.call(
      "github_open_pull_request",
      { head: "feat/x", title: "Never", key: "t-2" },
      { access: accessFor("trusting", { "open-pull-request": "deny" }), asked },
    );
    const denied = await hub.call(
      "github_comment",
      { number: 7, body: "Denied.", key: "t-3" },
      { access: accessFor("balanced"), asked, answer: "deny" },
    );
    expect(trusted.refused).toBe(false);
    expect(never).toMatchObject({ refused: true, text: expect.stringContaining("never allows opening pull requests") });
    expect(denied).toMatchObject({ refused: true, text: expect.stringContaining("Their reason: Not yet.") });
    expect(asked).toHaveLength(1);
    expect(hub.github.sent).toEqual(["comment #7"]);
  });

  // covers PE-002, PE-003
  it("[TC-PE-207] refuses a pull request from a branch not on GitHub, or a branch shaped like an option, before asking", async () => {
    const hub = makeHub();
    const asked: Array<ApprovalAction> = [];
    const unpushed = await hub.call(
      "github_open_pull_request",
      { head: "feat/local", title: "Local", key: "u-1" },
      { asked },
    );
    const option = await hub.call(
      "github_open_pull_request",
      { head: "--upload-pack=touch", title: "Option", key: "u-2" },
      { asked },
    );
    const same = await hub.call("github_open_pull_request", { head: "main", title: "Same", key: "u-3" }, { asked });
    expect(unpushed).toMatchObject({ refused: true, text: expect.stringContaining("Push it with github_push first") });
    expect(option.refused).toBe(true);
    expect(same).toMatchObject({ refused: true, text: expect.stringContaining("head branch other than main") });
    expect(asked).toHaveLength(0);
    expect(hub.github.sent).toEqual([]);
  });

  // covers PE-005, PE-003
  it("[TC-PE-208] does not send under another GitHub account connected while the card waits, and asks again", async () => {
    const credential = fixedCredential(TOKEN);
    const hub = makeHub(makeFakeGitHub(), new Map(), credential);
    const asked: Array<ApprovalAction> = [];
    const switched = await hub.call(
      "github_comment",
      { number: 7, body: "Hello.", key: "s-1" },
      { asked, whileAsking: credential.switchAccount },
    );
    expect(switched).toMatchObject({ refused: true, text: expect.stringContaining("sign-in changed") });
    expect(hub.github.sent).toEqual([]);
    const again = await hub.call("github_comment", { number: 7, body: "Hello.", key: "s-1" }, { asked });
    expect(again.refused).toBe(false);
    expect(asked).toHaveLength(2);
    expect(hub.github.sent).toEqual(["comment #7"]);
  });
});

describe("never twice: retried and uncertain pull requests and comments", () => {
  // covers IN-003, EX-004
  it("[TC-IN-100] returns the first result for a retried key without asking or sending again", async () => {
    const hub = makeHub();
    const asked: Array<ApprovalAction> = [];
    const pr = { head: "feat/x", title: "One", key: "same-pr" };
    const first = await hub.call("github_open_pull_request", pr, { asked });
    const again = await hub.call("github_open_pull_request", pr, { asked, step: "toolu_2" });
    const comment = { number: 7, body: "Once.", key: "same-c" };
    await hub.call("github_comment", comment, { asked });
    const commentAgain = await hub.call("github_comment", comment, { asked, step: "toolu_3" });
    const otherCall = await hub.call("github_comment", { ...comment, body: "Other." }, { asked });
    expect(first.refused).toBe(false);
    expect(again.text).toContain("You made this call before, so it was not sent again.");
    expect(again.text).toContain("pull request #100");
    expect(commentAgain.text).toContain("You made this call before");
    expect(otherCall.text).toContain("You already used the key same-c for another call.");
    expect(asked).toHaveLength(2);
    expect(hub.github.sent).toEqual(["pull feat/x into main", "comment #7"]);
  });

  // covers EX-003, EX-004
  it("[TC-IN-101] settles a pull request whose answer was lost as applied, with its link, when GitHub shows it", async () => {
    const hub = makeHub();
    hub.github.script.push("lost");
    const events: Array<RuntimeEvent> = [];
    const answer = await hub.call(
      "github_open_pull_request",
      { head: "feat/x", base: "main", title: "Lost", key: "lost-pr" },
      { access: accessFor("trusting"), events },
    );
    expect(answer).toMatchObject({ refused: false, text: expect.stringContaining("pull request #100") });
    expect(answer.text).toContain("https://github.com/octo/app/pull/100");
    expect(states(hub.rows)).toEqual([["lost-pr", "applied"]]);
    expect(events.map((event) => event._tag)).toEqual(["ToolStarted"]);
    expect(hub.github.sent).toHaveLength(1);
  });

  // covers EX-003, EX-004
  it("[TC-IN-102] keeps a pull request uncertain when only an older one from that head exists, and blocks another", async () => {
    const github = makeFakeGitHub();
    // A pull request from the same head into the same base, opened before this call by the same account.
    github.pulls.push({
      number: 42,
      url: "https://github.com/octo/app/pull/42",
      author: ME,
      createdAt: "2026-01-01T00:00:00Z",
      head: "feat/z",
      base: "main",
      title: "Older",
      body: "",
      draft: false,
    });
    github.script.push("dropped");
    const hub = makeHub(github);
    const events: Array<RuntimeEvent> = [];
    const turn = { access: accessFor("trusting"), events };
    const answer = await hub.call("github_open_pull_request", { head: "feat/z", title: "New", key: "u-pr" }, turn);
    expect(answer).toMatchObject({ refused: true, text: expect.stringContaining("Do not repeat it") });
    expect(answer.text).not.toContain("#42");
    expect(states(hub.rows)).toEqual([["u-pr", "uncertain"]]);
    expect(events.map((event) => event._tag)).toEqual(["ToolStarted", "ToolUncertain"]);
    const blocked = await hub.call(
      "github_open_pull_request",
      { head: "feat/z", title: "Again", key: "u-pr-2" },
      { ...turn, step: "toolu_2" },
    );
    expect(blocked).toMatchObject({ refused: true, text: expect.stringContaining("has not settled yet") });
    // Another head is another site, so it is not held up.
    const other = await hub.call(
      "github_open_pull_request",
      { head: "feat/y", title: "Other", key: "u-pr-3" },
      { ...turn, step: "toolu_3" },
    );
    expect(other.refused).toBe(false);
    expect(github.sent).toEqual(["pull feat/z into main", "pull feat/y into main"]);
  });

  // covers EX-003, EX-004
  it("[TC-IN-103] settles a comment whose answer was lost as applied when its marker is on GitHub", async () => {
    const hub = makeHub();
    // Someone else posts a comment that copies the marker shape; only the hub's own nonce counts.
    hub.github.comments.push({
      number: 7,
      body: "<!-- hobbots-call: 11111111-1111-1111-1111-111111111111 -->",
      author: "someone",
      createdAt: "2026-01-01T00:00:00Z",
      url: "https://github.com/octo/app/issues/7#issuecomment-0",
    });
    hub.github.script.push("lost");
    const answer = await hub.call(
      "github_comment",
      { number: 7, body: "Lost answer.", key: "lost-c" },
      { access: accessFor("trusting") },
    );
    expect(answer).toMatchObject({
      refused: false,
      text: expect.stringContaining("https://github.com/octo/app/issues/7#issuecomment-2"),
    });
    expect(states(hub.rows)).toEqual([["lost-c", "applied"]]);
  });

  // covers EX-003, EX-004
  it("[TC-IN-104] keeps a comment uncertain when its marker is not found, and blocks another on that item only", async () => {
    const hub = makeHub();
    hub.github.script.push("dropped");
    const turn = { access: accessFor("trusting") };
    const answer = await hub.call("github_comment", { number: 7, body: "Dropped.", key: "u-c" }, turn);
    expect(answer).toMatchObject({ refused: true, text: expect.stringContaining("Do not repeat it") });
    const sameKey = await hub.call("github_comment", { number: 7, body: "Dropped.", key: "u-c" }, turn);
    expect(sameKey.text).toContain("Do not repeat it");
    const blocked = await hub.call("github_comment", { number: 7, body: "Again.", key: "u-c-2" }, turn);
    expect(blocked).toMatchObject({ refused: true, text: expect.stringContaining("has not settled yet") });
    const otherItem = await hub.call("github_comment", { number: 9, body: "Elsewhere.", key: "u-c-3" }, turn);
    expect(otherItem.refused).toBe(false);
    expect(hub.github.sent).toEqual(["comment #7", "comment #9"]);
  });

  // covers EX-004
  it("[TC-IN-105] tries once more when nothing was sent, and never retries a rate limit or a refusal by itself", async () => {
    const hub = makeHub();
    const turn = { access: accessFor("trusting") };
    hub.github.script.push("not-sent");
    const retried = await hub.call("github_comment", { number: 7, body: "Second try.", key: "n-1" }, turn);
    expect(retried.refused).toBe(false);
    expect(hub.github.sent).toEqual(["comment #7", "comment #7"]);

    hub.github.script.push("rate-limited");
    const limited = await hub.call("github_comment", { number: 9, body: "Limited.", key: "n-2" }, turn);
    expect(limited).toMatchObject({ refused: true, text: expect.stringContaining("rate limit") });
    hub.github.script.push("refused");
    const refused = await hub.call("github_open_pull_request", { head: "feat/x", title: "No", key: "n-3" }, turn);
    expect(refused).toMatchObject({ refused: true, text: expect.stringContaining("Validation Failed") });
    expect(hub.github.sent).toEqual(["comment #7", "comment #7", "comment #9", "pull feat/x into main"]);
    // Nothing was done under the rate limit, so the same key may run again; a refusal keeps its answer.
    const limitedAgain = await hub.call("github_comment", { number: 9, body: "Limited.", key: "n-2" }, turn);
    const refusedAgain = await hub.call("github_open_pull_request", { head: "feat/x", title: "No", key: "n-3" }, turn);
    expect(limitedAgain.refused).toBe(false);
    expect(refusedAgain.text).toContain("You made this call before");
    expect(states(hub.rows)).toEqual([
      ["n-1", "applied"],
      ["n-2", "applied"],
      ["n-3", "refused"],
    ]);
  });

  // covers EX-003, EX-004
  it("[TC-IN-106] never takes another account's pull request, or one there when deciding, for this call's", async () => {
    const github = makeFakeGitHub();
    // Dated after the call, as a hub clock behind GitHub's would see it, but listed when deciding.
    const later = new Date(Date.now() + 60_000).toISOString();
    github.pulls.push({
      number: 10,
      url: "https://github.com/octo/app/pull/10",
      author: ME,
      createdAt: later,
      head: "feat/x",
      base: "main",
      title: "Closed earlier",
      body: "",
      draft: false,
    });
    github.script.push("posted-by-other");
    const hub = makeHub(github);
    const answer = await hub.call(
      "github_open_pull_request",
      { head: "feat/x", title: "Mine", key: "o-pr" },
      { access: accessFor("trusting") },
    );
    expect(github.pulls.map((pr) => [pr.number, pr.author])).toEqual([
      [10, ME],
      [101, "someone"],
    ]);
    expect(answer).toMatchObject({ refused: true, text: expect.stringContaining("Do not repeat it") });
    expect(states(hub.rows)).toEqual([["o-pr", "uncertain"]]);
  });

  // covers EX-003, EX-004
  it("[TC-IN-107] never takes a comment with this call's marker posted by another account for this call's", async () => {
    const hub = makeHub();
    hub.github.script.push("posted-by-other");
    const answer = await hub.call(
      "github_comment",
      { number: 7, body: "Mine.", key: "o-c" },
      { access: accessFor("trusting") },
    );
    expect(hub.github.comments.map((c) => c.author)).toEqual(["someone"]);
    expect(answer).toMatchObject({ refused: true, text: expect.stringContaining("Do not repeat it") });
    expect(states(hub.rows)).toEqual([["o-c", "uncertain"]]);
  });
});
