import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  CharmDeclarations,
  Charms,
  type CharmTurn,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  joinHubTools,
  makeRedactor,
  PermissionSummary,
  type PromptRequest,
  RuntimeAdapter,
  type RuntimeAdapterShape,
  SecretRedaction,
  SummoningHub,
} from "@hobbots/agents";
import { fakeCharm, memoryCharmCalls } from "@hobbots/agents/testing";
import type { HobPermissions } from "@hobbots/api";
import {
  type Agent,
  type AgentConfiguration,
  type ApprovalRequest,
  declaredOperations,
  isInProgress,
  type Message,
  roleFields,
  SUMMONING_DEFAULTS,
  SUMMONING_SELF_DEFAULTS,
  type Thread,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ActivityRepositoryLive,
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeAdditionalRuntimesLayer, FakeRuntimeLayer } from "@hobbots/runtimes";
import { hubCallRuntimes } from "@hobbots/runtimes/testing";
import { Effect, Exit, Layer, ManagedRuntime, Option, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectoryToolsLive } from "../src/directory.ts";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { SummoningCharm } from "../src/summoning.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// #406 at hub level: the Summoning Charm's tools on the hub action pipeline (ADR 031, ADR 034), with
// the hub's own composition, the real policy engine, the fake runtime and a fake GitHub Charm, on
// SQLite or PostgreSQL (TestDatabase). Claude Code and Codex are offered the same tools through the
// hub tools every adapter serves, so nothing here is the fake runtime's own.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-summoning-e2e-")));
const shared = join(temp, "shared");
const team = join(temp, "team");
const elsewhere = join(temp, "elsewhere");
const dataDir = join(temp, "data");
for (const folder of [shared, join(team, "web"), elsewhere, dataDir]) mkdirSync(folder, { recursive: true });

const requests: Array<PromptRequest> = [];

const expectedRuntimes = [
  "fake",
  ...(process.env.HOBBOTS_CLAUDE_CODE === undefined ? [] : ["claude-code"]),
  ...(process.env.HOBBOTS_CODEX === undefined ? [] : ["codex"]),
];

const recorded = (fake: RuntimeAdapterShape): RuntimeAdapterShape => ({
  ...fake,
  sendPrompt: (request) => {
    requests.push(request);
    return fake.sendPrompt(request);
  },
});
const runtime = Layer.effect(RuntimeAdapter, Effect.map(RuntimeAdapter, recorded)).pipe(
  Layer.provide(FakeRuntimeLayer()),
  Layer.provide(PolicyEngine.node),
);
const Database = Layer.mergeAll(
  HobbotsRepositoryLive,
  ApprovalRepositoryLive,
  GrantRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
  ActivityRepositoryLive,
  BackpackLive,
  EventJournal.layer,
  SetupRepository.layer,
  SearchIndex.layer,
).pipe(Layer.provideMerge(TestDatabase));
const App = SummoningHub.bound
  .pipe(Layer.provideMerge(HobLifecycle.layer))
  .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer)))
  .pipe(Layer.provideMerge(ChatService.layer))
  .pipe(Layer.provideMerge(ApprovalService.layer))
  .pipe(Layer.provideMerge(GrantService.layer))
  .pipe(Layer.provideMerge(HobToolsLive))
  .pipe(Layer.provideMerge(DirectoryToolsLive))
  .pipe(
    Layer.provideMerge(
      Charms.layer<SummoningHub>([
        fakeCharm({ id: "github", name: "GitHub" }),
        SummoningCharm.pipe(Effect.provide(PolicyEngine.node)),
      ]).pipe(Layer.provide(memoryCharmCalls())),
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

const eventually = <A>(read: () => Promise<A | undefined>) =>
  Effect.runPromise(
    Effect.tryPromise(read).pipe(
      Effect.flatMap((value) => (value === undefined ? Effect.fail("waiting" as const) : Effect.succeed(value))),
      Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 2_000 }),
    ),
  );

const messages = async (thread: Thread) =>
  (await request<ReadonlyArray<Message>>("GET", `/api/threads/${thread.id}/messages`)).body;

const approvalsOf = async (thread: Thread) =>
  (await request<ReadonlyArray<ApprovalRequest>>("GET", `/api/threads/${thread.id}/approvals`)).body;

