import { AgentId, CharmCall, type CharmDeclaration, EMPTY_HOB_POLICY, MessageId } from "@hobbots/domain";
import { Cause, Effect, Exit, Layer, Schedule, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type AskableVerdict,
  type Charm,
  Charms,
  type CharmTurn,
  defineCharm,
  HUB_TOOL_NAME_MAX,
  type HubTools,
  hubAction,
  hubCallStep,
  joinHubTools,
  makeRedactor,
  type ToolAccess,
} from "../src/index.ts";
import { charmToolsFor, memoryCharmCalls } from "../src/testing.ts";

// The Charm registry (ADR 031), with two fake Charms, Pip and Rook, each with a read and a write.

const set = (owner: string, names: ReadonlyArray<string>): HubTools => ({
  tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object" }, label: name })),
  call: (name) => Effect.succeed({ text: `${owner} ${name}`, refused: false }),
});

const allowed = (operation: `${string}.${string}`): AskableVerdict => ({
  decision: "allow",
  operation,
  reason: { message: "The policy allows it." },
  targets: [],
  onceOnly: false,
  grantable: false,
  rules: [],
  grantIds: [],
  policyVersion: "v1",
});

const declaration = (id: string): CharmDeclaration => ({
  id,
  operations: ["read", "write"].map((operation) => ({
    id: `${id}.${operation}` as const,
    words: `${operation} with ${id}`,
    presets: { careful: "allow", balanced: "allow", trusting: "allow" },
    site: [],
    onceOnly: false,
    actsAsIdentity: false,
  })),
  takesOver: [],
});

const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" }, label: name });

interface FakeCharm {
  readonly id: string;
  readonly name: string;
  /** Its tools' names, `<id>_read` and `<id>_write` unless given. */
  readonly read?: string;
  readonly write?: string;
  readonly connected?: boolean;
}

/** A Charm whose read answers its name, and whose write ends uncertain and is found applied when read back. */
const fakeCharm = (charm: FakeCharm): Effect.Effect<Charm> => {
  const prefix = charm.id.replaceAll("-", "_");
  const read = charm.read ?? `${prefix}_read`;
  const write = charm.write ?? `${prefix}_write`;
  const request = (operation: string) => ({
    _tag: "Charm",
    charm: charm.id,
    operation: `${charm.id}.${operation}`,
    site: {},
  });
  return Effect.succeed(
    defineCharm({
      declaration: declaration(charm.id),
      name: charm.name,
      actions: [
        hubAction({
          tool: tool(read),
          input: Schema.Struct({}),
          effect: "read",
          otherwise: `${charm.name} cannot be read`,
          plan: () => Effect.succeed({ request: request("read"), card: { arguments: {} }, send: Effect.succeed(read) }),
        }),
        hubAction({
          tool: tool(write),
          input: Schema.Struct({}),
          effect: "write",
          otherwise: `nothing was written to ${charm.name}`,
          readBack: () => Effect.succeed(true),
          plan: () =>
            Effect.succeed({
              request: request("write"),
              card: { arguments: {} },
              write: {
                site: charm.id,
                recorded: {},
                appliedText: `${charm.name} shows it took effect.`,
                send: Effect.succeed({ _tag: "Uncertain", text: "No answer." } as const),
              },
            }),
        }),
      ],
      decide: (_approvals, _base, planned) => () => Effect.succeed(allowed(planned.operation as `${string}.${string}`)),
      connected: () => Effect.succeed(charm.connected ?? true),
    }),
  );
};

const PIP = fakeCharm({ id: "pip", name: "Pip" });
const ROOK = fakeCharm({ id: "rook", name: "Rook" });

const access = (granted: ReadonlyArray<string>): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: [],
    hob: { ...EMPTY_HOB_POLICY, charms: { granted } },
    dataFolder: "/data",
    restrictions: [],
    charmOperations: [],
  },
  folders: [],
  runtimeFolder: "/runtimes/hob",
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

const turn = (granted: ReadonlyArray<string> | null): CharmTurn => ({
  agentId: AgentId.make("hob"),
  threadId: null,
  messageId: MessageId.make("m1"),
  scope: () => "reply:m1",
  currentAccess: Effect.succeed(granted === null ? null : access(granted)),
  redactor: makeRedactor(),
  approvals: null,
});

