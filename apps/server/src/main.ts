import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join, sep } from "node:path";
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  ApprovalService,
  CharmCallService,
  ChatService,
  DeviceService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PermissionSummary,
  SecretRedaction,
} from "@hobbots/agents";
import {
  GitHubAccountLive,
  GitHubApiNode,
  GitHubCharmTools,
  GitHubPushSettings,
  GitHubSignInFake,
  GitHubSignInNode,
  GitPushLive,
  GitRemotes,
  KeychainLive,
  KeychainMemory,
  LocalGitHubSignInsFake,
  LocalGitHubSignInsLive,
} from "@hobbots/charms";
import { secretsFromEnv } from "@hobbots/domain";
import { DEFAULT_DISPATCH_LIMITS, Dispatcher } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  CharmCallsLive,
  DeviceRepositoryLive,
  EventJournal,
  GitHubAccountRepository,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  SqliteLive,
  TaskRepositoryLive,
  TaskToolCallsLive,
} from "@hobbots/persistence";
import {
  ClaudeCodeLayer,
  FakeAdditionalRuntimesLayer,
  FakeRuntimeLayer,
  FolderSandboxLive,
  ProcessSandbox,
} from "@hobbots/runtimes";
import { Effect, Layer, Option, References } from "effect";
import { HttpRouter } from "effect/http";
import { DispatcherHostLive } from "./backpack.ts";
import { BlockOnRetirement } from "./blockers.ts";
import { ServerConfig } from "./config.ts";
import { ContinuationsLive, MemberContinuationsLive, WakeOnArrival } from "./continuations.ts";
import { DeviceGate, DeviceSecretsLive, WindowKeyLive } from "./devices.ts";
import { EventBus } from "./event-bus.ts";
import { EventStream, EventStreamRoute } from "./event-stream.ts";
import { FAKE_QUEST_STEP, FakeQuestLive } from "./fake-quest.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "./folders.ts";
import { ApiRoutes } from "./http.ts";
import { ensureInstallationId, Installation } from "./installation.ts";
import { JournalCompaction } from "./journal-compaction.ts";
import { HubListenersLive } from "./listeners.ts";
import { DEFAULT_PORT, readNetworkSettings } from "./network-settings.ts";
import { HubHostsLive, KnownTailnetPeersOnly, RemoteAccessLive, RemoteAccessStateLive } from "./remote-access.ts";
import { QuietRoutineReads } from "./request-log.ts";
import { StopWithoutWaitingForClients } from "./shutdown.ts";
import { TailscaleFakeFile, TailscaleLive } from "./tailscale.ts";
import { ToolLogsLive } from "./tool-logs.ts";
import { HobToolsLive } from "./tools.ts";
import { OwnHostsOnly, WebClientRoutes } from "./web.ts";

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
    const port = Option.getOrElse(config.port, () => network.port ?? DEFAULT_PORT);
    const Remote = HubHostsLive.pipe(
      Layer.provideMerge(RemoteAccessStateLive({ enabled: network.remoteAccess ?? false, port })),
    );
    const Tailnet =
      config.fakeTailscale === "on"
        ? TailscaleFakeFile(dataDir)
        : TailscaleLive(process.platform, process.env).pipe(Layer.provide(NodeServices.layer));

    // New installations start without hobs; the user summons the first one during setup.
    const database = join(config.dataDir, "hobbots.sqlite");
    // Search reads the same file from a worker thread, so a long search never blocks the server.
    // One SQLite client for the hub: the layer is shared, so it is built once.
    const Sqlite = SqliteLive(database);
    const Persistence = Layer.mergeAll(
      HobbotsRepositoryLive,
      ApprovalRepositoryLive,
      GrantRepositoryLive,
      TaskRepositoryLive,
      TaskToolCallsLive,
      CharmCallsLive,
      BackpackLive,
      DeviceRepositoryLive,
      EventJournal.layer,
      SetupRepository.layer,
      SearchIndex.sqliteWorker(database),
    ).pipe(Layer.provideMerge(Sqlite));
    // One policy engine for the hub, so its index of the folders' Git repositories is built once.
    // The fake answers for Claude Code and Codex, so a thread can switch brains (ADR 017). Its
    // sandbox and web tools never reach the hub's own tailnet names (ADR 021).
    const fake = { delay: "40 millis", stopDelay: "600 millis", sandbox: config.fakeSandbox } as const;
    const Runtime = (
      config.runtime === "fake"
        ? Layer.mergeAll(
            FakeRuntimeLayer({ ...fake, availability: config.fakeAvailability }),
            FakeAdditionalRuntimesLayer({ ...fake, availability: config.fakeCodexAvailability }),
          )
        : ClaudeCodeLayer({
            workspaceDir: join(config.dataDir, "workspaces", "default"),
            executable: Option.getOrUndefined(config.claudeExecutable),
          }).pipe(Layer.provide(ProcessSandbox.layer))
    ).pipe(Layer.provide(PolicyEngine.node), Layer.provide(Remote));
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
    const charmFolder = join(dataDir, "charms", "github");
    const Charms = GitHubCharmTools.pipe(
      Layer.provide(
        Layer.mergeAll(
          GitHubApiNode,
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
      Layer.provideMerge(Account),
      Layer.provide(NodeServices.layer),
    );
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
            // Work that arrives for a hob wakes its thread (ADR 019).
            WakeOnArrival,
            // A retired hob's work fails as blockers that wait for you (IN-007).
            BlockOnRetirement,
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
      // Before approvals, so a decision can save grants and every call reads the hob's live ones.
      .pipe(Layer.provideMerge(GrantService.layer))
      .pipe(Layer.provideMerge(HobToolsLive))
      // Before the chat service, whose turns offer it; after the database, which keeps its call records.
      .pipe(Layer.provideMerge(Layer.merge(Charms, CharmCallService.layer)))
      // Before any request, so every hob's hidden folders compare against canonical shared folders.
      .pipe(Layer.provideMerge(CanonicalSharedFolders))
      .pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Persistence,
            EventBus.layer,
            HobAdmission.layer,
            NodeFolderChecks,
            Runtime,
            identity,
            // The hub's credentials, provider keys included, are redacted by value from what tools report.
            SecretRedaction.layer(secretsFromEnv(process.env)),
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
            WebClientRoutes(config.webDir),
            OwnHostsOnly,
            KnownTailnetPeersOnly,
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
        ),
      ),
      Layer.provideMerge(RemoteAccessLive(dataDir).pipe(Layer.provideMerge(HubListenersLive(server, port)))),
      Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port })),
      Layer.provide(Layer.mergeAll(App, Remote, Tailnet)),
    );
  }),
);

Layer.launch(ServerLive).pipe(
  // HOBBOTS_LOG_LEVEL sets the least severe line the hub writes; Debug adds routine reads.
  Effect.provideServiceEffect(
    References.MinimumLogLevel,
    Effect.map(ServerConfig, (config) => config.logLevel),
  ),
  NodeRuntime.runMain,
);
