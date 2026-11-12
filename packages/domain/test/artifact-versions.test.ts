import { describe, expect, it } from "vitest";
import {
  Artifact,
  AttemptId,
  artifactShow,
  artifactVersions,
  ChapterId,
  ContentId,
  RegisteredArtifactId,
  type StoredVersion,
  ThreadId,
} from "../src/index.ts";

const artifact = (locator: string, kind: Artifact["kind"] = "doc") =>
  new Artifact({
    id: RegisteredArtifactId.make("a1"),
    threadId: ThreadId.make("t1"),
    chapterId: ChapterId.make("c1"),
    kind,
    title: "Launch",
    locator,
    latestVersion: 3,
    origin: { kind: "attempt", id: "attempt-3" },
    actor: { kind: "hob", id: "ada" },
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
    revision: 1,
  });

const stored = (version: number, source: StoredVersion["source"]): StoredVersion => ({
  version,
  at: `2026-11-12T0${version}:00:00.000Z`,
  origin: { kind: "attempt", id: `attempt-${version}` },
  source,
});

const kept = { _tag: "kept", attemptId: AttemptId.make("x"), contentId: ContentId.make("c") } as const;

describe("how an artifact is shown", () => {
  it("draws a document rendered, code and text as a diff, a page, an image and a link, and nothing it cannot read", () => {
    expect(artifactShow(artifact("/w/plan.md"))).toBe("document");
    expect(artifactShow(artifact("text:ref-1"))).toBe("document");
    expect(artifactShow(artifact("/w/src/app.ts", "code"))).toBe("diff");
    expect(artifactShow(artifact("/w/notes.txt"))).toBe("diff");
    expect(artifactShow(artifact("/w/site/index.html", "page"))).toBe("page");
    expect(artifactShow(artifact("/w/hero.png", "image"))).toBe("image");
    expect(artifactShow(artifact("https://github.com/o/r/pull/1", "pr"))).toBe("link");
    expect(artifactShow(artifact("/w/data.bin", "file"))).toBe("none");
  });
});

describe("an artifact's versions", () => {
  it("lists them newest first: kept, the latest read from the file now, older ones nothing kept as not kept", () => {
    const read = artifactVersions(artifact("/w/plan.md"), [
      stored(1, kept),
      stored(2, { _tag: "none" }),
      stored(3, { _tag: "none" }),
    ]);
    expect(read.show).toBe("document");
    expect(read.versions.map((each) => [each.version, each.content])).toEqual([
      [3, "now"],
      [2, "none"],
      [1, "kept"],
    ]);
    // A link is never read from a file.
    const link = artifactVersions(artifact("https://example.com", "page"), [stored(1, { _tag: "none" })]);
    expect(link.versions.map((each) => each.content)).toEqual(["none"]);
    expect(artifactVersions(artifact("text:r"), [stored(1, { _tag: "text", text: "Hi" })]).versions[0]?.content).toBe(
      "kept",
    );
  });
});
