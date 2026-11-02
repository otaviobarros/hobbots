import type { AgentId } from "@hobbots/domain";
import {
  type GitHubComment,
  type GitHubItem,
  type GitHubItemSummary,
  type GitHubRepository,
  type GitHubRepositoryInfo,
  type GitHubSearchResult,
  repositorySlug,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { GitHubCredential } from "./github-account.ts";
import { GitHubError } from "./github-error.ts";

export { GitHubError };

/**
 * GitHub's REST API, read on the hub with the GitHub account the user connected (#317, #322). Each
 * read asks `GitHubCredential` for the hob's token. The token never leaves the hub: it is not in the
 * sandbox, the database, the browser or any answer a hob reads.
 */

export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    readonly repository: (
      agentId: AgentId,
      repository: GitHubRepository,
    ) => Effect.Effect<GitHubRepositoryInfo, GitHubError>;
    /** Searches issues and pull requests with a query the hub built (`githubSearchQuery`). */
    readonly search: (agentId: AgentId, query: string, limit: number) => Effect.Effect<GitHubSearchResult, GitHubError>;
    readonly item: (
      agentId: AgentId,
      repository: GitHubRepository,
      number: number,
      comments: number,
    ) => Effect.Effect<GitHubItem, GitHubError>;
    /** The commit a branch on GitHub points to, or null when the branch is not there (#323). */
    readonly branchHead: (
      agentId: AgentId,
      repository: GitHubRepository,
      branch: string,
    ) => Effect.Effect<string | null, GitHubError>;
    /** The login the hob's sign-in acts as, which a push card shows. */
    readonly viewer: (agentId: AgentId) => Effect.Effect<string, GitHubError>;
    /** Pull requests in any state from `head` into `base` of the same repository, newest first (#324). */
    readonly pullRequests: (
      agentId: AgentId,
      repository: GitHubRepository,
      head: string,
      base: string,
    ) => Effect.Effect<ReadonlyArray<GitHubPullRequest>, GitHubError>;
    /** Comments on an issue or pull request updated at or after `since`, oldest first (#324). */
    readonly commentsSince: (
      agentId: AgentId,
      repository: GitHubRepository,
      number: number,
      since: string,
    ) => Effect.Effect<ReadonlyArray<GitHubPostedComment>, GitHubError>;
    /** Opens a pull request inside the repository; never retried here (#324). */
    readonly openPullRequest: (
      agentId: AgentId,
      repository: GitHubRepository,
      pullRequest: NewPullRequest,
    ) => Effect.Effect<GitHubWrite<GitHubPullRequest>>;
    /** Adds one comment to an issue or pull request; never retried here (#324). */
    readonly comment: (
      agentId: AgentId,
      repository: GitHubRepository,
      number: number,
      body: string,
    ) => Effect.Effect<GitHubWrite<GitHubPostedComment>>;
  }
>()("@hobbots/charms/GitHubApi") {}

/** A pull request as reading one back needs it. */
export interface GitHubPullRequest {
  readonly number: number;
  readonly url: string;
  readonly author: string | null;
  readonly createdAt: string;
}

/** A comment as reading one back needs it: the body is GitHub's raw Markdown, hidden markers included. */
export interface GitHubPostedComment {
  readonly url: string;
  readonly author: string | null;
  readonly body: string;
}

