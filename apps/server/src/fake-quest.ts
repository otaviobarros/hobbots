import { HobbotsRepository, TaskRepository, TaskTurns } from "@hobbots/agents";
import {
  type AgentId,
  ArtifactId,
  AttemptId,
  CheckpointId,
  type Committed,
  carriedFrom,
  DEFAULT_QUEST_LIMITS,
  DelegationId,
  type EventEnvelope,
  isLiveAttempt,
  Message,
  MessageId,
  MilestoneId,
  QuestId,
  QuestionId,
  type Task,
  TaskId,
  type Thread,
} from "@hobbots/domain";
import { DateTime, Duration, Effect, FiberMap, Layer, Option, Schedule, Stream } from "effect";
import { EventBus } from "./event-bus.ts";

/**
 * The Black Friday Quest of ADR 018, played on the hub's records for the fake runtime, so the chat's
 * card, strip, drawer and questions can be followed end to end before hobs lead Quests themselves.
 * Asking a hob for a Black Friday campaign starts it, with that hob as the lead and the hobs named
 * Quill and Ada as its party. Ada's question climbs to you; the Quest finishes once you answer it.
 * Cancelling it stops the play, and each of its Attempts ends as a session would when told to stop,
 * so every Task confirms its cancel.
 *
 * Asking for a spring sale sets up the same party with work for the Quest tab's controls instead:
 * Quill's banner and Ada's email have failed, so they can be retried or given to another hob, and
 * Quill's signs are under way, so they can be cancelled. Only `HOBBOTS_FAKE_QUEST=black-friday`
 * with the fake runtime turns either on.
 */

/** The scripted requests, each found by what you ask for. */
const SCRIPTS = { "black-friday": /black friday/i, "spring-sale": /spring sale/i } as const;
type Script = keyof typeof SCRIPTS;

const BRIEFS: Record<Script, { readonly title: string; readonly goal: string }> = {
  "black-friday": {
    title: "Plan the Black Friday campaign",
    goal: "A Black Friday campaign: landing copy and a launch email, live by Friday",
  },
  "spring-sale": { title: "Plan the spring sale", goal: "A spring sale: a banner, an email and window signs" },
};

const iso = Effect.map(DateTime.now, DateTime.formatIso);

interface Cast {
  readonly thread: Thread;
  readonly lead: AgentId;
  readonly quill: AgentId;
  readonly ada: AgentId;
}

/** The thread of a scripted request and which script it asks for, or null for any other event. */
const requestThread = (entry: EventEnvelope) => {
  const { payload } = entry;
  if (payload._tag !== "MessageUpserted" || payload.message.role !== "user" || payload.message.status === "queued") {
    return null;
  }
  const script = (Object.keys(SCRIPTS) as Array<Script>).find((each) => SCRIPTS[each].test(payload.message.content));
  return script === undefined ? null : { threadId: payload.message.threadId, script };
};

/** The ids the play gives its records in a thread, so each thread's Quest has its own. */
const idsFor = (threadId: Thread["id"]) => {
  const key = threadId.slice(0, 8);
  return { key, id: (name: string) => `${name}-${key}` };
};

/** The top Task of the Quest played in a thread. */
const campaignOf = (threadId: Thread["id"]) => TaskId.make(idsFor(threadId).id("campaign"));

/** A Task being cancelled, from an event that moved it there. */
const cancellingTask = (entry: EventEnvelope) =>
  entry.payload._tag === "TaskStateChanged" && entry.payload.task.state === "cancelling" ? entry.payload.task : null;

/**
 * Ends the Attempt of a played Task being cancelled, as its session would once told to stop, and
 * asks the hub to confirm the cancels that nothing runs in any more.
 */
const stopAttempt = (task: Task, bus: EventBus["Service"]) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const turns = yield* Effect.serviceOption(TaskTurns);
    const tree = yield* tasks.readTree(task.id);
    const live = Option.getOrUndefined(tree)?.attempts.find(
      (each) => each.id === task.currentAttemptId && isLiveAttempt(each.state),
    );
    if (live !== undefined) {
      const stopped = yield* tasks.updateAttempt(live.id, {
        state: "cancelled",
        outcome: "Stopped when you cancelled it.",
        at: yield* iso,
      });
      yield* bus.publish(stopped.entries);
    }
    if (Option.isSome(turns)) yield* turns.value.reviewTasks;
  });

