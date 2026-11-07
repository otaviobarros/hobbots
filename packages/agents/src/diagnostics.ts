import {
  type DiagnosticsHobSkills,
  DiagnosticsReport,
  type QuestTrace,
  type RecoveryError,
  type RecoveryStep,
  type StalledWork,
  type TraceEntry,
} from "@hobbots/api";
import {
  type AttemptId,
  type AttemptState,
  type BackpackItem,
  isLiveAttempt,
  type KnownSecret,
  type MemoryEngineHealth,
  openBlocker,
  type Quest,
  type QuestId,
  type RuntimeHealth,
  secretIn,
  type TaskId,
} from "@hobbots/domain";
import { Cause, Clock, Context, Effect, Layer, Option, Ref, Schema } from "effect";
import type { Redactor } from "./secrets.ts";

/** What a step of startup recovery does, for the code that records one without the API contract. */
export type { RecoveryStep };

/** What Diagnostics reads from storage that no other port reads (ADR 026). */
export class DiagnosticsReads extends Context.Service<
  DiagnosticsReads,
  {
    /** The latest Quests, newest first. */
    readonly listQuests: (limit: number) => Effect.Effect<ReadonlyArray<Quest>>;
    /**
     * When each Attempt last recorded anything: a checkpoint, a command or a file change. An
     * Attempt that recorded nothing is left out.
     */
    readonly lastProgress: (attemptIds: ReadonlyArray<AttemptId>) => Effect.Effect<ReadonlyMap<AttemptId, string>>;
    /** The latest journal entries that apply to these Tasks, oldest first, at most `limit`. */
    readonly journalForTasks: (
      taskIds: ReadonlyArray<TaskId>,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<TraceEntry>>;
    /** The Quest each Task belongs to: the nearest Quest on the Task or above it. A Task outside every Quest is left out. */
    readonly questsOf: (taskIds: ReadonlyArray<TaskId>) => Effect.Effect<ReadonlyMap<TaskId, QuestId>>;
    /** The highest migration the database has applied. */
    readonly schemaVersion: Effect.Effect<number>;
    readonly storage: Effect.Effect<"sqlite" | "postgres">;
  }
>()("@hobbots/agents/DiagnosticsReads") {}

/**
 * The steps of this process's startup recovery that failed (ADR 026). Recovery logs and goes on
 * past a step it cannot take; this keeps the failure for Settings › Diagnostics too.
 */
export class RecoveryLog extends Context.Service<
  RecoveryLog,
  {
    readonly record: (error: RecoveryError) => Effect.Effect<void>;
    readonly errors: Effect.Effect<ReadonlyArray<RecoveryError>>;
  }
>()("@hobbots/agents/RecoveryLog") {
  /** Kept in memory: each start of the hub runs its own recovery. */
  static readonly layer = Layer.effect(
    RecoveryLog,
    Effect.map(Ref.make<ReadonlyArray<RecoveryError>>([]), (ref) =>
      RecoveryLog.of({
        record: (error) => Ref.update(ref, (errors) => [...errors, error]),
        errors: Ref.get(ref),
      }),
    ),
  );
}

/** The tag of an error, its class name, or `Defect` for anything else. */
const tagOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string")
    return error._tag;
  return error instanceof Error ? error.name : "Defect";
};

/**
 * Keeps a failed step of startup recovery for Settings › Diagnostics, when the hub keeps a
 * recovery log. The message is kept as the error said it; Diagnostics redacts it before showing it.
 */
export const recordRecovery = (
  step: RecoveryStep,
  cause: Cause.Cause<unknown>,
  ids: { readonly taskId: TaskId | null; readonly attemptId: AttemptId | null },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const log = yield* Effect.serviceOption(RecoveryLog);
    if (Option.isNone(log)) return;
    const error = Cause.squash(cause);
    const at = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* log.value.record({
      step,
      tag: tagOf(error),
      message: error instanceof Error ? error.message : String(error),
      ...ids,
      at,
    });
  });

/** A running Attempt that recorded nothing for this long counts as stalled. */
export const NO_PROGRESS_AFTER_MS = 15 * 60 * 1000;

/** What the Now view reads to find stalled work. */
export interface StalledInput {
  /** Every open backpack item. */
  readonly open: ReadonlyArray<BackpackItem>;
  /** Every failed backpack item whose blocker waits for your choice. */
  readonly blocked: ReadonlyArray<BackpackItem>;
  /** Every Attempt still starting or running, with when it last recorded anything. */
  readonly live: ReadonlyArray<{
    readonly attemptId: AttemptId;
    readonly taskId: TaskId;
    readonly agentId: StalledWork["agentId"];
    readonly state: AttemptState;
    readonly startedAt: string;
    readonly lastProgress: string | undefined;
  }>;
  /** The Quest of each Task, when it has one. */
  readonly questOf: (taskId: TaskId) => QuestId | null;
  readonly now: string;
}

