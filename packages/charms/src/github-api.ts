import {
  type GitHubComment,
  type GitHubItem,
  type GitHubItemSummary,
  type GitHubRepository,
  type GitHubRepositoryInfo,
  type GitHubSearchResult,
  repositorySlug,
} from "@hobbots/domain";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * GitHub's REST API, read on the hub with the user's own sign-in (#317). The token never leaves the
 * hub: it is not in the sandbox, the database, the browser or any answer a hob reads.
 */

/** Why a read failed, in words for the hob and the person. */
export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  reason: Schema.Literals(["signed-out", "not-found", "rate-limited", "failed"]),
  message: Schema.String,
}) {}

export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    readonly repository: (repository: GitHubRepository) => Effect.Effect<GitHubRepositoryInfo, GitHubError>;
    /** Searches issues and pull requests with a query the hub built (`githubSearchQuery`). */
    readonly search: (query: string, limit: number) => Effect.Effect<GitHubSearchResult, GitHubError>;
    readonly item: (
      repository: GitHubRepository,
      number: number,
      comments: number,
    ) => Effect.Effect<GitHubItem, GitHubError>;
    /** The commit a branch is at on GitHub, or null when there is no such branch. */
    readonly branchHead: (repository: GitHubRepository, branch: string) => Effect.Effect<string | null, GitHubError>;
    /** The login of the account the hub signs in with. */
    readonly viewer: Effect.Effect<string, GitHubError>;
  }
>()("@hobbots/charms/GitHubApi") {}

/** Where the hub finds the user's GitHub token, read again for every call so a new sign-in applies. */
export class GitHubToken extends Context.Service<
  GitHubToken,
  { readonly get: Effect.Effect<Redacted.Redacted<string>, GitHubError> }
>()("@hobbots/charms/GitHubToken") {
  /**
   * The hub's own `GH_TOKEN` or `GITHUB_TOKEN`, else what `gh auth token` prints for github.com. Both
   * are read on the hub, outside the sandbox, where the user signed in.
   */
  static readonly layer = (env: NodeJS.ProcessEnv) =>
    Layer.effect(
      GitHubToken,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fromEnv = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
        const signedOut = new GitHubError({
          reason: "signed-out",
          message: "The hub is not signed in to GitHub. Run `gh auth login` on the hub, then try again.",
        });
        const fromGh = spawner
          .string(ChildProcess.make("gh", ["auth", "token", "--hostname", "github.com"], { env: ghEnv(env) }))
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.map((out) => out.trim()),
            Effect.filterOrFail(
              (token) => /^[A-Za-z0-9_]{20,255}$/.test(token),
              () => signedOut,
            ),
            Effect.mapError(() => signedOut),
          );
        return GitHubToken.of({
          get: fromEnv ? Effect.succeed(Redacted.make(fromEnv)) : Effect.map(fromGh, (token) => Redacted.make(token)),
        });
      }),
    );
}

/** What `gh` runs with: where it finds its own config and the keychain, and nothing a hob set. */
const ghEnv = (env: NodeJS.ProcessEnv): Record<string, string | undefined> => ({
  PATH: env.PATH,
  HOME: env.HOME,
  USER: env.USER,
  XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
  GH_CONFIG_DIR: env.GH_CONFIG_DIR,
  // On Linux, gh keeps its token in the Secret Service keyring, reached over the session bus.
  DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
  XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
  // No prompts, no update checks and no pager on the hub.
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PAGER: "",
});