const play = (cast: Cast, script: Script, step: Duration.Input, bus: EventBus["Service"]) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const repo = yield* HobbotsRepository;
    const { key, id } = idsFor(cast.thread.id);
    const announce = <A>(committed: Committed<A>) => Effect.as(bus.publish(committed.entries), committed.value);
    const pause = Effect.sleep(step);
    const start = (task: Task, attempt: string) =>
      Effect.gen(function* () {
        const at = yield* iso;
        return yield* tasks
          .startAttempt(task.id, task.revision, {
            id: AttemptId.make(id(attempt)),
            runtime: "claude-code",
            sessionId: null,
            configVersion: 1,
            policyVersion: null,
            startedAt: at,
          })
          .pipe(Effect.flatMap(announce));
      });
    const report = (taskId: TaskId, kind: "milestone" | "progress", summary: string, milestone: string | null) =>
      Effect.gen(function* () {
        yield* tasks
          .recordCheckpoint({
            id: CheckpointId.make(id(`cp-${crypto.randomUUID().slice(0, 8)}`)),
            taskId,
            source: kind === "milestone" ? "planned" : "unplanned",
            kind,
            milestoneId: milestone === null ? null : MilestoneId.make(id(milestone)),
            summary,
            createdAt: yield* iso,
          })
          .pipe(Effect.flatMap(announce));
      });
    const ask = (questionId: string, taskId: TaskId, askerId: AgentId, text: string) =>
      Effect.gen(function* () {
        return yield* tasks
          .askQuestion({ id: QuestionId.make(id(questionId)), taskId, askerId, text, createdAt: yield* iso })
          .pipe(Effect.flatMap(announce));
      });
    const complete = (taskId: TaskId, attempt: string, summary: string, artifact: [string, string] | null) =>
      Effect.gen(function* () {
        const [task] = Option.getOrThrow(yield* tasks.readTree(taskId)).tasks;
        if (task === undefined) return;
        // The hob reads what its backpack holds on the Task in the turn that finishes it (ADR 019).
        const ledger = Option.getOrThrow(yield* tasks.readLedger(taskId));
        yield* tasks
          .completeTask(taskId, task.revision, {
            summary,
            attemptId: AttemptId.make(id(attempt)),
            artifacts:
              artifact === null
                ? []
                : [
                    {
                      id: ArtifactId.make(`art-${attempt}-${key}`),
                      kind: "text",
                      label: artifact[0],
                      value: artifact[1],
                    },
                  ],
            at: yield* iso,
            carried: carriedFrom(ledger, () => true),
          })
          .pipe(Effect.flatMap(announce));
      }).pipe(
        // A turn may still be reading what the backpack holds on the Task, as the lead's chat does
        // with its party's results: the Task completes once that turn has handled them.
        Effect.retry({
          while: (error) => error._tag === "TaskRefused" && error.reason === "items-open",
          schedule: Schedule.spaced(step),
          times: 50,
        }),
      );

    // Aldric takes the request and brings in Quill and Ada.
    const campaign = yield* tasks
      .createTask({
        task: {
          id: TaskId.make(id("campaign")),
          ownerId: cast.lead,
          parentId: null,
          threadId: cast.thread.id,
          brief: BRIEFS[script].title,
          dependsOn: [],
          createdAt: yield* iso,
        },
        delegation: null,
        milestones: [],
      })
      .pipe(Effect.flatMap(announce));
    yield* start(campaign, "a-campaign");
    yield* pause;
    yield* tasks
      .startQuest({
        id: QuestId.make(id("quest")),
        taskId: campaign.id,
        goal: BRIEFS[script].goal,
        acceptance: ["Landing copy approved", "Campaign scheduled"],
        limits: DEFAULT_QUEST_LIMITS,
        createdAt: yield* iso,
      })
      .pipe(Effect.flatMap(announce));
    const member = (name: string, owner: AgentId, brief: string, milestones: ReadonlyArray<string>, after: TaskId[]) =>
      Effect.gen(function* () {
        const task = yield* tasks
          .createTask({
            task: {
              id: TaskId.make(id(name)),
              ownerId: owner,
              parentId: campaign.id,
              threadId: null,
              brief,
              dependsOn: after,
              createdAt: yield* iso,
            },
            delegation: {
              id: DelegationId.make(id(`d-${name}`)),
              brief,
              expectedOutput: null,
              authority: { overrides: {}, folders: null },
              timeoutMs: null,
            },
            milestones: milestones.map((title, index) => ({ id: MilestoneId.make(id(`${name}-${index}`)), title })),
          })
          .pipe(Effect.flatMap(announce));
        return (yield* start(task, `a-${name}`)).task;
      });
    // The spring sale stops here, with work in each state the Quest tab's controls act on.
    if (script === "spring-sale") {
      const failed = (name: string, owner: AgentId, brief: string, why: string) =>
        Effect.gen(function* () {
          const started = yield* member(name, owner, brief, [], []);
          const ended = yield* tasks
            .updateAttempt(AttemptId.make(id(`a-${name}`)), { state: "failed", outcome: why, at: yield* iso })
            .pipe(Effect.flatMap(announce));
          yield* tasks.moveTask(started.id, ended.task.revision, "failed", yield* iso).pipe(Effect.flatMap(announce));
        });
      yield* failed(
        "banner",
        cast.quill,
        "Write the sale banner\nA banner for the shop's home page.",
        "The image service timed out.",
      );
      yield* failed(
        "email",
        cast.ada,
        "Schedule the sale email\nSchedule the spring sale email for Monday.",
        "The mailing tool rejected the sign-in.",
      );
      yield* member("signs", cast.quill, "Order the sale signs\nOrder window signs for the shop.", [], []);
      return;
    }
    const copy = yield* member(
      "copy",
      cast.quill,
      "Draft the landing copy\nThree headlines and a short body for the Black Friday landing page.",
      ["Headlines", "Landing copy"],
      [],
    );
    yield* pause;
    const build = yield* member(
      "build",
      cast.ada,
      "Build the campaign\nSet up the landing page and schedule the launch email once the copy exists.",
      [],
      [copy.id],
    );
    yield* tasks.moveTask(build.id, build.revision, "waiting", yield* iso).pipe(Effect.flatMap(announce));
    yield* pause;

    // Quill asks Aldric, who answers without bothering you.
    yield* report(copy.id, "milestone", "Three headlines drafted", "copy-0");
    const discount = yield* ask("q-discount", copy.id, cast.quill, "Which discount should the headline lead with?");
    yield* pause;
    yield* tasks
      .answerQuestion(discount.id, { _tag: "Lead", agentId: cast.lead }, "Lead with 20% off everything.", yield* iso)
      .pipe(Effect.flatMap(announce));
    yield* report(build.id, "progress", "Keyword research done while waiting on Quill", null);
    yield* pause;

    // Ada's question needs a call only you can make: Aldric passes it up to you.
    const cutoff = yield* ask(
      "q-cutoff",
      build.id,
      cast.ada,
      "Carriers stop international deliveries on Dec 10. Should international orders get an earlier cutoff, Dec 12, while everything else stays Dec 18?",
    );
    yield* tasks.escalateQuestion(cutoff.id, cast.lead).pipe(Effect.flatMap(announce));
    yield* pause;

    // Quill finishes; Aldric checks the copy and hands it to Ada.
    yield* report(copy.id, "milestone", "Landing copy written", "copy-1");
    yield* complete(copy.id, "a-copy", "Landing copy ready", [
      "Landing copy",
      "Black Friday: 20% off everything, this weekend only.",
    ]);
    yield* tasks.handOff(ArtifactId.make(`art-a-copy-${key}`), build.id, yield* iso).pipe(Effect.flatMap(announce));
    const waiting = Option.getOrThrow(yield* tasks.readTree(build.id)).tasks[0];
    if (waiting !== undefined) {
      yield* tasks.moveTask(build.id, waiting.revision, "active", yield* iso).pipe(Effect.flatMap(announce));
    }

    // Once you answer, Ada finishes and Aldric wraps up in your chat.
    yield* answered(cutoff.id, build.id, step);
    yield* pause;
    yield* complete(build.id, "a-build", "Campaign scheduled", ["Launch email", "Scheduled for Friday 6:00"]);
    yield* pause;
    yield* complete(campaign.id, "a-campaign", "Black Friday campaign ready", null);
    yield* repo
      .upsertMessage(
        new Message({
          id: MessageId.make(crypto.randomUUID()),
          threadId: cast.thread.id,
          role: "assistant",
          content:
            "The Black Friday campaign is ready. Quill wrote the landing copy, leading with 20% off everything, and Ada scheduled the launch email for Friday. International orders follow the cutoff you chose.",
          status: "complete",
          error: null,
          configVersion: null,
          createdAt: yield* iso,
        }),
      )
      .pipe(Effect.flatMap(announce));
  });

