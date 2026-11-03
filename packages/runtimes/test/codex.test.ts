import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type { RuntimeAdapterShape } from "@hobbots/agents";
import { type Duration, Effect, Exit, Fiber, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { makeCodex } from "../src/codex/adapter.ts";
import { startAppServer } from "../src/codex/app-server.ts";
import { billingOf, chatGptTokens, signInOf } from "../src/codex/auth.ts";
import { codexCandidates, codexPath, findCodex, parseCodexVersion } from "../src/codex/locate.ts";
import { toCodexModels } from "../src/codex/models.ts";
import type { Model } from "../src/codex/protocol.ts";
import { type FakeCodexOptions, fakeCodex, fakeCodexLog } from "./codex-fixture.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-codex-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let folders = 0;
const folder = () => join(temp, String(++folders));

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

/** The Codex adapter, running the stand-in written with `options`. */
const codexWith = (options: FakeCodexOptions, checkTimeout: Duration.Input = "10 seconds") => {
  const dir = folder();
  const executable = fakeCodex(dir, options);
  return {
    dir,
    adapter: run(makeCodex({ executable, clientVersion: "test", checkTimeout })) as Promise<RuntimeAdapterShape>,
  };
};

const model = (fields: Partial<Model>): Model => ({
  id: "gpt-test",
  model: "gpt-test",
  displayName: "GPT Test",
  description: "A test model",
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "medium",
  inputModalities: ["text"],
  isDefault: false,
  ...fields,
});

const efforts = (...names: ReadonlyArray<string>) =>
  names.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));

describe("finding Codex", () => {
  it("reads the version `codex --version` prints", () => {
    expect(parseCodexVersion("codex-cli 0.166.0\n")).toBe("0.166.0");
    expect(parseCodexVersion("codex 0.170.2")).toBe("0.170.2");
    expect(parseCodexVersion("")).toBeUndefined();
    expect(parseCodexVersion("command not found")).toBeUndefined();
  });

  it("looks in npm's and Homebrew's folders before PATH, and gives Codex their PATH", () => {
    const env = { PATH: "/custom/bin:relative/bin", npm_config_prefix: "/opt/npm" };
    expect(codexCandidates(env, "/Users/me", ["/opt/homebrew/bin"])).toEqual([
      "/opt/npm/bin/codex",
      "/Users/me/.npm-global/bin/codex",
      "/Users/me/.local/bin/codex",
      "/opt/homebrew/bin/codex",
      "/custom/bin/codex",
    ]);
    expect(codexPath("/opt/npm/bin/codex", env, "/Users/me").split(":")[0]).toBe("/opt/npm/bin");
  });

  it("prefers the configured binary, resolving a relative path", () => {
    expect(findCodex("/somewhere/codex", {}, "/nowhere", [])).toBe("/somewhere/codex");
    expect(findCodex("codex", {}, "/nowhere", [])).toBe("codex");
    expect(findCodex(undefined, { PATH: "" }, "/nowhere", [])).toBeUndefined();
  });
});

describe("Codex's sign-in", () => {
  it("counts only a ChatGPT sign-in, and says where requests are billed", () => {
    const chatgpt = signInOf({
      account: { type: "chatgpt", email: "me@example.com", planType: "plus", workspaceName: null },
      requiresOpenaiAuth: true,
      workspaceRouting: null,
    });
    expect(chatgpt).toEqual({ _tag: "ChatGpt", plan: "plus", email: "me@example.com" });
    expect(billingOf(chatgpt)).toBe("subscription (plus)");

    const apiKey = signInOf({ account: { type: "apiKey" }, requiresOpenaiAuth: true, workspaceRouting: null });
    expect(apiKey).toEqual({ _tag: "NotChatGpt", kind: "api-key" });
    expect(billingOf(apiKey)).toBe("api-key");

    const signedOut = signInOf({ account: null, requiresOpenaiAuth: true, workspaceRouting: null });
    expect(billingOf(signedOut)).toBeNull();
  });
});

