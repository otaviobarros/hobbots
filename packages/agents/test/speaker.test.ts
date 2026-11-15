import { Agent, AgentId, mainLine, Thread, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { speakerIn } from "../src/speaker.ts";

// Issue #1549 (ADR 039, One hob speaks at a time; STD-ARCH-021): a turn's hob is its speaker,
// which in a camp need not be the hob the camp belongs to.

const NOW = "2026-11-14T00:00:00.000Z";
const hob = (id: string, name: string) =>
  new Agent({
    id: AgentId.make(id),
    name,
    roleTitle: "Writer",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
    lookSeed: 1,
    lookColor: "moss",
    configVersion: 1,
    createdAt: NOW,
  });
const WREN = hob("wren", "Wren");
const QUILL = hob("quill", "Quill");
const camp = new Thread({
  id: ThreadId.make("camp"),
  agentId: WREN.id,
  title: "Market",
  kind: "camp",
  createdAt: NOW,
  updatedAt: NOW,
});

describe("a turn's speaker", () => {
  // covers ADR 039 (One hob speaks at a time)
  it("names the hob that speaks, its line and reason, and whether the camp is its own (#1549)", () => {
    const reason = { cause: "mention", by: { kind: "user", id: "leo" } } as const;
    expect(speakerIn(camp, QUILL, reason)).toEqual({
      thread: camp,
      line: mainLine(camp.id),
      agent: QUILL,
      reason,
      role: "member",
    });
    expect(speakerIn(camp, WREN)).toMatchObject({ agent: WREN, reason: null, role: "owner" });
  });
});
