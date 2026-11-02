import { AgentId } from "@hobbots/domain";
import { Effect, Fiber, Layer, Redacted } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { GitHubApi, GitHubApiLive, GitHubCredential } from "../src/index.ts";

const TOKEN = "ghu_apiwrites0123456789abcdefghijklmnopqrstu";
const hob = AgentId.make("hob");
const repository = { owner: "octo", name: "app" };

/** One answer the fake GitHub gives: a status and body, or a failure before any answer. */
type Answer =
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  /** Headers at once, then a body that never ends. */
  | { readonly stalls: number }
  | { readonly fails: unknown };

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly auth: string | undefined;
  readonly body: unknown;
}

/** GitHub's API answering each request with the next of `answers`, and the hub's credential, recorded. */
const run = <A>(
  answers: ReadonlyArray<Answer>,
  use: (api: GitHubApi["Service"]) => Effect.Effect<A, unknown, TestClock.TestClock>,
) => {
  const seen: Array<Seen> = [];
  const credential: Array<string> = [];
  const queue = [...answers];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : null;
        seen.push({ method: request.method, url: url.toString(), auth: request.headers.authorization, body });
        const answer = queue.shift() ?? { status: 500 };
        if ("fails" in answer) {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: answer.fails }),
          });
        }
        if ("stalls" in answer) {
          return HttpClientResponse.fromWeb(
            request,
            new Response(new ReadableStream({ start: () => {} }), { status: answer.stalls }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
            status: answer.status,
            headers: answer.headers ?? {},
          }),
        );
      }),
    ),
  );
  const signIn = Layer.succeed(
    GitHubCredential,
    GitHubCredential.of({
      connected: Effect.succeed(true),
      tokenFor: () => Effect.succeed(Redacted.make(TOKEN)),
      refused: () => Effect.sync(() => credential.push("refused")).pipe(Effect.as(Redacted.make(`${TOKEN}2`))),
      revoked: () => Effect.sync(() => void credential.push("revoked")),
      reaches: () => Effect.void,
      onRepository: (_agentId, _repository, effect) => effect,
    }),
  );
  return Effect.gen(function* () {
    return yield* use(yield* GitHubApi);
  }).pipe(
    Effect.provide(GitHubApiLive.pipe(Layer.provide(http), Layer.provide(signIn))),
    Effect.provide(Layer.fresh(TestClock.layer())),
    Effect.runPromise,
    (result) => result.then((value) => ({ value, seen, credential })),
  );
};

const PULL = { number: 5, html_url: "https://github.com/octo/app/pull/5", user: { login: "me" }, created_at: "t" };
const NEW_PULL = { head: "feat/x", base: "main", title: "T", body: "B", draft: true };
const refusedConnection = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });

