import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
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
import { MemoryProjectsLive } from "@hobbots/memory";
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

// #1098: a repository's own skills (ADR 029, Scopes), over the hub's routes on its database, SQLite or
// PostgreSQL, with real Git repositories: an origin, and the clone a hob works in.

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

const skillMd = (name: string, description: string | null = `What ${name} is for.`) =>
  description === null
    ? `---\nname: ${name}\n---\n\n# ${name}\n`
    : `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const git = (folder: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const writeIn = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
};

beforeEach(async () => {
  const data = await mkdtemp(join(tmpdir(), "hobbots-skill-repo-data-"));
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
    Layer.provideMerge(SkillsLive(data, null)),
    Layer.provideMerge(
      Layer.mergeAll(
        Persistence,
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        // A project is its normalized Git origin, as for memory, so two clones share it.
        MemoryProjectsLive,
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

/**
 * An origin whose default branch holds skills in both folders, one that fails the checks, one kept
 * in both folders and one elsewhere in the repository; and a clone of it, which a hob works in.
 */
const repositoryWithSkills = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hobbots-skill-repo-")));
  const origin = join(root, "origin.git");
  const site = join(root, "site");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", "--quiet", `file://${origin}`, site], { stdio: "pipe" });
  git(site, "checkout", "--quiet", "-B", "main");
  await writeIn(site, {
    ".claude/skills/triage/SKILL.md": skillMd("triage"),
    ".claude/skills/old-macros/SKILL.md": skillMd("old-macros", null),
    ".agents/skills/refunds/SKILL.md": skillMd("refunds"),
    ".agents/skills/triage/SKILL.md": skillMd("triage"),
    "docs/skills/elsewhere/SKILL.md": skillMd("elsewhere"),
  });
  git(site, "add", "--all");
  git(site, "commit", "--quiet", "--message", "skills");
  git(site, "push", "--quiet", "origin", "main");
  const hob = {
    name: "Bram",
    ...roleFields("writer"),
    lookSeed: 7,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  };
  await request("PATCH", "/api/setup", { safetyPreset: "balanced", approvedFolders: [site] });
  const created = await request("POST", "/api/agents", hob);
  expect(created.status).toBe(200);
  return { site, agentId: created.body.id as string };
};

