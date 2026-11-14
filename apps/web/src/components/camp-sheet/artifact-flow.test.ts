import { ArtifactVersion, RegisteredArtifactId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_LIST,
  type ArtifactReading,
  firstLines,
  pageDocument,
  readArtifacts,
  shownVersion,
  versionBefore,
} from "./artifact-flow.ts";

const ID = RegisteredArtifactId.make("a1");

const version = (number: number, content: ArtifactVersion["content"] = "kept") =>
  new ArtifactVersion({
    version: number,
    at: "2026-11-12T00:00:00.000Z",
    origin: { kind: "attempt", id: `attempt-${number}` },
    content,
  });

describe("reading the camp's artifacts", () => {
  it("[TC-CH-1434-05] opens one at its latest version, picks another, moves to the full view and back to the list", () => {
    const steps: Array<ArtifactReading> = [ARTIFACT_LIST];
    const play = (...events: Array<Parameters<typeof readArtifacts>[1]>) => {
      for (const event of events) steps.push(readArtifacts(steps.at(-1) ?? ARTIFACT_LIST, event));
      return steps.at(-1);
    };
    expect(play({ _tag: "Filter", filter: "docs" })).toEqual({ step: "list", filter: "docs" });
    // Only an open artifact has a version to pick, or a full view to open.
    expect(play({ _tag: "Pick", version: 2 }, { _tag: "Expand" }, { _tag: "Collapse" })).toEqual({
      step: "list",
      filter: "docs",
    });
    expect(play({ _tag: "Open", artifactId: ID })).toEqual({
      step: "open",
      filter: "docs",
      artifactId: ID,
      version: null,
    });
    expect(play({ _tag: "Pick", version: 2 }, { _tag: "Expand" })).toEqual({
      step: "full",
      filter: "docs",
      artifactId: ID,
      version: 2,
    });
    // The filter stays while an artifact is open.
    expect(play({ _tag: "Filter", filter: "code" }, { _tag: "Collapse" })).toMatchObject({ step: "open", version: 2 });
    expect(play({ _tag: "Back" })).toEqual({ step: "list", filter: "docs" });
  });

  it("shows the picked version while it is listed, else the newest, and compares with the newest one kept before it", () => {
    const versions = [version(4), version(3, "none"), version(2), version(1)];
    expect(shownVersion(undefined, null)).toBeNull();
    expect(shownVersion(versions, null)?.version).toBe(4);
    expect(shownVersion(versions, 2)?.version).toBe(2);
    expect(shownVersion(versions, 9)?.version).toBe(4);
    expect(shownVersion([], null)).toBeNull();
    expect(versionBefore(versions, version(4))?.version).toBe(2);
    expect(versionBefore(versions, version(1))).toBeNull();
  });

  it("previews a text's first lines that hold something, a document's Markdown marks dropped, each cut", () => {
    expect(firstLines("\n# Launch plan\n\n## Dates\nShip on Friday.\n", true)).toEqual(["Launch plan", "Dates"]);
    expect(firstLines("> **Ship** on [Friday](https://example.com)\n\n```\n# not a heading\n```", true)).toEqual([
      "Ship on Friday",
      "# not a heading",
    ]);
    expect(firstLines("- one\n- two", true)).toEqual(["one", "two"]);
    expect(firstLines("foo  \nbar", true)).toEqual(["foo", "bar"]);
    expect(firstLines("# kept\n<p>as written</p>", false)).toEqual(["# kept", "<p>as written</p>"]);
    expect(firstLines("x".repeat(200), false, 2, 10)).toEqual([`${"x".repeat(9)}…`]);
    expect(firstLines("   \n\n", true)).toEqual([]);
  });

  it("shows a page under a policy that loads nothing from anywhere", () => {
    const page = pageDocument("<p>Hi</p>");
    expect(page).toContain("default-src 'none'");
    expect(page.endsWith("<p>Hi</p>")).toBe(true);
  });
});
