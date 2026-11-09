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
  HobProposalLog,
  HobProposals,
  HobService,
  hubCallStep,
  joinHubTools,
  makeRedactor,
  PermissionSummary,
  type PromptRequest,
  RuntimeAdapter,
  type RuntimeAdapterShape,
  SecretRedaction,
  SummoningHub,
  TaskRepository,
} from "@hobbots/agents";
import { fakeCharm, memoryCharmCalls } from "@hobbots/agents/testing";
import type { HobPermissions, HobProposalView } from "@hobbots/api";
import {
  type Agent,
  type AgentConfiguration,
  type ApprovalRequest,
  declaredOperations,
  HobProposal,
  HobProposalId,
  isInProgress,
  type Message,
  roleFields,
  SUMMONING_DEFAULTS,
  SUMMONING_SELF_DEFAULTS,
  TaskId,
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
  HobChangesLive,
  HobProposalLogLive,
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
  Layer.provide(FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node))),
);
const Database = Layer.mergeAll(
  HobbotsRepositoryLive,
  ApprovalRepositoryLive,
  GrantRepositoryLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
  ActivityRepositoryLive,
  BackpackLive,
  HobChangesLive,
  HobProposalLogLive,
  EventJournal.layer,
  SetupRepository.layer,
  SearchIndex.layer,
).pipe(Layer.provideMerge(TestDatabase));
// One store of Charm call records, shared by the Charms and the proposals that settle their calls.
const charmCalls = memoryCharmCalls();
const App = SummoningHub.bound
  .pipe(Layer.provideMerge(HobLifecycle.layer))
  .pipe(Layer.provideMerge(Layer.mergeAll(HobService.layer, PermissionSummary.layer)))
  .pipe(Layer.provideMerge(ChatService.layer))
  .pipe(Layer.provideMerge(ApprovalService.layer))
  .pipe(Layer.provideMerge(HobProposals.layer.pipe(Layer.provide(charmCalls))))
  .pipe(Layer.provideMerge(GrantService.layer))
  .pipe(Layer.provideMerge(HobToolsLive))
  .pipe(Layer.provideMerge(DirectoryToolsLive))
  .pipe(
    Layer.provideMerge(
      Charms.layer<SummoningHub>([
        fakeCharm({ id: "github", name: "GitHub" }),
        SummoningCharm.pipe(Effect.provide(PolicyEngine.node)),
      ]).pipe(Layer.provide(charmCalls)),
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
    if (pending) return { thread, pending, proposal: undefined, reply: undefined, sent: requests[asked] };
    const reply = (await messages(thread)).at(-1);
    // A call whose Ask became a proposal waits on its step until you decide its rows (ADR 034).
    const waiting = reply?.steps?.find((step) => step.state === "awaiting" && step.proposalId !== undefined);
    if (waiting?.proposalId !== undefined) {
      const proposal = await proposalOf(waiting.proposalId);
      return { thread, pending: undefined, proposal, reply: undefined, sent: requests[asked] };
    }
    return reply?.role === "assistant" && !isInProgress(reply.status)
      ? { thread, pending: undefined, proposal: undefined, reply, sent: requests[asked] }
      : undefined;
  });
};

/** The live hob the chief summoned under `name`. */
const summonedNamed = async (name: string) =>
  (await allHobs()).find(
    (agent) => agent.name === name && agent.status !== "retired" && agent.summonedBy === chief.id,
  ) as Agent;

const proposalOf = async (id: string) => {
  const found = await request<HobProposalView>("GET", `/api/hob-proposals/${id}`);
  expect(found.status).toBe(200);
  return found.body;
};

/** Decides one row of a proposal, or all of them, as you; the view as it stands after. */
const onProposal = async (
  proposal: HobProposalView,
  path: string,
  body: object = {},
): Promise<{ status: number; body: HobProposalView }> =>
  request<HobProposalView>("POST", `/api/hob-proposals/${proposal.proposal.id}/${path}`, body);

