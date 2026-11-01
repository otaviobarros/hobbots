import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  checkBrain,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  HobTools,
  PermissionSummary,
  type PromptRequest,
  RuntimeAdapter,
} from "@hobbots/agents";
import {
  type Agent,
  type Message,
  RuntimeModel,
  RuntimeModels,
  roleFields,
  starterRole,
  toneLines,
} from "@hobbots/domain";
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
import { fakeInstructionsPrompt, makeFakeRuntime } from "@hobbots/runtimes";
import { Effect, Layer, Schedule, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";

const hob = {
  name: "Wren",
  ...roleFields("writer"),
  lookSeed: 2 ** 32 - 1,
  lookColor: "moss",
  runtime: "claude-code",
  model: "fake-thinker",
  effort: "high",
  instructions: "Write short answers.",
};

// What the runtime is told on every turn: who the hob is, then its instructions.
const told = (instructions: string, name = "Wren", role: "writer" | "qa" = "writer") =>
  `## About you\nYou are ${name}, a hob in Hobbots. Your role is ${starterRole(role).title}: ${starterRole(role).note.toLowerCase()}\n\n## Your instructions, from the user\n${instructions}`;

let prompts: Array<PromptRequest>;
// The runtime session each prompt's turn started or resumed, as the runtime reported it.
let sessions: Map<string, string>;
// Each turn waits for this before the runtime replies, so a test can act while a reply is running.
let replyGate: Promise<void>;
// While set, turns reach the runtime as they did before #164: never carrying the instructions.
let beforeFix: boolean;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeEach(() => {
  prompts = [];
  sessions = new Map();
  replyGate = Promise.resolve();
  beforeFix = false;
  const fake = makeFakeRuntime();
  const runtime = Layer.succeed(RuntimeAdapter, {
    ...fake,
    sendPrompt: (sent) => {
      prompts.push(sent);
      const request = beforeFix ? { ...sent, instructionsChanged: false } : sent;
      const gate = replyGate;
      return Stream.fromEffect(Effect.promise(() => gate)).pipe(
        Stream.drain,
        Stream.concat(
          fake
            .sendPrompt(request)
            .pipe(
              Stream.tap((event) =>
                Effect.sync(() => event._tag === "SessionStarted" && sessions.set(request.prompt, event.sessionId)),
              ),
            ),
        ),
      );
    },
  });
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
          runtime,
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
});

afterEach(() => dispose());

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

describe("creating hobs", () => {
  // covers AG-001
  it("[TC-AG-002] creates a hob that appears in the hob list and chats with its chosen model and effort", async () => {
    const created = await request("POST", "/api/agents", hob);
    expect(created.status).toBe(200);
    const agent: Agent = created.body;
    expect(agent).toMatchObject(hob);

    const list = await request("GET", "/api/agents");
    expect(list.body).toEqual([agent]);

    const thread = await request("POST", `/api/agents/${agent.id}/threads`);
    await request("POST", `/api/threads/${thread.body.id}/messages`, { content: "hello" });
    // The turn runs in the background; its request is recorded as soon as it starts.
    await Effect.runPromise(
      Effect.suspend(() => (prompts.length > 0 ? Effect.void : Effect.fail("waiting"))).pipe(
        Effect.retry(Schedule.spaced("5 millis")),
      ),
    );
    expect(prompts.map((p) => [p.model, p.effort, p.instructions])).toEqual([
      ["fake-thinker", "high", told("Write short answers.")],
    ]);
  });

  // covers AG-001, AG-004
  it("[TC-AG-050] a second hob with another model chats on its own threads, apart from the first", async () => {
    const first: Agent = (await request("POST", "/api/agents", hob)).body;
    const second: Agent = (
      await request("POST", "/api/agents", {
        ...hob,
        name: "Moss",
        model: "fake-quick",
        effort: null,
        instructions: "Tidy files.",
      })
    ).body;
    expect((await request("GET", "/api/agents")).body.map((a: Agent) => a.name).sort()).toEqual(["Moss", "Wren"]);

    const firstThread = (await request("POST", `/api/agents/${first.id}/threads`)).body;
    const secondThread = (await request("POST", `/api/agents/${second.id}/threads`)).body;
    await request("POST", `/api/threads/${firstThread.id}/messages`, { content: "hello Wren" });
    await request("POST", `/api/threads/${secondThread.id}/messages`, { content: "hello Moss" });
    await Effect.runPromise(
      Effect.suspend(() => (prompts.length > 1 ? Effect.void : Effect.fail("waiting"))).pipe(
        Effect.retry(Schedule.spaced("5 millis")),
      ),
    );

    // Each turn runs with its own hob's brain and instructions.
    expect(new Set(prompts.map((p) => JSON.stringify([p.model, p.effort, p.instructions])))).toEqual(
      new Set([
        JSON.stringify(["fake-thinker", "high", told("Write short answers.")]),
        JSON.stringify(["fake-quick", null, told("Tidy files.", "Moss")]),
      ]),
    );
    // Each hob sees only its own thread, and each thread only its own messages.
    expect((await request("GET", `/api/agents/${first.id}/threads`)).body.map((t: { id: string }) => t.id)).toEqual([
      firstThread.id,
    ]);
    expect((await request("GET", `/api/agents/${second.id}/threads`)).body.map((t: { id: string }) => t.id)).toEqual([
      secondThread.id,
    ]);
    const said = async (threadId: string) =>
      (await request("GET", `/api/threads/${threadId}/messages`)).body
        .filter((m: { role: string }) => m.role === "user")
        .map((m: { content: string }) => m.content);
    expect(await said(firstThread.id)).toEqual(["hello Wren"]);
    expect(await said(secondThread.id)).toEqual(["hello Moss"]);
  });

  // covers AG-001
  it("[TC-AG-003] rejects invalid input with a typed error and creates nothing", async () => {
    const blankName = await request("POST", "/api/agents", { ...hob, name: "  " });
    expect(blankName).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "name" } });

    const badColor = await request("POST", "/api/agents", { ...hob, lookColor: "plaid" });
    expect(badColor).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "lookColor" } });

    const bigSeed = await request("POST", "/api/agents", { ...hob, lookSeed: 2 ** 32 });
    expect(bigSeed).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "lookSeed" } });

    const unknownModel = await request("POST", "/api/agents", { ...hob, model: "gpt-9" });
    expect(unknownModel).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "model" } });

    const noEffort = await request("POST", "/api/agents", { ...hob, model: "fake-quick" });
    expect(noEffort).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "effort" } });

    expect((await request("GET", "/api/agents")).body).toEqual([]);
  });

  // covers AG-001
  it("[TC-AG-007] returns the hob created first when a create is retried with the same id", async () => {
    const id = crypto.randomUUID();
    const first = await request("POST", "/api/agents", { ...hob, id });
    expect(first).toMatchObject({ status: 200, body: { ...hob, id } });

    const retry = await request("POST", "/api/agents", { ...hob, id });
    expect(retry).toEqual(first);
    expect((await request("GET", "/api/agents")).body).toEqual([first.body]);
  });

  // covers AG-001
  it("[TC-AG-008] rejects a create that reuses an id for different choices or is not a UUID", async () => {
    const id = crypto.randomUUID();
    const first = await request("POST", "/api/agents", { ...hob, id });

    const other = await request("POST", "/api/agents", { ...hob, id, name: "Moss" });
    expect(other).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "id" } });

    const notUuid = await request("POST", "/api/agents", { ...hob, id: "wren" });
    expect(notUuid).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "id" } });

    expect((await request("GET", "/api/agents")).body).toEqual([first.body]);
  });

  // covers AG-001, AG-005
  it("[TC-AG-004] lists the models the runtime offers for the picker", async () => {
    const models = await request("GET", "/api/runtimes/claude-code/models");
    expect(models.status).toBe(200);
    expect(models.body.source).toBe("runtime");
    expect(models.body.models.map((m: RuntimeModel) => [m.id, m.efforts.length, m.main])).toEqual([
      ["fake-thinker", 5, true],
      ["fake-quick", 0, false],
    ]);
  });
});

