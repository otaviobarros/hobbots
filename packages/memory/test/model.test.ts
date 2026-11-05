import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { renderEngineConfig } from "../src/engine/config.ts";
import { engineSettingsFor } from "../src/engine/model.ts";
import { usageOf } from "../src/engine/status.ts";

const both = () => true;
const settings = (change: Partial<MemorySettings> = {}): MemorySettings => ({ ...DEFAULT_MEMORY_SETTINGS, ...change });
const configFor = (chosen: MemorySettings, canRun: (provider: "claude" | "chatgpt") => boolean = both) =>
  renderEngineConfig(engineSettingsFor(chosen, canRun).engine);

describe("the memory model as the engine's provider settings", () => {
  // covers ADR 028
  it("[TC-GEN-212] writes the provider, model and effort, and sums up chats with the model", () => {
    const config = configFor(settings());
    expect(config).toContain('llm_provider = "anthropic"');
    expect(config).toContain('llm_model = "claude-haiku-5-5"');
    expect(config).toContain('llm_reasoning_effort = "low"');
    expect(config).toContain("consolidate_on_session_end = true");
    // The engine's own learning scheduler waits for the Curator.
    expect(config).toContain("[auto_improve.scheduler]\nenabled = false");
    expect(config).not.toContain("llm_fallbacks");

    const chatgpt = configFor(settings({ provider: "chatgpt", model: "gpt-5.5", effort: "medium" }));
    expect(chatgpt).toContain('llm_provider = "codex"');
    expect(chatgpt).toContain('llm_model = "gpt-5.5"');
    expect(chatgpt).toContain('llm_reasoning_effort = "medium"');
  });

  // covers ADR 028
  it("[TC-GEN-213] turns off every model call with No AI, whatever else was chosen", () => {
    const chosen = settings({
      provider: "none",
      fallback: "other",
      tasks: { summaries: "stronger", check: "stronger", answers: "stronger" },
    });
    const { engine, state } = engineSettingsFor(chosen, both);
    expect(state).toEqual({ _tag: "NoAi" });
    const config = renderEngineConfig(engine);
    expect(config).not.toMatch(/llm|consolidate|auto_improve/);
    expect(config).toContain("[auth]");
  });

  // covers ADR 028
  it("[TC-GEN-214] falls back to the other provider's small model, naming its key", () => {
    const claude = configFor(settings({ fallback: "other" }));
    expect(claude).toContain('[[llm_fallbacks]]\nprovider = "codex"\nmodel = "gpt-5.4-mini"');
    const chatgpt = configFor(settings({ provider: "chatgpt", model: "mini", fallback: "other" }));
    expect(chatgpt).toContain(
      '[[llm_fallbacks]]\nprovider = "anthropic"\nmodel = "claude-haiku-5-5"\napi_key_env = "ANTHROPIC_API_KEY"',
    );
    // Plain summaries need no fallback: the engine writes one without a model.
    expect(configFor(settings({ fallback: "plain" }))).not.toContain("llm_fallbacks");
  });

  // covers ADR 028
  it("[TC-GEN-215] gives a task the stronger model with its own fallbacks, or sums up chats with no AI", () => {
    const config = configFor(
      settings({ fallback: "other", tasks: { summaries: "stronger", check: "stronger", answers: "same" } }),
    );
    expect(config).toContain('[llm.consolidation]\nprovider = "anthropic"\nmodel = "claude-sonnet-5-5"');
    expect(config).toContain('[llm.lint]\nprovider = "anthropic"\nmodel = "claude-sonnet-5-5"');
    expect(config).toContain('[[llm.lint.fallbacks]]\nprovider = "codex"');
    expect(config).not.toContain("[llm.query_answer]");

    const plain = configFor(settings({ tasks: { summaries: "none", check: "same", answers: "stronger" } }));
    expect(plain).toContain("consolidate_on_session_end = false");
    expect(plain).toContain('[llm.query_answer]\nprovider = "anthropic"');
    expect(plain).not.toContain("[llm.consolidation]");
    // Every top-level key comes before the first table, as TOML needs.
    const firstTable = plain.indexOf("\n[");
    expect(plain.lastIndexOf("consolidate_on_session_end")).toBeLessThan(firstTable);
  });

  // covers ADR 028
  it("[TC-GEN-216] runs with no AI while the chosen provider has no key, and drops a fallback without one", () => {
    const { engine, state } = engineSettingsFor(settings(), () => false);
    expect(state).toEqual({ _tag: "NeedsKey", provider: "claude" });
    expect(renderEngineConfig(engine)).not.toContain("llm_");

    const onlyClaude = configFor(settings({ fallback: "other" }), (provider) => provider === "claude");
    expect(onlyClaude).toContain('llm_provider = "anthropic"');
    expect(onlyClaude).not.toContain("llm_fallbacks");
  });
});

describe("the memory model's use", () => {
  const workload = (fields: Partial<Record<string, number>>) => ({
    calls: 0,
    estimated_input_tokens: 0,
    estimated_output_tokens: 0,
    reported_input_tokens: 0,
    reported_output_tokens: 0,
    usage_reported_calls: 0,
    ...fields,
  });

  it("adds every workload, with the provider's own counts where it reported each call", () => {
    const usage = usageOf({
      counts: { pages_latest: 3 },
      providers: {
        llm_workloads: [
          workload({
            calls: 2,
            usage_reported_calls: 2,
            reported_input_tokens: 900,
            reported_output_tokens: 100,
            estimated_input_tokens: 5,
          }),
          workload({ calls: 3, usage_reported_calls: 1, estimated_input_tokens: 300, estimated_output_tokens: 30 }),
        ],
        llm_workloads_started_ms: Date.UTC(2026, 10, 5),
      },
    });
    expect(usage).toEqual({ calls: 5, inputTokens: 1200, outputTokens: 130, since: "2026-11-05T00:00:00.000Z" });
  });

  it("counts nothing while no model is configured", () => {
    expect(usageOf({ counts: { pages_latest: 0 }, providers: {} })).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      since: null,
    });
  });
});
