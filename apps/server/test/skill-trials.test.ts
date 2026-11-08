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
  SkillTrialsLive,
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

// #1099: Try in a chat and the Skills Overview's health checks (ADR 029), through the hub's routes
// with its own composition and a fake Claude Code and a fake Codex, each recording the skills every
// turn was given. A chat that tries a draft hands each runtime the draft as its one mount, from
// outside the library, and nothing about it reaches the library.

const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-skill-trials-")));
const home = join(root, "home");
const dataDir = join(root, "data");
const drafts = join(dataDir, "skills", "drafts");

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const skillMd = (name: string, description = `What ${name} is for.`, body = `Steps for ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

const folder = join(root, "import", "release");
write(join(folder, "SKILL.md"), skillMd("release"));
mkdirSync(home, { recursive: true });

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
  const App = SkillTrialsLive.pipe(Layer.provideMerge(HobLifecycle.layer)).pipe(
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

/** The mounts a turn got, as name, revision and whether the folder is a draft's. */
const mounted = (skills: ReadonlyArray<SkillMount>) =>
  skills.map((mount) => [mount.name, mount.revision, mount.folder.startsWith(drafts)]);

/** What the library holds, which trying a draft must leave as it was. */
const library = async () => {
  const { skills, assignments } = (await request("GET", "/api/skills")).body;
  const changes = (await request("GET", "/api/skills/changes")).body.changes;
  return { skills, assignments, changes };
};

const startTrial = (agentId: string, draft: unknown) => request("POST", "/api/skill-trials", { agentId, draft });

describe("trying a skill in a chat, and the health checks", () => {
  // covers ADR 029 (Try in a chat, Health checks), #1099
  it("[TC-AG-1099-08] tries a new skill, an unsaved edit and a proposal on a Claude Code hob and a Codex hob, each turn loading only the draft, and nothing reaches the library", async () => {
    await request("PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [] });
    const pip = await summon("Pip", "claude-code", 1099);
    const quill = await summon("Quill", "codex", 1100);
    const imported = await request("POST", "/api/skills", { source: { _tag: "Folder", path: folder } });
    expect(imported.status).toBe(200);
    const release = imported.body.imported[0];
    const r1 = release.revision.hash;
    expect(
      (
        await request("POST", `/api/skills/${release.skill.id}/assignments`, {
          scope: { _tag: "Everyone" },
          held: false,
        })
      ).status,
    ).toBe(200);

    // A hob proposes a skill from its own chat; it waits in the Inbox.
    const pipChat: Thread = (await request("POST", `/api/agents/${pip.id}/threads`)).body;
    const proposal = {
      key: "changelog",
      name: "changelog",
      instructions: skillMd("changelog", "Writes the changelog when you cut a release."),
      why: "I write the changelog the same way every release.",
    };
    await turn(pipChat, `Propose it.\nfake:hub ${SKILL_PROPOSE_TOOL} ${JSON.stringify(proposal)}`);
    const [waiting] = (await request("GET", "/api/skill-proposals")).body.proposals;
    expect(waiting.proposal).toMatchObject({ name: "changelog", state: "waiting" });
    const before = await library();

    // A new skill you have not added, tried on Claude Code: the turn gets the draft and nothing else.
    const written = await startTrial(pip.id, {
      _tag: "Written",
      text: skillMd("notes", "Takes meeting notes when you ask for them."),
    });
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({
      agentId: pip.id,
      title: "Trying Notes",
      skillTrial: { name: "notes", skillId: null, base: null, proposalId: null },
    });
    const notes = written.body.skillTrial.hash;
    const pipTry = await turn(written.body, "Take the notes.\nfake:skill notes");
    expect(pipTry.runtime).toBe("claude-code");
    expect(mounted(pipTry.skills)).toEqual([["notes", notes, true]]);
    expect(pipTry.reply.skillsUsed).toEqual([
      { source: "draft", skillId: null, name: "notes", set: null, pin: notes, number: null, explicit: false },
    ]);
    // The hob's own skills stay out of the chat: naming one uses nothing, and its messages record none.
    const pipOwn = await turn(written.body, "Release.\nfake:skill release");
    expect(mounted(pipOwn.skills)).toEqual([["notes", notes, true]]);
    expect(pipOwn.reply.skillsUsed).toEqual([]);
    expect((await messages(written.body)).every((one) => (one.skills ?? []).length === 0)).toBe(true);

    // An edit you have not saved, tried on Codex: the turn gets the edited release, as a draft.
    const edited = await startTrial(quill.id, {
      _tag: "Edit",
      skillId: release.skill.id,
      base: r1,
      description: "Cuts a release when you ask to ship.",
      instructions: "\n# release\n\nTag, then publish.\n",
    });
    expect(edited.status).toBe(200);
    expect(edited.body.skillTrial).toMatchObject({ name: "release", skillId: release.skill.id, base: r1 });
    const draft = edited.body.skillTrial.hash;
    expect(draft).not.toBe(r1);
    const quillTry = await turn(edited.body, "/release now\nfake:skill release");
    expect(quillTry.runtime).toBe("codex");
    expect(mounted(quillTry.skills)).toEqual([["release", draft, true]]);
    expect(quillTry.reply.skillsUsed).toEqual([
      expect.objectContaining({
        source: "draft",
        skillId: release.skill.id,
        name: "release",
        pin: draft,
        number: null,
      }),
    ]);

    // The proposal, with your edit on the card, tried on Codex and on Claude Code.
    for (const hob of [quill, pip]) {
      const proposed = await startTrial(hob.id, {
        _tag: "Proposal",
        proposalId: waiting.proposal.id,
        instructions: skillMd("changelog", "Writes the changelog when you cut a release.", "Newest first."),
      });
      expect(proposed.status).toBe(200);
      expect(proposed.body.skillTrial).toMatchObject({ name: "changelog", proposalId: waiting.proposal.id });
      const tried = await turn(proposed.body, "Write it.\nfake:skill changelog");
      expect(mounted(tried.skills)).toEqual([["changelog", proposed.body.skillTrial.hash, true]]);
      expect(tried.reply.skillsUsed.map((one: { source: string }) => one.source)).toEqual(["draft"]);
    }

    // A draft that breaks a check is refused as import refuses it, and no chat opens.
    const threads = (await request("GET", `/api/agents/${pip.id}/threads`)).body.length;
    const refused = await startTrial(pip.id, { _tag: "Written", text: "No front matter here." });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body._tag).toBe("SkillImportRefused");
    expect((await request("GET", `/api/agents/${pip.id}/threads`)).body).toHaveLength(threads);
    expect((await startTrial(pip.id, { _tag: "Proposal", proposalId: "missing" })).status).toBe(404);

    // Nothing reached the library: no skill, revision, assignment, change or use, and the proposal still waits.
    expect(await library()).toEqual(before);
    expect((await request("GET", `/api/skills/${release.skill.id}`)).body.skill.revisions).toBe(1);
    expect((await request("GET", `/api/skills/${release.skill.id}/uses`)).body.total).toBe(0);
    expect((await request("GET", "/api/skill-proposals")).body.proposals[0].proposal.state).toBe("waiting");
    // And a hob's own chat still gets its library skills, never a draft.
    const after = await turn(pipChat, "/skills");
    expect(mounted(after.skills)).toEqual([["release", r1, false]]);
  });

  it("[TC-AG-1099-09] shows each health check with what acting on it needs, and what each hob carries on both runtimes", async () => {
    const list = (await request("GET", "/api/skills")).body;
    const release = list.skills.find((skill: { name: string }) => skill.name === "release");
    const agents: ReadonlyArray<Agent> = (await request("GET", "/api/agents")).body;
    const quill = agents.find((agent) => agent.name === "Quill");
    if (quill === undefined) throw new Error("No Quill");
    const held = await request("POST", `/api/skills/${release.id}/assignments`, {
      scope: { _tag: "Hob", agentId: quill.id },
      held: true,
    });
    expect(held.status).toBe(200);
    const saved = await request("POST", `/api/skills/${release.id}/edits`, {
      base: release.latest,
      description: "Releases.",
      instructions: "\n# release\n\nTag.\n",
    });
    expect(saved.status).toBe(200);

    const health = await request("GET", "/api/skill-health");
    expect(health.status).toBe(200);
    // The held place stays on r1 while the skill is on r2.
    expect(health.body.behind).toEqual([
      expect.objectContaining({ assignmentId: held.body.id, skillId: release.id, number: 1, latest: 2, held: true }),
    ]);
    // Its newest description says nothing of when to use it.
    expect(health.body.descriptions).toEqual([
      { skillId: release.id, name: "release", set: null, problem: "vague", length: "Releases.".length },
    ]);
    // Quill gets release from Everyone and from itself: the same skill, so a pin, not a clash.
    expect(health.body.clashes).toEqual([]);
    // Added today, so not unused yet.
    expect(health.body.unused).toEqual([]);
    expect(
      health.body.loads
        .map((one: { runtime: string; skills: number; characters: number; budget: number }) => [
          one.runtime,
          one.skills,
          one.characters,
          one.budget,
        ])
        .sort(),
    ).toEqual(
      [
        ["claude-code", 1, "release: Releases.".length, 8000],
        ["codex", 1, "release: What release is for.".length, 8000],
      ].sort(),
    );
  });
});
