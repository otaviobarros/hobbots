import {
  type ApprovalAction,
  actionDigest,
  HobbotsRepository,
  type HubToolAnswer,
  type HubTools,
  makeRedactor,
  type ToolAccess,
  type TurnApprovals,
  WorkQuests,
  WorkTools,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  ApprovalId,
  Channel,
  ChannelId,
  EMPTY_HOB_POLICY,
  FINISH_WORK_TOOL,
  Message,
  MessageId,
  type PolicyDecision,
  roleFields,
  START_WORK_TOOL,
} from "@hobbots/domain";
import { HobbotsRepositoryLive, WorkQuestRepositoryLive } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { type HubCallRuntime, hubCallRuntimes } from "@hobbots/runtimes/testing";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkToolsLive } from "../src/work-tools.ts";

// `start_work` and `finish_work` on each runtime that serves hub tools (ADR 041): the fake runtime,
// and an installed Claude Code and Codex where HOBBOTS_CLAUDE_CODE and HOBBOTS_CODEX name them, each
// with a stand-in model. One turn starts a Quest in the camp's main line, and a second start in the
// same conversation is refused; the next turn finishes it, and the card reads it done. Each
// `start_work` is decided under Ada's Start a Quest answer (#1597).

const NOW = "2026-11-16T00:00:00.000Z";
const ADA = AgentId.make("ada");

const hub = ManagedRuntime.make(
  WorkToolsLive.pipe(
    Layer.provideMerge(WorkQuests.layer),
    Layer.provideMerge(Layer.mergeAll(HobbotsRepositoryLive, WorkQuestRepositoryLive)),
    Layer.provideMerge(TestDatabase),
  ),
);

const reply = (channelId: ChannelId, id: string) =>
  new Message({
    id: MessageId.make(id),
    channelId,
    role: "assistant",
    content: "",
    status: "streaming",
    error: null,
    configVersion: 1 as Message["configVersion"],
    createdAt: NOW,
  });

/** Ada's tool access, on Balanced, with her own Start a Quest answer when one is given. */
const accessWith = (answer?: PolicyDecision): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: [],
    hob: { ...EMPTY_HOB_POLICY, overrides: answer === undefined ? {} : { "start-quest": answer } },
    dataFolder: "/hobbots-data",
    restrictions: [],
  },
  folders: [],
  runtimeFolder: "/hobbots-data/runtimes/ada",
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

/** Approvals that answer every request with `decision`, keeping each action asked about in `asked`. */
const answering = (decision: "approve" | "deny", access: ToolAccess, asked: Array<ApprovalAction>): TurnApprovals => ({
  request: (action) =>
    Effect.map(actionDigest(action), (digest) => {
      asked.push(action);
      return {
        approvalId: ApprovalId.make(`approval-${asked.length}`),
        decision: Effect.succeed(
          decision === "approve"
            ? { _tag: "Approved", actionDigest: digest, policyVersion: action.policyVersion, lifetime: "once" }
            : { _tag: "Denied", reason: "Not this week" },
        ),
      };
    }),
  currentAccess: Effect.succeed(access),
  grants: Effect.succeed([]),
  used: () => Effect.void,
});

/** A reply of Ada's being written in `channelId`, with the Quest tools its turn is offered. */
const turnIn = (
  channelId: ChannelId,
  id: string,
  access: ToolAccess = accessWith(),
  approvals: TurnApprovals | null = null,
) =>
  hub.runPromise(
    Effect.gen(function* () {
      const message = reply(channelId, id);
      yield* (yield* HobbotsRepository).upsertMessage(message);
      const tools = yield* WorkTools.use((service) =>
        service.forTurn({
          agentId: ADA,
          channelId,
          messageId: message.id,
          scope: () => `reply:${message.id}`,
          currentAccess: Effect.succeed(access),
          redactor: makeRedactor([]),
          approvals,
        }),
      );
      if (tools === null) throw new Error("No Quest tools for a chat turn");
      // Every answer the hob read, in order.
      const answers: Array<HubToolAnswer> = [];
      const hubTools: HubTools = {
        tools: tools.tools,
        call: (name, input, step) =>
          Effect.tap(tools.call(name, input, step), (answer) => Effect.sync(() => answers.push(answer))),
      };
      return { messageId: message.id, hubTools, answers };
    }),
  );

const campOf = (name: string) =>
  hub.runPromise(
    Effect.gen(function* () {
      const channelId = ChannelId.make(`camp-${name}`);
      yield* (yield* HobbotsRepository).upsertChannel(
        new Channel({ id: channelId, ownerHobId: ADA, title: name, createdAt: NOW, updatedAt: NOW }),
      );
      return channelId;
    }),
  );

const expectedRuntimes = [
  "fake",
  ...(process.env.HOBBOTS_CLAUDE_CODE === undefined ? [] : ["claude-code"]),
  ...(process.env.HOBBOTS_CODEX === undefined ? [] : ["codex"]),
];

let runtimes: Awaited<ReturnType<typeof hubCallRuntimes>>;
beforeAll(async () => {
  runtimes = await hubCallRuntimes();
  await hub.runPromise(
    Effect.flatMap(HobbotsRepository, (repo) =>
      repo.insertAgent(
        new Agent({
          id: ADA,
          name: "Ada",
          ...roleFields("writer"),
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 1,
          lookColor: "moss",
          configVersion: 1,
          createdAt: NOW,
        }),
      ),
    ),
  );
});
afterAll(async () => {
  runtimes.close();
  await hub.dispose();
});

