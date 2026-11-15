import { AgentId, ThreadId, ThreadMember } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { campRuntimes } from "./people-sections.tsx";

const now = "2026-11-15T00:00:00.000Z";
const hobMember = (id: string) =>
  new ThreadMember({
    threadId: ThreadId.make("camp"),
    actor: { kind: "hob", id },
    role: "member",
    state: "active",
    joinedAt: now,
    addedBy: { kind: "user", id: "owner" },
    readRevision: null,
    mutedUntil: null,
    revision: 1,
  });
const hobs = [
  { id: AgentId.make("pip"), runtime: "claude-code" as const },
  { id: AgentId.make("quill"), runtime: "codex" as const },
];
const members = [hobMember("pip"), hobMember("quill")];

describe("campRuntimes", () => {
  // covers ADR 039 (Status and cost), ADR 017, #1467
  it("names the plan the camp's own brain spends, else each hob's", () => {
    expect(campRuntimes({ brain: null }, hobs, members)).toEqual(["claude-code", "codex"]);
    expect(campRuntimes({ brain: null }, hobs, [hobMember("pip")])).toEqual(["claude-code"]);
    expect(campRuntimes({ brain: { runtime: "codex", model: null, effort: null } }, hobs, [hobMember("pip")])).toEqual([
      "codex",
    ]);
  });
});