const item = (kind: StalledWork["kind"], each: BackpackItem, since: string): StalledWork => ({
  kind,
  agentId: each.recipientId,
  taskId: each.taskId,
  questId: each.questId,
  attemptId: each.attemptId,
  itemId: each.id,
  since,
});

/**
 * Work that stopped moving, oldest first: backpack items whose claim ran out, items that failed
 * every try and wait for you, and running Attempts that recorded nothing for a while.
 */
export const stalledWork = (input: StalledInput): ReadonlyArray<StalledWork> => {
  const now = Date.parse(input.now);
  const expired = input.open.flatMap((each) =>
    each.claim !== null && Date.parse(each.claim.leaseExpiresAt) < now
      ? [item("claimExpired", each, each.claim.leaseExpiresAt)]
      : [],
  );
  const exhausted = input.blocked.flatMap((each) => {
    const blocker = openBlocker(each);
    return blocker?.reason === "retries-exhausted" ? [item("triesExhausted", each, blocker.raisedAt)] : [];
  });
  const quiet = input.live.flatMap((attempt): ReadonlyArray<StalledWork> => {
    const since = attempt.lastProgress ?? attempt.startedAt;
    if (!isLiveAttempt(attempt.state) || now - Date.parse(since) < NO_PROGRESS_AFTER_MS) return [];
    return [
      {
        kind: "noProgress",
        agentId: attempt.agentId,
        taskId: attempt.taskId,
        questId: input.questOf(attempt.taskId),
        attemptId: attempt.attemptId,
        itemId: null,
        since,
      },
    ];
  });
  return [...expired, ...exhausted, ...quiet].sort((a, b) => a.since.localeCompare(b.since));
};

/** The first line of a text, trimmed and cut short: a brief's or a goal's title. */
export const titleOf = (text: string): string => {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

/** Where the report was made, as the hub knows it. */
export type ReportHub = DiagnosticsReport["hub"];

export interface ReportInput {
  readonly createdAt: string;
  readonly hub: ReportHub;
  readonly runtimes: ReadonlyArray<RuntimeHealth>;
  readonly memory: MemoryEngineHealth | null;
  readonly workHeld: boolean;
  readonly stalled: ReadonlyArray<StalledWork>;
  readonly recovery: ReadonlyArray<RecoveryError>;
  readonly skills: ReadonlyArray<DiagnosticsHobSkills>;
  readonly trace: QuestTrace | null;
  readonly includeTitles: boolean;
}

/** Whether a runtime is signed in, as far as its health says; null when it cannot tell. */
const signedIn = (health: RuntimeHealth): boolean | null => {
  switch (health.availability) {
    case "ready":
      return true;
    case "signedOut":
      return false;
    default:
      return null;
  }
};

const titled = (include: boolean, text: string) => (include ? { title: titleOf(text) } : {});

const reportQuest = (trace: QuestTrace, includeTitles: boolean) => {
  const { quest, tree } = trace;
  return {
    questId: quest.id,
    taskId: quest.taskId,
    leadId: quest.leadId,
    parentQuestId: quest.parentQuestId,
    threadId: quest.threadId,
    state: quest.state,
    depth: quest.depth,
    ...titled(includeTitles, quest.goal),
    createdAt: quest.createdAt,
    endedAt: quest.endedAt,
    tasks: tree.tasks.map((task) => {
      const delegation = tree.delegations.find((each) => each.childTaskId === task.id);
      return {
        taskId: task.id,
        parentTaskId: task.parentId,
        agentId: task.ownerId,
        threadId: task.threadId,
        state: task.state,
        ...titled(includeTitles, task.brief),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        delegation:
          delegation === undefined
            ? null
            : {
                delegationId: delegation.id,
                leadId: delegation.leadId,
                memberId: delegation.memberId,
                createdAt: delegation.createdAt,
              },
        attempts: tree.attempts
          .filter((attempt) => attempt.taskId === task.id)
          .map((attempt) => ({
            attemptId: attempt.id,
            number: attempt.number,
            agentId: attempt.agentId,
            runtime: attempt.runtime,
            runtimeSessionId: attempt.sessionId,
            state: attempt.state,
            outcome: attempt.outcome,
            startedAt: attempt.startedAt,
            endedAt: attempt.endedAt,
          })),
      };
    }),
    backpack: trace.backpack.map((each) => ({
      itemId: each.id,
      kind: each.kind,
      state: each.state,
      recipientId: each.recipientId,
      taskId: each.taskId,
      attemptId: each.attemptId,
      tries: each.deliveries.length,
      error: each.error,
      blocker: openBlocker(each)?.reason ?? null,
      createdAt: each.createdAt,
      updatedAt: each.updatedAt,
    })),
    journal: trace.journal,
  };
};

const encodeReport = Schema.encodeUnknownSync(DiagnosticsReport);

/**
 * The first layer: the report as its schema names it. Whatever the input carries beyond the
 * schema, such as a brief, a result or a new column, is dropped here.
 */
export const allowlistedReport = (input: ReportInput): DiagnosticsReport =>
  encodeReport({
    format: "hobbots.diagnostics",
    version: 1,
    createdAt: input.createdAt,
    hub: input.hub,
    runtimes: input.runtimes.map((health) => ({
      runtime: health.runtime,
      version: health.version,
      availability: health.availability,
      signedIn: signedIn(health),
    })),
    memory: input.memory,
    workHeld: input.workHeld,
    stalled: input.stalled,
    recovery: input.recovery,
    skills: input.skills,
    quest: input.trace === null ? null : reportQuest(input.trace, input.includeTitles),
  }) as DiagnosticsReport;

/** Every string in `value` changed by `change`, at any depth. Keys and other values stay as they are. */
const mapStrings = <A>(value: A, change: (text: string) => string): A => {
  const walk = (inner: unknown): unknown => {
    if (typeof inner === "string") return change(inner);
    if (Array.isArray(inner)) return inner.map(walk);
    if (inner !== null && typeof inner === "object") {
      return Object.fromEntries(Object.entries(inner).map(([key, each]) => [key, walk(each)]));
    }
    return inner;
  };
  return walk(value) as A;
};

/** Where files live on this computer, so a report names them without saying where. */
export interface ReportPlaces {
  /** Your home folder, shown as `~`. */
  readonly home: string;
  /** Each hob folder, shown as `folder 1`, `folder 2` and so on, in this order. */
  readonly folders: ReadonlyArray<string>;
}

const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Drops trailing slashes without a regex, which would backtrack on a long run of them. */
const withoutTrailingSlashes = (path: string): string => {
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || path[end - 1] === "\\")) end -= 1;
  return path.slice(0, end);
};