const settled = (thread: Thread) =>
  eventually(async () => {
    const reply = (await messages(thread)).at(-1);
    return reply?.role === "assistant" && !isInProgress(reply.status) ? reply : undefined;
  });

const hub = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/** The hob makes the scripted calls in a new thread: the request it waits on, or its finished reply. */
const turn = async (hob: Agent, ...calls: Array<string>) => {
  const thread = (await request<Thread>("POST", `/api/agents/${hob.id}/threads`)).body;
  const asked = requests.length;
  expect(
    (await request("POST", `/api/threads/${thread.id}/messages`, { content: ["Go", ...calls].join("\n") })).status,
  ).toBe(200);
  return eventually(async () => {
    const pending = (await approvalsOf(thread)).find((approval) => approval.state === "pending");
    if (pending) return { thread, pending, reply: undefined, sent: requests[asked] };
    const reply = (await messages(thread)).at(-1);
    return reply?.role === "assistant" && !isInProgress(reply.status)
      ? { thread, pending: undefined, reply, sent: requests[asked] }
      : undefined;
  });
};

/** Decides the request a turn waits on, and waits for the reply to end or ask again. */
const decide = async (
  asked: { readonly thread: Thread; readonly pending?: ApprovalRequest | undefined },
  decision: "approve" | "deny",
) => {
  const pending = asked.pending as ApprovalRequest;
  expect(pending).toBeDefined();
  const decided = await request<ApprovalRequest>("POST", `/api/approvals/${pending.id}/decision`, {
    decision,
    actionDigest: pending.actionDigest,
    ...(pending.onceOnly && decision === "approve" ? { confirmed: true } : {}),
  });
  expect(decided.status).toBe(200);
  return settled(asked.thread);
};

const create = async (name: string, lookSeed: number) => {
  const created = await request<Agent>("POST", "/api/agents", {
    name,
    ...roleFields("writer"),
    lookSeed,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: `${name}'s instructions.`,
  });
  expect(created.status).toBe(200);
  return created.body;
};

const permissions = async (hob: Agent, change: object) => {
  const changed = await request<HobPermissions>("PATCH", `/api/agents/${hob.id}/permissions`, change);
  expect(changed.status).toBe(200);
  return changed.body;
};

const hob = (id: string) =>
  hobs.runPromise(
    HobbotsRepository.use((repo) => repo.findAgent(id as Agent["id"])).pipe(Effect.map(Option.getOrThrow)),
  );
const allHobs = async () => (await request<ReadonlyArray<Agent>>("GET", "/api/agents")).body;
const versions = (id: string) =>
  hobs.runPromise(
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const agent = Option.getOrThrow(yield* repo.findAgent(id as Agent["id"]));
      const all: Array<AgentConfiguration> = [];
      for (let version = 1; version <= agent.configVersion; version++) {
        all.push(Option.getOrThrow(yield* repo.findAgentConfig(agent.id, version)));
      }
      return all;
    }),
  );

const draft = (name: string, fields: object = {}) => ({ name, role: "writer", ...fields });

let chief: Agent;
let other: Agent;

/** The chief's Summoning answers, with `answers` over the defaults granting wrote. */
const chiefAnswers = (answers: Record<string, string>) =>
  permissions(chief, {
    charms: { granted: ["github", "summoning"], overrides: { ...SUMMONING_DEFAULTS, ...answers } },
  });

