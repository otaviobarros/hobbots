import { Artifact, ChapterId, RegisteredArtifactId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { filterArtifacts, filterInEffect, isArtifactFilter, linkOf, shownFilters } from "./artifact-rows.ts";

const artifact = (id: string, kind: Artifact["kind"], locator = `/work/${id}`) =>
  new Artifact({
    id: RegisteredArtifactId.make(id),
    threadId: ThreadId.make("camp-1"),
    chapterId: ChapterId.make("c1"),
    kind,
    title: id,
    locator,
    latestVersion: 1,
    origin: { kind: "message", id: "m1" },
    actor: { kind: "hob", id: "hob-1" },
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
    revision: 1,
  });

describe("the Artifacts tab's chips", () => {
  it("[TC-CH-1387-29] groups the registry's kinds under each chip, keeping the hub's order", () => {
    const all = [artifact("a", "code"), artifact("b", "doc"), artifact("c", "pr"), artifact("d", "image")];
    expect(filterArtifacts(all, "all")).toEqual(all);
    expect(filterArtifacts(all, "code").map((each) => each.id)).toEqual(["a", "c"]);
    expect(filterArtifacts(all, "docs").map((each) => each.id)).toEqual(["b"]);
    expect(filterArtifacts(all, "pages")).toEqual([]);
    expect(isArtifactFilter("images")).toBe(true);
    expect(isArtifactFilter("files")).toBe(false);
    expect(linkOf(artifact("e", "pr", "https://github.com/o/r/pull/1"))).toBe("https://github.com/o/r/pull/1");
    expect(linkOf(artifact("f", "doc"))).toBeNull();
  });
});

describe("the chips a camp shows", () => {
  it("[TC-CH-1434-06] shows All and only the kinds the camp has, and falls back to All when a kind is gone", () => {
    const all = [artifact("a", "doc"), artifact("b", "pr")];
    expect(shownFilters(all)).toEqual(["all", "code", "docs"]);
    expect(shownFilters([])).toEqual(["all"]);
    expect(filterInEffect(all, "docs")).toBe("docs");
    expect(filterInEffect(all, "images")).toBe("all");
  });
});
