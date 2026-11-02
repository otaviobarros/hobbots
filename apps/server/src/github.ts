import { GitHubConnectFailed, type GitHubStatus, GitHubUnreachable, HobbotsApi } from "@hobbots/api";
import { GitHubConnection } from "@hobbots/charms";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/** What a hub without the GitHub Charm, as in tests, answers: no app to connect through. */
const NO_APP: GitHubStatus = { _tag: "Disconnected", problem: null, cannotConnect: "no-app" };

// Settings › Charms › GitHub: the connected account, the device flow and disconnecting (ADR 020).
export const GitHubHandlers = HttpApiBuilder.group(HobbotsApi, "github", (handlers) =>
  Effect.gen(function* () {
    const found = yield* Effect.serviceOption(GitHubConnection);
    if (Option.isNone(found)) {
      const absent = new GitHubConnectFailed({ reason: "no-app", message: "This hub does not connect GitHub." });
      return handlers.handleAll({
        status: () => Effect.succeed(NO_APP),
        found: () => Effect.succeed([]),
        use: () => Effect.fail(absent),
        connect: () => Effect.fail(absent),
        cancel: () => Effect.succeed(NO_APP),
        disconnect: () => Effect.succeed(NO_APP),
        repositories: () => Effect.fail(new GitHubUnreachable({ message: absent.message })),
      });
    }
    const connection = found.value;
    return handlers.handleAll({
      status: () => connection.state,
      connect: () =>
        connection.connect.pipe(
          Effect.mapError((refused) => new GitHubConnectFailed({ reason: refused.reason, message: refused.message })),
        ),
      found: () => connection.found,
      use: ({ payload }) =>
        connection
          .use(payload.source)
          .pipe(
            Effect.mapError((refused) => new GitHubConnectFailed({ reason: refused.reason, message: refused.message })),
          ),
      cancel: () => connection.cancel,
      disconnect: () => connection.disconnect,
      repositories: () =>
        connection.repositories.pipe(
          Effect.map((repositories) => ({ repositories, installUrl: connection.installUrl })),
          Effect.mapError((error) => new GitHubUnreachable({ message: error.message })),
        ),
    });
  }),
);
