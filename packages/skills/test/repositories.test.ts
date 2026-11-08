import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { RepositorySkillFinder } from "@hobbots/agents";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RepositorySkillFinderLive } from "../src/index.ts";
import { folderOf, skillMd } from "./fixtures.ts";

// #1098: the skill folders a clone holds, listed so Hobbots can offer them (ADR 029, Scopes).

const foldersIn = (checkout: string) =>
  Effect.runPromise(
    Effect.flatMap(RepositorySkillFinder, (finder) => finder.folders(checkout)).pipe(
      Effect.provide(RepositorySkillFinderLive),
    ),
  );

describe("a clone's own skill folders", () => {
  // covers STD-SEC-005, ADR 029 (Scopes), #1098
  it("[TC-AG-1098-04] lists .claude/skills and .agents/skills, and follows no link on the way", async () => {
    const elsewhere = await folderOf({ "skills/outside/SKILL.md": skillMd("outside") });
    const checkout = await folderOf({
      ".claude/skills/triage/SKILL.md": skillMd("triage"),
      ".claude/skills/notes/README.md": "Not a skill.",
      "docs/skills/elsewhere/SKILL.md": skillMd("elsewhere"),
    });
    await symlink(join(elsewhere, "skills/outside"), join(checkout, ".claude/skills/linked"));
    // A linked `.agents` reaches outside the clone, so nothing in it is listed.
    await symlink(elsewhere, join(checkout, ".agents"));
    expect(await foldersIn(checkout)).toEqual([".claude/skills/triage"]);

    // A linked skills folder under a real `.claude` is not followed either.
    const linkedRoot = await folderOf({ "README.md": "" });
    await mkdir(join(linkedRoot, ".claude"));
    await symlink(join(elsewhere, "skills"), join(linkedRoot, ".claude/skills"));
    expect(await foldersIn(linkedRoot)).toEqual([]);
  });
});
