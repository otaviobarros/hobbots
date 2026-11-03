import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { type Agent, type ApprovalRequest, roleFields, type Thread, WINDOW_DEVICE_ID } from "@hobbots/domain";
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
import { Effect, Layer, ManagedRuntime, Option, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TailnetPeer, TailnetPeers } from "../src/devices.ts";
import { EventBus } from "../src/event-bus.ts";
import { EventStream } from "../src/event-stream.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, testDevicesWith } from "./window-device.ts";

// Each decided approval names the approved device the user decided it from, and where (#598), over
// the hub's own routes with the fake runtime making the hob's tool calls.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-approval-deciders-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
const dataDir = join(temp, "hub", "data");
mkdirSync(project, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const HUB = "localhost:4365";
const OWN_ORIGIN = `http://${HUB}`;

const hubNode: TailnetPeer = { nodeId: "nHUB", nodeName: "hub", owner: { _tag: "User", login: "you@example.com" } };
const NoRemotePeers = Layer.succeed(TailnetPeers, {
  remote: () => false,
  hub: Effect.succeed(Option.some(hubNode)),
  peerOf: () => Effect.succeed(Option.none()),
});

const App = HobLifecycle.layer
  .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer, EventStream.layer)))
  .pipe(Layer.provideMerge(ChatService.layer))
  .pipe(Layer.provideMerge(ApprovalService.layer))
  .pipe(Layer.provideMerge(GrantService.layer))
  .pipe(Layer.provideMerge(HobToolsLive))
  .pipe(Layer.provideMerge(CanonicalSharedFolders))
  .pipe(Layer.provideMerge(testDevicesWith(NoRemotePeers)))
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

beforeEach(async () => {
  runtime = ManagedRuntime.make(App);
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
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
afterEach(() => dispose());

/** Who sends a request, as the headers it sends. */
type Caller = Readonly<Record<string, string>>;
const APP: Caller = AS_WINDOW;

/** A browser holding `cookie`, on the hub's own page: changes name its origin, reads are same-origin. */
const browser = (cookie: string, method = "GET"): Caller =>
  method === "GET" ? { cookie, "sec-fetch-site": "same-origin" } : { cookie, origin: OWN_ORIGIN };

const request = async <A>(caller: Caller, method: string, path: string, body?: unknown) => {
  const response = await handler(
    new Request(`http://${HUB}${path}`, {
      method,
      headers: { "content-type": "application/json", host: HUB, ...caller },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : undefined) as A,
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

const setupDone = () =>
  request(APP, "PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [project] });

const hobThread = async () => {
  const hob = await request<Agent>(APP, "POST", "/api/agents", {
    name: "Nettle",
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

/** A thread whose turn waits on the user to approve a push to a feature branch. */
const pendingPush = async () => {
  const thread = await hobThread();
  await request(APP, "POST", `/api/threads/${thread.id}/messages`, {
    content: "Ship it\nfake:tool Bash git push origin feature",
  });
  const [pending] = await eventually(async () => {
    const all = await approvals(thread);
    return all.some((approval) => approval.state === "pending") ? all : undefined;
  });
  return { thread, pending: pending as ApprovalRequest };
};

const cookieFrom = (setCookie: ReadonlyArray<string>, name: string) =>
  setCookie.map((line) => line.split(";")[0] ?? "").find((pair) => pair.startsWith(`${name}=`));

/** A second device: a browser that asked to pair and was allowed from the hub's window. Its cookie. */
const pairedBrowser = async () => {
  const opened = await request<{ status: { id: string } }>({}, "POST", "/api/pairing", {
    name: "Safari on iPhone",
    platform: "iOS",
    kind: "browser",
  });
  const pairing = cookieFrom(opened.setCookie, "hobbots_pairing") as string;
  await request(APP, "POST", `/api/pairing/requests/${opened.body.status.id}/allow`);
  const claimed = await request(browser(pairing), "GET", "/api/pairing");
  return cookieFrom(claimed.setCookie, "hobbots_device") as string;
};

const deviceNamed = async (name: string) => {
  const devices = await runtime.runPromise(Effect.flatMap(DeviceRepository, (repo) => repo.list));
  return devices.find((device) => device.name === name);
};

const decide = (caller: Caller, approval: ApprovalRequest, payload: Record<string, unknown>) =>
  request<ApprovalRequest>(caller, "POST", `/api/approvals/${approval.id}/decision`, {
    actionDigest: approval.actionDigest,
    ...payload,
  });

describe("approval deciders", () => {
  // covers PE-003, PE-006
  it("[TC-IN-203] attributes a decision from a second approved device to that device, with where it was made", async () => {
    await setupDone();
    const phone = await pairedBrowser();
    const iphone = await deviceNamed("Safari on iPhone");
    const { thread, pending } = await pendingPush();

    const decided = await decide(browser(phone, "POST"), pending, { decision: "approve", via: "inbox" });

    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ state: "approved", decidedByDeviceId: iphone?.id, decidedVia: "inbox" });
    const [stored] = await approvals(thread);
    expect(stored).toMatchObject({ decidedByDeviceId: iphone?.id, decidedVia: "inbox" });
  });

  // covers PE-003
  it("[TC-IN-204] attributes a decision from the hub's window to the window, and keeps the first decider when decided again", async () => {
    await setupDone();
    const phone = await pairedBrowser();
    const { thread, pending } = await pendingPush();

    const first = await decide(APP, pending, { decision: "deny", via: "chat" });
    const again = await decide(browser(phone, "POST"), pending, { decision: "deny", via: "inbox" });

    expect(first.body).toMatchObject({ state: "denied", decidedByDeviceId: WINDOW_DEVICE_ID, decidedVia: "chat" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ decidedByDeviceId: WINDOW_DEVICE_ID, decidedVia: "chat" });
    const [stored] = await approvals(thread);
    expect(stored).toMatchObject({ decidedByDeviceId: WINDOW_DEVICE_ID, decidedVia: "chat" });
  });

  // covers PE-003
  it("[TC-IN-205] records an expired request as expired, with no decider", async () => {
    await setupDone();
    const { thread } = await pendingPush();

    await request(APP, "POST", `/api/threads/${thread.id}/interrupt`);

    const [stored] = await eventually(async () => {
      const all = await approvals(thread);
      return all[0]?.state === "expired" ? all : undefined;
    });
    expect(stored).toMatchObject({ state: "expired", decidedByDeviceId: null, decidedVia: "expired" });
  });

  // covers PE-003
  it("[TC-IN-206] records no surface for a decision from a client that does not say where it was made", async () => {
    await setupDone();
    const { pending } = await pendingPush();

    const decided = await decide(APP, pending, { decision: "approve" });

    expect(decided.body).toMatchObject({ decidedByDeviceId: WINDOW_DEVICE_ID, decidedVia: null });
  });
});
