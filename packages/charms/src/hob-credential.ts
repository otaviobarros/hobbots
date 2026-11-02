import { GitHubIdentityPin, GrantService, HobbotsRepository, HobGitHubApps } from "@hobbots/agents";
import {
  type AgentId,
  type GitHubHobAppActor,
  type GitHubRepository,
  type HobGitHubApp,
  hobAppBot,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option, type Redacted } from "effect";
import { GitHubConnection, GitHubCredential, type GitHubTokenScope } from "./github-account.ts";
import { GitHubError } from "./github-error.ts";
import { HobAppTokens } from "./hob-app-tokens.ts";

/**
 * `GitHubCredential` chosen per hob (ADR 022): the hob's own GitHub App when it has one, the user's
 * account otherwise. When the hob's app cannot act, the call fails and says why; it never runs as
 * the user instead. Wraps the account's services, so it is given `GitHubAccountLive`'s layer and
 * gives back both of them. Reads the hob's name for who acts.
 */

/** The source a call was checked under: the hob's app by its ID, or the user's account. */
interface Pinned {
  readonly agentId: AgentId;
  readonly source: number | "account";
}

const PinnedSource = Context.Reference<Pinned | null>("@hobbots/charms/PinnedHobSource", {
  defaultValue: () => null,
});

const changed = new GitHubError({
  reason: "signed-out",
  message: "The hob's GitHub sign-in changed during this call, so it did not run. Try again.",
});

const noRepository = new GitHubError({
  reason: "failed",
  message: "A hob with its own GitHub app acts on one repository at a time, and this call named none.",
});

export const GitHubCredentialPerHob = Layer.effectContext(
  Effect.gen(function* () {
    const account = yield* GitHubCredential;
    const connection = yield* GitHubConnection;
    const apps = yield* HobGitHubApps;
    const hobApps = yield* HobAppTokens;
    const grants = yield* GrantService;
    const hobs = yield* HobbotsRepository;

    /** Who acts for the hob's app: the hob by its current name, or the app's own name once the hob is gone. */
    const actorOf = (agentId: AgentId, app: HobGitHubApp) =>
      Effect.map(
        hobs.findAgent(agentId),
        (hob): GitHubHobAppActor => ({
          _tag: "HobApp",
          hob: Option.match(hob, { onNone: () => app.slug, onSome: (found) => found.name }),
          bot: hobAppBot(app),
        }),
      );

    /** The hob's app, failing when the call was checked under another source. */
    const sourceOf = (agentId: AgentId) =>
      Effect.gen(function* () {
        const app = yield* apps.get(agentId);
        const pinned = yield* PinnedSource;
        if (pinned !== null && pinned.agentId === agentId && pinned.source !== (app?.appId ?? "account")) {
          return yield* changed;
        }
        return app;
      });

    const tokenFor = (agentId: AgentId | null, scope?: GitHubTokenScope) =>
      Effect.gen(function* () {
        if (agentId === null) return yield* account.tokenFor(null, scope);
        const app = yield* sourceOf(agentId);
        if (app === null) return yield* account.tokenFor(agentId, scope);
        if (scope === undefined) return yield* noRepository;
        return yield* hobApps.token(agentId, app, scope);
      });

    const refused = (agentId: AgentId | null, token: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        if (agentId === null || !hobApps.owns(token)) return yield* account.refused(agentId, token);
        const app = yield* sourceOf(agentId);
        if (app === null) return yield* changed;
        return yield* hobApps.refused(agentId, app, token);
      });

    const reaches = (agentId: AgentId, repository: GitHubRepository) =>
      Effect.gen(function* () {
        const app = yield* sourceOf(agentId);
        if (app === null) return yield* account.reaches(agentId, repository);
        return yield* hobApps.reaches(agentId, app, repository);
      });

    const credential = GitHubCredential.of({
      connected: account.connected,
      hobApp: (agentId) =>
        Effect.flatMap(sourceOf(agentId), (app) => (app === null ? Effect.succeed(null) : actorOf(agentId, app))),
      tokenFor,
      refused,
      revoked: (token) => (hobApps.owns(token) ? hobApps.revoked(token) : account.revoked(token)),
      reaches,
      onRepository: (agentId, repository, use) =>
        Effect.gen(function* () {
          // The credential and the identity count are read together, between switches (ADR 022), so
          // a request the call asks names the identity it acts as, even while a switch is under way.
          const [app, identity] = yield* grants.exclusive(
            Effect.all([sourceOf(agentId), grants.githubIdentity(agentId)]),
          );
          const outer = yield* GitHubIdentityPin;
          const pinned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(PinnedSource, { agentId, source: app?.appId ?? "account" } satisfies Pinned),
              Effect.provideService(
                GitHubIdentityPin,
                outer !== null && outer.agentId === agentId ? outer : { agentId, identity },
              ),
            );
          if (app === null) return yield* account.onRepository(agentId, repository, pinned(use));
          yield* hobApps.reaches(agentId, app, repository);
          return yield* pinned(use);
        }),
    });

    return Context.make(GitHubCredential, credential).pipe(Context.add(GitHubConnection, connection));
  }),
);
