import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import {
  ApprovalService,
  accessNow,
  CharmCallService,
  CharmDeclarations,
  ChatService,
  FolderSandbox,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  HobTools,
  PermissionSummary,
  SecretRedaction,
} from "@hobbots/agents";
import {
  GITHUB_CHARM,
  GitHubAccountLive,
  GitHubApiNode,
  GitHubCharmTools,
  GitHubCredentialPerHob,
  GitHubSignInNode,
  GitPushLive,
  GitRemotes,
  HobAppKeys,
  HobAppKeysMemory,
  HobGitHubAppNode,
  KeychainMemory,
  LocalGitHubSignInsNone,
} from "@hobbots/charms";
import { type FakeGitHub, startFakeGitHub } from "@hobbots/charms/testing";
import {
  type Agent,
  AgentId,
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
  HobGitHubAppRepository,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer, withCommitIdentity } from "@hobbots/runtimes";
import { Clock, Effect, Layer, ManagedRuntime, Option, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { HobGitHubAppPages } from "../src/hob-github-app.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { ToolLogsLive } from "../src/tool-logs.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// A hob's own GitHub identity, end to end (ADR 022, #228): the hub's own composition over the HTTP
// API, as `main.ts` builds it, with the fake runtime making the scripted Charm calls and a fake GitHub
// on a local port serving the manifest flow, the app's endpoints, the REST API, the Git database API
// and Git over HTTP. Frodo gets its own app through the hub's page and GitHub's redirect; Sam stays on
// the user's account. The cases run in order, as a person would: give Frodo its app, push, open a pull
// request and comment as its bot, let an hour pass, uninstall the app and revoke its key, disconnect
// it and retire the hob, then look everywhere a hob could reach for a credential. CI runs them on
// SQLite and on PostgreSQL.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-hob-identity-e2e-")));
const shire = join(temp, "shire");
const dataDir = join(temp, "hub", "data");
const sandboxRecords = join(temp, "sandbox-records");
for (const folder of [shire, dataDir, sandboxRecords]) mkdirSync(folder, { recursive: true });

const HUB = "localhost:4367";
const LOGIN = "otaviobarros";
const SLUG = `${LOGIN}/shire`;
const BOT = "frodo-hobbots[bot]";

/** The environment the user's own Git runs with: their name, which a hob with its own app must not commit as. */
const userGitEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: temp,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Otavio",
  GIT_AUTHOR_EMAIL: "otavio@example.com",
  GIT_COMMITTER_NAME: "Otavio",
  GIT_COMMITTER_EMAIL: "otavio@example.com",
};

const git = (cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = userGitEnv) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();

/** A commit of one new file on the folder's current branch, made with `env`. */
const commit = (folder: string, file: string, subject: string, env: NodeJS.ProcessEnv = userGitEnv) => {
  writeFileSync(join(folder, file), `${subject}\n`);
  git(folder, ["add", file], env);
  git(folder, ["commit", "--quiet", "-m", subject], env);
  return git(folder, ["rev-parse", "HEAD"], env);
};

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Stands in for the hob's sandbox, which this hub's CI cannot start: it runs the program as it is,
 * after writing the environment the program gets to `sandboxRecords`, so the last case can look for
 * a credential there. The Charm's own fence is proven against the real sandbox in TC-PE-152.
 */
const RecordingSandbox = Layer.succeed(
  FolderSandbox,
  FolderSandbox.of({
    readOnly: (_folders, program, args) =>
      Effect.succeed({
        commandLine: `sh -c ${quote(`env > ${quote(sandboxRecords)}/env-$$; exec ${[program, ...args].map(quote).join(" ")}`)}`,
        env: {},
      }),
  }),
);

/**
 * The hub's clock, which a case moves ahead with GitHub's to stand in for an hour passing. Only the
 * wall clock moves: sleeps and elapsed time stay real, so nothing waits an hour.
 */