describe("Codex's models", () => {
  it("offers the models Codex shows, with the efforts Hobbots knows and never ultra", () => {
    const listed = toCodexModels([
      model({ model: "gpt-6", displayName: "GPT-6", supportedReasoningEfforts: efforts("low", "max", "ultra") }),
      model({ model: "gpt-mini", supportedReasoningEfforts: efforts("minimal", "low", "medium") }),
      model({ model: "gpt-secret", hidden: true, supportedReasoningEfforts: efforts("low") }),
    ]);
    expect(listed.runtime).toBe("codex");
    expect(listed.source).toBe("runtime");
    expect(listed.models.map((entry) => [entry.id, entry.efforts])).toEqual([
      ["gpt-6", ["low", "max"]],
      ["gpt-mini", ["low", "medium"]],
    ]);
  });
});

describe("the App Server client", () => {
  it("answers Codex's requests by method, refuses the rest, and ends with the process", async () => {
    const dir = folder();
    const binary = fakeCodex(dir, { behavior: "ask" });
    const answered = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startAppServer(
            { command: binary, args: ["app-server"], env: { PATH: process.env.PATH ?? "" } },
            {
              clientVersion: "test",
              handlers: { "item/tool/call": () => Effect.succeed({ success: true, contentItems: [] }) },
            },
          );
          const account = yield* server.request("account/read", { refreshToken: false });
          return { account, init: server.initialized };
        }),
      ),
    );
    expect(answered.account.account).toBeNull();
    expect(answered.init.codexHome).toBe("/fake");

    const log = fakeCodexLog(dir);
    expect(log.map((message) => message.method ?? message.id)).toEqual(
      expect.arrayContaining(["initialize", "initialized", "account/read", "ask-1", "ask-2"]),
    );
    expect(log.find((message) => message.id === "ask-1")?.result).toEqual({ success: true, contentItems: [] });
    expect(log.find((message) => message.id === "ask-2")?.error).toMatchObject({ code: -32601 });
    expect(log.find((message) => message.method === "initialize")?.params).toMatchObject({
      capabilities: { experimentalApi: true },
    });
  });

  it("fails what is waiting and ends notifications when Codex exits", async () => {
    const binary = fakeCodex(folder(), { behavior: "exit" });
    const result = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startAppServer(
            { command: binary, args: ["app-server"], env: { PATH: process.env.PATH ?? "" } },
            { clientVersion: "test" },
          );
          const notifications = yield* server.subscribe;
          const reading = yield* Stream.runCollect(notifications).pipe(Effect.forkScoped);
          const code = yield* server.exited;
          const after = yield* Effect.exit(server.request("account/read", {}));
          const read = yield* Fiber.join(reading);
          return { code, after, read };
        }),
      ),
    );
    expect(result.code).toBe(3);
    expect(Exit.isFailure(result.after)).toBe(true);
    expect(result.read).toHaveLength(0);
  });

  it("fails a start whose binary cannot run", async () => {
    const exit = await run(
      Effect.exit(
        Effect.scoped(
          startAppServer({ command: join(folder(), "missing"), args: [], env: {} }, { clientVersion: "test" }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("AppServerError");
  });
});

// covers AG-005, RT-001
describe("Codex's provider health", () => {
  it("[TC-RT-001] reports a ChatGPT sign-in as ready, read without a token or a refresh", async () => {
    const { dir, adapter } = codexWith({
      account: { type: "chatgpt", email: "me@example.com", planType: "pro", workspaceName: null },
    });
    const health = await Effect.runPromise((await adapter).health);
    expect(health).toMatchObject({
      runtime: "codex",
      availability: "ready",
      billing: "subscription (pro)",
      version: "0.166.0",
      detail: "me@example.com",
    });
    const methods = fakeCodexLog(dir).filter((message) => message.method !== undefined);
    expect(methods.find((message) => message.method === "account/read")?.params).toEqual({ refreshToken: false });
    expect(methods.some((message) => message.method === "getAuthStatus")).toBe(false);
  });

  it("[TC-RT-002] reports a Codex with no sign-in as signed out", async () => {
    const health = await Effect.runPromise((await codexWith({ account: null }).adapter).health);
    expect(health).toMatchObject({ availability: "signedOut", billing: null, version: "0.166.0" });
  });

  it("[TC-RT-003] reports an API-key sign-in as needing ChatGPT", async () => {
    const health = await Effect.runPromise((await codexWith({ account: { type: "apiKey" } }).adapter).health);
    expect(health).toMatchObject({ availability: "signedOut", billing: "api-key" });
  });

  it("[TC-RT-004] reports a Codex older than 0.166.0 as outdated without starting it", async () => {
    const { dir, adapter } = codexWith({ version: "codex-cli 0.165.9" });
    const health = await Effect.runPromise((await adapter).health);
    expect(health).toMatchObject({ availability: "outdated", version: "0.165.9" });
    expect(health.detail).toContain("0.166.0");
    expect(fakeCodexLog(dir)).toHaveLength(0);
  });

  it("[TC-RT-005] reports a missing or broken Codex as unavailable, with no version", async () => {
    const missing = await run(makeCodex({ executable: join(folder(), "codex"), clientVersion: "test" }));
    expect(await Effect.runPromise(missing.health)).toMatchObject({ availability: "unavailable", version: null });
    const broken = await Effect.runPromise((await codexWith({ version: "" }).adapter).health);
    expect(broken).toMatchObject({ availability: "unavailable", version: null });
  });

  it("[TC-RT-006] reports a Codex that does not answer as not started, with its version", async () => {
    const health = await Effect.runPromise((await codexWith({ behavior: "silent" }, "300 millis").adapter).health);
    expect(health).toMatchObject({ availability: "unavailable", version: "0.166.0" });
  });

  it("[TC-RT-007] enforces nothing until Codex turns run, and refuses a turn", async () => {
    const codex = await codexWith({}).adapter;
    const enforcement = await Effect.runPromise(codex.enforcement);
    expect(Object.values(enforcement).every((capability) => capability.status === "unsupported")).toBe(true);
    const turn = await Effect.runPromise(Effect.exit(Stream.runDrain(codex.sendPrompt({} as never))));
    expect(Exit.isFailure(turn)).toBe(true);
  });
});

// covers AG-005, RT-001
describe("Codex's models for the brain picker", () => {
  it("[TC-RT-008] lists every page Codex returns, without hidden models or ultra", async () => {
    const { dir, adapter } = codexWith({
      pages: [
        [{ model: "gpt-6", supportedReasoningEfforts: efforts("low", "high", "ultra") }],
        [
          { model: "gpt-mini", supportedReasoningEfforts: efforts("low") },
          { model: "gpt-hidden", hidden: true },
        ],
      ],
    });
    const models = await Effect.runPromise((await adapter).models);
    expect(models.source).toBe("runtime");
    expect(models.models.map((entry) => [entry.id, entry.efforts])).toEqual([
      ["gpt-6", ["low", "high"]],
      ["gpt-mini", ["low"]],
    ]);
    expect(fakeCodexLog(dir).filter((message) => message.method === "model/list")).toHaveLength(2);
  });

  it("[TC-RT-009] offers no models while Codex is missing or outdated", async () => {
    const outdated = await Effect.runPromise((await codexWith({ version: "codex-cli 0.100.0" }).adapter).models);
    expect(outdated).toMatchObject({ runtime: "codex", source: "fallback", models: [] });
  });
});

// covers RT-001
describe("signing a turn in", () => {
  const tokensFrom = (options: FakeCodexOptions) =>
    run(
      Effect.exit(
        Effect.scoped(
          startAppServer(
            { command: fakeCodex(folder(), options), args: ["app-server"], env: { PATH: process.env.PATH ?? "" } },
            { clientVersion: "test" },
          ).pipe(Effect.flatMap(chatGptTokens)),
        ),
      ),
    );

  it("[TC-RT-010] gets a fresh access token and the ChatGPT workspace from the hub's App Server", async () => {
    const exit = await tokensFrom({
      account: { type: "chatgpt", email: null, planType: "plus", workspaceName: null },
      workspace: "workspace-1",
      token: "access-token",
    });
    expect(exit).toEqual(
      Exit.succeed({ accessToken: "access-token", chatgptAccountId: "workspace-1", chatgptPlanType: "plus" }),
    );
  });

  it("[TC-RT-011] refuses to sign a turn in without a ChatGPT sign-in", async () => {
    const exit = await tokensFrom({ account: { type: "apiKey" }, token: "key" });
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("not signed in with ChatGPT");
  });
});
