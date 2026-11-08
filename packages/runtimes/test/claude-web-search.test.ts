import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { type PromptRequest, type RuntimeEvent, type ToolAccess, WEB_RESULTS_LINE } from "@hobbots/agents";
import { EMPTY_HOB_POLICY, type HobPolicy } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { policyHooks, searchCount, toolTurn, wholeTurn } from "../src/claude-code.ts";

// Claude Code's own WebSearch, decided as Search the web (ADR 036, #1266).

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-search-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, "project");
mkdirSync(project);

const engine = Effect.runSync(Effect.service(PolicyEngine).pipe(Effect.provide(PolicyEngine.node)));

const access = (hob: HobPolicy = EMPTY_HOB_POLICY): ToolAccess => ({
  policy: { preset: "balanced", sharedFolders: [project], hob, dataFolder: join(root, "data"), restrictions: [] },
  folders: [project],
  runtimeFolder: join(root, "runtimes", "hob-1"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});
const NEVER: HobPolicy = { ...EMPTY_HOB_POLICY, overrides: { "search-web": "deny" } };

const RESPONSE = {
  query: "hobbots releases",
  results: [{ tool_use_id: "srv", content: [{ title: "Releases", url: "https://example.com/r" }] }, "Found one."],
  durationSeconds: 1,
};

/** Runs one WebSearch call through the hooks as Claude Code would. */
const search = async (hob: HobPolicy = EMPTY_HOB_POLICY, recordSearch?: PromptRequest["recordSearch"]) => {
  const turn = toolTurn(access(hob), "on", { webSearch: true });
  if (turn === null) throw new Error("expected a tool turn");
  const events: Array<RuntimeEvent> = [];
  const { hooks } = policyHooks(
    engine,
    turn,
    (event) => events.push(event),
    null,
    null,
    undefined,
    undefined,
    undefined,
    recordSearch,
  );
  const signal = new AbortController().signal;
  const base = {
    session_id: "s",
    transcript_path: "",
    cwd: project,
    tool_name: "WebSearch",
    tool_input: { query: "hobbots releases" },
    tool_use_id: "t1",
  };
  const pre = await hooks.PreToolUse?.[0]?.hooks[0]?.({ ...base, hook_event_name: "PreToolUse" } as HookInput, "t1", {
    signal,
  });
  const decision = (pre as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision;
  const post =
    decision === "allow"
      ? await hooks.PostToolUse?.[0]?.hooks[0]?.(
          { ...base, hook_event_name: "PostToolUse", tool_response: RESPONSE } as HookInput,
          "t1",
          { signal },
        )
      : undefined;
  const note = (post as { hookSpecificOutput?: { additionalContext?: string } } | undefined)?.hookSpecificOutput
    ?.additionalContext;
  return { decision, events, note };
};

describe("Claude Code's web search", () => {
  // covers ADR 036
  it("[TC-RT-1289-01] records a search's results with the turn's recorder before the hook returns and reports the search", async () => {
    const order: Array<string> = [];
    const done = await search(EMPTY_HOB_POLICY, (event) =>
      // Slow on purpose, as a found set written to a busy database would be.
      Effect.sleep("100 millis").pipe(
        Effect.andThen(Effect.sync(() => order.push(`found ${event.results?.map((hit) => hit.url).join(" ")}`))),
      ),
    );
    order.push("returned");
    expect(order).toEqual(["found https://example.com/r", "returned"]);
    expect(done.events.filter((event) => event._tag === "WebSearched")).toHaveLength(1);
  });

  // covers ADR 036
  it("[TC-RT-1266-05] offers WebSearch only to a turn the hub let search and a hob allowed to, and never WebFetch", () => {
    expect(toolTurn(access(), "on", { webSearch: true })?.tools).toContain("WebSearch");
    expect(toolTurn(access(), "on", { webSearch: true })?.webSearch).toBe(true);
    for (const turn of [toolTurn(access(), "on"), toolTurn(access(NEVER), "on", { webSearch: true })]) {
      expect(turn?.tools).not.toContain("WebSearch");
      expect(turn?.webSearch).toBe(false);
    }
    expect(toolTurn(access(), "on", { webSearch: true })?.tools).not.toContain("WebFetch");
  });

  // covers ADR 036
  it("[TC-RT-1266-06] decides a search as Search the web, reports its query and hits, and labels them as other people's text", async () => {
    const allowed = await search();
    expect(allowed.decision).toBe("allow");
    expect(allowed.events).toContainEqual({
      _tag: "ToolStarted",
      id: "t1",
      tool: "WebSearch",
      label: "Searching the web for hobbots releases",
      operation: "search-web",
      targets: ["hobbots releases"],
    });
    expect(allowed.events.at(-1)).toEqual({
      _tag: "WebSearched",
      id: "t1",
      query: "hobbots releases",
      results: [{ title: "Releases", url: "https://example.com/r" }],
    });
    expect(allowed.note).toBe(WEB_RESULTS_LINE);

    // A call to it under Never is refused, even were Claude Code to offer it.
    const refused = await search(NEVER);
    expect(refused.decision).toBe("deny");
    expect(refused.events.map((event) => event._tag)).not.toContain("WebSearched");
  });

  it("counts the turn's searches in its usage only when it could search", () => {
    const whole = wholeTurn();
    const usage = {
      timeToRequestMs: null,
      timeToFirstStreamMs: null,
      timeToFirstTokenMs: null,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    whole.read({ _tag: "Completed", sessionId: "s", text: "Done.", usage });
    expect(whole.end(2)).toEqual([
      { _tag: "Completed", sessionId: "s", text: "Done.", usage: { ...usage, webSearches: 2 } },
    ]);
    expect(whole.end()).toEqual([{ _tag: "Completed", sessionId: "s", text: "Done.", usage }]);
    // The searches reported are counted only on a turn that offered WebSearch.
    const searched = { _tag: "WebSearched", id: "t1", query: "q", results: null } as const;
    const counts = [toolTurn(access(), "on", { webSearch: true }), toolTurn(access(), "on"), null].map((turn) => {
      const searches = searchCount(turn);
      searches.see(searched);
      searches.see({ _tag: "StepEnded", id: "t1" });
      return searches.total();
    });
    expect(counts).toEqual([1, undefined, undefined]);
  });
});
