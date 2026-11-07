import { homedir } from "node:os";
import {
  allowlistedReport,
  DiagnosticsReads,
  everyRuntimeHealth,
  HobbotsRepository,
  holdsSecret,
  leakedField,
  makeRedactor,
  RecoveryLog,
  redactedReport,
  runtimeAdapters,
  SecretRedaction,
  stalledWork,
  TaskRepository,
  workHeld,
} from "@hobbots/agents";
import { DiagnosticsReportRefused, HobbotsApi, QuestNotFound, type QuestTrace } from "@hobbots/api";
import type { BackpackItem, QuestId } from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { MemoryEngine } from "@hobbots/memory";
import { DiagnosticsReadsLive, SetupRepository } from "@hobbots/persistence";
import { Clock, Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Installation } from "./installation.ts";
import { hobSkillLines } from "./skills.ts";

/** How many Quests Diagnostics offers to follow, and how many of a Quest's journal entries it shows. */
const LIMITS = { quests: 50, journal: 200 } as const;

const byId = (items: ReadonlyArray<BackpackItem>) => [...new Map(items.map((each) => [each.id, each])).values()];

// Settings › Diagnostics (ADR 026). Everything here is a read; the report is made on request,
// shown to you in full and never sent anywhere by the hub. Its own reads come with it, over the
// hub's database.
export const DiagnosticsHandlers = HttpApiBuilder.group(HobbotsApi, "diagnostics", (handlers) =>
  Effect.gen(function* () {
    const reads = yield* DiagnosticsReads;
    const tasks = yield* TaskRepository;
    const backpack = yield* Backpack;
    const repo = yield* HobbotsRepository;
    const setup = yield* SetupRepository;
    const installation = yield* Installation;
    const adapters = yield* runtimeAdapters;
    const redactor = Option.getOrElse(yield* Effect.serviceOption(SecretRedaction), () => makeRedactor());
    const recovery = yield* Effect.serviceOption(RecoveryLog);
    // A hub built without a memory engine, as some tests build it, reports none.
    const memory = yield* Effect.serviceOption(MemoryEngine);
    // Whether a restore holds work until you resume it (ADR 026).
    const held = yield* workHeld;
    // The handlers are built once, as the hub starts, after its recovery ran.
    const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    // Each hob's skills by name and revision, never their contents (ADR 029).
    const skills = yield* hobSkillLines;

    const now = Effect.gen(function* () {
      const at = new Date(yield* Clock.currentTimeMillis).toISOString();
      const live = yield* tasks.listLiveAttempts;
      const progress = yield* reads.lastProgress(live.map((attempt) => attempt.id));
      const quests = yield* reads.questsOf(live.map((attempt) => attempt.taskId));
      const errors = Option.isSome(recovery) ? yield* recovery.value.errors : [];
      return {
        runtimes: yield* everyRuntimeHealth(adapters),
        memory: Option.isSome(memory) ? yield* memory.value.health : null,
        stalled: stalledWork({
          open: yield* backpack.listOpen({ _tag: "Workspace" }),
          blocked: yield* backpack.listBlocked({ _tag: "Workspace" }),
          live: live.map((attempt) => ({
            attemptId: attempt.id,
            taskId: attempt.taskId,
            agentId: attempt.agentId,
            state: attempt.state,
            startedAt: attempt.startedAt,
            lastProgress: progress.get(attempt.id),
          })),
          questOf: (taskId) => quests.get(taskId) ?? null,
          now: at,
        }),
        // A recovery error's message can quote what failed, so it is redacted like tool output.
        recovery: errors.map((error) => ({ ...error, message: redactor.text(error.message) })),
        workHeld: yield* held,
        startedAt,
        skills: yield* skills,
      };
    });

    const trace = (questId: QuestId) =>
      Effect.gen(function* () {
        const quest = yield* tasks.findQuest(questId);
        if (Option.isNone(quest)) return yield* new QuestNotFound({ questId });
        const tree = yield* tasks.readTree(quest.value.taskId);
        if (Option.isNone(tree)) return yield* new QuestNotFound({ questId });
        const scope = { _tag: "Quest", questId } as const;
        return {
          quest: quest.value,
          tree: tree.value,
          backpack: byId([...(yield* backpack.listOpen(scope)), ...(yield* backpack.listBlocked(scope))]),
          journal: yield* reads.journalForTasks(
            tree.value.tasks.map((task) => task.id),
            LIMITS.journal,
          ),
        } satisfies QuestTrace;
      });

    /** Your home folder, and every folder a hob may work in, shared or its own, in a stable order. */
    const places = Effect.gen(function* () {
      const shared = (yield* setup.get).approvedFolders;
      const hobs = yield* repo.listAgentsWithStatus(["active", "paused", "retired"]);
      const own = hobs.flatMap((hob) => hob.policy.ownFolders);
      return { home: homedir(), folders: [...new Set([...shared, ...own])] };
    });

    const report = (questId: QuestId | undefined, includeTitles: boolean) =>
      Effect.gen(function* () {
        const current = yield* now;
        const followed = questId === undefined ? null : yield* trace(questId);
        const raw = allowlistedReport({
          createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          hub: {
            version: installation.version,
            schemaVersion: yield* reads.schemaVersion,
            storage: yield* reads.storage,
            os: process.platform,
            arch: process.arch,
            electron: process.versions.electron ?? null,
            node: process.versions.node,
          },
          runtimes: current.runtimes,
          memory: current.memory,
          workHeld: current.workHeld,
          stalled: current.stalled,
          recovery: current.recovery,
          skills: current.skills,
          trace: followed,
          includeTitles,
        });
        const redacted = redactedReport(raw, redactor, yield* places);
        // The final check names the field, never the value (ADR 026).
        const field = leakedField(redacted, holdsSecret(redactor));
        if (field !== null) {
          yield* Effect.logWarning(`Refused a diagnostics report: ${field} held a credential`);
          return yield* new DiagnosticsReportRefused({ field });
        }
        return redacted;
      });

    return handlers.handleAll({
      now: () => now,
      quests: () => reads.listQuests(LIMITS.quests),
      trace: ({ params }) => trace(params.questId),
      report: ({ query }) => report(query.questId, query.titles === "true"),
    });
  }),
).pipe(Layer.provide(DiagnosticsReadsLive));
