import { NodeHttpServer } from "@effect/platform-node";
import {
  AdditionalRuntimes,
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  HobTools,
  PermissionSummary,
  type PromptRequest,
  RuntimeAdapter,
  type RuntimeAdapterShape,
  RuntimeError,
  type RuntimeEvent,
} from "@hobbots/agents";
import { type Agent, isInProgress, type Message, type RuntimeKind, roleFields, type Thread } from "@hobbots/domain";
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
import { FAKE_DIRECTIVES, makeFakeRuntime } from "@hobbots/runtimes";
import { Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";

const hob = {
  name: "Wren",
  ...roleFields("writer"),
  lookSeed: 7,
  lookColor: "moss",
  runtime: "claude-code",
  model: "fake-thinker",
  effort: "high",
  instructions: "Write short answers.",
};
const codex = { runtime: "codex", model: "fake-coder", effort: null } as const;

// What each runtime was asked, in order.
let asked: Record<RuntimeKind, Array<PromptRequest>>;
// While set, Claude Code refuses every turn, as when it is signed out or down.
let claudeDown: boolean;
// While set, each Claude Code turn runs a command before it writes, as a reply that does work would.
let claudeWorks: boolean;
let handler: (request: Request) => Promise<Response>;
let dispose: (() => Promise<void>) | undefined;

const recorded = (runtime: RuntimeKind, fake: RuntimeAdapterShape): RuntimeAdapterShape => ({
  ...fake,
  sendPrompt: (request) => {
    asked[runtime].push(request);
    if (runtime === "claude-code" && claudeDown) {
      return Stream.fail(new RuntimeError({ message: "Claude Code is signed out" }));
    }
    const reply = fake.sendPrompt(request);
    if (runtime !== "claude-code" || !claudeWorks) return reply;
    return reply.pipe(
      Stream.flatMap((event) =>
        Stream.fromIterable<RuntimeEvent>(
          event._tag === "SessionStarted"
            ? [
                event,
                {
                  _tag: "ToolStarted",
                  id: "tool-1",
                  tool: "Bash",
                  operation: "run-commands",
                  targets: ["/work"],
                  label: "Running pnpm publish",
                },
                { _tag: "ToolFinished", id: "tool-1", failed: false },
              ]
            : [event],
        ),
      ),
    );
  },
});

/** A hub whose fake runtimes answer for Claude Code and, unless left out, for Codex. */
const start = (options: { readonly codex?: boolean } = {}) => {
  asked = { "claude-code": [], codex: [] };
  claudeDown = false;
  claudeWorks = false;
  const runtimes = Layer.mergeAll(
    Layer.succeed(RuntimeAdapter, recorded("claude-code", makeFakeRuntime())),
    options.codex === false
      ? Layer.empty
      : Layer.succeed(
          AdditionalRuntimes,
          new Map([["codex", recorded("codex", makeFakeRuntime({ runtime: "codex" }))]]),
        ),
  );
  const App = HobLifecycle.layer
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
          ApprovalService.layer,
          GrantService.layer,
          HobService.layer,
          PermissionSummary.layer,
        ),
      ),
    )
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
          runtimes,
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: "/tmp" }),
        ),
      ),
    );
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(Layer.provide(App), Layer.provide(NodeHttpServer.layerHttpServices)),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
};

afterEach(() => dispose?.());

