import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalService,
  ChatService,
  HobAdmission,
  HobbotsRepository,
  HobTools,
  SecretRedaction,
} from "@hobbots/agents";
import { Agent, AgentId, type ApprovalRequest, EMPTY_HOB_POLICY, isInProgress, type Message } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { ApprovalRepositoryLive, EventJournal, HobbotsRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, PubSub, Schedule, type Scope } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";

const HOB_ID = AgentId.make("wren");
const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-redaction-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const folder = join(root, "work");
mkdirSync(folder);

// A credential the hub holds, as one from its environment would be.
const DEPLOY_TOKEN = "hub-known-deploy-value-7f3a9c";
// Values Hobbots does not know, recognized by their shape.
const GITHUB_TOKEN = `ghp_${"a1B2".repeat(9)}`;
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAA -----END OPENSSH PRIVATE KEY-----";

const summonHob = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  yield* repo.insertAgent(
    new Agent({
      id: HOB_ID,
      name: "Wren",
      roleTitle: "Builder",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "You are Wren.",
      lookSeed: 77,
      lookColor: "moss",
      configVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
});

const tools = Layer.succeed(
  HobTools,
  HobTools.of({
    access: () =>
      Effect.succeed({
        policy: {
          preset: "balanced",
          sharedFolders: [folder],
          hob: EMPTY_HOB_POLICY,
          dataFolder: join(root, "data"),
          restrictions: [],
        },
        folders: [folder],
        runtimeFolder: join(root, "runtimes", HOB_ID),
      }),
  }),
);

const Persistence = Layer.mergeAll(HobbotsRepositoryLive, ApprovalRepositoryLive, EventJournal.layer).pipe(
  Layer.provideMerge(TestDatabase),
);
const TestLayer = ChatService.layer.pipe(
  Layer.provide(tools),
  Layer.provideMerge(ApprovalService.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effectDiscard(summonHob).pipe(Layer.provideMerge(Persistence)),
      EventBus.layer,
      HobAdmission.layer,
      FakeRuntimeLayer().pipe(Layer.provide(PolicyEngine.node)),
      SecretRedaction.layer([{ value: DEPLOY_TOKEN, kind: "DEPLOY_TOKEN" }]),
    ),
  ),
);

// Two commands that run, one printing a known credential and one a private key, then a push to a
// URL with a token in it, which asks.
const PROMPT = [
  "Deploy it",
  `fake:tool Bash echo ${DEPLOY_TOKEN}`,
  `fake:tool Bash echo ${PRIVATE_KEY}`,
  `fake:tool Bash git push https://wren:${GITHUB_TOKEN}@github.com/acme/app.git feature`,
].join("\n");

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ApprovalService | ChatService | HobbotsRepository | EventBus | EventJournal | Scope.Scope
  >,
) => effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise);

const leaks = (value: unknown) => {
  const text = JSON.stringify(value);
  return [DEPLOY_TOKEN, GITHUB_TOKEN, "b3BlbnNzaC1rZXktdjEAAAAA"].filter((secret) => text.includes(secret));
};

describe("secrets in tool calls", () => {
  // covers CH-004, PE-003
  it("[TC-PE-079] redacts known and recognized secrets from tool steps and approvals before they are stored, journaled or sent", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const approvals = yield* ApprovalService;
        const repo = yield* HobbotsRepository;
        const journal = yield* EventJournal;
        const subscription = yield* (yield* EventBus).subscribe;
        const thread = yield* chat.createThread(HOB_ID);
        yield* chat.sendPrompt(thread.id, PROMPT);
        const request = yield* approvals.listForThread(thread.id).pipe(
          Effect.flatMap((all) =>
            all[0] === undefined ? Effect.fail("none" as const) : Effect.succeed(all[0] as ApprovalRequest),
          ),
          Effect.retry(Schedule.spaced("5 millis")),
        );
        yield* approvals.decide(request.id, { decision: "deny", actionDigest: request.actionDigest });
        const reply = yield* repo.listMessages(thread.id).pipe(
          Effect.map((messages) => messages.at(-1) as Message),
          Effect.flatMap((m) =>
            m.role === "assistant" && !isInProgress(m.status) ? Effect.succeed(m) : Effect.fail("busy" as const),
          ),
          Effect.retry(Schedule.spaced("5 millis")),
        );
        const stored = yield* approvals.listForThread(thread.id);
        const journaled = yield* journal.readAfter(0);
        const published = yield* PubSub.takeAll(subscription);
        return { reply, stored, journaled, published };
      }),
    );

    // The user's prompt and the title made from it stay as written, and the reply's text is the
    // model's (the fake runtime echoes the prompt). Everything Hobbots reports about the tool calls is redacted.
    const fromHobbots = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value, (key, inner) => (["content", "title", "delta"].includes(key) ? undefined : inner)),
      );
    expect(result.reply.steps.filter((step) => step.kind === "tool").map((step) => step.label)).toEqual([
      "Running echo [redacted: DEPLOY_TOKEN]",
      "Running echo [redacted: private key]",
      "Running git push https://wren:[redacted: GitHub token]@github.com/a…",
    ]);
    expect(result.stored[0]?.arguments).toEqual({
      command: "git push https://wren:[redacted: GitHub token]@github.com/acme/app.git feature",
    });
    expect(leaks(result.reply.steps)).toEqual([]);
    expect(leaks(result.stored)).toEqual([]);
    // A client that resumes from the journal later never receives the raw value either.
    expect(leaks(fromHobbots(result.journaled))).toEqual([]);
    expect(leaks(fromHobbots(result.published))).toEqual([]);
    expect(result.journaled.some((entry) => entry.type === "ApprovalRequested")).toBe(true);
  });
});
