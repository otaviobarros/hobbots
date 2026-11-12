import { HubDecider, type Judgment, RuntimeError, RuntimeLimitReached } from "@hobbots/agents";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "@hobbots/domain";
import { Context, Effect, Exit, Layer, Redacted, Schema, Scope } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HubBrainDecider } from "../src/engine/hub-brain.ts";
import { MemoryModelEndpoint } from "../src/engine/model-endpoint.ts";
import { claude, codex, resetStandIns, standInRuntimes } from "./runtime-stand-ins.ts";

// The hub's brain (ADR 037, issue #1367): a judgment is one turn through the hub's model endpoint on
// Claude Code or Codex, and the caller's rule stands whenever the answer does not decode.

let scope: Scope.Closeable;
let decider: HubDecider["Service"];
let endpoint: MemoryModelEndpoint["Service"];
let settings: MemorySettings = DEFAULT_MEMORY_SETTINGS;

beforeAll(async () => {
  scope = await Effect.runPromise(Scope.make());
  const layer = HubBrainDecider(Effect.sync(() => settings)).pipe(
    Layer.provideMerge(MemoryModelEndpoint.layer(Redacted.make("k".repeat(64)))),
    Layer.provide(standInRuntimes),
  );
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  decider = Context.get(context, HubDecider);
  endpoint = Context.get(context, MemoryModelEndpoint);
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

beforeEach(() => {
  resetStandIns();
  settings = DEFAULT_MEMORY_SETTINGS;
});

const clash: Judgment<"clash" | "apart"> = {
  task: "judgments",
  question: "Do these two quests clash in meaning?",
  input: "Quest one: rename the app. Quest two: keep the app's name.",
  choices: Schema.Literals(["clash", "apart"]),
  rule: "apart",
};

const decide = () => Effect.runPromise(decider.decide(clash));

describe("the hub's brain", () => {
  // covers ADR 037
  it("[TC-GEN-1367-01] asks the chosen runtime for a choice and a confidence, as a turn of no hob's", async () => {
    claude.answer({ _tag: "Reply", text: '```json\n{"choice":"clash","confidence":0.9}\n```' });
    expect(await decide()).toEqual({ choice: "clash", confidence: 0.9, by: "brain" });
    expect(claude.turns).toMatchObject([
      { model: "quick", tools: null, hubTools: null, sessionId: null, ephemeral: true },
    ]);
    expect(claude.turns[0]?.prompt).toContain(clash.question);
    expect(claude.turns[0]?.prompt).toContain(clash.input);

    // A change in Settings applies to the next judgment: Codex now, at an effort its model takes.
    settings = { ...DEFAULT_MEMORY_SETTINGS, provider: "chatgpt", model: "big" };
    codex.answer({ _tag: "Reply", text: '{"choice":"apart","confidence":0.4}' });
    expect(await decide()).toEqual({ choice: "apart", confidence: 0.4, by: "brain" });
    expect(codex.turns).toMatchObject([{ model: "big", effort: "medium", tools: null, ephemeral: true }]);
    expect(claude.turns).toHaveLength(1);
  });

  // covers ADR 037
  it("[TC-GEN-1367-02] keeps the rule when the answer does not decode, on Claude Code and Codex", async () => {
    for (const [provider, runtime] of [
      ["claude", claude],
      ["chatgpt", codex],
    ] as const) {
      settings = { ...DEFAULT_MEMORY_SETTINGS, provider };
      for (const text of ['{"choice":"maybe","confidence":0.9}', "They clash.", '{"choice":"clash","confidence":7}']) {
        runtime.answer({ _tag: "Reply", text });
        expect(await decide()).toEqual({ choice: "apart", confidence: 1, by: "fallback" });
      }
      expect(runtime.turns).toHaveLength(3);
    }
  });

  // covers ADR 037
  it("[TC-GEN-1367-03] calls no model with No AI, for the brain or for the task, and the rule answers", async () => {
    settings = { ...DEFAULT_MEMORY_SETTINGS, provider: "none" };
    expect(await decide()).toEqual({ choice: "apart", confidence: 1, by: "rule" });
    settings = { ...DEFAULT_MEMORY_SETTINGS, tasks: { ...DEFAULT_MEMORY_SETTINGS.tasks, judgments: "none" } };
    expect(await decide()).toEqual({ choice: "apart", confidence: 1, by: "rule" });
    expect(claude.turns).toHaveLength(0);
    expect(codex.turns).toHaveLength(0);
  });

  // covers ADR 037
  it("[TC-GEN-1367-04] passes a judgment its runtime cannot run to the fallback, or keeps the rule", async () => {
    claude.answer({ _tag: "Fail", error: new RuntimeError({ message: "Claude Code is not signed in." }) });
    expect(await decide()).toEqual({ choice: "apart", confidence: 1, by: "fallback" });
    expect(codex.turns).toHaveLength(0);

    settings = { ...DEFAULT_MEMORY_SETTINGS, fallback: "other" };
    claude.answer({ _tag: "Fail", error: new RuntimeLimitReached({ resetsAt: null }) });
    codex.answer({ _tag: "Reply", text: '{"choice":"clash","confidence":0.7}' });
    expect(await decide()).toEqual({ choice: "clash", confidence: 0.7, by: "brain" });
    expect(codex.turns).toMatchObject([{ model: "small" }]);
    // The plan's limit is remembered, as a memory task's is.
    expect((await Effect.runPromise(endpoint.limited("claude-code")))._tag).toBe("Some");
  });

  // covers ADR 037
  it("[TC-GEN-1367-05] counts the brain's own turns and their tokens for Usage", async () => {
    const before = await Effect.runPromise(endpoint.hubUsage);
    claude.answer({ _tag: "Reply", text: '{"choice":"clash","confidence":0.9}' });
    await decide();
    claude.answer({ _tag: "Reply", text: "not an answer" });
    await decide();
    const after = await Effect.runPromise(endpoint.hubUsage);
    expect(after.calls - before.calls).toBe(2);
    expect(after.inputTokens - before.inputTokens).toBe(240);
    expect(after.outputTokens - before.outputTokens).toBe(16);
    expect(after.since).not.toBeNull();
  });
});
