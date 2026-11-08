import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, ToolAccess } from "@hobbots/agents";
import { EMPTY_HOB_POLICY, type HobPolicy } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { FAKE_SEARCH_DIRECTIVE, fakeSearchResults, makeFakeRuntime } from "../src/fake.ts";

// The fake runtime's scripted web search, which end-to-end tests drive (ADR 036, #1266).

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-fake-search-")));
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

const turn = (hob: HobPolicy, webSearch: boolean): Promise<ReadonlyArray<RuntimeEvent>> =>
  makeFakeRuntime({ engine })
    .sendPrompt({
      prompt: `${FAKE_SEARCH_DIRECTIVE} hobbots releases`,
      sessionId: null,
      instructions: "",
      instructionsChanged: false,
      model: null,
      effort: null,
      tools: access(hob),
      webSearch,
    })
    .pipe(Stream.runCollect, Effect.runPromise)
    .then((events) => Array.from(events));

describe("the fake runtime's web search", () => {
  it("[TC-RT-1266-07] runs a scripted search a hob may make, reports it and counts it in the turn's usage", async () => {
    const events = await turn(EMPTY_HOB_POLICY, true);
    expect(events).toContainEqual({
      _tag: "WebSearched",
      id: expect.any(String),
      query: "hobbots releases",
      results: fakeSearchResults("hobbots releases"),
    });
    expect(events.at(-1)).toMatchObject({ _tag: "Completed", usage: { webSearches: 1 } });
  });

  it("[TC-RT-1266-08] does not search for a hob set to Never, nor on a turn the hub did not let search", async () => {
    for (const events of [
      await turn({ ...EMPTY_HOB_POLICY, overrides: { "search-web": "deny" } }, true),
      await turn(EMPTY_HOB_POLICY, false),
    ]) {
      // Claude Code would not offer the tool, so the model never calls it.
      expect(events.filter((event) => event._tag.startsWith("Tool") || event._tag === "WebSearched")).toEqual([]);
      expect(events.at(-1)).not.toHaveProperty("usage.webSearches");
    }
  });
});
