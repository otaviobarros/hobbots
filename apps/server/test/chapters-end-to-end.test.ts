import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChapterService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PackReports,
  PermissionSummary,
  SecretRedaction,
} from "@hobbots/agents";
import type { FocusRead } from "@hobbots/api";
import { type Agent, type Chapter, isInProgress, type Message, roleFields, type Thread } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  ChapterRepositoryLive,
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

// A thread's chapters over the HTTP API (ADR 037, #1382), with the hub's own composition, as the
// device session admits them: Split here answers the same request again with what it did, and a
// refused split or merge names its reason. The Focus chip's read is the turn's `PackReport`.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-chapters-")));
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
    .pipe(Layer.provideMerge(Layer.mergeAll(ChatService.layer, ChapterService.layer)))
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
            ChapterRepositoryLive,
            SetupRepository.layer,
            SearchIndex.layer,
          ).pipe(Layer.provideMerge(TestDatabase)),
          EventBus.layer,
          HobAdmission.layer,
          PackReports.layer,
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

const chaptersOf = async (thread: Thread) =>
  (await request<ReadonlyArray<Chapter>>("GET", `/api/threads/${thread.id}/chapters`)).body.map((chapter) => [
    chapter.number,
    chapter.title,
    chapter.state,
  ]);

describe("chapters over the API", () => {
  // covers CH-001, ADR 037 (Chapters)
  it("[TC-CH-1382-03] splits once per key and merges back, and names why a split or a merge is refused", async () => {
    const { thread } = await pipWithThread();
    await exchange(thread, "My cat is called Miso");
    await exchange(thread, "Now the garden");
    expect(await chaptersOf(thread)).toEqual([[1, null, "live"]]);
    const [, , garden] = await messages(thread);

    const ask = { key: "garden", messageId: garden?.id, title: "The garden" };
    const split = await request<ReadonlyArray<Chapter>>("POST", `/api/threads/${thread.id}/chapters/split`, ask);
    expect(split.status).toBe(200);
    expect(split.body.map((chapter) => [chapter.id, chapter.state])).toEqual([
      [expect.any(String), "resting"],
      ["garden", "live"],
    ]);
    // The same request again splits nothing more.
    const again = await request<ReadonlyArray<Chapter>>("POST", `/api/threads/${thread.id}/chapters/split`, ask);
    expect(again.body).toEqual(split.body);
    expect((await messages(thread)).map((message) => message.chapterId)).toEqual([
      split.body[0]?.id,
      split.body[0]?.id,
      "garden",
      "garden",
    ]);

    const [first] = await messages(thread);
    const refusals = [
      [{ key: "start", messageId: garden?.id, title: "Again" }, "chapter-start"],
      [{ key: "nowhere", messageId: "no-such-message", title: "Nowhere" }, "message-not-found"],
    ] as const;
    for (const [payload, reason] of refusals) {
      const refused = await request("POST", `/api/threads/${thread.id}/chapters/split`, payload);
      expect(refused).toMatchObject({ status: 409, body: { _tag: "ChapterChangeRefused", reason } });
    }
    const untitled = await request("POST", `/api/threads/${thread.id}/chapters/split`, {
      key: "blank",
      messageId: first?.id,
      title: "",
    });
    expect(untitled.status).toBe(400);

    const firstChapter = split.body[0]?.id ?? "";
    const atFirst = await request("POST", `/api/threads/${thread.id}/chapters/${firstChapter}/merge`);
    expect(atFirst).toMatchObject({ status: 409, body: { reason: "first-chapter" } });
    const merged = await request<ReadonlyArray<Chapter>>("POST", `/api/threads/${thread.id}/chapters/garden/merge`);
    expect(merged.status).toBe(200);
    expect(await chaptersOf(thread)).toEqual([[1, null, "live"]]);
    // Merging it again, as a retry after a lost answer does, changes nothing; an unknown chapter is refused.
    const twice = await request("POST", `/api/threads/${thread.id}/chapters/garden/merge`);
    expect(twice).toEqual(merged);
    const never = await request("POST", `/api/threads/${thread.id}/chapters/no-such-chapter/merge`);
    expect(never).toMatchObject({ status: 409, body: { reason: "chapter-not-found" } });

    // An archived chat's chapters stay as they are.
    await request("POST", `/api/threads/${thread.id}/archive`);
    const closed = await request("POST", `/api/threads/${thread.id}/chapters/split`, { ...ask, key: "closed" });
    expect(closed).toMatchObject({ status: 409, body: { reason: "thread-closed" } });
    const unknown = await request("GET", "/api/threads/no-such-thread/chapters");
    expect(unknown).toMatchObject({ status: 404, body: { _tag: "ThreadNotFound" } });
  });

  // covers ADR 037 (The context pack, Focus chip)
  it("[TC-CH-1382-04] the Focus read is the report of the pack the last new session read, else the next one's", async () => {
    const { thread } = await pipWithThread();
    const before = await request<FocusRead>("GET", `/api/threads/${thread.id}/focus`);
    expect(before.status).toBe(200);
    expect(before.body.of).toBe("next-session");
    expect(before.body.report.parts.map((part) => part.part)).toEqual([
      "memory-brief",
      "members",
      "camp-brief",
      "decisions",
      "open-work",
      "carried",
      "artifacts",
      "chapters",
      "live-chapter",
    ]);

    // The thread's first turn starts a new session, which reads a pack and keeps its report.
    await exchange(thread, "My cat is called Miso");
    const after = await request<FocusRead>("GET", `/api/threads/${thread.id}/focus`);
    expect(after.body.of).toBe("last-turn");
    expect(after.body.report.tokens).toBe(after.body.report.parts.reduce((sum, part) => sum + part.tokens, 0));
    expect(after.body.report.tokens).toBeLessThanOrEqual(after.body.report.budget);
    const unknown = await request("GET", "/api/threads/no-such-thread/focus");
    expect(unknown.status).toBe(404);
  });
});
