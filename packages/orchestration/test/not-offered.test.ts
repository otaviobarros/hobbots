import type { SessionToolOffer } from "@hobbots/agents";
import { describe, expect, it } from "vitest";
import { notOfferedWords } from "../src/not-offered.ts";

const OFFER: SessionToolOffer = {
  tools: [
    { tool: "file_reads", from: "the runtime", answer: "allow" },
    { tool: "github_push", from: "the GitHub Charm", answer: "allow" },
  ],
  dropped: [
    { tool: "file_edits", from: "the runtime", reason: "never" },
    { tool: "read_only_commands", from: "the runtime", reason: "no-sandbox" },
    { tool: "github_comment", from: "the GitHub Charm", reason: "never" },
    { tool: "summon_hob", from: "the Summoning Charm", reason: "not-granted" },
  ],
};

const SAID = (tool: string) => `${tool} is not offered in this session, so it did not run.`;

describe("why a call to a tool the session was not offered did not run (#1356)", () => {
  // covers PE-001, ADR 014 (#1356, #1348)
  it("[TC-PE-1356-07] names the reason the session's offer gives, by the tool or the runtime tool it belongs to", () => {
    const why = (tool: string, runtimeTool: "file_reads" | "file_edits" | "commands" | null = null) =>
      notOfferedWords({ tool, runtimeTool }, OFFER, "Rook");
    expect(why("github_comment")).toBe(`${SAID("github_comment")} It is not offered because its answer is Never.`);
    expect(why("summon_hob")).toBe(
      `${SAID("summon_hob")} It is not offered because Rook does not hold the Summoning Charm.`,
    );
    expect(why("Edit", "file_edits")).toBe(`${SAID("Edit")} It is not offered because its answer is Never.`);
    // Read-only commands are the session's commands.
    expect(why("Bash", "commands")).toBe(
      `${SAID("Bash")} It is not offered because Rook's runtime cannot start its sandbox on this hub.`,
    );
    // A tool offered now was added after the session started, as a resumed Codex thread keeps its first tools.
    expect(why("github_push")).toBe(
      `${SAID("github_push")} The session started before it was offered and keeps the tools it started with; a new session gets it.`,
    );
    expect(why("post_to_slack")).toBe(`${SAID("post_to_slack")} Hobbots has no tool by that name for Rook.`);
  });
});
