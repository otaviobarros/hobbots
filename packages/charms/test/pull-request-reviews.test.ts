import { Records } from "@hobbots/agents";
import {
  type Actor,
  type AgentId,
  Artifact,
  type Artifact as ArtifactRecord,
  ChapterId,
  GITHUB_ACTOR,
  type GitHubItem,
  OWNER_ACTOR,
  planPullRequestEnded,
  RegisteredArtifactId,
  ThreadId,
} from "@hobbots/domain";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { checkPullRequests, GitHubApi, GitHubCredential, GitHubError } from "../src/index.ts";

// Issue #1422: a pull request a hob delivered is reviewed once GitHub reports it merged or closed,
// asked with the sign-in of the hob that made it. One still open, one GitHub did not answer for and
// one nobody's hob made stay waiting.

const NOW = "2026-11-12T10:00:00.000Z";

const pr = (id: string, locator: string, actor: Actor = { kind: "hob", id: "ada" }) =>
  new Artifact({
    id: RegisteredArtifactId.make(id),
    threadId: ThreadId.make(`chat-${id}`),
    chapterId: ChapterId.make("chapter-1"),
    kind: "pr",
    title: locator,
    locator,
    latestVersion: 1,
    origin: { kind: "task-artifact", id: `ref-${id}` },
    actor,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
  });

/** What GitHub answers for each pull request, by number: its state, or a failure. */
const STATES: Record<number, string | "fails"> = {
  1: "merged",
  2: "closed",
  3: "open",
  4: "fails",
  5: "merged",
  6: "closed",
  7: "open",
  8: "open",
};

const item = (number: number, state: string): GitHubItem => ({
  number,
  title: `PR ${number}`,
  state,
  author: "ada",
  updatedAt: NOW,
  pullRequest: true,
  url: `https://github.com/acme/shop/pull/${number}`,
  body: "",
  labels: [],
  commentCount: 0,
  comments: [],
});

const hub = (waiting: Array<ArtifactRecord>) => {
  const asked: Array<string> = [];
  const ended: Array<string> = [];
  const records = Layer.succeed(
    Records,
    Records.of({
      recordYours: () => Effect.die("not used"),
      recordHobs: () => Effect.die("not used"),
      crossOut: () => Effect.die("not used"),
      decisionsOf: () => Effect.succeed([]),
      activeDecisions: () => Effect.succeed([]),
      artifactsOf: () => Effect.succeed([]),
      review: () => Effect.die("not used"),
      waitingPullRequests: Effect.sync(() => [...waiting]),
      pullRequestEnded: (artifactId) =>
        Effect.sync(() => {
          const index = waiting.findIndex((artifact) => artifact.id === artifactId);
          const found = waiting[index];
          const next = found === undefined ? null : planPullRequestEnded(found, NOW);
          if (next !== null) {
            waiting.splice(index, 1);
            ended.push(artifactId);
          }
          return next;
        }),
    }),
  );
  const api = Layer.succeed(GitHubApi, {
    item: (agentId: AgentId, repository: { readonly owner: string; readonly name: string }, number: number) => {
      asked.push(`${agentId} ${repository.owner}/${repository.name}#${number}`);
      const state = STATES[number];
      return state === undefined || state === "fails"
        ? Effect.fail(new GitHubError({ reason: "failed", message: "GitHub did not answer." }))
        : Effect.succeed(item(number, state));
    },
  } as unknown as GitHubApi["Service"]);
  const credential = Layer.succeed(
    GitHubCredential,
    GitHubCredential.of({
      connected: Effect.succeed(true),
      hobApp: () => Effect.succeed(null),
      tokenFor: () => Effect.succeed(Redacted.make("token")),
      refused: () => Effect.succeed(Redacted.make("token")),
      revoked: () => Effect.void,
      reaches: () => Effect.void,
      onRepository: (_agentId, _repository, use) => use,
    }),
  );
  return { layer: Layer.mergeAll(records, api, credential), asked, ended };
};

describe("pull request reviews", () => {
  // covers ADR 037 (Records)
  it("[TC-OR-1422-05] reviews each waiting pull request GitHub reports merged or closed, asking once per pull request", async () => {
    const waiting = [
      pr("merged", "https://github.com/acme/shop/pull/1"),
      // The same pull request in another camp, as its files tab: asked about once, reviewed in both.
      pr("merged-again", "https://github.com/Acme/Shop/pull/1/files", { kind: "hob", id: "quill" }),
      pr("closed", "https://github.com/acme/shop/pull/2"),
      pr("open", "https://github.com/acme/shop/pull/3"),
      pr("unanswered", "https://github.com/acme/shop/pull/4"),
      // Recorded by you, with no hob's sign-in to read it.
      pr("yours", "https://github.com/acme/shop/pull/5", OWNER_ACTOR),
      // Recorded by you first, then made by a hob too: read with the hob's sign-in, reviewed in both.
      pr("yours-first", "https://github.com/acme/shop/pull/6", OWNER_ACTOR),
      pr("hobs-later", "https://github.com/acme/shop/pull/6", { kind: "hob", id: "pip" }),
    ];
    const { layer, asked, ended } = hub(waiting);
    const round = await Effect.runPromise(checkPullRequests().pipe(Effect.provide(layer)));
    expect(asked).toEqual([
      "ada acme/shop#1",
      "ada acme/shop#2",
      "ada acme/shop#3",
      "ada acme/shop#4",
      "pip acme/shop#6",
    ]);
    expect(round.reviewed).toBe(5);
    expect(ended).toEqual(["merged", "merged-again", "closed", "yours-first", "hobs-later"]);
    expect(waiting.map((artifact) => artifact.id)).toEqual(["open", "unanswered", "yours"]);
    // The next round asks only about what still waits, and changes nothing more.
    const next = await Effect.runPromise(checkPullRequests(round.next).pipe(Effect.provide(layer)));
    expect(next.reviewed).toBe(0);
    expect(asked.slice(5)).toEqual(["ada acme/shop#3", "ada acme/shop#4"]);
    expect(next.next).toBe(2);
    expect(planPullRequestEnded(pr("x", "https://github.com/acme/shop/pull/9"), NOW)?.reviewedBy).toEqual(GITHUB_ACTOR);
  });

  // covers ADR 037 (Records)
  it("[TC-OR-1422-06] asks about a few pull requests a round, going on from where the last round stopped", async () => {
    const waiting = [3, 7, 8].map((number) => pr(`open-${number}`, `https://github.com/acme/shop/pull/${number}`));
    const { layer, asked } = hub(waiting);
    let start = 0;
    for (let round = 0; round < 3; round++) {
      start = (await Effect.runPromise(checkPullRequests(start, 2).pipe(Effect.provide(layer)))).next;
    }
    expect(asked.map((line) => line.split("#")[1])).toEqual(["3", "7", "8", "3", "7", "8"]);
  });
});
