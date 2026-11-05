import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import type { RuntimeAdapterShape } from "@hobbots/agents";
import { policySandbox } from "@hobbots/domain";
import { waitUntil } from "@hobbots/domain/testing";
import { PolicyEngine } from "@hobbots/permissions";
import { type Duration, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { binaryLocator } from "../src/binary.ts";
import { codexEnforcement, makeCodex } from "../src/codex/adapter.ts";
import { startAppServer } from "../src/codex/app-server.ts";
import { billingOf, chatGptTokens, signInOf } from "../src/codex/auth.ts";
import { codexCandidates, codexPath, findCodex, minimumCodexVersion, parseCodexVersion } from "../src/codex/locate.ts";
import { listModels, toCodexModels } from "../src/codex/models.ts";
import { planFromRateLimits } from "../src/codex/plan.ts";
import type { Model, RateLimitSnapshot } from "../src/codex/protocol.ts";
import { ProcessSandbox } from "../src/sandbox.ts";
import { type FakeCodexOptions, fakeCodex, fakeCodexLog } from "./codex-fixture.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-codex-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let folders = 0;
const folder = () => join(temp, String(++folders));

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | PolicyEngine | ProcessSandbox>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          PolicyEngine.node,
          ProcessSandbox.unavailable("not needed for these checks"),
        ),
      ),
    ),
  );

/** The Codex adapter, running the stand-in written with `options`. */
const codexWith = (options: FakeCodexOptions, checkTimeout: Duration.Input = "10 seconds") => {
  const dir = folder();
  const executable = fakeCodex(dir, options);
  return {
    dir,
    adapter: run(
      makeCodex({ executable, clientVersion: "test", checkTimeout, workspaceDir: folder() }),
    ) as Promise<RuntimeAdapterShape>,
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
    // Its first `mini` is the small model for light work, such as memory's.
    expect(listed.small).toBe("gpt-mini");
    expect(toCodexModels([model({ model: "gpt-6" })]).small).toBeUndefined();
  });
});

