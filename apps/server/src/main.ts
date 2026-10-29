import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { HobbotsRepository, SqliteLive } from "@hobbots/persistence";
import { ClaudeCodeLayer, FakeRuntimeLayer } from "@hobbots/runtimes";
import { Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { ChatService } from "./chat.ts";
import { ServerConfig } from "./config.ts";
import { EventBus } from "./event-bus.ts";
import { ApiRoutes } from "./http.ts";
import { IPv6Loopback } from "./loopback.ts";
import { seedAgents } from "./seed.ts";
import { LoopbackHostOnly, WebClientRoutes } from "./web.ts";

const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    mkdirSync(config.dataDir, { recursive: true });

    const Persistence = HobbotsRepository.layer.pipe(
      Layer.provideMerge(SqliteLive(join(config.dataDir, "hobbots.sqlite"))),
    );
    const Seeded = Layer.effectDiscard(seedAgents).pipe(Layer.provideMerge(Persistence));
    const Runtime =
      config.runtime === "fake"
        ? FakeRuntimeLayer({ delay: "40 millis" })
        : ClaudeCodeLayer({
            workspaceDir: join(config.dataDir, "workspaces", "default"),
            executable: Option.getOrUndefined(config.claudeExecutable),
          });
    const App = ChatService.layer.pipe(Layer.provideMerge(Layer.mergeAll(Seeded, EventBus.layer, Runtime)));

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
    return HttpRouter.serve(
      Layer.mergeAll(
        ApiRoutes,
        WebClientRoutes(config.webDir),
        LoopbackHostOnly,
        HttpRouter.cors({ allowedOrigins: config.allowedOrigins }),
      ),
    ).pipe(
      Layer.provide(App),
      Layer.provideMerge(IPv6Loopback(server, config.port)),
      Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port: config.port })),
    );
  }),
);

Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