/** What registering `charms` stopped the hub with, or null when it started. */
const registering = (charms: ReadonlyArray<Effect.Effect<Charm>>) =>
  Effect.gen(function* () {
    yield* Charms;
  }).pipe(
    Effect.provide(Charms.layer(charms).pipe(Layer.provide(memoryCharmCalls()))),
    Effect.exit,
    Effect.map((exit) => (Exit.isSuccess(exit) ? null : Cause.pretty(exit.cause))),
    Effect.runPromise,
  );

const stored = (tool: string, charm: string, key: string) =>
  new CharmCall({
    agentId: AgentId.make("hob"),
    scope: "reply:m0",
    key,
    attempt: `${key}-1`,
    charm,
    tool,
    input: "{}",
    site: key,
    plan: "{}",
    appliedText: `${charm} shows it took effect.`,
    state: "sending",
    result: null,
    threadId: null,
    messageId: null,
    stepId: null,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
  });

describe("joined hub tools", () => {
  // covers PE-002, ADR 031
  it("[TC-PE-500] offers every set's tools in order, sends each call to its set, and refuses a name two sets offer", async () => {
    expect(joinHubTools([])).toBeNull();
    expect(joinHubTools([{ owner: "Memory", tools: null }])).toBeNull();
    const tasks = set("tasks", ["plan_steps"]);
    expect(joinHubTools([{ owner: "the Task tools", tools: tasks }])).toBe(tasks);
    const both = joinHubTools([
      { owner: "the Task tools", tools: tasks },
      { owner: "Memory", tools: null },
      { owner: "the GitHub Charm", tools: set("github", ["github_search"]) },
    ]) as HubTools;
    expect(both.tools.map((each) => each.name)).toEqual(["plan_steps", "github_search"]);
    const answer = (name: string) => Effect.runPromise(both.call(name, {})).then((a) => a.text);
    expect(await answer("github_search")).toBe("github github_search");
    expect(await answer("plan_steps")).toBe("tasks plan_steps");
    // A tool nobody offers goes to the first set, which refuses it in its own words.
    expect(await answer("nothing")).toBe("tasks nothing");
    // A name two sets offer is never given to either: it names both.
    expect(() =>
      joinHubTools([
        { owner: "the Task tools", tools: set("tasks", ["plan_steps", "shared"]) },
        { owner: "the GitHub Charm", tools: set("github", ["shared"]) },
      ]),
    ).toThrow("The hub tool shared is offered by both the Task tools and the GitHub Charm.");
  });
});

