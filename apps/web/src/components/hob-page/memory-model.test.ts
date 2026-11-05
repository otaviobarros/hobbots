import { Agent, AgentId, MemoryPath, memoryProjectIdentity } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { learnedLately, ownCount, readRows } from "./memory-model.ts";

const pip = new Agent({
  id: AgentId.make("pip"),
  name: "Pip",
  roleTitle: "Writer",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
  lookSeed: 1,
  lookColor: "moss",
  configVersion: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
});
const own = { _tag: "Hob", agentId: pip.id } as const;
const page = (path: string, updatedAt: string, pinned = false) => ({
  scope: own,
  path: MemoryPath.make(path),
  title: path,
  pinned,
  updatedAt,
});

describe("learnedLately", () => {
  it("lists the pages changed last, newest first, pinned or not, with their kinds", () => {
    const lately = learnedLately([
      page("howtos/old.md", "2026-11-01T00:00:00.000Z", true),
      page("gotchas/new.md", "2026-11-04T00:00:00.000Z"),
      page("decisions/mid.md", "2026-11-03T00:00:00.000Z"),
      page("notes.md", "2026-11-02T00:00:00.000Z"),
    ]);
    expect(lately.map((entry) => [entry.path, entry.kind])).toEqual([
      ["gotchas/new.md", "gotcha"],
      ["decisions/mid.md", "decision"],
      ["notes.md", "note"],
    ]);
  });
});

describe("readRows", () => {
  it("names each scope the hob reads, in the hub's order, with its count", () => {
    const site = { _tag: "Project", identity: memoryProjectIdentity("git@github.com:me/site.git", "site") } as const;
    const scopes = [
      { scope: own, pages: 24 },
      { scope: { _tag: "Everyone" } as const, pages: 7 },
      { scope: site, pages: 18 },
    ];
    expect(readRows(scopes, pip).map((row) => [row.title, row.pages])).toEqual([
      ["Its own memory", 24],
      ["About you", 7],
      ["site project", 18],
    ]);
    expect(ownCount(scopes)).toBe(24);
    expect(ownCount(undefined)).toBeUndefined();
  });
});