const request = async (method: string, path: string, body?: unknown) => {
  const response = await handler(
    new Request(`http://localhost:4364${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const summon = async (): Promise<Agent> => (await request("POST", "/api/agents", hob)).body;
const newThread = async (agent: Agent): Promise<Thread> =>
  (await request("POST", `/api/agents/${agent.id}/threads`)).body;
const thread = async (agent: Agent, id: string): Promise<Thread> =>
  (await request("GET", `/api/agents/${agent.id}/threads`)).body.find((t: Thread) => t.id === id);
const messages = async (threadId: string): Promise<Array<Message>> =>
  (await request("GET", `/api/threads/${threadId}/messages`)).body;
const settled = (threadId: string) =>
  vi.waitFor(async () => {
    const all = await messages(threadId);
    // A message sent just as a turn ends may wait for it; it starts once the turn has drained.
    expect(all.some((m) => isInProgress(m.status) || m.status === "queued")).toBe(false);
    return all;
  });
const say = async (threadId: string, content: string) => {
  await request("POST", `/api/threads/${threadId}/messages`, { content });
  return (await settled(threadId)).at(-1) as Message;
};
const switchTo = (threadId: string, brain: unknown, makeDefault?: boolean) =>
  request("PUT", `/api/threads/${threadId}/brain`, { brain, ...(makeDefault === undefined ? {} : { makeDefault }) });

describe("switching a thread's brain", () => {
  // covers RT-001, CH-001
  it("[TC-CH-126] continues on another runtime, whose first turn is briefed with the thread so far", async () => {
    start();
    const agent = await summon();
    const { id } = await newThread(agent);
    const first = await say(id, "My cat is called Miso.");
    expect(first).toMatchObject({ runtime: "claude-code", model: "fake-thinker", status: "complete" });

    const switched = await switchTo(id, codex);
    expect(switched.status).toBe(200);
    expect(switched.body.brain).toEqual(codex);
    const reply = await say(id, "What is my cat called?");

    expect(asked.codex).toHaveLength(1);
    const briefed = asked.codex[0] as PromptRequest;
    expect(briefed.sessionId).toBeNull();
    expect(briefed.model).toBe("fake-coder");
    expect(briefed.prompt).toBe("What is my cat called?");
    expect(briefed.briefing).toMatch(/^## This thread so far/);
    expect(briefed.briefing).toContain("My cat is called Miso.");
    expect(reply).toMatchObject({ runtime: "codex", model: "fake-coder", status: "complete" });
    // The fake echoes what it was told, so this shows the fact reached Codex's turn. A real model
    // using it is for the Codex adapter to prove (#12).
    expect(reply.content).toContain("Miso");
    const sessions = (await thread(agent, id)).sessions;
    expect(sessions.map((s) => s.runtime)).toEqual(["claude-code", "codex"]);
    expect(sessions[1]?.sessionId).toMatch(/^fake-codex-/);

    // The next Codex turn resumes its own session, with nothing to catch up on.
    await say(id, "Thanks.");
    expect(asked.codex[1]).toMatchObject({ prompt: "Thanks.", briefing: null, sessionId: sessions[1]?.sessionId });
  });

  // covers RT-001, CH-001
  it("[TC-CH-127] switching back resumes the first runtime's session and tells it only what it missed", async () => {
    start();
    const agent = await summon();
    const { id } = await newThread(agent);
    await say(id, "My cat is called Miso.");
    const claudeSession = asked["claude-code"].length;
    const claudeId = (await thread(agent, id)).sessions[0]?.sessionId;
    await switchTo(id, codex);
    await say(id, "She is three.");

    await switchTo(id, null);
    expect((await thread(agent, id)).brain).toBeNull();
    const reply = await say(id, "How old is she?");

    const resumed = asked["claude-code"][claudeSession] as PromptRequest;
    expect(resumed.sessionId).toBe(claudeId);
    expect(resumed.prompt).toBe("How old is she?");
    expect(resumed.briefing).toMatch(/^## Since your last reply/);
    // Only what came after its own reply, which it saw itself: Codex's turn.
    expect(resumed.briefing).toContain(
      "### Latest messages\n\n**User:**\n> She is three.\n\n**You, thinking with Codex · fake-coder:**",
    );
    expect(resumed.briefing).not.toContain("### Earlier, in summary");
    expect(reply.runtime).toBe("claude-code");

    await say(id, "Thanks.");
    expect(asked["claude-code"].at(-1)).toMatchObject({ prompt: "Thanks.", briefing: null, sessionId: claudeId });
  });

  // covers AG-002, RT-001
  it("[TC-CH-128] the picker changes only its thread; making it the hob's default edits the hob", async () => {
    start();
    const agent = await summon();
    const mine = await newThread(agent);
    const other = await newThread(agent);
    await switchTo(mine.id, codex);

    const unchanged = (await request("GET", "/api/agents")).body[0];
    expect(unchanged).toMatchObject({ runtime: "claude-code", model: "fake-thinker", configVersion: 1 });
    expect((await say(other.id, "hello")).runtime).toBe("claude-code");
    expect((await say(mine.id, "hello")).runtime).toBe("codex");

    const madeDefault = await switchTo(other.id, codex, true);
    expect(madeDefault.status).toBe(200);
    expect(madeDefault.body.brain).toBeNull();
    const edited = (await request("GET", "/api/agents")).body[0];
    expect(edited).toMatchObject({ runtime: "codex", model: "fake-coder", effort: null, configVersion: 2 });
    expect((await say(other.id, "again")).runtime).toBe("codex");
    expect((await say((await newThread(agent)).id, "hi")).runtime).toBe("codex");

    // Picking the hob's brain in a thread follows the hob again.
    expect((await switchTo(mine.id, codex)).body.brain).toBeNull();
  });

  // covers RT-001, EX-005
  it("[TC-CH-129] a switch away from a limited or unavailable Claude Code still works without asking it", async () => {
    start();
    const agent = await summon();
    const { id } = await newThread(agent);
    claudeWorks = true;
    const limited = await say(id, `${FAKE_DIRECTIVES.limit} write a poem about Miso`);
    claudeWorks = false;
    expect(limited.status).toBe("limited");
    const claudeTurns = asked["claude-code"].length;

    await switchTo(id, codex);
    // Continue is refused until the limited turn has fully ended.
    await vi.waitFor(async () =>
      expect((await request("POST", `/api/threads/${id}/messages/${limited.id}/continue`)).status).toBe(200),
    );
    const done = (await settled(id)).at(-1) as Message;
    expect(done).toMatchObject({ id: limited.id, status: "complete", runtime: "codex" });
    // Codex is told what the limited reply already did, so it does not do it again.
    const handoff = asked.codex[0]?.briefing ?? "";
    expect(handoff).toContain("write a poem about Miso");
    expect(handoff).toContain(
      "**You, thinking with Claude Code · fake-thinker:** [ended by the provider's usage limit]",
    );
    expect(handoff).toContain("Tools: Running pnpm publish (done)");
    expect(asked["claude-code"]).toHaveLength(claudeTurns);

    // Down altogether, Claude Code is not asked either once the thread has moved on.
    const other = await newThread(agent);
    await say(other.id, "hello");
    claudeDown = true;
    const before = asked["claude-code"].length;
    await switchTo(other.id, codex);
    expect((await say(other.id, "still there?")).status).toBe("complete");
    expect(asked["claude-code"]).toHaveLength(before);
  });

  // covers RT-001
  it("[TC-CH-130] refuses a brain the hub cannot run, or a model or effort its runtime does not offer", async () => {
    start({ codex: false });
    const agent = await summon();
    const { id } = await newThread(agent);
    const runtime = await switchTo(id, codex);
    expect(runtime).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "runtime" } });
    const model = await switchTo(id, { runtime: "claude-code", model: "nope", effort: null });
    expect(model).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "model" } });
    const effort = await switchTo(id, { runtime: "claude-code", model: "fake-quick", effort: "high" });
    expect(effort).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "effort" } });
    expect((await thread(agent, id)).brain).toBeNull();

    const health = (await request("GET", "/api/runtimes")).body;
    expect(health.map((h: { runtime: string; availability: string }) => [h.runtime, h.availability])).toEqual([
      ["claude-code", "ready"],
      ["codex", "unavailable"],
    ]);
    expect((await request("GET", "/api/runtimes/codex/models")).body.models).toEqual([]);

    await request("POST", `/api/agents/${agent.id}/retire`, { activeWork: "finish" });
    const retired = await switchTo(id, { runtime: "claude-code", model: "fake-quick", effort: null });
    expect(retired).toMatchObject({ status: 409, body: { _tag: "HobUnavailable" } });
  });
});