let ahead = 0;
const realClock = Clock.Clock.defaultValue();
const HubClock = Layer.succeed(Clock.Clock, {
  currentTimeMillisUnsafe: () => realClock.currentTimeMillisUnsafe() + ahead,
  currentTimeMillis: Effect.sync(() => realClock.currentTimeMillisUnsafe() + ahead),
  currentTimeNanosUnsafe: () => realClock.currentTimeNanosUnsafe() + BigInt(ahead) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => realClock.currentTimeNanosUnsafe() + BigInt(ahead) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => realClock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: realClock.monotonicTimeNanos,
  sleep: (duration) => realClock.sleep(duration),
});
const passes = (ms: number) => {
  ahead += ms;
  github.advance(ms);
};

let github: FakeGitHub;
/** The repository's folder on the fake GitHub. */
let remote: string;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let database: SqlClient.SqlClient;
// biome-ignore lint/suspicious/noExplicitAny: the hub's whole context, for the cases that read its services
let runtime: ManagedRuntime.ManagedRuntime<any, any>;
/** Every body the hub answered, to look for a credential in what a client reads. */
const answered: Array<string> = [];

beforeAll(async () => {
  github = await startFakeGitHub({ folder: join(temp, "github"), login: LOGIN, pendingPolls: 0 });
  // The user's repository, with `main` on GitHub and one issue; the Hobbots app is installed on it.
  git(shire, ["init", "--quiet", "--initial-branch=main"]);
  git(shire, ["remote", "add", "origin", `https://github.com/${SLUG}.git`]);
  // The repository's own identity, which a hob with its own app must not commit as either.
  git(shire, ["config", "user.name", "Shire maintainer"]);
  git(shire, ["config", "user.email", "maintainer@example.com"]);
  commit(shire, "README.md", "First");
  remote = github.createRepository({ owner: LOGIN, name: "shire", from: shire, description: "Where the hobs work" });
  github.install(SLUG);
  github.addItem(SLUG, { title: "The pony needs a name", author: "ada" });

  const charmFolder = join(dataDir, "charms", "github");
  const Account = GitHubAccountLive({ clientId: "Iv23liFakeHobbots", slug: "hobbots", environmentToken: null }).pipe(
    Layer.provide(
      Layer.mergeAll(KeychainMemory, GitHubSignInNode(github.hosts), LocalGitHubSignInsNone, GitHubAccountRepository),
    ),
  );
  // As `main.ts` composes them: each hob acts as its own app when it has one, as the user's account otherwise.
  const HobApp = HobGitHubAppNode(github.hosts).pipe(
    Layer.provideMerge(HobAppKeysMemory),
    Layer.provide(HobGitHubAppRepository),
  );
  const GitHub = GitHubCredentialPerHob.pipe(
    Layer.provide(Account),
    Layer.provideMerge(HobApp),
    Layer.provideMerge(HobGitHubAppRepository),
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
    Layer.provideMerge(GitHub),
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
    .pipe(Layer.provideMerge(HobToolsLive))
    .pipe(Layer.provideMerge(Layer.merge(Charms, CharmCallService.layer)))
    .pipe(Layer.provideMerge(GrantService.layer))
    .pipe(Layer.provideMerge(CanonicalSharedFolders))
    .pipe(Layer.provideMerge(TestDevices))
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
          // The Charms this hub holds, as the server declares them (ADR 031).
          Layer.succeed(CharmDeclarations, [GITHUB_CHARM]),
          NodeFolderChecks,
          FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)),
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
          SecretRedaction.layer([]),
          ToolLogsLive(join(dataDir, "tool-logs")),
        ),
      ),
    )
    .pipe(Layer.provideMerge(HubClock));
  runtime = ManagedRuntime.make(App);
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(ApiRoutes, HobGitHubAppPages).pipe(
      Layer.provideMerge(Layer.succeedContext(await runtime.context())),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = async () => {
    await web.dispose();
    await runtime.dispose();
  };
});

