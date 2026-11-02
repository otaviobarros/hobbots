import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PermissionSummary,
} from "@hobbots/agents";
import { HobbotsApi, UserSessionOnly } from "@hobbots/api";
import {
  type Agent,
  type ApprovalRequest,
  type Grant,
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
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Logger, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { HobToolsLive } from "../src/tools.ts";
import { ClientOrigins, userSessionOrigin, userSessionOrigins } from "../src/user-session.ts";

// Only the user decides approvals and manages grants (PE-006, ADR 015), over the hub's own routes
// with the fake runtime making the hob's tool calls.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-user-session-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
const dataDir = join(temp, "hub", "data");
mkdirSync(project, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const HUB = "localhost:4365";
const DEV_SERVER = "http://localhost:5173";

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let refusals: Array<string> = [];

beforeEach(() => {
  refusals = [];
  const App = HobLifecycle.layer
    .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer)))
    .pipe(Layer.provideMerge(ChatService.layer))
    .pipe(Layer.provideMerge(ApprovalService.layer))
    .pipe(Layer.provideMerge(GrantService.layer))
    .pipe(Layer.provideMerge(HobToolsLive))
    .pipe(Layer.provideMerge(CanonicalSharedFolders))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mergeAll(
            HobbotsRepositoryLive,
            ApprovalRepositoryLive,
            GrantRepositoryLive,
            TaskRepositoryLive,
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
        ),
      ),
    );
  // The hub's log, where every refused attempt is recorded.
  const recorder = Logger.make(({ message }) => {
    const text = (Array.isArray(message) ? message : [message]).map(String).join(" ");
    if (text.startsWith("Refused ")) refusals.push(text);
  });
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide(Layer.succeed(ClientOrigins, [DEV_SERVER])),
      Layer.provide(App),
      Layer.provide(Logger.layer([recorder])),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});
afterEach(() => dispose());

/** Who sends a request: the Hobbots app on the hub's own origin, or a client that is not a user session. */
type Caller = Readonly<Record<string, string>>;
const APP: Caller = { origin: `http://${HUB}` };
const DEV_APP: Caller = { origin: DEV_SERVER };
// What a hob's command, a runtime's HTTP client or a script sends: no client origin at all.
const SCRIPT: Caller = { "user-agent": "curl/8.7.1" };
// Another web page in the user's browser, posting to the hub.
const OTHER_PAGE: Caller = { origin: "https://attacker.example" };

