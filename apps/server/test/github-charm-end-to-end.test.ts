import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import {
  ApprovalService,
  CharmCallService,
  ChatService,
  FolderSandbox,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PermissionSummary,
  SecretRedaction,
} from "@hobbots/agents";
import {
  GitHubAccountLive,
  GitHubApiNode,
  GitHubCharmTools,
  GitHubSignInNode,
  GitPushLive,
  GitRemotes,
  KeychainMemory,
  LocalGitHubSignInsNone,
} from "@hobbots/charms";
import { type FakeGitHub, startFakeGitHub } from "@hobbots/charms/testing";
import {
  type Agent,
  type ApprovalRequest,
  isInProgress,
  type Message,
  type ReplyStep,
  roleFields,
  type Thread,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  CharmCallsLive,
  EventJournal,
  GitHubAccountRepository,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { ToolLogsLive } from "../src/tool-logs.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// The GitHub Charm's done-when checks (ADR 020, #325), at hub level and over the HTTP API, with the
// hub's own composition and the fake runtime making the scripted calls. Everything the hub sends to
// GitHub goes to a fake GitHub on a local port (`@hobbots/charms/testing`): the device flow, the REST
// API and Git over HTTP. The cases run in order, as a person would: connect, read, push, open a pull
// request, comment, and finally look everywhere a hob could reach for a credential. CI runs them on
// SQLite and on PostgreSQL.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-github-e2e-")));
const project = join(temp, "project");
const uninstalled = join(temp, "uninstalled");
const elsewhere = join(temp, "elsewhere");
const dataDir = join(temp, "hub", "data");
const sandboxRecords = join(temp, "sandbox-records");
for (const folder of [project, uninstalled, elsewhere, dataDir, sandboxRecords]) mkdirSync(folder, { recursive: true });

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: temp,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Pip",
      GIT_AUTHOR_EMAIL: "pip@example.com",
      GIT_COMMITTER_NAME: "Pip",
      GIT_COMMITTER_EMAIL: "pip@example.com",
    },
  }).trim();

/** A commit of one new file on the folder's current branch. */
const commit = (folder: string, file: string, subject: string) => {
  writeFileSync(join(folder, file), `${subject}\n`);
  git(folder, "add", file);
  git(folder, "commit", "--quiet", "--no-gpg-sign", "-m", subject);
  return git(folder, "rev-parse", "HEAD");
};

/** A repository with one commit on `main`, whose origin is `slug` on github.com. */
const repositoryIn = (folder: string, slug: string) => {
  git(folder, "init", "--quiet", "--initial-branch=main");
  git(folder, "remote", "add", "origin", `https://github.com/${slug}.git`);
  commit(folder, "README.md", "First");
};

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Stands in for the hob's sandbox, which this hub's CI cannot start: it runs the program as it is,
 * after writing the environment the program gets to `sandboxRecords`, so the last case can look
 * for a credential there. The Charm's own fence is proven against the real sandbox in TC-PE-152.
 */
const RecordingSandbox = Layer.succeed(
  FolderSandbox,
  FolderSandbox.of({
    readOnly: (_folders, program, args) =>
      Effect.succeed({
        // Git appends its own arguments to the command line; `sh -c` takes them as `$0` and on, unused.
        commandLine: `sh -c ${quote(`env > ${quote(sandboxRecords)}/env-$$; exec ${[program, ...args].map(quote).join(" ")}`)}`,
        env: {},
      }),
  }),
);

let github: FakeGitHub;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let database: SqlClient.SqlClient;
/** Every body the API answered, to look for a credential in what a client reads. */
const answered: Array<string> = [];

