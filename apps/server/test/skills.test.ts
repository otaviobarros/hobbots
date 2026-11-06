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
    const stale = await request("POST", `/api/skills/${skill.id}/edits`, { ...edit, base: "0".repeat(64) });
    expect(stale.status).toBe(404);
  });
});