// What GitHub answers, in the fields read. Bodies can be null; long text is cut for the hob's context.
const User = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const RepositoryJson = Schema.Struct({
  full_name: Schema.String,
  description: Schema.NullOr(Schema.String),
  default_branch: Schema.String,
  visibility: Schema.optionalKey(Schema.String),
  private: Schema.Boolean,
  html_url: Schema.String,
  open_issues_count: Schema.Number,
});
const PullRequestLink = Schema.optionalKey(
  Schema.Struct({ merged_at: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
);
const ItemJson = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  user: User,
  updated_at: Schema.String,
  pull_request: PullRequestLink,
});
const SearchJson = Schema.Struct({ total_count: Schema.Number, items: Schema.Array(ItemJson) });
const FullItemJson = Schema.Struct({
  ...ItemJson.fields,
  html_url: Schema.String,
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  labels: Schema.Array(Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })])),
  comments: Schema.Number,
});
const RefJson = Schema.Struct({ ref: Schema.String, object: Schema.Struct({ sha: Schema.String }) });
const ViewerJson = Schema.Struct({ login: Schema.String });
const CommentsJson = Schema.Array(
  Schema.Struct({ user: User, created_at: Schema.String, body: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
);

/** The longest body or comment a hob reads, so one long thread does not fill its context. */
export const MAX_TEXT = 4000;

const cut = (text: string | null | undefined) => {
  const value = text ?? "";
  return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}\n[Cut at ${MAX_TEXT} characters.]`;
};

const summary = (item: typeof ItemJson.Type): GitHubItemSummary => ({
  number: item.number,
  title: item.title,
  // GitHub reports a merged pull request as closed.
  state: item.pull_request?.merged_at ? "merged" : item.state,
  author: item.user?.login ?? null,
  updatedAt: item.updated_at,
});

const API = "https://api.github.com";

/** GitHub's REST API over `fetch`, signed in with the hub's token. */
export const GitHubApiLive = Layer.effect(
  GitHubApi,
  Effect.gen(function* () {
    const token = yield* GitHubToken;
    const http = yield* HttpClient.HttpClient;

    const read = <S extends Schema.Constraint>(
      path: string,
      schema: S,
      what: string,
      params: Record<string, string> = {},
    ): Effect.Effect<S["Type"], GitHubError, S["DecodingServices"]> =>
      Effect.gen(function* () {
        const signIn = yield* token.get;
        const request = HttpClientRequest.get(`${API}${path}`, { urlParams: params }).pipe(
          HttpClientRequest.bearerToken(Redacted.value(signIn)),
          HttpClientRequest.setHeaders({
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Hobbots",
          }),
        );
        const response = yield* http.execute(request).pipe(
          Effect.timeout("20 seconds"),
          Effect.mapError(() => new GitHubError({ reason: "failed", message: `GitHub did not answer for ${what}.` })),
        );
        if (response.status === 401) {
          return yield* new GitHubError({
            reason: "signed-out",
            message:
              "GitHub refused the hub's sign-in. Sign in again with `gh auth login` on the hub, or replace the GH_TOKEN or GITHUB_TOKEN the hub was started with.",
          });
        }
        if (response.status === 404) {
          return yield* new GitHubError({
            reason: "not-found",
            message: `GitHub has no ${what}, or the hub's sign-in cannot see it.`,
          });
        }
        // A 403 is a rate limit only when GitHub says so; otherwise the sign-in may not see this, as under SAML SSO.
        const limited =
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers["x-ratelimit-remaining"] === "0" || response.headers["retry-after"] !== undefined));
        if (limited) {
          return yield* new GitHubError({
            reason: "rate-limited",
            message: "GitHub's rate limit for the hub's sign-in is used up for now. Try again in a few minutes.",
          });
        }
        // 422: GitHub cannot search a repository the sign-in does not see.
        if (response.status === 403 || response.status === 422) {
          return yield* new GitHubError({
            reason: "not-found",
            message: `GitHub refused the hub's sign-in access to ${what} (${response.status}). Its organization may need the sign-in approved.`,
          });
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* new GitHubError({
            reason: "failed",
            message: `GitHub answered ${response.status} for ${what}.`,
          });
        }
        return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError(
            () => new GitHubError({ reason: "failed", message: `GitHub's answer for ${what} was not as expected.` }),
          ),
        );
      });

    // Each part of a branch name is its own path segment, so no name reaches another endpoint.
    const refPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

    return GitHubApi.of({
      branchHead: (repository, branch) =>
        read(
          `/repos/${repositorySlug(repository)}/git/ref/heads/${refPath(branch)}`,
          RefJson,
          `branch ${branch} in ${repositorySlug(repository)}`,
        ).pipe(
          Effect.map((json) => (json.ref === `refs/heads/${branch}` ? json.object.sha : null)),
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.succeed(null),
          ),
        ),
      viewer: read("/user", ViewerJson, "the hub's own account").pipe(Effect.map((json) => json.login)),
      repository: (repository) =>
        read(`/repos/${repositorySlug(repository)}`, RepositoryJson, `repository ${repositorySlug(repository)}`).pipe(
          Effect.map(
            (json): GitHubRepositoryInfo => ({
              fullName: json.full_name,
              description: json.description,
              defaultBranch: json.default_branch,
              visibility: json.visibility ?? (json.private ? "private" : "public"),
              url: json.html_url,
              openIssuesAndPullRequests: json.open_issues_count,
            }),
          ),
        ),
      search: (query, limit) =>
        read("/search/issues", SearchJson, "this search", {
          q: query,
          sort: "updated",
          order: "desc",
          // GitHub lists at least one; a count alone drops it.
          per_page: String(Math.max(limit, 1)),
        }).pipe(
          Effect.map((json) => ({
            query,
            total: json.total_count,
            items: json.items.slice(0, limit).map(summary),
          })),
        ),
      item: (repository, number, comments) =>
        Effect.gen(function* () {
          const slug = repositorySlug(repository);
          const what = `issue or pull request #${number} in ${slug}`;
          const json = yield* read(`/repos/${slug}/issues/${number}`, FullItemJson, what);
          const thread =
            comments === 0 || json.comments === 0
              ? []
              : yield* read(`/repos/${slug}/issues/${number}/comments`, CommentsJson, `the comments on #${number}`, {
                  per_page: String(comments),
                });
          return {
            ...summary(json),
            pullRequest: json.pull_request !== undefined,
            url: json.html_url,
            body: cut(json.body),
            labels: json.labels.map((label) => (typeof label === "string" ? label : label.name)),
            commentCount: json.comments,
            comments: thread.map(
              (comment): GitHubComment => ({
                author: comment.user?.login ?? null,
                createdAt: comment.created_at,
                body: cut(comment.body),
              }),
            ),
          } satisfies GitHubItem;
        }),
    });
  }),
);

/** The API with the hub's own `fetch`. */
export const GitHubApiNode = GitHubApiLive.pipe(Layer.provide(FetchHttpClient.layer));