const waitFor = (ready: () => Promise<boolean>) =>
  Effect.runPromise(
    Effect.tryPromise(ready).pipe(
      Effect.flatMap((done) => (done ? Effect.void : Effect.fail("waiting"))),
      Effect.retry(Schedule.spaced("5 millis")),
    ),
  );

describe("editing hobs", () => {
  // covers AG-002
  it("[TC-AG-022] runs a reply with the configuration it started with and the next reply with the edit", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    expect(agent.configVersion).toBe(1);
    const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
    const messages = async () => (await request("GET", `/api/threads/${thread.id}/messages`)).body as Array<Message>;
    const settled = () => waitFor(async () => (await messages()).every((m) => m.status !== "streaming"));

    let release = () => {};
    replyGate = new Promise((resolve) => {
      release = resolve;
    });
    await request("POST", `/api/threads/${thread.id}/messages`, { content: "first" });
    await waitFor(async () => prompts.length === 1);

    // The edit lands while the first reply is still running.
    const edited = await request("PATCH", `/api/agents/${agent.id}`, { instructions: "Write long answers." });
    expect(edited).toMatchObject({
      status: 200,
      body: { ...hob, id: agent.id, instructions: "Write long answers.", configVersion: 2 },
    });
    expect((await messages()).map((m) => m.status)).toEqual(["complete", "streaming"]);
    release();
    await settled();

    await request("POST", `/api/threads/${thread.id}/messages`, { content: "second" });
    // The second message may wait in the queue before its reply exists, so wait for it to start.
    await waitFor(async () => prompts.length === 2);
    await settled();

    expect(prompts.map((p) => p.instructions)).toEqual([told("Write short answers."), told("Write long answers.")]);
    expect((await messages()).map((m) => [m.role, m.content, m.configVersion])).toEqual([
      ["user", "first", null],
      ["assistant", "Echo: first", 1],
      ["user", "second", null],
      ["assistant", "Echo: second", 2],
    ]);
    // The resumed session follows the edit, which only the turn after it carried (#164).
    expect(prompts.map((p) => p.instructionsChanged)).toEqual([false, true]);
    await request("POST", `/api/threads/${thread.id}/messages`, { content: fakeInstructionsPrompt });
    await waitFor(async () => (await messages()).filter((m) => m.status === "complete").length === 6);
    expect((await messages()).findLast((m) => m.role === "assistant")?.content).toBe(told("Write long answers."));
    // Which instructions a session follows is not stored, so a thread that spans an edit keeps carrying them.
    expect(prompts.at(-1)?.instructionsChanged).toBe(true);
    expect((await request("GET", "/api/agents")).body).toEqual([edited.body]);
  });

  // covers AG-002
  it("[TC-AG-099] restores the earlier instructions after a stopped turn that may have delivered the edit", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
    const messages = async () => (await request("GET", `/api/threads/${thread.id}/messages`)).body as Array<Message>;
    const replies = async () => (await messages()).filter((m) => m.role === "assistant");
    const ask = async (content: string, count: number) => {
      await request("POST", `/api/threads/${thread.id}/messages`, { content });
      await waitFor(async () => (await replies()).filter((m) => m.status !== "streaming").length === count);
      return (await replies()).at(-1);
    };
    await ask("first", 1);

    // The edited turn reaches the runtime, which takes its instructions, and is stopped before it completes.
    await request("PATCH", `/api/agents/${agent.id}`, { instructions: "Write long answers." });
    replyGate = new Promise(() => {});
    await request("POST", `/api/threads/${thread.id}/messages`, { content: "second" });
    await waitFor(async () => prompts.length === 2);
    await request("POST", `/api/threads/${thread.id}/interrupt`);
    await waitFor(async () => (await replies()).at(-1)?.status === "stopped");
    expect(prompts.at(-1)?.instructionsChanged).toBe(true);

    // Restoring the first instructions reaches the session, though its last completed reply ran on them.
    replyGate = Promise.resolve();
    await request("PATCH", `/api/agents/${agent.id}`, { instructions: hob.instructions });
    expect((await ask(fakeInstructionsPrompt, 3))?.content).toBe(told("Write short answers."));
    expect(prompts.at(-1)?.instructionsChanged).toBe(true);
  });

  // covers AG-002
  it("[TC-AG-100] brings a thread edited before #164 back to its hob's current instructions", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
    const replies = async () =>
      ((await request("GET", `/api/threads/${thread.id}/messages`)).body as Array<Message>).filter(
        (m) => m.role === "assistant",
      );
    const ask = async (content: string, count: number) => {
      await request("POST", `/api/threads/${thread.id}/messages`, { content });
      await waitFor(async () => (await replies()).filter((m) => m.status === "complete").length === count);
      return (await replies()).at(-1)?.content;
    };

    // Before the fix, the edit was recorded on the reply but never reached the session.
    beforeFix = true;
    await ask("first", 1);
    await request("PATCH", `/api/agents/${agent.id}`, { instructions: "Write long answers." });
    expect(await ask(fakeInstructionsPrompt, 2)).toBe(told("Write short answers."));
    expect((await replies()).map((m) => m.configVersion)).toEqual([1, 2]);

    beforeFix = false;
    expect(await ask(fakeInstructionsPrompt, 3)).toBe(told("Write long answers."));
  });

  // covers AG-002
  it("[TC-AG-023] validates an edit, keeps the hob unchanged when it fails and adds no version for a no-op", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;

    const unknownModel = await request("PATCH", `/api/agents/${agent.id}`, { model: "gpt-9" });
    expect(unknownModel).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "model" } });
    // The effort is checked against the model the hob keeps.
    const noEffort = await request("PATCH", `/api/agents/${agent.id}`, { model: "fake-quick" });
    expect(noEffort).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "effort" } });
    const blankTitle = await request("PATCH", `/api/agents/${agent.id}`, { roleTitle: " " });
    expect(blankTitle).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "roleTitle" } });

    const missing = await request("PATCH", `/api/agents/${crypto.randomUUID()}`, { instructions: "" });
    expect(missing).toMatchObject({ status: 404, body: { _tag: "AgentNotFound" } });

    const same = await request("PATCH", `/api/agents/${agent.id}`, { instructions: hob.instructions });
    expect(same).toEqual({ status: 200, body: agent });

    const quick = await request("PATCH", `/api/agents/${agent.id}`, { model: "fake-quick", effort: null });
    expect(quick.body).toMatchObject({ model: "fake-quick", effort: null, configVersion: 2 });
    expect((await request("GET", "/api/agents")).body).toEqual([quick.body]);
  });

  // covers AG-001, AG-002
  it("[TC-AG-073] stores a role change as a new version, with a starter role's own title or a custom title and borrowed sigil", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    expect(agent).toMatchObject({
      role: "writer",
      roleTitle: "Writer",
      sigil: "writer",
      hat: "pointed",
      tool: "quill",
    });

    // A starter role brings its title; its hat and tool are the user's to change.
    const qa = await request("PATCH", `/api/agents/${agent.id}`, {
      role: "qa",
      sigil: "qa",
      hat: "horned",
      tool: null,
    });
    expect(qa.body).toMatchObject({ role: "qa", roleTitle: "QA engineer", sigil: "qa", hat: "horned", tool: null });
    expect(qa.body.configVersion).toBe(2);

    const custom = await request("PATCH", `/api/agents/${agent.id}`, {
      role: null,
      roleTitle: "Gardener",
      sigil: "chef",
    });
    expect(custom.body).toMatchObject({ role: null, roleTitle: "Gardener", sigil: "chef", configVersion: 3 });

    const renamed = await request("PATCH", `/api/agents/${agent.id}`, { role: "ceo", roleTitle: "Big boss" });
    expect(renamed).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "roleTitle" } });
    const unknown = await request("PATCH", `/api/agents/${agent.id}`, { role: "doctor" });
    expect(unknown).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "role" } });
    const borrowed = await request("POST", "/api/agents", { ...hob, role: null, roleTitle: "Bard", sigil: "fiction" });
    expect(borrowed.body).toMatchObject({ role: null, roleTitle: "Bard", sigil: "fiction" });
    const mismatched = await request("POST", "/api/agents", { ...hob, roleTitle: "Poet" });
    expect(mismatched).toMatchObject({ status: 400, body: { _tag: "InvalidHob", field: "roleTitle" } });

    expect((await request("GET", "/api/agents")).body).toEqual([custom.body, borrowed.body]);
  });

  // covers AG-002
  it("[TC-AG-083] tells the runtime the hob's current role on the next turn, ahead of its instructions", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
    const messages = async () => (await request("GET", `/api/threads/${thread.id}/messages`)).body as Array<Message>;
    const send = async (content: string, count: number) => {
      await request("POST", `/api/threads/${thread.id}/messages`, { content });
      await waitFor(async () => (await messages()).filter((m) => m.status === "complete").length === count);
    };

    await send("first", 2);
    await request("PATCH", `/api/agents/${agent.id}`, { role: "qa", sigil: "qa" });
    await send("second", 4);
    await request("PATCH", `/api/agents/${agent.id}`, { role: null, roleTitle: "Gardener", instructions: "" });
    await send("third", 6);

    expect(prompts.map((p) => p.instructions)).toEqual([
      told("Write short answers."),
      told("Write short answers.", "Wren", "qa"),
      "## About you\nYou are Wren, a hob in Hobbots. Your role is Gardener.",
    ]);
  });

  // covers AG-002
  it("[TC-AG-087] starts a hob at Default and Balanced, and tells the runtime a tone saved as a new version", async () => {
    const agent: Agent = (await request("POST", "/api/agents", hob)).body;
    expect([agent.voice, agent.length]).toEqual(["default", "balanced"]);
    const thread = (await request("POST", `/api/agents/${agent.id}/threads`)).body;
    const messages = async () => (await request("GET", `/api/threads/${thread.id}/messages`)).body as Array<Message>;
    const send = async (content: string, count: number) => {
      await request("POST", `/api/threads/${thread.id}/messages`, { content });
      await waitFor(async () => (await messages()).filter((m) => m.status === "complete").length === count);
    };

    await send("first", 2);
    const edited = await request("PATCH", `/api/agents/${agent.id}`, { voice: "pirate", length: "brief" });
    expect([edited.body.voice, edited.body.length, edited.body.configVersion]).toEqual(["pirate", "brief", 2]);
    await send("second", 4);
    const invalid = await request("PATCH", `/api/agents/${agent.id}`, { voice: "cynical" });
    expect(invalid.status).toBe(400);

    const tone = toneLines("pirate", "brief").join("\n");
    expect(prompts.map((p) => p.instructions)).toEqual([
      told("Write short answers."),
      told("Write short answers.").replace("\n\n## Your", `\n\n## How you talk\n${tone}\n\n## Your`),
    ]);
  });
});

