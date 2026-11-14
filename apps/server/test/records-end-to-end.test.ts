import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  CampSuggestionService,
  CatchUps,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  Notes,
  PermissionSummary,
  Records,
  RecordToolsLive,
  SecretRedaction,
} from "@hobbots/agents";
import {
  type Agent,
  CAMP_SUGGESTION_DECISIONS,
  type CampSuggestion,
  type CatchUp,
  type ChapterMove,
  type Decision,
  isInProgress,
  type Message,
  type MessagePin,
  RECORD_DECISION_TOOL,
  roleFields,
  type Thread,
  type UnreadThreads,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  BriefLogLive,
  CampSuggestionRepositoryLive,
  CatchUpRepositoryLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  PinRepositoryLive,
  RecordRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FAKE_HUB_DIRECTIVE, FakeRuntimeLayer } from "@hobbots/runtimes";
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

// Decisions over the HTTP API and from a chat turn (ADR 037, #1383), with the hub's own composition:
// a hob records one with `record_decision`, you replace it or cross it out, and every one is kept.
// A chat chapter they grow is suggested as a camp, which you keep in the chat or move into one (#1385).
// Notes to self, pins, catch-up and a camp's privacy setting are the camp sheet's (#1387).
const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-records-")));
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
    .pipe(Layer.provideMerge(RecordToolsLive.pipe(Layer.provideMerge(Records.layer))))
    .pipe(Layer.provideMerge(CampSuggestionService.layer))
    .pipe(Layer.provideMerge(Layer.mergeAll(Notes.layer, CatchUps.layer)))
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
            RecordRepositoryLive,
            CampSuggestionRepositoryLive.pipe(Layer.provide(EventJournal.layer)),
            BriefLogLive.pipe(Layer.provide(EventJournal.layer)),
            PinRepositoryLive,
            CatchUpRepositoryLive,
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

describe("decisions over the API", () => {
  // covers CH-001, ADR 037 (Records)
  it("[TC-CH-1383-08] keeps a hob's decision from its turn, and yours that replaces it, crossed out and listed", async () => {
    const { thread } = await pipWithThread();
    const call = { key: "tuesdays", text: "Launch emails go out on Tuesdays." };
    const reply = await exchange(thread, `${FAKE_HUB_DIRECTIVE} ${RECORD_DECISION_TOOL} ${JSON.stringify(call)}`);
    const decisions = async () =>
      (await request<ReadonlyArray<Decision>>("GET", `/api/threads/${thread.id}/decisions`)).body;
    const [hobs] = await decisions();
    expect(hobs).toMatchObject({ text: call.text, actor: { kind: "hob" }, sourceMessageId: reply.id, state: "active" });

    const yours = { key: "wednesdays", text: "Launch emails go out on Wednesdays.", replaces: hobs?.id };
    const recorded = await request<{ recorded: Decision; superseded: Decision }>(
      "POST",
      `/api/threads/${thread.id}/decisions`,
      yours,
    );
    expect(recorded.status).toBe(200);
    expect(recorded.body.recorded).toMatchObject({ actor: { kind: "user", id: "owner" }, sourceMessageId: null });
    expect(recorded.body.superseded).toMatchObject({
      id: hobs?.id,
      state: "superseded",
      supersededBy: recorded.body.recorded.id,
    });
    // The same request again records nothing new.
    const again = await request<{ recorded: Decision }>("POST", `/api/threads/${thread.id}/decisions`, yours);
    expect(again.body.recorded.id).toBe(recorded.body.recorded.id);

    const crossed = await request<Decision>(
      "POST",
      `/api/threads/${thread.id}/decisions/${recorded.body.recorded.id}/cross-out`,
    );
    expect(crossed.body).toMatchObject({ state: "superseded", supersededBy: null });
    const long = await request<{ _tag: string; reason: string }>("POST", `/api/threads/${thread.id}/decisions`, {
      key: "long",
      text: "x".repeat(501),
      replaces: null,
    });
    expect(long.status).toBe(409);
    expect(long.body).toMatchObject({ _tag: "DecisionChangeRefused", reason: "too-long" });
    expect((await decisions()).map((each) => [each.text, each.state])).toEqual([
      ["Launch emails go out on Wednesdays.", "superseded"],
      ["Launch emails go out on Tuesdays.", "superseded"],
    ]);
    expect((await request("GET", `/api/threads/${thread.id}/artifacts`)).body).toEqual([]);
    // No chapter ended, so the hub has written no brief yet (#1384).
    expect(await request("GET", `/api/threads/${thread.id}/brief`)).toEqual({ status: 200, body: null });
    expect((await request("GET", "/api/threads/nope/decisions")).status).toBe(404);
    expect((await request("GET", "/api/threads/nope/brief")).status).toBe(404);
  });
});

