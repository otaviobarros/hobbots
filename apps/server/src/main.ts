import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join, sep } from "node:path";
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  ActivityRecorder,
  ApprovalService,
  CharmCallService,
  ChatService,
  DataExport,
  DeviceService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  MemoryBriefReceipts,
  PermissionSummary,
  RecoveryLog,
  SecretRedaction,
  TaskFiles,
} from "@hobbots/agents";
import {
  GitHubAccountLive,
  GitHubApiNode,
  GitHubCharmTools,
  GitHubCredentialPerHob,
  GitHubPushSettings,
  GitHubSignInFake,
  GitHubSignInNode,
  GitPushLive,
  GitRemotes,
  HobAppKeysLive,
  HobAppKeysMemory,
  HobGitHubAppNode,
  KeychainLive,
  KeychainMemory,
  LocalGitHubSignInsFake,
  LocalGitHubSignInsLive,
  LocalGitToolsLive,
} from "@hobbots/charms";
import { DEFAULT_HUB_PORT, DEFAULT_SERVE_PORT, secretsFromEnv } from "@hobbots/domain";
import { DEFAULT_DISPATCH_LIMITS, Dispatcher } from "@hobbots/inbox";
import {
  defaultEngineFolder,
  loadOrCreateMemoryKeys,
  MemoryEngine,
  type MemoryKeys,
  MemoryProjectsLive,
} from "@hobbots/memory";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ActivityRepositoryLive,
  ApprovalRepositoryLive,
  BackpackLive,
  CharmCallsLive,
  DeviceRepositoryLive,
  EventJournal,
  GitHubAccountRepository,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  HobGitHubAppRepository,
  RestoreRepository,
  SearchIndex,
  SetupRepository,
  SqliteLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import {
  ClaudeCodeLayer,
  CodexLayer,
  FakeAdditionalRuntimesLayer,
  FakeRuntimeLayer,
  FolderSandboxLive,
  ProcessSandbox,
} from "@hobbots/runtimes";
import { ActivityStoreLive, FolderScannerLive, GitWorkspaceLive, HobFilesLive } from "@hobbots/workbench";
import { Deferred, Effect, Layer, Option, Redacted, References } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { DispatcherHostLive } from "./backpack.ts";
import { BackupHolds, HeldActivityStore, HeldRuntimes } from "./backup-holds.ts";
import { HubBackups } from "./backups.ts";
import { BlockOnRetirement } from "./blockers.ts";
import { ServerConfig } from "./config.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "./continuations.ts";
import { SaveDestinationsLive } from "./destination.ts";
import { DeviceGate, DeviceSecretsLive, PairingLimiterLive, WindowKeyLive } from "./devices.ts";
import { EventBus } from "./event-bus.ts";
import { EventStream, EventStreamRoute } from "./event-stream.ts";
import { ExportFoldersLive } from "./exports.ts";
import { FAKE_QUEST_STEP, FakeQuestLive } from "./fake-quest.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "./folders.ts";
import { HobGitHubAppPages } from "./hob-github-app.ts";
import { ApiRoutes } from "./http.ts";
import { ensureInstallationId, Installation } from "./installation.ts";
import { JournalCompaction } from "./journal-compaction.ts";
import { HubListenersLive } from "./listeners.ts";
import { backupBeforeMigrations } from "./migration-backup.ts";
import { readNetworkSettings } from "./network-settings.ts";
import {
  HubHostsLive,
  KnownTailnetPeersOnly,
  NoFunnelRequests,
  RemoteAccessLive,
  RemoteAccessStateLive,
} from "./remote-access.ts";
import { QuietRoutineReads } from "./request-log.ts";
import { finishReset, HubReset, wipeHubData } from "./resets.ts";
import { HubRestart, HubRestores, performRestore, RestoreOutcome, RestoreRulesLive, WorkHoldLive } from "./restores.ts";
import { StopWithoutWaitingForClients } from "./shutdown.ts";
import { TailscaleFakeFile, TailscaleLive } from "./tailscale.ts";
import { TaskFileRoute } from "./task-files.ts";
import { ToolLogsLive } from "./tool-logs.ts";
import { HobToolsLive } from "./tools.ts";
import { OwnHostsOnly, WebClientRoutes } from "./web.ts";
import { ActivityRetention, OverlappingChanges } from "./workbench.ts";
import { WorkbenchStreamRoute } from "./workbench-stream.ts";

