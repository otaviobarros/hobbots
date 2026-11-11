import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError, RuntimeLimitReached } from "@hobbots/agents";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "@hobbots/domain";
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultEngineFolder, ENGINE_BINARY } from "../src/engine/binary.ts";
import { renderEngineConfig } from "../src/engine/config.ts";
import { engineArguments } from "../src/engine/engine.ts";
import { engineSettingsFor } from "../src/engine/model.ts";
import { MemoryModelEndpoint } from "../src/engine/model-endpoint.ts";
import { AI_MEMORY_VERSION } from "../src/engine/release.ts";
import { readEngineStatus } from "../src/engine/status.ts";
import { claude, codex, resetStandIns, standInRuntimes } from "./runtime-stand-ins.ts";

// The memory model's provider settings against the bundled ai-memory release (ADR 028): the engine
// must start with every config Hobbots writes, and reach its models only through the hub's memory
// model endpoint, which runs each task on a runtime's adapter (here, stand-ins that record each
// turn). Run as the other contract tests are (see engine-contract.test.ts).
const folder = process.env.HOBBOTS_MEMORY_ENGINE_DIR ?? defaultEngineFolder();
const fetched = folder !== undefined && existsSync(join(folder, ENGINE_BINARY));
const enabled = fetched || process.env.HOBBOTS_MEMORY_CONTRACT === "1";

const ROOT = "r".repeat(64);
const MODEL_KEY = "m".repeat(64);
const folders: Array<string> = [];
let scope: Scope.Closeable | undefined;
let endpoint: MemoryModelEndpoint["Service"];

beforeAll(async () => {
  if (!enabled) return;
  const opened = await Effect.runPromise(Scope.make());
  scope = opened;
  const layer = MemoryModelEndpoint.layer(Redacted.make(MODEL_KEY)).pipe(Layer.provide(standInRuntimes));
  endpoint = Context.get(await Effect.runPromise(Layer.buildWithScope(layer, opened)), MemoryModelEndpoint);
});

beforeEach(resetStandIns);

afterAll(async () => {
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const each of folders) rmSync(each, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });

/**
 * Starts the engine with the config Hobbots writes for `chosen`, with only the bearers in its
 * environment as the hub starts it, runs `body` against it, then stops it.
 */