beforeAll(async () => {
  github = await startFakeGitHub({ folder: join(temp, "github"), login: "otaviobarros", pendingPolls: 1 });
  // The hob's project is on GitHub with the app installed; `main` is there, its feature branches are not.
  repositoryIn(project, "octo/workshop");
  github.createRepository({ owner: "octo", name: "workshop", from: project, description: "Where Pip works" });
  github.install("octo/workshop");
  github.addItem("octo/workshop", { title: "Crash on start", labels: ["bug"], author: "ada" });
  github.addItem("octo/workshop", { title: "Dark mode", labels: ["feature"], author: "ada" });
  github.addItem("octo/workshop", { title: "Typo in the docs", labels: ["bug"], author: "ada" });
  github.addItem("octo/workshop", { title: "Old question", state: "closed", author: "ada" });
  github.addItem("octo/workshop", {
    title: "Faster start",
    author: "ada",
    pullRequest: { head: "faster", base: "main" },
  });
  github.addItem("octo/workshop", {
    title: "Shipped",
    state: "closed",
    author: "ada",
    pullRequest: { head: "shipped", base: "main", merged: true },
  });
  // One of the hob's folders whose repository the app is not installed on, and one outside its folders.
  repositoryIn(uninstalled, "octo/uninstalled");
  github.createRepository({ owner: "octo", name: "uninstalled", from: uninstalled });
  repositoryIn(elsewhere, "octo/secret");
  github.createRepository({ owner: "octo", name: "secret", from: elsewhere });
  github.install("octo/secret");

  const charmFolder = join(dataDir, "charms", "github");
  const Account = GitHubAccountLive({ clientId: "Iv23liFakeHobbots", slug: "hobbots", environmentToken: null }).pipe(
    Layer.provide(
      Layer.mergeAll(KeychainMemory, GitHubSignInNode(github.hosts), LocalGitHubSignInsNone, GitHubAccountRepository),
    ),
  );
  const Charms = GitHubCharmTools.pipe(
    Layer.provide(
      Layer.mergeAll(
        GitHubApiNode(github.hosts.api),
        GitRemotes.layer,
        PolicyEngine.node,
        GitPushLive({ folder: charmFolder, httpsBase: github.base }).pipe(Layer.provide(RecordingSandbox)),
      ),
    ),
    Layer.provideMerge(Account),
    Layer.provide(NodeServices.layer),
  );
  const Database = Layer.effectDiscard(
    Effect.map(SqlClient.SqlClient, (sql) => {
      database = sql;
    }),
  );
  const App = HobLifecycle.layer
    .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer)))
    .pipe(Layer.provideMerge(ChatService.layer))
    .pipe(Layer.provideMerge(ApprovalService.layer))
    .pipe(Layer.provideMerge(GrantService.layer))
    .pipe(Layer.provideMerge(HobToolsLive))
    .pipe(Layer.provideMerge(Layer.merge(Charms, CharmCallService.layer)))
    .pipe(Layer.provideMerge(CanonicalSharedFolders))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mergeAll(
            HobbotsRepositoryLive,
            ApprovalRepositoryLive,
            GrantRepositoryLive,
            TaskRepositoryLive,
            CharmCallsLive,
            EventJournal.layer,
            BackpackLive,
            SetupRepository.layer,
            SearchIndex.layer,
            Database,
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
  await github.close();
  rmSync(temp, { recursive: true, force: true });
});