describe("several hobs at once", () => {
  // covers AG-001, AG-002, AG-006
  it("[TC-AG-097] three hobs with different models chat at once, an edit mid-reply reaches only the next reply, and a retired hob refuses messages but stays readable", async () => {
    const create = async (fields: Record<string, unknown>) =>
      (await request("POST", "/api/agents", { ...hob, ...fields })).body as Agent;
    const wren = await create({});
    const moss = await create({ name: "Moss", model: "fake-quick", effort: null, instructions: "Tidy files." });
    // A hob with no model chats on the runtime's default.
    const ash = await create({
      name: "Ash",
      ...roleFields("qa"),
      model: null,
      effort: null,
      instructions: "Find bugs.",
    });
    const threadOf = async (agent: Agent) =>
      (await request("POST", `/api/agents/${agent.id}/threads`)).body.id as string;
    const threads = { wren: await threadOf(wren), moss: await threadOf(moss), ash: await threadOf(ash) };
    const messages = async (threadId: string) =>
      (await request("GET", `/api/threads/${threadId}/messages`)).body as Array<Message>;
    const settled = () =>
      waitFor(async () => {
        for (const id of Object.values(threads)) {
          if ((await messages(id)).some((m) => m.status !== "complete")) return false;
        }
        return true;
      });

    // All three replies are running at the same time.
    let release = () => {};
    replyGate = new Promise((resolve) => {
      release = resolve;
    });
    await request("POST", `/api/threads/${threads.wren}/messages`, { content: "first for Wren" });
    await request("POST", `/api/threads/${threads.moss}/messages`, { content: "first for Moss" });
    await request("POST", `/api/threads/${threads.ash}/messages`, { content: "first for Ash" });
    await waitFor(async () => prompts.length === 3);

    // Editing Wren while its reply runs makes a new version of Wren only.
    const edited = await request("PATCH", `/api/agents/${wren.id}`, { instructions: "Write long answers." });
    expect(edited.body).toMatchObject({ id: wren.id, configVersion: 2 });
    for (const id of Object.values(threads)) {
      expect((await messages(id)).map((m) => m.status)).toEqual(["complete", "streaming"]);
    }
    release();
    await settled();

    await request("POST", `/api/threads/${threads.wren}/messages`, { content: "second for Wren" });
    await request("POST", `/api/threads/${threads.moss}/messages`, { content: "second for Moss" });
    await settled();

    // Each turn ran with its own hob's model, effort and instructions; only Wren's next turn took the edit.
    const byPrompt = new Map(prompts.map((p) => [p.prompt, p]));
    expect(
      ["first for Wren", "first for Moss", "first for Ash", "second for Wren", "second for Moss"].map((prompt) => {
        const p = byPrompt.get(prompt);
        return [prompt, p?.model, p?.effort, p?.instructions];
      }),
    ).toEqual([
      ["first for Wren", "fake-thinker", "high", told("Write short answers.")],
      ["first for Moss", "fake-quick", null, told("Tidy files.", "Moss")],
      ["first for Ash", null, null, told("Find bugs.", "Ash", "qa")],
      ["second for Wren", "fake-thinker", "high", told("Write long answers.")],
      ["second for Moss", "fake-quick", null, told("Tidy files.", "Moss")],
    ]);
    // Each first turn starts its own runtime session, and each second turn resumes its own thread's.
    const resumed = (prompt: string) => byPrompt.get(prompt)?.sessionId;
    expect([resumed("first for Wren"), resumed("first for Moss"), resumed("first for Ash")]).toEqual([
      null,
      null,
      null,
    ]);
    const started = ["first for Wren", "first for Moss", "first for Ash"].map((prompt) => sessions.get(prompt));
    expect(new Set(started).size).toBe(3);
    expect(started).toEqual([expect.any(String), expect.any(String), expect.any(String)]);
    expect([resumed("second for Wren"), resumed("second for Moss")]).toEqual([started[0], started[1]]);

    // Each thread holds only its own hob's messages, marked with the version that wrote each reply.
    const transcript = async (threadId: string) =>
      (await messages(threadId)).map((m) => [m.content, m.configVersion] as const);
    expect(await transcript(threads.wren)).toEqual([
      ["first for Wren", null],
      ["Echo: first for Wren", 1],
      ["second for Wren", null],
      ["Echo: second for Wren", 2],
    ]);
    expect(await transcript(threads.moss)).toEqual([
      ["first for Moss", null],
      ["Echo: first for Moss", 1],
      ["second for Moss", null],
      ["Echo: second for Moss", 1],
    ]);
    expect(await transcript(threads.ash)).toEqual([
      ["first for Ash", null],
      ["Echo: first for Ash", 1],
    ]);

    // Wren's resumed session follows the edit and Moss's keeps its own instructions (#164).
    await request("POST", `/api/threads/${threads.wren}/messages`, { content: fakeInstructionsPrompt });
    await request("POST", `/api/threads/${threads.moss}/messages`, { content: fakeInstructionsPrompt });
    await waitFor(
      async () => (await messages(threads.wren)).length === 6 && (await messages(threads.moss)).length === 6,
    );
    await settled();
    expect((await messages(threads.wren)).findLast((m) => m.role === "assistant")?.content).toBe(
      told("Write long answers."),
    );
    expect((await messages(threads.moss)).findLast((m) => m.role === "assistant")?.content).toBe(
      told("Tidy files.", "Moss"),
    );

    // Retiring Ash refuses its new work and keeps its chat; the other hobs carry on.
    expect((await request("POST", `/api/agents/${ash.id}/retire`, { activeWork: "finish" })).status).toBe(200);
    expect(await request("POST", `/api/threads/${threads.ash}/messages`, { content: "again" })).toMatchObject({
      status: 409,
      body: { _tag: "HobUnavailable", status: "retired" },
    });
    expect(await transcript(threads.ash)).toEqual([
      ["first for Ash", null],
      ["Echo: first for Ash", 1],
    ]);
    expect((await request("GET", `/api/agents/${ash.id}/threads`)).body).toMatchObject([{ id: threads.ash }]);
    expect((await request("GET", "/api/agents?status=retired")).body).toMatchObject([{ id: ash.id }]);
    expect((await request("GET", "/api/agents")).body.map((a: Agent) => [a.name, a.configVersion]).sort()).toEqual([
      ["Moss", 1],
      ["Wren", 2],
    ]);
    expect((await request("POST", `/api/threads/${threads.moss}/messages`, { content: "third for Moss" })).status).toBe(
      200,
    );
    await settled();
    expect((await transcript(threads.moss)).at(-1)).toEqual(["Echo: third for Moss", 1]);
  });
});

describe("checking a hob's brain", () => {
  const offered = new RuntimeModels({
    runtime: "claude-code",
    source: "runtime",
    models: [
      new RuntimeModel({
        id: "default",
        displayName: "Default",
        description: "",
        efforts: ["low", "high"],
        main: true,
      }),
      new RuntimeModel({ id: "old", displayName: "Old", description: "", efforts: [], main: false }),
    ],
  });

  it("accepts the runtime's defaults and any offered pair", () => {
    expect(checkBrain(offered, { model: null, effort: null })).toBeUndefined();
    expect(checkBrain(offered, { model: "default", effort: "high" })).toBeUndefined();
    expect(checkBrain(offered, { model: "old", effort: null })).toBeUndefined();
  });

  it("checks a default model's effort against the runtime's default entry", () => {
    expect(checkBrain(offered, { model: null, effort: "max" })?.field).toBe("effort");
    expect(checkBrain(offered, { model: null, effort: "low" })).toBeUndefined();
  });

  it("names the field the runtime does not offer", () => {
    expect(checkBrain(offered, { model: "missing", effort: null })?.field).toBe("model");
    expect(checkBrain(offered, { model: "old", effort: "low" })?.message).toBe("Old takes no effort setting");
  });
});
