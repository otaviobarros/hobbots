import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join, sep } from "node:path";
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
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
  GitHubSignInFake,
  GitHubSignInNode,
  GitRemotes,
  KeychainLive,
  KeychainMemory,
  LocalGitHubSignInsFake,
  LocalGitHubSignInsLive,
} from "@hobbots/charms";
import { secretsFromEnv } from "@hobbots/domain";
import { Dispatcher } from "@hobbots/inbox";
import { StepRunnerLive, TaskSignal, TaskTools } from "@hobbots/orchestration";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
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
import { ClaudeCodeLayer, FakeAdditionalRuntimesLayer, FakeRuntimeLayer, ProcessSandbox } from "@hobbots/runtimes";
import { Effect, Layer, Option, References } from "effect";
import { HttpRouter } from "effect/http";
import { DispatcherHostLive } from "./backpack.ts";
import { ServerConfig } from "./config.ts";
import { EventBus } from "./event-bus.ts";
import { EventStream, EventStreamRoute } from "./event-stream.ts";
import { FAKE_QUEST_STEP, FakeQuestLive } from "./fake-quest.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "./folders.ts";
import { ApiRoutes } from "./http.ts";
import { ensureInstallationId, Installation } from "./installation.ts";
import { JournalCompaction } from "./journal-compaction.ts";
import { IPv6Loopback } from "./loopback.ts";
import { QuietRoutineReads } from "./request-log.ts";
import { StopWithoutWaitingForClients } from "./shutdown.ts";
import { ToolLogsLive } from "./tool-logs.ts";
import { HobToolsLive } from "./tools.ts";
import { ClientOrigins, userSessionOrigins } from "./user-session.ts";
import { LoopbackHostOnly, WebClientRoutes } from "./web.ts";

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
      BackpackLive,
      EventJournal.layer,
      SetupRepository.layer,
      SearchIndex.sqliteWorker(database),
    ).pipe(Layer.provideMerge(Sqlite));
    // One policy engine for the hub, so its index of the folders' Git repositories is built once.
    // The fake answers for Claude Code and Codex, so a thread can switch brains (ADR 017).
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
    ).pipe(Layer.provide(PolicyEngine.node));
    // The GitHub Charm reads on the hub, outside the sandbox (#317), as the GitHub account the user
    // connected in Settings, whose tokens stay in the OS keychain (ADR 020).
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
    const Charms = GitHubCharmTools.pipe(
      Layer.provide(Layer.mergeAll(GitHubApiNode, GitRemotes.layer, PolicyEngine.node)),
      Layer.provideMerge(Account),
      Layer.provide(NodeServices.layer),
    );
    const App = HobLifecycle.layer
      .pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            EventStream.layer,
            HobService.layer,
            PermissionSummary.layer,
            JournalCompaction,
            // At start, it expires the claims an earlier process held on backpack items (ADR 019).
            Dispatcher.layer().pipe(Layer.provide(DispatcherHostLive)),
            config.runtime === "fake" && config.fakeQuest === "black-friday"
              ? FakeQuestLive(FAKE_QUEST_STEP)
              : Layer.empty,
          ),
        ),
      )
      .pipe(Layer.provideMerge(ChatService.layer))
      // Before the chat service: its turns offer the Task tools (the hub checks every call), and a
      // Task's steps run in their own sessions while the hob keeps chatting (ADR 018).
      .pipe(
        Layer.provideMerge(
          StepRunnerLive(config.stepLimits).pipe(
            Layer.provideMerge(TaskTools.layer(sep === "\\" ? "\\" : "/", config.taskLimits)),
            Layer.provideMerge(TaskSignal.layer),
          ),
        ),
      )
      // Before the chat service, so turns can ask, and after a restart the requests left pending expire.
      .pipe(Layer.provideMerge(ApprovalService.layer))
      // Before approvals, so a decision can save grants and every call reads the hob's live ones.
      .pipe(Layer.provideMerge(GrantService.layer))
      .pipe(Layer.provideMerge(HobToolsLive))
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
            Charms,
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
      `Hobbots server on http://localhost:${config.port} (runtime: ${config.runtime}, data: ${config.dataDir})`,
    );

    // Loopback only, on both IPv4 and IPv6: other machines on the network cannot connect.
    const server = createServer();
    // Each provided layer is built before the ones above it. App comes last so the server listens
    // only once the routes can answer: a request that arrives earlier is never answered.
    return StopWithoutWaitingForClients(server).pipe(
      Layer.provideMerge(
        HttpRouter.serve(
          Layer.mergeAll(
            ApiRoutes.pipe(Layer.provide(Layer.succeed(ClientOrigins, userSessionOrigins(config)))),
            EventStreamRoute,
            WebClientRoutes(config.webDir),
            LoopbackHostOnly,
            QuietRoutineReads,
            // Browsers cache a preflight for this long, in seconds (Chromium's upper limit), rather than 5.
            HttpRouter.cors({ allowedOrigins: config.allowedOrigins, maxAge: 7200 }),
          ),
        ),
      ),
      Layer.provideMerge(IPv6Loopback(server, config.port)),
      Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port: config.port })),
      Layer.provide(App),
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
