import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PermissionSummary,
  SecretRedaction,
} from "@hobbots/agents";
import { type Agent, isInProgress, type Message, roleFields, type StartedFresh, type Thread } from "@hobbots/domain";
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
import { Effect, Layer, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { ToolLogsLive } from "../src/tool-logs.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Make a camp and Start fresh over the HTTP API (ADR 037, #1376), with the hub's own composition, as
// the device session admits them: both answer the same request again with what they did.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-camps-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
const dataDir = join(temp, "hub", "data");
mkdirSync(project);
mkdirSync(dataDir, { recursive: true });

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeEach(() => {
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
          FakeRuntimeLayer({ delay: "10 millis" }).pipe(Layer.provide(PolicyEngine.node)),
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
afterEach(() => dispose());

const request = async <A>(method: string, path: string, body?: unknown): Promise<{ status: number; body: A }> => {
  const response = await handler(
    new Request(`http://localhost:4364${path}`, {
      method,
      // As the web client sends it, so approvals answer the user (PE-006).
      headers: { "content-type": "application/json", host: "localhost:4364", ...AS_WINDOW },
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

const messages = async (thread: Thread) =>
  (await request<ReadonlyArray<Message>>("GET", `/api/threads/${thread.id}/messages`)).body;

const listed = async (hobId: string, archived = false) =>
  (
    await request<ReadonlyArray<Thread>>("GET", `/api/agents/${hobId}/threads${archived ? "?archived=true" : ""}`)
  ).body.map((thread) => thread.id);

/** Waits until the thread's last message is a reply that has ended. */
const replyEnded = (thread: Thread) =>
  eventually(async () => {
    const last = (await messages(thread)).at(-1);
    return last?.role === "assistant" && !isInProgress(last.status) ? last : undefined;
  });

/** A finished setup on `preset` sharing a project folder, with Pip and one empty thread. */
const pipWithThread = async (preset: "careful" | "balanced" = "balanced") => {
  await request("PATCH", "/api/setup", { completed: true, safetyPreset: preset, approvedFolders: [project] });
  const pip = (
    await request<Agent>("POST", "/api/agents", {
      name: "Pip",
      ...roleFields("writer"),
      lookSeed: 4821,
      lookColor: "violet",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    })
  ).body;
  const thread = (await request<Thread>("POST", `/api/agents/${pip.id}/threads`)).body;
  return { pip, thread };
};

/** Sends `content` and waits until its reply has ended. */
const exchange = async (thread: Thread, content: string) => {
  const sent = await request("POST", `/api/threads/${thread.id}/messages`, { content });
  expect(sent.status).toBe(200);
  return replyEnded(thread);
};

describe("camps and Start fresh over the API", () => {
  // covers CH-009
  it("[TC-CH-1376-07] makes a camp and starts a chat fresh once per key, and refuses what does not fit", async () => {
    const { pip, thread } = await pipWithThread();
    await exchange(thread, "Plan the launch");
    const ask = { key: "camp-launch", title: "Launch post", goal: "Write the launch post", private: true };
    const camp = await request<Thread>("POST", `/api/agents/${pip.id}/camps`, ask);
    expect(camp.status).toBe(200);
    expect(camp.body).toMatchObject({ id: "camp-launch", kind: "camp", goal: "Write the launch post", private: true });
    const again = await request<Thread>("POST", `/api/agents/${pip.id}/camps`, ask);
    expect(again.body).toEqual(camp.body);
    const reused = await request("POST", `/api/agents/${pip.id}/camps`, { ...ask, title: "Another" });
    expect(reused).toMatchObject({ status: 409, body: { _tag: "ThreadKeyReused", threadId: "camp-launch" } });
    const untitled = await request("POST", `/api/agents/${pip.id}/camps`, { ...ask, key: "camp-2", title: "" });
    expect(untitled.status).toBe(400);

    const onCamp = await request("POST", "/api/threads/camp-launch/start-fresh", { key: "fresh-0" });
    expect(onCamp).toMatchObject({ status: 409, body: { _tag: "StartFreshRefused", reason: "not-open-chat" } });
    const fresh = await request<StartedFresh>("POST", `/api/threads/${thread.id}/start-fresh`, { key: "fresh-1" });
    expect(fresh.status).toBe(200);
    expect(fresh.body.superseded).toMatchObject({ id: thread.id, state: "superseded" });
    expect(fresh.body.chat).toMatchObject({ id: "fresh-1", kind: "chat", origin: { threadId: thread.id } });
    const replayed = await request<StartedFresh>("POST", `/api/threads/${thread.id}/start-fresh`, { key: "fresh-1" });
    expect(replayed.body).toEqual(fresh.body);
    expect(await listed(pip.id)).toEqual(["fresh-1", "camp-launch"]);
    expect(await listed(pip.id, true)).toEqual([thread.id]);
  });
});
