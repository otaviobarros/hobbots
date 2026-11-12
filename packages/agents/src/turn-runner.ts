import {
  type Agent,
  type AgentConfiguration,
  type AgentId,
  type Brain,
  type Committed,
  liveSession,
  Message,
  type MessageId,
  MessageTransitions,
  RUNTIME_NAMES,
  type RuntimeKind,
  type RuntimeSession,
  stripEscapes,
  systemInstructions,
  type TaskBriefMark,
  type TaskId,
  type Thread,
  type ThreadId,
  type TurnEnding,
  toolsSucceeded,
  type WebReadMark,
} from "@hobbots/domain";
import { DateTime, Effect, Option, Ref, Semaphore, Stream } from "effect";
import { ApprovalService } from "./approvals.ts";
import { contextBlock } from "./briefing.ts";
import { type CharmTurn, hubToolOffer, joinHubTools, type WebRecordPlace } from "./charms.ts";
import { stoppableWait } from "./command-wait.ts";
import type { CarriedWork } from "./continuations.ts";
import { EventPublisher, ToolLogs } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";
import {
  type CallSteering,
  type HubTools,
  type RuntimeEvent,
  runtimeAdapters,
  type ToolAccess,
  type ToolStartedEvent,
} from "./runtime.ts";
import { type Redactor, redactEvent } from "./secrets.ts";
import {
  askedSkillOf,
  namedSkills,
  runtimePrompt,
  skillUseRecorder,
  TurnSkillsInUse,
  withUsedSkill,
} from "./skill-turn.ts";
import { nextSteps, replyStepId } from "./steps.ts";
import { type ChatTaskTurn, TaskTurns } from "./task-turns.ts";
import { callScope } from "./tasks.ts";
import type { Reply } from "./thread-run.ts";
import { keepToolOutput } from "./tool-output.ts";
import { ActivityRecorder, trackTurn } from "./turn-activity.ts";
import type { makeTurnGrants } from "./turn-grants.ts";
import { draftGoneText, type makeTurnInputs, withSkills } from "./turn-inputs.ts";
import { PackReports, type PackSources, packTurn } from "./turn-pack.ts";
import { makeTurnSession } from "./turn-session.ts";
import { makeWebProvenance, webWorkOf } from "./web-fetch.ts";
import { makeWebMark, webMarkBriefing, withWebMark } from "./web-mark.ts";
import { type WebSearchTurn, webSearchRequest, webSearchTurn } from "./web-usage.ts";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** Backpack items a turn carries (ADR 019): told to it, held under its claims, and accepted with its session. */
export type Carry = Pick<CarriedWork, "holding" | "accepted" | "late" | "routineOnly">;

/**
 * A reply whose runtime stream ended without a result. Stop waiting ended it (`waitsStopped` is how
 * many commands it stopped): a reply that only waited is done with the text it has, and one that was
 * not waiting after all is stopped like any other (#1056). Otherwise it is cut off, not a silent
 * success.
 */
const endedWithoutResult = (message: Message, waitsStopped: number | null) => {
  if (waitsStopped === null) return MessageTransitions.cutOff(message, "Runtime ended without a result");
  return waitsStopped > 0 ? MessageTransitions.complete(message) : MessageTransitions.interrupt(message);
};

/** The message of yours a turn answers, as a Task turn is told it: what you wrote and when (#1005). */
const yoursIn = (message: Message | undefined) =>
  message === undefined ? {} : { yours: { text: message.content, sentAt: message.createdAt } };

/** How a turn ended, for the Attempt it may have started on a Task: a reply still running was stopped. */
const turnEnding = (message: Message): TurnEnding =>
  message.status === "complete"
    ? { _tag: "Replied", text: message.content }
    : message.status === "failed" || message.status === "limited"
      ? { _tag: "Failed", reason: message.error }
      : { _tag: "Stopped", reason: null };

/** The read-the-web mark of the session a turn resumes, if it read the web. */
const readWebOf = (known: RuntimeSession | undefined): WebReadMark | null => known?.readWeb ?? null;

