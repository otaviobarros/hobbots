import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  Charms,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobProposals,
  HobService,
  PermissionSummary,
  type PromptRequest,
  QuestionService,
  RosterReceipts,
  RuntimeAdapter,
  type RuntimeAdapterShape,
  SecretRedaction,
  SummoningHub,
  TaskControls,
  TaskRepository,
} from "@hobbots/agents";
import { fakeCharm } from "@hobbots/agents/testing";
import type { HobPermissions, HobProposalView } from "@hobbots/api";
import {
  type Agent,
  isInProgress,
  type Message,
  type Question,
  roleFields,
  SUMMONING_DEFAULTS,
  type TaskTree,
  type Thread,
} from "@hobbots/domain";
import { Dispatcher } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ActivityRepositoryLive,
  ApprovalRepositoryLive,
  BackpackLive,
  CharmCallsLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  HobChangesLive,
  HobProposalLogLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeAdditionalRuntimesLayer, FakeRuntimeLayer } from "@hobbots/runtimes";
import { Deferred, Effect, Layer, ManagedRuntime, Option, Schedule, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DispatcherHostLive } from "../src/backpack.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "../src/continuations.ts";
import { DirectoryToolsLive } from "../src/directory.ts";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { SummoningCharm } from "../src/summoning.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// #412: hob management end to end (ADR 034), on a hub that runs the Summoning Charm beside the Task
// tools, questions, the roster of other hobs and the SQL Charm call records, as the hub composes
// them, with the real policy engine and the fake runtime, on SQLite or PostgreSQL (TestDatabase).
// The hobs are played from `fake:hub` lines: one without the Charm hands summoning work to one that
// holds it, a manager asks its lead, and Tasks move a summon's keyed call into their scope.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-hob-management-")));
const shared = join(temp, "shared");
const team = join(temp, "team");
const dataDir = join(temp, "data");
for (const folder of [shared, team, dataDir]) mkdirSync(folder, { recursive: true });

const requests: Array<PromptRequest> = [];

/** A prompt with this line of its own runs only once the test lets it go on: a reply left running. */
const HOLD = "fake:hold";
let gate = Deferred.makeUnsafe<void>();

/** What the hub answered each scripted call, in order, by the call's key or else its tool: what the hob read back. */
const answers: Array<readonly [string, string]> = [];
const answered = (key: string) => answers.filter(([each]) => each === key).map(([, text]) => text);

/** The request with its hub calls' answers added to `answers`. */
const answering = (request: PromptRequest): PromptRequest => {
  const hubTools = request.hubTools;
  if (!hubTools) return request;
  const call: typeof hubTools.call = (name, input, step) =>
    Effect.tap(hubTools.call(name, input, step), (answer) =>
      Effect.sync(() => {
        const key = (input as { readonly key?: unknown } | null)?.key;
        answers.push([typeof key === "string" ? key : name, answer.text]);
      }),
    );
  return { ...request, hubTools: { ...hubTools, call } };
};

const recorded = (fake: RuntimeAdapterShape): RuntimeAdapterShape => ({
  ...fake,
  sendPrompt: (sent) => {
    const request = answering(sent);
    requests.push(request);
    const stream = fake.sendPrompt(request);
    return request.prompt.split("\n").includes(HOLD) ? Stream.unwrap(Effect.as(Deferred.await(gate), stream)) : stream;
  },
});
const runtime = Layer.effect(RuntimeAdapter, Effect.map(RuntimeAdapter, recorded)).pipe(
  Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))),
);
const Database = Layer.mergeAll(
  HobbotsRepositoryLive,
  ApprovalRepositoryLive,
  GrantRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
  CharmCallsLive,
  ActivityRepositoryLive,
  BackpackLive,
  HobChangesLive,
  HobProposalLogLive,
  EventJournal.layer,
  SetupRepository.layer,
  SearchIndex.layer,
).pipe(Layer.provideMerge(TestDatabase));
const App = Layer.mergeAll(SummoningHub.bound, WakeOnArrival, TaskControls.layer)
  .pipe(Layer.provideMerge(HobLifecycle.layer))
  .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer)))
  .pipe(Layer.provideMerge(ChatService.layer))
  .pipe(Layer.provideMerge(ContinuationsLive))
  .pipe(
    Layer.provideMerge(
      StepRunnerLive().pipe(
        Layer.provideMerge(MemberContinuationsLive),
        Layer.provideMerge(TaskTools.layer("/")),
        Layer.provideMerge(TaskSignal.layer),
      ),
    ),
  )
  .pipe(Layer.provideMerge(Dispatcher.layer().pipe(Layer.provideMerge(DispatcherHostLive))))
  .pipe(Layer.provideMerge(Layer.mergeAll(ApprovalService.layer, QuestionService.layer)))
  .pipe(Layer.provideMerge(HobProposals.layer))
  .pipe(Layer.provideMerge(GrantService.layer))
  .pipe(Layer.provideMerge(HobToolsLive))
  .pipe(Layer.provideMerge(DirectoryToolsLive))
  .pipe(
    Layer.provideMerge(
      Charms.layer<SummoningHub>([
        fakeCharm({ id: "github", name: "GitHub" }),
        SummoningCharm.pipe(Effect.provide(PolicyEngine.node)),
      ]),
    ),
  )
  .pipe(Layer.provideMerge(CanonicalSharedFolders))
  .pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Database,
        EventBus.layer,
        HobAdmission.layer,
        SummoningHub.layer,
        RosterReceipts.layer,
        NodeFolderChecks,
        runtime,
        FakeAdditionalRuntimesLayer().pipe(Layer.provide(PolicyEngine.node)),
        Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
        SecretRedaction.layer([]),
      ),
    ),
  );
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let hobs: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;

