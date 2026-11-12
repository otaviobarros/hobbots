import { AgentId, CharmCall, EMPTY_HOB_POLICY, MessageId } from "@hobbots/domain";
import { Cause, Effect, Exit, Layer, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import {
  Charms,
  type CharmTurn,
  HUB_TOOL_NAME_MAX,
  type HubTools,
  hubCallStep,
  hubToolOffer,
  joinHubTools,
  makeRedactor,
  type Takeover,
  type ToolAccess,
} from "../src/index.ts";
import { charmTakeoversFor, charmToolsFor, fakeCharm, memoryCharmCalls } from "../src/testing.ts";

// The Charm registry (ADR 031), with two fake Charms, Pip and Rook, each with a read and a write.

const set = (owner: string, names: ReadonlyArray<string>): HubTools => ({
  tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object" }, label: name })),
  call: (name) => Effect.succeed({ text: `${owner} ${name}`, refused: false }),
});

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
    // A Charm whose every write reads back from the hub's own records offers its writes there too (ADR 034).
    const outside = await Effect.gen(function* () {
      const sets = yield* (yield* Charms).forTurn(turn(["pip"]), { writes: false });
      return sets.map((each) => each.tools?.tools.map((t) => t.name) ?? []);
    }).pipe(
      Effect.provide(
        Charms.layer([Effect.map(PIP, (pip) => ({ ...pip, writesOutsideChats: true }))]).pipe(
          Layer.provide(memoryCharmCalls()),
        ),
      ),
      Effect.runPromise,
    );
    expect(outside).toEqual([["pip_read", "pip_write"]]);

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

  // covers PE-005, ADR 038
  it("[TC-PE-1343-01] offers a session outside any chat the writes of a Charm that offers them there, and steers a push only to a write it offers", async () => {
    const pushing = (outside: boolean) =>
      Effect.map(
        fakeCharm({ id: "rook", name: "Rook", pushesFrom: ["/work/site"] }),
        (rook): Charm => ({ ...rook, writesOutsideChats: outside }),
      );
    const outsideAChat = (charms: ReadonlyArray<Effect.Effect<Charm>>) =>
      Effect.gen(function* () {
        const sets = yield* (yield* Charms).forTurn(turn(["pip", "rook"]), { writes: false });
        return sets.map((each) => ({
          owner: each.owner,
          tools: each.tools?.tools.map((t) => t.name) ?? [],
          steers: (each.takeovers ?? []).map((takeover) => `${takeover.operation} to ${takeover.tool}`),
        }));
      }).pipe(Effect.provide(Charms.layer(charms).pipe(Layer.provide(memoryCharmCalls()))), Effect.runPromise);

    // A Charm that offers its writes outside chats, as the GitHub Charm does, is offered whole, and
    // steers a push to its write as in a chat. One that does not keeps its writes and steering to chats.
    expect(await outsideAChat([PIP, pushing(true)])).toEqual([
      { owner: "the Pip Charm", tools: ["pip_read"], steers: [] },
      { owner: "the Rook Charm", tools: ["rook_read", "rook_write"], steers: ["push to rook_write"] },
    ]);
    expect(await outsideAChat([pushing(false)])).toEqual([
      { owner: "the Rook Charm", tools: ["rook_read"], steers: [] },
    ]);

    // A write the hob's policy answers Never for is not offered there, and nothing is steered to it.
    const never = await Effect.gen(function* () {
      const policy = access(["rook"]);
      const denied = {
        ...turn(["rook"]),
        currentAccess: Effect.succeed({
          ...policy,
          policy: {
            ...policy.policy,
            hob: { ...policy.policy.hob, charms: { granted: ["rook"], overrides: { "rook.write": "deny" } } },
          },
        }),
      } satisfies CharmTurn;
      const sets = yield* (yield* Charms).forTurn(denied, { writes: false });
      return sets.map((each) => [each.tools?.tools.map((t) => t.name), each.takeovers?.length ?? 0]);
    }).pipe(
      Effect.provide(
        Charms.layer([
          Effect.map(
            pushing(true),
            (rook): Charm => ({
              ...rook,
              tools: rook.tools.map((tool) =>
                tool.effect === "write" ? { ...tool, operation: "rook.write" as const } : tool,
              ),
            }),
          ),
        ]).pipe(Layer.provide(memoryCharmCalls())),
      ),
      Effect.runPromise,
    );
    expect(never).toEqual([[["rook_read"], 0]]);
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
    // Writes offered outside chats must each read back, since no reply step can settle them there.
    const unread = await registering([
      Effect.map(ROOK, (rook) => ({ ...rook, writesOutsideChats: true, readBacks: {} })),
    ]);
    expect(unread).toContain(
      "The Rook Charm offers its writes outside chats, but its tool rook_write reads nothing back.",
    );
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

  // covers PE-005, ADR 031
  it("[TC-PE-512] steers the built-in requests a held Charm takes over, from its declaration alone", async () => {
    const pushing = fakeCharm({ id: "rook", name: "Rook", pushesFrom: ["/work/site"] });
    const takeovers = (granted: ReadonlyArray<string> | null, connected = true) =>
      Effect.gen(function* () {
        const found = yield* charmTakeoversFor(turn(granted));
        const offer = yield* (yield* hubToolOffer)(turn(granted));
        // The offer a runtime gets steers exactly what the registry exposes.
        const named = (each: Takeover) => [each.operation, each.charm, each.tool];
        expect((offer.steering?.takeovers ?? []).map(named)).toEqual(found.map(named));
        return yield* Effect.forEach(found, (each) =>
          Effect.map(
            Effect.all([
              each.appliesIn("/work/site"),
              each.appliesIn("/work/site/docs"),
              each.appliesIn("/work/other"),
            ]),
            (applies) => ({ operation: each.operation, charm: each.charm, tool: each.tool, applies }),
          ),
        );
      }).pipe(
        Effect.provide(
          Charms.layer([
            PIP,
            connected ? pushing : fakeCharm({ id: "rook", name: "Rook", connected: false, pushesFrom: [] }),
          ]).pipe(Layer.provide(memoryCharmCalls())),
        ),
        Effect.runPromise,
      );

    expect(await takeovers(["pip", "rook"])).toEqual([
      { operation: "push", charm: "Rook", tool: "rook_write", applies: [true, true, false] },
    ]);
    // A Charm the hob does not hold, or that is not connected, steers nothing, nor does a Charm that takes nothing over.
    expect(await takeovers(["pip"])).toEqual([]);
    expect(await takeovers(["pip", "rook"], false)).toEqual([]);
    expect(await takeovers(null)).toEqual([]);

    // A takeover the declaration does not name, a second of one request, or one to a tool the Charm
    // does not offer stops the hub.
    const steering = (takeovers: Charm["takeovers"]) =>
      registering([Effect.map(PIP, (charm): Charm => ({ ...charm, takeovers }))]);
    const push = { operation: "push", tool: "pip_write", appliesIn: () => Effect.succeed(true) } as const;
    expect(await steering([push])).toContain("The Pip Charm steers push, which it does not take over.");
    const declared = (takeovers: Charm["takeovers"]) =>
      registering([
        Effect.map(fakeCharm({ id: "pip", name: "Pip", pushesFrom: [] }), (charm): Charm => ({ ...charm, takeovers })),
      ]);
    expect(await declared([push])).toBeNull();
    expect(await declared([push, push])).toContain("The Pip Charm steers push twice.");
    expect(await declared([{ ...push, tool: "github_push" }])).toContain(
      "The Pip Charm steers push to github_push, which it does not offer.",
    );
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
