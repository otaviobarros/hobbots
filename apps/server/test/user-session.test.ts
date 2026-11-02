import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  DeviceRepository,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PermissionSummary,
} from "@hobbots/agents";
import { DeviceSession, HobbotsApi } from "@hobbots/api";
import {
  type Agent,
  type ApprovalRequest,
  DeviceId,
  type Grant,
  isInProgress,
  type Message,
  type PairingRequest,
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
import { Effect, Layer, Logger, ManagedRuntime, Option, References, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TailnetPeer, TailnetPeers } from "../src/devices.ts";
import { EventBus } from "../src/event-bus.ts";
import { EventStream, EventStreamRoute } from "../src/event-stream.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TEST_WINDOW_KEY, testDevicesWith } from "./window-device.ts";

// Only approved devices reach the hub, and only the user decides approvals and manages grants
// (PE-006, ADR 015, ADR 021), over the hub's own routes with the fake runtime making the hob's tool calls.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-user-session-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
const dataDir = join(temp, "hub", "data");
mkdirSync(project, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const HUB = "localhost:4365";
const OWN_ORIGIN = `http://${HUB}`;

// A test names the Tailscale node a request comes from with this header; without it, it is local.
const NODE_HEADER = "x-test-tailnet-node";
const node = (nodeId: string): TailnetPeer => ({
  nodeId,
  nodeName: nodeId.toLowerCase(),
  owner: { _tag: "User", login: "you@example.com" },
});
const TestPeers = Layer.succeed(TailnetPeers, {
  peerOf: (request) =>
    Effect.succeed(Option.map(Option.fromNullishOr(request.headers[NODE_HEADER]), (nodeId) => node(nodeId))),
});

const App = HobLifecycle.layer
  .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer, EventStream.layer)))
  .pipe(Layer.provideMerge(ChatService.layer))
  .pipe(Layer.provideMerge(ApprovalService.layer))
  .pipe(Layer.provideMerge(GrantService.layer))
  .pipe(Layer.provideMerge(HobToolsLive))
  .pipe(Layer.provideMerge(CanonicalSharedFolders))
  .pipe(Layer.provideMerge(testDevicesWith(TestPeers)))
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

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let refusals: Array<string> = [];
let logged: Array<string> = [];