describe("camp suggestions over the API", () => {
  // covers CH-009, ADR 037 (Records: CampSuggestion, Moving a chapter into a camp moves it)
  it("[TC-CH-1385-18] offers a grown chat chapter, keeps it in the chat, and moves it into a new camp once", async () => {
    const { thread } = await pipWithThread();
    await exchange(thread, "Let us plan the launch.");
    for (let n = 1; n <= CAMP_SUGGESTION_DECISIONS; n++) {
      await request("POST", `/api/threads/${thread.id}/decisions`, {
        key: `d${n}`,
        text: `Decision ${n}`,
        replaces: null,
      });
    }
    const suggestions = async () =>
      (await request<ReadonlyArray<CampSuggestion>>("GET", `/api/threads/${thread.id}/camp-suggestions`)).body;
    const [open] = await suggestions();
    expect(open).toMatchObject({ state: "open", reasons: [{ code: "decisions", count: CAMP_SUGGESTION_DECISIONS }] });
    const keep = `/api/threads/${thread.id}/camp-suggestions/${open?.id}/keep`;
    expect((await request<CampSuggestion>("POST", keep)).body).toMatchObject({ state: "kept" });
    expect((await request<CampSuggestion>("POST", keep)).body).toMatchObject({ state: "kept" });
    expect(await suggestions()).toEqual([]);
    const missing = await request("POST", `/api/threads/${thread.id}/camp-suggestions/nope/keep`);
    expect(missing).toMatchObject({ status: 409, body: { _tag: "CampSuggestionChangeRefused", reason: "not-found" } });

    // The chat's live chapter moves into a new camp, with its messages and decisions.
    const listed = await request<ReadonlyArray<Thread>>("GET", `/api/agents/${thread.agentId}/threads`);
    const chapterId = listed.body.find((each) => each.id === thread.id)?.liveChapterId;
    const into = { _tag: "new", key: "camp-launch", title: "Launch", goal: null, private: false };
    const moved = await request<ChapterMove>("POST", `/api/threads/${thread.id}/chapters/${chapterId}/move`, into);
    expect(moved.status).toBe(200);
    expect(moved.body.stub).toMatchObject({ id: chapterId, state: "moved", movedTo: "camp-launch" });
    const again = await request<ChapterMove>("POST", `/api/threads/${thread.id}/chapters/${chapterId}/move`, into);
    expect(again.body.stub).toEqual(moved.body.stub);
    expect((await request<ReadonlyArray<Message>>("GET", "/api/threads/camp-launch/messages")).body).toHaveLength(2);
    expect((await request<ReadonlyArray<Decision>>("GET", "/api/threads/camp-launch/decisions")).body).toHaveLength(
      CAMP_SUGGESTION_DECISIONS,
    );
    expect(await messages(thread)).toEqual([]);

    const refused = await request("POST", `/api/threads/${thread.id}/chapters/${chapterId}/move`, {
      _tag: "camp",
      campId: "nowhere",
    });
    expect(refused).toMatchObject({ status: 409, body: { _tag: "ChapterMoveRefused", reason: "not-a-camp" } });
    const unknown = await request("POST", `/api/threads/${thread.id}/chapters/nope/move`, into);
    expect(unknown).toMatchObject({ status: 404, body: { _tag: "ChapterMissing" } });
  });
});

