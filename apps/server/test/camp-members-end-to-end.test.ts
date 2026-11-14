import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  CampMembers,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  HobTools,
  PermissionSummary,
  RuntimeAdapter,
  type RuntimeEvent,
} from "@hobbots/agents";
import type { MembersReport } from "@hobbots/api";
import { Agent, AgentId, type Message, type Thread, type ThreadMember } from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
  ThreadMemberRepositoryLive,
  UserRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { type Cause, Effect, Layer, Queue, Schedule, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Issue #1467 (ADR 039, Members): a camp is made with the hobs picked, and its members sheet lists,
// adds and takes out hobs over the API. A hob taken out owes nothing there any more: the answers it
// was waiting to give are dropped, and the one it is giving stops.

const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");
const ROOK = AgentId.make("rook");

const Hobs = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    for (const [id, name] of [
      [QUILL, "Quill"],
      [PIP, "Pip"],
      [ROOK, "Rook"],
    ] as const) {
      yield* repo.insertAgent(
        new Agent({
          id,
          name,
          roleTitle: "Guide",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 3,
          lookColor: "moss",
          configVersion: 1,
          createdAt: "2026-11-14T10:00:00.000Z",
        }),
      );
    }
  }),
);

/** Each turn the runtime starts, which streams what the test offers and ends when the test ends it. */
let turns: Array<Queue.Queue<RuntimeEvent, Cause.Done>>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeEach(() => {
  turns = [];
  const runtime = Layer.succeed(RuntimeAdapter, {
    ...makeFakeRuntime(),
    sendPrompt: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const turn = yield* Queue.unbounded<RuntimeEvent, Cause.Done>();
          turns.push(turn);
          return Stream.fromQueue(turn);
        }),
      ),
  });
  const App = HobLifecycle.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        CampMembers.layer.pipe(Layer.provideMerge(ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)))),
        ApprovalService.layer,
        GrantService.layer,
        HobService.layer,
        PermissionSummary.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Hobs.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ThreadMemberRepositoryLive,
              UserRepositoryLive,
              HobbotsRepositoryLive,
              ApprovalRepositoryLive,
              GrantRepositoryLive,
              TaskRepositoryLive,
              EventJournal.layer,
              BackpackLive,
              SetupRepository.layer,
              SearchIndex.layer,
            ),
          ),
        ).pipe(Layer.provideMerge(TestDatabase)),
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        runtime,
        Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: "/tmp" }),
      ),
    ),
  );
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(Layer.provideMerge(TestDevices), Layer.provideMerge(App), Layer.provide(NodeHttpServer.layerHttpServices)),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});

afterEach(async () => {
  for (const turn of turns) Effect.runSync(Queue.end(turn));
  await dispose();
});

const request = async <A>(method: string, path: string, body?: unknown): Promise<{ status: number; body: A }> => {
  const response = await handler(
    new Request(`http://localhost:4382${path}`, {
      method,
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const waitUntil = (check: () => Promise<boolean>) =>
  Effect.runPromise(
    Effect.promise(check).pipe(
      Effect.flatMap((done) => (done ? Effect.void : Effect.fail("not yet" as const))),
      Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 400 }),
    ),
  );

const since = "2026-11-14T00:00:00.000Z";
const report = async (threadId: string) =>
  (await request<MembersReport>("GET", `/api/threads/${threadId}/members?since=${since}`)).body;
const shown = (member: ThreadMember) => `${member.actor.kind}:${member.actor.id}:${member.state}`;
const working = async (): Promise<ReadonlyArray<string>> =>
  (await request<{ working: ReadonlyArray<{ agentId: string }> }>("GET", "/api/activity")).body.working.map(
    (hob) => hob.agentId,
  );
const replies = async (threadId: string) =>
  (await request<ReadonlyArray<Message>>("GET", `/api/threads/${threadId}/messages`)).body
    .filter((message) => message.role === "assistant")
    .map((message) => `${message.actor?.id}:${message.status}`);

/** Quill's camp, made with Pip and Rook. */
const campOfThree = async () => {
  const made = await request<Thread>("POST", `/api/agents/${QUILL}/camps`, {
    key: "camp-plans",
    title: "Plans",
    goal: null,
    private: false,
    hobs: [PIP, ROOK, QUILL],
  });
  expect(made.status).toBe(200);
  return made.body;
};

describe("a camp's members over the API", () => {
  // covers ADR 039 (Members), #1467
  it("[TC-CH-1467-02] makes a camp with the hobs picked and lists them, then adds one back and refuses the lead's removal", async () => {
    const camp = await campOfThree();
    const listed = await report(camp.id);
    expect(listed.members.map(shown).sort()).toEqual([
      "hob:pip:active",
      "hob:quill:active",
      "hob:rook:active",
      "user:owner:active",
    ]);
    expect(listed.people.map((user) => user.id)).toEqual(["owner"]);
    expect(listed.today).toEqual([]);

    const lead = await request("DELETE", `/api/threads/${camp.id}/members/hob/${QUILL}`);
    expect(lead).toMatchObject({ status: 409, body: { _tag: "MembershipRefused", reason: "lead" } });
    const owner = await request("DELETE", `/api/threads/${camp.id}/members/user/owner`);
    expect(owner).toMatchObject({ status: 409, body: { _tag: "MembershipRefused", reason: "owner" } });

    const out = await request<ThreadMember>("DELETE", `/api/threads/${camp.id}/members/hob/${ROOK}`);
    expect(out.status).toBe(200);
    expect(shown(out.body)).toBe("hob:rook:removed");
    const back = await request<ThreadMember>("POST", `/api/threads/${camp.id}/members`, {
      actor: { kind: "hob", id: ROOK },
    });
    expect(back.status).toBe(200);
    expect(shown(back.body)).toBe("hob:rook:active");
    const stranger = await request("POST", `/api/threads/${camp.id}/members`, { actor: { kind: "hob", id: "wren" } });
    expect(stranger.status).toBe(404);
  });

  // covers ADR 039 (Members; One hob speaks at a time), #1467
  it("[TC-CH-1467-03] drops what a hob taken out was waiting to answer, and stops the answer it was giving", async () => {
    const camp = await campOfThree();
    await request("POST", `/api/threads/${camp.id}/messages`, { content: "@pip @rook what do you think?" });
    await waitUntil(async () => (await working()).includes(PIP));

    // Rook waits for the floor while Pip speaks; taken out, Rook owes nothing.
    expect((await request("DELETE", `/api/threads/${camp.id}/members/hob/${ROOK}`)).status).toBe(200);
    // Pip, taken out while it speaks, stops.
    expect((await request("DELETE", `/api/threads/${camp.id}/members/hob/${PIP}`)).status).toBe(200);
    await waitUntil(async () => (await working()).length === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await working()).toEqual([]);
    expect(turns).toHaveLength(1);
    expect(await replies(camp.id)).toEqual([`${PIP}:stopped`]);
    expect((await report(camp.id)).members.map(shown).sort()).toEqual([
      "hob:pip:removed",
      "hob:quill:active",
      "hob:rook:removed",
      "user:owner:active",
    ]);
  });
});
