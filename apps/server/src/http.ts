import { hostname } from "node:os";
import {
  type ApprovalService,
  ChatService,
  DeviceService,
  everyRuntimeHealth,
  foundAgent,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  missingRuntimeModels,
  readToolLog,
  runtimeAdapters,
  summonCapsOf,
  type TaskRepository,
  ToolLogs,
  UnattendedSummonLimits,
} from "@hobbots/agents";
import { CONNECT_PROTOCOL, HobbotsApi, type SetBrainPayload, ThreadNotFound } from "@hobbots/api";
import type { ThreadId } from "@hobbots/domain";
import type { Backpack } from "@hobbots/inbox";
import { Effect, Layer, Option } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { ApprovalsHandlers } from "./approvals.ts";
import { BackpackHandlers } from "./backpack.ts";
import { BackupHandlers } from "./backup-handlers.ts";
import { BlockersHandlers } from "./blockers.ts";
import { CampSuggestionsHandlers } from "./camp-suggestions.ts";
import { ChaptersHandlers } from "./chapters.ts";
import { CharmCallsHandlers } from "./charm-calls.ts";
import { DevicesHandlers } from "./device-handlers.ts";
import { DeviceGate } from "./devices.ts";
import { DiagnosticsHandlers } from "./diagnostics.ts";
import { ExportsHandlers } from "./exports.ts";
import { GitHubHandlers } from "./github.ts";
import { GrantsHandlers } from "./grants.ts";
import { HobChangesHandlers } from "./hob-changes.ts";
import { HobGitHubAppHandlers } from "./hob-github-app.ts";
import { HobInputErrorsLayer } from "./hob-input-errors.ts";
import { HobMemoryHandlers } from "./hob-memory.ts";
import { HobPresences } from "./hob-presence.ts";
import { HobProposalsHandlers } from "./hob-proposals.ts";
import { Installation } from "./installation.ts";
import { MemoryPagesHandlers } from "./memory.ts";
import { MemoryHandlers } from "./memory-settings.ts";
import { MemorySharesHandlers } from "./memory-shares.ts";
import { PairingHandlers, PairingRequestsHandlers, withRetryAfter } from "./pairing.ts";
import { PermissionsHandlers } from "./permissions.ts";
import { RecordsHandlers } from "./records.ts";
import { RemoteAccessHandlers } from "./remote-access.ts";
import { openWork, retireAs } from "./retire.ts";
import { SearchHandlers } from "./search.ts";
import { SetupHandlers } from "./setup.ts";
import { SkillProposalsHandlers } from "./skill-proposals.ts";
import { SkillRepositoriesHandlers } from "./skill-repositories.ts";
import { SkillHealthHandlers, SkillTrialsHandlers } from "./skill-trials.ts";
import { SkillUpdatesHandlers } from "./skill-updates.ts";
import { SkillsHandlers } from "./skills.ts";
import { QuestionsHandlers, TaskControlsHandlers, TasksHandlers } from "./tasks.ts";
import { UsageHandlers } from "./usage.ts";
import { DeviceSessionLive } from "./user-session.ts";
import { WebHandlers } from "./web-usage.ts";
import { WorkbenchHandlers } from "./workbench.ts";

// The create and update endpoints' middleware is read when the group is built, so it is provided here.
const AgentsHandlers = HttpApiBuilder.group(HobbotsApi, "agents", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    const hobs = yield* HobService;
    const lifecycle = yield* HobLifecycle;
    const summonLimits = yield* UnattendedSummonLimits;
    const context = yield* Effect.context<HobbotsRepository | TaskRepository | ApprovalService | Backpack>();
    return handlers.handleAll({
      list: ({ query }) => repo.listAgentsWithStatus(query.status ? [query.status] : ["active", "paused"]),
      create: ({ payload }) => hobs.create(payload),
      update: ({ params, payload }) => hobs.update(params.agentId, payload),
      pause: ({ params }) => lifecycle.pause(params.agentId),
      wake: ({ params }) => lifecycle.wake(params.agentId),
      retire: ({ params, payload }) =>
        retireAs(params.agentId, payload).pipe(Effect.provideService(HobLifecycle, lifecycle)),
      openWork: ({ params, query }) => openWork(params.agentId, query.handOverTo).pipe(Effect.provide(context)),
      bringBack: ({ params }) => lifecycle.bringBack(params.agentId),
      threads: ({ params, query }) =>
        repo.findAgent(params.agentId).pipe(
          Effect.flatMap(foundAgent(params.agentId)),
          Effect.flatMap(() =>
            query.archived === "true" ? repo.listArchivedThreads(params.agentId) : repo.listThreads(params.agentId),
          ),
        ),
      createThread: ({ params }) => chat.createThread(params.agentId),
      makeCamp: ({ params, payload }) =>
        chat.makeCamp(params.agentId, {
          key: payload.key,
          title: payload.title,
          goal: payload.goal,
          private: payload.private,
        }),
      summonCaps: ({ params }) =>
        repo.findAgent(params.agentId).pipe(
          Effect.flatMap(foundAgent(params.agentId)),
          Effect.andThen(repo.listAgents),
          Effect.map((agents) => summonCapsOf(agents, params.agentId, summonLimits)),
        ),
    });
  }),
).pipe(Layer.provide(HobInputErrorsLayer));

