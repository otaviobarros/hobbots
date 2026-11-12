import { Artifact, ChapterId, RegisteredArtifactId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { reviewLine } from "./artifact-review.tsx";

// Issue #1387 with #1422: the Artifacts tab says where each artifact's review stands, and who settled it.

const at = new Date(Date.now() - 60_000).toISOString();
const artifact = (review: Partial<Pick<Artifact, "review" | "reviewedAt" | "reviewedBy">>) =>
  new Artifact({
    id: RegisteredArtifactId.make("a1"),
    threadId: ThreadId.make("camp-1"),
    chapterId: ChapterId.make("c1"),
    kind: "pr",
    title: "Launch page",
    locator: "https://github.com/acme/site/pull/7",
    latestVersion: 1,
    origin: { kind: "message", id: "m1" },
    actor: { kind: "hob", id: "hob-1" },
    createdAt: at,
    updatedAt: at,
    revision: 1,
    ...review,
  });

describe("reviewLine", () => {
  it("[TC-CH-1387-33] says an artifact waits for you, or who reviewed or dismissed it", () => {
    expect(reviewLine(artifact({}), "Aldric")).toBe("Waiting for you");
    expect(
      reviewLine(artifact({ review: "reviewed", reviewedAt: at, reviewedBy: { kind: "user", id: "owner" } }), "Aldric"),
    ).toMatch(/^Reviewed by you · /);
    expect(
      reviewLine(artifact({ review: "reviewed", reviewedAt: at, reviewedBy: { kind: "hub", id: "github" } }), "Aldric"),
    ).toMatch(/^Reviewed by GitHub · /);
    expect(
      reviewLine(
        artifact({ review: "dismissed", reviewedAt: at, reviewedBy: { kind: "user", id: "owner" } }),
        "Aldric",
      ),
    ).toMatch(/^Dismissed by you · /);
  });
});
