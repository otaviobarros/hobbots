import { AgentId, type CharmOperation, EMPTY_HOB_POLICY, type HobPolicy, type Thread } from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  changeReach,
  type ReachCharm,
  type RuntimeAdapterShape,
  reachesEverySession,
  reachLines,
  reachOf,
  whenItApplies,
} from "../src/index.ts";

// When a change to a hob applies, and what it opens that some of its sessions still do not get (#1347).

const operation = (id: CharmOperation["id"], words: string): CharmOperation => ({
  id,
  words,
  site: [],
  onceOnly: false,
  actsAsIdentity: false,
  presets: { careful: "ask", balanced: "allow", autonomous: "allow" },
});

/** The Shelf Charm offers its writes only in chats; the Ledger Charm offers them outside chats too (ADR 038). */
const SHELF: ReachCharm = {
  declaration: { id: "shelf", operations: [operation("shelf.write", "writing on the shelf")] },
  name: "Shelf",
  tools: [{ effect: "read" }, { effect: "write", operation: "shelf.write" }],
};
const LEDGER: ReachCharm = {
  declaration: { id: "ledger", operations: [operation("ledger.write", "writing in the ledger")] },
  name: "Ledger",
  tools: [{ effect: "read" }, { effect: "write", operation: "ledger.write" }],
  writesOutsideChats: true,
};
const CHARMS = [SHELF, LEDGER];

const policy = (granted: ReadonlyArray<string>, overrides: HobPolicy["overrides"] = {}): HobPolicy => ({
  ...EMPTY_HOB_POLICY,
  overrides,
  charms: { granted },
});

const reach = (before: HobPolicy, after: HobPolicy, keepsTools: boolean) =>
  changeReach({
    before: { policy: before },
    after: { policy: after },
    preset: "balanced",
    charms: CHARMS,
    keepsTools: keepsTools ? ["codex"] : [],
  });

const NONE = { runtimes: [], charms: [], operations: [], taskOperations: [] };

describe("when a change applies", () => {
  it("says it applies from the hob's next turn, in a chat or a Task, and what a running turn keeps", () => {
    expect(whenItApplies("Thorn")).toBe(
      "Thorn gets this from its next turn, in a chat or a Task. A turn already running finishes the old way, unless this takes something away: then it stops.",
    );
  });

  it("names a Charm write granted to a hob that a Task session is still not offered, with why", () => {
    const granted = reach(policy([]), policy(["shelf", "ledger"]), false);
    expect(granted).toEqual({ chatsOnly: ["shelf"], newSessionsOnly: NONE });
    expect(reachLines({ name: "Thorn" }, granted, CHARMS)).toEqual([
      "In a Task, Thorn is still not offered the Shelf Charm's writes: that Charm offers them only in chats.",
    ]);
    // A Charm write opened from Never on a Charm the hob already holds is named the same way.
    const opened = reach(
      policy(["shelf"], { "shelf.write": "deny" } as HobPolicy["overrides"]),
      policy(["shelf"]),
      false,
    );
    expect(opened.chatsOnly).toEqual(["shelf"]);
  });

  it("names nothing when a Charm offers its writes outside chats, or the change opens nothing", () => {
    const ledger = reach(policy([]), policy(["ledger"]), false);
    expect(reachesEverySession(ledger)).toBe(true);
    expect(reachLines({ name: "Thorn" }, ledger, CHARMS)).toEqual([]);
    // Widening a built-in answer reaches the next turn on a runtime that offers its tools every turn.
    const commands = reach(policy([], { "run-commands": "deny" }), policy([]), false);
    expect(reachesEverySession(commands)).toBe(true);
  });

  it("on a runtime whose resumed session keeps its tools, names the Charms granted and the tools opened", () => {
    const opened = reach(
      policy(["ledger"], {
        "read-hobs": "deny",
        "run-commands": "deny",
        "ledger.write": "deny",
      } as HobPolicy["overrides"]),
      policy(["ledger", "shelf"]),
      true,
    );
    // Run commands offers no hub tool: the hub decides each command on every runtime, so it is not
    // named. A chat was offered the Ledger write already, under Never too, so only a Task misses it.
    expect(opened.newSessionsOnly).toEqual({
      runtimes: ["codex"],
      charms: ["shelf"],
      operations: ["read-hobs"],
      taskOperations: ["ledger.write"],
    });
    expect(reachLines({ name: "Thorn" }, opened, CHARMS)).toEqual([
      "In a Task, Thorn is still not offered the Shelf Charm's writes: that Charm offers them only in chats.",
      "On Codex, a chat or Task Thorn already started keeps the tools it started with, so Thorn gets the Shelf Charm's tools and the tools for reading other hobs only in a chat or Task it starts after this.",
      "On Codex, a Task Thorn already started keeps the tools it started with, so Thorn gets the tools for writing in the ledger only in a Task it starts after this.",
    ]);
  });

  it("names nothing for a Charm answer whose tool every session was already offered", () => {
    // A Charm's reads are offered in a chat and a Task whatever their answer, and a chat-only
    // Charm's writes in a chat, so opening either offers no new tool.
    const read: ReachCharm = {
      declaration: { id: "ledger", operations: [operation("ledger.read", "reading the ledger")] },
      name: "Ledger",
      tools: [{ effect: "read", operation: "ledger.read" }],
      writesOutsideChats: true,
    };
    const opened = changeReach({
      before: { policy: policy(["ledger"], { "ledger.read": "deny" } as HobPolicy["overrides"]) },
      after: { policy: policy(["ledger"]) },
      preset: "balanced",
      charms: [read],
      keepsTools: ["codex"],
    });
    expect(reachesEverySession(opened)).toBe(true);
    expect(opened.newSessionsOnly).toEqual(NONE);
  });

  it("names nothing a narrowing takes away, since a narrowing stops the running turn", () => {
    expect(reachesEverySession(reach(policy(["ledger", "shelf"]), policy([], { "read-hobs": "deny" }), true))).toBe(
      true,
    );
  });

  it("counts the runtime of each of the hob's chats, not only the hob's own runtime", async () => {
    // A Claude Code hob with one chat moved to Codex: that chat resumes with the tools it started with.
    const id = AgentId.make("thorn");
    const threads = [{ brain: { runtime: "codex", model: null, effort: null } }] as unknown as ReadonlyArray<Thread>;
    const adapters = (runtime: string) =>
      (runtime === "codex" ? { resumeKeepsHubTools: true } : {}) as unknown as RuntimeAdapterShape;
    const reachFor = (chats: ReadonlyArray<Thread>) =>
      Effect.runPromise(
        reachOf({
          repo: { listThreads: () => Effect.succeed(chats) } as never,
          setup: { get: Effect.succeed({ safetyPreset: "balanced" }) } as never,
          adapters,
          charms: CHARMS,
        })(
          { policy: policy(["ledger"], { "read-hobs": "deny" }) },
          { policy: policy(["ledger"]), id, runtime: "claude-code" },
        ),
      );
    expect((await reachFor(threads)).newSessionsOnly).toEqual({
      ...NONE,
      runtimes: ["codex"],
      operations: ["read-hobs"],
    });
    expect(reachesEverySession(await reachFor([]))).toBe(true);
  });
});