const withEngine = async <A>(chosen: MemorySettings, body: (url: string) => Promise<A>) => {
  const dataDir = mkdtempSync(join(tmpdir(), "hobbots-memory-model-"));
  folders.push(dataDir);
  const memoryDir = join(dataDir, "memory");
  mkdirSync(memoryDir);
  const configFile = join(memoryDir, "config.toml");
  writeFileSync(configFile, renderEngineConfig(engineSettingsFor(chosen), endpoint.url));
  const port = await freePort();
  const output: Array<string> = [];
  const child = spawn(join(folder ?? "", ENGINE_BINARY), [...engineArguments(port, memoryDir, configFile)], {
    cwd: memoryDir,
    env: {
      AI_MEMORY_AUTH_TOKEN: ROOT,
      AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN: "p".repeat(64),
      LLM_API_KEY: MODEL_KEY,
      HOME: memoryDir,
      PATH: "/usr/bin:/bin",
    },
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let tries = 0; ; tries++) {
      if (child.exitCode !== null) throw new Error(`The engine exited: ${output.join("").slice(-2000)}`);
      const answered = await fetch(`${url}/healthz`).then(
        (response) => response.ok,
        () => false,
      );
      if (answered) break;
      if (tries > 150) throw new Error("The engine did not answer");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return await body(url);
  } finally {
    child.kill("SIGTERM");
  }
};

/** The engine's `/admin/status`, raw and as Hobbots reads it. */
const statusOf = async (url: string) => {
  const raw = (await (await fetch(`${url}/admin/status`, { headers: { authorization: `Bearer ${ROOT}` } })).json()) as {
    providers: Record<string, unknown>;
  };
  const read = await Effect.runPromise(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return yield* readEngineStatus(http, { url, root: Redacted.make(ROOT), proxy: Redacted.make("p".repeat(64)) });
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  return { raw: raw.providers, read };
};

/** The engine's own probe of its configured model chain: `POST /admin/llm-test`. */
const probe = async (url: string) => {
  const response = await fetch(`${url}/admin/llm-test`, {
    method: "POST",
    headers: { authorization: `Bearer ${ROOT}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe.runIf(enabled)(`the memory model on the bundled ai-memory ${AI_MEMORY_VERSION}`, () => {
  // covers ADR 028
  it("[TC-GEN-217] starts with the hub's endpoint as its only provider, the chosen effort and per-task models, and reports their use", async () => {
    await withEngine(
      {
        ...DEFAULT_MEMORY_SETTINGS,
        fallback: "other",
        tasks: { ...DEFAULT_MEMORY_SETTINGS.tasks, summaries: "careful", check: "careful", answers: "same" },
      },
      async (url) => {
        const { raw, read } = await statusOf(url);
        expect(raw.llm).toMatchObject({ provider: "openai-compat", model: "smallest" });
        expect(JSON.stringify(raw.llm_task_chains)).toContain("careful");
        expect(JSON.stringify(raw)).not.toMatch(/anthropic|"codex"/);
        expect(read).toEqual({
          pages: 0,
          usage: { calls: 0, inputTokens: 0, outputTokens: 0, since: expect.any(String) },
        });
      },
    );
  }, 60_000);

  // covers ADR 028
  it("[TC-GEN-218] starts with no model at all under No AI", async () => {
    await withEngine({ ...DEFAULT_MEMORY_SETTINGS, provider: "none" }, async (url) => {
      const { raw, read } = await statusOf(url);
      expect(raw.llm_workloads ?? []).toEqual([]);
      expect(JSON.stringify(raw.llm ?? null)).not.toContain("openai-compat");
      expect(read?.usage.calls).toBe(0);
      expect((await probe(url)).status).toBe(503);
    });
    expect(claude.turns).toHaveLength(0);
  }, 60_000);

  // covers ADR 028
  it("[TC-GEN-317] runs the engine's model call as one turn on the chosen runtime's adapter, with no API key", async () => {
    await withEngine({ ...DEFAULT_MEMORY_SETTINGS, effort: "medium" }, async (url) => {
      const { status, body } = await probe(url);
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, model: "quick" });
    });
    expect(claude.turns).toMatchObject([
      { prompt: "ping", sessionId: null, model: "quick", effort: null, tools: null, hubTools: null, ephemeral: true },
    ]);
    expect(codex.turns).toHaveLength(0);
  }, 60_000);

  // covers ADR 028
  it("[TC-GEN-318] falls back to the other runtime when the chosen one hits its plan's limit or is signed out", async () => {
    codex.answer({ _tag: "Fail", error: new RuntimeLimitReached({ resetsAt: null }) });
    await withEngine({ ...DEFAULT_MEMORY_SETTINGS, provider: "chatgpt", fallback: "other" }, async (url) => {
      expect(await probe(url)).toMatchObject({ status: 200, body: { ok: true } });
    });
    expect(codex.turns).toHaveLength(1);
    expect(claude.turns).toMatchObject([{ model: "quick", ephemeral: true }]);

    // Signed out, with plain summaries as the fallback: the call fails, and the engine writes its
    // summaries without a model.
    resetStandIns();
    claude.answer({ _tag: "Fail", error: new RuntimeError({ message: "Claude Code is not signed in." }) });
    await withEngine({ ...DEFAULT_MEMORY_SETTINGS }, async (url) => {
      expect(await probe(url)).toMatchObject({ status: 502, body: { ok: false } });
    });
    expect(codex.turns).toHaveLength(0);
  }, 90_000);
});
