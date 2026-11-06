import { ConnectedGitHubUser, UserGitIdentity } from "@hobbots/agents";
import { GitHubApi } from "@hobbots/charms";
import { userGitIdentity } from "@hobbots/runtimes";
import { Effect, Layer, Option } from "effect";

/**
 * Where the hub reads who hobs commit as when it asks you (#741): your own Git config, and your
 * connected GitHub account. Which questions to ask, and when, is the agents package's.
 */

/** Your Git config's name and email, from the config files under `home`, read anew each time. */
export const UserGitIdentityLive = (home: string) =>
  Layer.succeed(UserGitIdentity, UserGitIdentity.of({ read: Effect.sync(() => userGitIdentity(home)) }));

// How long a turn waits on GitHub to offer your account, before it asks without it.
const GITHUB_WAIT = "5 seconds";

/** Your connected GitHub account, read through the GitHub Charm's API when the hub has it (ADR 020). */
export const ConnectedGitHubUserLive = Layer.effect(
  ConnectedGitHubUser,
  Effect.gen(function* () {
    const api = Option.getOrUndefined(yield* Effect.serviceOption(GitHubApi));
    return ConnectedGitHubUser.of({
      get: (agentId) =>
        api === undefined
          ? Effect.succeed(null)
          : api.user(agentId).pipe(
              Effect.timeout(GITHUB_WAIT),
              Effect.catchCause(() => Effect.succeed(null)),
            ),
    });
  }),
);