describe("the Summoning Charm, end to end", () => {
  beforeAll(async () => {
    await request("PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [shared] });
    chief = await create("Chief", 4001);
    other = await create("Other", 4002);
    await permissions(chief, { ownFolders: [team] });
    // Other can do more than the chief: its own folder is outside the chief's.
    await permissions(other, { ownFolders: [elsewhere] });
  });

  // covers ADR 034 (Field answers), #406 (granting writes the defaults)
  it("[TC-AG-406-01] granting the Charm writes the default answers as overrides, and its tools reach the hob's turn", async () => {
    const granted = await permissions(chief, { charms: { granted: ["github", "summoning"] } });
    expect(granted.policy.charms?.overrides).toMatchObject(SUMMONING_DEFAULTS);
    expect(granted.decisions["summoning.summon"]).toBe("ask");
    expect(granted.decisions["summoning.name"]).toBe("allow");
    expect(granted.presets["summoning.instructions"]).toBe("allow");
    const { sent } = await turn(chief);
    const tools = sent?.hubTools?.tools.map((tool) => tool.name) ?? [];
    for (const name of ["check", "summon", "change", "pause", "wake", "retire"]) {
      expect(tools).toContain(`summoning_${name}`);
    }
    expect(tools.find((name) => name === "summoning_summon")).toBeDefined();
    const summon = sent?.hubTools?.tools.find((tool) => tool.name === "summoning_summon");
    expect(JSON.stringify(summon?.inputSchema)).toContain('"key"');
    // A hob without the Charm is offered none of its tools.
    const plain = await turn(other);
    expect(plain.sent?.hubTools?.tools.map((tool) => tool.name) ?? []).not.toContain("summoning_summon");
  });

  // covers ADR 034 (The check tool finds the gaps first), #406 done when 4
  it("[TC-AG-406-02] the check tool names what each draft lacks or gets wrong, and which fields would ask, and writes nothing", async () => {
    const before = (await allHobs()).length;
    const { reply } = await turn(
      chief,
      hub("summoning_check", {
        summon: [
          { role_title: "Engineer" },
          { name: "Nameless role" },
          draft("Bad brain", { runtime: "claude-code", model: "no-such-model" }),
          draft("Too wide", {
            own_folders: [elsewhere],
            charms: ["other-charm"],
            answers: { "run-commands": "allow" },
          }),
          draft("Fine", { own_folders: [join(team, "web")] }),
        ],
        change: [
          { hob: "Other", instructions: "Be terse." },
          { hob: "Nobody", name: "X" },
        ],
      }),
    );
    const text = reply?.content ?? "";
    expect(text).toContain("Checked; nothing was changed.");
    expect(text).toContain("- A new hob: It needs a name.");
    expect(text).toContain("- Nameless role: It needs a role");
    expect(text).toContain('does not offer the model "no-such-model"');
    expect(text).toContain(`authority-wider: folders, since ${elsewhere}`);
    expect(text).toContain("authority-wider: charms, since you do not hold the other-charm Charm");
    expect(text).toContain("- Fine: ready. It would ask the user about summoning new hobs");
    expect(text).toContain("- Other: outside-scope: Other is outside your Summoning scope.");
    expect(text).toContain("- Nobody: unknown-hob: There is no hob named Nobody.");
    expect((await allHobs()).length).toBe(before);
  });

  let summoned: ReadonlyArray<Agent> = [];

  // covers ADR 034 (Never twice, A summon is decided on summoning.summon, No escalation), #406 done when 3
  it("[TC-AG-406-03] a summon of three hobs under Allow creates them within the chief's authority, and a retry returns the same three", async () => {
    await chiefAnswers({ "summoning.summon": "allow" });
    const call = hub("summoning_summon", {
      key: "hire-three",
      hobs: [
        draft("Ada", { own_folders: [join(team, "web")], charms: ["github"] }),
        draft("Bo", { answers: { "edit-files": "ask" } }),
        draft("Cy", { role: null, role_title: "Release captain" }),
      ],
    });
    // The runtime retries the call with the same key in the same reply, then reuses the key for other drafts.
    const first = await turn(chief, call, call, hub("summoning_summon", { key: "hire-three", hobs: [draft("Dee")] }));
    expect(first.pending).toBeUndefined();
    const text = first.reply?.content ?? "";
    expect(text).toContain("Summoned 3 hobs:");
    summoned = (await allHobs()).filter((agent) => ["Ada", "Bo", "Cy"].includes(agent.name));
    expect(summoned).toHaveLength(3);
    const [, , retried, reused] = text.split("summoning_summon: ");
    expect(retried).toContain("You made this call before, so it was not sent again.");
    expect(reused).toContain("You already used the key hire-three for another call.");
    expect((await allHobs()).some((agent) => agent.name === "Dee")).toBe(false);
    for (const agent of summoned) {
      expect(text).toContain(`id ${agent.id}: open it at /hobs/${agent.id}`);
      expect(retried).toContain(agent.id);
      expect(agent).toMatchObject({ summonedBy: chief.id, summonedUnattended: true });
      const [version] = await versions(agent.id);
      expect(version?.actor).toMatchObject({ _tag: "Hob", hobId: chief.id, call: { key: "hire-three" } });
      // Never wider than the chief: in the sandbox, signing nothing, holding only what it was given.
      expect(agent.policy.signCommits).toBeUndefined();
      expect(agent.policy.charms?.granted ?? []).not.toContain("summoning");
    }
    const ada = summoned.find((agent) => agent.name === "Ada") as Agent;
    const bo = summoned.find((agent) => agent.name === "Bo") as Agent;
    const cy = summoned.find((agent) => agent.name === "Cy") as Agent;
    expect(ada.policy.ownFolders).toEqual([join(team, "web")]);
    expect(ada.policy.charms?.granted).toEqual(["github"]);
    expect(bo.policy.overrides["edit-files"]).toBe("ask");
    expect(bo.policy.charms?.granted).toEqual([]);
    expect(cy).toMatchObject({ role: null, roleTitle: "Release captain" });

    // The same key in another reply is another call (ADR 031): it summons hobs of its own.
    const other = await turn(chief, hub("summoning_summon", { key: "hire-three", hobs: [draft("Fay")] }));
    expect(other.reply?.content).toContain("Summoned 1 hob:");
  });

  // covers ADR 034 (Asking), #406 (Ask)
  it("[TC-AG-406-04] under the default Ask a summon asks the user once only, and is created as summoned with a card", async () => {
    await chiefAnswers({});
    const asked = await turn(chief, hub("summoning_summon", { key: "hire-dee", hobs: [draft("Dee")] }));
    expect(asked.pending).toMatchObject({ tool: "summoning_summon", operation: "summoning.summon", grantable: false });
    const reply = await decide(asked, "approve");
    expect(reply.content).toContain("Summoned 1 hob:");
    const dee = (await allHobs()).find((agent) => agent.name === "Dee") as Agent;
    expect(dee).toMatchObject({ summonedBy: chief.id, summonedUnattended: false });

    const denied = await turn(chief, hub("summoning_summon", { key: "hire-eve", hobs: [draft("Eve")] }));
    await decide(denied, "deny");
    expect((await allHobs()).some((agent) => agent.name === "Eve")).toBe(false);
  });

  // covers ADR 034 (Scope, Field answers, No escalation), #406 done when 1
  it("[TC-AG-406-05] changes within the scope and fields apply, and an out-of-scope, Never or wider call is refused with nothing written", async () => {
    await chiefAnswers({ "summoning.good-at": "allow", "summoning.voice": "deny" });
    const ada = summoned.find((agent) => agent.name === "Ada") as Agent;
    const bo = summoned.find((agent) => agent.name === "Bo") as Agent;
    const changed = await turn(
      chief,
      hub("summoning_change", {
        key: "rename",
        changes: [
          { hob: "Ada", name: "Ada Lovelace", good_at: "Front-end pages." },
          { hob: bo.id, look_color: "sky" },
        ],
      }),
    );
    expect(changed.pending).toBeUndefined();
    expect(changed.reply?.content).toContain("- Ada: changed name, good-at.");
    expect(await hob(ada.id)).toMatchObject({
      name: "Ada Lovelace",
      goodAt: "Front-end pages.",
      lookColor: ada.lookColor,
    });
    expect((await hob(bo.id)).lookColor).toBe("sky");
    expect((await versions(ada.id)).at(-1)?.actor).toMatchObject({ _tag: "Hob", hobId: chief.id });

    const refusals = [
      [{ hob: "Other", name: "Renamed" }, "outside-scope: Other is outside your Summoning scope."],
      [{ hob: bo.id, voice: "pirate" }, "a hob's voice is at Never for you."],
      [{ hob: bo.id, own_folders: [elsewhere] }, "authority-wider: folders"],
      [{ hob: bo.id, charms: ["summoning"] }, "Only the user grants the Summoning Charm."],
      [{ hob: bo.id, answers: { "summoning.summon": "allow" } }, "Only the user sets the Summoning Charm's answers."],
      [{ hob: bo.id, answers: { "use-web": "allow", push: "allow" } }, "authority-wider: answers, since push"],
    ] as const;
    for (const [change, reason] of refusals) {
      const before = await hob(bo.id);
      const { reply, pending } = await turn(
        chief,
        hub("summoning_change", { key: crypto.randomUUID(), changes: [change] }),
      );
      expect(pending).toBeUndefined();
      expect(reply?.content).toContain("No hob was changed.");
      expect(reply?.content).toContain(reason);
      expect((await hob(bo.id)).configVersion).toBe(before.configVersion);
    }
    expect((await hob(other.id)).name).toBe("Other");

    const wider = await turn(
      chief,
      hub("summoning_summon", { key: "too-wide", hobs: [draft("Wide", { own_folders: [elsewhere] })] }),
    );
    expect(wider.reply?.content).toContain("No hob was summoned.");
    expect((await allHobs()).some((agent) => agent.name === "Wide")).toBe(false);
  });

  // covers ADR 034 (The confused deputy)
  it("[TC-AG-406-06] a change to a hob wider than the chief asks on every field, whatever its answers say", async () => {
    await chiefAnswers({ "summoning.name": "allow" });
    // You put Other in the chief's scope: it can still do more than the chief.
    await permissions(chief, { charms: { summoning: { summoned: true, hobs: [other.id], self: false } } });
    const asked = await turn(
      chief,
      hub("summoning_change", { key: "rename-other", changes: [{ hob: "Other", name: "Otto" }] }),
    );
    expect(asked.pending).toMatchObject({ onceOnly: true, grantable: false });
    expect(asked.pending?.reason).toContain(
      "Other can do more than you (folders), so every change to it asks the user.",
    );
    await decide(asked, "approve");
    expect((await hob(other.id)).name).toBe("Otto");
  });

  // covers ADR 034 (Managing itself), #406 done when 2
  it("[TC-AG-406-07] a hob managing itself changes its own instructions once you allow it, and never widens itself or retires itself", async () => {
    const scoped = await permissions(chief, { charms: { summoning: { summoned: true, hobs: [], self: true } } });
    // Turning "Can manage itself" on writes every self field as Ask.
    expect(scoped.policy.charms?.overrides).toMatchObject(SUMMONING_SELF_DEFAULTS);
    const asked = await turn(
      chief,
      hub("summoning_change", { key: "friendlier", changes: [{ hob: "Chief", instructions: "Be friendlier." }] }),
    );
    expect(asked.pending).toMatchObject({ operation: "summoning.self-instructions" });
    await decide(asked, "approve");
    expect((await hob(chief.id)).instructions).toBe("Be friendlier.");

    for (const [change, reason] of [
      [
        { hob: "Chief", own_folders: [shared] },
        "outside-scope: managing yourself, you may never change a hob's folders.",
      ],
      [{ hob: "Chief", charms: ["github"] }, "outside-scope: managing yourself, you may never change a hob's Charms"],
      [{ hob: "Chief", role_title: "Boss" }, "outside-scope: managing yourself, you may never change a hob's role."],
    ] as const) {
      const before = await hob(chief.id);
      const { reply } = await turn(chief, hub("summoning_change", { key: crypto.randomUUID(), changes: [change] }));
      expect(reply?.content).toContain(reason);
      expect((await hob(chief.id)).configVersion).toBe(before.configVersion);
    }
    const retire = await turn(
      chief,
      hub("summoning_retire", { key: "leave", hob: "Chief", running_replies: "finish" }),
    );
    expect(retire.reply?.content).toContain("Refused (outside-scope): You never retire yourself.");
    const pause = await turn(chief, hub("summoning_pause", { key: "nap", hob: "Chief" }));
    expect(pause.reply?.content).toContain("Refused (outside-scope): You never pause yourself.");
    expect((await hob(chief.id)).status).toBe("active");
  });

  // covers ADR 034 (Pause, wake and retire; Retiring)
  it("[TC-AG-406-08] the chief pauses and wakes a hob it summoned, and retiring one always asks once only, with today's choice for its replies", async () => {
    const cy = summoned.find((agent) => agent.name === "Cy") as Agent;
    const paused = await turn(chief, hub("summoning_pause", { key: "pause-cy", hob: "Cy" }));
    expect(paused.reply?.content).toContain("Cy is paused now.");
    expect((await hob(cy.id)).status).toBe("paused");
    await turn(chief, hub("summoning_wake", { key: "wake-cy", hob: "Cy" }));
    expect((await hob(cy.id)).status).toBe("active");

    const retire = await turn(chief, hub("summoning_retire", { key: "retire-cy", hob: "Cy", running_replies: "stop" }));
    expect(retire.pending).toMatchObject({ operation: "summoning.retire", onceOnly: true, grantable: false });
    const reply = await decide(retire, "approve");
    expect(reply.content).toContain("Cy is retired now.");
    expect((await hob(cy.id)).status).toBe("retired");
    // A retired hob is outside every scope.
    const after = await turn(chief, hub("summoning_wake", { key: "wake-cy-again", hob: cy.id }));
    expect(after.reply?.content).toContain("Refused (outside-scope): Cy is retired, so it is outside every scope.");
  });

  // covers EX-004, ADR 034 (Every runtime), #406 (every runtime: Claude Code, Codex, fake)
  it("[TC-AG-406-10] each runtime records a Summoning call's step before it pauses a hob, and pauses nothing unrecorded", {
    timeout: 240_000,
  }, async () => {
    const bo = summoned.find((agent) => agent.name === "Bo") as Agent;
    const runtimes = await hubCallRuntimes();
    try {
      expect(runtimes.runtimes.map((runtime) => runtime.name)).toEqual(expectedRuntimes);
      for (const [index, runtime] of runtimes.runtimes.entries()) {
        for (const records of [true, false]) {
          const manager = await hob(chief.id);
          const charmOperations = declaredOperations(
            await hobs.runPromise(
              Effect.gen(function* () {
                return yield* CharmDeclarations;
              }),
            ),
          );
          const order: Array<string> = [];
          const charmTurn: CharmTurn = {
            agentId: manager.id,
            threadId: null,
            messageId: null,
            scope: () => `reply:${runtime.name}-${records}`,
            also: `reply:${runtime.name}-${records}`,
            currentAccess: Effect.succeed({
              policy: {
                preset: "balanced",
                sharedFolders: [shared],
                hob: manager.policy,
                dataFolder: dataDir,
                restrictions: [],
                charmOperations,
              },
              folders: [team],
              runtimeFolder: join(temp, "runtimes", runtime.name),
              commitsAs: { _tag: "UserConfig", config: { name: "Chief", email: "chief@example.com" } },
            }),
            redactor: makeRedactor([]),
            approvals: null,
          };
          const hubTools = joinHubTools(await hobs.runPromise(Charms.use((charms) => charms.forTurn(charmTurn))));
          if (hubTools === null) throw new Error("No Summoning tools");
          const { exit } = await runtime.turn({
            hubTools,
            recordToolStart: (event) =>
              Effect.promise(async () => {
                order.push(`recorded ${event.tool} ${event.operation} while ${(await hob(bo.id)).status}`);
                return records;
              }),
            calls: [{ tool: "summoning_pause", input: { key: `pause-bo-${index}-${records}`, hob: "Bo" } }],
          });
          expect(Exit.isSuccess(exit), String(exit)).toBe(true);
          expect(order, runtime.name).toEqual(["recorded summoning_pause summoning.pause while active"]);
          expect((await hob(bo.id)).status, runtime.name).toBe(records ? "paused" : "active");
          if (records) await turn(chief, hub("summoning_wake", { key: `wake-bo-${index}`, hob: "Bo" }));
          expect((await hob(bo.id)).status).toBe("active");
        }
      }
    } finally {
      runtimes.close();
    }
  });

  // covers ADR 034 (The Charm: Every hob), #406 (granted per hob or to every hob)
  it("[TC-AG-406-09] Summoning for every hob reaches the hobs you made, never a hob a hob summoned, and a hob's own tab can take it away", async () => {
    const plain = await create("Plain", 4003);
    const set = await request<{ summoningForEveryHob: unknown }>("PATCH", "/api/setup", {
      summoningForEveryHob: { scope: { summoned: true, hobs: [], self: false }, overrides: {} },
    });
    expect(set.status).toBe(200);
    expect(set.body.summoningForEveryHob).toMatchObject({ overrides: SUMMONING_DEFAULTS });
    const tools = async (agent: Agent) => (await turn(agent)).sent?.hubTools?.tools.map((tool) => tool.name) ?? [];
    expect(await tools(plain)).toContain("summoning_summon");
    const bo = summoned.find((agent) => agent.name === "Bo") as Agent;
    expect(await tools(bo)).not.toContain("summoning_summon");
    await permissions(plain, { charms: { withheld: ["summoning"] } });
    expect(await tools(plain)).not.toContain("summoning_summon");
    await request("PATCH", "/api/setup", { summoningForEveryHob: null });
    const refused = await request("PATCH", "/api/setup", {
      summoningForEveryHob: { scope: { summoned: true, hobs: [], self: false }, overrides: { "github.read": "deny" } },
    });
    expect(refused.status).toBe(400);
  });
});