/** Replaces each hob folder, then the home folder, wherever a path starts with one. */
export const placesHidden = (places: ReportPlaces): ((text: string) => string) => {
  const named = places.folders
    .map((folder, index) => ({ folder: withoutTrailingSlashes(folder), name: `folder ${index + 1}` }))
    .filter((each) => each.folder.length > 1)
    .sort((a, b) => b.folder.length - a.folder.length);
  const home = withoutTrailingSlashes(places.home);
  // A folder counts only as a whole path: `/Users/me/shop` is not inside `/Users/me/shopping`.
  const rules = [
    ...named.map((each) => ({
      pattern: new RegExp(`${literally(each.folder)}(?=$|[/\\\\\\s"'),:;])`, "g"),
      name: each.name,
    })),
    ...(home.length > 1 ? [{ pattern: new RegExp(`${literally(home)}(?=$|[/\\\\\\s"'),:;])`, "g"), name: "~" }] : []),
  ];
  return (text) => rules.reduce((result, rule) => result.replace(rule.pattern, rule.name), text);
};

/** The second layer: every string through the hub's redactor, then paths hidden. */
export const redactedReport = (
  report: DiagnosticsReport,
  redactor: Pick<Redactor, "text">,
  places: ReportPlaces,
): DiagnosticsReport => {
  const hide = placesHidden(places);
  return mapStrings(report, (text) => hide(redactor.text(text)));
};

/**
 * The third layer: the first field that `holdsSecret` finds a credential or a secret's shape in, as
 * a dotted path such as `quest.tasks.1.attempts.0.outcome`; null when none does.
 */
export const leakedField = (value: unknown, holdsSecret: (text: string) => boolean, path = ""): string | null => {
  if (typeof value === "string") return holdsSecret(value) ? path : null;
  if (value === null || typeof value !== "object") return null;
  for (const [key, inner] of Object.entries(value)) {
    const found = leakedField(inner, holdsSecret, path === "" ? key : `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
};

/**
 * Whether text holds a credential: anything the redactor would still change, which is a value it
 * knows or a secret's shape, or one of `known`. Redacted text holds none, since a marker matches nothing.
 */
export const holdsSecret =
  (redactor: Pick<Redactor, "text">, known: ReadonlyArray<KnownSecret> = []) =>
  (text: string): boolean =>
    redactor.text(text) !== text || secretIn(text, known) !== null;