/** The memory engine as the hub's settings choose it: turned off, missing, or the bundled binary. */
const memoryEngineLayer = (
  config: { readonly memory: "on" | "off"; readonly memoryEngineDir: Option.Option<string> },
  dataDir: string,
  keys: MemoryKeys,
) => {
  if (config.memory === "off") return MemoryEngine.off("disabled");
  const folder = Option.getOrElse(config.memoryEngineDir, () => defaultEngineFolder() ?? "");
  if (folder === "") return MemoryEngine.off("missing");
  return MemoryEngine.layer({ folder, dataDir, keys }).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
};

const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    mkdirSync(config.dataDir, { recursive: true });
    // The canonical path, so clients compare the same spelling of the folder.
    const dataDir = realpathSync(config.dataDir);
    const identity = Layer.succeed(Installation, {
      app: "hobbots",
      installationId: ensureInstallationId(dataDir),
      version: config.version,
      dataDir,
    });
    // The port and remote access as the user last chose them (ADR 021); HOBBOTS_PORT overrides the port.
    const network = readNetworkSettings(dataDir);
    const port = Option.getOrElse(config.port, () => network.port ?? DEFAULT_HUB_PORT);
    // The serve listener's port, which `tailscale serve` forwards HTTPS to; HOBBOTS_SERVE_PORT overrides it.
    const servePort = Option.getOrElse(
      config.servePort,
      () => network.servePort ?? (port === DEFAULT_SERVE_PORT ? DEFAULT_SERVE_PORT + 1 : DEFAULT_SERVE_PORT),
    );
    const Remote = HubHostsLive.pipe(
      Layer.provideMerge(
        RemoteAccessStateLive({
          enabled: network.remoteAccess ?? false,
          paused: network.remoteAccessPaused ?? false,
          port,
          https: network.https ?? false,
          servePort,
        }),
      ),
    );
    const Tailnet =
      config.fakeTailscale === "on"
        ? TailscaleFakeFile(dataDir)
        : TailscaleLive(process.platform, process.env).pipe(Layer.provide(NodeServices.layer));

    // New installations start without hobs; the user summons the first one during setup.
    const database = join(config.dataDir, "hobbots.sqlite");
    // Search reads the same file from a worker thread, so a long search never blocks the server.
    // One SQLite client for the hub: the layer is shared, so it is built once. On the first start
    // after a restore, its rules apply before anything reads the database (ADR 026).
    const Sqlite = RestoreRulesLive(dataDir).pipe(Layer.provideMerge(SqliteLive(database)));
    const Persistence = Layer.mergeAll(
      HobbotsRepositoryLive,
      ApprovalRepositoryLive,
      GrantRepositoryLive,
      TaskRepositoryLive,
      TaskToolCallsLive,
      CharmCallsLive,
      ActivityRepositoryLive,
      BackpackLive,
      DeviceRepositoryLive,
      RestoreRepository.layer,
      EventJournal.layer,
      SetupRepository.layer,
      SearchIndex.sqliteWorker(database),
    ).pipe(Layer.provideMerge(Sqlite));
    // One policy engine for the hub, so its index of the folders' Git repositories is built once.
    // The fake answers for Claude Code and Codex, so a thread can switch brains (ADR 017). Its
    // sandbox and web tools never reach the hub's own tailnet names (ADR 021).
    // Playing a scripted Quest, the fake lead stays quiet between the plan and the finish (#901).
    const fake = {
      delay: "40 millis",
      stopDelay: "600 millis",
      sandbox: config.fakeSandbox,
      quietContinuations: config.fakeQuest !== "off",
    } as const;
    const Runtime = (
      config.runtime === "fake"
        ? Layer.mergeAll(
            FakeRuntimeLayer({ ...fake, availability: config.fakeAvailability }),
            FakeAdditionalRuntimesLayer({ ...fake, availability: config.fakeCodexAvailability }),
          )
        : Layer.mergeAll(
            ClaudeCodeLayer({
              workspaceDir: join(config.dataDir, "workspaces", "default"),
              executable: Option.getOrUndefined(config.claudeExecutable),
            }),
            CodexLayer({
              executable: Option.getOrUndefined(config.codexExecutable),
              clientVersion: config.version,
              workspaceDir: join(config.dataDir, "workspaces", "codex"),
            }).pipe(Layer.provide(NodeServices.layer)),
            // One sandbox serves both runtimes' turns (ADR 014).
          ).pipe(Layer.provide(ProcessSandbox.layer))
    ).pipe(Layer.provide(PolicyEngine.node), Layer.provide(Remote));
    // Turns that can write to the default workspace wait while a backup copies it (ADR 026).
    const HeldRuntime = HeldRuntimes.pipe(Layer.provide(Runtime), Layer.provideMerge(BackupHolds.layer));
    // The GitHub Charm reads and pushes on the hub, outside the sandbox (#317, #323), as the GitHub
    // account the user connected in Settings, whose tokens stay in the OS keychain (ADR 020). A push
    // reads the hob's branch with Git in the hob's sandbox.
    const fakeGitHub = config.fakeGitHub === "on";
    const Account = GitHubAccountLive({
      clientId: fakeGitHub ? "fake" : config.githubClientId,
      slug: config.githubAppSlug,
      environmentToken: Option.getOrNull(config.githubToken),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          fakeGitHub ? KeychainMemory : KeychainLive(process.platform, process.env),
          fakeGitHub ? GitHubSignInFake : GitHubSignInNode(),
          fakeGitHub ? LocalGitHubSignInsFake : LocalGitHubSignInsLive(process.env),
          GitHubAccountRepository.pipe(Layer.provide(Sqlite)),
        ),
      ),
    );
    // Each hob's own GitHub App (ADR 022): its identity in the database, its key in the keychain.
    const HobApp = HobGitHubAppNode().pipe(
      Layer.provide(
        Layer.mergeAll(
          fakeGitHub ? HobAppKeysMemory : HobAppKeysLive(process.platform, process.env),
          HobGitHubAppRepository.pipe(Layer.provide(Sqlite)),
        ),
      ),
    );
    // Each hob acts on GitHub as its own app when it has one, as the user's account otherwise (#224).
    // The hobs' apps are given on, so a hob with its own app commits as its bot (ADR 022).
    const GitHub = GitHubCredentialPerHob.pipe(
      Layer.provide(Account),
      Layer.provideMerge(HobApp),
      Layer.provideMerge(HobGitHubAppRepository.pipe(Layer.provide(Sqlite))),
    );
    const charmFolder = join(dataDir, "charms", "github");
    const Charms = GitHubCharmTools.pipe(
      Layer.provide(
        Layer.mergeAll(
          GitHubApiNode(),
          GitRemotes.layer,
          PolicyEngine.node,
          GitPushLive({ folder: charmFolder }).pipe(
            Layer.provide(
              FolderSandboxLive({ dataFolder: dataDir, stateFolder: join(charmFolder, "sandbox") }).pipe(
                Layer.provide(ProcessSandbox.layer),
              ),
            ),
          ),
          Layer.succeed(GitHubPushSettings, {
            over: config.githubPush,
            agentSocket: Option.getOrUndefined(config.githubSshAgent),
          }),
        ),
      ),
      Layer.provideMerge(GitHub),
      Layer.provide(NodeServices.layer),
    );
    // The hub creates a repository for a hob, whose sandbox cannot write its config (ADR 014).
    // The hub makes a hob's repository in its own data folder, which no turn reaches, then copies it (#578).
    const LocalGit = LocalGitToolsLive({ stagingFolder: join(dataDir, "charms", "local-git") }).pipe(
      Layer.provide(Layer.mergeAll(PolicyEngine.node, NodeServices.layer)),
    );
    // The memory engine (ADR 028): the bundled ai-memory, run beside the hub and stopped with it. Its
    // two keys stay in the data folder and reach only the engine's environment. Without an engine,
    // or one that fails its checksum, memory is off and everything else works.
    const memoryKeys = loadOrCreateMemoryKeys(dataDir);
    const Memory = memoryEngineLayer(config, dataDir, memoryKeys);
    // The hub's own path separator, which alone divides the folders a hob may be given (STD-SEC-003).
    const separator = sep === "\\" ? "\\" : "/";
    const App = HobLifecycle.layer
      .pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            EventStream.layer,
            HobService.layer,
            PermissionSummary.layer,
            JournalCompaction,
            // The Workbench's heavy details are cleared past their retention window (ADR 023).
            ActivityRetention,
            // Two Tasks of one Quest changing the same file is a finding for their lead (#570).
            OverlappingChanges,
            // Work that arrives for a hob wakes its thread (ADR 019).
            WakeOnArrival,
            // A retired hob's work fails as blockers that wait for you (IN-007).
            BlockOnRetirement,
            // Settings › Backup & export (ADR 026).
            HubBackups.layer,
            HubRestores.layer,
            // Settings › Your data › Start over (#948).
            HubReset.layer,
            config.runtime === "fake" && config.fakeQuest === "black-friday"
              ? FakeQuestLive(FAKE_QUEST_STEP)
              : Layer.empty,
          ),
        ),
      )
      .pipe(Layer.provideMerge(ChatService.layer))
      // Before the chat service: every turn you did not start with Send starts from the backpack, and
      // at start the dispatcher expires the claims an earlier process held (ADR 019).
      .pipe(Layer.provideMerge(ContinuationsLive))
      // Before the chat service: its turns offer the Task tools (the hub checks every call), and a
      // Task's steps and its party members' work run in their own sessions while the hob keeps
      // chatting (ADR 018).
      .pipe(
        Layer.provideMerge(
          StepRunnerLive(config.stepLimits, separator).pipe(
            Layer.provideMerge(MemberContinuationsLive),
            Layer.provideMerge(TaskTools.layer(separator, config.taskLimits)),
            Layer.provideMerge(TaskSignal.layer),
          ),
        ),
      )
      // Before the chat service and the step runner: every turn, a step's and a party member's too,
      // records what it ran and changed for the Workbench (ADR 023), its details kept in the data
      // folder, out of every hob's reach.
      .pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ActivityRecorder.layer(),
            TaskFiles.layer.pipe(Layer.provide(HobFilesLive)),
            // Exports of your threads and work history (ADR 026), never inside a hob's folder.
            DataExport.layer(config.version).pipe(
              Layer.provide(
                Layer.mergeAll(
                  HobFilesLive,
                  ExportFoldersLive,
                  SaveDestinationsLive(join(config.dataDir, "workspaces", "default")),
                ),
              ),
            ),
          ).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                FolderScannerLive,
                // What a Task leaves uncommitted when it completes, read without running Git (#586).
                GitWorkspaceLive,
                // Nothing is deleted from it while a backup holds cleanup (ADR 026).
                HeldActivityStore.pipe(Layer.provide(ActivityStoreLive(join(dataDir, "activity")))),
              ),
            ),
          ),
        ),
      )
      // One dispatcher for the whole hub, so the claims it expires at start are an earlier process's.
      .pipe(
        Layer.provideMerge(
          Dispatcher.layer({ ...DEFAULT_DISPATCH_LIMITS, maxDeliveries: config.maxDeliveries }).pipe(
            Layer.provideMerge(DispatcherHostLive),
          ),
        ),
      )
      // Before the chat service, so turns can ask, and after a restart the requests left pending expire.
      .pipe(Layer.provideMerge(ApprovalService.layer))
      .pipe(Layer.provideMerge(HobToolsLive))
      // Before the chat service, whose turns offer it; after the database, which keeps its call records.
      .pipe(Layer.provideMerge(Layer.mergeAll(Charms, LocalGit, CharmCallService.layer)))
      // Before approvals, so a decision can save grants and every call reads the hob's live ones; before
      // the hob's own GitHub app, which revokes GitHub grants whenever the hob's identity changes (ADR 022).
      .pipe(Layer.provideMerge(GrantService.layer))
      // Before any request, so every hob's hidden folders compare against canonical shared folders.
      .pipe(Layer.provideMerge(CanonicalSharedFolders))
      // Where exports and backups may be saved: never inside a folder a hob works in (ADR 026).
      .pipe(Layer.provideMerge(SaveDestinationsLive(join(dataDir, "workspaces", "default"))))
      .pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            // After a restore, work waits until you resume it (ADR 026).
            WorkHoldLive.pipe(Layer.provideMerge(Persistence)),
            EventBus.layer,
            HobAdmission.layer,
            NodeFolderChecks,
            HeldRuntime,
            identity,
            // What the startup recovery could not do, for Settings › Diagnostics (ADR 026).
            RecoveryLog.layer,
            Memory,
            // Before every session, a chat's, a step's and a party member's: a hob's memory reaches the
            // projects of its folders, and what each session was briefed from it (ADR 028).
            MemoryProjectsLive,
            MemoryBriefReceipts.layer,
            // The hub's credentials, provider keys and memory keys included, are redacted by value
            // from what tools report.
            SecretRedaction.layer([
              ...secretsFromEnv(process.env),
              { value: Redacted.value(memoryKeys.root), kind: "AI_MEMORY_AUTH_TOKEN" },
              { value: Redacted.value(memoryKeys.proxy), kind: "AI_MEMORY_AUTH__ACTOR_PROXY_BEARER_TOKEN" },
            ]),
            // The whole output of long tool calls, which their steps show cut.
            ToolLogsLive(join(dataDir, "tool-logs")),
          ),
        ),
      );

    if (!existsSync(join(config.webDir, "index.html"))) {
      yield* Effect.logWarning(
        `No web client in ${config.webDir}; run \`pnpm --filter @hobbots/web build\` to serve it`,
      );
    }
    yield* Effect.log(
      `Hobbots server on http://localhost:${port} (runtime: ${config.runtime}, data: ${config.dataDir})`,
    );

    // Loopback on IPv4 and IPv6, and the tailnet while remote access is on: no other interface.
    const server = createServer();
    // Each provided layer is built before the ones above it. App comes last so the server listens
    // only once the routes can answer: a request that arrives earlier is never answered.
    return StopWithoutWaitingForClients(server).pipe(
      Layer.provideMerge(
        HttpRouter.serve(
          Layer.mergeAll(
            ApiRoutes,
            EventStreamRoute,
            WorkbenchStreamRoute,
            TaskFileRoute,
            HobGitHubAppPages,
            WebClientRoutes(config.webDir),
            OwnHostsOnly,
            KnownTailnetPeersOnly,
            NoFunnelRequests,
            QuietRoutineReads,
          ),
        ),
      ),
      // Every client is an approved device; the hub's window gets its key on each start (ADR 021).
      // Above remote access, so the device check knows which requests came in on the tailnet.
      Layer.provideMerge(
        DeviceGate.layer.pipe(
          Layer.provideMerge(DeviceService.layer),
          Layer.provideMerge(WindowKeyLive(dataDir)),
          Layer.provideMerge(DeviceSecretsLive),
          Layer.provideMerge(PairingLimiterLive),
        ),
      ),
      Layer.provideMerge(RemoteAccessLive(dataDir).pipe(Layer.provideMerge(HubListenersLive(server, port)))),
      Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port })),
      Layer.provide(Layer.mergeAll(App, Remote, Tailnet)),
    );
  }),
);

