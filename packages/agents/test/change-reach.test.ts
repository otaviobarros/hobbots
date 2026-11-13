import { type CharmOperation, EMPTY_HOB_POLICY, type HobPolicy } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { changeReach, type ReachCharm, reachesEverySession, reachLines, whenItApplies } from "../src/index.ts";

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
    before: { runtime: keepsTools ? "codex" : "claude-code", policy: before },
    after: { runtime: keepsTools ? "codex" : "claude-code", policy: after },
    preset: "balanced",
    charms: CHARMS,
    keepsTools,
  });

describe("when a change applies", () => {
  it("says it applies from the hob's next turn, in a chat or a Task, and what a running turn keeps", () => {
    expect(whenItApplies("Thorn")).toBe(
      "Thorn gets this from its next turn, in a chat or a Task. A turn already running finishes the old way, unless this takes something away: then it stops.",
    );
  });

  it("names a Charm write granted to a hob that a Task session is still not offered, with why", () => {
    const granted = reach(policy([]), policy(["shelf", "ledger"]), false);
    expect(granted).toEqual({ chatsOnly: ["shelf"], newSessionsOnly: { charms: [], operations: [] } });
    expect(reachLines({ name: "Thorn", runtime: "claude-code" }, granted, CHARMS)).toEqual([
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
    expect(reachLines({ name: "Thorn", runtime: "claude-code" }, ledger, CHARMS)).toEqual([]);
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
    // Run commands offers no hub tool: the hub decides each command on every runtime, so it is not named.
    expect(opened.newSessionsOnly).toEqual({ charms: ["shelf"], operations: ["read-hobs", "ledger.write"] });
    expect(reachLines({ name: "Thorn", runtime: "codex" }, opened, CHARMS)).toEqual([
      "In a Task, Thorn is still not offered the Shelf Charm's writes: that Charm offers them only in chats.",
      "Thorn runs on Codex, where a chat or Task already started keeps the tools it started with, so the Shelf Charm's tools, reading other hobs, and writing in the ledger reach Thorn only in a chat or Task it starts after this.",
    ]);
  });

  it("names nothing a narrowing takes away, since a narrowing stops the running turn", () => {
    expect(reachesEverySession(reach(policy(["ledger", "shelf"]), policy([], { "read-hobs": "deny" }), true))).toBe(
      true,
    );
  });
});
