import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  HobTools,
  type HubQuestionHandler,
  HubQuestions,
  PermissionSummary,
} from "@hobbots/agents";
import { HubQuestionsRead } from "@hobbots/api";
import { HubQuestion, pickedOption, type QuestionOption } from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  HubQuestionRepositoryLive,
  SearchIndex,
  SetupRepository,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Fiber, Layer, ManagedRuntime, Schema, type Scope } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// Issue #976: the hub itself asks you, with choices, about a decision only it can apply. The
// question goes straight to you over the same API the Inbox reads, never to a lead, and the part
// of the hub that raised it applies the choice you picked or the words you typed. The fake
// runtime stands in for every hob; none takes part.

const GITHUB: QuestionOption = { label: "My GitHub account", consequence: "Commits show as you on GitHub." };
const TYPED: QuestionOption = { label: "A name and email I type", consequence: "" };
const SUBJECT = { kind: "commit-identity", key: "default", title: "Commit identity" };

/** What the stand-in for the commit identity's handler applied, in order: the label picked, or the words typed. */
let applied: Array<{ readonly answer: string | null; readonly picked: string | null }>;

const identityHandler: HubQuestionHandler = {
  kind: SUBJECT.kind,
  apply: (question) =>
    Effect.sync(() => void applied.push({ answer: question.answer, picked: pickedOption(question)?.label ?? null })),
};

type Hub = Awaited<ReturnType<typeof startHub>>;
let hub: Hub | undefined;
afterEach(async () => {
  await hub?.dispose();
  hub = undefined;
});

const startHub = async () => {
  const App = HobLifecycle.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
        ApprovalService.layer,
        GrantService.layer,
        HobService.layer,
        PermissionSummary.layer,
        HubQuestions.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          HobbotsRepositoryLive,
          ApprovalRepositoryLive,
          GrantRepositoryLive,
          TaskRepositoryLive,
          HubQuestionRepositoryLive,
          EventJournal.layer,
          BackpackLive,
          SetupRepository.layer,
          SearchIndex.layer,
        ).pipe(Layer.provideMerge(TestDatabase)),
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        FakeRuntimeLayer({ availability: "signedOut" }),
        Layer.succeed(Installation, { app: "hobbots", installationId: "hub-questions", version: "0.0.0", dataDir: "" }),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(App);
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide(TestDevices),
      Layer.provide(Layer.succeedContext(await runtime.context())),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await web.handler(
      new Request(`http://localhost:4390${path}`, {
        method,
        headers: { ...AS_WINDOW, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as unknown };
  };
  return {
    request,
    run: <A, E>(effect: Effect.Effect<A, E, HubQuestions | Scope.Scope>) =>
      runtime.runPromise(Effect.scoped(effect) as Effect.Effect<A, E, HubQuestions>),
    /** Registers the handler for the life of the hub, as the part of the hub that raises the question would. */
    handle: (handler: HubQuestionHandler) =>
      runtime.runFork(
        Effect.scoped(
          Effect.andThen(
            HubQuestions.use((each) => each.handle(handler)),
            Effect.never,
          ),
        ),
      ),
    dispose: async () => {
      await web.dispose();
      await runtime.dispose();
    },
  };
};

const raise = (questions: HubQuestions["Service"]) =>
  questions.raise({ subject: SUBJECT, text: "Who should hobs commit as?", options: [GITHUB, TYPED], recommended: 0 });

const readOpen = async (current: Hub) => {
  const { status, body } = await current.request("GET", "/api/hub-questions");
  expect(status).toBe(200);
  return Schema.decodeUnknownSync(HubQuestionsRead)(body).questions;
};

const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 100 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
};

describe("a question the hub asks you itself", () => {
  // covers OR-004, IN-004
  it("[TC-OR-590] reaches you with its choices, you pick one in the Inbox, and the hub applies it", async () => {
    applied = [];
    hub = await startHub();
    const current = hub;
    current.handle(identityHandler);
    const raised = await current.run(HubQuestions.use(raise));

    // It waits for you with its choices and the recommended one, about the subject the hub named.
    const open = await readOpen(current);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: raised.id, subject: SUBJECT, options: [GITHUB, TYPED], recommended: 0 });

    // You pick a choice in the Inbox as its button does, sending its label; any case names it.
    const answered = await current.request("POST", `/api/hub-questions/${raised.id}/answer`, {
      answer: "my github account",
      via: "inbox",
    });
    expect(answered.status).toBe(200);
    expect(Schema.decodeUnknownSync(HubQuestion)(answered.body)).toMatchObject({
      state: "answered",
      answer: GITHUB.label,
      picked: 0,
      answeredVia: "inbox",
    });

    // The hub applies the choice you picked, once, and the question leaves the Inbox.
    await until(() => applied.length > 0);
    expect(applied).toEqual([{ answer: GITHUB.label, picked: GITHUB.label }]);
    expect(await readOpen(current)).toEqual([]);

    // It is answered: a second answer is refused, and so is one to a question that does not exist.
    const again = await current.request("POST", `/api/hub-questions/${raised.id}/answer`, { answer: "Formal" });
    expect(again).toMatchObject({ status: 409, body: { _tag: "HubQuestionClosed" } });
    const missing = await current.request("POST", "/api/hub-questions/nope/answer", { answer: "Formal" });
    expect(missing).toMatchObject({ status: 404, body: { _tag: "HubQuestionNotFound" } });
    expect(applied).toHaveLength(1);
  }, 30_000);

  // covers OR-004
  it("[TC-OR-591] applies an answer in your own words, even one given before its handler was there", async () => {
    applied = [];
    hub = await startHub();
    const current = hub;
    const raised = await current.run(HubQuestions.use(raise));
    const answered = await current.request("POST", `/api/hub-questions/${raised.id}/answer`, {
      answer: "Ada <ada@example.com>",
      via: "chat",
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ answer: "Ada <ada@example.com>", picked: null });
    // Nothing handles it yet, so the answer waits; the handler applies it once it registers.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(applied).toEqual([]);
    current.handle(identityHandler);
    await until(() => applied.length > 0);
    expect(applied).toEqual([{ answer: "Ada <ada@example.com>", picked: null }]);
  }, 30_000);

  // covers OR-004
  it("[TC-OR-592] keeps an answer its handler failed to apply, and applies it once when the handler next registers", async () => {
    applied = [];
    hub = await startHub();
    const current = hub;
    // The first handler fails, as one would when what it changes is out of reach.
    let tries = 0;
    const failing = current.handle({
      kind: SUBJECT.kind,
      apply: () => Effect.suspend(() => (tries++, Effect.fail("unreachable"))),
    });
    const raised = await current.run(HubQuestions.use(raise));
    const answered = await current.request("POST", `/api/hub-questions/${raised.id}/answer`, { answer: TYPED.label });
    expect(answered.status).toBe(200);
    await until(() => tries > 0);
    expect(applied).toEqual([]);

    // The answer is kept, not lost: when the handler registers again, as at the next start, it applies it once.
    await Effect.runPromise(Fiber.interrupt(failing));
    current.handle(identityHandler);
    await until(() => applied.length > 0);
    expect(applied).toEqual([{ answer: TYPED.label, picked: TYPED.label }]);
    expect(tries).toBe(1);

    // Applied answers are not applied again by a later registration.
    current.handle(identityHandler);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(applied).toHaveLength(1);
  }, 30_000);
});
