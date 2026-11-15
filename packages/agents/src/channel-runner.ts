import {
  type Actor,
  type Agent,
  type AgentConfiguration,
  AgentId,
  type BackpackTurnEnd,
  type Brain,
  Channel,
  type ChannelId,
  ChannelLifecycle,
  ChannelMembers,
  type ChannelRunStatus,
  DEFAULT_CHANNEL_TITLE,
  decideFloor,
  type FloorHob,
  type FloorPhase,
  type FloorSnapshot,
  hobActor,
  hobReads,
  holdsEveryChatTool,
  isInProgress,
  type Line,
  lineKey,
  liveSession,
  Message,
  MessageId,
  type MessageStatus,
  mainLine,
  nextRequest,
  openChannelTask,
  QueuedMessageTransitions,
  replyActivity,
  startsAtOnce,
  systemInstructions,
  TurnRequest,
  TurnRequestId,
  TurnRequests,
  titleFromPrompt,
  type WebReadMark,
} from "@hobbots/domain";
import { DateTime, Deferred, Effect, Fiber, FiberMap, HashMap, Option, Ref, Semaphore } from "effect";
import { HobAdmission, withChannelLock } from "./admission.ts";
import { ChannelMemberRepository } from "./channel-members.ts";
import {
  type ChannelRun,
  type ChannelRunEvent,
  ChannelRunMachine,
  idleRun,
  isAtRest,
  isBusy,
  isDispatching,
  type Reply,
  runStatus,
} from "./channel-run.ts";
import { type CarriedEnd, type CarriedWork, Continuations } from "./continuations.ts";
import { makePackPeople, type TurnReason, turnReasonOf } from "./pack-people.ts";
import { passStands } from "./pass-tool.ts";
import { EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import { runtimeAdapters } from "./runtime.ts";
import { type Speaker, speakerIn } from "./speaker.ts";
import { stoppedCommands, uncertainCalls } from "./steps.ts";
import { TaskTurns } from "./task-turns.ts";
import { TaskRepository } from "./tasks.ts";
import type { makeTurnInputs } from "./turn-inputs.ts";
import { makePackSources } from "./turn-pack.ts";
import { type Carry, makeTurnRunner, type TurnRunnerDeps } from "./turn-runner.ts";
import { type TurnSlot, takeSlot, turnSlots } from "./turn-slots.ts";
import { workHeld } from "./work-hold.ts";

// Every channel's run (#1397): when its turns start and end, what queued behind them, and the work
// the backpack carries into them. ChatService decides what you asked for; this runs it.

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/**
 * Whether a member hob's turn, registered after it launched at `launchedAt`, has to stop: the hob
 * is gone, its running work was stopped (at `stoppedAt`) since the turn launched, or it retired
 * with its work stopped. A pause, or a retirement that lets running replies finish, stops none
 * (ADR 039). Times are epoch milliseconds.
 */
export const memberTurnLeft = (hob: Option.Option<Agent>, stoppedAt: number | null, launchedAt: number): boolean => {
  if (Option.isNone(hob)) return true;
  if (stoppedAt === null) return false;
  const { status, retiredAt } = hob.value;
  return stoppedAt >= launchedAt || (status === "retired" && retiredAt !== null && stoppedAt >= Date.parse(retiredAt));
};

/** The transcript before `saved`, the turn's reply, without the turn's own prompt. */
const earlierThan = (transcript: ReadonlyArray<Message>, saved: Message, promptId: MessageId | null) =>
  transcript
    .slice(
      0,
      Math.max(
        0,
        transcript.findIndex((m) => m.id === saved.id),
      ),
    )
    .filter((m) => m.id !== promptId);

/** What a turn carries when it carries no backpack items. */
const NOTHING_CARRIED: Carry = {
  holding: [],
  accepted: () => Effect.void,
  late: Effect.succeed(false),
  routineOnly: true,
};

/** How a turn starts: its reply's id, what it carries, and whether its end starts what waits next. */
interface TurnStart {
  readonly replyId?: MessageId;
  /** Told after the briefing, as Hobbots' own words: the work that rides along your message. */
  readonly context?: string | null;
  readonly carry?: Carry | null;
  /** False when whoever started the turn starts what waits next, once it has settled the turn's work. */
  readonly drain?: boolean;
  /**
   * The slot the turn runs in (#1448), freed when it ends. Absent for a turn that carries backpack
   * work, which runs in its dispatch's slot.
   */
  readonly slot?: TurnSlot;
}

/** How a turn that carried work ended early, as a code: a reply still running was interrupted. */
const turnEnd = (status: MessageStatus): BackpackTurnEnd =>
  status === "failed" || status === "stopped" || status === "limited" ? status : "interrupted";

/** The brain a channel's turn thinks with: the channel's own, else the hob's configuration's. */
export const brainFor = (channel: Channel, config: AgentConfiguration): Brain =>
  channel.brain ?? { runtime: config.runtime, model: config.model, effort: config.effort };

/** What the channel runner takes from ChatService: the writes it announces, and what a turn starts with. */
export interface ChannelRunnerDeps
  extends Pick<TurnRunnerDeps, "redactor" | "grants" | "saveMessage" | "announce" | "changeChannel"> {
  readonly inputs: Effect.Success<ReturnType<typeof makeTurnInputs>>;
  /**
   * Starts a queued message together with its reply, the requests the turn answers taking the floor
   * with it; null when the message or a request no longer waits.
   */
  readonly saveStarted: (
    message: Message,
    reply: Message,
    speaking: ReadonlyArray<TurnRequestId>,
  ) => Effect.Effect<Message | null>;
  /** Saves a turn's new reply, the requests it answers taking the floor with it; null when one no longer waits. */
  readonly saveSpeaking: (reply: Message, speaking: ReadonlyArray<TurnRequestId>) => Effect.Effect<Message | null>;
}

/**
 * The read-the-web mark a hob's reply in a turn's context carries, if one does (ADR 039, A relay
 * carries the read-the-web mark): the reply it answers, in any chapter, the live chapter its session
 * hears, and the reply Continue resumes. What it wrote may carry what a page said.
 */
const contextReadWeb = (
  yours: Message | undefined,
  told: ReadonlyArray<Message>,
  continued: Message | null,
): WebReadMark | null =>
  [...(yours === undefined ? [] : [yours]), ...told, ...(continued === null ? [] : [continued])].find(
    (m) => m.readWeb !== null,
  )?.readWeb ?? null;

export const makeChannelRunner = (deps: ChannelRunnerDeps) =>
  Effect.gen(function* () {
    const { redactor, grants, inputs, saveMessage, announce, changeChannel, saveStarted, saveSpeaking } = deps;
    const { brief, instructionsChanged } = inputs;
    const repo = yield* HobbotsRepository;
    const packSources = yield* makePackSources;
    const packPeople = yield* makePackPeople;
    const bus = yield* EventPublisher;
    const admission = yield* HobAdmission;
    // Without a backpack, a channel starts only your queued messages.
    const continuations = yield* Effect.serviceOption(Continuations);
    // Without members, a channel's own hob is the only one that speaks there.
    const members = yield* Effect.serviceOption(ChannelMemberRepository);
    // After a restore nothing that waited starts on its own until you resume work (ADR 026).
    const held = yield* workHeld;
    // Without turn slots, as in tests of one part, no turn waits for one (#1448).
    const slots = yield* turnSlots;
    // Without Task records, a chat's turns are in no Quest.
    const taskRecords = yield* Effect.serviceOption(TaskRepository);
    const adapters = yield* runtimeAdapters;
    // Without Task tools, as in tests of one part, a chat's turns offer none.
    const offersTaskTools = Option.isSome(yield* Effect.serviceOption(TaskTurns));
    /**
     * `channel` as a turn of `agent` on `runtime` sees it (#1543). A runtime that keeps the hub tools a
     * session started with, as Codex does (ADR 024), never gets a Task tool its session lacks, so a
     * hob in a channel that started before that tool existed could never call it. Such a session, or
     * one without `pass` (ADR 039), or one whose tools are not known, is
     * left out: the turn starts a new session from the context pack in its place, as in a new chapter,
     * and the new one is recorded over it.
     */
    const withoutStaleSession = (channel: Channel, runtime: Brain["runtime"], agentId: AgentId): Channel => {
      if (adapters(runtime)?.resumeKeepsHubTools !== true) return channel;
      const live = liveSession(channel, runtime, agentId);
      if (live === undefined || holdsEveryChatTool(live.taskTools, offersTaskTools)) return channel;
      return new Channel({ ...channel, sessions: channel.sessions.filter((session) => session !== live) });
    };
    const scope = yield* Effect.scope;
    const turns = yield* FiberMap.make<ChannelId>();
    // The hob of each channel's turn, from when `TurnStarted` announces it until `TurnEnded` does, so
    // a read made on either event names the hob whose runtime runs there, a member's in a camp too.
    const turnHobs = yield* Ref.make(
      HashMap.empty<ChannelId, { readonly agentId: AgentId; readonly turn: Fiber.Fiber<unknown, unknown> }>(),
    );
    // When each hob's running work was last stopped, in epoch milliseconds, so a member turn that
    // registered after the sweep still stops (ADR 039).
    const stops = yield* Ref.make(HashMap.empty<AgentId, number>());
    const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    // Every line's run (ADR 037, ADR 039), changed only through `ChannelRunMachine`, keyed by
    // `lineKey`. In memory, as turns are; what waits is the stored `TurnRequest`s and backpack items.
    // A line with no entry is idle. `revision` counts every transition, so clients can order what
    // each publishes. Every turn runs in a channel's main line until threads come (#1472).
    interface LineRun {
      readonly line: Line;
      readonly run: ChannelRun;
    }
    interface Runs {
      readonly all: HashMap.HashMap<string, LineRun>;
      readonly revision: number;
    }
    const runs = yield* Ref.make<Runs>({ all: HashMap.empty(), revision: 0 });
    interface StepResult {
      readonly before: ChannelRun;
      readonly taken: boolean;
    }
    const runIn = (all: Runs["all"], line: Line) =>
      Option.match(HashMap.get(all, lineKey(line)), { onNone: () => idleRun, onSome: ({ run }) => run });
    const runOf = (channelId: ChannelId) =>
      Ref.get(runs).pipe(Effect.map(({ all }) => runIn(all, mainLine(channelId))));
    // Applies an event to the line's run: `taken` says whether its rules allowed it, and `before`
    // is the run it found. A run back at rest is dropped, so the map holds only what is remembered.
    // Every transition taken is published once as `ChannelRunChanged`, after the change.
    const step = (channelId: ChannelId, event: ChannelRunEvent) =>
      Ref.modify(runs, (current): readonly [StepResult & { readonly published: ChannelRunStatus | null }, Runs] => {
        const line = mainLine(channelId);
        const before = runIn(current.all, line);
        const after = ChannelRunMachine.transition(before, event);
        if (typeof after === "string") return [{ before, taken: false, published: null }, current];
        const revision = current.revision + 1;
        const key = lineKey(line);
        const all = isAtRest(after)
          ? HashMap.remove(current.all, key)
          : HashMap.set(current.all, key, { line, run: after });
        return [
          { before, taken: true, published: runStatus(line, after, revision) },
          { all, revision },
        ];
      }).pipe(
        Effect.tap(({ published }) =>
          published === null ? Effect.void : bus.publishTransient({ _tag: "ChannelRunChanged", run: published }),
        ),
        Effect.map(({ before, taken }): StepResult => ({ before, taken })),
      );
    // An event the run loop only sends when the run allows it: a refusal is a bug in the loop.
    const must = (channelId: ChannelId, event: ChannelRunEvent) =>
      step(channelId, event).pipe(
        Effect.flatMap((result) =>
          result.taken
            ? Effect.succeed(result)
            : Effect.die(new Error(`ChannelRun: ${event._tag} is not allowed while the run is ${result.before.run}`)),
        ),
      );

    // The reply in memory becomes `next`, and the channel's run learns what the reply is doing now.
    // A reply that no longer runs there changes nothing in the run.
    const setReply = (reply: Reply, next: Message) =>
      Ref.set(reply.current, next).pipe(
        Effect.andThen(step(next.channelId, { _tag: "ReplyChanged", reply, activity: replyActivity(next) })),
        Effect.asVoid,
      );

    // Applies a domain transition to a running reply, `apply` taking the result in. The lock keeps
    // the turn and a stop request from saving out of order. Finished replies reject changes, so late
    // runtime events and repeated stops are ignored.
    const changeReply = <A>(
      reply: Reply,
      f: (message: Message) => Message | unknown,
      apply: (next: Message) => Effect.Effect<A>,
    ) =>
      Semaphore.withPermit(
        reply.lock,
        Effect.gen(function* () {
          const next = f(yield* Ref.get(reply.current));
          return next instanceof Message ? Option.some(yield* apply(next)) : Option.none<A>();
        }),
      );

    // The reply in memory takes the result, then `after` runs with it.
    const transition = <A>(
      reply: Reply,
      f: (message: Message) => Message | unknown,
      after: (next: Message) => Effect.Effect<A>,
    ) => changeReply(reply, f, (next) => Effect.andThen(setReply(reply, next), after(next)));

    // The reply in memory takes the result only once `save` has committed it, and the save is not cut
    // short: a stop that comes while it runs waits for it. So a stop's own save, which starts from the
    // reply in memory, never writes what was not committed, nor drops what was.
    const committedTransition = <A>(
      reply: Reply,
      f: (message: Message) => Message | unknown,
      save: (next: Message) => Effect.Effect<A>,
    ) => changeReply(reply, f, (next) => Effect.uninterruptible(Effect.tap(save(next), () => setReply(reply, next))));

    const { runTurn } = yield* makeTurnRunner({
      redactor,
      grants,
      inputs,
      saveMessage,
      announce,
      changeChannel,
      transition,
      committedTransition,
      turnEnded: (channelId, reply) => step(channelId, { _tag: "TurnEnded", reply }),
    });

    // A slot for a turn in the channel, under the hub's cap on turns (#1590); null when the turn must
    // wait, and then the channel is woken once a slot may be its. Runs under the hob's lock.
    const slotFor = (channel: Channel, agent: Agent): Effect.Effect<TurnSlot | null> =>
      takeSlot(
        slots,
        { id: `thread:${channel.id}`, agentId: agent.id },
        Effect.suspend(() => drainChannels([channel.id])),
      );

    // Starts a turn for a prompt that is already stored, or for a continuation's prompt, which
    // Hobbots wrote from the work that arrived (ADR 019): a continuation has no message of yours, so
    // its reply follows the channel's last message. Runs under the hob's lock; the channel is busy
    // from here until the turn's drain releases it, so later prompts queue behind it.
    // `saveReply` stores the new streaming reply; the turn starts only once it is saved.
    const beginTurn = (
      speaker: Speaker,
      prompt: Message | string,
      saveReply: (reply: Message) => Effect.Effect<Message | null> = saveMessage,
      start: TurnStart = {},
    ) =>
      Effect.gen(function* () {
        const { channel, agent } = speaker;
        const config = yield* repo.findAgentConfig(agent.id, agent.configVersion).pipe(Effect.map(Option.getOrThrow));
        const brain = brainFor(channel, config);
        const now = yield* nowIso;
        const assistantMessage = new Message({
          id: start.replyId ?? MessageId.make(crypto.randomUUID()),
          channelId: channel.id,
          // Written by the hob that speaks, which in a camp need not be the channel's first hob.
          actor: hobActor(agent.id),
          role: "assistant",
          content: "",
          status: "streaming",
          error: null,
          configVersion: config.version,
          runtime: brain.runtime,
          model: brain.model,
          promptId: typeof prompt === "string" ? null : prompt.id,
          createdAt: now,
        });
        const saved = yield* saveReply(assistantMessage);
        if (saved === null) {
          yield* start.slot?.release ?? Effect.void;
          return null;
        }
        const yours = typeof prompt === "string" ? null : prompt;
        const updated = yield* changeChannel(channel.id, (latest) =>
          yours !== null && latest.title === DEFAULT_CHANNEL_TITLE
            ? new Channel({ ...latest, title: titleFromPrompt(yours.content), updatedAt: now })
            : new Channel({ ...latest, updatedAt: now }),
        ).pipe(Effect.map(Option.getOrElse(() => channel)));
        const content = yours === null ? (prompt as string) : yours.content;
        const turn = yield* launch(
          { ...speaker, channel: updated },
          config,
          content,
          saved,
          yours?.id ?? null,
          null,
          start,
        );
        return { saved, turn };
      }).pipe(Effect.onError(() => start.slot?.release ?? Effect.void));

    // Runs a turn for a reply that is already saved as streaming, on the channel's brain, with what
    // its session missed told first. `promptId` is the turn's own prompt, when it is a message;
    // `continued` the reply Continue resumes, as it was before this turn.
    // Runs under the hob's lock.
    const launch = (
      given: Speaker,
      config: AgentConfiguration,
      prompt: string,
      saved: Message,
      promptId: MessageId | null,
      continued: Message | null = null,
      start: TurnStart = {},
    ) =>
      Effect.gen(function* () {
        const launchedAt = yield* nowMillis;
        const { agent } = given;
        const channel = withoutStaleSession(given.channel, brainFor(given.channel, config).runtime, agent.id);
        const speaker: Speaker = { ...given, channel };
        const brain = brainFor(channel, config);
        // A note to self never reaches a turn (ADR 037).
        const transcript = (yield* repo.listMessages(channel.id)).filter((m) => m.status !== "queued" && hobReads(m));
        const before = earlierThan(transcript, saved, promptId);
        // A reply continued on another brain is told too, with the text and tool steps its first
        // brain left, so the new one does not redo or contradict that work.
        const switched = continued !== null && continued.runtime !== brain.runtime;
        // A new session starts from the context pack; a resumed one hears what other brains wrote in
        // the live chapter since. Only the live chapter is ever replayed (ADR 037).
        const inChapter = before.filter((m) => m.chapterId === channel.liveChapterId);
        const told = switched ? [...inChapter, continued] : inChapter;
        const people = yield* packPeople(speaker);
        const reason =
          speaker.reason ??
          turnReasonOf(transcript.find((m) => m.id === promptId) ?? null, channel, people.rows, agent.id, people.quest);
        const briefed = yield* brief(speaker, brain.runtime, told, switched, people, reason);
        const pack =
          liveSession(channel, brain.runtime, agent.id) === undefined
            ? yield* packSources(channel, told, before, people, reason)
            : null;
        // Every turn hears of every call the channel left uncertain, whichever brain runs it, since a
        // reply that completes is no proof one was checked: none is repeated unchecked (EX-004).
        // Continue names the continued reply's own.
        const uncertain = uncertainCalls(before.flatMap((m) => (m.role === "assistant" ? m.steps : [])));
        // The turn right after a reply hears of the commands you stopped while it waited (#1056).
        const lastReply = before.findLast((m) => m.role === "assistant");
        const stopped = lastReply === undefined ? null : stoppedCommands(lastReply.steps);
        const briefing =
          [briefed, uncertain, stopped, start.context ?? null].filter((part) => part !== null).join("\n\n") || null;
        const changed = yield* instructionsChanged(speaker, brain.runtime, systemInstructions(config.name, config));
        const yours = saved.promptId === null ? undefined : transcript.find((m) => m.id === saved.promptId);
        // Registered before the turn starts, so a stop sent right away still reaches it.
        const reply: Reply = {
          current: yield* Ref.make(saved),
          lock: yield* Semaphore.make(1),
          stepsFrom: saved.steps.length,
          prefix: saved.content,
          // Only work that needs the hob is held back when you stop the turn; progress waits anyway.
          carries: start.carry != null && !start.carry.routineOnly,
          endWait: yield* Deferred.make<void>(),
          waitsStopped: yield* Ref.make<number | null>(null),
          passed: yield* Ref.make<string | null>(null),
        };
        // Who waits behind it is published first, so the turn's start says who is next.
        yield* lineUp(channel.id);
        yield* must(channel.id, { _tag: "Launch", hobId: agent.id, reply, activity: replyActivity(saved) });
        // The drain is forked outside the turn: it waits for the hob's lock, which a retirement
        // may hold while it waits for this very turn to stop.
        const turn = yield* FiberMap.run(
          turns,
          channel.id,
          runTurn(
            speaker,
            config,
            brain,
            prompt,
            { text: briefing, pack, readWeb: contextReadWeb(yours, told, continued) },
            reply,
            changed,
            start.carry ?? NOTHING_CARRIED,
            // The message of yours the reply answers, as you wrote it, which Continue keeps (#1005).
            yours,
          ).pipe(
            // However the turn ended, the requests it spoke for are answered, or passed with no
            // message when its hob passed (ADR 039), before the floor frees.
            Effect.ensuring(endRequests(saved.id, reply)),
            // The slot frees before the drain, so what waits here can take it.
            Effect.ensuring(start.slot?.release ?? Effect.void),
            Effect.ensuring(start.drain === false ? Effect.void : Effect.forkIn(drain(channel.id), scope)),
          ),
        );
        yield* announceTurn(channel.id, agent.id, turn);
        yield* stopIfLeft(speaker, launchedAt);
        return { turn, reply };
      }).pipe(Effect.onError(() => start.slot?.release ?? Effect.void));

    // A member hob is admitted under the camp's lock, not its own, so a stop of its running work may
    // have swept them before this turn was there to see. Read again once the turn is registered: it
    // stops when the hob is gone, when its work was stopped since the turn launched, or when it
    // retired with its work stopped. A pause, or a retirement that lets running replies finish,
    // leaves the turn to finish (ADR 039).
    const stopIfLeft = ({ channel, agent, role }: Speaker, launchedAt: number) =>
      Effect.gen(function* () {
        if (role === "owner") return;
        const agentId = agent.id;
        const stopped = HashMap.get(yield* Ref.get(stops), agentId);
        const left = memberTurnLeft(yield* repo.findAgent(agentId), Option.getOrNull(stopped), launchedAt);
        if (left) yield* endTurn(channel.id);
      });

    // Stops every turn where the hob holds the floor, in its own channels or in camps it joined, and
    // records when, so a member turn admitted meanwhile stops once it registers.
    const stopHob = (agentId: AgentId) =>
      Effect.gen(function* () {
        const at = yield* nowMillis;
        yield* Ref.update(stops, HashMap.set(agentId, at));
        for (const channelId of yield* activeChannels) {
          if ((yield* runOf(channelId)).speaking === agentId) yield* endTurn(channelId);
        }
      });

    // Tells clients when a turn joins the running turns and when it has left them, so a read of
    // `activeChannels` made on either event already agrees with it. The map drops a turn in the
    // observer it added first, so it is gone before this await returns, after the runtime exited.
    const announceTurn = (channelId: ChannelId, agentId: AgentId, turn: Fiber.Fiber<unknown, unknown>) =>
      Effect.gen(function* () {
        // A turn that already ended never joined the map for long; its end is announced below.
        if (yield* FiberMap.has(turns, channelId)) {
          yield* Ref.update(turnHobs, HashMap.set(channelId, { agentId, turn }));
          yield* bus.publishTransient({ _tag: "TurnStarted", channelId, agentId });
        }
        // Only this turn's entry goes: the channel's next turn may have started meanwhile.
        const leave = Ref.update(turnHobs, (all) =>
          Option.match(HashMap.get(all, channelId), {
            onNone: () => all,
            onSome: (entry) => (entry.turn === turn ? HashMap.remove(all, channelId) : all),
          }),
        );
        yield* Fiber.await(turn).pipe(
          Effect.andThen(leave),
          Effect.andThen(bus.publishTransient({ _tag: "TurnEnded", channelId, agentId })),
          Effect.forkIn(scope),
        );
      });

    // Ends the requests the turn writing `replyId` spoke for: passed, with no message, when its hob
    // called `pass` (ADR 039) and did nothing after it that the reply must keep; answered otherwise.
    const endRequests = (replyId: MessageId, reply: Reply) =>
      Effect.gen(function* () {
        const reason = yield* Ref.get(reply.passed);
        if (reason === null || !passStands(yield* Ref.get(reply.current), reply.stepsFrom)) {
          return yield* repo.answerTurnRequests(replyId);
        }
        const channelId = (yield* Ref.get(reply.current)).channelId;
        const transcript = yield* repo.listMessages(channelId);
        const before = transcript[transcript.findIndex((m) => m.id === replyId) - 1]?.id;
        const committed = yield* repo.passTurnRequests(replyId, reason);
        yield* bus.publish(committed.entries);
        if (committed.value.length > 0 && before !== undefined) yield* seenBefore(channelId, replyId, before);
      });

    // A session that saw the channel through a reply that is gone saw it through the message before
    // it, so the session's next turn is told only what came after (#1462).
    const seenBefore = (channelId: ChannelId, gone: MessageId, before: MessageId) =>
      changeChannel(channelId, (latest) =>
        latest.sessions.some((session) => session.seenThrough === gone)
          ? new Channel({
              ...latest,
              sessions: latest.sessions.map((session) =>
                session.seenThrough === gone ? { ...session, seenThrough: before } : session,
              ),
            })
          : null,
      ).pipe(Effect.asVoid);

    // Publishes who waits for the line's floor, and whose relay waits for a person, from its
    // requests as stored now.
    const lineUp = (channelId: ChannelId) =>
      Effect.gen(function* () {
        const open = yield* repo.openTurnRequests(mainLine(channelId));
        const next = [...new Set(TurnRequests.waiting(open).map((request) => request.hobId))];
        yield* step(channelId, { _tag: "Lined", next, paused: TurnRequests.pausedHobs(open) });
      });

    // The hobs among `hobIds` that take work now in `channel`, by id. A member hob that is retiring
    // takes work in a camp it joined only for a Task of its own open there; the channel's own hob
    // keeps its rules for open Tasks.
    const activeHobs = (channel: Channel, hobIds: ReadonlyArray<AgentId>) =>
      Effect.gen(function* () {
        const owner = channel.ownerHobId;
        const found = yield* Effect.forEach([...new Set(hobIds)], (hobId) => repo.findAgent(hobId));
        const retiringMember = found.some(
          (agent) => Option.isSome(agent) && agent.value.retiring !== null && agent.value.id !== owner,
        );
        const trees =
          retiringMember && Option.isSome(taskRecords) ? yield* taskRecords.value.readChannelTrees(channel.id) : [];
        const mayWork = (agent: Agent) =>
          agent.retiring === null || agent.id === owner || openChannelTask(trees, agent.id) !== undefined;
        const takesWork = (agent: Agent) => agent.status === "active" && mayWork(agent);
        return new Map(
          found.flatMap((agent) =>
            Option.isSome(agent) && takesWork(agent.value) ? [[agent.value.id, agent.value] as const] : [],
          ),
        );
      });

    // The hobs that speak in the channel: its own hob, then its active member hobs as they joined.
    const hobsOf = (channel: Channel) => {
      const owner = channel.ownerHobId;
      return Option.isNone(members)
        ? Effect.succeed<ReadonlyArray<AgentId>>([owner])
        : members.value
            .list(channel.id)
            .pipe(
              Effect.map((list) => [
                owner,
                ...list.flatMap((member) =>
                  member.actor.kind === "hob" && ChannelMembers.isActive(member) && member.actor.id !== owner
                    ? [AgentId.make(member.actor.id)]
                    : [],
                ),
              ]),
            );
    };

    // Runs `effect` under the channel's lock, its own hob's, which every turn of the channel takes.
    const underChannel = <A>(channelId: ChannelId, effect: Effect.Effect<A>) =>
      repo
        .findChannel(channelId)
        .pipe(
          Effect.flatMap((channel) =>
            Option.isNone(channel) ? effect : withChannelLock(admission, channel.value, effect),
          ),
        );

    // Why a turn runs, as its request records it.
    const reasonOf = (request: TurnRequest): TurnReason => ({ cause: request.cause, by: request.causedBy });

    /**
     * Everything the floor's decision reads for the line, as the records stand now, with the channel
     * and the hobs that take work there; null when the channel is gone. `asking` names a hob a request
     * about to be sent waits for. Runs under the line's lock.
     *
     * The backpack is read only where the decision looks (ADR 019, IN-005): with a request next, its
     * hob's work and routine progress; with none, the work of each hob of the camp. An archived line,
     * a hub holding the work that waited, and a dispatch's own decision read none: `read` says so.
     */
    const snapshotOf = (channelId: ChannelId, phase: FloorPhase, sent: MessageId | null = null, asking?: AgentId) =>
      Effect.gen(function* () {
        const found = yield* repo.findChannel(channelId);
        if (Option.isNone(found)) return null;
        const channel = found.value;
        const run = yield* runOf(channelId);
        const requests = yield* repo.openTurnRequests(mainLine(channelId));
        const camp = yield* hobsOf(channel);
        const asked = [
          ...TurnRequests.waiting(requests).map((request) => request.hobId),
          ...(asking === undefined ? [] : [asking]),
        ];
        const hobIds = [...new Set([...camp, ...asked])];
        const awake = yield* activeHobs(channel, hobIds);
        const open = ChannelLifecycle.isOpen(channel);
        const restoring = yield* held;
        const queued = run.held.length > 0 && Option.isSome(yield* repo.nextQueuedMessage(channelId));
        const facts = hobIds.map(
          (hobId): FloorHob => ({
            hobId,
            available: awake.has(hobId),
            member: camp.includes(hobId),
            held: run.held.includes(hobId),
            work: false,
            progress: false,
          }),
        );
        const bare: FloorSnapshot = {
          phase,
          open,
          restoring,
          sent,
          backpack: Option.isSome(continuations),
          requests,
          chosen: run.chosen,
          hobs: facts,
          queued,
        };
        const service = open && !restoring && phase._tag === "Free" ? Option.getOrNull(continuations) : null;
        if (service === null) return { snapshot: bare, channel, awake, read: false };
        const next = nextRequest(bare)?.hobId;
        const riders = new Set([next, asking].filter((hobId): hobId is AgentId => hobId !== undefined));
        const looked = next === undefined ? new Set([...camp, ...riders]) : riders;
        const hobs = yield* Effect.forEach(facts, (hob) =>
          Effect.gen(function* () {
            if (!hob.member || !looked.has(hob.hobId)) return hob;
            const work = (yield* service.waiting(hob.hobId)).includes(channelId);
            const progress = riders.has(hob.hobId) && (yield* service.progressWaits(channelId, hob.hobId));
            return { ...hob, work, progress };
          }),
        );
        return { snapshot: { ...bare, hobs }, channel, awake, read: true };
      });

    /** A turn the floor started: its reply as saved, the running turn, and the request it answers. */
    interface Begun {
      readonly saved: Message;
      readonly turn: { readonly turn: Fiber.Fiber<unknown, unknown>; readonly reply: Reply };
      readonly request: TurnRequest;
    }

    /** The slot a turn starting now was handed, and the hob it counts against (#1448). */
    interface Handed {
      readonly hobId: AgentId;
      readonly slot: TurnSlot;
    }

    /**
     * Moves the line's floor on (ADR 039, #1549): the one place a turn or a dispatch starts there,
     * from `decideFloor`. Runs under the line's lock. A turn may start in the slot it was `handed`,
     * when that counts against its hob; any other slot handed is given up. `sent` is the message of
     * yours being sent, which starts even while the hub holds work after a restore. Returns the turn
     * it started and the request it answers, if any.
     */
    const advance = (
      channelId: ChannelId,
      handed: Handed | null = null,
      sent: MessageId | null = null,
    ): Effect.Effect<Begun | null> =>
      Effect.gen(function* () {
        const giveUp = handed?.slot.release ?? Effect.void;
        if (isBusy(yield* runOf(channelId))) {
          yield* giveUp;
          yield* lineUp(channelId);
          return null;
        }
        const read = yield* snapshotOf(channelId, { _tag: "Free" }, sent);
        if (read === null) {
          yield* giveUp;
          return null;
        }
        const { snapshot, channel, awake } = read;
        const { action, release } = decideFloor(snapshot);
        // A message of yours waiting there takes the work you stopped along with it.
        if (release) yield* step(channelId, { _tag: "Release" });
        if (action._tag === "Start") return yield* startIn(channel, awake, action.request, handed);
        yield* giveUp;
        if (action._tag !== "Dispatch") return yield* rest(channelId, snapshot, read.read).pipe(Effect.as(null));
        const carrier = awake.get(action.hobId);
        if (carrier === undefined || Option.isNone(continuations)) {
          return yield* Effect.die(new Error("The floor dispatched for a hob that takes no work, or with no backpack"));
        }
        yield* dispatch(continuations.value, channel, carrier);
        // A dispatch that waits for a slot leaves the line saying who waits, as a turn does.
        yield* lineUp(channelId);
        return null;
      });

    // Starts the request the floor gave its turn, in the slot handed for it when that counts against
    // its hob: one handed for another hob's turn goes back. A turn that waits for a slot leaves the
    // line saying who waits.
    const startIn = (
      channel: Channel,
      awake: ReadonlyMap<AgentId, Agent>,
      request: TurnRequest,
      handed: Handed | null,
    ): Effect.Effect<Begun | null> =>
      Effect.gen(function* () {
        const agent = awake.get(request.hobId);
        if (agent === undefined) return yield* Effect.die(new Error("The floor started a hob that takes no work"));
        if (handed !== null && handed.hobId !== agent.id) yield* handed.slot.release;
        const slot = handed?.hobId === agent.id ? handed.slot : yield* slotFor(channel, agent);
        if (slot === null) return yield* lineUp(channel.id).pipe(Effect.as(null));
        return yield* startRequest(channel, agent, request, { slot });
      });

    // Nobody can take the floor now: the line still says who waits, as after a restart, and a line
    // whose records were read and hold nothing waiting gives its place for a slot up, so it holds
    // back no other turn. One whose backpack went unread, as while the hub holds work after a
    // restore, keeps its place.
    const rest = (channelId: ChannelId, snapshot: FloorSnapshot, read: boolean) =>
      Effect.gen(function* () {
        if (snapshot.open && !snapshot.restoring) yield* step(channelId, { _tag: "Unchoose", messageId: null });
        const waits = TurnRequests.waiting(snapshot.requests).length > 0 || snapshot.hobs.some((hob) => hob.work);
        if (slots !== null && read && !waits) yield* slots.withdraw(`thread:${channelId}`);
        yield* lineUp(channelId);
      });

    /**
     * Starts the request's turn: the request takes the floor together with its turn's reply, and a
     * queued message starts with them, so a crash cannot leave one without the others. A message
     * already said, as one that several hobs owe, is the prompt of each later one. The turn runs for
     * the request, which says why (#1465).
     */
    const startRequest = (
      channel: Channel,
      agent: Agent,
      request: TurnRequest,
      start: TurnStart,
    ): Effect.Effect<Begun | null> =>
      Effect.gen(function* () {
        yield* step(channel.id, { _tag: "Unchoose", messageId: null });
        const message = yield* repo.findMessage(request.messageId);
        if (Option.isNone(message)) {
          yield* start.slot?.release ?? Effect.void;
          return null;
        }
        const speaker = speakerIn(channel, agent, reasonOf(request));
        const started = QueuedMessageTransitions.start(message.value);
        const begun =
          started instanceof Message
            ? yield* beginTurn(speaker, started, (reply) => saveStarted(started, reply, [request.id]), start)
            : yield* beginTurn(speaker, message.value, (reply) => saveSpeaking(reply, [request.id]), start);
        return begun === null ? null : { ...begun, request };
      });

    // The dispatcher puts the backpack work waiting for the hob there into the line's next turn, in
    // one slot for the whole dispatch, or waits for one (#1448). The dispatch reads the backpack after
    // this, so it sees whatever a wake until now announced.
    const dispatch = (service: Continuations["Service"], channel: Channel, agent: Agent) =>
      Effect.gen(function* () {
        const slot = yield* slotFor(channel, agent);
        if (slot === null) return;
        yield* must(channel.id, { _tag: "Dispatch", hobId: agent.id });
        yield* Effect.forkIn(carryWork(service, channel.id, agent.id, slot), scope);
      });

    // Delivers the work waiting for the hob in the channel, then frees the line and moves its floor
    // on. When no turn ran for it, the next turn may start in the dispatch's slot if it is this hob's:
    // given up and asked for again, the slot would go to the channels that waited longer, which would
    // do the same (#1448).
    const carryWork = (service: Continuations["Service"], channelId: ChannelId, hobId: AgentId, slot: TurnSlot) => {
      let handed = false;
      return Effect.gen(function* () {
        const ran = yield* service
          .deliver(channelId, hobId, {
            // The floor plans a turn for the work, or none: routine progress alone starts no turn.
            plan: (routineOnly) =>
              underChannel(
                channelId,
                snapshotOf(channelId, { _tag: "Carrying", hobId, routineOnly, late: false }).pipe(
                  Effect.map((read) =>
                    read === null || decideFloor(read.snapshot).action._tag === "Idle"
                      ? null
                      : MessageId.make(crypto.randomUUID()),
                  ),
                ),
              ),
            run: (replyId, work) => carryingTurn(channelId, hobId, replyId, work),
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not deliver a hob's backpack work", cause).pipe(Effect.as(false)),
            ),
          );
        yield* underChannel(
          channelId,
          Effect.gen(function* () {
            yield* must(channelId, { _tag: "Delivered" });
            handed = true;
            if (ran) {
              yield* slot.release;
              yield* advance(channelId);
            } else yield* advance(channelId, { hobId, slot });
          }),
        );
      }).pipe(Effect.ensuring(Effect.suspend(() => (handed ? Effect.void : slot.release))));
    };

    // One turn that carries the work, as the floor decides it: the hob's request that is next, the
    // work riding along, else a continuation whose prompt is the work. Returns once the turn has
    // ended, and how.
    const carryingTurn = (
      channelId: ChannelId,
      hobId: AgentId,
      replyId: MessageId,
      work: CarriedWork,
    ): Effect.Effect<CarriedEnd> =>
      Effect.gen(function* () {
        const start = { replyId, carry: work, drain: false } as const;
        const begun = yield* underChannel(
          channelId,
          Effect.gen(function* () {
            // Work that went late while the turn waited to start, as when you cancel its Quest,
            // starts no continuation: it resolves as late (#993).
            const phase: FloorPhase = {
              _tag: "Carrying",
              hobId,
              routineOnly: work.routineOnly,
              late: yield* work.late,
            };
            const read = yield* snapshotOf(channelId, phase);
            if (read === null) return null;
            const { action } = decideFloor(read.snapshot);
            const agent = read.awake.get(hobId);
            if (agent === undefined) return null;
            if (action._tag === "Start") {
              const context = work.text("context");
              return (yield* startRequest(read.channel, agent, action.request, { ...start, context }))?.turn ?? null;
            }
            if (action._tag !== "Continue") return null;
            const speaker = speakerIn(read.channel, agent);
            return (yield* beginTurn(speaker, work.text("prompt"), saveMessage, start))?.turn ?? null;
          }),
        );
        if (begun === null) return { _tag: "EndedEarly", end: "unavailable", diagnostic: null };
        // A dispatch that stops waiting, as when the turn's claim is lost, stops the turn too, so
        // no second turn starts over it.
        yield* Fiber.await(begun.turn).pipe(Effect.onInterrupt(() => FiberMap.remove(turns, channelId)));
        const ended = yield* Ref.get(begun.reply.current);
        if (ended.status === "complete") return { _tag: "Handled" };
        // The reply's error is what the runtime said; how the turn ended is a code the client words.
        return { _tag: "EndedEarly", end: turnEnd(ended.status), diagnostic: ended.error ?? null };
      });

    // After a turn ends, frees its line and moves its floor on.
    const drain = (channelId: ChannelId) =>
      Effect.gen(function* () {
        // The ended turn may still be leaving the map; a new turn must not replace it there.
        const ended = yield* FiberMap.get(turns, channelId);
        if (Option.isSome(ended)) yield* Fiber.await(ended.value);
        yield* underChannel(channelId, step(channelId, { _tag: "Drained" }).pipe(Effect.andThen(advance(channelId))));
      });

    // Moves the floor on in each channel: after a restart, when a paused hob wakes, or when work
    // arrives for its hob. A busy line moves on once it is free.
    const drainChannels = (channelIds: ReadonlyArray<ChannelId>) =>
      Effect.forEach(channelIds, (channelId) => underChannel(channelId, advance(channelId)), { discard: true });

    /**
     * Whether a message of yours sent now in the channel, owed by `agentId`, takes the floor at once:
     * the line is free, nothing ahead of it can speak, and no backpack work of the hob goes first.
     * Runs under the line's lock.
     */
    const sendsAtOnce = (channelId: ChannelId, agentId: AgentId, by: Actor, at: string) =>
      Effect.gen(function* () {
        if (isBusy(yield* runOf(channelId))) return false;
        const read = yield* snapshotOf(channelId, { _tag: "Free" }, null, agentId);
        if (read === null) return false;
        const messageId = MessageId.make(crypto.randomUUID());
        const yours = new TurnRequest({
          id: TurnRequestId.make(messageId),
          channelId,
          rootMessageId: null,
          hobId: agentId,
          messageId,
          causedBy: by,
          cause: "only-hob",
          relayDepth: 0,
          state: "waiting",
          replyId: null,
          droppedBy: null,
          queuedAt: Number.MAX_SAFE_INTEGER,
          position: 0,
          createdAt: at,
        });
        return startsAtOnce(read.snapshot, yours);
      });

    const activeChannels = Effect.sync(() => Array.from(turns, ([channelId]) => channelId));
    const activeTurns = Ref.get(turnHobs).pipe(
      Effect.map((all) => Array.from(all, ([channelId, { agentId }]) => ({ channelId, agentId }))),
    );
    const channelRuns = Ref.get(runs).pipe(
      Effect.map(({ all, revision }) => ({
        revision,
        runs: Array.from(HashMap.values(all)).flatMap(({ line, run }) =>
          // An idle line still says who waits for the floor, or for a person, so a client that
          // reconnects sees it.
          isBusy(run) || run.next.length > 0 || run.paused.length > 0 ? [runStatus(line, run, revision)] : [],
        ),
      })),
    );
    const streamingReplies = Effect.suspend(() =>
      Ref.get(runs).pipe(
        Effect.flatMap(({ all }) =>
          Effect.forEach(
            Array.from(HashMap.values(all)).flatMap(({ run }) => (run.reply === null ? [] : [run.reply])),
            (reply) => Ref.get(reply.current),
          ),
        ),
      ),
    ).pipe(Effect.map((messages) => messages.filter((message) => isInProgress(message.status))));

    /**
     * Holds the work a dispatch is putting through, while no turn of it has launched yet: the turn
     * it would start finds its hob held and starts nothing, and the work waits for you (ADR 039).
     * Called under the channel's lock, which a dispatch's turn is admitted under.
     */
    const holdDispatch = (channelId: ChannelId) =>
      Effect.gen(function* () {
        const run = yield* runOf(channelId);
        if (isDispatching(run) && run.carrier !== null) yield* step(channelId, { _tag: "Hold", hobId: run.carrier });
      });

    /** Stops the channel's running turn, if any, and returns once it has ended. */
    const endTurn = (channelId: ChannelId) => FiberMap.remove(turns, channelId);

    return {
      runOf,
      step,
      transition,
      launch,
      slotFor,
      advance,
      sendsAtOnce,
      lineUp,
      drainChannels,
      endTurn,
      stopHob,
      holdDispatch,
      hobsOf,
      activeChannels,
      activeTurns,
      channelRuns,
      streamingReplies,
    } as const;
  });
