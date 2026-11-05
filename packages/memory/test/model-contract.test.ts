import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "@hobbots/domain";
import { Effect, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { afterAll, describe, expect, it } from "vitest";
import { defaultEngineFolder, ENGINE_BINARY } from "../src/engine/binary.ts";
import { renderEngineConfig } from "../src/engine/config.ts";
import { engineArguments } from "../src/engine/engine.ts";
import { engineSettingsFor } from "../src/engine/model.ts";
import { AI_MEMORY_VERSION } from "../src/engine/release.ts";
import { readEngineStatus } from "../src/engine/status.ts";

// The memory model's provider settings against the bundled ai-memory release (ADR 028): the engine
// must start with every config Hobbots writes, and run each task on the model it was given. Run as
// the other contract tests are (see engine-contract.test.ts).
const folder = process.env.HOBBOTS_MEMORY_ENGINE_DIR ?? defaultEngineFolder();
const fetched = folder !== undefined && existsSync(join(folder, ENGINE_BINARY));
const enabled = fetched || process.env.HOBBOTS_MEMORY_CONTRACT === "1";

const ROOT = "r".repeat(64);
const folders: Array<string> = [];
afterAll(() => {
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

/** Starts the engine with the config Hobbots writes for `chosen`, and answers its `/admin/status`. */
const statusWith = async (chosen: MemorySettings) => {
  const dataDir = mkdtempSync(join(tmpdir(), "hobbots-memory-model-"));
  folders.push(dataDir);
  const memoryDir = join(dataDir, "memory");
  mkdirSync(memoryDir);
  const configFile = join(memoryDir, "config.toml");
  writeFileSync(configFile, renderEngineConfig(engineSettingsFor(chosen, () => true).engine));
  const port = await freePort();
  const output: Array<string> = [];
  const child = spawn(join(folder ?? "", ENGINE_BINARY), [...engineArguments(port, memoryDir, configFile)], {
    cwd: memoryDir,
    env: {
      AI_MEMORY_AUTH_TOKEN: ROOT,
      AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN: "p".repeat(64),
      // A key in the right shape, never used: no memory task runs here.
      ANTHROPIC_API_KEY: "sk-ant-contract-test",
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
    const raw = (await (
      await fetch(`${url}/admin/status`, { headers: { authorization: `Bearer ${ROOT}` } })
    ).json()) as { providers: Record<string, unknown> };
    const read = await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        return yield* readEngineStatus(http, { url, root: Redacted.make(ROOT), proxy: Redacted.make("p".repeat(64)) });
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    return { raw: raw.providers, read };
  } finally {
    child.kill("SIGTERM");
  }
};

describe.runIf(enabled)(`the memory model on the bundled ai-memory ${AI_MEMORY_VERSION}`, () => {
  // covers ADR 028
  it("[TC-GEN-217] starts with the chosen model, effort and per-task models, and reports their use", async () => {
    const { raw, read } = await statusWith({
      ...DEFAULT_MEMORY_SETTINGS,
      effort: "low",
      tasks: { summaries: "stronger", check: "stronger", answers: "same" },
    });
    expect(raw.llm).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });
    expect(JSON.stringify(raw.llm_task_chains)).toContain("claude-sonnet-5-5");
    expect(read).toEqual({
      pages: 0,
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, since: expect.any(String) },
    });
  }, 60_000);

  // covers ADR 028
  it("[TC-GEN-218] starts with no model at all under No AI", async () => {
    const { raw, read } = await statusWith({ ...DEFAULT_MEMORY_SETTINGS, provider: "none" });
    expect(raw.llm_workloads ?? []).toEqual([]);
    expect(JSON.stringify(raw.llm ?? null)).not.toContain("anthropic");
    expect(read?.usage.calls).toBe(0);
  }, 60_000);
});
