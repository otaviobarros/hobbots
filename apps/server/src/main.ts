import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { ChatService, HobAdmission, HobLifecycle, HobService, PermissionSummary } from "@hobbots/agents";
import { PolicyEngine } from "@hobbots/permissions";
import { EventJournal, HobbotsRepositoryLive, SearchIndex, SetupRepository, SqliteLive } from "@hobbots/persistence";
import { ClaudeCodeLayer, FakeRuntimeLayer, ProcessSandbox } from "@hobbots/runtimes";
import { Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { ServerConfig } from "./config.ts";
import { EventBus } from "./event-bus.ts";
import { EventStream, EventStreamRoute } from "./event-stream.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "./folders.ts";
import { ApiRoutes } from "./http.ts";
import { ensureInstallationId, Installation } from "./installation.ts";
import { JournalCompaction } from "./journal-compaction.ts";
import { IPv6Loopback } from "./loopback.ts";
import { StopWithoutWaitingForClients } from "./shutdown.ts";
import { HobToolsLive } from "./tools.ts";
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
    const Persistence = Layer.mergeAll(
      HobbotsRepositoryLive,
      EventJournal.layer,
      SetupRepository.layer,
      SearchIndex.sqliteWorker(database),
    ).pipe(Layer.provideMerge(SqliteLive(database)));
    // One policy engine for the hub, so its index of the folders' Git repositories is built once.
    const Runtime = (
      config.runtime === "fake"
        ? FakeRuntimeLayer({ delay: "40 millis", stopDelay: "600 millis", availability: config.fakeAvailability })
        : ClaudeCodeLayer({
            workspaceDir: join(config.dataDir, "workspaces", "default"),
            executable: Option.getOrUndefined(config.claudeExecutable),
          }).pipe(Layer.provide(ProcessSandbox.layer))
    ).pipe(Layer.provide(PolicyEngine.node));
    const App = HobLifecycle.layer
      .pipe(
        Layer.provideMerge(
          Layer.mergeAll(EventStream.layer, HobService.layer, PermissionSummary.layer, JournalCompaction),
        ),
      )
      .pipe(Layer.provideMerge(ChatService.layer))
      .pipe(Layer.provideMerge(HobToolsLive))
      // Before any request, so every hob's hidden folders compare against canonical shared folders.
      .pipe(Layer.provideMerge(CanonicalSharedFolders))
      .pipe(
        Layer.provideMerge(
          Layer.mergeAll(Persistence, EventBus.layer, HobAdmission.layer, NodeFolderChecks, Runtime, identity),
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
    return StopWithoutWaitingForClients(server).pipe(
      Layer.provideMerge(
        HttpRouter.serve(
          Layer.mergeAll(
            ApiRoutes,
            EventStreamRoute,
            WebClientRoutes(config.webDir),
            LoopbackHostOnly,
            HttpRouter.cors({ allowedOrigins: config.allowedOrigins }),
          ),
        ),
      ),
      Layer.provide(App),
      Layer.provideMerge(IPv6Loopback(server, config.port)),
      Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port: config.port })),
    );
  }),
);

Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