const request = async <A>(method: string, path: string, body?: unknown): Promise<{ status: number; body: A }> => {
  const response = await handler(
    new Request(`http://localhost:4364${path}`, {
      method,
      headers: { "content-type": "application/json", host: "localhost:4364", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  answered.push(text);
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const eventually = <A>(read: () => Promise<A | undefined>) =>
  Effect.runPromise(
    Effect.tryPromise(read).pipe(
      Effect.flatMap((value) => (value === undefined ? Effect.fail("waiting" as const) : Effect.succeed(value))),
      Effect.retry(Schedule.spaced("10 millis")),
    ),
  );

const toolSteps = (reply: Message): ReadonlyArray<ReplyStep> => reply.steps.filter((step) => step.kind === "tool");

const approvalsOf = async (thread: Thread) =>
  (await request<ReadonlyArray<ApprovalRequest>>("GET", `/api/threads/${thread.id}/approvals`)).body;

/** The last reply of the thread once it has ended. */
const settled = (thread: Thread) =>
  eventually(async () => {
    const reply = (await request<ReadonlyArray<Message>>("GET", `/api/threads/${thread.id}/messages`)).body.at(-1);
    return reply?.role === "assistant" && !isInProgress(reply.status) ? reply : undefined;
  });

let hob: Agent | undefined;

/** Pip, on Balanced, sharing the project and the folder whose repository the app is not installed on. */
const pip = async (): Promise<Agent> => {
  if (hob !== undefined) return hob;
  await request("PATCH", "/api/setup", {
    completed: true,
    safetyPreset: "balanced",
    approvedFolders: [project, uninstalled],
  });
  const summoned = await request<Agent>("POST", "/api/agents", {
    name: "Pip",
    ...roleFields("writer"),
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  hob = summoned.body;
  return hob;
};

/** Pip makes the scripted Charm calls in a new thread: the request it waits on, or its finished reply. */
const turn = async (...calls: Array<string>) => {
  const thread = (await request<Thread>("POST", `/api/agents/${(await pip()).id}/threads`)).body;
  const content = ["Go", ...calls.map((call) => `fake:hub ${call}`)].join("\n");
  expect((await request("POST", `/api/threads/${thread.id}/messages`, { content })).status).toBe(200);
  return eventually(async () => {
    const pending = (await approvalsOf(thread)).find((approval) => approval.state === "pending");
    if (pending) return { thread, pending, reply: undefined };
    const reply = (await request<ReadonlyArray<Message>>("GET", `/api/threads/${thread.id}/messages`)).body.at(-1);
    return reply?.role === "assistant" && !isInProgress(reply.status)
      ? { thread, pending: undefined, reply }
      : undefined;
  });
};

const call = (tool: string, input: Record<string, unknown>) => `${tool} ${JSON.stringify(input)}`;

const decide = (approval: ApprovalRequest, decision: Record<string, unknown>) =>
  request<ApprovalRequest & { readonly _tag?: string }>("POST", `/api/approvals/${approval.id}/decision`, {
    actionDigest: approval.actionDigest,
    ...decision,
  });

/** Approves the request just this once and waits for the reply to end. */
const approveOnce = async (
  asked: { readonly thread: Thread; readonly pending?: ApprovalRequest | undefined },
  high = false,
) => {
  expect(asked.pending).toBeDefined();
  const decided = await decide(asked.pending as ApprovalRequest, {
    decision: "approve",
    ...(high ? { confirmed: true } : {}),
  });
  expect(decided.body).toMatchObject({ state: "approved" });
  return settled(asked.thread);
};

const connected = async () => {
  const status = await request<{ readonly _tag: string }>("GET", "/api/charms/github");
  if (status.body._tag === "Connected") return;
  await request("POST", "/api/charms/github/connect");
  await eventually(async () => {
    const now = await request<{ readonly _tag: string }>("GET", "/api/charms/github");
    return now.body._tag === "Connected" ? now.body : undefined;
  });
};

/** GitHub API requests that named a repository other than the hob's own. */
const touched = (slug: string) =>
  github.requests.filter(
    (sent) =>
      sent.path.startsWith(`/repos/${slug}`) ||
      sent.path.startsWith(`/${slug}.git`) ||
      sent.query.get("q")?.includes(`repo:${slug}`),
  );

describe("the GitHub Charm, end to end against a fake GitHub", () => {
  // covers PE-002, PE-008
  it("[TC-PE-240] connects through the device flow, shows the account and its repositories, and only then offers the Charm", async () => {
    const before = await turn(call("github_repository", {}));
    expect(before.reply?.content).not.toContain("octo/workshop");
    expect(github.requests).toEqual([]);

    const started = await request<{ readonly _tag: string; readonly userCode?: string }>(
      "POST",
      "/api/charms/github/connect",
    );
    expect(started.body).toMatchObject({ _tag: "Connecting", userCode: "FAKE-0001" });
    const account = await eventually(async () => {
      const status = await request<{ readonly _tag: string; readonly account?: { readonly login: string } }>(
        "GET",
        "/api/charms/github",
      );
      return status.body._tag === "Connected" ? status.body.account : undefined;
    });
    expect(account).toMatchObject({ login: "otaviobarros" });
    // GitHub was polled until the code was entered: once pending, then granted.
    expect(github.requests.filter((sent) => sent.path === "/login/oauth/access_token")).toHaveLength(2);
    const reachable = await request<{ readonly repositories: ReadonlyArray<{ readonly fullName: string }> }>(
      "GET",
      "/api/charms/github/repositories",
    );
    expect(reachable.body.repositories?.map((repository) => repository.fullName)).toEqual([
      "octo/secret",
      "octo/workshop",
    ]);

    const after = await turn(call("github_repository", {}));
    expect(after.reply?.content).toContain("octo/workshop (private), default branch main");
  }, 30_000);

  // covers PE-002, PE-008
  it("[TC-PE-241] reads the repository's counts of issues and pull requests without asking", async () => {
    await connected();
    const read = await turn(
      call("github_repository", {}),
      call("github_search", { kind: "issue" }),
      call("github_search", { kind: "issue", label: "bug", limit: 0 }),
      call("github_search", { kind: "pull_request", state: "merged", limit: 0 }),
      call("github_search", { kind: "pull_request", state: "all", limit: 0 }),
    );
    expect(read.pending).toBeUndefined();
    const reply = read.reply as Message;
    expect(toolSteps(reply).map((step) => step.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(reply.content).toContain("Open issues and pull requests together: 4.");
    expect(reply.content).toContain("3 matches for `repo:octo/workshop is:issue is:open`");
    expect(reply.content).toContain('2 matches for `repo:octo/workshop is:issue is:open label:"bug"`');
    expect(reply.content).toContain("1 match for `repo:octo/workshop is:pr is:merged`");
    expect(reply.content).toContain("2 matches for `repo:octo/workshop is:pr`");
    // Every search the hub sent was pinned to the hob's repository.
    const searches = github.requests.filter((sent) => sent.path === "/search/issues");
    expect(searches.map((sent) => sent.query.get("q")?.split(" ")[0])).toEqual(
      Array(searches.length).fill("repo:octo/workshop"),
    );
  });

  // covers PE-003, PE-007
  it("[TC-PE-242] pushes a branch under Balanced once the user approves the commit the card showed", async () => {
    await connected();
    git(project, "checkout", "--quiet", "-b", "feat/x");
    const pushed = commit(project, "b.txt", "Add b");
    const asked = await turn(call("github_push", { branch: "feat/x", key: "push-feat-x" }));
    expect(asked.pending).toMatchObject({
      tool: "github_push",
      operation: "push",
      onceOnly: false,
      grantable: true,
      arguments: { commit: pushed, commits: 1, subjects: ["Add b"], actingAs: { _tag: "You", login: "otaviobarros" } },
    });
    expect(github.headOf("octo/workshop", "feat/x")).toBeNull();

    const reply = await approveOnce(asked);
    expect(toolSteps(reply)).toMatchObject([{ state: "done" }]);
    expect(reply.content).toContain(`Pushed ${pushed.slice(0, 12)} to octo/workshop branch feat/x`);
    expect(github.headOf("octo/workshop", "feat/x")).toBe(pushed);
  }, 30_000);

  // covers PE-003, PE-007
  it("[TC-PE-243] asks once only for a force push, never saves it as a rule, and asks again the next time", async () => {
    await connected();
    git(project, "checkout", "--quiet", "feat/x");
    const before = github.headOf("octo/workshop", "feat/x");
    expect(before).not.toBeNull();
    git(project, "commit", "--quiet", "--amend", "--no-gpg-sign", "-m", "Add b, reworded");
    const rewritten = git(project, "rev-parse", "HEAD");

    // Without force, GitHub refuses a branch that does not build on its own.
    const plain = await turn(call("github_push", { branch: "feat/x", key: "push-feat-x-again" }));
    const refused = await approveOnce(plain);
    expect(refused.content).toContain("GitHub refused the push: [rejected] (non-fast-forward)");
    expect(github.headOf("octo/workshop", "feat/x")).toBe(before);

    const forced = await turn(call("github_push", { branch: "feat/x", force: true, key: "force-feat-x" }));
    const card = forced.pending as ApprovalRequest;
    expect(card).toMatchObject({
      onceOnly: true,
      grantable: false,
      arguments: { commit: rewritten, replaces: before },
    });
    // Neither saved as a rule nor approved without the confirmation check box.
    expect((await decide(card, { decision: "approve", lifetime: "always", confirmed: true })).body).toMatchObject({
      _tag: "ApprovalNotGrantable",
    });
    expect((await decide(card, { decision: "approve" })).body).toMatchObject({ _tag: "ApprovalNotConfirmed" });
    const reply = await approveOnce(forced, true);
    expect(toolSteps(reply)).toMatchObject([{ state: "done" }]);
    expect(github.headOf("octo/workshop", "feat/x")).toBe(rewritten);
    expect((await request<ReadonlyArray<unknown>>("GET", "/api/grants")).body).toEqual([]);

    // The approval was for that push alone: the next force push asks again.
    git(project, "commit", "--quiet", "--amend", "--no-gpg-sign", "-m", "Add b, once more");
    const again = await turn(call("github_push", { branch: "feat/x", force: true, key: "force-feat-x-2" }));
    expect(again.pending).toMatchObject({ onceOnly: true, state: "pending" });
    await decide(again.pending as ApprovalRequest, { decision: "deny", reason: "Not this time" });
    await settled(again.thread);
    expect(github.headOf("octo/workshop", "feat/x")).toBe(rewritten);
  }, 30_000);

  // covers PE-003, PE-007
  it("[TC-PE-244] opens a draft pull request from the pushed branch after the user approves the text", async () => {
    await connected();
    const asked = await turn(
      call("github_open_pull_request", {
        head: "feat/x",
        title: "Add b",
        body: "Adds b.\n\nCloses #1.",
        key: "pr-feat-x",
      }),
    );
    expect(asked.pending).toMatchObject({
      tool: "github_open_pull_request",
      operation: "github.open-pull-request",
      arguments: { head: "feat/x", base: "main", draft: true, title: "Add b" },
    });
    const reply = await approveOnce(asked);
    expect(toolSteps(reply)).toMatchObject([{ state: "done" }]);
    const opened = github.items("octo/workshop").find((item) => item.pullRequest?.head === "feat/x");
    expect(opened).toMatchObject({
      title: "Add b",
      body: "Adds b.\n\nCloses #1.",
      author: "otaviobarros",
      pullRequest: { base: "main", draft: true },
    });
    expect(reply.content).toContain(
      `Opened draft pull request #${opened?.number} from feat/x into main in octo/workshop`,
    );
  }, 30_000);

  // covers PE-003, PE-007
  it("[TC-PE-245] comments on an issue after the user approves it, and reads it back without the hub's marker", async () => {
    await connected();
    const asked = await turn(
      call("github_comment", { number: 1, body: "I can reproduce this on main.", key: "comment-1" }),
    );
    expect(asked.pending).toMatchObject({ tool: "github_comment", operation: "github.comment" });
    const reply = await approveOnce(asked);
    expect(toolSteps(reply)).toMatchObject([{ state: "done" }]);
    const [posted] = github.items("octo/workshop").find((item) => item.number === 1)?.comments ?? [];
    expect(posted?.author).toBe("otaviobarros");
    expect(posted?.body).toMatch(/^I can reproduce this on main\.\n*<!-- hobbots-call: \S+ -->$/);

    const read = await turn(call("github_item", { number: 1 }));
    expect(read.reply?.content).toContain("I can reproduce this on main.");
    expect(read.reply?.content).not.toContain("hobbots-call");
  }, 30_000);

  // covers PE-002, PE-004
  it("[TC-PE-246] refuses a repository outside the hob's folders, and one the app is not installed on, before asking or reaching it", async () => {
    await connected();
    git(elsewhere, "checkout", "--quiet", "-b", "steal");
    commit(elsewhere, "c.txt", "Elsewhere");
    git(uninstalled, "checkout", "--quiet", "-b", "feat/y");
    commit(uninstalled, "d.txt", "Uninstalled");
    const sentBefore = github.requests.length;

    const outside = await turn(
      call("github_repository", { folder: elsewhere }),
      call("github_push", { folder: elsewhere, branch: "steal", key: "push-elsewhere" }),
      call("github_open_pull_request", { folder: elsewhere, head: "main", title: "Hi", key: "pr-elsewhere" }),
      call("github_comment", { folder: elsewhere, number: 1, body: "Hi", key: "comment-elsewhere" }),
    );
    expect(outside.pending).toBeUndefined();
    expect(outside.reply?.content.match(/is not one of your folders/g)).toHaveLength(4);

    const notInstalled = await turn(
      call("github_repository", { folder: uninstalled }),
      call("github_push", { folder: uninstalled, branch: "feat/y", key: "push-uninstalled" }),
    );
    expect(notInstalled.pending).toBeUndefined();
    expect(notInstalled.reply?.content.match(/The Hobbots app is not installed on octo\/uninstalled/g)).toHaveLength(2);

    // Neither repository was read or written on GitHub.
    expect(touched("octo/secret")).toEqual([]);
    expect(github.requests.slice(sentBefore).filter((sent) => touched("octo/uninstalled").includes(sent))).toEqual([]);
    expect(github.headOf("octo/secret", "steal")).toBeNull();
    expect(github.headOf("octo/uninstalled", "feat/y")).toBeNull();
  }, 30_000);

  // covers PE-005, PE-006
  it("[TC-PE-247] keeps every credential out of the sandbox's environment, the files a hob can read, the database and tool output", async () => {
    const secrets = github.secrets();
    // The device flow's pair, at least: the cases above signed in.
    expect(secrets.length).toBeGreaterThanOrEqual(2);
    const leaks = (where: string, text: string) => secrets.filter((secret) => text.includes(secret)).map(() => where);

    // The credential reached GitHub, and only as the hub sent it: every signed request used a token GitHub issued.
    const signed = github.requests.filter((sent) => sent.authorization !== undefined);
    expect(signed.length).toBeGreaterThan(0);
    for (const sent of signed) {
      const [kind, value = ""] = (sent.authorization ?? "").split(" ");
      const token = kind === "Basic" ? Buffer.from(value, "base64").toString("utf8").split(":")[1] : value;
      expect(secrets).toContain(token);
    }

    // The environment of every process the Charm started in the hob's sandbox.
    const environments = readdirSync(sandboxRecords);
    expect(environments.length).toBeGreaterThan(0);
    const found = environments.flatMap((name) =>
      leaks(`sandbox environment ${name}`, readFileSync(join(sandboxRecords, name), "utf8")),
    );

    // Every file on the hub: the hob's folders, its runtime folder, tool logs and the Charm's staging repositories.
    const walk = (folder: string): Array<string> =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) return walk(path);
        return entry.isFile() ? [path] : [];
      });
    const files = walk(temp);
    expect(files.some((path) => path.startsWith(join(dataDir, "charms", "github")))).toBe(true);
    for (const path of files) found.push(...leaks(path, readFileSync(path, "latin1")));

    // Every row of every table: messages, steps, approvals, Charm calls, the journal.
    const tables = await Effect.runPromise(
      database.onDialectOrElse({
        pg: () =>
          database<{
            readonly name: string;
          }>`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()`,
        orElse: () => database<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`,
      }),
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const { name } of tables) {
      const rows = await Effect.runPromise(database`SELECT * FROM ${database(name)}`);
      found.push(
        ...leaks(
          `table ${name}`,
          JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? `${value}` : value)),
        ),
      );
    }

    // What the hob and the clients read: every reply and every answer of the API, approvals included.
    const threads = (await request<ReadonlyArray<Thread>>("GET", `/api/agents/${(await pip()).id}/threads`)).body;
    for (const thread of threads) {
      await request("GET", `/api/threads/${thread.id}/messages`);
      await request("GET", `/api/threads/${thread.id}/approvals`);
    }
    for (const text of answered) found.push(...leaks("an API answer", text));

    expect(found).toEqual([]);
  });
});
