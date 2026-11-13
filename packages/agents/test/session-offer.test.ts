import { AgentId, declaredOperations, EMPTY_HOB_POLICY, type PolicyDecision } from "@hobbots/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { type Charm, Charms, describeSessionOffer, type ToolAccess } from "../src/index.ts";
import { fakeCharm, fakeCharmDeclaration, memoryCharmCalls } from "../src/testing.ts";

// What a member's session outside any chat is offered, described for its lead (#1348): each tool
// with its answer, and each tool it lacks with why, from fake Charms Pip, Rook and Lark.

const outside = (charm: Effect.Effect<Charm>, writes: boolean) =>
  Effect.map(
    charm,
    (each): Charm => ({
      ...each,
      writesOutsideChats: writes,
      tools: each.tools.map((tool) => ({ ...tool, operation: `${each.declaration.id}.${tool.effect}` as const })),
    }),
  );

const CHARMS = [
  outside(fakeCharm({ id: "pip", name: "Pip" }), false),
  outside(fakeCharm({ id: "rook", name: "Rook" }), true),
  fakeCharm({ id: "lark", name: "Lark", connected: false }),
];

const access = (
  folders: ReadonlyArray<string>,
  overrides: Readonly<Record<string, PolicyDecision>> = {},
  charms: Readonly<Record<string, PolicyDecision>> = {},
): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: [],
    hob: { ...EMPTY_HOB_POLICY, overrides, charms: { granted: ["pip", "rook", "lark"], overrides: charms } },
    dataFolder: "/data",
    restrictions: [],
    charmOperations: declaredOperations(["pip", "rook", "lark"].map((id) => fakeCharmDeclaration(id))),
  },
  folders,
  runtimeFolder: "/runtimes/hob",
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

const describeFor = (given: ToolAccess | null, offered: ReadonlyArray<string>, charms = CHARMS) =>
  Effect.gen(function* () {
    const describe = yield* describeSessionOffer;
    return yield* describe({ agentId: AgentId.make("hob"), access: given, offered });
  }).pipe(Effect.provide(Charms.layer(charms).pipe(Layer.provide(memoryCharmCalls()))), Effect.runPromise);

describe("a member's session offer, described for its lead (#1348)", () => {
  // covers PE-005, OR-002, ADR 014 (Amendment: what a delegation tells its lead)
  it("[TC-PE-1348-01] gives each offered tool its answer, and each tool it lacks a reason", async () => {
    const { tools, dropped } = await describeFor(access(["/work"], { "edit-files": "ask" }, { "rook.write": "ask" }), [
      "pip_read",
      "rook_read",
      "rook_write",
      "git_init",
      "complete_task",
    ]);
    expect(tools).toEqual([
      { tool: "file_reads", from: "the runtime", answer: "allow" },
      { tool: "file_edits", from: "the runtime", answer: "ask" },
      { tool: "pip_read", from: "the Pip Charm", answer: "allow" },
      { tool: "rook_read", from: "the Rook Charm", answer: "allow" },
      { tool: "rook_write", from: "the Rook Charm", answer: "ask" },
      { tool: "git_init", from: "Local Git", answer: "allow" },
      { tool: "complete_task", from: "the Task tools", answer: "allow" },
    ]);
    // Commands close under Edit files Ask; Pip offers its writes only in chats; Lark is not connected.
    expect(dropped).toEqual([
      { tool: "commands", from: "the runtime", reason: "commands-closed" },
      { tool: "pip_write", from: "the Pip Charm", reason: "chats-only" },
      { tool: "lark_read", from: "the Lark Charm", reason: "not-connected" },
      { tool: "lark_write", from: "the Lark Charm", reason: "not-connected" },
    ]);
  });

  // covers PE-005, ADR 031, ADR 038
  it("[TC-PE-1348-02] names Never answers, Charms the hob does not hold, and a session with no folder", async () => {
    const never = await describeFor(access(["/work"], { "use-web": "deny" }, { "rook.write": "deny" }), [
      "rook_read",
      "pip_read",
    ]);
    expect(never.dropped).toEqual(
      expect.arrayContaining([
        { tool: "rook_write", from: "the Rook Charm", reason: "never" },
        { tool: "web_fetch", from: "the Web tools", reason: "never" },
      ]),
    );
    const ungranted = {
      ...access([]),
      policy: { ...access([]).policy, hob: { ...EMPTY_HOB_POLICY, charms: { granted: [] } } },
    };
    const none = await describeFor(ungranted, ["complete_task"]);
    expect(none.tools).toEqual([{ tool: "complete_task", from: "the Task tools", answer: "allow" }]);
    expect(none.dropped).toEqual(
      expect.arrayContaining([
        { tool: "file_reads", from: "the runtime", reason: "chat-only" },
        { tool: "pip_read", from: "the Pip Charm", reason: "not-granted" },
        { tool: "rook_write", from: "the Rook Charm", reason: "not-granted" },
        { tool: "git_init", from: "Local Git", reason: "chat-only" },
      ]),
    );
    // A hob without tools is offered none of them, and every Charm reads as not granted.
    const nothing = await describeFor(null, []);
    expect(nothing.tools).toEqual([]);
    expect(nothing.dropped.map((tool) => tool.reason)).not.toContain("not-connected");
  });
});
