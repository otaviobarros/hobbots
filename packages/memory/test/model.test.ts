import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { renderEngineConfig } from "../src/engine/config.ts";
import { engineSettingsFor } from "../src/engine/model.ts";
import { usageOf } from "../src/engine/status.ts";

const ENDPOINT = "http://127.0.0.1:4555";
const settings = (change: Partial<MemorySettings> = {}): MemorySettings => ({ ...DEFAULT_MEMORY_SETTINGS, ...change });
const configFor = (chosen: MemorySettings) => renderEngineConfig(engineSettingsFor(chosen), ENDPOINT);

/** A model's table as the engine reads it: always the hub's endpoint, with the model bearer's variable. */
const table = (name: string, runtime: string, model: string) =>
  `[${name}]\nprovider = "openai-compat"\nmodel = "${model}"\nbase_url = "${ENDPOINT}/${runtime}/v1"\napi_key_env = "LLM_API_KEY"`;

describe("the memory model as the engine's provider settings", () => {
  // covers ADR 028
  it("[TC-GEN-212] sends every task to the hub's endpoint for the provider's runtime, with the model and effort", () => {
    const config = configFor(settings());
    expect(config).toContain('llm_provider = "openai-compat"');
    // No model chosen: the runtime's smallest, which the endpoint picks from what the runtime offers.
    expect(config).toContain('llm_model = "smallest"');
    expect(config).toContain(`llm_base_url = "${ENDPOINT}/claude-code/v1"`);
    expect(config).toContain("llm_compat_strict = false");
    expect(config).toContain('llm_reasoning_effort = "low"');
    expect(config).toContain("consolidate_on_session_end = true");
    // The engine's own learning scheduler waits for the Curator.
    expect(config).toContain("[auto_improve.scheduler]\nenabled = false");
    expect(config).not.toContain("llm_fallbacks");
    // No engine provider of its own, no key and no sign-in file.
    expect(config).not.toMatch(/anthropic|"codex"|api_key\s*=|auth\.json/);

    const chatgpt = configFor(settings({ provider: "chatgpt", model: "gpt-9.9", effort: "medium" }));
    expect(chatgpt).toContain('llm_model = "gpt-9.9"');
    expect(chatgpt).toContain(`llm_base_url = "${ENDPOINT}/codex/v1"`);
    expect(chatgpt).toContain('llm_reasoning_effort = "medium"');

    // Without the endpoint, the engine gets no model at all.
    expect(renderEngineConfig(engineSettingsFor(settings()), null)).not.toContain("llm_");
  });

  // covers ADR 028
  it("[TC-GEN-213] turns off every model call with No AI, whatever else was chosen", () => {
    const chosen = settings({
      provider: "none",
      fallback: "other",
      tasks: { summaries: "careful", check: "careful", answers: "careful" },
    });
    const config = configFor(chosen);
    expect(config).not.toMatch(/llm|consolidate|auto_improve/);
    expect(config).toContain("[auth]");
  });

  // covers ADR 028
  it("[TC-GEN-214] falls back to the other runtime's smallest model through the same endpoint", () => {
    expect(configFor(settings({ fallback: "other" }))).toContain(table("[llm_fallbacks]", "codex", "smallest"));
    expect(configFor(settings({ provider: "chatgpt", fallback: "other" }))).toContain(
      table("[llm_fallbacks]", "claude-code", "smallest"),
    );
    // Plain summaries need no fallback: the engine writes one without a model.
    expect(configFor(settings({ fallback: "plain" }))).not.toContain("llm_fallbacks");
  });

  // covers ADR 028
  it("[TC-GEN-215] gives a task its own model of the runtime with its own fallbacks, or sums up chats with no AI", () => {
    const config = configFor(
      settings({ fallback: "other", tasks: { summaries: "careful", check: "claude-opus-4-8[1m]", answers: "same" } }),
    );
    expect(config).toContain(table("llm.consolidation", "claude-code", "careful"));
    expect(config).toContain(table("llm.lint", "claude-code", "claude-opus-4-8[1m]"));
    expect(config).toContain(table("[llm.lint.fallbacks]", "codex", "smallest"));
    expect(config).not.toContain("[llm.query_answer]");

    const plain = configFor(settings({ tasks: { summaries: "none", check: "same", answers: "careful" } }));
    expect(plain).toContain("consolidate_on_session_end = false");
    expect(plain).toContain(table("llm.query_answer", "claude-code", "careful"));
    expect(plain).not.toContain("[llm.consolidation]");
    // Every top-level key comes before the first table, as TOML needs.
    const firstTable = plain.indexOf("\n[");
    expect(plain.lastIndexOf("consolidate_on_session_end")).toBeLessThan(firstTable);
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
