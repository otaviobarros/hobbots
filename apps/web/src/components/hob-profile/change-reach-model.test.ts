import { describe, expect, it } from "vitest";
import { reachLines } from "./change-reach-model.ts";

const NOTHING = { chatsOnly: [], newSessionsOnly: { charms: [], operations: [] } };

describe("what a saved change still does not reach (#1347)", () => {
  it("names nothing when the change reaches every session", () => {
    expect(reachLines({ name: "Thorn", runtime: "claude-code" }, NOTHING)).toEqual([]);
    expect(reachLines({ name: "Thorn", runtime: "claude-code" }, undefined)).toEqual([]);
  });

  it("names a Charm whose writes a Task session is not offered, and what a Codex session started before misses", () => {
    expect(
      reachLines(
        { name: "Thorn", runtime: "codex" },
        { chatsOnly: ["shelf"], newSessionsOnly: { charms: ["github"], operations: ["read-hobs", "use-web"] } },
      ),
    ).toEqual([
      "In a Task, Thorn is still not offered the Shelf Charm's writes: that Charm offers them only in chats.",
      "Thorn runs on Codex, where a chat or Task already started keeps the tools it started with, so the GitHub Charm's tools and the tools of Read other hobs and Use the web reach Thorn only in a chat or Task it starts after this.",
    ]);
  });
});