/** Decides every row of the proposal a turn waits on, and waits for the reply to end. */
const decideProposal = async (
  asked: { readonly thread: Thread; readonly proposal?: HobProposalView | undefined },
  decision: "allow-all" | "deny-all",
  body: object = {},
) => {
  const proposal = asked.proposal as HobProposalView;
  expect(proposal).toBeDefined();
  const decided = await onProposal(proposal, decision, body);
  expect(decided.status).toBe(200);
  expect(decided.body.proposal.state).toBe("settled");
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
  it("[TC-AG-406-04] under the default Ask a summon becomes a proposal, and is created as summoned once you allow it", async () => {
    await chiefAnswers({});
    const asked = await turn(chief, hub("summoning_summon", { key: "hire-dee", hobs: [draft("Dee")] }));
    expect(asked.pending).toBeUndefined();
    expect(asked.proposal?.proposal).toMatchObject({
      kind: "summon",
      agentId: chief.id,
      asks: ["summoning.summon"],
      state: "open",
    });
    const reply = await decideProposal(asked, "allow-all");
    expect(reply.content).toContain("- Dee: the user allowed it. Summoned Dee (Writer)");
    const dee = (await allHobs()).find((agent) => agent.name === "Dee") as Agent;
    expect(dee).toMatchObject({ summonedBy: chief.id, summonedUnattended: false });

    const denied = await turn(chief, hub("summoning_summon", { key: "hire-eve", hobs: [draft("Eve")] }));
    const deniedReply = await decideProposal(denied, "deny-all");
    expect(deniedReply.content).toContain("- Eve: the user denied it, so nothing was done.");
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

  // covers ADR 034 (No escalation), #406 (same validation as the screens)
  it("[TC-AG-406-11] a change is checked by the policy it leaves, so a replaced answer map or a shown folder never widens a hob, and a label the profile refuses is refused", async () => {
    await chiefAnswers({
      "summoning.name": "allow",
      "summoning.folders": "allow",
      "summoning.charms": "allow",
      "github.read": "deny",
    });
    const bo = summoned.find((agent) => agent.name === "Bo") as Agent;
    // The chief may not run commands, nor see the shared folder, and neither may Bo.
    await permissions(chief, { overrides: { "run-commands": "deny" }, hiddenSharedFolders: [shared] });
    await permissions(bo, {
      overrides: { "edit-files": "ask", "run-commands": "deny" },
      hiddenSharedFolders: [shared],
    });
    const refusals = [
      [{ hob: bo.id, answers: {} }, "authority-wider: answers, since run-commands would be wider than your own."],
      [
        { hob: bo.id, hidden_shared_folders: [] },
        `authority-wider: shared folders, since ${shared} is hidden from you.`,
      ],
      [{ hob: bo.id, name: "" }, "It needs a name."],
      [{ hob: bo.id, name: "B".repeat(41) }, "Its name is longer than 40 characters."],
      [{ hob: bo.id, role: null, role_title: "  " }, "Its role title cannot be empty."],
      [{ hob: bo.id, name: "Bo Renamed", hidden_shared_folders: [elsewhere] }, `${elsewhere} is not a shared folder.`],
      // The chief holds GitHub but may not read with it: Bo, who holds no Charm, gains no GitHub reads.
      [{ hob: bo.id, charms: ["github"] }, "authority-wider: answers, since github.read would be wider than your own."],
    ] as const;
    for (const [change, reason] of refusals) {
      const before = await hob(bo.id);
      const { reply } = await turn(chief, hub("summoning_change", { key: crypto.randomUUID(), changes: [change] }));
      expect(reply?.content).toContain("No hob was changed.");
      expect(reply?.content).toContain(reason);
      expect(await hob(bo.id)).toMatchObject({ name: before.name, configVersion: before.configVersion });
    }
    // A change that keeps Bo within the chief applies, its profile and permissions as one version.
    const before = await hob(bo.id);
    const kept = await turn(
      chief,
      hub("summoning_change", {
        key: "keep-bo",
        changes: [{ hob: bo.id, name: "Bo", answers: { "edit-files": "deny", "run-commands": "deny" } }],
      }),
    );
    expect(kept.reply?.content).toContain("- Bo: changed name, charms.");
    expect((await hob(bo.id)).configVersion).toBe(before.configVersion + 1);
    await permissions(chief, { overrides: {}, hiddenSharedFolders: [] });
    await permissions(bo, { overrides: { "edit-files": "ask" }, hiddenSharedFolders: [] });
  });

  // covers PE-008, ADR 034 (The same use cases as the screens)
  it("[TC-AG-406-12] a Summoning change takes back the grants that relied on what it took away, as the Charms tab does", async () => {
    await chiefAnswers({ "summoning.charms": "allow" });
    const bo = summoned.find((agent) => agent.name === "Bo") as Agent;
    // With every edit open, Bo is offered commands, and deleting files asks.
    await permissions(bo, { overrides: {} });
    const asked = await turn(bo, "fake:tool Bash rm build");
    const pending = asked.pending as ApprovalRequest;
    expect(pending, asked.reply?.content).toMatchObject({ operation: "delete-files" });
    const decided = await request("POST", `/api/approvals/${pending.id}/decision`, {
      decision: "approve",
      actionDigest: pending.actionDigest,
      lifetime: "always",
    });
    expect(decided.status).toBe(200);
    await settled(asked.thread);
    const grantsOf = () => hobs.runPromise(GrantService.use((grants) => grants.list({ agentId: bo.id, all: true })));
    expect((await grantsOf()).filter((grant) => grant.revokedAt === null)).toHaveLength(1);

    const narrowed = await turn(
      chief,
      hub("summoning_change", {
        key: "no-deleting",
        changes: [{ hob: bo.id, answers: { "delete-files": "deny" } }],
      }),
    );
    expect(narrowed.reply?.content).toContain("- Bo: changed charms.");
    const [grant] = await grantsOf();
    expect(grant).toMatchObject({ revokedBy: "hub", revokeReason: "narrowed" });
    await permissions(bo, { overrides: { "edit-files": "ask" } });
  });

  // covers ADR 034 (The same use cases as the screens), #406 (refusals write nothing)
  it("[TC-AG-406-13] a hob's profile and permissions change as one version, so a change either part refuses stores nothing", async () => {
    const bo = summoned.find((agent) => agent.name === "Bo") as Agent;
    const before = await hob(bo.id);
    const refused = await hobs.runPromise(
      HobService.use((service) =>
        service.change(
          bo.id,
          { profile: { name: "Bo Renamed" }, permissions: { hiddenSharedFolders: [elsewhere] } },
          { _tag: "Hob", hobId: chief.id, call: { scope: "reply:test", key: "atomic" } },
        ),
      ).pipe(Effect.flip),
    );
    expect(refused).toMatchObject({ _tag: "InvalidFolder" });
    expect(await hob(bo.id)).toMatchObject({ name: before.name, configVersion: before.configVersion });
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
    // A safety Ask: "Always allow" is never offered for it.
    expect(asked.proposal?.proposal).toMatchObject({ kind: "change", asks: [] });
    expect(asked.proposal?.proposal.safety).toContain(
      "Other can do more than you (folders), so every change to it asks the user.",
    );
    expect(asked.proposal?.proposal.rows[0]).toMatchObject({ label: "Other", before: { name: "Other" } });
    await decideProposal(asked, "allow-all");
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
    expect(asked.proposal?.proposal.asks).toEqual(["summoning.self-instructions"]);
    await decideProposal(asked, "allow-all");
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
    // Retiring is high risk: never "Always allow", and allowing it needs the check box.
    expect(retire.proposal?.proposal).toMatchObject({ kind: "retire", highRisk: true, asks: [] });
    expect(retire.proposal?.proposal.rows[0]).toMatchObject({ label: "Cy", runningReplies: "stop" });
    const unconfirmed = await onProposal(retire.proposal as HobProposalView, "allow-all");
    expect(unconfirmed.status).toBe(422);
    expect((await hob(cy.id)).status).toBe("active");
    const reply = await decideProposal(retire, "allow-all", { confirmed: true });
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

  // covers ADR 034 (Limits for unattended summons), #407 done when 1 and 2
  it("[TC-AG-407-01] a manager with summon at Allow summons up to its cap, the next summon asks, one you approve is not counted, and retiring frees a place", async () => {
    await chiefAnswers({ "summoning.summon": "allow" });
    const caps = async () =>
      (await request<{ live: number; perHob: number; perTree: number }>("GET", `/api/agents/${chief.id}/summon-caps`))
        .body;
    // Ada, Bo and Fay are live from earlier; Cy was retired, which freed its place.
    expect(await caps()).toEqual({ live: 3, perHob: 4, perTree: 3 });
    const gil = await turn(chief, hub("summoning_summon", { key: "hire-gil", hobs: [draft("Gil")] }));
    expect(gil.pending).toBeUndefined();
    expect(gil.reply?.content).toContain("Summoned 1 hob:");
    expect(await caps()).toMatchObject({ live: 4 });

    // At the cap the check says so, and the summon asks once only instead of being refused.
    const checked = await turn(chief, hub("summoning_check", { summon: [draft("Hal")] }));
    expect(checked.reply?.content).toContain("the cap is 4, so this summon asks the user.");
    const hal = await turn(chief, hub("summoning_summon", { key: "hire-hal", hobs: [draft("Hal")] }));
    // The ask is a proposal (ADR 034): the cap's reason is on its card, which offers no "Always allow".
    expect(hal.proposal?.proposal.safety).toContain("You have 4 live hobs summoned without asking the user");
    expect(hal.proposal?.proposal.asks).toEqual([]);
    expect((await decideProposal(hal, "allow-all")).content).toContain("- Hal: the user allowed it. Summoned Hal");
    const hired = (await allHobs()).find((agent) => agent.name === "Hal") as Agent;
    expect(hired).toMatchObject({ summonedBy: chief.id, summonedUnattended: false });
    expect(await caps()).toMatchObject({ live: 4 });

    // Retiring a hob summoned without a card frees its place, so the next summon runs without one.
    const placed = (await allHobs()).find((agent) => agent.name === "Gil") as Agent;
    expect((await request("POST", `/api/agents/${placed.id}/retire`, { activeWork: "finish" })).status).toBe(200);
    expect(await caps()).toMatchObject({ live: 3 });
    const ivy = await turn(chief, hub("summoning_summon", { key: "hire-ivy", hobs: [draft("Ivy")] }));
    expect(ivy.pending).toBeUndefined();
    expect((await allHobs()).find((agent) => agent.name === "Ivy")).toMatchObject({ summonedUnattended: true });
  });

  /** A hob you made with summon at Allow, within the team folder. */
  const manager = async (name: string, lookSeed: number) => {
    const made = await create(name, lookSeed);
    await permissions(made, {
      ownFolders: [team],
      charms: { granted: ["summoning"], overrides: { ...SUMMONING_DEFAULTS, "summoning.summon": "allow" } },
    });
    return hob(made.id);
  };

  /** A Task tree on the hub's records: a root owned by `owner`, and children directly under it. */
  const tree = (owner: Agent, root: string, children: ReadonlyArray<string>) =>
    hobs.runPromise(
      Effect.gen(function* () {
        const tasks = yield* TaskRepository;
        const task = (id: string, parentId: string | null) => ({
          id: TaskId.make(id),
          ownerId: owner.id,
          parentId: parentId === null ? null : TaskId.make(parentId),
          threadId: null,
          brief: `Brief for ${id}`,
          dependsOn: [],
          createdAt: new Date().toISOString(),
        });
        yield* tasks.createTask({ task: task(root, null), delegation: null, milestones: [] });
        for (const child of children) {
          yield* tasks.createTask({ task: task(child, root), delegation: null, milestones: [] });
        }
      }),
    );

  /** A turn of `by` on Task `task`: every hob summoned in it is summoned for that Task. */
  const taskTurn = async (by: Agent, task: string): Promise<CharmTurn> => {
    const charmOperations = declaredOperations(
      await hobs.runPromise(
        Effect.gen(function* () {
          return yield* CharmDeclarations;
        }),
      ),
    );
    return {
      agentId: by.id,
      threadId: null,
      messageId: null,
      scope: () => `task:${task}`,
      also: `task:${task}`,
      currentAccess: Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [shared],
          hob: by.policy,
          dataFolder: dataDir,
          restrictions: [],
          charmOperations,
        },
        folders: [team],
        runtimeFolder: join(temp, "runtimes", "tree"),
        commitsAs: { _tag: "UserConfig", config: { name: by.name, email: "manager@example.com" } },
      }),
      redactor: makeRedactor([]),
      approvals: null,
    };
  };

  /** `by` summons `names` on Task `task`; with no way to ask here, a call that asks is refused. */
  const summonIn = async (
    by: Agent,
    task: string,
    key: string,
    names: ReadonlyArray<string>,
    recorded: () => Promise<void> = async () => {},
  ) => {
    const turnOn = await taskTurn(by, task);
    const tools = joinHubTools(await hobs.runPromise(Charms.use((charms) => charms.forTurn(turnOn))));
    if (tools === null) throw new Error("No Summoning tools");
    const input = { key, hobs: names.map((name) => draft(name)) };
    return hobs.runPromise(
      tools.call(
        "summoning_summon",
        input,
        hubCallStep(
          key,
          () => {},
          () => Effect.promise(recorded).pipe(Effect.as(true)),
        ),
      ),
    );
  };
  const named = async (name: string) => (await allHobs()).find((agent) => agent.name === name);

  // covers ADR 034 (Limits for unattended summons), #407 (3 per Task tree)
  it("[TC-AG-407-02] summons without a card for one Task tree count across its root, children and siblings, stop at its cap and ask, and a summon that would pass a cap asks for all its hobs", async () => {
    const lead = await manager("Lead", 4004);
    await tree(lead, "launch", ["launch-site", "launch-mail"]);
    await tree(lead, "sale", []);

    const two = await summonIn(lead, "launch", "on-root", ["Jo", "Kit"]);
    expect(two.refused, two.text).toBe(false);
    expect(await named("Kit")).toMatchObject({ summonedBy: lead.id, summonedFor: "launch", summonedUnattended: true });
    // From a child, the two summoned for the root count: two more would pass the cap of 3, so the
    // call asks for both, and creates neither.
    const past = await summonIn(lead, "launch-site", "past-cap", ["Lu", "Max"]);
    expect(past.refused).toBe(true);
    expect(past.text).toContain("This work has 2 live hobs summoned without asking the user, and the cap is 3");
    expect(await named("Lu")).toBeUndefined();
    expect(await named("Max")).toBeUndefined();
    const third = await summonIn(lead, "launch-site", "on-child", ["Lu"]);
    expect(third.refused, third.text).toBe(false);
    expect(await named("Lu")).toMatchObject({ summonedFor: "launch-site" });
    // A sibling sees the root's and the other child's.
    const fourth = await summonIn(lead, "launch-mail", "on-sibling", ["Max"]);
    expect(fourth.refused).toBe(true);
    expect(fourth.text).toContain("This work has 3 live hobs summoned without asking the user, and the cap is 3");
    expect(await named("Max")).toBeUndefined();
    // Another tree has room of its own, up to the manager's cap of 4.
    expect((await summonIn(lead, "sale", "other-tree", ["Max"])).refused).toBe(false);
    const pastManager = await summonIn(lead, "sale", "past-manager", ["Ned"]);
    expect(pastManager.refused).toBe(true);
    expect(pastManager.text).toContain("You have 4 live hobs summoned without asking the user, and the cap is 4");
  });

  // covers ADR 034 (Limits for unattended summons), #407 (counted under a lock)
  it("[TC-AG-407-03] two managers summoning at once in one Task tree never both take its last place", async () => {
    const first = await manager("Ora", 4005);
    const second = await manager("Pax", 4006);
    await tree(first, "fair", ["fair-stalls", "fair-music"]);
    expect((await summonIn(first, "fair", "fair-first", ["Quin", "Rue"])).refused).toBe(false);
    // Both calls are decided, seeing two of three places taken, before either is sent.
    let arrived = 0;
    let release: () => void = () => {};
    const bothDecided = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorded = () => {
      arrived += 1;
      if (arrived === 2) release();
      return bothDecided;
    };
    const both = await Promise.all([
      summonIn(first, "fair-stalls", "fair-last-ora", ["Sol"], recorded),
      summonIn(second, "fair-music", "fair-last-pax", ["Tam"], recorded),
    ]);
    expect(both.filter((answer) => !answer.refused)).toHaveLength(1);
    const lost = both.find((answer) => answer.refused);
    expect(lost?.text).toMatch(/cap is 3/);
    const inFair = (await allHobs()).filter(
      (agent) => agent.summonedUnattended && ["fair", "fair-stalls", "fair-music"].includes(agent.summonedFor ?? ""),
    );
    expect(inFair).toHaveLength(3);
  });

  // covers ADR 034 (Asking is a proposal: a decision per row, Edit), #409 done when 1
  it("[TC-AG-409-01] you edit one of three hobs on a summon card, and all three are created, the edited one as you edited it", async () => {
    await chiefAnswers({});
    const asked = await turn(
      chief,
      hub("summoning_summon", {
        key: "hire-trio",
        hobs: [draft("Flo"), draft("Gus", { instructions: "Write tests." }), draft("Hedda")],
      }),
    );
    const view = asked.proposal as HobProposalView;
    expect(view.proposal.rows.map((row) => [row.label, row.state])).toEqual([
      ["Flo", "pending"],
      ["Gus", "pending"],
      ["Hedda", "pending"],
    ]);
    const gus = view.proposal.rows[1] as HobProposalView["proposal"]["rows"][number];
    // Your version is checked as the manager's was: never wider than the manager.
    const wider = await onProposal(view, `rows/${gus.id}/allow`, {
      edited: { ...gus.draft, own_folders: [elsewhere] },
    });
    expect(wider.status).toBe(422);
    expect(JSON.stringify(wider.body)).toContain("authority-wider: folders");
    const edited = await onProposal(view, `rows/${gus.id}/allow`, {
      edited: { ...gus.draft, name: "Gussie", instructions: "Write tests first.", good_at: "Tests." },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.proposal.rows[1]).toMatchObject({ state: "allowed", edited: { name: "Gussie" } });
    expect(edited.body.proposal.state).toBe("open");
    const reply = await decideProposal(asked, "allow-all");
    expect(reply.content).toContain("- Gus: the user allowed it. Summoned Gussie (Writer)");
    const made = (await allHobs()).filter((agent) => ["Flo", "Gussie", "Hedda"].includes(agent.name));
    expect(made.map((agent) => agent.name).sort()).toEqual(["Flo", "Gussie", "Hedda"]);
    const gussie = made.find((agent) => agent.name === "Gussie") as Agent;
    expect(gussie).toMatchObject({
      id: gus.hobId,
      instructions: "Write tests first.",
      goodAt: "Tests.",
      summonedBy: chief.id,
      summonedUnattended: false,
    });
    // Made by you, on the chief's proposal and its call.
    expect((await versions(gussie.id))[0]?.actor).toMatchObject({
      _tag: "YouApplyingProposal",
      hobId: chief.id,
      proposalId: view.proposal.id,
      call: { key: "hire-trio" },
    });
    // A row decided already, or a proposal that settled, is never decided again.
    expect((await onProposal(view, `rows/${gus.id}/deny`)).status).toBe(409);
  });

  // covers ADR 034 (A decision per row, the manager hears row by row, Changed since), #409 done when 2
  it("[TC-AG-409-02] a change to three hobs is allowed for two and denied for one, and the chief hears which", async () => {
    await chiefAnswers({});
    const hire = await turn(
      chief,
      hub("summoning_summon", { key: "hire-crew", hobs: [draft("Iris"), draft("Jules"), draft("Kai")] }),
    );
    await decideProposal(hire, "allow-all");
    const asked = await turn(
      chief,
      hub("summoning_change", {
        key: "retone-crew",
        changes: [
          { hob: "Iris", instructions: "Be brief." },
          { hob: "Jules", instructions: "Be brief." },
          { hob: "Kai", instructions: "Be brief." },
        ],
      }),
    );
    const view = asked.proposal as HobProposalView;
    expect(view.proposal.asks).toEqual(["summoning.instructions"]);
    const [iris, jules, kai] = view.proposal.rows as ReadonlyArray<HobProposalView["proposal"]["rows"][number]>;
    expect(iris?.before).toEqual({ instructions: "" });
    expect(iris?.change).toMatchObject({ hob: iris?.hobId, instructions: "Be brief." });
    expect((await onProposal(view, `rows/${iris?.id}/allow`)).status).toBe(200);
    // Kai is changed from its profile meanwhile: its row shows as changed since, and only Deny is left.
    expect((await request("PATCH", `/api/agents/${kai?.hobId}`, { name: "Kitty" })).status).toBe(200);
    const read = await proposalOf(view.proposal.id);
    expect(read.changedSince).toEqual([kai?.id]);
    const stale = await onProposal(view, `rows/${kai?.id}/allow`);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ _tag: "HobProposalChangedSince" });
    expect((await onProposal(view, `rows/${jules?.id}/allow`)).status).toBe(200);
    expect((await onProposal(view, `rows/${kai?.id}/deny`)).status).toBe(200);
    const reply = await settled(asked.thread);
    expect(reply.content).toContain("- Iris: the user allowed it. Changed instructions, from its next turn.");
    expect(reply.content).toContain("- Jules: the user allowed it.");
    // A row keeps the name its hob had when the row was made.
    expect(reply.content).toContain("- Kai: the user denied it, so nothing was done.");
    expect((await hob(iris?.hobId as string)).instructions).toBe("Be brief.");
    expect((await hob(jules?.hobId as string)).instructions).toBe("Be brief.");
    expect((await hob(kai?.hobId as string)).instructions).toBe("");
  });

  // covers ADR 034 ("Always allow"), #409 done when 3, #410 (the Charms tab reads it as Allow)
  it("[TC-AG-409-03] Always allow on a summon card sets summoning.summon to Allow as your change, and the next summon runs without a card", async () => {
    // A manager of its own, so the caps the chief reached above leave its next summon free.
    const boss = await create("Bram", 4009);
    await permissions(boss, { ownFolders: [team], charms: { granted: ["summoning"], overrides: SUMMONING_DEFAULTS } });
    const before = await hob(boss.id);
    const asked = await turn(boss, hub("summoning_summon", { key: "hire-lark", hobs: [draft("Lark")] }));
    const view = asked.proposal as HobProposalView;
    // Only an operation that asked is offered.
    expect((await onProposal(view, "always-allow", { operations: ["summoning.instructions"] })).status).toBe(409);
    const always = await onProposal(view, "always-allow", { operations: ["summoning.summon"] });
    expect(always.status).toBe(200);
    expect(always.body.proposal.alwaysAllowed).toEqual(["summoning.summon"]);
    const after = await hob(boss.id);
    expect(after.configVersion).toBe(before.configVersion + 1);
    expect(after.policy.charms?.overrides?.["summoning.summon"]).toBe("allow");
    expect((await versions(boss.id)).at(-1)?.actor).toEqual({ _tag: "You" });
    const tab = await request<HobPermissions>("GET", `/api/agents/${boss.id}/permissions`);
    expect(tab.body.decisions["summoning.summon"]).toBe("allow");
    const reply = await decideProposal(asked, "allow-all");
    expect(reply.content).toContain("The user set summoning.summon to Allow for you");
    const next = await turn(boss, hub("summoning_summon", { key: "hire-mabel", hobs: [draft("Mabel")] }));
    expect(next.proposal).toBeUndefined();
    expect(next.reply?.content).toContain("Summoned 1 hob:");
  });

  // covers ADR 034 (Asking is a proposal: Always allow; The Charm: Every hob), #409, #410
  it("[TC-AG-409-05] Always allow for a manager with the Charm from every hob gives it its own grant from that setting", async () => {
    const wren = await create("Wren", 4005);
    const scope = { summoned: true, hobs: [], self: false };
    expect((await request("PATCH", "/api/setup", { summoningForEveryHob: { scope, overrides: {} } })).status).toBe(200);
    try {
      const asked = await turn(wren, hub("summoning_summon", { key: "hire-iona", hobs: [draft("Iona")] }));
      const view = asked.proposal as HobProposalView;
      expect((await onProposal(view, "always-allow", { operations: ["summoning.summon"] })).status).toBe(200);
      const after = await hob(wren.id);
      expect(after.policy.charms?.granted).toContain("summoning");
      expect(after.policy.charms?.summoning).toEqual(scope);
      expect(after.policy.charms?.overrides).toMatchObject({ ...SUMMONING_DEFAULTS, "summoning.summon": "allow" });
      expect((await versions(wren.id)).at(-1)?.actor).toEqual({ _tag: "You" });
      await decideProposal(asked, "deny-all");
    } finally {
      await request("PATCH", "/api/setup", { summoningForEveryHob: null });
    }
  });

  // covers ADR 034 (The call waits on its step; outcome as a backpack item), PE-006
  it("[TC-AG-409-04] only a user session decides a proposal, and one decided after its turn stopped reaches the chief's backpack", async () => {
    await chiefAnswers({});
    const asked = await turn(chief, hub("summoning_summon", { key: "hire-nell", hobs: [draft("Nell")] }));
    const view = asked.proposal as HobProposalView;
    const anonymous = await handler(
      new Request(`http://localhost:4578/api/hob-proposals/${view.proposal.id}/allow-all`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(anonymous.status).not.toBe(200);
    expect((await proposalOf(view.proposal.id)).proposal.state).toBe("open");
    expect((await request("POST", `/api/threads/${asked.thread.id}/interrupt`)).status).toBeLessThan(300);
    await settled(asked.thread);
    // The proposal outlives its turn, in the Inbox.
    const listed = await request<{ proposals: ReadonlyArray<HobProposalView> }>("GET", "/api/hob-proposals");
    expect(listed.body.proposals.some((each) => each.proposal.id === view.proposal.id)).toBe(true);
    expect((await onProposal(view, "allow-all")).status).toBe(200);
    expect((await allHobs()).some((agent) => agent.name === "Nell")).toBe(true);
    const backpack = await eventually(async () => {
      const read = await request<{ items: ReadonlyArray<{ payload: { _tag: string } }> }>(
        "GET",
        `/api/agents/${chief.id}/backpack`,
      );
      return read.body.items.find((item) => item.payload._tag === "hob-proposal");
    });
    expect(backpack).toBeDefined();
  });
  // covers ADR 034 (Applying re-checks), AG-002
  it("[TC-AG-409-07] a proposal you allow after its operation went to Never, or its hob left the scope, is refused and changes nothing", async () => {
    await chiefAnswers({});
    const hire = await turn(chief, hub("summoning_summon", { key: "hire-pair", hobs: [draft("Opal"), draft("Pim")] }));
    await decideProposal(hire, "allow-all");
    const opal = await summonedNamed("Opal");
    const pim = await summonedNamed("Pim");
    await chiefAnswers({ "summoning.pause": "ask" });

    // The answer went to Never while the proposal waited.
    const pauseOpal = await turn(chief, hub("summoning_pause", { key: "pause-opal", hob: "Opal" }));
    const opalView = pauseOpal.proposal as HobProposalView;
    await chiefAnswers({ "summoning.pause": "deny" });
    const never = await onProposal(opalView, `rows/${opalView.proposal.rows[0]?.id}/allow`);
    expect(never.status).toBe(422);
    expect(JSON.stringify(never.body)).toContain("is at Never for you");
    expect((await hob(opal.id)).status).toBe("active");
    await decideProposal(pauseOpal, "deny-all");

    // The hob left the chief's scope while the proposal waited.
    await chiefAnswers({ "summoning.pause": "ask" });
    const pausePim = await turn(chief, hub("summoning_pause", { key: "pause-pim", hob: "Pim" }));
    const pimView = pausePim.proposal as HobProposalView;
    await permissions(chief, {
      charms: {
        granted: ["github", "summoning"],
        overrides: { ...SUMMONING_DEFAULTS, "summoning.pause": "ask" },
        summoning: { summoned: false, hobs: [], self: false },
      },
    });
    try {
      const outside = await onProposal(pimView, `rows/${pimView.proposal.rows[0]?.id}/allow`);
      expect(outside.status).toBe(422);
      expect(JSON.stringify(outside.body)).toContain("is outside your Summoning scope");
      expect((await hob(pim.id)).status).toBe("active");
    } finally {
      await permissions(chief, {
        charms: {
          granted: ["github", "summoning"],
          overrides: SUMMONING_DEFAULTS,
          summoning: { summoned: true, hobs: [], self: false },
        },
      });
    }
    await decideProposal(pausePim, "deny-all");

    // Summoning itself went to Never while a summon waited.
    await chiefAnswers({});
    const hireQuill = await turn(chief, hub("summoning_summon", { key: "hire-quill", hobs: [draft("Quill")] }));
    const quillView = hireQuill.proposal as HobProposalView;
    await chiefAnswers({ "summoning.summon": "deny" });
    const summonNever = await onProposal(quillView, `rows/${quillView.proposal.rows[0]?.id}/allow`);
    expect(summonNever.status).toBe(422);
    expect((await allHobs()).some((agent) => agent.name === "Quill")).toBe(false);
    await chiefAnswers({});
    await decideProposal(hireQuill, "deny-all");
  });
  // covers ADR 034 ("Always allow" for a hob managing itself; Changed since)
  it("[TC-AG-409-10] Always allow on a hob's change to itself leaves that change yours to allow, and an edit of yours since still makes it stale", async () => {
    const sage = await create("Sage", 4010);
    await permissions(sage, {
      ownFolders: [team],
      charms: { granted: ["summoning"], summoning: { summoned: true, hobs: [], self: true } },
    });
    const change = (key: string, instructions: string) =>
      turn(sage, hub("summoning_change", { key, changes: [{ hob: "Sage", instructions }] }));
    const asked = await change("calmer", "Be calm.");
    const view = asked.proposal as HobProposalView;
    expect(view.proposal.asks).toEqual(["summoning.self-instructions"]);
    const always = await onProposal(view, "always-allow", { operations: ["summoning.self-instructions"] });
    expect(always.status).toBe(200);
    // The change "Always allow" made to Sage is the proposal's own, so the row is not stale.
    expect(always.body.changedSince).toEqual([]);
    await decideProposal(asked, "allow-all");
    expect((await hob(sage.id)).instructions).toBe("Be calm.");

    // With self-instructions at Ask again, an edit of yours after a proposal was made still leaves
    // its row to deny.
    await permissions(sage, {
      charms: { granted: ["summoning"], overrides: { ...SUMMONING_DEFAULTS, ...SUMMONING_SELF_DEFAULTS } },
    });
    const later = await change("terser", "Be terse.");
    const laterView = later.proposal as HobProposalView;
    expect((await request("PATCH", `/api/agents/${sage.id}`, { goodAt: "Calm answers." })).status).toBe(200);
    const stale = await proposalOf(laterView.proposal.id);
    expect(stale.changedSince).toEqual([laterView.proposal.rows[0]?.id]);
    await decideProposal(later, "deny-all");
  });
  // covers ADR 034 ("Always allow" for every field that asked, as one change)
  it("[TC-AG-409-13] Always allow for several fields sets each to Allow in one change of yours, and refuses one that did not ask", async () => {
    const tess = await create("Tess", 4013);
    await permissions(tess, {
      ownFolders: [team],
      charms: {
        granted: ["summoning"],
        overrides: { ...SUMMONING_DEFAULTS, ...SUMMONING_SELF_DEFAULTS },
        summoning: { summoned: true, hobs: [], self: true },
      },
    });
    const asked = await turn(
      tess,
      hub("summoning_change", {
        key: "tidier",
        changes: [{ hob: "Tess", good_at: "Tidy notes.", instructions: "Be tidy." }],
      }),
    );
    const view = asked.proposal as HobProposalView;
    expect([...view.proposal.asks].sort()).toEqual(["summoning.self-good-at", "summoning.self-instructions"]);
    const both = ["summoning.self-good-at", "summoning.self-instructions"];
    // One that did not ask refuses the whole call, and nothing changes.
    const before = await hob(tess.id);
    expect((await onProposal(view, "always-allow", { operations: [...both, "summoning.self-name"] })).status).toBe(409);
    expect((await hob(tess.id)).configVersion).toBe(before.configVersion);

    const always = await onProposal(view, "always-allow", { operations: both });
    expect(always.status).toBe(200);
    expect([...always.body.proposal.alwaysAllowed].sort()).toEqual(both);
    expect(always.body.changedSince).toEqual([]);
    const after = await hob(tess.id);
    expect(after.configVersion).toBe(before.configVersion + 1);
    expect(after.policy.charms?.overrides).toMatchObject({
      "summoning.self-good-at": "allow",
      "summoning.self-instructions": "allow",
    });
    await decideProposal(asked, "allow-all");
    expect(await hob(tess.id)).toMatchObject({ goodAt: "Tidy notes.", instructions: "Be tidy." });
  });
  // covers STD-DATA-001, ADR 034 (A decision is yours while your device is)
  it("[TC-AG-409-11] a row the hub stopped before it saved what it made is settled from the hob's history when the card is read, even after a later edit", async () => {
    await chiefAnswers({});
    const hire = await turn(chief, hub("summoning_summon", { key: "hire-duo", hobs: [draft("Rook"), draft("Sly")] }));
    await decideProposal(hire, "allow-all");
    const rook = await summonedNamed("Rook");
    const sly = await summonedNamed("Sly");
    /** As if the hub stopped after making `rowId` and before saving it: the row is applying again. */
    const stoppedWhileMaking = (proposalId: string, rowId: string) =>
      hobs.runPromise(
        Effect.gen(function* () {
          const log = yield* HobProposalLog;
          const stored = Option.getOrThrow(yield* log.get(HobProposalId.make(proposalId)));
          const rows = stored.rows.map((each) =>
            each.id === rowId ? { ...each, state: "applying" as const, outcome: null } : each,
          );
          yield* log.move(new HobProposal({ ...stored, rows, state: "open", settledAt: null }));
        }),
      );

    // A change made by the proposal, then an edit of yours: the latest version is yours, not the proposal's.
    await chiefAnswers({ "summoning.instructions": "ask" });
    const retone = await turn(
      chief,
      hub("summoning_change", {
        key: "retone-duo",
        changes: [
          { hob: "Rook", instructions: "Be brief." },
          { hob: "Sly", instructions: "Be brief." },
        ],
      }),
    );
    const view = retone.proposal as HobProposalView;
    const [rookRow] = view.proposal.rows;
    expect((await onProposal(view, `rows/${rookRow?.id}/allow`)).status).toBe(200);
    await stoppedWhileMaking(view.proposal.id, rookRow?.id ?? "");
    expect((await request("PATCH", `/api/agents/${rook.id}`, { goodAt: "Short notes." })).status).toBe(200);
    // Reading the card is enough: the row reads as made, and Deny cannot say nothing was done.
    const read = await proposalOf(view.proposal.id);
    expect(read.proposal.rows[0]).toMatchObject({
      state: "allowed",
      outcome: "Changed instructions, from its next turn.",
    });
    expect((await onProposal(view, `rows/${rookRow?.id}/deny`)).status).toBe(409);
    await decideProposal(retone, "deny-all");

    // A pause made by the proposal, then a wake of yours.
    await chiefAnswers({ "summoning.pause": "ask" });
    const pause = await turn(chief, hub("summoning_pause", { key: "pause-sly", hob: "Sly" }));
    const paused = await decideProposal(pause, "allow-all");
    expect(paused.content).toContain("Sly is paused now.");
    const pauseView = pause.proposal as HobProposalView;
    await stoppedWhileMaking(pauseView.proposal.id, pauseView.proposal.rows[0]?.id ?? "");
    expect((await request("POST", `/api/agents/${sly.id}/wake`)).status).toBe(200);
    const after = await proposalOf(pauseView.proposal.id);
    expect(after.proposal.rows[0]).toMatchObject({ state: "allowed", outcome: "Sly is paused now." });
    expect(after.proposal.state).toBe("settled");
    await chiefAnswers({});
  });
});