beforeAll(async () => {
  hobs = ManagedRuntime.make(App);
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide(TestDevices),
      Layer.provide(Layer.succeedContext(await hobs.context())),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});

afterAll(async () => {
  await dispose();
  await hobs.dispose();
  rmSync(temp, { recursive: true, force: true });
});

const request = async <A>(method: string, path: string, body?: unknown): Promise<{ status: number; body: A }> => {
  const response = await handler(
    new Request(`http://localhost:4578${path}`, {
      method,
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

/** `read` once it gives a value, polled on the hub's state within a time limit (STD-TEST-009). */
const eventually = <A>(read: () => Promise<A | undefined>) =>
  Effect.runPromise(
    Effect.tryPromise(read).pipe(
      Effect.flatMap((value) => (value === undefined ? Effect.fail("waiting" as const) : Effect.succeed(value))),
      Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 2_000 }),
    ),
  );

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;
const draft = (name: string, fields: object = {}) => ({ name, role: "writer", ...fields });

const create = async (name: string, lookSeed: number) => {
  const created = await request<Agent>("POST", "/api/agents", {
    name,
    ...roleFields("writer"),
    lookSeed,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  expect(created.status).toBe(200);
  return created.body;
};

const permissions = async (hob: Agent, change: object) => {
  const changed = await request<HobPermissions>("PATCH", `/api/agents/${hob.id}/permissions`, change);
  expect(changed.status).toBe(200);
  return changed.body;
};

/** Grants `hob` the Summoning Charm in the team folder, its answers the defaults with `answers` over them. */
const manages = (hob: Agent, answers: Record<string, string> = {}) =>
  permissions(hob, {
    ownFolders: [team],
    charms: { granted: ["summoning"], overrides: { ...SUMMONING_DEFAULTS, ...answers } },
  });

const allHobs = async () => (await request<ReadonlyArray<Agent>>("GET", "/api/agents")).body;
const named = async (name: string) => (await allHobs()).find((agent) => agent.name === name);
const hobNamed = (name: string) => eventually(() => named(name));
/** The hob as stored, retired or not. */
const stored = (hob: Agent) =>
  hobs.runPromise(HobbotsRepository.use((repo) => repo.findAgent(hob.id)).pipe(Effect.map(Option.getOrThrow)));

const messages = async (thread: Thread) =>
  (await request<ReadonlyArray<Message>>("GET", `/api/threads/${thread.id}/messages`)).body;

/** Sends `lines` to `hob` in a new thread of its own. */
const send = async (hob: Agent, lines: ReadonlyArray<string>) => {
  const thread = (await request<Thread>("POST", `/api/agents/${hob.id}/threads`)).body;
  expect((await request("POST", `/api/threads/${thread.id}/messages`, { content: lines.join("\n") })).status).toBe(200);
  return thread;
};

/** The thread's reply once `ready` holds for it. */
const replyWhen = (thread: Thread, ready: (reply: Message) => boolean) =>
  eventually(async () => {
    const reply = (await messages(thread)).filter((message) => message.role === "assistant").at(-1);
    return reply !== undefined && ready(reply) ? reply : undefined;
  });

const ended = (thread: Thread) => replyWhen(thread, (reply) => !isInProgress(reply.status));

/** The request's Task tree once `ready` holds for it. */
const treeWhen = (thread: Thread, ready: (tree: TaskTree) => boolean) =>
  eventually(async () => {
    const [tree] = await hobs.runPromise(TaskRepository.use((tasks) => tasks.readThreadTrees(thread.id)));
    return tree !== undefined && ready(tree) ? tree : undefined;
  });

/** The proposal a manager's call waits on, once it does: from its step in `thread`, or in the Inbox. */
const proposalBy = (manager: Agent) =>
  eventually(async () => {
    const listed = await request<{ proposals: ReadonlyArray<HobProposalView> }>("GET", "/api/hob-proposals");
    return listed.body.proposals.find((each) => each.proposal.agentId === manager.id && each.proposal.state === "open");
  });

const onProposal = (proposal: HobProposalView, path: string, body: object = {}) =>
  request<HobProposalView>("POST", `/api/hob-proposals/${proposal.proposal.id}/${path}`, body);

/** A prompt the fake was sent that carries `marker`. */
const sentWith = (marker: string) => eventually(async () => requests.find((each) => each.prompt.includes(marker)));

/** Your answer to `question`, as the question card sends it. */
const answer = (question: Question, text: string) =>
  request<Question>("POST", `/api/questions/${question.id}/answer`, { answer: text });

let chief: Agent;
let plain: Agent;

describe("hob management, end to end", () => {
  beforeAll(async () => {
    await request("PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [shared] });
    chief = await create("Chief", 5001);
    plain = await create("Plain", 5002);
    await manages(chief, { "summoning.summon": "allow", "summoning.instructions": "allow" });
  });

  // covers ADR 034 (Finding who can summon), ADR 032 (The roster), #412
  it("[TC-AG-412-01] a hob without the Charm is told who holds it, hands the summon to that hob, and the hob is summoned for that Task", async () => {
    const thread = await send(plain, [
      "Hire Mo for the launch",
      hub("delegate_task", {
        key: "hire-mo",
        hob: "Chief",
        brief: [
          "Summon Mo, a writer for the launch",
          hub("summoning_summon", { key: "summon-mo", hobs: [draft("Mo")] }),
          hub("summoning_change", { key: "brief-mo", changes: [{ hob: "Mo", instructions: "Write short." }] }),
          hub("complete_task", { key: "mo-done", summary: "Summoned Mo" }),
        ].join("\n"),
      }),
    ]);

    // Plain's turn was told who holds the Charm, and to hand such work to it.
    const told = await sentWith("Hire Mo for the launch");

    expect(told.hubTools?.tools.map((tool) => tool.name) ?? []).not.toContain("summoning_summon");
    expect(told.briefing).toContain(
      '- "Chief": "Writer"; Claude Code, model default, effort default; Charms: Summoning',
    );
    expect(told.briefing).toContain("hand that work with delegate_task to a hob listed below with the Summoning Charm");

    const mo = await hobNamed("Mo");
    const tree = await treeWhen(thread, (each) => each.tasks.some((task) => task.ownerId === chief.id));
    const chiefTask = tree.tasks.find((task) => task.ownerId === chief.id);
    expect(mo).toMatchObject({ summonedBy: chief.id, summonedFor: chiefTask?.id, summonedUnattended: true });
    // On the Task it was handed, the manager changes the hob too, as a version that names its call there.
    const briefed = await eventually(async () =>
      (await named("Mo"))?.instructions === "Write short." ? true : undefined,
    );
    expect(briefed).toBe(true);
    expect(answered("brief-mo")[0]).toContain("Changed, from each hob's next turn:");
  });

  // covers ADR 034 (Finding who can summon: several hold it), OR-002, #412
  it("[TC-AG-412-02] when two hobs hold the Charm, a hob asks who should be responsible, you pick one, and that hob summons", async () => {
    const bram = await create("Bram", 5003);
    await manages(bram, { "summoning.summon": "allow" });
    const thread = await send(plain, [
      "Hire Nia",
      hub("start_quest", { key: "quest", goal: "Nia is on the team" }),
      hub("ask", {
        key: "who",
        question: "Chief and Bram can both summon hobs. Who should hire Nia?",
        options: [
          { label: "Chief", consequence: "Chief summons Nia." },
          { label: "Bram", consequence: "Bram summons Nia." },
        ],
      }),
      `fake:then ${hub("delegate_task", {
        key: "hire-nia",
        hob: "Bram",
        brief: [
          "Summon Nia",
          hub("summoning_summon", { key: "summon-nia", hobs: [draft("Nia")] }),
          hub("complete_task", { key: "nia-done", summary: "Summoned Nia" }),
        ].join("\n"),
      })}`,
    ]);
    const told = await sentWith("Hire Nia");
    expect(told.briefing).toContain("Bram");
    expect(told.briefing).toContain("first ask who should be responsible, with ask and those hobs as the choices");
    // Plain has no lead, so the question reaches you as a pick card with both hobs.
    const asked = await treeWhen(thread, (tree) => tree.questions.some((question) => question.recipientId === null));
    const question = asked.questions[0] as Question;
    expect(question.options.map((option) => option.label)).toEqual(["Chief", "Bram"]);
    const picked = await answer(question, "Bram");
    expect(picked.status).toBe(200);
    const nia = await hobNamed("Nia");
    expect(nia).toMatchObject({ summonedBy: bram.id, summonedUnattended: true });
    expect(await named("Chief")).toBeDefined();
  });

  // covers ADR 034 (The check tool finds the gaps first; Questions go through ask; Asking is a proposal), #412
  it("[TC-AG-412-03] a manager checks three drafts, asks its lead about the unclear one, and summons the three from one card after you edit one", async () => {
    const lead = await create("Lead", 5004);
    const brief = [
      "Hire Pia, Quinn and a third engineer",
      hub("summoning_check", { summon: [draft("Pia"), draft("Quinn"), { role: "writer" }] }),
      hub("ask", { key: "third", question: "What is the third engineer's name?" }),
      `fake:then ${hub("summoning_summon", {
        key: "hire-three",
        hobs: [draft("Pia"), draft("Quinn"), draft("Ravi")],
      })}`,
      `fake:then ${hub("complete_task", { key: "three-done", summary: "Hired three" })}`,
    ];
    await manages(chief, {});
    const thread = await send(lead, [
      "Have Chief hire three engineers",
      hub("delegate_task", { key: "hire", hob: "Chief", brief: brief.join("\n") }),
      hub("wait_for", { key: "wait", tasks: ["$hire.task_id"] }),
      `fake:then ${hub("answer", { key: "named", question_id: "$third.question_id", answer: "Ravi" })}`,
    ]);
    // The check names the gap and writes nothing; the question goes to the lead, never to you.
    const checked = await eventually(async () =>
      requests.find((each) => each.prompt.includes("was answered by hob") && each.prompt.includes("Ravi")),
    );
    expect(checked).toBeDefined();
    const heard = await treeWhen(thread, (tree) => tree.questions[0]?.state === "answered");
    expect(heard.questions[0]).toMatchObject({
      askerId: chief.id,
      chain: [],
      answeredBy: { _tag: "Lead", agentId: lead.id },
    });
    expect(answered("summoning_check")[0]).toContain("- A new hob: It needs a name.");
    expect(answered("summoning_check")[0]).toContain("Checked; nothing was changed.");
    expect(await named("Pia")).toBeUndefined();

    // One card for the three; you edit Quinn and allow every row.
    const card = await proposalBy(chief);
    expect(card.proposal.rows.map((row) => row.label)).toEqual(["Pia", "Quinn", "Ravi"]);
    const quinn = card.proposal.rows[1] as HobProposalView["proposal"]["rows"][number];
    const edited = await onProposal(card, `rows/${quinn.id}/allow`, {
      edited: { ...quinn.draft, name: "Quincy", good_at: "Release notes." },
    });
    expect(edited.status).toBe(200);
    const decided = await onProposal(card, "allow-all");
    expect(decided.status).toBe(200);
    expect(decided.body.proposal.state).toBe("settled");

    const chiefTask = heard.tasks.find((task) => task.ownerId === chief.id);
    const made = await eventually(async () => {
      const all = await allHobs();
      const three = all.filter((agent) => ["Pia", "Quincy", "Ravi"].includes(agent.name));
      return three.length === 3 ? three : undefined;
    });
    for (const agent of made) {
      // Each shows who summoned it, for the Task it was summoned for, and opens from its card.
      expect(agent).toMatchObject({ summonedBy: chief.id, summonedFor: chiefTask?.id, summonedUnattended: false });
      expect(decided.body.proposal.rows.map((row) => row.hobId)).toContain(agent.id);
    }
    expect(made.find((agent) => agent.name === "Quincy")).toMatchObject({ id: quinn.hobId, goodAt: "Release notes." });
    expect(decided.body.proposal.rows[1]?.outcome).toContain("Summoned Quincy (Writer)");
  });
  // covers ADR 034 (Never twice), ADR 031 (keyed calls), #660, #412
  it("[TC-AG-412-04] a summon retried after its call moved into the Task the reply started returns the same hob, and the same key from another manager summons its own", async () => {
    await manages(chief, { "summoning.summon": "allow" });
    const thread = await send(chief, [
      "Hire Uma",
      hub("summoning_summon", { key: "hire-uma", hobs: [draft("Uma")] }),
      hub("start_quest", { key: "quest", goal: "Uma is on the team" }),
      // The runtime sends the call again with the same key, now that the reply works on a Task.
      hub("summoning_summon", { key: "hire-uma", hobs: [draft("Uma")] }),
    ]);
    // The reply to your message, not a turn the started Quest wakes later.
    const reply = await eventually(async () => {
      const first = (await messages(thread)).find((message) => message.role === "assistant");
      return first !== undefined && !isInProgress(first.status) ? first : undefined;
    });
    const [, first, retried] = reply.content.split("summoning_summon: ");
    const id = /id ([0-9a-f-]{36})/.exec(first ?? "")?.[1];
    expect(id, reply.content).toBeDefined();
    expect(retried).toContain("You made this call before, so it was not sent again.");
    expect(retried).toContain(`id ${id}`);
    // The call's record moved into the Task's work with the reply's other calls.
    const [tree] = await hobs.runPromise(TaskRepository.use((tasks) => tasks.readThreadTrees(thread.id)));
    expect(tree?.tasks[0]?.ownerId).toBe(chief.id);

    const bram = (await named("Bram")) as Agent;
    const other = await send(bram, [hub("summoning_summon", { key: "hire-uma", hobs: [draft("Uma")] })]);
    const otherId = /id ([0-9a-f-]{36})/.exec((await ended(other)).content)?.[1];
    expect(otherId).toBeDefined();
    expect(otherId).not.toBe(id);
    const made = (await allHobs()).filter((agent) => agent.id === id || agent.id === otherId);
    expect(made.map((agent) => [agent.name, agent.summonedBy]).sort()).toEqual(
      [
        ["Uma", chief.id],
        ["Uma", bram.id],
      ].sort(),
    );
  });

  /** `name`, summoned by the chief without a card, with a reply of its own left running. */
  const busy = async (name: string) => {
    const thread = await send(chief, [hub("summoning_summon", { key: `hire-${name}`, hobs: [draft(name)] })]);
    await ended(thread);
    const made = (await named(name)) as Agent;
    gate = Deferred.makeUnsafe<void>();
    const running = await send(made, ["Draft the launch post", HOLD]);
    await replyWhen(running, (reply) => reply.status === "streaming");
    return { made, running };
  };

  /** The chief asks to retire `name`, with `replies` for its running replies, and waits on the card. */
  const retiring = async (name: string, replies: "finish" | "stop") => {
    const thread = await send(chief, [
      hub("summoning_retire", { key: `retire-${name}`, hob: name, running_replies: replies }),
    ]);
    return { thread, card: await proposalBy(chief) };
  };

  // covers ADR 034 (Retiring; Retire is high risk), AG-006, #412
  it("[TC-AG-412-05] retiring through the Charm asks once only with the check box, and its replies finish or stop as the manager chose", async () => {
    const rex = await busy("Rex");
    const finish = await retiring("Rex", "finish");
    expect(finish.card.proposal).toMatchObject({ kind: "retire", highRisk: true, asks: [] });
    expect(finish.card.proposal.rows[0]).toMatchObject({ label: "Rex", runningReplies: "finish" });
    // Never without the check box, and never "Always allow".
    expect((await onProposal(finish.card, "allow-all")).status).toBe(422);
    expect((await onProposal(finish.card, "always-allow", { operation: "summoning.retire" })).status).toBe(409);
    expect((await onProposal(finish.card, "allow-all", { confirmed: true })).status).toBe(200);
    expect((await ended(finish.thread)).content).toContain("Rex is retired now.");
    expect((await stored(rex.made)).status).toBe("retired");
    // Once only: the settled card is never decided again.
    expect((await onProposal(finish.card, "allow-all", { confirmed: true })).status).toBe(409);
    // Rex's reply was left to finish, and does once it can.
    expect((await messages(rex.running)).at(-1)?.status).toBe("streaming");
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    expect((await ended(rex.running)).status).toBe("complete");

    const sid = await busy("Sid");
    const stop = await retiring("Sid", "stop");
    expect(stop.card.proposal.rows[0]).toMatchObject({ label: "Sid", runningReplies: "stop" });
    expect((await onProposal(stop.card, "allow-all", { confirmed: true })).status).toBe(200);
    expect((await ended(stop.thread)).content).toContain("Sid is retired now.");
    // Sid's reply was stopped, without waiting for it to go on.
    expect((await ended(sid.running)).status).not.toBe("complete");
    expect((await stored(sid.made)).status).toBe("retired");
    await Effect.runPromise(Deferred.succeed(gate, undefined));
  });
});
