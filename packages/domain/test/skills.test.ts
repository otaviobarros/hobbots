import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SkillFilePath,
  SkillFrontMatter,
  SkillName,
  savedSkillInstructions,
  skillCharmsOf,
  skillRevisionLabel,
} from "../src/index.ts";

const valid = (schema: Schema.Codec<unknown, unknown>, value: unknown) => Schema.is(schema)(value);

describe("skill names", () => {
  it("takes lower-case letters, digits and single hyphens, at most 64 characters", () => {
    for (const name of ["release", "pr-style", "a1", "x".repeat(64)]) expect(valid(SkillName, name)).toBe(true);
    for (const name of ["", "Release", "-x", "x-", "a--b", "a_b", "a b", "x".repeat(65)]) {
      expect(valid(SkillName, name)).toBe(false);
    }
  });
});

describe("skill file paths", () => {
  it("stays inside the skill", () => {
    for (const path of ["SKILL.md", "scripts/run.sh", ".hidden/file", "a/b..c", "...", "notas/café.md"]) {
      expect(valid(SkillFilePath, path)).toBe(true);
    }
    const outside = ["", "/etc/passwd", "../x", "a/../b", "./a", "a/./b", "a//b", "a\\b", "a/", "..", "a/.."];
    // A line break or another control character never hides a '..' part from the check.
    const hidden = ["a\n/../../outside", "a\r/../x", "a/\n..", "\n/..", "a\u0000b", "a\tb", "a\u007fb"];
    for (const path of [...outside, ...hidden]) {
      expect(valid(SkillFilePath, path)).toBe(false);
    }
  });
});

describe("skill front matter", () => {
  const decode = Schema.decodeUnknownSync(SkillFrontMatter);

  it("needs a name and a description of at most 1,024 characters", () => {
    expect(() => decode({ name: "release" })).toThrow();
    expect(() => decode({ name: "release", description: "" })).toThrow();
    expect(() => decode({ name: "release", description: "x".repeat(1025) })).toThrow();
    expect(decode({ name: "release", description: "x".repeat(1024), other: 1 }).name).toBe("release");
  });

  it("reads the Charms a skill needs from metadata.hobbots.charms", () => {
    const needs = decode({
      name: "pr",
      description: "Pull requests",
      metadata: { hobbots: { charms: ["github", "linear", "github"] } },
    });
    expect(skillCharmsOf(needs)).toEqual(["github", "linear"]);
    expect(skillCharmsOf(decode({ name: "pr", description: "d", metadata: { hobbots: "x" } }))).toEqual([]);
    expect(skillCharmsOf(decode({ name: "pr", description: "d" }))).toEqual([]);
  });

  it("saves instructions without opening line breaks and ending in one, keeping indentation", () => {
    expect(savedSkillInstructions("\n\nRead the diff.")).toBe("Read the diff.\n");
    expect(savedSkillInstructions("Read the diff.\n")).toBe("Read the diff.\n");
    expect(savedSkillInstructions("    code\n")).toBe("    code\n");
    expect(savedSkillInstructions("")).toBe("");
  });

  it("labels a revision by its number", () => {
    expect(skillRevisionLabel({ number: 4 })).toBe("r4");
  });
});
