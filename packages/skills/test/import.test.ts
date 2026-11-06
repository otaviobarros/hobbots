import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SkillFiles, SkillLibrary } from "@hobbots/agents";
import { SkillName } from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { SkillImporter } from "../src/index.ts";
import { archiveOf, folderOf, importerLayer, repositoryOf, runWith, skillMd } from "./fixtures.ts";

// #1060: importing skills safely (ADR 029, Import), into the library and the object store.

const you = { by: { _tag: "You" } } as const;

const objectFiles = async (folder: string): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = [];
  const walk = async (at: string, prefix: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(at, entry.name), path);
      else found.push(path);
    }
  };
  await walk(folder, "");
  return found.sort();
};

describe("skill import", () => {
  // covers ADR 029 (Import, Storage and revisions), #1060
  it("[TC-AG-121] imports a folder once per content: the same content again returns the existing revision", async () => {
    const { layer, data } = await importerLayer();
    const folder = await folderOf({ "SKILL.md": skillMd("release"), "notes/steps.md": "Tag, then push." });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const [first] = yield* importer.add({ _tag: "Folder", path: folder }, you);
        expect(first).toMatchObject({ added: true, revision: { number: 1, name: "release", path: null } });
        const [again] = yield* importer.add({ _tag: "Folder", path: folder }, you);
        expect(again).toMatchObject({ added: false, revision: { number: 1, hash: first?.revision.hash } });
        expect((yield* (yield* SkillLibrary).list).map((skill) => skill.name)).toEqual(["release"]);

        // The files are kept once, read-only, under the revision's hash.
        const object = yield* (yield* SkillFiles).folder(first?.revision.hash ?? ("" as never));
        expect(object).toBe(join(data, "skills", "objects", first?.revision.hash ?? ""));
        expect(yield* Effect.promise(() => objectFiles(object ?? ""))).toEqual(["SKILL.md", "notes/steps.md"]);
        const mode = (yield* Effect.promise(() => stat(join(object ?? "", "SKILL.md")))).mode & 0o777;
        expect(mode).toBe(0o444);
        expect(first?.revision.files.map((file) => file.path)).toEqual(["SKILL.md", "notes/steps.md"]);
      }),
    );
  });

  it("[TC-AG-122] makes a new revision for new content of a skill, and refuses a new skill of a name the library has", async () => {
    const { layer } = await importerLayer();
    const one = await folderOf({ "SKILL.md": skillMd("release") });
    const two = await folderOf({ "SKILL.md": skillMd("release", "How releases go now.") });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const [first] = yield* importer.add({ _tag: "Folder", path: one }, you);
        const taken = yield* Effect.flip(importer.add({ _tag: "Folder", path: two }, you));
        expect(taken._tag).toBe("SkillNameTaken");
        if (first === undefined) return expect.unreachable();
        const skillId = first.skill.id;
        const [second] = yield* importer.add({ _tag: "Folder", path: two }, { ...you, skillId });
        expect(second?.revision).toMatchObject({ number: 2, description: "How releases go now." });
        const other = yield* Effect.promise(() => folderOf({ "SKILL.md": skillMd("ship") }));
        const renamed = yield* Effect.flip(importer.add({ _tag: "Folder", path: other }, { ...you, skillId }));
        expect(renamed._tag).toBe("SkillNameChanged");
      }),
    );
  });

  it("[TC-AG-123] refuses an archive with a link outside the skill, and writes nothing", async () => {
    const { layer, data } = await importerLayer();
    const bytes = await archiveOf({
      "release/SKILL.md": skillMd("release"),
      "release/secrets": { text: "../../../.ssh/id_ed25519", link: true },
    });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const refused = yield* Effect.flip(importer.add({ _tag: "Archive", fileName: "release.skill", bytes }, you));
        expect(refused).toMatchObject({ _tag: "SkillRefused", check: "symlink", path: "release/secrets" });
        expect(yield* (yield* SkillLibrary).list).toEqual([]);
        expect(yield* Effect.promise(() => readdir(join(data, "skills", "objects")))).toEqual([]);
      }),
    );
  });

  it("[TC-AG-124] refuses a SKILL.md without valid front matter, and a link out of the skill in its text", async () => {
    const { layer, data } = await importerLayer();
    const cases = [
      { "SKILL.md": "# Release\n\nNo front matter.\n" },
      { "SKILL.md": "---\nname: Release Steps\ndescription: x\n---\n" },
      { "SKILL.md": "---\nname: release\n---\n" },
      { "SKILL.md": `---\nname: release\ndescription: ${"x".repeat(1025)}\n---\n` },
      { "SKILL.md": "---\nname: [unclosed\n---\n" },
    ];
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        for (const fixture of cases) {
          const bytes = yield* Effect.promise(() => archiveOf(fixture));
          const refused = yield* Effect.flip(importer.add({ _tag: "Archive", fileName: "x.zip", bytes }, you));
          expect(refused).toMatchObject({ _tag: "SkillRefused", check: "front-matter", path: "SKILL.md" });
        }
        const linking = yield* Effect.promise(() =>
          archiveOf({ "SKILL.md": skillMd("release", "x", "").replace("Steps", "See [keys](../../.ssh/config) and") }),
        );
        const outside = yield* Effect.flip(importer.add({ _tag: "Archive", fileName: "x.zip", bytes: linking }, you));
        expect(outside).toMatchObject({ check: "outside-path", path: "SKILL.md" });
        expect(yield* Effect.promise(() => readdir(join(data, "skills", "objects")))).toEqual([]);
      }),
    );
  });

  it("[TC-AG-125] refuses a link in a folder and a skill over the limits", async () => {
    const { layer } = await importerLayer();
    const linked = await folderOf({ "SKILL.md": skillMd("release"), home: { text: "/", link: true } });
    const many = await folderOf(
      Object.fromEntries([["SKILL.md", skillMd("many")], ...Array.from({ length: 200 }, (_, i) => [`f/${i}.md`, "x"])]),
    );
    const large = await folderOf({ "SKILL.md": skillMd("large"), "big.txt": "x".repeat(5 * 1024 * 1024 + 1) });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const flip = (path: string) => Effect.flip(importer.add({ _tag: "Folder", path }, you));
        expect(yield* flip(linked)).toMatchObject({ check: "symlink", path: "home" });
        expect(yield* flip(many)).toMatchObject({ check: "too-many-files", path: null });
        expect(yield* flip(large)).toMatchObject({ check: "too-large" });
        // The link is never followed, not even to list it.
        expect((yield* Effect.promise(() => lstat(join(linked, "home")))).isSymbolicLink()).toBe(true);
      }),
    );
  });

  it("[TC-AG-126] imports a Claude Code plugin with only its skills, and notes what it dropped", async () => {
    const { layer } = await importerLayer();
    const plugin = await folderOf({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "acme", version: "2.1.0" }),
      "hooks/hooks.json": "{}",
      "commands/deploy.md": "Deploy it.",
      "agents/reviewer.md": "Review.",
      ".mcp.json": "{}",
      "skills/release/SKILL.md": skillMd("release", "Releases.", "allowed-tools: Bash(git push:*)\n"),
      "skills/review/SKILL.md": skillMd("review"),
    });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const scan = yield* importer.scan({ _tag: "Folder", path: plugin });
        expect(scan.candidates.map((one) => one.folder)).toEqual(["skills/release", "skills/review"]);
        const added = yield* importer.add({ _tag: "Folder", path: plugin }, you);
        expect(added.map((one) => one.revision.name)).toEqual(["release", "review"]);
        const release = added[0]?.revision;
        expect(release?.label).toBe("2.1.0");
        expect(release?.path).toBe("skills/release");
        expect(release?.dropped).toEqual([
          { kind: "hooks", path: "hooks" },
          { kind: "commands", path: "commands" },
          { kind: "agents", path: "agents" },
          { kind: "mcp-servers", path: ".mcp.json" },
          { kind: "allowed-tools", path: "skills/release/SKILL.md" },
        ]);
        expect(release?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
        // The stored SKILL.md no longer grants tools.
        const folder = yield* (yield* SkillFiles).folder(release?.hash ?? ("" as never));
        const text = yield* Effect.promise(() => readFile(join(folder ?? "", "SKILL.md"), "utf8"));
        expect(text).not.toContain("allowed-tools");
        expect(text).toContain("name: release");
        expect(text).toContain("# release");
      }),
    );
  });

  it("[TC-AG-127] drops Codex's tool dependencies and keeps them, and metadata.hobbots.charms, as Charm hints", async () => {
    const { layer } = await importerLayer();
    const folder = await folderOf({
      "SKILL.md": skillMd("pull-requests", "PRs.", "metadata:\n  hobbots:\n    charms: [linear]\n"),
      "agents/openai.yaml":
        "policy:\n  allow_implicit_invocation: true\ndependencies:\n  tools:\n    - type: mcp\n      value: GitHub\n      url: https://example.com/mcp\n",
    });
    await runWith(layer)(
      Effect.gen(function* () {
        const [added] = yield* (yield* SkillImporter).add({ _tag: "Folder", path: folder }, you);
        expect(added?.revision.charms).toEqual(["github", "linear"]);
        expect(added?.revision.dropped).toEqual([{ kind: "tool-dependencies", path: "agents/openai.yaml" }]);
        const object = yield* (yield* SkillFiles).folder(added?.revision.hash ?? ("" as never));
        const yaml = yield* Effect.promise(() => readFile(join(object ?? "", "agents/openai.yaml"), "utf8"));
        expect(yaml).toContain("allow_implicit_invocation: true");
        expect(yaml).not.toContain("dependencies");
      }),
    );
  });

  it("[TC-AG-128] flags a script, a URL and hidden text, and runs nothing", async () => {
    const { layer } = await importerLayer();
    const folder = await folderOf({
      "SKILL.md": skillMd("release", "Releases.").replace("Steps", "Read https://example.com/guide.​ Steps"),
      "scripts/tag": { text: "#!/bin/sh\ntouch ran\n", executable: true },
      "tools/check.py": "print('x')\n",
    });
    await runWith(layer)(
      Effect.gen(function* () {
        const [added] = yield* (yield* SkillImporter).add({ _tag: "Folder", path: folder }, you);
        expect(added?.revision.flags).toEqual([
          { _tag: "Url", path: "SKILL.md", url: "https://example.com/guide" },
          { _tag: "HiddenText", path: "SKILL.md", codePoint: "U+200B" },
          { _tag: "Script", path: "scripts/tag" },
          { _tag: "Script", path: "tools/check.py" },
        ]);
        expect(added?.revision.files.find((file) => file.path === "scripts/tag")?.mode).toBe("executable");
        expect(yield* Effect.promise(() => lstat(join(folder, "ran")).catch(() => null))).toBeNull();
      }),
    );
  });

  it("[TC-AG-129] imports from a Git commit, lists a repository's skills to pick from, and keeps the commit", async () => {
    const { layer } = await importerLayer();
    const repository = await repositoryOf({
      "README.md": "Skills.",
      "skills/release/SKILL.md": skillMd("release"),
      "skills/review/SKILL.md": skillMd("review"),
      "skills/broken/SKILL.md": "no front matter",
    });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const source = { _tag: "Git", url: repository.url, ref: "main" } as const;
        const scan = yield* importer.scan(source);
        expect(scan.commit).toBe(repository.commit);
        expect(scan.candidates.map((one) => [one.folder, one.name, one.refusal?.check ?? null])).toEqual([
          ["skills/broken", null, "front-matter"],
          ["skills/release", "release", null],
          ["skills/review", "review", null],
        ]);
        // Taking every skill fails on the broken one; picking leaves it out.
        expect((yield* Effect.flip(importer.add(source, you)))._tag).toBe("SkillRefused");
        const [added] = yield* importer.add(source, { ...you, folders: ["skills/review"] });
        expect(added?.revision).toMatchObject({ name: "review", commit: repository.commit, path: "skills/review" });
        const sources = yield* (yield* SkillLibrary).sources;
        expect(sources.map((one) => one.origin)).toEqual([{ _tag: "Git", url: repository.url, ref: "main" }]);
        expect((yield* importer.scan(source)).candidates[2]?.existing).toMatchObject({ number: 1 });
        const missing = yield* Effect.flip(importer.scan({ _tag: "Git", url: `${repository.url}-gone`, ref: null }));
        expect(missing._tag).toBe("SkillSourceUnreadable");
      }),
    );
  });

  it("[TC-AG-130] reads skills-lock.json, so a skill the skills CLI installed keeps its version and its source", async () => {
    const { layer } = await importerLayer();
    const installed = { "SKILL.md": skillMd("pnpm"), "notes.md": "Use pnpm." };
    // The skills CLI's own hash of the installed copy: SHA-256 over each path and then its contents.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256");
    for (const path of Object.keys(installed).sort((a, b) => a.localeCompare(b))) {
      hash.update(path);
      hash.update(installed[path as keyof typeof installed]);
    }
    const lock = {
      version: 1,
      skills: {
        pnpm: {
          source: "antfu/skills",
          sourceType: "github",
          skillPath: "skills/pnpm/SKILL.md",
          computedHash: hash.digest("hex"),
        },
        other: { source: "acme/skills", sourceType: "github", computedHash: "0".repeat(64) },
      },
    };
    const project = await folderOf({
      "skills-lock.json": JSON.stringify(lock),
      ".agents/skills/pnpm/SKILL.md": installed["SKILL.md"],
      ".agents/skills/pnpm/notes.md": installed["notes.md"],
      ".agents/skills/other/SKILL.md": skillMd("other", "Changed since the lock."),
    });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const scan = yield* importer.scan({ _tag: "Folder", path: project });
        expect(scan.candidates.map((one) => [one.name, one.locked])).toEqual([
          ["other", { matches: false, url: "https://github.com/acme/skills" }],
          ["pnpm", { matches: true, url: "https://github.com/antfu/skills" }],
        ]);
        const [, pnpm] = yield* importer.add({ _tag: "Folder", path: project }, you);
        expect(pnpm?.revision).toMatchObject({ name: SkillName.make("pnpm"), commit: null, path: "skills/pnpm" });
        const sources = yield* (yield* SkillLibrary).sources;
        expect(sources.map((one) => one.origin)).toContainEqual({
          _tag: "Git",
          url: "https://github.com/antfu/skills",
          ref: null,
        });
      }),
    );
  });

  it("[TC-AG-131] imports a skill written in Hobbots, with no source", async () => {
    const { layer } = await importerLayer();
    await runWith(layer)(
      Effect.gen(function* () {
        const written = { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("commit-style") }] } as const;
        const [added] = yield* (yield* SkillImporter).add(written, you);
        expect(added?.revision).toMatchObject({ sourceId: null, commit: null, path: null });
        expect(yield* (yield* SkillLibrary).sources).toEqual([]);
        const outside = { _tag: "Written", files: [...written.files, { path: "../x.md", text: "x" }] } as const;
        expect(yield* Effect.flip((yield* SkillImporter).add(outside, you))).toMatchObject({ check: "outside-path" });
      }),
    );
  });
});
