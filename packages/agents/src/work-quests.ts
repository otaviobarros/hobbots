import type { ChannelNotFound } from "@hobbots/api";
import {
  type AgentId,
  type ChannelId,
  type Committed,
  FINISH_WORK_DESCRIPTION,
  FINISH_WORK_LABEL,
  FINISH_WORK_TOOL,
  FinishWorkInput,
  finishWorkJsonSchema,
  type MessageId,
  type PackRead,
  START_WORK_DESCRIPTION,
  START_WORK_LABEL,
  START_WORK_TOOL,
  StartWorkInput,
  startWorkJsonSchema,
  type WorkQuest,
  WorkQuestId,
  type WorkQuestRefused,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import type { CharmTurn } from "./charms.ts";
import { PackReports } from "./pack-reports.ts";
import { announcer, announcing, EventPublisher } from "./ports.ts";
import type { HubTool, HubToolAnswer, HubTools } from "./runtime.ts";

/**
 * Quests as work threads (ADR 041): a hob starts one with `start_work` where it is talking and ends
 * it with `finish_work`, on every runtime that serves hub tools. Until the rollout removes the Quest
 * of ADR 018, the code calls this one a work Quest.
 */

/** A Quest to start, as the command takes it. */
export interface WorkQuestStart {
  /** The new Quest's id, used only when its reply started none yet. */
  readonly id: WorkQuestId;
  readonly channelId: ChannelId;
  /** The thread it runs in; null for the main line. */
  readonly rootMessageId: MessageId | null;
  readonly title: string;
  readonly goal: string;
  readonly doneWhen: ReadonlyArray<string>;
  readonly expectedBy: string | null;
  readonly ownerHobId: AgentId;
  readonly repository: string | null;
  /** The reply whose turn starts it: a retried call from the same reply returns the Quest it started. */
  readonly startedFrom: MessageId;
  /** What the hob's session read first, from the report of the pack it started from (ADR 039). */
  readonly readFirst: ReadonlyArray<PackRead>;
  readonly at: string;
}

/** A hob's running Quest to finish, as the command takes it. */
export interface WorkQuestFinishRequest {
  readonly channelId: ChannelId;
  readonly rootMessageId: MessageId | null;
  readonly ownerHobId: AgentId;
  readonly result: string;
  readonly made: ReadonlyArray<string>;
  /** The reply whose turn finishes it: a retried call from the same reply returns the Quest it finished. */
  readonly from: MessageId;
  readonly at: string;
}

/**
 * Where Quests are kept (ADR 041). Each command runs its pure rule on the records as stored and
 * journals its event in the same transaction.
 */
export class WorkQuestRepository extends Context.Service<
  WorkQuestRepository,
  {
    /**
     * Starts a Quest, journaled as `WorkQuestStarted`, its requester read from the turn request its
     * reply answers. A reply that started one already gets that one back, and nothing is journaled.
     */
    readonly start: (
      request: WorkQuestStart,
    ) => Effect.Effect<Committed<WorkQuest>, WorkQuestRefused | ChannelNotFound>;
    /**
     * Finishes the hob's running Quest in the conversation, journaled as `WorkQuestChanged`. A reply
     * that finished one already gets that one back, and nothing is journaled.
     */
    readonly finish: (request: WorkQuestFinishRequest) => Effect.Effect<Committed<WorkQuest>, WorkQuestRefused>;
    /** The channel's Quests, oldest first. */
    readonly list: (channelId: ChannelId) => Effect.Effect<ReadonlyArray<WorkQuest>, ChannelNotFound>;
    /** The Quests the hob runs, active or waiting, in every channel, oldest first. */
    readonly runningOwnedBy: (ownerHobId: AgentId) => Effect.Effect<ReadonlyArray<WorkQuest>>;
  }
>()("@hobbots/agents/WorkQuestRepository") {}

/** The Quest commands (ADR 041), each announced once committed, and the read the chat takes. */
export class WorkQuests extends Context.Service<
  WorkQuests,
  {
    readonly start: (
      request: Omit<WorkQuestStart, "at">,
    ) => Effect.Effect<WorkQuest, WorkQuestRefused | ChannelNotFound>;
    readonly finish: (request: Omit<WorkQuestFinishRequest, "at">) => Effect.Effect<WorkQuest, WorkQuestRefused>;
    /** A channel's Quests, oldest first, for its cards. */
    readonly of: (channelId: ChannelId) => Effect.Effect<ReadonlyArray<WorkQuest>, ChannelNotFound>;
    /** The Quests the hob runs, which a hob that retires once its work is done waits for (#408). */
    readonly runningOwnedBy: (ownerHobId: AgentId) => Effect.Effect<ReadonlyArray<WorkQuest>>;
  }
>()("@hobbots/agents/WorkQuests") {
  static readonly layer = Layer.effect(
    WorkQuests,
    Effect.gen(function* () {
      const quests = yield* WorkQuestRepository;
      const announced = announcing(announcer(yield* Effect.serviceOption(EventPublisher), "a Quest"));
      const now = Effect.map(DateTime.now, DateTime.formatIso);
      return WorkQuests.of({
        start: (request) => Effect.flatMap(now, (at) => announced(quests.start({ ...request, at }))),
        finish: (request) => Effect.flatMap(now, (at) => announced(quests.finish({ ...request, at }))),
        of: quests.list,
        runningOwnedBy: quests.runningOwnedBy,
      });
    }),
  );
}

/**
 * Whether the hob runs a Quest in the channel, which a hob retiring once its work is done goes on
 * with there (#408). Without Quests it runs none.
 */
export const runsQuestIn = (quests: Option.Option<WorkQuests["Service"]>, hobId: AgentId, channelId: ChannelId) =>
  Option.isNone(quests)
    ? Effect.succeed(false)
    : Effect.map(quests.value.runningOwnedBy(hobId), (running) =>
        running.some((quest) => quest.channelId === channelId),
      );

/**
 * The Quest tools (ADR 041): `start_work` and `finish_work`, for a turn that writes a reply in a chat
 * or camp, whatever the hob's tool access, since they reach nothing outside the hub's own records.
 * A session outside any chat, a Task step's, is offered neither. Absent, a turn offers neither.
 */
export class WorkTools extends Context.Service<
  WorkTools,
  {
    /** The tools the turn offers, read at its start: none (null) for a turn outside any chat. */
    readonly forTurn: (turn: CharmTurn) => Effect.Effect<HubTools | null>;
  }
>()("@hobbots/agents/WorkTools") {}

/** Who offers the Quest tools, as a hub tool's owner is named. */
export const WORK_TOOLS_OWNER = "the Quest tools";

const START_WORK: HubTool = {
  name: START_WORK_TOOL,
  description: START_WORK_DESCRIPTION,
  inputSchema: startWorkJsonSchema(),
  label: START_WORK_LABEL,
};

const FINISH_WORK: HubTool = {
  name: FINISH_WORK_TOOL,
  description: FINISH_WORK_DESCRIPTION,
  inputSchema: finishWorkJsonSchema(),
  label: FINISH_WORK_LABEL,
};

/** The id of the Quest a reply's `start_work` makes: one per reply, so a retried call starts none twice. */
export const replyQuestId = (messageId: MessageId): WorkQuestId => WorkQuestId.make(`${messageId}:quest`);

export const START_WORK_UNREADABLE =
  'Give the Quest a `title`, a `goal` and at least one `done_when` line, such as ["The page is live"].';
export const FINISH_WORK_UNREADABLE =
  "Give what was delivered as `result`, and what the work made as `made` if anything.";

/** What the hob reads back once its Quest started. */
export const startedText = (quest: WorkQuest): string =>
  `Started the Quest "${quest.title}" (${quest.id}). Its card shows here. Finish it with ${FINISH_WORK_TOOL} once every "Done when" line holds.`;

/** What the hob reads back once its Quest is done. */
export const finishedText = (quest: WorkQuest): string =>
  `Finished the Quest "${quest.title}". Its card now shows it done for the person who asked to review.`;

const decodeStart = Schema.decodeUnknownEffect(StartWorkInput);
const decodeFinish = Schema.decodeUnknownEffect(FinishWorkInput);

const refusedAnswer = (refused: WorkQuestRefused): HubToolAnswer => ({
  text: `Refused (${refused.reason}): ${refused.message}`,
  refused: true,
});

/** `start_work` and `finish_work` for a turn, through `WorkQuests`, as the turn's hob, from its reply. */
export const WorkToolsLive = Layer.effect(
  WorkTools,
  Effect.gen(function* () {
    const quests = yield* WorkQuests;
    const reports = yield* Effect.serviceOption(PackReports);
    // What the hob's session read first: the pack it last started from in the channel, or nothing
    // when none is known, as for a session resumed after a restart (ADR 039). No model is asked.
    const readFirstOf = (channelId: ChannelId, hobId: AgentId) =>
      Option.isNone(reports)
        ? Effect.succeed([])
        : Effect.map(reports.value.lastOf(channelId, hobId), (report) =>
            Option.match(report, { onNone: () => [], onSome: (each) => each.read }),
          );
    // A runtime runs each call on its own, so it carries the hub's services, its logger included.
    const context = yield* Effect.context<never>();

    const start = (turn: CharmTurn, channelId: ChannelId, messageId: MessageId, raw: unknown) =>
      Effect.gen(function* () {
        const decoded = yield* decodeStart(raw).pipe(Effect.option);
        if (Option.isNone(decoded)) return { text: START_WORK_UNREADABLE, refused: true };
        const input = decoded.value;
        // What a hob wrote is redacted before it is kept, as everything the journal holds is.
        const kept = turn.redactor.text;
        const quest = yield* quests.start({
          id: replyQuestId(messageId),
          channelId,
          // Every turn runs in a channel's main line until reply threads come (#1484).
          rootMessageId: null,
          title: kept(input.title),
          goal: kept(input.goal),
          doneWhen: input.done_when.map(kept),
          expectedBy: input.expected_by ?? null,
          ownerHobId: turn.agentId,
          repository: input.repository === undefined ? null : kept(input.repository),
          startedFrom: messageId,
          readFirst: yield* readFirstOf(channelId, turn.agentId),
        });
        return { text: turn.redactor.text(startedText(quest)), refused: false };
      }).pipe(
        Effect.catchTags({
          WorkQuestRefused: (refused) => Effect.succeed(refusedAnswer(refused)),
          ChannelNotFound: () =>
            Effect.succeed({ text: "This chat or camp is gone, so no Quest started.", refused: true }),
        }),
      );

    const finish = (turn: CharmTurn, channelId: ChannelId, messageId: MessageId, raw: unknown) =>
      Effect.gen(function* () {
        const decoded = yield* decodeFinish(raw).pipe(Effect.option);
        if (Option.isNone(decoded)) return { text: FINISH_WORK_UNREADABLE, refused: true };
        const input = decoded.value;
        const quest = yield* quests.finish({
          channelId,
          rootMessageId: null,
          ownerHobId: turn.agentId,
          result: turn.redactor.text(input.result),
          made: (input.made ?? []).map(turn.redactor.text),
          from: messageId,
        });
        return { text: turn.redactor.text(finishedText(quest)), refused: false };
      }).pipe(Effect.catchTag("WorkQuestRefused", (refused) => Effect.succeed(refusedAnswer(refused))));

    /** What a turn's call answers: a failure the hub did not expect is logged, and the hob reads that it failed. */
    const answer = (name: string, run: Effect.Effect<HubToolAnswer>): Effect.Effect<HubToolAnswer> =>
      Effect.provideContext(
        Effect.catchCause(run, (cause) =>
          Effect.as(Effect.logError(`A ${name} call failed`, cause), {
            text: "Hobbots could not change the Quest. Try again later.",
            refused: true,
          }),
        ),
        context,
      );

    return WorkTools.of({
      forTurn: (turn) => {
        const { channelId, messageId } = turn;
        if (channelId === null || messageId === null) return Effect.succeed(null);
        return Effect.succeed({
          tools: [START_WORK, FINISH_WORK],
          call: (name, raw) =>
            name === START_WORK_TOOL
              ? answer(name, start(turn, channelId, messageId, raw))
              : name === FINISH_WORK_TOOL
                ? answer(name, finish(turn, channelId, messageId, raw))
                : Effect.succeed({ text: `${name} is not one of the Quest tools.`, refused: true }),
        });
      },
    });
  }),
);