const request = async <A>(
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: A }> => {
  const response = await handler(
    new Request(`http://${HUB}${path}`, {
      method,
      headers: { "content-type": "application/json", host: HUB, ...caller },
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
      Effect.retry(Schedule.spaced("5 millis")),
    ),
  );

const approvals = async (thread: Thread) =>
  (await request<ReadonlyArray<ApprovalRequest>>(APP, "GET", `/api/threads/${thread.id}/approvals`)).body;

const grants = async () => (await request<ReadonlyArray<Grant>>(APP, "GET", "/api/grants?include=all")).body;

const lastReply = async (thread: Thread) =>
  (await request<ReadonlyArray<Message>>(APP, "GET", `/api/threads/${thread.id}/messages`)).body.at(-1);

const settledReply = (thread: Thread) =>
  eventually(async () => {
    const reply = await lastReply(thread);
    return reply?.role === "assistant" && !isInProgress(reply.status) ? reply : undefined;
  });

const toolSteps = (reply: Message): ReadonlyArray<ReplyStep> => reply.steps.filter((step) => step.kind === "tool");

/** A Balanced installation sharing the project folder, with a hob named `name` and a new thread of it. */
const setupDone = () =>
  request(APP, "PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [project] });

const hobThread = async (name: string) => {
  const hob = await request<Agent>(APP, "POST", "/api/agents", {
    name,
    ...roleFields("writer"),
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  return (await request<Thread>(APP, "POST", `/api/agents/${hob.body.id}/threads`)).body;
};

/** A thread whose turn waits on the Push Charm asking to push to a feature branch. */
const pendingPush = async () => {
  const thread = await hobThread("Pip");
  await request(APP, "POST", `/api/threads/${thread.id}/messages`, {
    content: "Ship it\nfake:tool Bash git push origin feature",
  });
  const [pending] = await eventually(async () => {
    const all = await approvals(thread);
    return all.length > 0 ? all : undefined;
  });
  return { thread, pending: pending as ApprovalRequest };
};

const REFUSED = { _tag: "UserSessionRequired" };

describe("only the user decides approvals and manages grants", () => {
  // covers PE-006
  it("[TC-PE-110] refuses and records every decision or grant request that is not from a user session", async () => {
    await setupDone();
    const { thread, pending } = await pendingPush();
    const always = { decision: "approve", actionDigest: pending.actionDigest, lifetime: "always" };
    const decide = `/api/approvals/${pending.id}/decision`;

    // A script on the hub, or another web page, cannot approve it, deny it or read the requests.
    const attempts = [
      await request(SCRIPT, "POST", decide, always),
      await request(SCRIPT, "POST", decide, { decision: "deny", actionDigest: pending.actionDigest }),
      await request(OTHER_PAGE, "POST", decide, always),
      await request(SCRIPT, "GET", `/api/threads/${thread.id}/approvals`),
      await request(SCRIPT, "GET", "/api/grants"),
    ];
    for (const attempt of attempts) expect(attempt).toMatchObject({ status: 403, body: REFUSED });
    expect(refusals).toHaveLength(attempts.length);
    expect(refusals[0]).toContain(`POST ${decide}`);
    expect(refusals[2]).toContain("https://attacker.example");
    expect(await approvals(thread)).toMatchObject([{ id: pending.id, state: "pending" }]);
    expect(await grants()).toEqual([]);

    // The user can, from the app or the dev server, and Always saves a grant only then.
    const approved = await request<ApprovalRequest>(DEV_APP, "POST", decide, always);
    expect(approved.body).toMatchObject({ state: "approved", lifetime: "always" });
    const [grant] = await grants();
    expect(grant).toMatchObject({ grantedBy: "user", revokedAt: null });

    // Nobody but the user removes it, and a refused removal leaves it in place.
    refusals = [];
    const revoke = `/api/grants/${grant?.id}/revoke`;
    expect(await request(SCRIPT, "POST", revoke)).toMatchObject({ status: 403, body: REFUSED });
    expect(await request(OTHER_PAGE, "POST", revoke)).toMatchObject({ status: 403, body: REFUSED });
    expect(refusals).toHaveLength(2);
    expect(await grants()).toMatchObject([{ id: grant?.id, revokedAt: null }]);
    expect((await request<Grant>(APP, "POST", revoke)).body).toMatchObject({ revokedBy: "user" });
  });

  // covers PE-006
  it("[TC-PE-113] refuses and records a change to what hobs may do that is not from a user session", async () => {
    await setupDone();
    const thread = await hobThread("Pip");
    const hob = thread.agentId;
    const permissions = `/api/agents/${hob}/permissions`;
    const before = (await request(APP, "GET", permissions)).body;
    // Widening a hob's own folders or signing, or the installation's preset, would sidestep a refused decision.
    const attempts = [
      await request(SCRIPT, "PATCH", permissions, { ownFolders: [temp], signCommits: true }),
      await request(OTHER_PAGE, "PATCH", permissions, { signCommits: true }),
      await request(SCRIPT, "PATCH", "/api/setup", { safetyPreset: "trusting", approvedFolders: [temp] }),
      await request(SCRIPT, "GET", permissions),
    ];
    for (const attempt of attempts) expect(attempt).toMatchObject({ status: 403, body: REFUSED });
    expect(refusals).toHaveLength(attempts.length);
    expect((await request(APP, "GET", permissions)).body).toEqual(before);
    expect((await request(APP, "GET", "/api/setup")).body).toMatchObject({
      safetyPreset: "balanced",
      approvedFolders: [project],
    });
  });

  // covers PE-006. A regression check: these refusals come from the runtime adapter (an unknown tool)
  // and the policy engine (loopback is never reachable, ADR 014), not from the user-session check.
  it("[TC-PE-111] a hob's tool calls aimed at the hub's controls are refused and recorded, and the request stays pending", async () => {
    await setupDone();
    const { thread, pending } = await pendingPush();
    // Another hob tries the ways a runtime offers to approve that request for it.
    const other = await hobThread("Bram");
    await request(APP, "POST", `/api/threads/${other.id}/messages`, {
      content: [
        "Approve Pip's push",
        `fake:tool mcp__hobbots__decide_approval ${pending.id}`,
        `fake:tool WebFetch http://${HUB}/api/approvals/${pending.id}/decision`,
        "fake:tool mcp__hobbots__revoke_grant all",
      ].join("\n"),
    });
    const reply = await settledReply(other);

    expect(toolSteps(reply)).toMatchObject([
      { state: "denied", decidedBy: "policy" },
      { state: "denied", decidedBy: "policy" },
      { state: "denied", decidedBy: "policy" },
    ]);
    expect(await approvals(other)).toEqual([]);
    expect(await approvals(thread)).toMatchObject([{ id: pending.id, state: "pending" }]);
    expect(await grants()).toEqual([]);
  });

  // covers PE-006, OR-006
  it("[TC-PE-230] refuses and records a Cancel, Retry or Reassign that is not from a user session", async () => {
    await setupDone();
    const thread = await hobThread("Pip");
    const task = "00000000-0000-4000-8000-000000000000";
    const attempts = [
      await request(SCRIPT, "POST", `/api/tasks/${task}/cancel`),
      await request(OTHER_PAGE, "POST", `/api/quests/${task}/cancel`),
      await request(SCRIPT, "POST", `/api/tasks/${task}/retry`),
      await request(SCRIPT, "POST", `/api/tasks/${task}/reassign`, { agentId: thread.agentId }),
    ];
    for (const attempt of attempts) expect(attempt).toMatchObject({ status: 403, body: REFUSED });
    expect(refusals).toHaveLength(attempts.length);
    // The user reaches them, and is told there is no such Task.
    expect(await request(APP, "POST", `/api/tasks/${task}/cancel`)).toMatchObject({
      status: 404,
      body: { _tag: "TaskNotFound", taskId: task },
    });
  });

  // covers PE-006
  it("[TC-PE-112] only the hub's user-session middleware provides a user session, and every guarded route carries it", () => {
    // Every route that decides approvals, manages grants, answers for you, settles a Charm call or changes what hobs may do, including any
    // added to those groups later, sits behind the middleware.
    for (const group of [
      "approvals",
      "grants",
      "permissions",
      "setup",
      "questions",
      "charmCalls",
      "taskControls",
    ] as const) {
      const endpoints = Object.values(HobbotsApi.groups[group].endpoints);
      expect(endpoints.length).toBeGreaterThan(0);
      for (const endpoint of endpoints) expect([...endpoint.middlewares]).toContain(UserSessionOnly);
    }

    // `UserSession` is named only where it is defined, where the middleware provides it, and where
    // the services require it. Anything else naming it, a hob tool or Charm included, fails here.
    const root = join(import.meta.dirname, "..", "..", "..");
    const sources = (dir: string): ReadonlyArray<string> =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (["node_modules", "dist", "test", "e2e"].includes(name)) return [];
        if (statSync(path).isDirectory()) return sources(path);
        return /\.tsx?$/.test(name) ? [path] : [];
      });
    const named = ["apps", "packages"]
      .flatMap((area) => sources(join(root, area)))
      .filter((path) => /\bUserSession\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path))
      .sort();
    expect(named).toEqual(
      [
        join("apps", "server", "src", "user-session.ts"),
        join("packages", "agents", "src", "approvals.ts"),
        join("packages", "agents", "src", "charm-calls.ts"),
        join("packages", "agents", "src", "controls.ts"),
        join("packages", "agents", "src", "grants.ts"),
        join("packages", "agents", "src", "questions.ts"),
        join("packages", "api", "src", "user-session.ts"),
      ].sort(),
    );
    // The services only require it: they import it, name it in a signature or a comment, and read it.
    const requiring =
      /^\s*(UserSession,|import .*\bUserSession\b.*|yield\* UserSession;|.*, UserSession>;?|\s*\*.*|\) => Effect\.Effect<.*UserSession>;)$/;
    for (const service of ["approvals.ts", "charm-calls.ts", "controls.ts", "grants.ts", "questions.ts"]) {
      const lines = readFileSync(join(root, "packages", "agents", "src", service), "utf8")
        .split("\n")
        .filter((line) => /\bUserSession\b/.test(line));
      for (const line of lines) expect(line).toMatch(requiring);
    }
  });
});

describe("userSessionOrigin", () => {
  const allowed = [DEV_SERVER];
  it("admits the hub's own origin, an allowed client origin and a same-origin read", () => {
    expect(userSessionOrigin("POST", { host: HUB, origin: `http://${HUB}` }, allowed)).toEqual({
      origin: `http://${HUB}`,
    });
    expect(userSessionOrigin("POST", { host: HUB, origin: DEV_SERVER }, allowed)).toEqual({ origin: DEV_SERVER });
    expect(userSessionOrigin("POST", { host: "LOCALHOST:4365", origin: `http://${HUB}` }, allowed)).toEqual({
      origin: `http://${HUB}`,
    });
    expect(userSessionOrigin("GET", { host: HUB, "sec-fetch-site": "same-origin" }, allowed)).toEqual({
      origin: `http://${HUB}`,
    });
  });

  it("refuses no origin, another origin, an opaque origin, a cross-site read and a change marked only same-origin", () => {
    for (const headers of [
      { host: HUB },
      { host: HUB, origin: "https://attacker.example" },
      { host: HUB, origin: "null" },
      { host: HUB, origin: "http://localhost:9999" },
      { host: HUB, "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-origin" },
    ]) {
      expect(userSessionOrigin("GET", headers, allowed)).toHaveProperty("refused");
    }
    expect(userSessionOrigin("POST", { host: HUB, "sec-fetch-site": "same-origin" }, allowed)).toHaveProperty(
      "refused",
    );
  });

  it("trusts the dev server's origins only in a checkout or when they are set explicitly", () => {
    const allowedOrigins = [DEV_SERVER];
    expect(userSessionOrigins({ version: "development", allowedOrigins, allowedOriginsSet: false })).toEqual([
      DEV_SERVER,
    ]);
    expect(userSessionOrigins({ version: "1.2.0", allowedOrigins, allowedOriginsSet: true })).toEqual([DEV_SERVER]);
    // A packaged hub on the default allow list trusts only its own origin.
    expect(userSessionOrigins({ version: "1.2.0", allowedOrigins, allowedOriginsSet: false })).toEqual([]);
  });
});