const START = {
  title: "Winter market page",
  goal: "A landing page for the winter market.",
  done_when: ["The page is live", "It shows the map"],
  expected_by: "2026-12-01",
};

/** Runs a turn on `runtime` that starts a Quest twice, then one that finishes it. */
const work = async (runtime: HubCallRuntime) => {
  const channelId = await campOf(runtime.name);
  const first = await turnIn(channelId, `start-${runtime.name}`);
  const started = await runtime.turn({
    hubTools: first.hubTools,
    recordToolStart: () => Effect.succeed(true),
    calls: [
      { tool: START_WORK_TOOL, input: START },
      { tool: START_WORK_TOOL, input: { ...START, title: "Another page" } },
    ],
  });
  expect(Exit.isSuccess(started.exit), String(started.exit)).toBe(true);
  const running = await hub.runPromise(WorkQuests.use((quests) => quests.of(channelId)));
  const second = await turnIn(channelId, `finish-${runtime.name}`);
  const finished = await runtime.turn({
    hubTools: second.hubTools,
    recordToolStart: () => Effect.succeed(true),
    calls: [{ tool: FINISH_WORK_TOOL, input: { result: "The page is live with the map.", made: ["PR #12"] } }],
  });
  expect(Exit.isSuccess(finished.exit), String(finished.exit)).toBe(true);
  const done = await hub.runPromise(WorkQuests.use((quests) => quests.of(channelId)));
  return { first, second, running, done };
};

describe("start_work and finish_work on every runtime", () => {
  // covers ADR 041 (Tools)
  it("each runtime starts a Quest where the hob talks, refuses a second, and finishes it (#1596)", {
    timeout: 240_000,
  }, async () => {
    expect(runtimes.runtimes.map((runtime) => runtime.name)).toEqual(expectedRuntimes);
    for (const runtime of runtimes.runtimes) {
      const { first, second, running, done } = await work(runtime);
      expect(
        first.answers.map((answer) => answer.refused),
        runtime.name,
      ).toEqual([false, true]);
      expect(first.answers[1]?.text, runtime.name).toContain("busy");
      expect(
        running.map((quest) => ({ title: quest.title, state: quest.state, startedFrom: quest.startedFrom })),
        runtime.name,
      ).toEqual([{ title: "Winter market page", state: "active", startedFrom: first.messageId }]);
      expect(
        second.answers.map((answer) => answer.refused),
        runtime.name,
      ).toEqual([false]);
      expect(
        done.map((quest) => ({
          state: quest.state,
          ownerHobId: quest.ownerHobId,
          doneWhen: quest.doneWhen,
          expectedBy: quest.expectedBy,
          result: quest.result,
          made: quest.made,
          finishedFrom: quest.finishedFrom,
        })),
        runtime.name,
      ).toEqual([
        {
          state: "done",
          ownerHobId: ADA,
          doneWhen: ["The page is live", "It shows the map"],
          expectedBy: "2026-12-01",
          result: "The page is live with the map.",
          made: ["PR #12"],
          finishedFrom: second.messageId,
        },
      ]);
    }
  });

  // covers ADR 041 (Starting)
  it("each runtime decides start_work under Start a Quest: Ask shows the suggested Quest and starts it once approved, a denial and Never start none (#1597)", {
    timeout: 240_000,
  }, async () => {
    for (const runtime of runtimes.runtimes) {
      const channelId = await campOf(`answers-${runtime.name}`);
      const started = async (id: string, answer: PolicyDecision, decision: "approve" | "deny") => {
        const access = accessWith(answer);
        const asked: Array<ApprovalAction> = [];
        const turn = await turnIn(channelId, `${id}-${runtime.name}`, access, answering(decision, access, asked));
        const ran = await runtime.turn({
          hubTools: turn.hubTools,
          recordToolStart: () => Effect.succeed(true),
          calls: [{ tool: START_WORK_TOOL, input: START }],
        });
        expect(Exit.isSuccess(ran.exit), String(ran.exit)).toBe(true);
        const quests = await hub.runPromise(WorkQuests.use((service) => service.of(channelId)));
        return { asked, answers: turn.answers, quests };
      };

      const never = await started("never", "deny", "approve");
      expect(never.asked, runtime.name).toEqual([]);
      expect(
        never.answers.map((answer) => answer.refused),
        runtime.name,
      ).toEqual([true]);
      expect(never.answers[0]?.text, runtime.name).toContain("never allows starting a Quest");
      expect(never.quests, runtime.name).toEqual([]);

      const denied = await started("denied", "ask", "deny");
      expect(
        denied.asked.map((action) => action.operation),
        runtime.name,
      ).toEqual(["start-quest"]);
      expect(denied.answers[0]?.text, runtime.name).toContain("Not this week");
      expect(denied.quests, runtime.name).toEqual([]);

      const approved = await started("approved", "ask", "approve");
      expect(approved.asked, runtime.name).toMatchObject([
        {
          tool: START_WORK_TOOL,
          operation: "start-quest",
          targets: ["Winter market page"],
          arguments: {
            title: START.title,
            goal: START.goal,
            done_when: START.done_when,
            expected_by: START.expected_by,
          },
          grantable: false,
        },
      ]);
      expect(
        approved.answers.map((answer) => answer.refused),
        runtime.name,
      ).toEqual([false]);
      expect(
        approved.quests.map((quest) => quest.title),
        runtime.name,
      ).toEqual(["Winter market page"]);
    }
  });
});
