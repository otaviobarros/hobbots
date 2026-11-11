import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubDecider, type Judgment } from "@hobbots/agents";
import { DEFAULT_MEMORY_SETTINGS } from "@hobbots/domain";
import { HubBrainDecider, MemoryModelEndpoint } from "@hobbots/memory";
import { FakeAdditionalRuntimesLayer, FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Redacted, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memorySettingsFile, readMemorySettings } from "../src/memory-settings.ts";

// The hub's brain on the fake runtime (ADR 037, issue #1367), read from the settings file as the hub
// reads it: the fake's echo is no answer in the judgment's shape, so the rule stands.

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hobbots-hub-brain-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const drift: Judgment<"same" | "drifting"> = {
  task: "judgments",
  question: "Is the last chapter drifting into a topic of its own?",
  input: "We moved from the release notes to the logo colors.",
  choices: Schema.Literals(["same", "drifting"]),
  rule: "same",
};

const judge = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const decider = yield* HubDecider;
      const endpoint = yield* MemoryModelEndpoint;
      const decided = yield* decider.decide(drift);
      return { decided, usage: yield* endpoint.hubUsage };
    }).pipe(
      Effect.provide(
        HubBrainDecider(Effect.sync(() => readMemorySettings(dataDir))).pipe(
          Layer.provideMerge(MemoryModelEndpoint.layer(Redacted.make("k".repeat(64)))),
          Layer.provide(Layer.mergeAll(FakeRuntimeLayer(), FakeAdditionalRuntimesLayer())),
        ),
      ),
      Effect.scoped,
    ),
  );

describe("the hub's brain on the fake runtime", () => {
  // covers ADR 037
  it("[TC-GEN-1367-06] keeps the rule when the fake's reply does not decode, on Claude Code and on Codex", async () => {
    for (const provider of ["claude", "chatgpt"] as const) {
      writeFileSync(memorySettingsFile(dataDir), JSON.stringify({ ...DEFAULT_MEMORY_SETTINGS, provider }));
      const { decided, usage } = await judge();
      expect(decided).toEqual({ choice: "same", confidence: 1, by: "rule" });
      // The turn ran: the brain was asked, and its answer did not decode.
      expect(usage.calls).toBe(1);
    }
  });

  // covers ADR 037
  it("[TC-GEN-1367-07] calls no model with No AI, and reads a memory model saved before the hub's tasks", async () => {
    const saved = {
      provider: "none",
      model: null,
      effort: "low",
      fallback: "plain",
      tasks: { summaries: "same", check: "same", answers: "same" },
    };
    writeFileSync(memorySettingsFile(dataDir), JSON.stringify(saved));
    expect(readMemorySettings(dataDir)).toEqual({ ...DEFAULT_MEMORY_SETTINGS, provider: "none" });
    const { decided, usage } = await judge();
    expect(decided).toEqual({ choice: "same", confidence: 1, by: "rule" });
    expect(usage.calls).toBe(0);
  });
});