/** The thread's session with its read-the-web mark set, or null when it already holds it. */
const markedSession = (known: RuntimeSession, mark: WebReadMark): RuntimeSession | null =>
  known.readWeb?.since === mark.since && known.readWeb.source === mark.source ? null : { ...known, readWeb: mark };

/** Records the mark on the Attempt the turn runs as, if it has one and the session read the web. */
const attemptReadWeb = (turn: ChatTaskTurn | null, mark: WebReadMark | null): Effect.Effect<void> =>
  turn === null || mark === null ? Effect.void : turn.readWeb(mark);

const taskBriefIn = (thread: Thread, runtime: RuntimeKind): TaskBriefMark | null =>
  liveSession(thread, runtime)?.taskBrief ?? null;

/** A chat turn's web search, recorded for its hob, chat and reply, and the Task and Attempt it works on (ADR 036). */
const chatWebTurn = (
  agentId: AgentId,
  threadId: ThreadId,
  messageId: MessageId,
  runtime: RuntimeKind,
  taskTurn: ChatTaskTurn | null,
  workingOn: Effect.Effect<TaskId | null>,
) =>
  webSearchTurn({
    agentId,
    messageId,
    runtime,
    work: webWorkOf({ threadId }),
    ...chatWebPlace(threadId, taskTurn, workingOn),
  });

/** Where a chat turn's web records belong: its chat, and the Task and Attempt it works on once known. */
const chatWebPlace = (
  threadId: ThreadId,
  taskTurn: ChatTaskTurn | null,
  workingOn: Effect.Effect<TaskId | null>,
): WebRecordPlace => ({
  threadId,
  taskId: workingOn,
  attemptId: taskTurn === null ? Effect.succeed(null) : taskTurn.attempt,
});

/** What a turn takes from ChatService: the reply's writes, the thread's session, and the run it ends. */
export interface TurnRunnerDeps {
  readonly redactor: Redactor;
  readonly grants: Effect.Success<ReturnType<typeof makeTurnGrants>>;
  readonly inputs: Pick<
    Effect.Success<ReturnType<typeof makeTurnInputs>>,
    "memoryBriefFor" | "rosterFor" | "skillsFor"
  >;
  readonly saveMessage: (message: Message) => Effect.Effect<Message>;
  readonly announce: <A>(committed: Committed<A>) => Effect.Effect<A>;
  readonly changeThread: (
    threadId: ThreadId,
    change: (thread: Thread) => Thread | null,
  ) => Effect.Effect<Option.Option<Thread>>;
  readonly transition: ReplyChange;
  readonly committedTransition: ReplyChange;
  /** Tells the thread's run that the turn of `reply` ended. */
  readonly turnEnded: (threadId: ThreadId, reply: Reply) => Effect.Effect<unknown>;
}

/** Applies a domain transition to a running reply, then `then` with the result (ChatService's reply lock). */
type ReplyChange = <A>(
  reply: Reply,
  f: (message: Message) => Message | unknown,
  then: (next: Message) => Effect.Effect<A>,
) => Effect.Effect<Option.Option<A>>;

