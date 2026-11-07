import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SkillFiles, SkillLibrary } from "@hobbots/agents";
import { SkillName } from "@hobbots/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { checkSet } from "../src/check.ts";
import { decodeSkillsLock, SKILLS_LOCK_FILE, SkillImporter, writeSkillExport } from "../src/index.ts";
import { folderTree } from "../src/sources/folder.ts";
import { type Fixture, folderOf, importerLayer, repositoryOf, runWith, skillMd, temp } from "./fixtures.ts";

// #1143: importing a plugin, or a repository's folder of skills that share files, as one set (ADR 029, Skill sets).

const you = { by: { _tag: "You" } } as const;

/** A skill that links to the set's shared rules and to a sibling skill, as agent-engineering's do. */
const linking = (name: string, sibling: string) =>
  skillMd(name, `What ${name} is for.`).replace(
    `Steps for ${name}.`,
    `First read the [contract](../../references/workflow-contract.md). Then [${sibling}](../${sibling}/SKILL.md).`,
  );

/** agent-engineering v0.5.0 as laid out on GitHub, cut to three of its nine skills. */
const agentEngineering = (version = "0.5.0"): Fixture => ({
  "plugin.json": JSON.stringify({ name: "agent-engineering", version, description: "A playbook for coding agents." }),
  ".claude-plugin/plugin.json": JSON.stringify({
    name: "agent-engineering",
    version,
    description: "A playbook for coding agents.",
  }),
  ".claude-plugin/marketplace.json": JSON.stringify({
    name: "agent-engineering",
    plugins: [{ name: "agent-engineering", source: "./" }],
  }),
  ".agents/plugins/marketplace.json": JSON.stringify({ name: "agent-engineering", plugins: [] }),
  "README.md": "# Agent engineering\n",
  "assets/icon.png": "not really a picture",
  "skills/deliver-change/SKILL.md": linking("deliver-change", "plan-change"),
  "skills/plan-change/SKILL.md": linking("plan-change", "implement-change"),
  "skills/implement-change/SKILL.md": skillMd("implement-change"),
  "skills/setup-project/SKILL.md": linking("setup-project", "plan-change"),
  // A template the project guide holds: its links point into the project it sets up, not into the set.
  "skills/setup-project/references/project-guide.md": "| Instructions | [Agent guide](../AGENTS.md) |\n",
  "references/workflow-contract.md": `# Shared workflow contract\n\nSee [verification](verification.md). Version ${version}.\n`,
  "references/verification.md": "# Verification\n",
  "references/unlinked.md": "No skill links here.\n",
});

const files = async (folder: string, prefix = ""): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = [];
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await files(folder, path)));
    else found.push(path);
  }
  return found.sort();
};

