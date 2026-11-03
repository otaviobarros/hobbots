import type { FolderChecksShape } from "@hobbots/agents";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { delegatedAuthority } from "../src/authority.ts";
import { defaultFolders, pathsIn } from "../src/default-folders.ts";

// Issue #582: a member a lead names no folders for gets the narrowest the work needs, not every
// folder the lead can reach.

/** A hub whose folders are `existing`, each stored as typed; anything else is refused as no folder. */
const checks = (existing: ReadonlyArray<string>) =>
  ({
    check: (typed: string) => (existing.includes(typed) ? Effect.succeed(typed) : Effect.fail(`${typed} is no folder`)),
    identity: Effect.succeed,
  }) as unknown as FolderChecksShape;

const lead = ["/work/test", "/work/hobbots", "/work/other"];
const hub = checks([...lead, "/work/test/site", "/work/test/shop", "/elsewhere"]);
const defaults = (brief: string, folders: ReadonlyArray<string> = lead) =>
  Effect.runPromise(defaultFolders(hub, folders, brief, "/"));

describe("A member's default folders", () => {
  it("are the folders the brief names inside the lead's, as the hub stores them", async () => {
    expect(await defaults("Build the site in /work/test/site, and keep the shop (/work/test/shop) as it is.")).toEqual([
      "/work/test/site",
      "/work/test/shop",
    ]);
  });

  it("leave out what the brief names outside the lead's folders, files, and paths that are not on the hub", async () => {
    expect(
      await defaults(
        "Read /elsewhere and /work/test/site/README.md, then write /work/test/missing. See https://x.dev/a.",
      ),
    ).toEqual(["/work/test"]);
  });

  it("are the folder the lead's Task works in when the brief names none, and none when the lead has none", async () => {
    expect(await defaults("Make the badge")).toEqual(["/work/test"]);
    expect(await defaults("Make the badge", [])).toEqual([]);
  });

  it("are within the lead's, so the authority given is narrowed to them", async () => {
    const folders = await defaults("Work in /work/test/site.");
    const given = delegatedAuthority({ decisions: {} as never, fixed: [], folders: lead }, { folders }, "/");
    expect(given).toMatchObject({ _tag: "Narrowed", authority: { folders: ["/work/test/site"] } });
  });
});

describe("Paths in a brief", () => {
  it("are the absolute ones, without the sentence's punctuation around them", () => {
    expect(pathsIn('Use "/a/b", then (/c/d). Not a/b or https://e.dev/f; and /g.', "/")).toEqual([
      "/a/b",
      "/c/d",
      "/g",
    ]);
  });

  it("start at a drive on Windows", () => {
    expect(pathsIn(String.raw`Work in C:\Users\you\site.`, "\\")).toEqual([String.raw`C:\Users\you\site`]);
  });
});
