import { describe, expect, it } from "vitest";
import { reachLines } from "./change-reach-model.ts";

const NOTHING = {
  chatsOnly: [],
  newSessionsOnly: { runtimes: [], charms: [], operations: [], taskOperations: [] },
};

describe("what a saved change still does not reach (#1347)", () => {
  it("names nothing when the change reaches every session", () => {
    expect(reachLines({ name: "Thorn" }, NOTHING)).toEqual([]);
    expect(reachLines({ name: "Thorn" }, undefined)).toEqual([]);
  });

  it("names a Charm whose writes a Task session is not offered, and what a Codex session started before misses", () => {
    expect(
      reachLines(
        { name: "Thorn" },
        {
          chatsOnly: ["shelf"],
          newSessionsOnly: {
            runtimes: ["codex"],
            charms: ["github"],
            operations: ["read-hobs", "use-web"],
            taskOperations: ["github.comment"],
          },
        },
      ),
    ).toEqual([
      "In a Task, Thorn is still not offered the Shelf Charm's writes: that Charm offers them only in chats.",
      "On Codex, a chat or Task Thorn already started keeps the tools it started with, so Thorn gets the GitHub Charm's tools and the tools of Read other hobs and Use the web only in a chat or Task it starts after this.",
      "On Codex, a Task Thorn already started keeps the tools it started with, so Thorn gets the tools of Comment on GitHub only in a Task it starts after this.",
    ]);
  });
});