/** Waits until you answer the question, looking again every `step`. */
const answered = (questionId: QuestionId, taskId: TaskId, step: Duration.Input) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const isAnswered = tasks.readTree(taskId).pipe(
      Effect.map((tree) =>
        Option.match(tree, {
          onNone: () => true,
          onSome: (read) => read.questions.some((each) => each.id === questionId && each.state === "answered"),
        }),
      ),
    );
    while (!(yield* isAnswered)) yield* Effect.sleep(step);
  });

const castFor = (threadId: Thread["id"]) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const tasks = yield* TaskRepository;
    const thread = yield* repo.findThread(threadId);
    if (Option.isNone(thread) || (yield* tasks.readThreadTrees(threadId)).length > 0) return Option.none<Cast>();
    const hobs = yield* repo.listAgents;
    const named = (name: string) =>
      hobs.find((hob) => hob.name.toLowerCase() === name && hob.id !== thread.value.agentId);
    const quill = named("quill");
    const ada = named("ada");
    if (quill === undefined || ada === undefined) {
      yield* Effect.logWarning("The Black Friday Quest needs hobs named Quill and Ada besides the lead.");
      return Option.none<Cast>();
    }
    return Option.some({ thread: thread.value, lead: thread.value.agentId, quill: quill.id, ada: ada.id });
  });