export const makeTurnRunner = (deps: TurnRunnerDeps) =>
  Effect.gen(function* () {
    const { redactor, saveMessage, announce, changeThread, transition, committedTransition, turnEnded } = deps;
    const { currentAccess, grant, release } = deps.grants;
    const { memoryBriefFor, rosterFor, skillsFor } = deps.inputs;
    const repo = yield* HobbotsRepository;
    const bus = yield* EventPublisher;
    const adapters = yield* runtimeAdapters;
    // Without approvals, a call the policy answers Ask for is refused, as in hubs and tests that ask nothing.
    const approvals = yield* Effect.serviceOption(ApprovalService);
    // Without a log store, a long tool output keeps only its start and end.
    const toolLogs = yield* Effect.serviceOption(ToolLogs);
    // Records what each turn runs and changes for the Workbench (ADR 023); absent, nothing is recorded.
    const recorder = yield* Effect.serviceOption(ActivityRecorder);
    // Each chat's found URLs (ADR 036), which a search's results join.
    const web = yield* makeWebProvenance;
    const activityOf = (tools: ToolAccess | null, taskTurn: ChatTaskTurn | null) =>
      trackTurn(recorder, {
        folders: tools?.folders ?? [],
        attempt: taskTurn?.attempt ?? Effect.succeed(null),
        workIn: taskTurn?.workIn ?? Effect.succeed(null),
        redactor,
      });
    // Without Task work, turns offer no Task tools.
    const taskTurns = yield* Effect.serviceOption(TaskTurns);
    // Without Charms or local Git tools, turns offer only the Task tools.
    const charmsFor = yield* hubToolOffer;
    // Without a place to keep them, a pack's report is only logged.
    const packReports = yield* Effect.serviceOption(PackReports);

    // The turn runs with the configuration it started with; edits made meanwhile apply to the next turn.
    // Its tools are the exception: a narrower policy stops it (reviewAuthority).
    const runTurn = (
      agent: Agent,
      config: AgentConfiguration,
      thread: Thread,
      brain: Brain,
      prompt: string,
      // What the turn tells its session ahead of the prompt, and for a new session, what its context
      // pack is built from once the turn knows its memory brief (ADR 037).
      told: { readonly text: string | null; readonly pack: PackSources | null },
      reply: Reply,
      changed: boolean,
      carry: Carry,
      yours: Message | undefined,
    ) =>
      Effect.gen(function* () {
        const adapter = adapters(brain.runtime);
        if (adapter === undefined) {
          yield* transition(
            reply,
            (m) => MessageTransitions.cutOff(m, `Hobbots cannot run ${RUNTIME_NAMES[brain.runtime]} on this hub`),
            saveMessage,
          );
          return;
        }
        // Saves the streamed text about once a second without journaling it, so a crash keeps
        // all but the last moment of it (ADR 013). Ending the reply saves it in full.
        let checkpointed = "";
        const checkpoint = Semaphore.withPermit(
          reply.lock,
          Effect.gen(function* () {
            const current = yield* Ref.get(reply.current);
            if (current.content === checkpointed) return;
            yield* repo.checkpointMessage(current);
            checkpointed = current.content;
          }),
        );
        yield* checkpoint.pipe(Effect.delay("1 second"), Effect.forever, Effect.forkScoped);
        const update = (f: (message: Message) => Message | unknown) => transition(reply, f, saveMessage);
        // The top Task the turn works on, once the turn below knows it: This Task binds to it (ADR 018).
        let onTask: ChatTaskTurn | null = null;
        const session = makeTurnSession({
          thread,
          runtime: brain.runtime,
          changeThread,
          toldOfTask: () => onTask?.told ?? null,
        });
        // The skills the turn uses, mapped to the revisions it was given (ADR 029, The use line).
        const skillUses = yield* skillUseRecorder({
          agentId: agent.id,
          threadId: thread.id,
          messageId: (yield* Ref.get(reply.current)).id,
        });

        // Saves a step's change with the reply. A tool call that starts is stamped with when.
        // `takes` says whether the reply takes the step at all.
        const saveStep = (event: RuntimeEvent, takes: (message: Message) => boolean = () => true) =>
          Effect.gen(function* () {
            const now = yield* nowIso;
            return yield* update((m) => {
              if (!takes(m)) return undefined;
              const steps = nextSteps(m.steps, reply.stepsFrom, event, now);
              return steps === null ? undefined : MessageTransitions.setSteps(m, steps);
            });
          });
        // A tool call the policy allowed is saved before it runs, so a crash while it runs leaves it
        // uncertain rather than unknown (EX-004). A reply that has ended takes no new step: refused.
        // So is one you asked to stop: a runtime woken while it shuts down, as Claude Code is when
        // Stop waiting ends the command it waited on, must not start that command again (#1217).
        const recordToolStart = (event: ToolStartedEvent) =>
          saveStep(redactEvent(event, redactor), (m) => m.status !== "stopping").pipe(Effect.map(Option.isSome));

        // Secrets are redacted before a tool call's step is saved, journaled or announced, so a client
        // that reads the reply later never receives them either.
        const handle = (raw: RuntimeEvent) =>
          raw._tag === "SessionStarted" ? handleEvent(raw) : Effect.andThen(session.confirmBrief, handleEvent(raw));
        // What the turn searched is recorded, against the hob's web limits (ADR 036, Usage and limits).
        let webTurn: WebSearchTurn | null = null;
        const handleEvent = (raw: RuntimeEvent) => {
          const event = redactEvent(raw, redactor);
          return Effect.andThen(
            Effect.suspend(() => webTurn?.see(event) ?? Effect.void),
            handleRedacted(event),
          );
        };
        const handleRedacted = (event: RuntimeEvent) => {
          switch (event._tag) {
            // The session has now seen the thread through this reply.
            case "SessionStarted":
              return Effect.gen(function* () {
                session.begin(event.sessionId, event.policyVersion ?? null);
                skillUses.organization(event.organizationSkills);
                // The runtime accepted the turn: the work it carries is now being processed.
                yield* carry.accepted(event.sessionId);
                yield* session.record(event.sessionId, (yield* Ref.get(reply.current)).id);
                if (event.billing && !event.billing.startsWith("subscription") && event.billing !== "fake") {
                  yield* Effect.logWarning(
                    `${RUNTIME_NAMES[brain.runtime]} is billing via ${event.billing}, not the subscription`,
                  );
                }
              });
            case "TextDelta":
              return transition(
                reply,
                (m) => MessageTransitions.appendDelta(m, event.text),
                (m) =>
                  bus.publishTransient({
                    _tag: "MessageDelta",
                    threadId: m.threadId,
                    messageId: m.id,
                    offset: m.content.length - event.text.length,
                    delta: event.text,
                  }),
              );
            // A lead's routine progress is kept out of the chat as it completes, so it shows only while it streams (#1006).
            case "Completed":
              return Effect.gen(function* () {
                const quiet = onTask === null ? false : yield* onTask.quiet;
                return yield* update((m) => {
                  const done = MessageTransitions.complete(m, reply.prefix + event.text, event.usage);
                  // A failed, refused or uncertain call stays in view, with the unread dot and the last line.
                  return quiet && done instanceof Message && toolsSucceeded(done.steps)
                    ? new Message({ ...done, quiet })
                    : done;
                });
              });
            // What the call printed is cut to its start and end before the step is saved; a long
            // output is kept whole in the step's log.
            case "ToolFinished":
              return Effect.gen(function* () {
                const current = yield* Ref.get(reply.current);
                const stepId = replyStepId(current.steps, reply.stepsFrom, event.id);
                const output =
                  event.output === undefined
                    ? undefined
                    : yield* keepToolOutput(
                        // The Workbench keeps a command's colors; the reply's step reads as plain text (#902).
                        stripEscapes(event.output),
                        { threadId: thread.id, messageId: current.id, stepId },
                        toolLogs,
                      );
                yield* update((m) => {
                  const steps = nextSteps(m.steps, reply.stepsFrom, event, undefined, output);
                  return steps === null ? undefined : MessageTransitions.setSteps(m, steps);
                });
              });
            // A command's output as it comes is the Workbench's, recorded with the turn's activity.
            case "ToolOutput":
              return Effect.void;
            case "SessionCompacted":
              return session.forgetTaskBrief;
            // The reply shows each skill it used once, under it.
            // Its use is saved with the reply's line, in one transaction, so neither outlives the other,
            // and the reply in memory takes the line only once both are committed.
            case "SkillUsed":
              return Effect.flatMap(skillUses.resolve(event), (resolved) =>
                resolved === null
                  ? Effect.void
                  : committedTransition(
                      reply,
                      (m) => new Message({ ...m, skillsUsed: withUsedSkill(m.skillsUsed, resolved.used) }),
                      (next) =>
                        repo
                          .upsertMessage(next, resolved.use === null ? [] : [resolved.use])
                          .pipe(Effect.flatMap(announce)),
                    ),
              );
            // Steps, a tool call's included, are saved with the reply, so they replay on reconnect.
            default:
              return saveStep(event);
          }
        };

        const workingOn = Effect.suspend(() => onTask?.workingOn ?? Effect.succeed<TaskId | null>(null));
        // A request still pending when the turn ends expires: a stopped reply is never approvable late.
        const turnApprovals = Option.isSome(approvals)
          ? yield* Effect.acquireRelease(
              approvals.value.forTurn(
                { agentId: agent.id, threadId: thread.id, messageId: (yield* Ref.get(reply.current)).id },
                currentAccess(agent.id),
                workingOn,
              ),
              (handle) => handle.close,
            )
          : null;
        // The session's read-the-web mark (ADR 036): held from where the resumed session left it, and
        // kept on the thread's session and on the Attempt the turn runs as, if any.
        const markedBefore = readWebOf(session.expected);
        const webMark = yield* makeWebMark(markedBefore, (mark) =>
          Effect.andThen(
            session.change((known) => markedSession(known, mark)),
            Effect.suspend(() => attemptReadWeb(onTask, mark)),
          ),
        );
        // Every call of the turn is decided under the mark, by the runtime and the hub's tools alike.
        const callApprovals = withWebMark(turnApprovals?.approvals ?? null, webMark, currentAccess(agent.id));
        // The Task the hob works on in this thread, if any: its tools, and what its steps returned.
        // The turn's Attempt on it ends with the turn.
        const taskTurn = Option.isSome(taskTurns)
          ? yield* Effect.acquireRelease(
              taskTurns.value.forChat({
                agentId: agent.id,
                threadId: thread.id,
                messageId: (yield* Ref.get(reply.current)).id,
                promptId: (yield* Ref.get(reply.current)).promptId,
                ...yoursIn(yours),
                prompt,
                runtime: brain.runtime,
                configVersion: config.version,
                holding: carry.holding,
                told: taskBriefIn(thread, brain.runtime),
                webMark: webMark.current,
              }),
              (turn) =>
                // An Attempt the turn started after its session read the web carries the mark too.
                webMark.current.pipe(
                  Effect.flatMap((mark) => attemptReadWeb(turn, mark)),
                  Effect.andThen(Ref.get(reply.current)),
                  Effect.flatMap((m) => turn.end(turnEnding(m), session.id(), session.policy())),
                ),
            )
          : null;
        onTask = taskTurn;
        // A continuation whose work went late after its last check, as when you cancel its Quest
        // while it starts, ends here before its runtime is asked anything (#993). Read after the
        // turn's Attempt began, so a cancel that comes later waits for the turn to stop instead.
        const current = yield* Ref.get(reply.current);
        if (current.promptId === null && (yield* carry.late)) {
          yield* update((m) => {
            const stopping = MessageTransitions.requestStop(m);
            return stopping instanceof Message ? MessageTransitions.interrupt(stopping) : stopping;
          });
          return;
        }
        const tools = yield* grant(thread.id, agent);
        const expected = session.expected;
        const memory = yield* memoryBriefFor(agent, tools, expected);
        const roster = yield* rosterFor(agent, tools, expected, adapter);
        session.briefed({ memory, roster });
        const pack = yield* packTurn(packReports, thread.id, told.pack, memory);
        const skills = yield* skillsFor(agent, config, tools, thread, yours);
        // A chat that tries a draft never runs without it: the hub lost its files, as a restore does,
        // so the reply says how to bring it back instead of answering as if it were loaded.
        if (skills.trial !== null && skills.mounts.length === 0) {
          yield* update((m) => MessageTransitions.cutOff(m, draftGoneText(skills.trial?.name ?? "")));
          return;
        }
        yield* update(withSkills(skills.recorded));
        skillUses.given(skills.recorded, skills.trial);
        const named = namedSkills(skills.recorded, skills.trial);
        // The skill you picked goes to the runtime as its own mention, so the prompt drops your `/name`.
        const asked = askedSkillOf(yours, named);
        // What the turn runs and changes, recorded for the Workbench on the Attempt it works on (ADR 023).
        // Acquired after the Task's turn, so the end-of-turn compare lands before its Attempt ends.
        const activity = yield* activityOf(tools, taskTurn);
        const webUse = yield* chatWebTurn(agent.id, thread.id, current.id, brain.runtime, taskTurn, workingOn);
        webTurn = webUse;
        const search = webSearchRequest(tools, webUse, adapter);
        yield* activity
          .run(
            {
              prompt: runtimePrompt(prompt, asked, named),
              briefing: contextBlock(
                [memory, roster],
                webMarkBriefing(markedBefore),
                pack,
                told.text,
                taskTurn?.briefing ?? null,
                search.note,
              ),
              sessionId: expected?.sessionId ?? null,
              instructions: systemInstructions(config.name, config),
              instructionsChanged: changed,
              model: brain.model,
              effort: brain.effort,
              tools,
              // Settled from the policy as the turn starts, as its tools are (ADR 036).
              webSearch: search.webSearch,
              checkWebSearch: search.checkWebSearch,
              skills: skills.mounts,
              askedSkill: asked,
              approvals: callApprovals,
              redaction: redactor,
              recordToolStart,
              // A search's results are found URLs in the chat before the hob can act on them, and
              // its session is marked as having read the web (ADR 036).
              recordSearch: (event) =>
                Effect.andThen(
                  web.searched({ threadId: thread.id }, redactor)(event),
                  webMark.read({ _tag: "Search", query: redactor.text(event.query) }),
                ),
              // Its hub tools read the revisions this turn mounted, not what a rollout moved since.
              ...(yield* Effect.gen(function* () {
                const messageId = (yield* Ref.get(reply.current)).id;
                const charmTurn: CharmTurn = {
                  agentId: agent.id,
                  threadId: thread.id,
                  messageId,
                  webPlace: chatWebPlace(thread.id, taskTurn, workingOn),
                  scope: taskTurn?.scope ?? (() => callScope.reply(messageId)),
                  also: callScope.reply(messageId),
                  currentAccess: currentAccess(agent.id),
                  redactor,
                  approvals: callApprovals,
                };
                // A Charm call's refusal is recorded as a Task tool's is, when the turn has Task tools.
                const recorded = taskTurn?.recordCharms ?? ((charms: HubTools | null) => charms);
                const offer = yield* charmsFor(charmTurn);
                const holdsCommit = taskTurn?.holdsCommit;
                const steering: CallSteering = {
                  takeovers: offer.steering?.takeovers ?? [],
                  ...(holdsCommit === undefined ? {} : { holdsCommit }),
                };
                return {
                  hubTools: joinHubTools([
                    { owner: "the Task tools", tools: taskTurn?.hubTools ?? null },
                    { owner: "the hub's other tools", tools: recorded(offer.hubTools) },
                  ]),
                  steering,
                };
              }).pipe(Effect.provideService(TurnSkillsInUse, skills.recorded))),
            },
            // Stop waiting ends the runtime's stream inside the activity's, so the Workbench hears which
            // commands were stopped (#1056).
            (request) =>
              stoppableWait(adapter.sendPrompt(request), reply.endWait, (count) => Ref.set(reply.waitsStopped, count)),
          )
          .pipe(
            Stream.runForEach(handle),
            Effect.ensuring(webUse.end),
            Effect.catchTags({
              // The runtime's error can quote what a tool printed.
              RuntimeError: (error) => update((m) => MessageTransitions.cutOff(m, redactor.text(error.message))),
              RuntimeLimitReached: (error) => update((m) => MessageTransitions.limit(m, error.resetsAt)),
            }),
          );
        const waitsStopped = yield* Ref.get(reply.waitsStopped);
        yield* update((m) => endedWithoutResult(m, waitsStopped));
      }).pipe(
        // Stops the checkpoints as soon as the turn's stream is done.
        Effect.scoped,
        // Runs after the runtime's stream has closed, so "stopped" means the turn really ended.
        Effect.onInterrupt(() => transition(reply, MessageTransitions.interrupt, saveMessage)),
        // A reply already replaced by a newer turn's changes nothing.
        Effect.ensuring(turnEnded(thread.id, reply).pipe(Effect.andThen(release(thread.id)))),
      );

    return { runTurn } as const;
  });