/** What stopped the hub: a restore of the backup in `backup` (ADR 026), or Start over (#948). */
type Restart = { readonly _tag: "Restore"; readonly backup: string } | { readonly _tag: "Reset" };

/**
 * Runs the hub until a restore or Start over asks it to stop (ADR 026, #948): the hub stops, the
 * backup is restored or the data is deleted with nothing using the data folder, and the hub starts
 * again on what is there, in the same process. Before each start, a reset that stopped halfway is
 * finished, and a data folder that a migration will change is backed up first.
 */
const Hub = Effect.gen(function* () {
  const config = yield* ServerConfig;
  let failed: string | null = null;
  for (;;) {
    mkdirSync(config.dataDir, { recursive: true });
    const dataDir = realpathSync(config.dataDir);
    if (yield* Effect.promise(() => finishReset(dataDir))) yield* Effect.log("Finished starting over");
    yield* backupBeforeMigrations(dataDir, config.version);
    const asked = yield* Deferred.make<Restart>();
    const restart = Layer.succeed(HubRestart, {
      restore: (backup: string) => Deferred.succeed(asked, { _tag: "Restore", backup }).pipe(Effect.asVoid),
      reset: Deferred.succeed(asked, { _tag: "Reset" }).pipe(Effect.asVoid),
    });
    const next: Restart = yield* Effect.raceFirst(
      Layer.launch(ServerLive.pipe(Layer.provide(Layer.merge(restart, Layer.succeed(RestoreOutcome, { failed }))))),
      Deferred.await(asked),
    );
    if (next._tag === "Reset") {
      yield* Effect.log("Stopped to start over");
      yield* Effect.promise(() => wipeHubData(dataDir));
      failed = null;
      continue;
    }
    yield* Effect.log(`Stopped to restore the backup in ${next.backup}`);
    failed = yield* performRestore(dataDir, next.backup).pipe(
      Effect.as(null),
      Effect.catchTag("RestoreRefused", (refused) => Effect.logWarning(refused.reason).pipe(Effect.as(refused.reason))),
    );
  }
});

Hub.pipe(
  // HOBBOTS_LOG_LEVEL sets the least severe line the hub writes; Debug adds routine reads.
  Effect.provideServiceEffect(
    References.MinimumLogLevel,
    Effect.map(ServerConfig, (config) => config.logLevel),
  ),
  NodeRuntime.runMain,
);