describe("skill sets", () => {
  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-01] imports agent-engineering from Git as one set: its skills and the files they link to, as laid out", async () => {
    const { layer } = await importerLayer();
    const repository = await repositoryOf(agentEngineering());
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const source = { _tag: "Git", url: repository.url, ref: null } as const;
        const scan = yield* importer.scan(source);
        expect(scan.candidates).toHaveLength(1);
        const [candidate] = scan.candidates;
        expect(candidate).toMatchObject({ folder: "", name: "agent-engineering", label: "0.5.0", refusal: null });
        expect(candidate?.description).toBe("A playbook for coding agents.");
        expect(candidate?.set?.skills.map((skill) => skill.name)).toEqual([
          "deliver-change",
          "implement-change",
          "plan-change",
          "setup-project",
        ]);
        const [added] = yield* importer.add(source, you);
        expect(added?.revision).toMatchObject({ name: "agent-engineering", label: "0.5.0", commit: repository.commit });
        const folder = (yield* (yield* SkillFiles).folder(added?.revision.hash ?? ("" as never))) ?? "";
        // Its skills and what they link to, nothing else of the plugin.
        expect(yield* Effect.promise(() => files(folder))).toEqual([
          "references/verification.md",
          "references/workflow-contract.md",
          "skills/deliver-change/SKILL.md",
          "skills/implement-change/SKILL.md",
          "skills/plan-change/SKILL.md",
          "skills/setup-project/SKILL.md",
          "skills/setup-project/references/project-guide.md",
        ]);
        // The links resolve inside the stored set as they did in the plugin.
        const deliver = join(folder, "skills", "deliver-change");
        const contract = yield* Effect.promise(() =>
          readFile(join(deliver, "..", "..", "references", "workflow-contract.md"), "utf8"),
        );
        expect(contract).toContain("Shared workflow contract");
        const sibling = yield* Effect.promise(() => readFile(join(deliver, "..", "plan-change", "SKILL.md"), "utf8"));
        expect(sibling).toContain("name: plan-change");
        expect((yield* (yield* SkillLibrary).list).map((skill) => skill.name)).toEqual(["agent-engineering"]);
      }),
    );
  });

  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-02] refuses a link outside the set's root, naming the file and the rule", async () => {
    const { layer } = await importerLayer();
    const plugin = await folderOf({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "leaky" }),
      "skills/one/SKILL.md": linking("one", "two"),
      "skills/two/SKILL.md": skillMd("two").replace("Steps for two.", "See [secrets](../../../outside.md)."),
      "references/workflow-contract.md": "Rules.\n",
    });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const [candidate] = (yield* importer.scan({ _tag: "Folder", path: plugin })).candidates;
        expect(candidate?.refusal).toMatchObject({
          check: "outside-path",
          path: "skills/two/SKILL.md",
          message: "skills/two/SKILL.md links to ../../../outside.md, outside the set.",
        });
        expect(yield* Effect.flip(importer.add({ _tag: "Folder", path: plugin }, you))).toMatchObject({
          _tag: "SkillRefused",
          check: "outside-path",
        });
        expect(yield* (yield* SkillLibrary).list).toEqual([]);
      }),
    );
  });

  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-03] takes a repository's folder of skills that share files as a set named after the folder", async () => {
    const { layer } = await importerLayer();
    const repository = await folderOf({
      "tools/playbook/skills/one/SKILL.md": linking("one", "two"),
      "tools/playbook/skills/two/SKILL.md": skillMd("two"),
      "tools/playbook/references/workflow-contract.md": "Rules.\n",
      "tools/other/SKILL.md": skillMd("other"),
    });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const scan = yield* importer.scan({ _tag: "Folder", path: repository });
        expect(scan.candidates.map((one) => [one.folder, one.name, one.set?.skills.length ?? null])).toEqual([
          ["tools/other", "other", null],
          ["tools/playbook", "playbook", 2],
        ]);
        expect(scan.candidates[1]?.description).toBe("Skills: one, two.");
      }),
    );
  });

  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-04] refuses a set named like Hobbots' own plugin, or with two skills of one name", async () => {
    const { layer } = await importerLayer();
    const reserved = await folderOf({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "hobbots-skills" }),
      "skills/one/SKILL.md": skillMd("one"),
    });
    const twice = await folderOf({
      ".codex-plugin/plugin.json": JSON.stringify({ name: "twice" }),
      "skills/one/SKILL.md": skillMd("one"),
      "more/one/SKILL.md": skillMd("one"),
    });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const [named] = (yield* importer.scan({ _tag: "Folder", path: reserved })).candidates;
        expect(named?.refusal).toMatchObject({ check: "front-matter", path: ".claude-plugin/plugin.json" });
        const [doubled] = (yield* importer.scan({ _tag: "Folder", path: twice })).candidates;
        expect(doubled?.refusal).toMatchObject({ check: "front-matter", path: "skills/one/SKILL.md" });
      }),
    );
  });

  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-05] makes one revision per distinct content of the whole set", async () => {
    const { layer } = await importerLayer();
    const repository = await repositoryOf(agentEngineering());
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const source = { _tag: "Git", url: repository.url, ref: null } as const;
        const [first] = yield* importer.add(source, you);
        const [again] = yield* importer.add(source, you);
        expect(again).toMatchObject({ added: false, revision: { hash: first?.revision.hash, number: 1 } });
        // A change to a shared file the skills link to is a new revision of the set.
        repository.git("rm", "--quiet", "README.md");
        yield* Effect.promise(() =>
          import("node:fs/promises").then((fs) =>
            fs.writeFile(
              join(repository.root, "references", "workflow-contract.md"),
              "# Shared workflow contract\n\nv0.6.0\n",
            ),
          ),
        );
        repository.git("commit", "--quiet", "--all", "--message", "v0.6.0");
        const [next] = yield* importer.add(source, { ...you, skillId: first?.skill.id ?? ("" as never) });
        expect(next).toMatchObject({ added: true, revision: { number: 2, name: "agent-engineering" } });
        // A file nothing links to changes nothing.
        expect(first?.revision.files.map((file) => file.path)).not.toContain("README.md");
      }),
    );
  });

  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-06] refuses an edit in Hobbots of a set, and a set as a revision of one skill", async () => {
    const { layer } = await importerLayer();
    const repository = await repositoryOf(agentEngineering());
    const loose = await folderOf({ "SKILL.md": skillMd("agent-engineering") });
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const [set] = yield* importer.add({ _tag: "Git", url: repository.url, ref: null }, you);
        if (set === undefined) return expect.unreachable();
        const folder = (yield* (yield* SkillFiles).folder(set.revision.hash)) ?? "";
        const edit = {
          _tag: "Edited",
          folder,
          description: "Another description.",
          instructions: "Other steps.",
          carried: { charms: [], dropped: [] },
        } as const;
        const edited = yield* Effect.flip(importer.add(edit, { ...you, skillId: set.skill.id }));
        expect(edited).toMatchObject({ _tag: "SkillRefused", check: "set", path: null });
        expect(edited.message).toContain("Make a copy");
        const written = { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("agent-engineering") }] } as const;
        expect(yield* Effect.flip(importer.add(written, { ...you, skillId: set.skill.id }))).toMatchObject({
          check: "set",
        });
        // Nor does a loose skill take a set as its next revision.
        yield* (yield* SkillLibrary).remove(set.skill.id);
        const [one] = yield* importer.add({ _tag: "Folder", path: loose }, you);
        const toSet = yield* Effect.flip(
          importer.add(
            { _tag: "Git", url: repository.url, ref: null },
            { ...you, skillId: one?.skill.id ?? ("" as never) },
          ),
        );
        expect(toSet).toMatchObject({ _tag: "SkillRefused", check: "set" });
        expect((yield* (yield* SkillLibrary).revisions(one?.skill.id ?? ("" as never))).length).toBe(1);
      }),
    );
  });

  // covers ADR 029 (Skill sets, Backups, exports and Diagnostics), #1143
  it("[TC-OP-1143-01] exports a set as its folder with a manifest naming it, which another hub imports as the same set", async () => {
    const from = await importerLayer();
    const v5 = await folderOf(agentEngineering("0.5.0"));
    const v6 = await folderOf(agentEngineering("0.6.0"));
    const folder = await temp("export");
    const before = await runWith(from.layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const library = yield* SkillLibrary;
        const [r1] = yield* importer.add({ _tag: "Folder", path: v5 }, you);
        if (r1 === undefined) return expect.unreachable();
        const [r2] = yield* importer.add({ _tag: "Folder", path: v6 }, { ...you, skillId: r1.skill.id });
        if (r2 === undefined) return expect.unreachable();
        const base = { skillId: r1.skill.id, onlyWhenAsked: false, by: { _tag: "You" } } as const;
        yield* library.assign({ ...base, scope: { _tag: "Everyone" }, pin: r2.revision.hash, held: false });
        yield* library.assign({
          ...base,
          scope: { _tag: "Hob", agentId: "pip" as never },
          pin: r1.revision.hash,
          held: true,
        });
        yield* writeSkillExport(folder, {
          assignments: true,
          hobName: () => "Pip",
          exportedAt: "2026-11-07T10:00:00.000Z",
        });
        return [r1.revision, r2.revision];
      }),
    );
    const manifest = JSON.parse(
      await readFile(join(folder, "agent-engineering", ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(manifest).toEqual({
      name: "agent-engineering",
      description: "A playbook for coding agents.",
      version: "0.6.0",
      skills: ["./skills"],
    });
    const lock = decodeSkillsLock(await readFile(join(folder, SKILLS_LOCK_FILE), "utf8"));
    expect(lock._tag === "Some" ? lock.value.skills[0]?.set : null).toEqual({
      skills: ["deliver-change", "implement-change", "plan-change", "setup-project"],
    });

    const to = await importerLayer();
    await runWith(to.layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const scan = yield* importer.scan({ _tag: "Folder", path: folder });
        expect(
          scan.candidates.map((one) => [one.folder, one.name, one.exported?.matches, one.exported?.older.length]),
        ).toEqual([["agent-engineering", "agent-engineering", true, 1]]);
        const added = yield* importer.addSet(
          { _tag: "Folder", path: folder },
          {
            ...you,
            scanned: new Map(scan.candidates.flatMap((one) => (one.hash === null ? [] : [[one.folder, one.hash]]))),
            scannedLock: scan.exported?.lock ?? null,
            placeHob: () => Effect.succeed("pip" as never),
            hasProject: () => Effect.succeed(false),
          },
        );
        expect(added.assigned).toHaveLength(2);
        const library = yield* SkillLibrary;
        const [skill] = yield* library.list;
        const revisions = [...(yield* library.revisions(skill?.id ?? ("" as never)))].reverse();
        expect(revisions.map((one) => [one.hash, one.label, one.set?.skills.length])).toEqual(
          before.map((one) => [one.hash, one.label, 4]),
        );
      }),
    );
  });

  // covers ADR 029 (Import checks, Skill sets), #1143
  it("[TC-AG-1143-14] refuses a set over the limits before reading the files that take it over", async () => {
    const big = "x".repeat(6 * 1024 * 1024);
    const folder = await folderOf({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "heavy" }),
      "skills/one/SKILL.md": skillMd("one"),
      "skills/one/assets/huge.bin": big,
    });
    const tree = await folderTree(folder);
    const read: Array<string> = [];
    const watched = { ...tree, read: (path: string) => (read.push(path), tree.read(path)) };
    const set = { folder: "", skills: ["skills/one"], manifest: ".claude-plugin/plugin.json", dropped: [] };
    const result = await checkSet(watched, set, null);
    expect(result).toMatchObject({ _tag: "Refused", refusal: { check: "too-large", path: null } });
    expect(read).not.toContain("skills/one/assets/huge.bin");
    await (tree as { close?: () => Promise<void> }).close?.();
  });

  // covers ADR 029 (Skill sets), #1143
  it("[TC-AG-1143-15] copies one skill of a set as a skill of its own, with the set's files it links to and its links pointed at them", async () => {
    const { layer } = await importerLayer();
    const repository = await repositoryOf(agentEngineering());
    await runWith(layer)(
      Effect.gen(function* () {
        const importer = yield* SkillImporter;
        const [set] = yield* importer.add({ _tag: "Git", url: repository.url, ref: null }, you);
        const member = set?.revision.set?.skills.find((one) => one.name === "deliver-change");
        if (set === undefined || member === undefined) return expect.unreachable();
        const folder = (yield* (yield* SkillFiles).folder(set.revision.hash)) ?? "";
        const source = {
          _tag: "Copied",
          folder,
          name: SkillName.make("deliver-change-copy"),
          carried: { charms: [], dropped: [] },
          member,
        } as const;
        const [copy] = yield* importer.add(source, you);
        expect(copy?.revision).toMatchObject({ name: "deliver-change-copy", number: 1, set: null, sourceId: null });
        const copied = (yield* (yield* SkillFiles).folder(copy?.revision.hash ?? ("" as never))) ?? "";
        // Its folder at the top; what it links to, directly or through those files, under linked/. Another
        // skill's SKILL.md is named after its folder, and a file nothing reaches stays out.
        expect(yield* Effect.promise(() => files(copied))).toEqual([
          "SKILL.md",
          "linked/references/verification.md",
          "linked/references/workflow-contract.md",
          "linked/skills/implement-change/implement-change.md",
          "linked/skills/plan-change/plan-change.md",
        ]);
        const skill = yield* Effect.promise(() => readFile(join(copied, "SKILL.md"), "utf8"));
        expect(skill).toContain("name: deliver-change-copy");
        expect(skill).toContain("[contract](linked/references/workflow-contract.md)");
        expect(skill).toContain("[plan-change](linked/skills/plan-change/plan-change.md)");
        const plan = yield* Effect.promise(() =>
          readFile(join(copied, "linked", "skills", "plan-change", "plan-change.md"), "utf8"),
        );
        // A link between two files it brings keeps working from their new places.
        expect(plan).toContain("[contract](../../references/workflow-contract.md)");
        expect(plan).toContain("[implement-change](../implement-change/implement-change.md)");
        // The set itself is unchanged.
        expect(yield* Effect.promise(() => files(folder))).toContain("skills/deliver-change/SKILL.md");
      }),
    );
  });
});
