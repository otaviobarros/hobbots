import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  HobTools,
  PermissionSummary,
  RuntimeAdapter,
} from "@hobbots/agents";
import { roleFields } from "@hobbots/domain";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  SkillLibraryLive,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { SkillsLive } from "../src/skills.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// #1060: the skills library's routes (ADR 029, Import), over the hub's database, SQLite or PostgreSQL.

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let agentsFolder: string;

const skillMd = (name: string, description = `What ${name} is for.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const folderWith = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "hobbots-skill-route-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
};

beforeEach(async () => {
  const data = await mkdtemp(join(tmpdir(), "hobbots-skill-data-"));
  agentsFolder = await folderWith({ "shared/SKILL.md": skillMd("shared") });
  const Persistence = Layer.mergeAll(
    HobbotsRepositoryLive,
    ApprovalRepositoryLive,
    GrantRepositoryLive,
    TaskRepositoryLive,
    EventJournal.layer,
    BackpackLive,
    SetupRepository.layer,
    SearchIndex.layer,
    SkillLibraryLive,
  ).pipe(Layer.provideMerge(TestDatabase));
  const App = HobLifecycle.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
        ApprovalService.layer,
        GrantService.layer,
        HobService.layer,
        PermissionSummary.layer,
      ),
    ),
    Layer.provideMerge(SkillsLive(data, agentsFolder)),
    Layer.provideMerge(
      Layer.mergeAll(
        Persistence,
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        Layer.succeed(RuntimeAdapter, makeFakeRuntime()),
        Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: data }),
      ),
    ),
  );
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(Layer.provide(TestDevices), Layer.provide(App), Layer.provide(NodeHttpServer.layerHttpServices)),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});

afterEach(() => dispose());

const request = async (method: string, path: string, body?: unknown) => {
  const response = await handler(
    new Request(`http://localhost:4364${path}`, {
      method,
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

describe("skills routes", () => {
  // covers ADR 029 (Import, Storage and revisions), #1060
  it("[TC-AG-134] lists, reads, imports, revises and removes skills, and shows ~/.agents/skills under Everyone", async () => {
    const listed = await request("GET", "/api/skills");
    expect(listed.status).toBe(200);
    expect(listed.body.skills.map((skill: { name: string }) => skill.name)).toEqual(["shared"]);
    expect(listed.body.agentsFolder).toEqual({ path: agentsFolder, problems: [] });
    const shared = await request("GET", `/api/skills/${listed.body.skills[0].id}`);
    expect(shared.body.assignments.map((one: { scope: unknown }) => one.scope)).toEqual([{ _tag: "Everyone" }]);

    const folder = await folderWith({ "SKILL.md": skillMd("release"), "notes.md": "See https://example.com." });
    const scanned = await request("POST", "/api/skills/scan", { source: { _tag: "Folder", path: folder } });
    expect(scanned.body.candidates).toMatchObject([{ folder: "", name: "release", existing: null }]);

    const imported = await request("POST", "/api/skills", { source: { _tag: "Folder", path: folder } });
    expect(imported.status).toBe(200);
    const [{ skill, revision, added }] = imported.body.imported;
    expect(added).toBe(true);
    expect(revision.flags).toEqual([{ _tag: "Url", path: "notes.md", url: "https://example.com" }]);
    const again = await request("POST", "/api/skills", { source: { _tag: "Folder", path: folder } });
    expect(again.body.imported[0]).toMatchObject({ added: false, revision: { hash: revision.hash } });

    const read = await request("GET", `/api/skills/${skill.id}/revisions/${revision.hash}`);
    expect(read.body.instructions).toBe(skillMd("release"));

    const written = { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("release", "Releases, now.") }] };
    const revised = await request("POST", `/api/skills/${skill.id}/revisions`, { source: written });
    expect(revised.body).toMatchObject({ added: true, revision: { number: 2, sourceId: null } });
    const detail = await request("GET", `/api/skills/${skill.id}`);
    expect(detail.body.revisions.map((one: { number: number }) => one.number)).toEqual([2, 1]);

    // The same content is the revision it already is; other content of that name is a conflict.
    expect((await request("POST", "/api/skills", { source: written })).body.imported[0].added).toBe(false);
    const other = { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("release", "Another.") }] };
    const taken = await request("POST", "/api/skills", { source: other });
    expect(taken).toMatchObject({ status: 409, body: { _tag: "SkillNameConflict", skillId: skill.id } });

    expect((await request("DELETE", `/api/skills/${skill.id}`)).status).toBe(200);
    expect((await request("GET", `/api/skills/${skill.id}`)).status).toBe(404);
  });

  it("[TC-AG-135] refuses what fails a check with the rule and the file, and a skill something assigns", async () => {
    const broken = { _tag: "Written", files: [{ path: "SKILL.md", text: "# No front matter" }] };
    const refused = await request("POST", "/api/skills", { source: broken });
    expect(refused).toMatchObject({
      status: 422,
      body: { _tag: "SkillImportRefused", check: "front-matter", path: "SKILL.md" },
    });
    const missing = await request("POST", "/api/skills/scan", { source: { _tag: "Folder", path: "/no/such/folder" } });
    expect(missing).toMatchObject({ status: 422, body: { _tag: "SkillSourceNotRead" } });

    const listed = await request("GET", "/api/skills");
    const sharedId = listed.body.skills[0].id;
    const inUse = await request("DELETE", `/api/skills/${sharedId}`);
    expect(inUse).toMatchObject({ status: 409, body: { _tag: "SkillStillAssigned", skillId: sharedId } });
    expect(inUse.body.assignments).toHaveLength(1);
  });
  // covers ADR 029 (Storage and revisions, The Skills page), #1062
  it("[TC-AG-146] reads a revision's files only by the paths it lists, and edits a skill into a new revision", async () => {
    const folder = await folderWith({
      "SKILL.md": skillMd("release"),
      "references/checks.md": "Check the banner.",
      "logo.bin": "\u0000\u0001",
    });
    const imported = await request("POST", "/api/skills", { source: { _tag: "Folder", path: folder } });
    const [{ skill, revision }] = imported.body.imported;
    const at = `/api/skills/${skill.id}/revisions/${revision.hash}/file`;

    const checks = await request("GET", `${at}?path=references%2Fchecks.md`);
    expect(checks.body).toEqual({ path: "references/checks.md", mode: "regular", size: 17, text: "Check the banner." });
    expect((await request("GET", `${at}?path=logo.bin`)).body).toMatchObject({ path: "logo.bin", text: null });
    // A path the revision does not list is not read, whatever it names.
    expect((await request("GET", `${at}?path=..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await request("GET", `${at}?path=missing.md`)).status).toBe(404);

    const edit = { base: revision.hash, description: "Use when releasing.", instructions: "Tag, then push." };
    const edited = await request("POST", `/api/skills/${skill.id}/edits`, edit);
    expect(edited.body).toMatchObject({ added: true, revision: { number: 2, description: "Use when releasing." } });
    expect(edited.body.revision.files.map((file: { path: string }) => file.path)).toEqual([
      "SKILL.md",
      "logo.bin",
      "references/checks.md",
    ]);
    const read = await request("GET", `/api/skills/${skill.id}/revisions/${edited.body.revision.hash}`);
    expect(read.body.instructions).toBe(
      "---\nname: release\ndescription: Use when releasing.\n---\n\nTag, then push.\n",
    );
    const missing = await request("POST", `/api/skills/${skill.id}/edits`, { ...edit, base: "0".repeat(64) });
    expect(missing.status).toBe(404);

    // An edit made from r1 after r2 was saved is refused, and saves nothing: r2 stays the newest.
    const stale = await request("POST", `/api/skills/${skill.id}/edits`, { ...edit, instructions: "Only tag." });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ _tag: "SkillEditStale", latest: edited.body.revision.hash });
    const after = await request("GET", `/api/skills/${skill.id}`);
    expect(after.body.skill).toMatchObject({ revisions: 2, latest: edited.body.revision.hash });
  });

  // covers ADR 029 (~/.agents/skills stays, through Hobbots; Make a copy), #1139
  it("[TC-AG-163] refuses an edit or a revision of a ~/.agents/skills skill, and Make a copy gives an editable one", async () => {
    const listed = await request("GET", "/api/skills");
    const [shared] = listed.body.skills;
    const edit = { base: shared.latest, description: "Changed here.", instructions: "Changed." };
    const refused = await request("POST", `/api/skills/${shared.id}/edits`, edit);
    expect(refused).toMatchObject({
      status: 409,
      body: { _tag: "SkillIsReadOnly", name: "shared", folder: `${agentsFolder}/shared` },
    });
    const written = { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("shared", "Forked.") }] };
    const revised = await request("POST", `/api/skills/${shared.id}/revisions`, { source: written });
    expect(revised.body._tag).toBe("SkillIsReadOnly");
    expect((await request("GET", `/api/skills/${shared.id}`)).body.skill.revisions).toBe(1);

    // A copy: r1, the same files, no source, given to no one unless you pick a scope.
    const copied = await request("POST", `/api/skills/${shared.id}/copies`, { name: "shared-copy" });
    expect(copied.status).toBe(200);
    expect(copied.body).toMatchObject({
      added: true,
      assignment: null,
      skill: { name: "shared-copy", revisions: 1, sourceId: null },
    });
    const read = await request("GET", `/api/skills/${copied.body.skill.id}/revisions/${copied.body.revision.hash}`);
    // Only its name changes; every other line is the original's.
    expect(read.body.instructions).toBe("---\nname: shared-copy\ndescription: What shared is for.\n---\n\n# shared\n");
    const copyEdit = { base: copied.body.revision.hash, description: "Mine.", instructions: "Mine." };
    const edited = await request("POST", `/api/skills/${copied.body.skill.id}/edits`, copyEdit);
    expect(edited.body).toMatchObject({ added: true, revision: { number: 2 } });

    // A second copy under that name is refused; one given to Everyone has its assignment.
    const again = await request("POST", `/api/skills/${shared.id}/copies`, { name: "shared-copy" });
    expect(again).toMatchObject({ status: 409, body: { _tag: "SkillNameConflict" } });
    const given = await request("POST", `/api/skills/${shared.id}/copies`, {
      name: "shared-everyone",
      scope: { _tag: "Everyone" },
    });
    expect(given.body.assignment).toMatchObject({ scope: { _tag: "Everyone" }, pin: given.body.revision.hash });

    // The folder moves to r2 and back: r2 stays the newest, but a copy takes what the folder holds now.
    const file = join(agentsFolder, "shared", "SKILL.md");
    await writeFile(file, skillMd("shared", "Changed in the folder."));
    await request("POST", "/api/skills/agents-folder/sync");
    await writeFile(file, skillMd("shared"));
    await request("POST", "/api/skills/agents-folder/sync");
    expect((await request("GET", `/api/skills/${shared.id}`)).body.skill.revisions).toBe(2);
    const older = await request("POST", `/api/skills/${shared.id}/copies`, { name: "shared-older" });
    expect(older.status).toBe(200);
    const olderRead = await request("GET", `/api/skills/${older.body.skill.id}/revisions/${older.body.revision.hash}`);
    expect(olderRead.body.instructions).toBe(
      "---\nname: shared-older\ndescription: What shared is for.\n---\n\n# shared\n",
    );
  });

  // covers ADR 029 (Scopes, The Skills page), #1062
  it("[TC-AG-148] lists the projects a skill can go to: those hobs work in, before any skill is given to them", async () => {
    const site = join(await mkdtemp(join(tmpdir(), "skills-")), "Site");
    await mkdir(site);
    expect((await request("GET", "/api/skills")).body.projects).toEqual([]);
    await request("PATCH", "/api/setup", { safetyPreset: "balanced", approvedFolders: [site] });
    const hob = {
      name: "Wren",
      ...roleFields("writer"),
      lookSeed: 7,
      lookColor: "moss",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    };
    expect((await request("POST", "/api/agents", hob)).status).toBe(200);
    // A folder with no Git remote is its own project, by its name.
    expect((await request("GET", "/api/skills")).body.projects).toEqual(["site"]);
  });

  // covers ADR 029 (Pins and rollout, The Skills page), #1062
  it("[TC-AG-149] keeps the places an edit holds back, changes no hold when it is refused, and never replays its holds", async () => {
    const folder = await folderWith({ "SKILL.md": skillMd("release") });
    const imported = await request("POST", "/api/skills", { source: { _tag: "Folder", path: folder } });
    const [{ skill, revision }] = imported.body.imported;
    const everyone = await request("POST", `/api/skills/${skill.id}/assignments`, { scope: { _tag: "Everyone" } });
    const place = async () => (await request("GET", `/api/skills/${skill.id}`)).body.assignments[0];
    const keep = [{ assignmentId: everyone.body.id, held: true }];
    const edit = { base: revision.hash, description: "Use when releasing.", instructions: "Tag it." };

    // A refused edit changes no hold.
    const r2 = await request("POST", `/api/skills/${skill.id}/edits`, edit);
    expect(r2.body.rolledOut).toHaveLength(1);
    const stale = await request("POST", `/api/skills/${skill.id}/edits`, {
      ...edit,
      instructions: "Push.",
      holds: keep,
    });
    expect(stale.status).toBe(409);
    expect(await place()).toMatchObject({ pin: r2.body.revision.hash, held: false });

    // Saved as r3 with Everyone kept on r2.
    const next = { ...edit, base: r2.body.revision.hash, instructions: "Tag, then push.", holds: keep };
    const r3 = await request("POST", `/api/skills/${skill.id}/edits`, next);
    expect(r3.body).toMatchObject({ added: true, revision: { number: 3 }, rolledOut: [] });
    expect(await place()).toMatchObject({ pin: r2.body.revision.hash, held: true });

    // Its answer was lost, Everyone was let go on another device, and the save is sent again: it is
    // r3, and the hold it carried is not set over the newer choice.
    await request("POST", `/api/skills/assignments/${everyone.body.id}/hold`, { held: false });
    const again = await request("POST", `/api/skills/${skill.id}/edits`, next);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ added: false, revision: { number: 3 }, rolledOut: [] });
    expect(await place()).toMatchObject({ pin: r2.body.revision.hash, held: false });
  });

  // covers ADR 029 (The Skills page, Journal events), #1062
  it("[TC-AG-151] What changed lists each save with what its rollout moved and held, rollbacks, and skills given or removed", async () => {
    const folder = await folderWith({ "SKILL.md": skillMd("release") });
    const imported = await request("POST", "/api/skills", { source: { _tag: "Folder", path: folder } });
    const [{ skill, revision }] = imported.body.imported;
    const everyone = await request("POST", `/api/skills/${skill.id}/assignments`, { scope: { _tag: "Everyone" } });
    const edit = { base: revision.hash, description: "Use when releasing.", instructions: "Tag it." };
    const r2 = await request("POST", `/api/skills/${skill.id}/edits`, edit);
    const r3 = await request("POST", `/api/skills/${skill.id}/edits`, {
      ...edit,
      base: r2.body.revision.hash,
      instructions: "Tag, then push.",
      holds: [{ assignmentId: everyone.body.id, held: true }],
    });
    expect(r3.body.revision.number).toBe(3);
    await request("POST", `/api/skills/assignments/${everyone.body.id}/roll-out`, { pin: revision.hash });
    const gone = await folderWith({ "SKILL.md": skillMd("gone") });
    const added = await request("POST", "/api/skills", { source: { _tag: "Folder", path: gone } });
    await request("DELETE", `/api/skills/${added.body.imported[0].skill.id}`);

    const { status, body } = await request("GET", "/api/skills/changes");
    expect(status).toBe(200);
    // A removed skill keeps its name, newest first.
    expect(body.changes.slice(0, 2).map((one: { kind: string; name: string }) => [one.kind, one.name])).toEqual([
      ["removed", "gone"],
      ["saved", "gone"],
    ]);
    const release = body.changes.filter((one: { skillId: string }) => one.skillId === skill.id);
    const everyoneScope = { _tag: "Everyone" };
    expect(
      release.map((one: { kind: string; number: number | null; scopes: unknown; held: unknown }) => ({
        kind: one.kind,
        number: one.number,
        scopes: one.scopes,
        held: one.held,
      })),
    ).toEqual([
      { kind: "rolledOut", number: 1, scopes: [everyoneScope], held: [] },
      { kind: "saved", number: 3, scopes: [], held: [everyoneScope] },
      { kind: "saved", number: 2, scopes: [everyoneScope], held: [] },
      { kind: "assigned", number: 1, scopes: [everyoneScope], held: [] },
      { kind: "saved", number: 1, scopes: [], held: [] },
    ]);
    // A save's Roll back goes to the revision before it, for the places its rollout moved.
    expect(release[2]).toMatchObject({
      moved: [{ assignmentId: everyone.body.id, from: revision.hash }],
      previous: revision.hash,
      previousNumber: 1,
      by: { _tag: "You" },
    });
    expect(release[0]).toMatchObject({
      moved: [{ assignmentId: everyone.body.id, from: r2.body.revision.hash }],
      previous: r2.body.revision.hash,
      previousNumber: 2,
    });
  });

  // covers ADR 029 (Pins and rollout, The Skills page), #1062
  it("[TC-AG-160] a save that moves places from different revisions keeps where each came from, for Roll back", async () => {
    const hob = {
      name: "Wren",
      ...roleFields("writer"),
      lookSeed: 7,
      lookColor: "moss",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    };
    const wren = await request("POST", "/api/agents", hob);
    const folder = await folderWith({ "SKILL.md": skillMd("release") });
    const imported = await request("POST", "/api/skills", { source: { _tag: "Folder", path: folder } });
    const [{ skill, revision }] = imported.body.imported;
    const everyone = await request("POST", `/api/skills/${skill.id}/assignments`, { scope: { _tag: "Everyone" } });
    const own = await request("POST", `/api/skills/${skill.id}/assignments`, {
      scope: { _tag: "Hob", agentId: wren.body.id },
    });
    const edit = { base: revision.hash, description: "Use when releasing.", instructions: "Tag it." };
    const r2 = await request("POST", `/api/skills/${skill.id}/edits`, edit);
    // Wren goes back to r1 while Everyone stays on r2; r3 then moves both, each from its own revision.
    await request("POST", `/api/skills/assignments/${own.body.id}/roll-out`, { pin: revision.hash });
    await request("POST", `/api/skills/${skill.id}/edits`, {
      ...edit,
      base: r2.body.revision.hash,
      instructions: "Tag, then push.",
    });

    const { body } = await request("GET", "/api/skills/changes");
    const [save] = body.changes.filter((one: { skillId: string }) => one.skillId === skill.id);
    expect(save).toMatchObject({ kind: "saved", number: 3, previous: null, previousNumber: null });
    expect(save.moved).toEqual(
      expect.arrayContaining([
        { assignmentId: everyone.body.id, from: r2.body.revision.hash },
        { assignmentId: own.body.id, from: revision.hash },
      ]),
    );
    expect(save.moved).toHaveLength(2);
  });
});