describe("a repository's own skills", () => {
  // covers ADR 029 (Scopes), #1098
  it("[TC-AG-1098-01] offers a repository's skills once, and imports them from its default branch into the project", async () => {
    const { site, agentId } = await repositoryWithSkills();
    const listed = await request("GET", "/api/skill-repositories");
    expect(listed.status).toBe(200);
    const [repository] = listed.body.repositories;
    expect(listed.body.repositories).toHaveLength(1);
    expect(repository).toMatchObject({
      folder: site,
      agentId,
      skills: [".agents/skills/refunds", ".agents/skills/triage", ".claude/skills/old-macros", ".claude/skills/triage"],
      offered: true,
    });
    // The project is the one the Skills page gives skills to, as hobs' turns resolve it.
    expect((await request("GET", "/api/skills")).body.projects).toEqual([repository.project]);
    // Nothing is in the library until you import it.
    expect((await request("GET", "/api/skills")).body.skills).toEqual([]);

    const scanned = await request("POST", "/api/skill-repositories/scan", { project: repository.project });
    expect(scanned.status).toBe(200);
    const { candidates, commit } = scanned.body.scan;
    expect(commit).toBe(git(site, "rev-parse", "HEAD"));
    // Only its own folders, and the skill kept the same in both of them once.
    expect(candidates.map((one: { folder: string }) => one.folder)).toEqual([
      ".agents/skills/refunds",
      ".agents/skills/triage",
      ".claude/skills/old-macros",
    ]);
    expect(candidates[2].refusal).not.toBeNull();

    // A folder outside them is not this repository's skill.
    const elsewhere = await request("POST", "/api/skill-repositories/import", {
      project: repository.project,
      scanned: [{ folder: "docs/skills/elsewhere", hash: candidates[0].hash }],
    });
    expect(elsewhere.status).toBe(404);

    const scannedOk = candidates
      .filter((one: { refusal: unknown }) => one.refusal === null)
      .map((one: { folder: string; hash: string }) => ({ folder: one.folder, hash: one.hash }));
    const imported = await request("POST", "/api/skill-repositories/import", {
      project: repository.project,
      scanned: scannedOk,
    });
    expect(imported.status).toBe(200);
    expect(imported.body.imported.map((one: { skill: { name: string } }) => one.skill.name)).toEqual([
      "refunds",
      "triage",
    ]);
    expect(imported.body.assigned.map((one: { scope: unknown }) => one.scope)).toEqual([
      { _tag: "Project", identity: repository.project },
      { _tag: "Project", identity: repository.project },
    ]);
    // Revisions like any skill from Git: read at the default branch's commit, from its folder there.
    expect(imported.body.imported[0].revision).toMatchObject({ number: 1, commit, path: ".agents/skills/refunds" });
    const sources = (await request("GET", "/api/skills")).body.sources;
    expect(sources.map((one: { origin: unknown }) => one.origin)).toEqual([
      { _tag: "Git", url: repository.url, ref: null },
    ]);
    // The hob working in the repository gets them, as the project's.
    const hob = await request("GET", `/api/skills/hobs/${agentId}`);
    expect(hob.body.skills.map((one: { name: string; scope: { _tag: string } }) => [one.name, one.scope._tag])).toEqual([
      ["refunds", "Project"],
      ["triage", "Project"],
    ]);

    // Offered once: after the import it is not offered again.
    expect((await request("GET", "/api/skill-repositories")).body.repositories[0].offered).toBe(false);
    // Until the repository holds a skill it did not hold then; Not now closes it again.
    await writeIn(site, { ".agents/skills/escalation/SKILL.md": skillMd("escalation") });
    expect((await request("GET", "/api/skill-repositories")).body.repositories[0].offered).toBe(true);
    const dismissed = await request("POST", "/api/skill-repositories/dismiss", { project: repository.project });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.repositories[0].offered).toBe(false);
    // A project no hob works in has no repository to read.
    expect((await request("POST", "/api/skill-repositories/scan", { project: "github.com/me/other" })).status).toBe(
      404,
    );
  });

  // covers ADR 029 (Scopes, Updates from a source), #1098
  it("[TC-AG-1098-02] keeps what a hob loads when a branch changes a skill, and shows a default-branch change as an update", async () => {
    const { site, agentId } = await repositoryWithSkills();
    const [repository] = (await request("GET", "/api/skill-repositories")).body.repositories;
    const { candidates } = (await request("POST", "/api/skill-repositories/scan", { project: repository.project })).body
      .scan;
    const triage = candidates.find((one: { name: string }) => one.name === "triage");
    await request("POST", "/api/skill-repositories/import", {
      project: repository.project,
      scanned: [{ folder: triage.folder, hash: triage.hash }],
    });
    const loaded = async () =>
      (await request("GET", `/api/skills/hobs/${agentId}`)).body.skills.map((one: { pin: string }) => one.pin);
    expect(await loaded()).toEqual([triage.hash]);

    // A branch changes the skill, in the clone the hob works in and on the origin.
    git(site, "checkout", "--quiet", "-b", "change-triage");
    await writeIn(site, {
      ".agents/skills/triage/SKILL.md": skillMd("triage", "Use when sorting the inbox, and run triage.sh."),
    });
    git(site, "commit", "--quiet", "--all", "--message", "change triage on a branch");
    git(site, "push", "--quiet", "origin", "change-triage");
    // What the hob loads stays the imported revision, and the branch is no update.
    expect(await loaded()).toEqual([triage.hash]);
    const onBranch = await request("POST", "/api/skill-updates/check");
    expect(onBranch.body.problems).toEqual([]);
    expect(onBranch.body.updates).toEqual([]);

    // The default branch changes it: that shows as an update, with its review, and nothing moves yet.
    git(site, "checkout", "--quiet", "main");
    await writeIn(site, { ".agents/skills/triage/SKILL.md": skillMd("triage", "Use when sorting the inbox.") });
    git(site, "commit", "--quiet", "--all", "--message", "describe triage");
    git(site, "push", "--quiet", "origin", "main");
    const checked = await request("POST", "/api/skill-updates/check");
    const [update] = checked.body.updates;
    expect(checked.body.updates).toHaveLength(1);
    expect(update).toMatchObject({
      name: "triage",
      base: triage.hash,
      path: ".agents/skills/triage",
      state: "waiting",
    });
    expect(update.instructions[0].after).toContain("Use when sorting the inbox.");
    expect(await loaded()).toEqual([triage.hash]);

    // Accepting it rolls it out to the project, as for any source.
    const accepted = await request("POST", `/api/skill-updates/${update.skillId}/accept`, {
      hash: update.hash,
      base: update.base,
    });
    expect(accepted.status).toBe(200);
    expect(await loaded()).toEqual([update.hash]);
  });
});
