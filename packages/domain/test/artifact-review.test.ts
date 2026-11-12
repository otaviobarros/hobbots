import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  Artifact,
  type ArtifactReview,
  type ArtifactReviewEvent,
  ArtifactReviewMachine,
  ArtifactReviewRefused,
  ArtifactReviews,
  ChapterId,
  GITHUB_ACTOR,
  IllegalArtifactReviewTransition,
  OWNER_ACTOR,
  planPullRequestEnded,
  planReview,
  RegisteredArtifactId,
  type RegisteredArtifactKind,
  ThreadId,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

// Issue #1422 (ADR 037, Records): every artifact waits for your review, is reviewed or dismissed
// once, and a pull request is reviewed when GitHub reports it merged or closed.

const ID = RegisteredArtifactId.make("a1");
const at = (minute: number) => new Date(Date.UTC(2026, 10, 12) + minute * 60_000).toISOString();
const KINDS: ReadonlyArray<RegisteredArtifactKind> = ["code", "page", "doc", "email", "image", "pr", "file"];

const artifact = (kind: RegisteredArtifactKind, review: ArtifactReview = "waiting") =>
  new Artifact({
    id: ID,
    threadId: ThreadId.make("chat-1"),
    chapterId: ChapterId.make("chapter-1"),
    kind,
    title: "Launch plan",
    locator: "/code/launch.md",
    latestVersion: 1,
    origin: { kind: "task-artifact", id: "ref-1" },
    actor: { kind: "hob", id: "ada" },
    createdAt: at(0),
    updatedAt: at(0),
    review,
    reviewedAt: review === "waiting" ? null : at(1),
    reviewedBy: review === "waiting" ? null : OWNER_ACTOR,
  });

/** What the model tracks of an artifact: every field a rule writes, and the kind a guard reads. */
interface ReviewView {
  readonly kind: RegisteredArtifactKind;
  readonly review: ArtifactReview;
  readonly reviewedAt: string | null;
  readonly reviewedBy: Actor | null;
}

const view = (a: Artifact): ReviewView => ({
  kind: a.kind,
  review: a.review,
  reviewedAt: a.reviewedAt,
  reviewedBy: a.reviewedBy,
});

// The rule, kept apart from the machine: only an artifact waiting changes, once; GitHub ends only a
// pull request, and is named as who reviewed it.
const step = (m: ReviewView, e: ArtifactReviewEvent): ReviewView | "refused" => {
  if (m.review !== "waiting") return "refused";
  switch (e._tag) {
    case "Review":
      return { ...m, review: "reviewed", reviewedAt: e.at, reviewedBy: e.by };
    case "Dismiss":
      return { ...m, review: "dismissed", reviewedAt: e.at, reviewedBy: e.by };
    case "PullRequestEnded":
      return m.kind === "pr" ? { ...m, review: "reviewed", reviewedAt: e.at, reviewedBy: GITHUB_ACTOR } : "refused";
  }
};

const times = fc.integer({ min: 0, max: 10_000 }).map(at);
const actors = fc.constantFrom<Actor>(OWNER_ACTOR, { kind: "user", id: "sam" });
const events: fc.Arbitrary<ArtifactReviewEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Review" as const), at: times, by: actors }),
  fc.record({ _tag: fc.constant("Dismiss" as const), at: times, by: actors }),
  fc.record({ _tag: fc.constant("PullRequestEnded" as const), at: times }),
);

describe("ArtifactReviewMachine", () => {
  // covers ADR 037 (Records), STD-ARCH-013
  it("[TC-OR-1422-01] agrees with a model of reviewing, dismissing and pull requests ending over random runs of events", () => {
    agreesWithModel({
      machine: ArtifactReviewMachine,
      records: fc
        .tuple(fc.constantFrom(...KINDS), fc.constantFrom<ArtifactReview>("waiting", "reviewed", "dismissed"))
        .map(([kind, review]) => artifact(kind, review)),
      events,
      model: { init: view, step, view },
      isError: (result): result is IllegalArtifactReviewTransition => result instanceof IllegalArtifactReviewTransition,
    });
  });

  it("exports one row per event", () => {
    expect(ArtifactReviewMachine.table.map((row) => [row.event, row.from, row.to, row.guarded])).toEqual([
      ["Review", ["waiting"], "reviewed", false],
      ["Dismiss", ["waiting"], "dismissed", false],
      ["PullRequestEnded", ["waiting"], "reviewed", true],
    ]);
  });

  it("[TC-OR-1422-02] answers the same review again as it is, and refuses one settled the other way or missing", () => {
    const reviewed = planReview({ id: ID, artifact: artifact("doc"), outcome: "reviewed", by: OWNER_ACTOR, at: at(2) });
    expect(reviewed).toMatchObject({
      changed: true,
      artifact: { review: "reviewed", reviewedAt: at(2), reviewedBy: OWNER_ACTOR },
    });
    const again = planReview({
      id: ID,
      artifact: artifact("doc", "reviewed"),
      outcome: "reviewed",
      by: OWNER_ACTOR,
      at: at(3),
    });
    expect(again).toMatchObject({ changed: false, artifact: { reviewedAt: at(1) } });
    expect(
      planReview({ id: ID, artifact: artifact("doc", "reviewed"), outcome: "dismissed", by: OWNER_ACTOR, at: at(3) }),
    ).toEqual(new ArtifactReviewRefused({ artifactId: ID, reason: "settled" }));
    expect(planReview({ id: ID, artifact: null, outcome: "dismissed", by: OWNER_ACTOR, at: at(3) })).toEqual(
      new ArtifactReviewRefused({ artifactId: ID, reason: "not-found" }),
    );
  });

  it("reviews a waiting pull request when it ends on GitHub, and nothing else", () => {
    expect(planPullRequestEnded(artifact("pr"), at(4))).toMatchObject({
      review: "reviewed",
      reviewedAt: at(4),
      reviewedBy: GITHUB_ACTOR,
    });
    expect(planPullRequestEnded(artifact("pr", "dismissed"), at(4))).toBeNull();
    expect(planPullRequestEnded(artifact("page"), at(4))).toBeNull();
  });

  it("asks for review only of a pull request, doc, page or code still waiting", () => {
    expect(KINDS.filter((kind) => ArtifactReviews.awaitsReview(artifact(kind)))).toEqual(["code", "page", "doc", "pr"]);
    expect(ArtifactReviews.awaitsReview(artifact("pr", "reviewed"))).toBe(false);
  });

  it("decodes an artifact journaled before reviews as waiting", () => {
    const { review, reviewedAt, reviewedBy, ...before } = artifact("doc");
    const decoded = Schema.decodeUnknownSync(Artifact)({ ...before, revision: 3 });
    expect([decoded.review, decoded.reviewedAt, decoded.reviewedBy]).toEqual(["waiting", null, null]);
  });
});