beforeEach(async () => {
  refusals = [];
  logged = [];
  // The hub's log, where every refused attempt is recorded.
  const recorder = Logger.make(({ message, fiber }) => {
    const text = (Array.isArray(message) ? message : [message]).map(String).join(" ");
    logged.push(text, JSON.stringify(fiber.getRef(References.CurrentLogAnnotations)));
    if (text.startsWith("Refused ")) refusals.push(text);
  });
  runtime = ManagedRuntime.make(App.pipe(Layer.provide(Logger.layer([recorder]))));
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(ApiRoutes, EventStreamRoute).pipe(
      Layer.provideMerge(Layer.succeedContext(await runtime.context())),
      Layer.provide(Logger.layer([recorder])),
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
afterEach(() => dispose());

/** Who sends a request, as the headers it sends. */
type Caller = Readonly<Record<string, string>>;
// The hub's window's main process, with the window key.
const APP: Caller = AS_WINDOW;
// What a hob's command, a runtime's HTTP client or a script sends: no device token at all.
const SCRIPT: Caller = { "user-agent": "curl/8.7.1" };

/** A browser holding `cookie`, on the hub's own page: changes name its origin, reads are same-origin. */
const browser = (cookie: string, method = "GET"): Caller =>
  method === "GET" ? { cookie, "sec-fetch-site": "same-origin" } : { cookie, origin: OWN_ORIGIN };

const send = (caller: Caller, method: string, path: string, body?: unknown) =>
  handler(
    new Request(`http://${HUB}${path}`, {
      method,
      headers: { "content-type": "application/json", host: HUB, ...caller },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const request = async <A>(
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: A; setCookie: ReadonlyArray<string> }> => {
  const response = await send(caller, method, path, body);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    setCookie: response.headers.getSetCookie(),
  };
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

/** The `name=value` of the cookie a response set, or undefined when it set none by that name. */
const cookieFrom = (setCookie: ReadonlyArray<string>, name: string) =>
  setCookie.map((line) => line.split(";")[0] ?? "").find((pair) => pair.startsWith(`${name}=`));

/** A browser that asked to pair from `caller`'s place and was allowed: its device cookie. */
const pairedBrowser = async (place: Caller = {}) => {
  const opened = await request<{ status: { id: string } }>(place, "POST", "/api/pairing", {
    name: "Safari on iPhone",
    platform: "iOS",
    kind: "browser",
  });
  const pairing = cookieFrom(opened.setCookie, "hobbots_pairing") as string;
  await request(APP, "POST", `/api/pairing/requests/${opened.body.status.id}/allow`);
  const claimed = await request({ ...place, ...browser(pairing) }, "GET", "/api/pairing");
  return { cookie: cookieFrom(claimed.setCookie, "hobbots_device") as string, requestId: opened.body.status.id };
};

const REQUIRED = { _tag: "DeviceRequired" };
const FOREIGN = { _tag: "ForeignOrigin" };

const devices = () => runtime.runPromise(Effect.flatMap(DeviceRepository, (repo) => repo.list));

describe("only approved devices reach the hub", () => {
  // covers DP-004, PE-006
  it("[TC-PE-210] refuses a request without an approved device's token on every route and the event stream, before any handler runs", async () => {
    const outside = new Set(["health", "pairing"]);
    let checked = 0;
    for (const group of Object.values(HobbotsApi.groups)) {
      for (const endpoint of Object.values(group.endpoints)) {
        // Unknown ids: a handler that ran would answer 404 or 400, not 401.
        const path = endpoint.path.replaceAll(/:[A-Za-z]+/g, "unknown");
        const answered = await request(SCRIPT, endpoint.method, path, endpoint.method === "GET" ? undefined : {});
        if (outside.has(group.identifier)) {
          expect(answered.status, `${endpoint.method} ${path}`).not.toBe(401);
          continue;
        }
        expect(answered, `${endpoint.method} ${path}`).toMatchObject({ status: 401, body: REQUIRED });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);

    // An unknown token, a forged window key, a bearer token of another kind and the event stream are refused too.
    for (const caller of [
      { authorization: "Bearer hbd_unknownunknownunknownunknownunknownunknown" },
      { authorization: `Bearer hbw_${"x".repeat(43)}` },
      { authorization: "Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { cookie: `hobbots_device=${TEST_WINDOW_KEY.replace("t", "u")}`, "sec-fetch-site": "same-origin" },
    ]) {
      expect(await request(caller, "GET", "/api/agents")).toMatchObject({ status: 401, body: REQUIRED });
      expect((await send(caller, "GET", "/api/events")).status).toBe(401);
    }
    expect((await send(SCRIPT, "GET", "/api/events")).status).toBe(401);
    // The health endpoint answers without one, so a client can tell this hub from another program.
    expect(await request(SCRIPT, "GET", "/api/health")).toMatchObject({ status: 200, body: { app: "hobbots" } });
    // The hub's window passes, on the routes and the stream.
    expect((await request(APP, "GET", "/api/agents")).status).toBe(200);
    const stream = await send(APP, "GET", "/api/events");
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
    expect(refusals.length).toBeGreaterThan(checked);
  });

  // covers DP-004
  it("[TC-PE-211] a browser that pairs gets its device as an HttpOnly cookie once, and the pairing secret stops working", async () => {
    const opened = await request<{ status: { id: string; code: string; state: string }; secret?: string }>(
      { origin: OWN_ORIGIN },
      "POST",
      "/api/pairing",
      { name: "  Safari\u0007 on iPhone ", platform: "iOS", kind: "browser" },
    );
    expect(opened.status).toBe(200);
    expect(opened.body.status).toMatchObject({ state: "pending" });
    expect(opened.body.status.code).toMatch(/^\d{6}$/);
    // A browser's pairing secret is a cookie its page scripts never see, never part of the body.
    expect(opened.body).not.toHaveProperty("secret");
    const pairingLine = opened.setCookie.find((line) => line.startsWith("hobbots_pairing=")) ?? "";
    expect(pairingLine).toContain("HttpOnly");
    expect(pairingLine).toContain("SameSite=Strict");
    const pairing = cookieFrom(opened.setCookie, "hobbots_pairing") as string;

    // Waiting, it learns nothing but where its request stands; a page of another site cannot ask for it.
    expect((await request(browser(pairing), "GET", "/api/pairing")).body).toMatchObject({ state: "pending" });
    expect(await request({ cookie: pairing, "sec-fetch-site": "cross-site" }, "GET", "/api/pairing")).toMatchObject({
      status: 403,
      body: FOREIGN,
    });

    // The hub's window sees it waiting, with its cleaned name, and allows it.
    const waiting = await request<ReadonlyArray<PairingRequest>>(APP, "GET", "/api/pairing/requests");
    expect(waiting.body).toMatchObject([{ id: opened.body.status.id, name: "Safari on iPhone", kind: "browser" }]);
    // A script cannot list or decide them.
    expect((await request(SCRIPT, "POST", `/api/pairing/requests/${opened.body.status.id}/allow`)).status).toBe(401);
    expect((await request(APP, "POST", `/api/pairing/requests/${opened.body.status.id}/allow`)).body).toMatchObject({
      state: "allowed",
    });

    // Its next status check hands the token over as the device cookie, and drops the pairing cookie.
    const claimed = await request<Record<string, unknown>>(browser(pairing), "GET", "/api/pairing");
    expect(claimed.body).toMatchObject({ state: "claimed" });
    expect(claimed.body).not.toHaveProperty("token");
    const deviceLine = claimed.setCookie.find((line) => line.startsWith("hobbots_device=")) ?? "";
    for (const part of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=34560000"])
      expect(deviceLine).toContain(part);
    expect(deviceLine).not.toContain("Domain");
    expect(claimed.setCookie.find((line) => line.startsWith("hobbots_pairing="))).toContain("Max-Age=0");
    const cookie = cookieFrom(claimed.setCookie, "hobbots_device") as string;
    expect(cookie).toMatch(/^hobbots_device=hbd_[A-Za-z0-9_-]{43}$/);
    // Only once: the secret no longer answers.
    expect(await request(browser(pairing), "GET", "/api/pairing")).toMatchObject({ status: 404 });

    // The cookie works for reads on the hub's page and changes that name its own origin.
    expect((await request(browser(cookie), "GET", "/api/agents")).status).toBe(200);
    expect((await request(browser(cookie, "PATCH"), "PATCH", "/api/setup", { completed: true })).status).toBe(200);
    const stream = await send(browser(cookie), "GET", "/api/events");
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
    expect((await devices()).map((device) => [device.kind, device.name])).toEqual([
      ["window", "This computer's Hobbots window"],
      ["browser", "Safari on iPhone"],
    ]);
  });

  // covers DP-004
  it("[TC-PE-212] the desktop app pairs with a bearer secret and takes its token in the body", async () => {
    const opened = await request<{ status: { id: string }; secret: string }>({}, "POST", "/api/pairing", {
      name: "MacBook Air",
      platform: "macOS",
      kind: "desktop",
    });
    expect(opened.body.secret).toMatch(/^hbp_[A-Za-z0-9_-]{43}$/);
    expect(opened.setCookie).toEqual([]);
    const pairing = { authorization: `Bearer ${opened.body.secret}` };
    expect((await request(pairing, "GET", "/api/pairing")).body).toMatchObject({ state: "pending" });
    await request(APP, "POST", `/api/pairing/requests/${opened.body.status.id}/allow`);
    const claimed = await request<{ token: string }>(pairing, "GET", "/api/pairing");
    expect(claimed.body.token).toMatch(/^hbd_[A-Za-z0-9_-]{43}$/);
    expect(claimed.setCookie).toEqual([]);
    expect((await request({ authorization: `Bearer ${claimed.body.token}` }, "GET", "/api/agents")).status).toBe(200);
    expect(await request(pairing, "GET", "/api/pairing")).toMatchObject({ status: 404 });
  });

  // covers DP-004
  it("[TC-PE-213] refuses a cookie request another page could have sent, and two device cookies of one name", async () => {
    const { cookie } = await pairedBrowser();
    const attempts = [
      // A change without its own Origin, or from another one, even on localhost.
      await request({ cookie }, "PATCH", "/api/setup", { completed: true }),
      await request({ cookie, origin: "http://localhost:5174" }, "PATCH", "/api/setup", { completed: true }),
      await request({ cookie, origin: "https://attacker.example" }, "POST", "/api/agents", {}),
      // Reads the browser marks cross-site or same-site, the event stream included.
      await request({ cookie, "sec-fetch-site": "cross-site" }, "GET", "/api/agents"),
      await request({ cookie, "sec-fetch-site": "same-site" }, "GET", "/api/grants"),
    ];
    for (const attempt of attempts) expect(attempt).toMatchObject({ status: 403, body: FOREIGN });
    expect((await send({ cookie, "sec-fetch-site": "cross-site" }, "GET", "/api/events")).status).toBe(403);
    // A cookie another host set for a parent domain cannot shadow the real one.
    const doubled = { cookie: `${cookie}; ${cookie}`, "sec-fetch-site": "same-origin" };
    expect(await request(doubled, "GET", "/api/agents")).toMatchObject({ status: 401, body: REQUIRED });
    // Opening a pairing request from another page is refused; the desktop app names no origin.
    expect(
      await request({ origin: "https://attacker.example" }, "POST", "/api/pairing", {
        name: "x",
        platform: "",
        kind: "browser",
      }),
    ).toMatchObject({ status: 403, body: FOREIGN });
  });

  // covers DP-004
  it("[TC-PE-214] accepts a token only from where it was approved, and the window key only in local requests", async () => {
    const phone = { [NODE_HEADER]: "nPHONE" };
    const { cookie } = await pairedBrowser(phone);
    const local = await pairedBrowser();
    const from = (place: Caller, token: string) => ({ ...place, ...browser(token) });

    expect((await request(from(phone, cookie), "GET", "/api/agents")).status).toBe(200);
    // The same cookie copied to another node, or used locally, is refused like a missing one.
    expect(await request(from({ [NODE_HEADER]: "nLAPTOP" }, cookie), "GET", "/api/agents")).toMatchObject({
      status: 401,
      body: REQUIRED,
    });
    expect(await request(from({}, cookie), "GET", "/api/agents")).toMatchObject({ status: 401, body: REQUIRED });
    // A device approved locally is not accepted over the tailnet, and neither is the window key.
    expect((await request(from(phone, local.cookie), "GET", "/api/agents")).status).toBe(401);
    expect((await request({ ...phone, ...APP }, "GET", "/api/agents")).status).toBe(401);
    expect((await devices()).find((device) => device.kind === "browser" && device.tailscale !== null)).toMatchObject({
      tailscale: { nodeId: "nPHONE" },
    });
  });

  // covers DP-004, PE-006
  it("[TC-PE-215] a revoked device is refused as revoked, decides nothing, and no secret is ever stored or logged", async () => {
    await setupDone();
    const { pending } = await pendingPush();
    const { cookie } = await pairedBrowser();
    const [, phone] = await devices();
    await runtime.runPromise(
      Effect.flatMap(DeviceRepository, (repo) => repo.revoke(DeviceId.make(phone?.id ?? ""), new Date().toISOString())),
    );
    const decide = `/api/approvals/${pending.id}/decision`;
    const decision = { decision: "approve", actionDigest: pending.actionDigest, lifetime: "always" };
    expect(await request(browser(cookie, "POST"), "POST", decide, decision)).toMatchObject({
      status: 401,
      body: { _tag: "DeviceRevoked" },
    });
    expect(await request(browser(cookie), "GET", "/api/agents")).toMatchObject({ status: 401 });
    expect((await send(browser(cookie), "GET", "/api/events")).status).toBe(401);
    expect(await grants()).toEqual([]);

    // The database and the hub's log hold hashes and codes, never a token, a pairing secret or the window key.
    const dump = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const devicesRows = yield* sql`SELECT * FROM devices`;
        const pairingRows = yield* sql`SELECT * FROM pairing_requests`;
        const journal = yield* sql`SELECT * FROM event_journal`;
        return JSON.stringify([devicesRows, pairingRows, journal]);
      }),
    );
    for (const text of [dump, logged.join("\n")]) {
      expect(text).not.toMatch(/hb[dpw]_[A-Za-z0-9_-]{20}/);
    }
    expect(dump).toContain("Safari on iPhone");
  });
});

describe("only the user decides approvals and manages grants", () => {
  // covers PE-006
  it("[TC-PE-110] refuses and records every decision or grant request that is not from an approved device", async () => {
    await setupDone();
    const { thread, pending } = await pendingPush();
    const always = { decision: "approve", actionDigest: pending.actionDigest, lifetime: "always" };
    const decide = `/api/approvals/${pending.id}/decision`;
    const { cookie } = await pairedBrowser();
    refusals = [];

    // A script on the hub, or another web page in the user's browser, cannot approve it, deny it or read the requests.
    const attempts = [
      await request(SCRIPT, "POST", decide, always),
      await request(SCRIPT, "POST", decide, { decision: "deny", actionDigest: pending.actionDigest }),
      await request({ cookie, origin: "https://attacker.example" }, "POST", decide, always),
      await request(SCRIPT, "GET", `/api/threads/${thread.id}/approvals`),
      await request(SCRIPT, "GET", "/api/grants"),
    ];
    for (const attempt of attempts) expect([401, 403]).toContain(attempt.status);
    expect(refusals).toHaveLength(attempts.length);
    expect(refusals[0]).toContain(`POST ${decide}`);
    expect(await approvals(thread)).toMatchObject([{ id: pending.id, state: "pending" }]);
    expect(await grants()).toEqual([]);

    // The user can, from a paired browser, and Always saves a grant only then.
    const approved = await request<ApprovalRequest>(browser(cookie, "POST"), "POST", decide, always);
    expect(approved.body).toMatchObject({ state: "approved", lifetime: "always" });
    const [grant] = await grants();
    expect(grant).toMatchObject({ grantedBy: "user", revokedAt: null });

    // Nobody but the user removes it, and a refused removal leaves it in place.
    refusals = [];
    const revoke = `/api/grants/${grant?.id}/revoke`;
    expect(await request(SCRIPT, "POST", revoke)).toMatchObject({ status: 401, body: REQUIRED });
    expect(await request({ cookie }, "POST", revoke)).toMatchObject({ status: 403, body: FOREIGN });
    expect(refusals).toHaveLength(2);
    expect(await grants()).toMatchObject([{ id: grant?.id, revokedAt: null }]);
    expect((await request<Grant>(APP, "POST", revoke)).body).toMatchObject({ revokedBy: "user" });
  });

  // covers PE-006
  it("[TC-PE-113] refuses and records a change to what hobs may do that is not from an approved device", async () => {
    await setupDone();
    const thread = await hobThread("Pip");
    const hob = thread.agentId;
    const permissions = `/api/agents/${hob}/permissions`;
    const before = (await request(APP, "GET", permissions)).body;
    refusals = [];
    // Widening a hob's own folders or signing, or the installation's preset, would sidestep a refused decision.
    const attempts = [
      await request(SCRIPT, "PATCH", permissions, { ownFolders: [temp], signCommits: true }),
      await request({ origin: "https://attacker.example" }, "PATCH", permissions, { signCommits: true }),
      await request(SCRIPT, "PATCH", "/api/setup", { safetyPreset: "trusting", approvedFolders: [temp] }),
      await request(SCRIPT, "GET", permissions),
    ];
    for (const attempt of attempts) expect(attempt).toMatchObject({ status: 401, body: REQUIRED });
    expect(refusals).toHaveLength(attempts.length);
    expect((await request(APP, "GET", permissions)).body).toEqual(before);
    expect((await request(APP, "GET", "/api/setup")).body).toMatchObject({
      safetyPreset: "balanced",
      approvedFolders: [project],
    });
  });

  // covers PE-006. A regression check: these refusals come from the runtime adapter (an unknown tool)
  // and the policy engine (loopback is never reachable, ADR 014), not from the device check.
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

  // covers PE-006
  it("[TC-PE-112] only the hub's device middleware provides a user session, and every route but health and pairing carries it", () => {
    // Every route, including any added later, sits behind the middleware, except the two a device
    // without a token needs.
    for (const group of Object.values(HobbotsApi.groups)) {
      const endpoints = Object.values(group.endpoints);
      expect(endpoints.length).toBeGreaterThan(0);
      for (const endpoint of endpoints) {
        if (group.identifier === "health" || group.identifier === "pairing") {
          expect([...endpoint.middlewares]).not.toContain(DeviceSession);
        } else {
          expect([...endpoint.middlewares], `${group.identifier}.${endpoint.name}`).toContain(DeviceSession);
        }
      }
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
        join("packages", "agents", "src", "devices.ts"),
        join("packages", "agents", "src", "grants.ts"),
        join("packages", "agents", "src", "questions.ts"),
        join("packages", "api", "src", "user-session.ts"),
      ].sort(),
    );
    // The services only require it: they import it, name it in a signature or a comment, and read it.
    const requiring =
      /^\s*(UserSession,|import .*\bUserSession\b.*|(const session = )?yield\* UserSession;|.*, UserSession>;?|\s*\*.*|\) => Effect\.Effect<.*UserSession>;|\s*UserSession$)$/;
    for (const service of ["approvals.ts", "charm-calls.ts", "devices.ts", "grants.ts", "questions.ts"]) {
      const lines = readFileSync(join(root, "packages", "agents", "src", service), "utf8")
        .split("\n")
        .filter((line) => /\bUserSession\b/.test(line));
      for (const line of lines) expect(line).toMatch(requiring);
    }
  });
});
