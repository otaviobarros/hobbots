import { ActivityRepository, HobbotsRepository, TaskRepository, TaskTurns } from "@hobbots/agents";
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
  FileChangeId,
  isLiveAttempt,
  isTerminalTask,
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
 * so every Task confirms its cancel. When hobs named Rook and Pip are there too, Aldric also brings in
 * Rook, who leads a Quest of his own under Aldric's and brings in Pip (#275).
 *
 * Asking for a spring sale sets up the same party with work for the Quest tab's controls instead:
 * Quill's banner and Ada's email have failed, so they can be retried or given to another hob, and
 * Quill's signs are under way, so they can be cancelled. Asking for the shop badge has Quill make
 * it while Ada reviews the shop, and both change the badge's file while both are at work, so the
 * hub's finding on the two Tasks can be followed (#570), while Aldric's clearing of the badge before
 * he delegated is none (#658); Quill then finishes with the badge left uncommitted (#586). Asking
 * to wrap up the spec has the lead edit the spec itself and complete the Quest leaving it
 * uncommitted on purpose, as its hold on the top Task lets it (#665). Asking for a long brief plays
 * the Black Friday Quest with briefs of a paragraph that name a deep folder, as real ones do (#874).
 * Only `HOBBOTS_FAKE_QUEST=black-friday` with the fake runtime turns any of them on.
 */

/**
 * A folder deep enough that a brief naming it is wider than any column it shows in (#874), with no
 * space or hyphen to break at.
 */
const LONG_FOLDER = "/Users/someone/Development/projects/hobbots_manual_tests/black_friday_campaign_full_run";

/** The scripted requests, each found by what you ask for. */
const SCRIPTS = {
  "black-friday": /black friday/i,
  "spring-sale": /spring sale/i,
  "shop-badge": /shop badge/i,
  "spec-wrap": /wrap up the spec/i,
  "long-brief": /long brief/i,
} as const;
type Script = keyof typeof SCRIPTS;

const BRIEFS: Record<Script, { readonly title: string; readonly goal: string }> = {
  "black-friday": {
    title: "Plan the Black Friday campaign",
    goal: "A Black Friday campaign: landing copy and a launch email, live by Friday",
  },
  "spring-sale": { title: "Plan the spring sale", goal: "A spring sale: a banner, an email and window signs" },
  "shop-badge": { title: "Make the shop badge", goal: "A badge on the shop's page, in the agreed colour" },
  "spec-wrap": { title: "Wrap up the spec", goal: "The shop's spec, final and committed" },
  "long-brief": {
    title: `Run the Black Friday campaign end to end for the shop in ${LONG_FOLDER}, working only inside that folder: install nothing, use no network, start no web server and never push.`,
    goal: "A Black Friday campaign: landing copy and a launch email, live by Friday",
  },
};

/** The folder the shop badge's play says its files are in. */
const SHOP = "/fake/shop";

/**
 * Records that a played Task's Attempt changed `path` in the shop, as its turn's scan would; with no
 * `hash`, that it deleted it.
 */
const changeInShop = (attempt: AttemptId, path: string, hash: string | null, bus: EventBus["Service"]) =>
  Effect.gen(function* () {
    const activity = yield* Effect.serviceOption(ActivityRepository);
    if (Option.isNone(activity)) return;
    const version = (of: string) => ({
      hash: of,
      size: 2048,
      kind: "image" as const,
      contentId: null,
      notKept: "unreadable" as const,
    });
    const saved = yield* activity.value.saveChanges(attempt, SHOP, [
      {
        id: FileChangeId.make(`${attempt}-${path}`),
        path,
        kind: hash === null ? "deleted" : "edited",
        movedFrom: null,
        before: version("grey"),
        after: hash === null ? null : version(hash),
        sharedWith: [],
        settled: true,
        recordedAt: yield* iso,
      },
    ]);
    if (Option.isSome(saved)) yield* bus.publish(saved.value.entries);
  });

const iso = Effect.map(DateTime.now, DateTime.formatIso);

interface Cast {
  readonly thread: Thread;
  readonly lead: AgentId;
  readonly quill: AgentId;
  readonly ada: AgentId;
  /** Rook and Pip, for the nested Quest, when both are there. */
  readonly nested: { readonly rook: AgentId; readonly pip: AgentId } | null;
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
        _tag: "Ended",
        end: { _tag: "Stopped", reason: null },
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
    const report = (
      taskId: TaskId,
      kind: "milestone" | "progress",
      summary: string,
      milestone: string | null,
      detail: string | null = null,
    ) =>
      Effect.gen(function* () {
        yield* tasks
          .recordCheckpoint({
            id: CheckpointId.make(id(`cp-${crypto.randomUUID().slice(0, 8)}`)),
            taskId,
            source: kind === "milestone" ? "planned" : "unplanned",
            kind,
            milestoneId: milestone === null ? null : MilestoneId.make(id(milestone)),
            summary,
            detail,
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
    const complete = (
      taskId: TaskId,
      attempt: string,
      summary: string,
      artifact: [string, string] | null,
      uncommitted: string | null = null,
    ) =>
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
            ...(uncommitted === null
              ? {}
              : { uncommitted: { id: CheckpointId.make(id(`uncommitted-${attempt}`)), summary: uncommitted } }),
          })
          .pipe(Effect.flatMap(announce));
      }).pipe(
        // A turn may still be reading what the backpack holds on the Task, as the lead's chat does
        // with its party's results: the Task completes once that turn has handled them.
        Effect.retry({
          // A Task under it that you cancelled still has to confirm it stopped.
          while: (error) =>
            error._tag === "TaskRefused" && (error.reason === "items-open" || error.reason === "children-open"),
          schedule: Schedule.spaced(step),
          times: 50,
        }),
      );

    // What the lead writes in your chat: only the plan, a question no lead can answer and the
    // finish (#901). The plan is its reply to your request; the rest the play writes as it goes.
    const say = (content: string) =>
      Effect.gen(function* () {
        yield* repo
          .upsertMessage(
            new Message({
              id: MessageId.make(crypto.randomUUID()),
              threadId: cast.thread.id,
              role: "assistant",
              content,
              status: "complete",
              error: null,
              configVersion: null,
              createdAt: yield* iso,
            }),
          )
          .pipe(Effect.flatMap(announce));
      });

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
    const quest = (name: string, taskId: TaskId, goal: string) =>
      Effect.gen(function* () {
        yield* tasks
          .startQuest({
            id: QuestId.make(id(name)),
            taskId,
            goal,
            acceptance:
              name === "quest" && script !== "spec-wrap" ? ["Landing copy approved", "Campaign scheduled"] : [],
            limits: DEFAULT_QUEST_LIMITS,
            createdAt: yield* iso,
          })
          .pipe(Effect.flatMap(announce));
      });
    yield* quest("quest", campaign.id, BRIEFS[script].goal);
    const member = (
      name: string,
      owner: AgentId,
      brief: string,
      milestones: ReadonlyArray<string>,
      after: TaskId[],
      parentId: TaskId = campaign.id,
      folders: ReadonlyArray<string> | null = null,
    ) =>
      Effect.gen(function* () {
        const task = yield* tasks
          .createTask({
            task: {
              id: TaskId.make(id(name)),
              ownerId: owner,
              parentId,
              threadId: null,
              brief,
              dependsOn: after,
              createdAt: yield* iso,
            },
            delegation: {
              id: DelegationId.make(id(`d-${name}`)),
              brief,
              expectedOutput: null,
              authority: { overrides: {}, folders },
              timeoutMs: null,
            },
            milestones: milestones.map((title, index) => ({ id: MilestoneId.make(id(`${name}-${index}`)), title })),
          })
          .pipe(Effect.flatMap(announce));
        // A Task that comes after others stays queued until they complete, as a real one does.
        return after.length === 0 ? (yield* start(task, `a-${name}`)).task : task;
      });
    // The spring sale stops here, with work in each state the Quest tab's controls act on.
    if (script === "spring-sale") {
      const failed = (name: string, owner: AgentId, brief: string, why: string) =>
        Effect.gen(function* () {
          const started = yield* member(name, owner, brief, [], []);
          const ended = yield* tasks
            .updateAttempt(AttemptId.make(id(`a-${name}`)), {
              _tag: "Ended",
              end: { _tag: "Failed", reason: why },
              at: yield* iso,
            })
            .pipe(Effect.flatMap(announce));
          yield* tasks.moveTask(started.id, ended.task.revision, "failed", yield* iso).pipe(Effect.flatMap(announce));
        });
      // Quill's signs come first, so his lane names them while his later banner Task has failed.
      yield* member("signs", cast.quill, "Order the sale signs\nOrder window signs for the shop.", [], []);
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
      return;
    }
    // The lead edits the spec after the last commit and completes the Quest, leaving it on purpose (#665).
    if (script === "spec-wrap") {
      yield* changeInShop(AttemptId.make(id("a-campaign")), "docs/SPEC.md", "final", bus);
      yield* pause;
      yield* complete(
        campaign.id,
        "a-campaign",
        "Spec wrapped up",
        null,
        `Left 1 file uncommitted since the last commit: docs/SPEC.md in ${SHOP}. Left on purpose: You asked to review it before it is committed.`,
      );
      return;
    }
    // The shop badge stops with Quill and Ada both at work, after both changed the badge.
    if (script === "shop-badge") {
      // Aldric clears the last run's badge before he delegates: his Attempt keeps that change while
      // Quill and Ada work, and it is no overlap with theirs (#658).
      yield* changeInShop(AttemptId.make(id("a-campaign")), "web/badge.png", null, bus);
      yield* pause;
      // Each member works only in the folders its lead gave it (#582): Quill the shop's web folder.
      const badge = yield* member(
        "badge",
        cast.quill,
        "Make the shop badge\nA badge in the agreed colour.",
        [],
        [],
        campaign.id,
        [`${SHOP}/web`],
      );
      yield* changeInShop(AttemptId.make(id("a-badge")), "web/badge.png", "green", bus);
      yield* pause;
      yield* member(
        "review",
        cast.ada,
        "Review the shop\nCheck the shop's page before it goes out.",
        [],
        [],
        campaign.id,
        [SHOP],
      );
      yield* changeInShop(AttemptId.make(id("a-review")), "web/badge.png", "grey-again", bus);
      yield* pause;
      // Quill finishes with the badge left uncommitted, as the hub reads it from a repository (#586).
      yield* complete(
        badge.id,
        "a-badge",
        "Badge made in green",
        null,
        `Left 1 file uncommitted since the last commit: web/badge.png in ${SHOP}.`,
      );
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
      script === "long-brief"
        ? `Build the campaign for the shop in ${LONG_FOLDER}: set up the landing page and schedule the launch email once the copy exists. Work only inside that folder; install nothing, no network, no web server, never push.`
        : "Build the campaign\nSet up the landing page and schedule the launch email once the copy exists.",
      [],
      [copy.id],
    );
    yield* pause;

    // Rook runs the ads and brings in Pip for the keywords, leading a Quest of his own under Aldric's.
    const ads =
      cast.nested === null
        ? null
        : yield* member("ads", cast.nested.rook, "Run the ads\nSearch and social ads for the weekend.", [], []);
    if (ads !== null && cast.nested !== null) {
      yield* quest("ads-quest", ads.id, "Search and social ads for the weekend");
      const keywords = yield* member(
        "keywords",
        cast.nested.pip,
        "Research the keywords\nThe searches Black Friday shoppers make for the shop.",
        [],
        [],
        ads.id,
      );
      yield* pause;
      yield* complete(keywords.id, "a-keywords", "Twelve keywords, led by doorbuster", null);
      yield* pause;
      yield* complete(ads.id, "a-ads", "Ads ready around doorbuster", null);
    }

    // Quill asks Aldric, who answers without bothering you.
    yield* whileOpen(
      copy.id,
      Effect.gen(function* () {
        yield* report(copy.id, "milestone", "Three headlines drafted", "copy-0");
        const discount = yield* ask("q-discount", copy.id, cast.quill, "Which discount should the headline lead with?");
        yield* pause;
        yield* tasks
          .answerQuestion(
            discount.id,
            { _tag: "Lead", agentId: cast.lead },
            "Lead with 20% off everything.",
            yield* iso,
          )
          .pipe(Effect.flatMap(announce));
      }),
    );
    yield* pause;

    // Quill finishes, and Ada's Task starts with the copy it comes after.
    yield* whileOpen(
      copy.id,
      Effect.gen(function* () {
        yield* report(copy.id, "milestone", "Landing copy written", "copy-1");
        yield* complete(copy.id, "a-copy", "Landing copy ready", [
          "Landing copy",
          "Black Friday: 20% off everything, this weekend only.",
        ]);
      }),
    );
    if ((yield* stateOf(copy.id)) === "completed") {
      yield* whileOpen(
        build.id,
        Effect.gen(function* () {
          const queued = Option.getOrThrow(yield* tasks.readTree(build.id)).tasks[0];
          if (queued !== undefined) yield* start(queued, "a-build");
        }),
      );
    }
    yield* whileOpen(
      build.id,
      report(
        build.id,
        "progress",
        "Keyword research done",
        null,
        "Doorbuster and early access lead what shoppers search for.",
      ),
    );
    yield* pause;

    // Ada's question needs a call only you can make: Aldric passes it up to you.
    const cutoff = yield* whileOpen(
      build.id,
      Effect.gen(function* () {
        const asked = yield* ask(
          "q-cutoff",
          build.id,
          cast.ada,
          "Carriers stop international deliveries on Dec 10. Should international orders get an earlier cutoff, Dec 12, while everything else stays Dec 18?",
        );
        yield* tasks.escalateQuestion(asked.id, cast.lead).pipe(Effect.flatMap(announce));
        yield* say("Ada has one question for you about the international cutoff. Answer it on its card.");
        return asked;
      }),
    );
    yield* pause;

    // Once you answer, Ada finishes and Aldric wraps up in your chat. Work you cancelled is skipped.
    if (Option.isSome(cutoff)) yield* answered(cutoff.value.id, build.id, step);
    yield* pause;
    yield* whileOpen(
      build.id,
      complete(build.id, "a-build", "Campaign scheduled", ["Launch email", "Scheduled for Friday 6:00"]),
    );
    yield* pause;
    yield* complete(campaign.id, "a-campaign", "Black Friday campaign ready", null);
    const scheduled = (yield* stateOf(build.id)) === "completed";
    // One short summary: what was made, where it is, and who did what.
    yield* say(
      scheduled
        ? "The Black Friday campaign is ready. The landing copy leads with 20% off everything, and the launch email is scheduled for Friday 6:00. Quill wrote the copy and Ada scheduled the email, with the cutoff you chose."
        : "The Black Friday campaign is wrapped up without Ada's part, which you cancelled: the landing copy is ready and the launch email is not scheduled. Quill wrote the copy.",
    );
  });

/** Where a played Task stands now, or null once the hub no longer has it. */
const stateOf = (taskId: TaskId) =>
  Effect.flatMap(TaskRepository, (tasks) =>
    Effect.map(tasks.readTree(taskId), (tree) => Option.getOrUndefined(tree)?.tasks[0]?.state ?? null),
  );

/** Whether a played Task is still open: not ended, and no cancel asked for. */
const isOpen = (taskId: TaskId) =>
  Effect.map(stateOf(taskId), (state) => state !== null && state !== "cancelling" && !isTerminalTask(state));

/**
 * Plays a step on a Task only while it is open: once you cancel a member's Task, the play skips
 * what that Task would have done and goes on with the rest of the Quest. Your cancel can also land
 * while the step runs, after the look; the step then fails on the Task's newer revision or its
 * cancel, and is skipped the same way. A step that fails on a Task still open fails the play.
 */
const whileOpen = <A, E, R>(taskId: TaskId, step: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    if (!(yield* isOpen(taskId))) return Option.none<A>();
    return yield* step.pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.flatMap(isOpen(taskId), (open) => (open ? Effect.fail(error) : Effect.succeed(Option.none<A>()))),
      ),
    );
  });

/** Waits until you answer the question, or its Task ends, looking again every `step`. */
const answered = (questionId: QuestionId, taskId: TaskId, step: Duration.Input) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const isAnswered = tasks.readTree(taskId).pipe(
      Effect.map((tree) =>
        Option.match(tree, {
          onNone: () => true,
          // A Task you cancelled has nobody left to hear the answer.
          onSome: (read) =>
            read.questions.some((each) => each.id === questionId && each.state === "answered") ||
            read.tasks[0]?.state === "cancelling" ||
            (read.tasks[0] !== undefined && isTerminalTask(read.tasks[0].state)),
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
    const rook = named("rook");
    const pip = named("pip");
    const nested = rook === undefined || pip === undefined ? null : { rook: rook.id, pip: pip.id };
    return Option.some({ thread: thread.value, lead: thread.value.agentId, quill: quill.id, ada: ada.id, nested });
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