export interface NewPullRequest {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

/**
 * How one write request ended, told apart as ADR 020 needs: done, refused by GitHub, never sent,
 * refused for the sign-in (so nothing was done), rate limited, or uncertain, when it may have taken
 * effect. The caller decides what to try again.
 */
export type GitHubWrite<A> =
  | { readonly _tag: "Done"; readonly value: A }
  | { readonly _tag: "Refused"; readonly message: string }
  | { readonly _tag: "NotSent"; readonly message: string }
  | { readonly _tag: "SignedOut" }
  | { readonly _tag: "RateLimited"; readonly message: string }
  | { readonly _tag: "Uncertain"; readonly message: string };

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
const CommentsJson = Schema.Array(
  Schema.Struct({ user: User, created_at: Schema.String, body: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
);

const RefJson = Schema.Struct({ ref: Schema.String, object: Schema.Struct({ sha: Schema.String }) });
const PullRequestJson = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  user: User,
  created_at: Schema.String,
});
const PostedCommentJson = Schema.Struct({
  html_url: Schema.String,
  user: User,
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const pullRequestOf = (json: typeof PullRequestJson.Type): GitHubPullRequest => ({
  number: json.number,
  url: json.html_url,
  author: json.user?.login ?? null,
  createdAt: json.created_at,
});
const postedCommentOf = (json: typeof PostedCommentJson.Type): GitHubPostedComment => ({
  url: json.html_url,
  author: json.user?.login ?? null,
  body: json.body ?? "",
});

/** The pages of comments reading back looks through: 1,000 comments since the call, far more than a thread gets in minutes. */
const COMMENT_PAGES = 10;

/**
 * Failures that happen before a request leaves the hub: the name did not resolve, or nothing took the
 * connection. Anything else, a reset or a timeout included, may have reached GitHub.
 */
const NOT_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Whether a failed request surely never reached GitHub, from the error codes in its causes. */
const neverSent = (error: unknown): boolean => {
  let cause: unknown = error;
  for (let depth = 0; depth < 6 && cause !== null && typeof cause === "object"; depth++) {
    const { code } = cause as { readonly code?: unknown };
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return true;
    cause = (cause as { readonly cause?: unknown }).cause;
  }
  return false;
};

/** Whether GitHub answered that the sign-in's rate limit is used up (GitHub's REST API docs). */
const rateLimited = (response: HttpClientResponse.HttpClientResponse) =>
  response.status === 429 ||
  (response.status === 403 &&
    (response.headers["x-ratelimit-remaining"] === "0" || response.headers["retry-after"] !== undefined));

/** When to try again, in words, from GitHub's `retry-after` or `x-ratelimit-reset` header. */
const retryText = (response: HttpClientResponse.HttpClientResponse): string => {
  const after = Number(response.headers["retry-after"]);
  if (Number.isFinite(after) && after > 0)
    return ` Try again in ${Math.ceil(after / 60)} minute${after > 60 ? "s" : ""}.`;
  const reset = Number(response.headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) return ` Try again after ${new Date(reset * 1000).toISOString()}.`;
  return " Try again in a few minutes.";
};

const ErrorJson = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(
    Schema.Array(Schema.Union([Schema.String, Schema.Struct({ message: Schema.optionalKey(Schema.String) })])),
  ),
});

/** GitHub's reason for a refusal in its own words, cut short, or its status alone. */
const refusalText = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(ErrorJson)(response).pipe(
    Effect.map((json) => {
      const details = (json.errors ?? []).flatMap((e) => {
        const text = typeof e === "string" ? e : e.message;
        return text === undefined ? [] : [text];
      });
      const words = [json.message, ...details].filter((w) => w !== undefined && w !== "").join(": ");
      return words === ""
        ? `GitHub refused it (${response.status}).`
        : `GitHub refused it (${response.status}): ${words.slice(0, 500)}`;
    }),
    Effect.orElseSucceed(() => `GitHub refused it (${response.status}).`),
  );
const ViewerJson = Schema.Struct({ login: Schema.String });

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

/** GitHub's REST API over `fetch`, signed in as the hob's GitHub credential. */
export const GitHubApiLive = Layer.effect(
  GitHubApi,
  Effect.gen(function* () {
    const credential = yield* GitHubCredential;
    const http = yield* HttpClient.HttpClient;

    const send = (token: Redacted.Redacted<string>, path: string, params: Record<string, string>, what: string) =>
      http
        .execute(
          HttpClientRequest.get(`${API}${path}`, { urlParams: params }).pipe(
            HttpClientRequest.bearerToken(Redacted.value(token)),
            HttpClientRequest.setHeaders({
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "Hobbots",
            }),
          ),
        )
        .pipe(
          Effect.timeout("20 seconds"),
          Effect.mapError(() => new GitHubError({ reason: "failed", message: `GitHub did not answer for ${what}.` })),
        );

    const read = <S extends Schema.Constraint>(
      agentId: AgentId,
      path: string,
      schema: S,
      what: string,
      params: Record<string, string> = {},
    ): Effect.Effect<S["Type"], GitHubError, S["DecodingServices"]> =>
      Effect.gen(function* () {
        const token = yield* credential.tokenFor(agentId);
        let response = yield* send(token, path, params, what);
        // A refused token is refreshed once and the read tried again; refused again, GitHub is disconnected.
        if (response.status === 401) {
          const fresh = yield* credential.refused(agentId, token);
          response = yield* send(fresh, path, params, what);
          if (response.status === 401) {
            yield* credential.revoked(fresh);
            return yield* new GitHubError({
              reason: "signed-out",
              message:
                "GitHub is disconnected: it no longer accepts the hub's sign-in. Connect GitHub again in Settings › Charms.",
            });
          }
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

    // Each part of a branch name is encoded on its own, so `feat/x` stays a path GitHub reads.
    const refPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

    /**
     * One write request, classified as ADR 020 tells writes apart. Never sent twice here: a 401 means
     * GitHub did nothing, and the caller refreshes the sign-in and decides whether to send again.
     */
    const write = <S extends Schema.Constraint>(
      token: Redacted.Redacted<string>,
      path: string,
      body: Record<string, unknown>,
      schema: S,
    ): Effect.Effect<GitHubWrite<S["Type"]>, never, S["DecodingServices"]> =>
      http
        .execute(
          HttpClientRequest.post(`${API}${path}`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(token)),
            HttpClientRequest.setHeaders({
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "Hobbots",
            }),
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        )
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.matchEffect({
            onFailure: (error): Effect.Effect<GitHubWrite<S["Type"]>> =>
              Effect.succeed(
                neverSent(error)
                  ? { _tag: "NotSent", message: "The hub could not reach GitHub, so nothing was sent." }
                  : { _tag: "Uncertain", message: "GitHub did not answer in time, or the connection dropped." },
              ),
            onSuccess: (response): Effect.Effect<GitHubWrite<S["Type"]>, never, S["DecodingServices"]> => {
              if (response.status === 401) return Effect.succeed({ _tag: "SignedOut" });
              if (rateLimited(response)) {
                return Effect.succeed({
                  _tag: "RateLimited",
                  message: `GitHub's rate limit for the hub's sign-in is used up, so nothing was sent.${retryText(response)}`,
                });
              }
              if (response.status >= 500) {
                return Effect.succeed({ _tag: "Uncertain", message: `GitHub answered ${response.status}.` });
              }
              if (response.status < 200 || response.status >= 300) {
                return refusalText(response).pipe(Effect.map((message) => ({ _tag: "Refused", message }) as const));
              }
              // GitHub took it, but an answer that cannot be read does not say what was made.
              return HttpClientResponse.schemaBodyJson(schema)(response).pipe(
                Effect.match({
                  onFailure: () =>
                    ({ _tag: "Uncertain", message: "GitHub's answer was cut off or not as expected." }) as const,
                  onSuccess: (value) => ({ _tag: "Done", value }) as const,
                }),
              );
            },
          }),
        );

    /** A write with the hob's token, sent once more with a refreshed token when GitHub refused the sign-in. */
    const signedWrite = <S extends Schema.Constraint>(
      agentId: AgentId,
      path: string,
      body: Record<string, unknown>,
      schema: S,
    ): Effect.Effect<GitHubWrite<S["Type"]>, never, S["DecodingServices"]> =>
      Effect.gen(function* () {
        const disconnected = {
          _tag: "NotSent",
          message:
            "GitHub is disconnected: it no longer accepts the hub's sign-in. Connect GitHub again in Settings › Charms.",
        } as const;
        const token = yield* credential.tokenFor(agentId).pipe(Effect.option);
        if (Option.isNone(token)) return disconnected;
        const first = yield* write(token.value, path, body, schema);
        if (first._tag !== "SignedOut") return first;
        // A 401 means GitHub did nothing, so sending once more with a refreshed token cannot send it twice.
        const fresh = yield* credential.refused(agentId, token.value).pipe(Effect.option);
        if (Option.isNone(fresh)) return disconnected;
        const again = yield* write(fresh.value, path, body, schema);
        if (again._tag !== "SignedOut") return again;
        yield* credential.revoked(fresh.value);
        return disconnected;
      });

    return GitHubApi.of({
      openPullRequest: (agentId, repository, pullRequest) =>
        signedWrite(agentId, `/repos/${repositorySlug(repository)}/pulls`, { ...pullRequest }, PullRequestJson).pipe(
          Effect.map((result) => (result._tag === "Done" ? { ...result, value: pullRequestOf(result.value) } : result)),
        ),
      comment: (agentId, repository, number, body) =>
        signedWrite(
          agentId,
          `/repos/${repositorySlug(repository)}/issues/${number}/comments`,
          { body },
          PostedCommentJson,
        ).pipe(
          Effect.map((result) =>
            result._tag === "Done" ? { ...result, value: postedCommentOf(result.value) } : result,
          ),
        ),
      pullRequests: (agentId, repository, head, base) =>
        read(
          agentId,
          `/repos/${repositorySlug(repository)}/pulls`,
          Schema.Array(PullRequestJson),
          `pull requests from ${head} into ${base}`,
          // GitHub matches the head as `owner:branch`; pull requests across forks are out of scope.
          {
            head: `${repository.owner}:${head}`,
            base,
            state: "all",
            sort: "created",
            direction: "desc",
            per_page: "30",
          },
        ).pipe(Effect.map((list) => list.map(pullRequestOf))),
      commentsSince: (agentId, repository, number, since) =>
        Effect.gen(function* () {
          const found: Array<GitHubPostedComment> = [];
          for (let page = 1; page <= COMMENT_PAGES; page++) {
            const list = yield* read(
              agentId,
              `/repos/${repositorySlug(repository)}/issues/${number}/comments`,
              Schema.Array(PostedCommentJson),
              `the comments on #${number}`,
              { since, per_page: "100", page: String(page) },
            );
            found.push(...list.map(postedCommentOf));
            if (list.length < 100) break;
          }
          return found;
        }),
      branchHead: (agentId, repository, branch) =>
        read(
          agentId,
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
      viewer: (agentId) =>
        read(agentId, "/user", ViewerJson, "the account the hub signs in as").pipe(Effect.map((json) => json.login)),
      repository: (agentId, repository) =>
        read(
          agentId,
          `/repos/${repositorySlug(repository)}`,
          RepositoryJson,
          `repository ${repositorySlug(repository)}`,
        ).pipe(
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
      search: (agentId, query, limit) =>
        read(agentId, "/search/issues", SearchJson, "this search", {
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
      item: (agentId, repository, number, comments) =>
        Effect.gen(function* () {
          const slug = repositorySlug(repository);
          const what = `issue or pull request #${number} in ${slug}`;
          const json = yield* read(agentId, `/repos/${slug}/issues/${number}`, FullItemJson, what);
          const thread =
            comments === 0 || json.comments === 0
              ? []
              : yield* read(
                  agentId,
                  `/repos/${slug}/issues/${number}/comments`,
                  CommentsJson,
                  `the comments on #${number}`,
                  {
                    per_page: String(comments),
                  },
                );
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
