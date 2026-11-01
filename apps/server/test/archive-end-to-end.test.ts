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
import {
  type Agent,
  type ApprovalRequest,
  isInProgress,
  type Message,
  roleFields,
  type SearchHit,
  type Thread,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
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

// The archive slice's done-when checks over the HTTP API, with the hub's own composition: the
// setup's preset and folders, one policy engine, approvals, search and the fake runtime, which
// writes one event every few milliseconds so a reply is still running when the archive is asked.
// The browser side of the same checks is in apps/web/e2e/archive-end-to-end.e2e.ts.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-archive-")));
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
    ApiRoutes.pipe(Layer.provide(App), Layer.provide(NodeHttpServer.layerHttpServices)),
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
      headers: { "content-type": "application/json", host: "localhost:4364", origin: "http://localhost:4364" },
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

const archive = (thread: Thread) =>
  request<Thread & { _tag?: string; reason?: string }>("POST", `/api/threads/${thread.id}/archive`);

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

// Long enough that the fake runtime is still writing it when the archive is asked.
const LONG_PROMPT = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

describe("archiving threads, end to end", () => {
  // covers CH-006, CH-009
  it("[TC-CH-165] an archived thread leaves the hob's list, is found in the archived list and by search, is read-only, and comes back whole on restore", async () => {
    const { pip, thread } = await pipWithThread();
    await exchange(thread, "Rename the kettle newsletter");
    const other = (await request<Thread>("POST", `/api/agents/${pip.id}/threads`)).body;
    await exchange(other, "Plan my week");
    const before = await messages(thread);

    const archived = await archive(thread);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toEqual(expect.any(String));
    expect(await listed(pip.id)).toEqual([other.id]);
    expect(await listed(pip.id, true)).toEqual([thread.id]);

    // Search still finds it, marked archived.
    const hits = (await request<ReadonlyArray<SearchHit>>("GET", "/api/search?q=newsletter")).body;
    expect(hits.map((hit) => ({ id: hit.thread.id, archived: hit.thread.archivedAt !== null }))).toEqual([
      { id: thread.id, archived: true },
    ]);

    // Read-only: the transcript reads as before, and a message is refused.
    expect(await messages(thread)).toEqual(before);
    const sent = await request("POST", `/api/threads/${thread.id}/messages`, { content: "One more idea" });
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ _tag: "ThreadArchived", threadId: thread.id });

    // Restored: back in its place in the list with its history, and it takes messages again.
    const restored = await request<Thread>("POST", `/api/threads/${thread.id}/restore`);
    expect(restored.body.archivedAt).toBeNull();
    expect(restored.body.updatedAt).toBe(archived.body.updatedAt);
    expect(await listed(pip.id)).toEqual([other.id, thread.id]);
    expect(await listed(pip.id, true)).toEqual([]);
    const reply = await exchange(thread, "Try a shorter name");
    expect(reply.status).toBe("complete");
    expect((await messages(thread)).slice(0, before.length)).toEqual(before);
  });

  // covers CH-008, CH-009
  it("[TC-CH-166] refuses to archive while a reply runs, keeps the thread listed, and archives once the reply ends", async () => {
    const { pip, thread } = await pipWithThread();
    await request("POST", `/api/threads/${thread.id}/messages`, { content: LONG_PROMPT });
    await eventually(async () => ((await messages(thread)).at(-1)?.status === "streaming" ? true : undefined));

    const refused = await archive(thread);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ _tag: "ThreadArchiveRefused", threadId: thread.id, reason: "reply-running" });
    expect(await listed(pip.id)).toEqual([thread.id]);
    // The refusal did not interrupt the reply.
    const reply = await replyEnded(thread);
    expect(reply.status).toBe("complete");
    expect(reply.content).toBe(`Echo: ${LONG_PROMPT}`);

    expect((await archive(thread)).status).toBe(200);
    expect(await listed(pip.id)).toEqual([]);
  });

  // covers CH-009, PE-003
  it("[TC-CH-167] refuses to archive while an approval waits, and archives once the user decides and the reply ends", async () => {
    const { pip, thread } = await pipWithThread("balanced");
    // Balanced asks before a push; the fake runtime makes the scripted call.
    await request("POST", `/api/threads/${thread.id}/messages`, {
      content: ["Ship it", "fake:tool Bash git push origin feature"].join("\n"),
    });
    const [pending] = await eventually(async () => {
      const all = (await request<ReadonlyArray<ApprovalRequest>>("GET", `/api/threads/${thread.id}/approvals`)).body;
      return all.length > 0 ? all : undefined;
    });
    expect(pending).toMatchObject({ state: "pending" });

    // The reply is held open too, and the approval is the reason the user sees.
    const refused = await archive(thread);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      _tag: "ThreadArchiveRefused",
      threadId: thread.id,
      reason: "approval-pending",
    });
    expect(await listed(pip.id)).toEqual([thread.id]);
    expect((await messages(thread)).at(-1)?.status).toBe("streaming");

    await request("POST", `/api/approvals/${pending?.id}/decision`, {
      decision: "deny",
      actionDigest: pending?.actionDigest,
    });
    expect((await replyEnded(thread)).status).toBe("complete");
    expect((await archive(thread)).status).toBe(200);
    expect(await listed(pip.id, true)).toEqual([thread.id]);
  });
});
