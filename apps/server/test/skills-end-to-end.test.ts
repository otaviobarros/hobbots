import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  AdditionalRuntimes,
  ApprovalService,
  ChatService,
  GrantService,
  HobAdmission,
  HobLifecycle,
  HobService,
  PermissionSummary,
  type PromptRequest,
  RuntimeAdapter,
  type RuntimeAdapterShape,
  type SkillMount,
  SkillReviewsLive,
} from "@hobbots/agents";
import {
  type Agent,
  isInProgress,
  type Message,
  type RuntimeKind,
  roleFields,
  SKILL_PROPOSE_TOOL,
  type Thread,
} from "@hobbots/domain";
import { MemoryProjectsLive } from "@hobbots/memory";
import { PolicyEngine } from "@hobbots/permissions";
import {
  ApprovalRepositoryLive,
  BackpackLive,
  EventJournal,
  GrantRepositoryLive,
  HobbotsRepositoryLive,
  SearchIndex,
  SetupRepository,
  SkillLibraryLive,
  SkillProposalLogLive,
  TaskRepositoryLive,
} from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { makeFakeRuntime } from "@hobbots/runtimes";
import { SkillToolsLive } from "@hobbots/skills";
import { Effect, Layer, Option, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { CanonicalSharedFolders, NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { agentsSkillsFolder, SkillsLive } from "../src/skills.ts";
import { HobToolsLive } from "../src/tools.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// #1065: the skills library end to end on the hub (ADR 029, with the skill sets of #1143 and the
// read-only `~/.agents/skills` of #1139), through its HTTP routes, with the hub's
// own composition: the skills store and import, `~/.agents/skills` read from a fake home, the skill
// tools beside every turn, and a fake Claude Code and a fake Codex, each recording the skills every
// turn was given. The real runtimes' side of the clean runtime is their contract tests
// (`packages/runtimes/test/clean-runtime-*.test.ts`); here the hub hands each runtime only what the
// library gives, whatever the home folder's runtime setups hold.

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-skills-e2e-")));
const home = join(root, "home");
const dataDir = join(root, "data");
const project = join(root, "app");

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const skillMd = (name: string, description = `What ${name} is for.`, body = `Steps for ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
const git = (folder: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    encoding: "utf8",
  }).trim();

/** Skills installed in each runtime's own setup and in the project, which no hob may ever load. */
const FOREIGN = ["home-claude-skill", "home-plugin-skill", "home-codex-skill", "repo-claude-skill", "repo-codex-skill"];

// The home folder: Claude Code's and Codex's own setups, each with a skill, and the shared folder.
write(join(home, ".claude", "skills", "home-claude-skill", "SKILL.md"), skillMd("home-claude-skill"));
write(
  join(home, ".claude", "plugins", "local", "home-plugin", "skills", "home-plugin-skill", "SKILL.md"),
  skillMd("home-plugin-skill"),
);
write(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "home-plugin@local": true } }));
write(join(home, ".codex", "skills", "home-codex-skill", "SKILL.md"), skillMd("home-codex-skill"));
write(join(home, ".agents", "skills", "house-style", "SKILL.md"), skillMd("house-style"));
// The project both hobs work in, a Git clone with skills of its own.
write(join(project, ".claude", "skills", "repo-claude-skill", "SKILL.md"), skillMd("repo-claude-skill"));
write(join(project, ".codex", "skills", "repo-codex-skill", "SKILL.md"), skillMd("repo-codex-skill"));
execFileSync("git", ["init", "--quiet", project]);
execFileSync("git", ["-C", project, "remote", "add", "origin", "git@github.com:me/app.git"]);
// A folder of skills to import, and a Git repository of skills at a commit.
const folder = join(root, "import", "release");
write(join(folder, "SKILL.md"), skillMd("release"));
const repository = join(root, "skills-repo");
write(join(repository, "skills", "review", "SKILL.md"), skillMd("review"));
git(repository, "init", "--quiet", "--initial-branch=main");
git(repository, "add", "--all");
git(repository, "commit", "--quiet", "--message", "skills");
const commit = git(repository, "rev-parse", "HEAD");
// A Claude Code plugin whose two skills share a reference file and link to each other: one skill set.
const plugin = join(root, "playbook");
write(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "playbook", version: "0.5.0" }));
for (const [name, sibling] of [
  ["deliver-change", "plan-change"],
  ["plan-change", "deliver-change"],
] as const) {
  write(
    join(plugin, "skills", name, "SKILL.md"),
    `${skillMd(name)}\nRead [the contract](../../references/contract.md) and [${sibling}](../${sibling}/SKILL.md).\n`,
  );
}
write(join(plugin, "references", "contract.md"), "# Contract\n");

/** Every turn's skills, by the runtime that ran it, in the order the turns started. */
const given: Array<{ readonly runtime: RuntimeKind; readonly skills: ReadonlyArray<SkillMount> }> = [];

/** A fake runtime that records the skills each turn was given before it answers. */
const recording = (runtime: RuntimeKind): RuntimeAdapterShape => {
  const fake = makeFakeRuntime({ runtime });
  return {
    ...fake,
    sendPrompt: (request: PromptRequest) => {
      given.push({ runtime, skills: request.skills ?? [] });
      return fake.sendPrompt(request);
    },
  };
};

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
const savedHome = process.env.HOME;

beforeAll(() => {
  // The hub finds `~/.agents/skills` in the home folder, as it does on a real install.
  process.env.HOME = home;
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
    SkillProposalLogLive,
  ).pipe(Layer.provideMerge(TestDatabase));
  const SkillTooling = SkillToolsLive.pipe(Layer.provideMerge(SkillReviewsLive), Layer.provide(PolicyEngine.node));
  const App = HobLifecycle.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ChatService.layer,
        ApprovalService.layer,
        GrantService.layer,
        HobService.layer,
        PermissionSummary.layer,
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(HobToolsLive, SkillTooling)),
    Layer.provideMerge(CanonicalSharedFolders),
    Layer.provideMerge(SkillsLive(dataDir, agentsSkillsFolder(Option.none(), "claude"))),
    Layer.provideMerge(
      Layer.mergeAll(
        Persistence,
        EventBus.layer,
        HobAdmission.layer,
        NodeFolderChecks,
        // A project is its normalized Git origin, as for memory, so two clones share it.
        MemoryProjectsLive,
        Layer.succeed(RuntimeAdapter, recording("claude-code")),
        Layer.succeed(AdditionalRuntimes, new Map([["codex", recording("codex")]])),
        Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
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

/** Makes every folder under `folder` writable again, since the skills store keeps its revisions read-only. */
const unlock = (folder: string): void => {
  chmodSync(folder, 0o755);
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) unlock(join(folder, entry.name));
  }
};

afterAll(async () => {
  await dispose();
  process.env.HOME = savedHome;
  unlock(root);
  rmSync(root, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: the routes' bodies are read as JSON.
const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await handler(
    new Request(`http://localhost:4578${path}`, {
      method,
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

/** Waits on the hub's state, for at most ten seconds (STD-TEST-009). */
const eventually = <A>(read: () => Promise<A | undefined>) =>
  Effect.runPromise(
    Effect.tryPromise(read).pipe(
      Effect.flatMap((value) => (value === undefined ? Effect.fail("waiting" as const) : Effect.succeed(value))),
      Effect.retry({ schedule: Schedule.spaced("20 millis") }),
      Effect.timeout("10 seconds"),
    ),
  );

const summon = async (name: string, runtime: RuntimeKind, lookSeed: number): Promise<Agent> => {
  const summoned = await request("POST", "/api/agents", {
    name,
    ...roleFields("writer"),
    lookSeed,
    lookColor: "moss",
    runtime,
    model: null,
    effort: null,
    instructions: "",
  });
  expect(summoned.status).toBe(200);
  return summoned.body;
};

const messages = async (thread: Thread): Promise<ReadonlyArray<Message>> =>
  (await request("GET", `/api/threads/${thread.id}/messages`)).body;

/** Sends `content` and waits for its reply to end; returns the reply and what its turn was given. */
const turn = async (thread: Thread, content: string) => {
  const before = (await messages(thread)).filter((m) => m.role === "assistant").length;
  const turns = given.length;
  const sent = await request("POST", `/api/threads/${thread.id}/messages`, { content });
  expect(sent.status).toBe(200);
  const reply = await eventually(async () => {
    const ended = (await messages(thread)).filter((m) => m.role === "assistant" && !isInProgress(m.status));
    return ended.length > before ? ended.at(-1) : undefined;
  });
  const [one] = given.slice(turns);
  if (one === undefined) throw new Error("No turn started");
  return { reply, runtime: one.runtime, skills: one.skills };
};

/** The loose skills a turn mounted, each with its revision. */
const pins = (skills: ReadonlyArray<SkillMount>) =>
  skills.filter((mount) => !mount.set).map((mount) => [mount.name, mount.revision]);
/** The skills of sets a turn mounted, each named with its set, with the set's revision. */
const setPins = (skills: ReadonlyArray<SkillMount>) =>
  skills.filter((mount) => mount.set).map((mount) => [`${mount.set?.name}:${mount.name}`, mount.revision]);

describe("the skills library end to end", () => {
  // covers RT-001, ADR 029 (Import, Skill sets, Scopes, Pins and rollout, A clean runtime, Proactive hobs, The use line), #1057
  it("[TC-AG-1065] one library reaches a Claude Code hob and a Codex hob by scope, a plugin as one set, rolls out past a held pin, keeps the runtimes clean and ~/.agents/skills read-only, waits for you on a proposal and names each use", async () => {
    await request("PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [project] });
    const pip = await summon("Pip", "claude-code", 1065);
    const quill = await summon("Quill", "codex", 1066);

    // Import from a folder and from a Git commit; `~/.agents/skills` is listed under Everyone, from that folder.
    const fromFolder = await request("POST", "/api/skills", { source: { _tag: "Folder", path: folder } });
    expect(fromFolder.status).toBe(200);
    const release = fromFolder.body.imported[0];
    const fromGit = await request("POST", "/api/skills", {
      source: { _tag: "Git", url: `file://${repository}`, ref: "main" },
    });
    expect(fromGit.status).toBe(200);
    const review = fromGit.body.imported[0];
    expect(review.revision).toMatchObject({ name: "review", commit, path: "skills/review" });
    // A plugin comes in as one set, its two skills and the file they share kept together.
    const fromPlugin = await request("POST", "/api/skills", { source: { _tag: "Folder", path: plugin } });
    expect(fromPlugin.status).toBe(200);
    const playbook = fromPlugin.body.imported[0];
    expect(playbook.revision).toMatchObject({ name: "playbook", label: "0.5.0" });
    expect(playbook.revision.set.skills.map((one: { name: string }) => one.name)).toEqual([
      "deliver-change",
      "plan-change",
    ]);
    const library = (await request("GET", "/api/skills")).body;
    const houseStyle = library.skills.find((skill: { name: string }) => skill.name === "house-style");
    expect(library.sources.find((source: { id: string }) => source.id === houseStyle.sourceId)?.origin).toEqual({
      _tag: "AgentsFolder",
      path: join(home, ".agents", "skills"),
    });
    expect(library.agentsFolder).toEqual({ path: join(home, ".agents", "skills"), home, problems: [] });
    expect(
      library.assignments
        .filter((one: { skillId: string }) => one.skillId === houseStyle.id)
        .map((one: { scope: unknown }) => one.scope),
    ).toEqual([{ _tag: "Everyone" }]);
    // Nothing a runtime's own setup or the project holds came into the library.
    expect(library.skills.map((skill: { name: string }) => skill.name).sort()).toEqual([
      "house-style",
      "playbook",
      "release",
      "review",
    ]);
    const [identity] = library.projects;
    expect(identity).toBe("github.com/me/app");

    // Scopes: release to Everyone, to the project and to Quill alone, held there; review to Pip alone.
    const assign = async (skillId: string, scope: unknown, held = false) => {
      const assigned = await request("POST", `/api/skills/${skillId}/assignments`, { scope, held });
      expect(assigned.status).toBe(200);
      return assigned.body;
    };
    const toEveryone = await assign(release.skill.id, { _tag: "Everyone" });
    const toProject = await assign(release.skill.id, { _tag: "Project", identity });
    const toQuill = await assign(release.skill.id, { _tag: "Hob", agentId: quill.id }, true);
    await assign(review.skill.id, { _tag: "Hob", agentId: pip.id });
    // The set goes to the project, and Quill turns off one of its skills for itself alone.
    await assign(playbook.skill.id, { _tag: "Project", identity });
    const optOut = await request("PUT", `/api/skills/hobs/${quill.id}/opt-outs/${playbook.skill.id}`, {
      optedOut: true,
      member: "plan-change",
    });
    expect(optOut.body.optedOutOfSets).toEqual([{ skillId: playbook.skill.id, name: "plan-change" }]);

    // The narrower scope wins the clash, and the clash is shown.
    const pipView = (await request("GET", `/api/skills/hobs/${pip.id}`)).body;
    expect(
      pipView.skills.map((skill: { name: string; scope: { _tag: string } }) => [skill.name, skill.scope._tag]),
    ).toEqual([
      ["deliver-change", "Project"],
      ["house-style", "Everyone"],
      ["plan-change", "Project"],
      ["release", "Project"],
      ["review", "Hob"],
    ]);
    expect(
      pipView.replaced.map((one: { assignment: { id: string }; by: { id: string } }) => [one.assignment.id, one.by.id]),
    ).toEqual([[toEveryone.id, toProject.id]]);
    const quillView = (await request("GET", `/api/skills/hobs/${quill.id}`)).body;
    expect(
      quillView.skills.map((skill: { name: string; scope: { _tag: string } }) => [skill.name, skill.scope._tag]),
    ).toEqual([
      ["deliver-change", "Project"],
      ["house-style", "Everyone"],
      ["release", "Hob"],
    ]);
    expect(quillView.replaced.map((one: { by: { id: string } }) => one.by.id)).toEqual([toQuill.id, toQuill.id]);

    // Each runtime's turn gets exactly the skills its scopes give it, all served from the hub's own store.
    const pipThread: Thread = (await request("POST", `/api/agents/${pip.id}/threads`)).body;
    const quillThread: Thread = (await request("POST", `/api/agents/${quill.id}/threads`)).body;
    const r1 = release.revision.hash;
    const pipFirst = await turn(pipThread, "/skills");
    expect(pipFirst.runtime).toBe("claude-code");
    expect(pins(pipFirst.skills)).toEqual([
      ["house-style", houseStyle.latest],
      ["release", r1],
      ["review", review.revision.hash],
    ]);
    expect(setPins(pipFirst.skills)).toEqual([
      ["playbook:deliver-change", playbook.revision.hash],
      ["playbook:plan-change", playbook.revision.hash],
    ]);
    const quillFirst = await turn(quillThread, "/skills");
    expect(quillFirst.runtime).toBe("codex");
    expect(pins(quillFirst.skills)).toEqual([
      ["house-style", houseStyle.latest],
      ["release", r1],
    ]);
    expect(setPins(quillFirst.skills)).toEqual([["playbook:deliver-change", playbook.revision.hash]]);

    // The clean runtime: no turn was handed anything from `~/.claude`, `~/.codex` or the project's own
    // folders, and the `~/.agents/skills` skill reached both runtimes as a mount the hub serves.
    for (const one of given) {
      for (const mount of one.skills) {
        expect(FOREIGN).not.toContain(mount.name);
        expect(mount.folder.startsWith(dataDir), mount.folder).toBe(true);
      }
    }

    // Rollout: saving your edit as r2 says where it went, moves every assignment but the held one, and the next turns show it.
    const saved = await request("POST", `/api/skills/${release.skill.id}/edits`, {
      base: r1,
      description: "Releases, now.",
      instructions: "\n# release\n\nTag, then publish.\n",
    });
    expect(saved.status).toBe(200);
    const r2 = saved.body.revision.hash;
    expect(saved.body.revision.number).toBe(2);
    expect(saved.body.rolledOut.map((one: { id: string }) => one.id).sort()).toEqual(
      [toEveryone.id, toProject.id].sort(),
    );
    const detail = (await request("GET", `/api/skills/${release.skill.id}`)).body;
    expect(detail.skill.latest).toBe(r2);
    // The held one stays on r1, a revision behind the newest.
    expect(detail.assignments.find((one: { id: string }) => one.id === toQuill.id)).toMatchObject({
      pin: r1,
      held: true,
    });
    const savedChange = (await request("GET", "/api/skills/changes")).body.changes.find(
      (change: { kind: string; skillId: string }) => change.kind === "saved" && change.skillId === release.skill.id,
    );
    expect(savedChange).toMatchObject({ number: 2, previous: r1, previousNumber: 1 });
    expect(savedChange.scopes).toEqual(expect.arrayContaining([{ _tag: "Everyone" }, { _tag: "Project", identity }]));
    expect(savedChange.scopes).toHaveLength(2);

    // The use line: the reply names the skill and the revision its turn used.
    const pipUses = await turn(pipThread, "Cut the release.\nfake:skill release");
    expect(pins(pipUses.skills).find(([name]) => name === "release")).toEqual(["release", r2]);
    expect(pipUses.reply.skillsUsed).toEqual([
      { source: "library", skillId: release.skill.id, name: "release", set: null, pin: r2, number: 2, explicit: false },
    ]);
    const quillUses = await turn(quillThread, "Cut the release.\nfake:skill release");
    expect(quillUses.reply.skillsUsed).toEqual([
      { source: "library", skillId: release.skill.id, name: "release", set: null, pin: r1, number: 1, explicit: false },
    ]);
    const uses = (await request("GET", `/api/skills/${release.skill.id}/uses`)).body;
    expect(uses.total).toBe(2);
    expect(uses.hobs.map((one: { agentId: string; count: number }) => [one.agentId, one.count]).sort()).toEqual(
      [
        [pip.id, 1],
        [quill.id, 1],
      ].sort(),
    );
    // A skill of a set is picked by its bare name or with its set's, and its use names the set's revision.
    const setUse = (name: string, pin: string) => ({
      source: "library",
      skillId: playbook.skill.id,
      name,
      set: "playbook",
      pin,
      number: 1,
      explicit: true,
    });
    const pipPlan = await turn(pipThread, "/plan-change go");
    expect(pipPlan.reply.skillsUsed).toEqual([setUse("plan-change", playbook.revision.hash)]);
    const quillDeliver = await turn(quillThread, "/playbook:deliver-change go");
    expect(quillDeliver.reply.skillsUsed).toEqual([setUse("deliver-change", playbook.revision.hash)]);
    // The skill Quill turned off is not handed to its turn, so naming it uses nothing.
    const quillPlan = await turn(quillThread, "/playbook:plan-change go");
    expect(quillPlan.reply.skillsUsed).toEqual([]);

    // Roll back from What changed: back to r1 for everyone it moved, and the next turn is on r1.
    const back = await request("POST", `/api/skills/${release.skill.id}/roll-out`, { pin: savedChange.previous });
    expect(back.body.rolledOut.map((one: { id: string }) => one.id).sort()).toEqual(
      [toEveryone.id, toProject.id].sort(),
    );
    const afterBack = await turn(pipThread, "/skills");
    expect(pins(afterBack.skills).find(([name]) => name === "release")).toEqual(["release", r1]);

    // `~/.agents/skills` is read-only in Hobbots: an edit is refused, and Make a copy gives Pip an editable one.
    const readOnly = await request("POST", `/api/skills/${houseStyle.id}/edits`, {
      base: houseStyle.latest,
      description: "Changed here.",
      instructions: "Changed.",
    });
    expect(readOnly).toMatchObject({ status: 409, body: { _tag: "SkillIsReadOnly", name: "house-style" } });
    const copied = await request("POST", `/api/skills/${houseStyle.id}/copies`, {
      name: "house-style-copy",
      scope: { _tag: "Hob", agentId: pip.id },
    });
    expect(copied.body).toMatchObject({ added: true, skill: { name: "house-style-copy", sourceId: null } });
    const afterCopy = await turn(pipThread, "/skills");
    expect(pins(afterCopy.skills).map(([name]) => name)).toEqual(
      expect.arrayContaining(["house-style", "house-style-copy"]),
    );

    // A proposal: the hob's skill tool files it, and nothing reaches the library or any turn until you add it.
    const proposal = {
      key: "changelog",
      name: "changelog",
      instructions: skillMd("changelog", "Writes the changelog for a release."),
      why: "I write the changelog the same way every release.",
    };
    const proposed = await turn(pipThread, `Propose it.\nfake:hub ${SKILL_PROPOSE_TOOL} ${JSON.stringify(proposal)}`);
    expect(proposed.reply.content).toContain("waits for the user's review in their Inbox");
    const [waiting] = (await request("GET", "/api/skill-proposals")).body.proposals;
    expect(waiting.proposal).toMatchObject({ name: "changelog", state: "waiting", skillId: null, agentId: pip.id });
    expect((await request("GET", "/api/skills")).body.skills).toHaveLength(5);
    expect(pins((await turn(pipThread, "/skills")).skills).map(([name]) => name)).not.toContain("changelog");

    const added = await request("POST", `/api/skill-proposals/${waiting.proposal.id}/add`, {});
    expect(added).toMatchObject({ status: 200, body: { state: "added", added: { number: 1 } } });
    // Added, it goes to the hob that proposed it, and to no other.
    expect(pins((await turn(pipThread, "/skills")).skills).map(([name]) => name)).toContain("changelog");
    expect(pins((await turn(quillThread, "/skills")).skills).map(([name]) => name)).toEqual(["house-style", "release"]);
  });
});