const ThreadsHandlers = HttpApiBuilder.group(HobbotsApi, "threads", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    const hobs = yield* HobService;
    // Hubs without a log store, as in tests, have no full logs to open.
    const logs = yield* Effect.serviceOption(ToolLogs);
    // Making a brain the hob's default edits the hob (a new configuration version), then the thread
    // follows the hob again. Otherwise only the thread changes (ADR 017).
    const setBrain = (threadId: ThreadId, { brain, makeDefault }: SetBrainPayload) =>
      Effect.gen(function* () {
        if (brain === null || makeDefault !== true) return yield* chat.setBrain(threadId, brain);
        const thread = yield* repo
          .findThread(threadId)
          .pipe(
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(new ThreadNotFound({ threadId })), onSome: Effect.succeed }),
            ),
          );
        // One step under the hob's lock: an archived thread changes nothing, not even its hob's
        // default, and no archive lands between the hob's edit and the thread following it.
        return yield* hobs.updateThen(thread.agentId, brain, chat.checkBrainSwitch(threadId), () =>
          chat.followHob(threadId),
        );
      });
    // A read of a thread that must exist: refused with ThreadNotFound when it does not.
    const ofThread = <A>(threadId: ThreadId, read: (threadId: ThreadId) => Effect.Effect<A>) =>
      repo
        .findThread(threadId)
        .pipe(
          Effect.flatMap(
            Option.match({ onNone: () => Effect.fail(new ThreadNotFound({ threadId })), onSome: () => read(threadId) }),
          ),
        );
    return handlers.handleAll({
      messages: ({ params }) => ofThread(params.threadId, repo.listMessages),
      sendPrompt: ({ params, payload }) => chat.sendPrompt(params.threadId, payload.content, payload.skill ?? null),
      removeQueued: ({ params }) => chat.removeQueued(params.threadId, params.messageId),
      sendNow: ({ params }) => chat.sendNow(params.threadId, params.messageId),
      interrupt: ({ params }) => chat.stop(params.threadId),
      stopWaiting: ({ params }) => chat.stopWaiting(params.threadId),
      continueReply: ({ params }) => chat.continueReply(params.threadId, params.messageId),
      toolLog: ({ params }) => readToolLog(params, repo, logs),
      setBrain: ({ params, payload }) => setBrain(params.threadId, payload),
      rename: ({ params, payload }) => chat.rename(params.threadId, payload.title),
      pin: ({ params, payload }) => chat.setPinned(params.threadId, payload.pinned),
      markRead: ({ params, payload }) => chat.markRead(params.threadId, payload.messageId, payload.revision),
      archive: ({ params }) => chat.archive(params.threadId),
      restore: ({ params }) => chat.restore(params.threadId),
      startFresh: ({ params, payload }) => chat.startFresh(params.threadId, payload.key),
      carryOver: ({ params }) => ofThread(params.threadId, repo.carryOver),
    });
  }),
);