afterAll(async () => {
  await dispose();
  await github.close();
  rmSync(temp, { recursive: true, force: true });
});

const send = async (
  method: string,
  url: string,
  headers: Readonly<Record<string, string>> = AS_WINDOW,
  body?: unknown,
): Promise<{ status: number; text: string }> => {
  const target = new URL(url, `http://${HUB}`);
  const response = await handler(
    new Request(target, {
      method,
      headers: { "content-type": "application/json", host: target.host, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  answered.push(text);
  return { status: response.status, text };
};

const request = async <A>(method: string, path: string, body?: unknown): Promise<{ status: number; body: A }> => {
  const response = await send(method, path, AS_WINDOW, body);
  return { status: response.status, body: (response.text ? JSON.parse(response.text) : undefined) as A };
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

const hobs = new Map<string, Agent>();

/** A hob on Balanced sharing the user's repository, summoned once. */
const summon = async (name: string): Promise<Agent> => {
  const known = hobs.get(name);
  if (known !== undefined) return known;
  await request("PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [shire] });
  const summoned = await request<Agent>("POST", "/api/agents", {
    name,
    ...roleFields("writer"),
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  expect(summoned.status).toBe(200);
  hobs.set(name, summoned.body);
  return summoned.body;
};
const frodo = () => summon("Frodo");
const sam = () => summon("Sam");

/** The hob makes the scripted Charm calls in a new thread: the request it waits on, or its finished reply. */
const turn = async (hob: Agent, ...calls: Array<string>) => {
  const thread = (await request<Thread>("POST", `/api/agents/${hob.id}/threads`)).body;
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

/** Approves the request just this once and waits for the reply to end. */
const approveOnce = async (asked: { readonly thread: Thread; readonly pending?: ApprovalRequest | undefined }) => {
  expect(asked.pending).toBeDefined();
  const pending = asked.pending as ApprovalRequest;
  const decided = await request<ApprovalRequest>("POST", `/api/approvals/${pending.id}/decision`, {
    actionDigest: pending.actionDigest,
    decision: "approve",
  });
  expect(decided.body).toMatchObject({ state: "approved" });
  return settled(asked.thread);
};

/** The hub's answer for the hob's app, as the Charms tab reads it. */
const appStatus = async (hob: Agent) =>
  (await request<Record<string, unknown>>("GET", `/api/agents/${hob.id}/github-app`)).body;

const keyKept = (hob: Agent) =>
  runtime.runPromise(
    Effect.flatMap(HobAppKeys, (keys) => keys.read(AgentId.make(hob.id))).pipe(Effect.map(Option.isSome)),
  );

const unescapeHtml = (text: string) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** What the user's default browser does: opens the hub's page, posts its manifest to GitHub, and follows GitHub back. */
const createOnGitHub = async (hob: Agent) => {
  const started = await request<{ readonly url: string }>("POST", `/api/agents/${hob.id}/github-app/start`);
  expect(started.status).toBe(200);
  const page = await send("GET", started.body.url, {});
  const action = unescapeHtml(/<form id="manifest" method="post" action="([^"]+)">/.exec(page.text)?.[1] ?? "");
  const manifest = unescapeHtml(/name="manifest" value="([^"]+)"/.exec(page.text)?.[1] ?? "");
  const created = await fetch(action, { method: "POST", body: new URLSearchParams({ manifest }), redirect: "manual" });
  return send("GET", created.headers.get("location") ?? "", {});
};

/** The fake's record of Frodo's app. */
const frodoApp = () => {
  const app = github.apps.find((each) => each.slug === "frodo-hobbots");
  if (app === undefined) throw new Error("Frodo has no app on the fake GitHub");
  return app;
};

/** The requests GitHub received that were signed with the user's own tokens rather than an app's. */
const asTheUser = (from: number) =>
  github.requests.slice(from).filter((sent) => {
    const [kind, value = ""] = (sent.authorization ?? "").split(" ");
    const token = kind === "Basic" ? Buffer.from(value, "base64").toString("utf8").split(":")[1] : value;
    return token !== undefined && token !== "" && !token.startsWith("ghs_") && token.split(".").length !== 3;
  });

const ensureUserConnected = async () => {
  const status = await request<{ readonly _tag: string }>("GET", "/api/charms/github");
  if (status.body._tag === "Connected") return;
  await request("POST", "/api/charms/github/connect");
  await eventually(async () => {
    const now = await request<{ readonly _tag: string }>("GET", "/api/charms/github");
    return now.body._tag === "Connected" ? now.body : undefined;
  });
};

describe("A hob's own GitHub identity, end to end against a fake GitHub", () => {
  // covers ADR 022, PE-005
  it("[TC-GEN-110] gives a hob its own app from the hub's page, and the hob then commits locally as its bot", async () => {
    await ensureUserConnected();
    const hob = await frodo();
    const back = await createOnGitHub(hob);
    expect(back.status).toBe(200);
    expect(back.text).toContain("Frodo has its own GitHub app");
    github.installApp("frodo-hobbots", "selected", [SLUG]);
    const listed = await request<{ readonly installations: ReadonlyArray<unknown> }>(
      "GET",
      `/api/agents/${hob.id}/github-app/installations`,
    );
    expect(listed.body.installations).toHaveLength(1);
    expect(await appStatus(hob)).toMatchObject({ _tag: "Connected", bot: BOT, needsReconnect: null });
    expect(await keyKept(hob)).toBe(true);

    // The turn the hub gives Frodo commits as its bot, with the ID GitHub gave the bot's account.
    const email = `${frodoApp().botId}+${BOT}@users.noreply.github.com`;
    const access = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* accessNow(yield* HobbotsRepository, yield* HobTools, AgentId.make(hob.id));
      }),
    );
    expect(access?.commitAs).toEqual({ name: BOT, email });
    // Sam, on the user's account, keeps the user's own identity.
    const samId = AgentId.make((await sam()).id);
    const samAccess = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* accessNow(yield* HobbotsRepository, yield* HobTools, samId);
      }),
    );
    expect(samAccess?.commitAs).toBeUndefined();

    // A commit made with the environment the launcher gives Frodo's turn is the bot's, though the
    // user's environment and the repository's config both name someone else.
    git(shire, ["checkout", "--quiet", "-b", "frodo/ring"]);
    const env = withCommitIdentity(userGitEnv, access?.commitAs);
    commit(shire, "ring.txt", "Carry the ring", env);
    expect(git(shire, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%G?"])).toBe(`${BOT} <${email}>|${BOT} <${email}>|N`);
  }, 30_000);
  // covers ADR 022, PE-003, PE-007
  it("[TC-GEN-111] pushes as the hob's bot after a card that names it, and GitHub shows the commits as the bot's, Verified", async () => {
    const hob = await frodo();
    const local = git(shire, ["rev-parse", "HEAD"]);
    const fromMade = github.madeCommits.length;
    const fromToken = github.installationTokens.length;
    const fromRequest = github.requests.length;
    const asked = await turn(hob, call("github_push", { branch: "frodo/ring", key: "push-ring" }));
    expect(asked.pending).toMatchObject({
      tool: "github_push",
      operation: "push",
      arguments: {
        commit: local,
        commits: 1,
        subjects: ["Carry the ring"],
        actingAs: { _tag: "HobApp", hob: "Frodo", bot: BOT },
      },
    });
    expect(asked.pending?.arguments.summary).toContain("GitHub creates these commits again, signed as the bot");
    expect(github.headOf(SLUG, "frodo/ring")).toBeNull();

    const reply = await approveOnce(asked);
    expect(toolSteps(reply)).toMatchObject([{ state: "done" }]);
    const made = github.madeCommits.slice(fromMade);
    const email = `${frodoApp().botId}+${BOT}@users.noreply.github.com`;
    expect(made).toEqual([
      expect.objectContaining({
        madeBy: BOT,
        verified: true,
        author: { name: BOT, email },
        committer: { name: BOT, email },
      }),
    ]);
    // The branch is at GitHub's commit, with the hob's tree and message, on top of `main`.
    expect(github.headOf(SLUG, "frodo/ring")).toBe(made[0]?.sha);
    expect(git(remote, ["rev-parse", "frodo/ring^{tree}"])).toBe(git(shire, ["rev-parse", `${local}^{tree}`]));
    expect(git(remote, ["log", "-1", "--format=%s", "frodo/ring"])).toBe("Carry the ring");
    expect(git(remote, ["rev-parse", "frodo/ring~1"])).toBe(git(shire, ["rev-parse", "main"]));
    expect(reply.content).toContain(`${local.slice(0, 12)} is ${made[0]?.sha.slice(0, 12)} on GitHub`);
    // Only the hob's app reached GitHub: its push token wrote contents, and nothing went as the user.
    expect(github.installationTokens.slice(fromToken).map((token) => token.permissions)).toContainEqual(
      expect.objectContaining({ contents: "write" }),
    );
    expect(github.installationTokens.slice(fromToken).every((token) => token.repositories.join() === SLUG)).toBe(true);
    expect(asTheUser(fromRequest)).toEqual([]);
  }, 30_000);

  // covers ADR 022, PE-003, PE-007
  it("[TC-GEN-112] opens a draft pull request and comments as the hob's bot, with cards and steps that name it", async () => {
    const hob = await frodo();
    const fromRequest = github.requests.length;
    const opening = await turn(
      hob,
      call("github_open_pull_request", {
        head: "frodo/ring",
        title: "Carry the ring",
        body: "Closes #1.",
        key: "pr-ring",
      }),
    );
    expect(opening.pending).toMatchObject({
      tool: "github_open_pull_request",
      arguments: { head: "frodo/ring", base: "main", draft: true, actingAs: { _tag: "HobApp", bot: BOT } },
    });
    const opened = await approveOnce(opening);
    expect(toolSteps(opened)).toMatchObject([{ state: "done", label: expect.stringContaining(BOT) }]);
    const pullRequest = github.items(SLUG).find((item) => item.pullRequest?.head === "frodo/ring");
    expect(pullRequest).toMatchObject({
      title: "Carry the ring",
      author: BOT,
      pullRequest: { base: "main", draft: true },
    });

    const commenting = await turn(hob, call("github_comment", { number: 1, body: "Bill, maybe.", key: "comment-1" }));
    expect(commenting.pending).toMatchObject({
      tool: "github_comment",
      arguments: { actingAs: { _tag: "HobApp", bot: BOT } },
    });
    const commented = await approveOnce(commenting);
    expect(toolSteps(commented)).toMatchObject([{ state: "done", label: expect.stringContaining(BOT) }]);
    const [posted] = github.items(SLUG).find((item) => item.number === 1)?.comments ?? [];
    expect(posted).toMatchObject({ author: BOT, body: expect.stringMatching(/^Bill, maybe\./) });
    expect(asTheUser(fromRequest)).toEqual([]);
  }, 30_000);

  // covers ADR 022, PE-003
  it("[TC-GEN-113] keeps a hob without its own app on the user's account, with the user's commits and name", async () => {
    const hob = await sam();
    git(shire, ["checkout", "--quiet", "main"]);
    git(shire, ["checkout", "--quiet", "-b", "sam/pans"]);
    const local = commit(shire, "pans.txt", "Pack the pans");
    const fromMade = github.madeCommits.length;
    const fromToken = github.installationTokens.length;

    const pushing = await turn(hob, call("github_push", { branch: "sam/pans", key: "push-pans" }));
    expect(pushing.pending).toMatchObject({ arguments: { commit: local, actingAs: { _tag: "You", login: LOGIN } } });
    expect(toolSteps(await approveOnce(pushing))).toMatchObject([{ state: "done" }]);
    // The user's own commit, sent as it is: GitHub made none, and the branch is at the local commit.
    expect(github.headOf(SLUG, "sam/pans")).toBe(local);
    expect(git(remote, ["log", "-1", "--format=%an", "sam/pans"])).toBe("Otavio");
    expect(github.madeCommits.slice(fromMade)).toEqual([]);

    const commenting = await turn(hob, call("github_comment", { number: 1, body: "Po-tay-toes.", key: "comment-sam" }));
    expect(commenting.pending).toMatchObject({ arguments: { actingAs: { _tag: "You", login: LOGIN } } });
    await approveOnce(commenting);
    const comments = github.items(SLUG).find((item) => item.number === 1)?.comments ?? [];
    expect(comments.at(-1)).toMatchObject({ author: LOGIN, body: expect.stringMatching(/^Po-tay-toes\./) });
    // Frodo's app was never asked for a token on Sam's behalf.
    expect(github.installationTokens.slice(fromToken)).toEqual([]);
  }, 30_000);

  // covers ADR 022
  it("[TC-GEN-114] replaces the hob's token after its hour without asking the user, and never sends the lapsed one", async () => {
    const hob = await frodo();
    const read = () => turn(hob, call("github_repository", {}));
    const first = await read();
    expect(first.pending).toBeUndefined();
    expect(first.reply?.content).toContain(SLUG);
    const minted = github.installationTokens.length;
    const kept = github.installationTokens.at(-1);
    // Within the hour, the same token serves the next read.
    expect((await read()).reply?.content).toContain(SLUG);
    expect(github.installationTokens.length).toBe(minted);

    passes(61 * 60_000);
    const fromRequest = github.requests.length;
    const later = await read();
    expect(later.pending).toBeUndefined();
    expect(later.reply?.content).toContain(SLUG);
    expect(toolSteps(later.reply as Message)).toMatchObject([{ state: "done" }]);
    // One new token, from a new JWT; the lapsed one was never sent, and the user was never asked to sign in.
    expect(github.installationTokens.length).toBe(minted + 1);
    const sent = github.requests.slice(fromRequest);
    expect(sent.some((each) => each.authorization?.includes(kept?.token ?? "none"))).toBe(false);
    expect(sent.map((each) => each.path)).toContain(`/app/installations/${kept?.installationId}/access_tokens`);
    expect(sent.filter((each) => each.path.startsWith("/login/"))).toEqual([]);
    expect(asTheUser(fromRequest)).toEqual([]);
    expect(await appStatus(hob)).toMatchObject({ _tag: "Connected", needsReconnect: null });
  }, 30_000);

  // covers ADR 022
  it("[TC-GEN-115] fails clearly when the hob's app is uninstalled, marks it for reinstalling, never acts as the user, and works again once reinstalled", async () => {
    const hob = await frodo();
    const installation = frodoApp().installations[0]?.id;
    github.uninstallApp("frodo-hobbots");
    const fromRequest = github.requests.length;
    const refused = await turn(hob, call("github_repository", {}));
    expect(refused.pending).toBeUndefined();
    expect(refused.reply?.content).toContain(`${BOT} is not installed on ${SLUG}`);
    expect(refused.reply?.content).toContain(`${github.base}/apps/frodo-hobbots/installations/new`);
    // GitHub refused the lapsed installation's token and the hub minted once more, which GitHub would not
    // do. The hub then asked where the app is still installed: nowhere. One retry, then nothing more, and
    // nothing as the user.
    expect(github.requests.slice(fromRequest).map((sent) => `${sent.method} ${sent.path}`)).toEqual([
      `GET /repos/${SLUG}`,
      `POST /app/installations/${installation}/access_tokens`,
      "GET /app/installations",
    ]);
    expect(asTheUser(fromRequest)).toEqual([]);
    // The Charms tab marks the app for reinstalling (#419), and the hob's next action reaches GitHub no more.
    expect(await appStatus(hob)).toMatchObject({ _tag: "Connected", needsReconnect: { reason: "installation" } });
    const sentBefore = github.requests.length;
    const blocked = await turn(hob, call("github_repository", {}));
    expect(blocked.reply?.content).toContain(`${github.base}/apps/frodo-hobbots/installations/new`);
    expect(github.requests.length).toBe(sentBefore);

    // Reinstalled on GitHub, the Charms tab lists it again, which clears the mark, and the hob reads as its bot.
    github.installApp("frodo-hobbots", "selected", [SLUG]);
    await request("GET", `/api/agents/${hob.id}/github-app/installations`);
    expect(await appStatus(hob)).toMatchObject({ _tag: "Connected", needsReconnect: null });
    const again = await turn(hob, call("github_repository", {}));
    expect(again.reply?.content).toContain(SLUG);
    expect(await appStatus(hob)).toMatchObject({ _tag: "Connected", needsReconnect: null });
  }, 30_000);

  // covers ADR 022
  it("[TC-GEN-116] marks the hob's app for a reconnect when GitHub refuses its key, sends nothing more, and never acts as the user", async () => {
    const hob = await frodo();
    frodoApp().keyLive = false;
    // An hour on, the hob's token has lapsed and the hub must sign in with the key again.
    passes(61 * 60_000);
    const fromRequest = github.requests.length;
    const refused = await turn(hob, call("github_repository", {}));
    expect(refused.pending).toBeUndefined();
    expect(refused.reply?.content).toContain(`GitHub refused ${BOT}'s key`);
    expect(await appStatus(hob)).toMatchObject({ _tag: "Connected", needsReconnect: { reason: "key" } });

    // Until the user acts, the hob's GitHub actions fail with that reason and reach GitHub no more.
    const sentBefore = github.requests.length;
    const blocked = await turn(
      hob,
      call("github_repository", {}),
      call("github_comment", { number: 1, body: "Anyone?", key: "comment-blocked" }),
    );
    expect(blocked.pending).toBeUndefined();
    expect(blocked.reply?.content).toContain("Give the hob a new app");
    expect(github.requests.length).toBe(sentBefore);
    expect(asTheUser(fromRequest)).toEqual([]);
    expect(
      github
        .items(SLUG)
        .find((item) => item.number === 1)
        ?.comments.map((each) => each.body),
    ).not.toContainEqual(expect.stringContaining("Anyone?"));

    // The key works again, as after a clock problem: the Charms tab reading the installations clears the mark.
    frodoApp().keyLive = true;
    await request("GET", `/api/agents/${hob.id}/github-app/installations`);
    expect(await appStatus(hob)).toMatchObject({ _tag: "Connected", needsReconnect: null });
  }, 30_000);

  // covers ADR 022, PE-007
  it("[TC-GEN-117] disconnecting removes the app's installations and key and the hob acts as the user; retiring a hob deletes its key", async () => {
    const hob = await frodo();
    const disconnected = await request("POST", `/api/agents/${hob.id}/github-app/disconnect`);
    expect(disconnected.body).toEqual({
      deleteUrl: `${github.base}/settings/apps/frodo-hobbots/advanced`,
      problem: null,
    });
    expect(frodoApp().installations).toEqual([]);
    expect(await keyKept(hob)).toBe(false);
    expect(await appStatus(hob)).toEqual({ _tag: "None", cannotCreate: null });

    // The next comment asks as the user, and goes out under the user's name.
    const fromToken = github.installationTokens.length;
    const commenting = await turn(hob, call("github_comment", { number: 1, body: "Back as you.", key: "comment-you" }));
    expect(commenting.pending).toMatchObject({ arguments: { actingAs: { _tag: "You", login: LOGIN } } });
    await approveOnce(commenting);
    const comments = github.items(SLUG).find((item) => item.number === 1)?.comments ?? [];
    expect(comments.at(-1)).toMatchObject({ author: LOGIN, body: expect.stringMatching(/^Back as you\./) });
    expect(github.installationTokens.slice(fromToken)).toEqual([]);

    // Merry gets its own app, then retires: its installations and its key go with it.
    const merry = await summon("Merry");
    expect((await createOnGitHub(merry)).status).toBe(200);
    github.installApp("merry-hobbots", "selected", [SLUG]);
    expect(await keyKept(merry)).toBe(true);
    expect((await request("POST", `/api/agents/${merry.id}/retire`, { activeWork: "stop" })).status).toBe(200);
    expect(github.apps.find((app) => app.slug === "merry-hobbots")?.installations).toEqual([]);
    expect(await keyKept(merry)).toBe(false);
  }, 30_000);

  // covers ADR 022, PE-005, PE-006
  it("[TC-GEN-118] keeps the app's key, its JWTs and its tokens out of the sandbox's environment, the files a hob can read, the database and tool output", async () => {
    const secrets = github.secrets();
    // The app's key, the JWTs it signed and the tokens GitHub gave it are all among them.
    expect(secrets.some((secret) => secret.includes("PRIVATE KEY"))).toBe(true);
    expect(secrets.some((secret) => secret.split(".").length === 3)).toBe(true);
    expect(secrets.filter((secret) => secret.startsWith("ghs_")).length).toBeGreaterThan(1);
    const leaks = (where: string, text: string) => secrets.filter((secret) => text.includes(secret)).map(() => where);

    // The environment the launcher gives a hob with its own app holds its identity and nothing else of GitHub's.
    const found = leaks(
      "the hob's commit environment",
      JSON.stringify(withCommitIdentity(userGitEnv, { name: BOT, email: "bot@users.noreply.github.com" })),
    );

    // The environment of every process the Charm started in the hob's sandbox.
    const environments = readdirSync(sandboxRecords);
    expect(environments.length).toBeGreaterThan(0);
    for (const name of environments) {
      found.push(...leaks(`sandbox environment ${name}`, readFileSync(join(sandboxRecords, name), "utf8")));
    }

    // Every file on the hub: the hob's folders, its runtime folder, tool logs and the Charm's staging repositories.
    const walk = (folder: string): Array<string> =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) return walk(path);
        return entry.isFile() ? [path] : [];
      });
    const files = walk(temp);
    expect(files.some((path) => path.startsWith(join(dataDir, "charms", "github")))).toBe(true);
    for (const path of files) {
      const text = readFileSync(path, "latin1");
      found.push(...leaks(path, text));
      if (text.includes("PRIVATE KEY-----")) found.push(`a private key in ${path}`);
    }

    // Every row of every table: messages, steps, approvals, Charm calls, the hob's app, the journal.
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
      const text = JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? `${value}` : value));
      found.push(...leaks(`table ${name}`, text));
      if (text.includes("PRIVATE KEY")) found.push(`a private key in table ${name}`);
    }

    // What the hobs and the clients read: every reply and every answer of the API, approval cards included.
    for (const hob of hobs.values()) {
      const threads = (await request<ReadonlyArray<Thread>>("GET", `/api/agents/${hob.id}/threads`)).body;
      for (const thread of threads) {
        await request("GET", `/api/threads/${thread.id}/messages`);
        await request("GET", `/api/threads/${thread.id}/approvals`);
      }
    }
    for (const text of answered) {
      found.push(...leaks("an API answer", text));
      if (text.includes("PRIVATE KEY")) found.push("a private key in an API answer");
    }

    expect(found).toEqual([]);
  });
});