// covers RT-001
describe("the App Server client", () => {
  it("[TC-RT-013] answers Codex's requests by method, refuses the rest, and ends with the process", async () => {
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
          // The answers to Codex's own requests go out on their own: the process keeps running
          // until the stand-in has read both, or ending the scope would stop it first.
          yield* waitUntil(
            Effect.sync(() => fakeCodexLog(dir).map((message) => message.id)),
            (ids) => ids.includes("ask-1") && ids.includes("ask-2"),
            { what: "the stand-in to read the answers to ask-1 and ask-2" },
          );
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
  }, 30_000);

  it("[TC-RT-014] fails what is waiting and ends notifications when Codex exits", async () => {
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

  it("[TC-RT-015] fails a start whose binary cannot run", async () => {
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
  // TC-RT-001 is retired: Codex turns run now (#438), so a ChatGPT sign-in is ready (TC-RT-034).
  it("[TC-RT-034] reports a ChatGPT sign-in as ready, read without a token or a refresh", async () => {
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
    const missing = await run(
      makeCodex({ executable: join(folder(), "codex"), clientVersion: "test", workspaceDir: folder() }),
    );
    expect(await Effect.runPromise(missing.health)).toMatchObject({ availability: "unavailable", version: null });
    const broken = await Effect.runPromise((await codexWith({ version: "" }).adapter).health);
    expect(broken).toMatchObject({ availability: "unavailable", version: null });
  });

  it("[TC-RT-006] reports a Codex that does not answer as not started, with its version", async () => {
    const health = await Effect.runPromise((await codexWith({ behavior: "silent" }, "300 millis").adapter).health);
    expect(health).toMatchObject({ availability: "unavailable", version: "0.166.0" });
  });

  // TC-RT-007 is retired: Codex turns run now (#438). TC-RT-032 is retired: the policy decides Codex's
  // tool calls now (#439), and TC-RT-060 checks what it enforces.
  // covers PE-005, ADR 024
  it("[TC-RT-060] declares the policy, events and interruption enforced, and the sandbox only where it started", async () => {
    const codex = await codexWith({}).adapter;
    const off = await Effect.runPromise(codex.enforcement);
    expect(off).toMatchObject({
      toolInterception: { status: "verified" },
      processSandbox: { status: "unsupported", evidence: "not needed for these checks" },
      hubTools: { status: "verified" },
      toolEvents: { status: "verified" },
      toolInterruption: { status: "verified" },
    });
    // Commands stay closed without the sandbox: the profile decides them as if it were missing.
    expect(policySandbox(off)).toBe("unavailable");
    const on = codexEnforcement({ state: "on", evidence: "sandbox-runtime on linux" });
    expect(on.processSandbox.status).toBe(process.platform === "darwin" ? "verified" : "unverified");
  });
});

// covers AG-005, RT-001
describe("Codex's models for the brain picker", () => {
  it("[TC-RT-008] lists every page Codex returns, without hidden models or ultra", async () => {
    const dir = folder();
    const binary = fakeCodex(dir, {
      pages: [
        [{ model: "gpt-6", supportedReasoningEfforts: efforts("low", "high", "ultra") }],
        [
          { model: "gpt-mini", supportedReasoningEfforts: efforts("low") },
          { model: "gpt-hidden", hidden: true },
        ],
      ],
    });
    const listed = await run(
      Effect.scoped(
        startAppServer(
          { command: binary, args: ["app-server"], env: { PATH: process.env.PATH ?? "" } },
          { clientVersion: "test" },
        ).pipe(Effect.flatMap(listModels)),
      ),
    );
    const models = toCodexModels(listed);
    expect(models.source).toBe("runtime");
    expect(models.models.map((entry) => [entry.id, entry.efforts])).toEqual([
      ["gpt-6", ["low", "high"]],
      ["gpt-mini", ["low"]],
    ]);
    expect(fakeCodexLog(dir).filter((message) => message.method === "model/list")).toHaveLength(2);
  });

  // TC-RT-016 is retired: Codex turns run now (#438), so a signed-in Codex offers its models (TC-RT-035).
  it("[TC-RT-035] offers a signed-in Codex's models to pick", async () => {
    const { dir, adapter } = codexWith({
      account: { type: "chatgpt", email: null, planType: "plus", workspaceName: null },
      pages: [[{ model: "gpt-6", supportedReasoningEfforts: efforts("low") }]],
    });
    const models = await Effect.runPromise((await adapter).models);
    expect(models).toMatchObject({ runtime: "codex", source: "runtime" });
    expect(models.models.map((entry) => entry.id)).toEqual(["gpt-6"]);
    expect(fakeCodexLog(dir).some((message) => message.method === "model/list")).toBe(true);
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

// covers AG-005
describe("noticing an update", () => {
  it("[TC-RT-017] asks a binary configured by bare name for its version again once it is updated", async () => {
    const dir = folder();
    fakeCodex(dir, { version: "codex-cli 0.166.0" });
    const locate = binaryLocator({
      find: () => "codex",
      parse: parseCodexVersion,
      env: () => ({ PATH: [dir, process.env.PATH ?? ""].join(delimiter) }),
      minimum: minimumCodexVersion,
    });
    expect(await Effect.runPromise(locate)).toMatchObject({ _tag: "Found", binary: "codex", version: "0.166.0" });
    const updated = fakeCodex(dir, { version: "codex-cli 0.167.0" });
    const later = new Date(Date.now() + 60_000);
    utimesSync(updated, later, later);
    expect(await Effect.runPromise(locate)).toMatchObject({ _tag: "Found", version: "0.167.0" });
  });
});

const snapshot = (fields: Partial<RateLimitSnapshot>): RateLimitSnapshot => ({
  limitId: "codex",
  limitName: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_793_800_000 },
  secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_794_200_000 },
  rateLimitReachedType: null,
  ...fields,
});

describe("Codex's plan usage", () => {
  const checkedAt = "2026-11-04T15:00:00.000Z";

  it("reports the five-hour and weekly windows as the session and the week", () => {
    const plan = planFromRateLimits({ rateLimits: snapshot({}), rateLimitsByLimitId: null }, checkedAt);
    expect(plan).toEqual({
      runtime: "codex",
      reported: true,
      checkedAt,
      extraUsage: null,
      meters: [
        {
          kind: "session",
          group: "session",
          percent: 12,
          resetsAt: new Date(1_793_800_000 * 1000).toISOString(),
          scope: null,
          severity: "normal",
          active: false,
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 40,
          resetsAt: new Date(1_794_200_000 * 1000).toISOString(),
          scope: null,
          severity: "normal",
          active: false,
        },
      ],
    });
  });

  it("lists every metered limit, the main one first, and scopes the others by name", () => {
    const plan = planFromRateLimits(
      {
        rateLimits: snapshot({}),
        rateLimitsByLimitId: {
          spark: snapshot({ limitId: "spark", limitName: "GPT Spark", secondary: null }),
          codex: snapshot({ rateLimitReachedType: "rate_limit_reached" }),
        },
      },
      checkedAt,
    );
    expect(plan.meters.map(({ kind, scope, severity }) => ({ kind, scope, severity }))).toEqual([
      { kind: "session", scope: null, severity: "critical" },
      { kind: "weekly_all", scope: null, severity: "critical" },
      { kind: "window", scope: "GPT Spark", severity: "normal" },
    ]);
  });

  it("reports nothing for an account without windows", () => {
    const plan = planFromRateLimits(
      { rateLimits: snapshot({ primary: null, secondary: null }), rateLimitsByLimitId: null },
      checkedAt,
    );
    expect(plan).toEqual({ runtime: "codex", reported: false, meters: [], extraUsage: null, checkedAt });
  });

  it("asks the App Server for the limits without their reset-credit details", async () => {
    const { dir, adapter } = codexWith({ rateLimits: { rateLimits: snapshot({}), rateLimitsByLimitId: null } });
    const plan = await Effect.runPromise((await adapter).planUsage ?? Effect.die("no plan usage"));
    expect(plan.reported).toBe(true);
    expect(plan.meters).toHaveLength(2);
    expect(fakeCodexLog(dir).find((message) => message.method === "account/rateLimits/read")?.params).toEqual({
      excludeResetCreditDetails: true,
    });
  });

  it("reports nothing when Codex cannot read the limits", async () => {
    const { adapter } = codexWith({});
    const plan = await Effect.runPromise((await adapter).planUsage ?? Effect.die("no plan usage"));
    expect(plan).toMatchObject({ runtime: "codex", reported: false, meters: [] });
  });
});