const SystemHandlers = HttpApiBuilder.group(HobbotsApi, "system", (handlers) =>
  Effect.gen(function* () {
    const adapters = yield* runtimeAdapters;
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    const presences = yield* HobPresences;

    // A hob is working while one of its threads has a turn running, until the turn's runtime has
    // exited. `TurnStarted` and `TurnEnded` announce each change once it has happened, so a read made
    // on either event already agrees with it.
    const activity = chat.activeThreads.pipe(
      Effect.flatMap((threadIds) =>
        Effect.forEach(threadIds, (threadId) =>
          repo.findThread(threadId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none()),
                onSome: (thread) =>
                  repo
                    .findAgent(thread.agentId)
                    .pipe(Effect.map(Option.map((agent) => ({ agentId: agent.id, name: agent.name, threadId })))),
              }),
            ),
          ),
        ),
      ),
      Effect.map((hobs) => ({ working: hobs.flatMap(Option.toArray) })),
    );

    return handlers.handleAll({
      activity: () => activity,
      status: () =>
        Effect.all([chat.threadRuns, presences.current]).pipe(
          Effect.map(([runs, presences]) => ({
            runsRevision: runs.revision,
            runs: runs.runs,
            presenceRevision: presences.revision,
            hobs: presences.hobs,
          })),
        ),
      runtimes: () => everyRuntimeHealth(adapters),
    });
  }),
).pipe(Layer.provide(HobPresences.layer));

/** The hub's name for the waiting screen: the computer's own, without the `.local` macOS adds. */
const hubName = (host: string = hostname()): string => host.replace(/\.local$/i, "");

// Answers without a device, so a client can tell this hub from another program first (ADR 012).
// Only a local request learns the installation ID and data folder (ADR 021).
const HealthHandlers = HttpApiBuilder.group(HobbotsApi, "health", (handlers) =>
  Effect.gen(function* () {
    const installation = yield* Installation;
    const gate = yield* DeviceGate;
    const devices = yield* DeviceService;
    const name = hubName();
    return handlers.handleAll({
      health: () =>
        Effect.gen(function* () {
          const place = yield* gate.placeOf(yield* HttpServerRequest.HttpServerRequest);
          if (Option.isSome(place)) yield* devices.throttleAnonymous(place.value);
          const local = Option.exists(place, (where) => where._tag === "Local");
          const connect = CONNECT_PROTOCOL;
          return local
            ? { ...installation, name, connect }
            : { app: installation.app, name, version: installation.version, connect };
        }).pipe(withRetryAfter),
    });
  }),
);

// A runtime the hub has no adapter for offers no models.
const RuntimesHandlers = HttpApiBuilder.group(HobbotsApi, "runtimes", (handlers) =>
  Effect.gen(function* () {
    const adapters = yield* runtimeAdapters;
    return handlers.handleAll({
      models: ({ params }) => adapters(params.runtime)?.models ?? Effect.succeed(missingRuntimeModels(params.runtime)),
    });
  }),
);

/**
 * Every API route. All but health and pairing sit behind the device middleware (ADR 021), which
 * needs `DeviceGate` and the device store.
 */
export const ApiRoutes = HttpApiBuilder.layer(HobbotsApi).pipe(
  Layer.provide([
    HealthHandlers,
    PairingHandlers,
    PairingRequestsHandlers,
    DevicesHandlers,
    AgentsHandlers,
    HobChangesHandlers,
    ThreadsHandlers,
    ChaptersHandlers,
    RecordsHandlers,
    CampSuggestionsHandlers,
    SystemHandlers,
    SetupHandlers,
    RuntimesHandlers,
    SearchHandlers,
    PermissionsHandlers,
    ApprovalsHandlers,
    GrantsHandlers,
    CharmCallsHandlers,
    TasksHandlers,
    TaskControlsHandlers,
    QuestionsHandlers,
    BackpackHandlers,
    BlockersHandlers,
    GitHubHandlers,
    HobGitHubAppHandlers,
    WorkbenchHandlers,
    RemoteAccessHandlers,
    BackupHandlers,
    DiagnosticsHandlers,
    ExportsHandlers,
    UsageHandlers,
    WebHandlers,
    MemoryHandlers,
    MemoryPagesHandlers,
    MemorySharesHandlers,
    HobMemoryHandlers,
    SkillsHandlers,
    SkillProposalsHandlers,
    HobProposalsHandlers,
    SkillUpdatesHandlers,
    SkillRepositoriesHandlers,
    SkillTrialsHandlers,
    SkillHealthHandlers,
  ]),
  Layer.provide(DeviceSessionLive),
);