describe("GitHub API writes", () => {
  // covers EX-004, PE-005
  it("[TC-GEN-041] tells a write's ends apart: done, refused, not sent, rate limited and uncertain", async () => {
    const done = await run([{ status: 201, body: PULL }], (api) => api.openPullRequest(hob, repository, NEW_PULL));
    expect(done.value).toEqual({
      _tag: "Done",
      value: { number: 5, url: "https://github.com/octo/app/pull/5", author: "me", createdAt: "t" },
    });
    expect(done.seen).toEqual([
      { method: "POST", url: "https://api.github.com/repos/octo/app/pulls", auth: `Bearer ${TOKEN}`, body: NEW_PULL },
    ]);

    const refused = await run(
      [{ status: 422, body: { message: "Validation Failed", errors: [{ message: "A pull request already exists" }] } }],
      (api) => api.openPullRequest(hob, repository, NEW_PULL),
    );
    expect(refused.value).toEqual({
      _tag: "Refused",
      message: "GitHub refused it (422): Validation Failed: A pull request already exists",
    });

    const notSent = await run([{ fails: refusedConnection }], (api) => api.comment(hob, repository, 7, "Hi"));
    expect(notSent.value).toMatchObject({ _tag: "NotSent" });
    expect(notSent.seen).toHaveLength(1);

    const limited = await run(
      [{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }],
      (api) => api.comment(hob, repository, 7, "Hi"),
    );
    expect(limited.value).toMatchObject({
      _tag: "RateLimited",
      message: expect.stringContaining("2027-01-15T08:00:00"),
    });

    for (const answer of [{ status: 502 }, { fails: new Error("socket hang up") }, { status: 201, body: "{cut" }]) {
      const uncertain = await run([answer], (api) => api.comment(hob, repository, 7, "Hi"));
      expect(uncertain.value).toMatchObject({ _tag: "Uncertain" });
      expect(uncertain.seen).toHaveLength(1);
    }
  });

  // covers EX-003, EX-004
  it("[TC-GEN-045] leaves a write uncertain when GitHub sends its headers and then never ends the body", async () => {
    const stalled = await run([{ stalls: 201 }], (api) =>
      Effect.gen(function* () {
        const writing = yield* api.comment(hob, repository, 7, "Hi").pipe(Effect.forkChild);
        yield* TestClock.adjust("31 seconds");
        return yield* Fiber.join(writing);
      }),
    );
    expect(stalled.value).toMatchObject({ _tag: "Uncertain" });
    expect(stalled.seen).toHaveLength(1);
  });

  // covers PE-005, EX-004
  it("[TC-GEN-042] sends once more with a refreshed token after a 401, and disconnects GitHub after a second", async () => {
    const comment = { html_url: "https://github.com/octo/app/issues/7#c1", user: { login: "me" }, body: "Hi" };
    const refreshed = await run([{ status: 401 }, { status: 201, body: comment }], (api) =>
      api.comment(hob, repository, 7, "Hi"),
    );
    expect(refreshed.value).toMatchObject({ _tag: "Done", value: { url: comment.html_url } });
    expect(refreshed.seen.map((s) => s.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}2`]);
    expect(refreshed.credential).toEqual(["refused"]);

    const disconnected = await run([{ status: 401 }, { status: 401 }], (api) => api.comment(hob, repository, 7, "Hi"));
    expect(disconnected.value).toMatchObject({ _tag: "NotSent", message: expect.stringContaining("disconnected") });
    expect(disconnected.credential).toEqual(["refused", "revoked"]);
  });

  // covers EX-003
  it("[TC-GEN-043] reads back pull requests in every state from one head, and comments since a call page by page", async () => {
    const pulls = await run([{ status: 200, body: [PULL] }], (api) =>
      api.pullRequests(hob, repository, "feat/x", "main"),
    );
    expect(pulls.value).toEqual([{ number: 5, url: PULL.html_url, author: "me", createdAt: "t" }]);
    const url = new URL(pulls.seen[0]?.url ?? "");
    expect(url.pathname).toBe("/repos/octo/app/pulls");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ head: "octo:feat/x", base: "main", state: "all" });

    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ html_url: `c${i}`, user: { login: "me" }, body: `b${i}` }));
    const comments = await run(
      [
        { status: 200, body: page(100) },
        { status: 200, body: page(3) },
      ],
      (api) => api.commentsSince(hob, repository, 7, "2026-11-02T00:00:00.000Z"),
    );
    expect(comments.value).toHaveLength(103);
    expect(comments.seen.map((s) => new URL(s.url).searchParams.get("page"))).toEqual(["1", "2"]);
    expect(new URL(comments.seen[0]?.url ?? "").searchParams.get("since")).toBe("2026-11-02T00:00:00.000Z");
  });

  // covers PE-006, EX-003
  it("[TC-GEN-044] hides the hub's call markers from what a hob reads of an issue and its comments", async () => {
    const marker = "<!-- hobbots-call: 0f0f0f0f-0000-0000-0000-000000000000 -->";
    const read = await run(
      [
        {
          status: 200,
          body: {
            number: 7,
            title: "Bug",
            state: "open",
            user: null,
            updated_at: "t",
            html_url: "u",
            body: `Body.${marker}`,
            labels: [],
            comments: 1,
          },
        },
        { status: 200, body: [{ user: { login: "me" }, created_at: "t", body: `Done.\n\n${marker}` }] },
      ],
      (api) => api.item(hob, repository, 7, 5),
    );
    expect(JSON.stringify(read.value)).not.toContain("hobbots-call");
    expect(read.value).toMatchObject({ body: "Body.", comments: [{ body: "Done.\n\n" }] });
  });
});