/** Plays the Black Friday Quest for each request that asks for one, `step` apart, until it is cancelled. */
export const FakeQuestLive = (step: Duration.Input) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const bus = yield* EventBus;
      // Each play runs under its top Task's id; the roots played stay known after a play ends.
      const plays = yield* FiberMap.make<TaskId>();
      const played = new Set<TaskId>();
      const start = (threadId: Thread["id"], script: Script) =>
        castFor(threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (cast) => {
                played.add(campaignOf(threadId));
                return FiberMap.run(
                  plays,
                  campaignOf(threadId),
                  play(cast, script, step, bus).pipe(
                    Effect.catchCause((cause) => Effect.logError("The Black Friday Quest stopped", cause)),
                  ),
                ).pipe(Effect.asVoid);
              },
            }),
          ),
        );
      // Cancelling the request stops its play; cancelling a member's Task stops only that Task.
      const cancel = (task: Task) =>
        played.has(task.rootId)
          ? (task.id === task.rootId ? FiberMap.remove(plays, task.rootId) : Effect.void).pipe(
              Effect.andThen(stopAttempt(task, bus)),
              Effect.catchCause((cause) => Effect.logWarning("Could not stop a cancelled fake Task", cause)),
            )
          : Effect.void;
      yield* bus.stream.pipe(
        Stream.runForEach((event) => {
          if (event._tag !== "Journaled") return Effect.void;
          const request = requestThread(event.entry);
          if (request !== null) return start(request.threadId, request.script);
          const cancelling = cancellingTask(event.entry);
          return cancelling === null ? Effect.void : cancel(cancelling);
        }),
        Effect.forkScoped,
      );
    }),
  );

export const FAKE_QUEST_STEP = Duration.millis(600);