describe("the Charm registry (ADR 031)", () => {
  // covers PE-002, PE-005, ADR 031
  it("[TC-PE-501] serves a hob each Charm it holds that is connected, each as its own list", async () => {
    const offered = (granted: ReadonlyArray<string> | null, writes?: boolean) =>
      Effect.gen(function* () {
        const sets = yield* (yield* Charms).forTurn(turn(granted), writes === undefined ? undefined : { writes });
        return sets.map((each) => [each.owner, each.tools?.tools.map((t) => t.name) ?? []]);
      }).pipe(
        Effect.provide(
          Charms.layer([PIP, ROOK, fakeCharm({ id: "lark", name: "Lark", connected: false })]).pipe(
            Layer.provide(memoryCharmCalls()),
          ),
        ),
        Effect.runPromise,
      );

    expect(await offered(["pip", "rook"])).toEqual([
      ["the Pip Charm", ["pip_read", "pip_write"]],
      ["the Rook Charm", ["rook_read", "rook_write"]],
    ]);
    expect(await offered(["rook"])).toEqual([["the Rook Charm", ["rook_read", "rook_write"]]]);
    // A Charm that is not connected, one the hob does not hold, and a turn without tools offer nothing.
    expect(await offered(["lark", "github"])).toEqual([]);
    expect(await offered(null)).toEqual([]);
    // A session with no reply to settle a write on is offered only the reads.
    expect(await offered(["pip"], false)).toEqual([["the Pip Charm", ["pip_read"]]]);

    // A call reaches the Charm that offers its tool, through the pipeline.
    const answers = await Effect.gen(function* () {
      const tools = (yield* charmToolsFor(turn(["pip", "rook"]))) as HubTools;
      return [
        yield* tools.call(
          "rook_read",
          {},
          hubCallStep("toolu_1", () => {}),
        ),
      ];
    }).pipe(Effect.provide(Charms.layer([PIP, ROOK]).pipe(Layer.provide(memoryCharmCalls()))), Effect.runPromise);
    expect(answers[0]?.refused).toBe(false);
    expect(answers[0]?.text).toContain("rook_read");
  });

  // covers PE-002, ADR 031
  it("[TC-PE-502] stops the hub on a tool name two owners share, naming both, or a name over 64 characters, naming it", async () => {
    expect(await registering([PIP, ROOK])).toBeNull();

    const twice = await registering([
      PIP,
      fakeCharm({ id: "rook", name: "Rook", read: "rook_read", write: "rook_read" }),
    ]);
    expect(twice).toContain("The hub tool rook_read is offered twice by the Rook Charm.");
    const shared = await registering([
      fakeCharm({ id: "pip", name: "Pip", read: "pip_shelf_read" }),
      fakeCharm({ id: "pip-shelf", name: "Pip's Shelf" }),
    ]);
    expect(shared).toContain("The hub tool pip_shelf_read is offered by both the Pip Charm and the Pip's Shelf Charm.");
    // A new Charm's tools are named `<charm>_<action>`.
    const misnamed = await registering([fakeCharm({ id: "rook", name: "Rook", read: "pip_read" })]);
    expect(misnamed).toContain("The Rook Charm's tool pip_read does not start with rook_.");
    // A Charm may not take a built-in hub tool's name.
    const memory = await registering([fakeCharm({ id: "memory", name: "Memories", read: "memory_search" })]);
    expect(memory).toContain("The hub tool memory_search is offered by both Memory and the Memories Charm.");
    const tasks = await registering([fakeCharm({ id: "plan", name: "Planner", read: "plan_steps" })]);
    expect(tasks).toContain("The hub tool plan_steps is offered by both the Task tools and the Planner Charm.");

    // 64 characters is the longest name; one more is refused, never cut.
    const longest = `pip_${"r".repeat(HUB_TOOL_NAME_MAX - 4)}`;
    expect(await registering([fakeCharm({ id: "pip", name: "Pip", read: longest })])).toBeNull();
    const over = `${longest}x`;
    const long = await registering([fakeCharm({ id: "pip", name: "Pip", read: over })]);
    expect(long).toContain(`The hub tool name ${over}, from the Pip Charm, is longer than 64 characters.`);
  });

  // covers EX-003, EX-004, ADR 031
  it("[TC-PE-503] runs every Charm's writes and reads back every Charm's unsettled calls with one never-twice runner", async () => {
    const rows = new Map<string, CharmCall>();
    // Calls the hub left in flight when it last stopped, one of each Charm's.
    rows.set("hob reply:m0 left-pip", stored("pip_write", "Pip", "left-pip"));
    rows.set("hob reply:m0 left-rook", stored("rook_write", "Rook", "left-rook"));
    const answers = await Effect.gen(function* () {
      // The startup scan settles both, each by its own Charm's read-back.
      yield* Effect.suspend(() =>
        [...rows.values()].every((row) => row.state === "applied") ? Effect.void : Effect.fail("reading back"),
      ).pipe(Effect.retry(Schedule.spaced("5 millis")));
      const tools = (yield* charmToolsFor(turn(["pip", "rook"]))) as HubTools;
      const step = (id: string) => hubCallStep(id, () => {});
      return [
        yield* tools.call("pip_write", { key: "k1" }, step("toolu_1")),
        yield* tools.call("rook_write", { key: "k2" }, step("toolu_2")),
      ];
    }).pipe(Effect.provide(Charms.layer([PIP, ROOK]).pipe(Layer.provide(memoryCharmCalls(rows)))), Effect.runPromise);

    expect(answers.map((answer) => answer.text)).toEqual(["Pip shows it took effect.", "Rook shows it took effect."]);
    // Each call names its own Charm, and the one runner kept them apart by tool.
    const calls = [...rows.values()].map((row) => [row.key, row.charm, row.tool, row.state]);
    expect(calls).toEqual([
      ["left-pip", "Pip", "pip_write", "applied"],
      ["left-rook", "Rook", "rook_write", "applied"],
      ["k1", "Pip", "pip_write", "applied"],
      ["k2", "Rook", "rook_write", "applied"],
    ]);
  });
});
