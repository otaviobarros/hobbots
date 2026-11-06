import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillMount } from "@hobbots/agents";
import { Effect, Exit, Scope } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { sandboxFilesystem } from "../src/sandbox.ts";
import {
  holdSkillFolder,
  onlyWhenAskedCodexFile,
  onlyWhenAskedSkillFile,
  removeFolder,
  SKILL_MOUNTS,
  skillMountsHash,
  writeSkillFolder,
} from "../src/skills.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-skills-"));
afterAll(() => {
  // Some tests leave read-only skill folders behind, which only a writable tree lets go.
  removeFolder(temp);
});

/** A revision's files, as the library keeps them. */
const revision = (name: string, body = `Use ${name}.`, extra: Record<string, string> = {}) => {
  const folder = mkdtempSync(join(temp, `${name}-`));
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: About ${name}.\n---\n\n${body}\n`);
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  return folder;
};

/** Seals a revision as the library keeps it: nothing writable, its scripts still runnable. */
const sealed = (folder: string): string => {
  for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile()) chmodSync(path, statSync(path).mode & 0o111 ? 0o555 : 0o444);
  }
  for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true }).reverse()) {
    if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o555);
  }
  chmodSync(folder, 0o555);
  return folder;
};

const mount = (name: string, folder: string, implicit = true, rev = "r1"): SkillMount => ({
  name,
  revision: rev,
  folder,
  implicit,
});

describe("a turn's skill folder (ADR 029)", () => {
  it("is named by its mounts in any order, and by each one's revision and Only when asked", () => {
    const a = mount("alpha", "/x");
    const b = mount("beta", "/y");
    expect(skillMountsHash([a, b])).toBe(skillMountsHash([b, a]));
    expect(skillMountsHash([a, b])).not.toBe(skillMountsHash([{ ...a, revision: "r2" }, b]));
    expect(skillMountsHash([a, b])).not.toBe(skillMountsHash([{ ...a, implicit: false }, b]));
    // Where a revision's files are kept does not name it.
    expect(skillMountsHash([a])).toBe(skillMountsHash([{ ...a, folder: "/elsewhere" }]));
  });

  it("holds a skills-only plugin with each skill copied, read-only, and keeps a folder already written", () => {
    const base = mkdtempSync(join(temp, "base-"));
    const mounts = [mount("alpha", revision("alpha", "Steps.", { "scripts/run.sh": "echo hi\n" }))];
    const written = writeSkillFolder(base, mounts);
    expect(written.folder).toBe(join(base, SKILL_MOUNTS, written.hash));
    expect(JSON.parse(readFileSync(join(written.folder, ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({
      name: "hobbots-skills",
    });
    expect(readdirSync(written.skills)).toEqual(["alpha"]);
    expect(readFileSync(join(written.skills, "alpha", "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
    // Nothing in it may be written, and no MCP server, hook or command comes with it.
    expect(statSync(join(written.skills, "alpha", "SKILL.md")).mode & 0o222).toBe(0);
    expect(statSync(written.skills).mode & 0o222).toBe(0);
    expect(readdirSync(written.folder).sort()).toEqual([".claude-plugin", "skills"]);
    expect(writeSkillFolder(base, mounts)).toEqual(written);
    // No draft is left beside it.
    expect(readdirSync(join(base, SKILL_MOUNTS))).toEqual([written.hash]);
  });

  it("marks an Only when asked skill for both runtimes in the folder, never in the stored revision", () => {
    const base = mkdtempSync(join(temp, "base-"));
    const stored = revision("quiet", "Quiet steps.", {
      "agents/openai.yaml": "interface:\n  display_name: Quiet\npolicy:\n  allow_implicit_invocation: true\n",
    });
    const written = writeSkillFolder(base, [mount("quiet", stored, false)]);
    const skill = readFileSync(join(written.skills, "quiet", "SKILL.md"), "utf8");
    expect(skill).toBe(
      "---\nname: quiet\ndescription: About quiet.\ndisable-model-invocation: true\n---\n\nQuiet steps.\n",
    );
    expect(readFileSync(join(written.skills, "quiet", "agents", "openai.yaml"), "utf8")).toBe(
      "interface:\n  display_name: Quiet\npolicy:\n  allow_implicit_invocation: false\n",
    );
    expect(readFileSync(join(stored, "SKILL.md"), "utf8")).not.toContain("disable-model-invocation");
  });

  it("writes Only when asked into a SKILL.md without front matter and a skill without Codex's file", () => {
    expect(onlyWhenAskedSkillFile("Just steps.\n")).toBe("---\ndisable-model-invocation: true\n---\nJust steps.\n");
    expect(onlyWhenAskedSkillFile("---\ndisable-model-invocation: false\n---\nx")).toBe(
      "---\ndisable-model-invocation: true\n---\nx",
    );
    expect(onlyWhenAskedCodexFile(null)).toBe("policy:\n  allow_implicit_invocation: false\n");
  });

  it("refuses a skill that holds a link or has a name no library skill has", () => {
    const base = mkdtempSync(join(temp, "base-"));
    const linked = revision("linked");
    symlinkSync("/etc/passwd", join(linked, "passwd"));
    expect(() => writeSkillFolder(base, [mount("linked", linked)])).toThrow(/holds a link/);
    expect(() => writeSkillFolder(base, [mount("../escape", revision("escape"))])).toThrow(/not a skill name/);
    // Nothing half written is left.
    expect(readdirSync(join(base, SKILL_MOUNTS))).toEqual([]);
  });

  // covers RT-001, ADR 029
  it("[TC-RT-524] marks a read-only revision Only when asked, and its scripts still run from the folder", () => {
    const base = mkdtempSync(join(temp, "base-"));
    const stored = revision("release", "Release steps.", {
      "scripts/run.sh": "#!/bin/sh\necho released\n",
      "agents/openai.yaml": "interface:\n  display_name: Release\n",
    });
    chmodSync(join(stored, "scripts", "run.sh"), 0o755);
    const written = writeSkillFolder(base, [mount("release", sealed(stored), false)]);
    const copy = join(written.skills, "release");
    expect(readFileSync(join(copy, "SKILL.md"), "utf8")).toContain("disable-model-invocation: true");
    expect(readFileSync(join(copy, "agents", "openai.yaml"), "utf8")).toContain("allow_implicit_invocation: false");
    // A script the policy lets run is run straight from the folder, which stays read-only.
    const script = join(copy, "scripts", "run.sh");
    expect(execFileSync(script, { encoding: "utf8" })).toBe("released\n");
    expect(statSync(script).mode & 0o222).toBe(0);
    expect(statSync(join(copy, "SKILL.md")).mode & 0o111).toBe(0);
    // A revision without Codex's file gets one, inside a read-only revision too.
    const plain = writeSkillFolder(base, [mount("plain", sealed(revision("plain")), false)]);
    expect(readFileSync(join(plain.skills, "plain", "agents", "openai.yaml"), "utf8")).toBe(
      "policy:\n  allow_implicit_invocation: false\n",
    );
  });

  // covers RT-001, ADR 029
  it("[TC-RT-520] is shared by overlapping turns with the same mounts, kept apart from another revision's, and removed after the last", async () => {
    const base = mkdtempSync(join(temp, "base-"));
    const r4 = [mount("release", revision("release", "Release r4."), true, "r4")];
    const r5 = [mount("release", revision("release", "Release r5."), true, "r5")];
    const hold = (scope: Scope.Closeable, mounts: ReadonlyArray<SkillMount>) =>
      Effect.runPromise(holdSkillFolder(base, mounts).pipe(Scope.provide(scope)));
    const first = await Effect.runPromise(Scope.make());
    const second = await Effect.runPromise(Scope.make());
    const third = await Effect.runPromise(Scope.make());
    const a = await hold(first, r4);
    const b = await hold(second, r4);
    const c = await hold(third, r5);
    expect(b).toEqual(a);
    expect(c?.folder).not.toBe(a?.folder);
    // A turn on r4 reads r4 while one on r5 runs beside it.
    expect(readFileSync(join(a?.skills ?? "", "release", "SKILL.md"), "utf8")).toContain("Release r4.");
    expect(readFileSync(join(c?.skills ?? "", "release", "SKILL.md"), "utf8")).toContain("Release r5.");
    await Effect.runPromise(Scope.close(first, Exit.void));
    expect(existsSync(a?.folder ?? "")).toBe(true);
    await Effect.runPromise(Scope.close(second, Exit.void));
    expect(existsSync(a?.folder ?? "")).toBe(false);
    expect(existsSync(c?.folder ?? "")).toBe(true);
    await Effect.runPromise(Scope.close(third, Exit.void));
    expect(readdirSync(join(base, SKILL_MOUNTS))).toEqual([]);
  });

  it("removes folders no turn holds, as a hub that stopped leaves them, and holds nothing without skills", async () => {
    const base = mkdtempSync(join(temp, "base-"));
    const stale = writeSkillFolder(base, [mount("old", revision("old"))]);
    const scope = await Effect.runPromise(Scope.make());
    await Effect.runPromise(holdSkillFolder(base, [mount("new", revision("new"))]).pipe(Scope.provide(scope)));
    expect(existsSync(stale.folder)).toBe(false);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(await Effect.runPromise(Effect.scoped(holdSkillFolder(base, [])))).toBeNull();
    expect(await Effect.runPromise(Effect.scoped(holdSkillFolder(base, null)))).toBeNull();
  });
});

describe("a turn's skill folder in the sandbox (ADR 029)", () => {
  // covers PE-001, ADR 029
  it("[TC-RT-523] is readable, and nothing under the runtime folder's skill folders is writable", () => {
    const runtimeFolder = "/hub/runtimes/hob-1";
    const skillFolder = join(runtimeFolder, SKILL_MOUNTS, "abc");
    const filesystem = sandboxFilesystem({
      folders: ["/work/project"],
      folderAccess: { read: true, write: true },
      dataFolder: "/hub/data",
      binary: "/usr/bin/claude",
      runtimeFolder,
      skillFolder,
      tempFolder: "/tmp/hb-1",
      allowedHosts: [],
      home: "/home/u",
      roots: [],
    });
    expect(filesystem.allowRead).toContain(skillFolder);
    // The runtime folder itself is writable for Claude Code, so its skill folders are carved out.
    expect(filesystem.allowWrite).toContain(runtimeFolder);
    expect(filesystem.denyWrite).toContain(join(runtimeFolder, SKILL_MOUNTS));
  });
});
