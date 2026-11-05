import { RuntimeError, RuntimeLimitReached } from "@hobbots/agents";
import { Context, Effect, Exit, Layer, Option, Redacted, Scope } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryModelEndpoint } from "../src/engine/model-endpoint.ts";
import { claude, codex, resetStandIns, standInRuntimes } from "./runtime-stand-ins.ts";

// The memory model endpoint (ADR 028, issue #980): the engine reaches a model only through it, and
// each request is one turn on the runtime's own adapter, with no hob, tools, folders or session.

const KEY = "k".repeat(64);

let scope: Scope.Closeable;
let endpoint: MemoryModelEndpoint["Service"];

beforeAll(async () => {
  scope = await Effect.runPromise(Scope.make());
  const layer = MemoryModelEndpoint.layer(Redacted.make(KEY)).pipe(Layer.provide(standInRuntimes));
  endpoint = Context.get(await Effect.runPromise(Layer.buildWithScope(layer, scope)), MemoryModelEndpoint);
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

beforeEach(resetStandIns);

/** A request as ai-memory's OpenAI-compatible provider sends it. */
const ask = (runtime: string, body: unknown, bearer = KEY) =>
  fetch(`${endpoint.url}/${runtime}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const summary = (model: string, effort?: string) => ({
  model,
  messages: [
    { role: "system", content: "Sum up the session as JSON matching this schema: {}" },
    { role: "user", content: "The user asked for a release note." },
  ],
  max_tokens: 4096,
  ...(effort === undefined ? {} : { reasoning_effort: effort }),
});

describe("the memory model endpoint", () => {
  // covers ADR 028
  it("[TC-GEN-313] runs one turn of no hob's on each runtime's own adapter, and answers as OpenAI does", async () => {
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await ask("claude-code", summary("careful", "medium"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      model: "careful",
      choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
    });
    // No tools, hub tools, approvals or folders, and no session to resume or keep.
    expect(claude.turns).toEqual([
      {
        prompt: "The user asked for a release note.",
        instructions: "Sum up the session as JSON matching this schema: {}",
        instructionsChanged: false,
        sessionId: null,
        model: "careful",
        effort: "medium",
        tools: null,
        approvals: null,
        hubTools: null,
        ephemeral: true,
      },
    ]);

    const chatgpt = await ask("codex", summary("big", "high"));
    expect(chatgpt.status).toBe(200);
    expect(codex.turns).toMatchObject([{ model: "big", effort: "high", ephemeral: true, tools: null }]);
    expect(claude.turns).toHaveLength(1);
  });

  // covers ADR 028
  it("[TC-GEN-314] runs a model the runtime stopped offering, or the smallest, on its smallest, at an effort it takes", async () => {
    await ask("claude-code", summary("smallest", "high"));
    await ask("claude-code", summary("gone-1", "low"));
    // The model the runtime names for quick work; it takes no effort setting.
    expect(claude.turns.map(({ model, effort }) => ({ model, effort }))).toEqual([
      { model: "quick", effort: null },
      { model: "quick", effort: null },
    ]);
    // Codex names none: its last main model, at the effort asked for or the lowest it takes.
    await ask("codex", summary("smallest", "low"));
    await ask("codex", summary("big", "low"));
    expect(codex.turns.map(({ model, effort }) => ({ model, effort }))).toEqual([
      { model: "small", effort: "low" },
      { model: "big", effort: "medium" },
    ]);
  });

  // covers ADR 028
  it("[TC-GEN-315] answers a plan's limit as a transient failure, so the engine's fallback applies, and says when it refills", async () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    codex.answer({ _tag: "Fail", error: new RuntimeLimitReached({ resetsAt }) });
    const limited = await ask("codex", summary("smallest"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(3500);
    expect(Option.getOrNull(await Effect.runPromise(endpoint.limited("codex")))).toEqual({ resetsAt });
    expect((await Effect.runPromise(endpoint.limited("claude-code")))._tag).toBe("None");

    // A task that runs again clears it.
    codex.answer({ _tag: "Reply", text: "Back." });
    expect((await ask("codex", summary("smallest"))).status).toBe(200);
    expect((await Effect.runPromise(endpoint.limited("codex")))._tag).toBe("None");
  });

  // covers ADR 028
  it("[TC-GEN-316] answers a signed-out runtime as unavailable, and refuses a wrong bearer, runtime or request", async () => {
    claude.answer({ _tag: "Fail", error: new RuntimeError({ message: "Claude Code is not signed in." }) });
    const signedOut = await ask("claude-code", summary("smallest"));
    expect(signedOut.status).toBe(503);
    expect(JSON.stringify(await signedOut.json())).not.toContain("signed in");

    expect((await ask("claude-code", summary("smallest"), "x".repeat(64))).status).toBe(401);
    expect((await ask("gemini", summary("smallest"))).status).toBe(404);
    expect((await ask("claude-code", { model: "smallest", messages: [] })).status).toBe(400);
    // Nothing refused ever reached a runtime.
    expect(claude.turns).toHaveLength(1);
    expect(codex.turns).toHaveLength(0);
  });
});

describe("a memory turn's text", () => {
  it("names each role when the engine sends a conversation", async () => {
    await ask("claude-code", {
      model: "smallest",
      messages: [
        { role: "user", content: "First." },
        { role: "assistant", content: "Noted." },
        { role: "user", content: "Second." },
      ],
    });
    expect(claude.turns[0]?.prompt).toBe(
      "<user>\nFirst.\n</user>\n\n<assistant>\nNoted.\n</assistant>\n\n<user>\nSecond.\n</user>",
    );
    expect(claude.turns[0]?.instructions).toBe("");
  });
});