describe("the camp sheet over the API", () => {
  // covers CH-001, ADR 037 (Mine: notes to self never wake a hob)
  it("[TC-CH-1387-01] keeps a note to self that wakes no hob, once under its key", async () => {
    const { thread } = await pipWithThread();
    await exchange(thread, "Hello.");
    const note = { key: "note-1", content: "Ask Ana about the venue." };
    const written = await request<Message>("POST", `/api/threads/${thread.id}/notes`, note);
    expect(written).toMatchObject({
      status: 200,
      body: { id: "note-1", role: "note", content: "Ask Ana about the venue.", actor: { kind: "user" } },
    });
    expect((await request<Message>("POST", `/api/threads/${thread.id}/notes`, note)).body.id).toBe("note-1");
    const reused = await request("POST", `/api/threads/${thread.id}/notes`, { key: "note-1", content: "Other" });
    expect(reused).toMatchObject({ status: 409, body: { _tag: "MessageKeyReused" } });
    expect((await request("POST", `/api/threads/${thread.id}/notes`, { key: "n2", content: "  " })).status).toBe(400);
    // No hob woke: the transcript ends at the note, with no reply after it.
    expect((await messages(thread)).map((each) => each.role)).toEqual(["user", "assistant", "note"]);
    const listed = await request<UnreadThreads>("GET", "/api/unread-threads");
    expect(listed.body.threadIds).toContain(thread.id);
    expect((await request("POST", "/api/threads/nope/notes", note)).status).toBe(404);
  });

  // covers CH-001, ADR 037 (Mine: pins)
  it("[TC-CH-1387-02] pins a message once, lists it, and unpins it", async () => {
    const { thread } = await pipWithThread();
    const reply = await exchange(thread, "Hello.");
    const path = `/api/threads/${thread.id}/messages/${reply.id}/pinned`;
    const pinned = await request<MessagePin>("PUT", path, { pinned: true });
    expect(pinned.body).toMatchObject({ messageId: reply.id, threadId: thread.id });
    expect((await request<MessagePin>("PUT", path, { pinned: true })).body).toEqual(pinned.body);
    expect((await request("GET", `/api/threads/${thread.id}/pins`)).body).toEqual([pinned.body]);
    expect(await request("PUT", path, { pinned: false })).toEqual({ status: 200, body: null });
    expect((await request("GET", `/api/threads/${thread.id}/pins`)).body).toEqual([]);
    const elsewhere = await request("PUT", `/api/threads/${thread.id}/messages/nope/pinned`, { pinned: true });
    expect(elsewhere).toMatchObject({ status: 404, body: { _tag: "MessageNotFound" } });
  });

  // covers CH-001, ADR 037 (Catch-up)
  it("[TC-CH-1387-03] catches you up on the replies and records since you read, and on nothing after", async () => {
    const { thread } = await pipWithThread();
    const first = await exchange(thread, "Hello.");
    await request("PUT", `/api/threads/${thread.id}/read`, { messageId: first.id, revision: first.revision });
    const call = { key: "fridays", text: "Ship on Fridays." };
    const reply = await exchange(thread, `${FAKE_HUB_DIRECTIVE} ${RECORD_DECISION_TOOL} ${JSON.stringify(call)}`);
    const catchUp = async () => (await request<CatchUp>("GET", `/api/threads/${thread.id}/catch-up`)).body;
    const caught = await catchUp();
    expect(caught).toMatchObject({ firstUnread: reply.id, replies: 1, more: 0, readUpTo: first.createdAt });
    expect(caught.items).toMatchObject([{ _tag: "Decided", decision: { text: call.text }, messageId: reply.id }]);
    const last = (await messages(thread)).at(-1);
    await request("PUT", `/api/threads/${thread.id}/read`, { messageId: last?.id, revision: last?.revision });
    expect(await catchUp()).toMatchObject({ firstUnread: null, replies: 0, items: [] });
    expect((await request("GET", "/api/threads/nope/catch-up")).status).toBe(404);
  });

  // covers CH-001, ADR 037 (Private camps), #1377
  it("[TC-CH-1387-04] makes a camp private later, and refuses it for a chat", async () => {
    const { thread } = await pipWithThread();
    const chat = await request("PUT", `/api/threads/${thread.id}/private`, { private: true });
    expect(chat).toMatchObject({ status: 409, body: { _tag: "ThreadNotCamp" } });
    await exchange(thread, "Let us plan the launch.");
    const listed = await request<ReadonlyArray<Thread>>("GET", `/api/agents/${thread.agentId}/threads`);
    const chapterId = listed.body.find((each) => each.id === thread.id)?.liveChapterId;
    const into = { _tag: "new", key: "camp-private", title: "Launch", goal: null, private: false };
    await request("POST", `/api/threads/${thread.id}/chapters/${chapterId}/move`, into);
    const made = await request<Thread>("PUT", "/api/threads/camp-private/private", { private: true });
    expect(made).toMatchObject({ status: 200, body: { id: "camp-private", private: true } });
  });
});
