import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ApprovalService,
  type CharmTurn,
  ChatService,
  GrantService,
  HobAdmission,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  HobTools,
  hubCallStep,
  makeRedactor,
  PermissionSummary,
  SkillFiles,
  SkillLibrary,
  SkillProposalLog,
  SkillReviews,
  SkillReviewsLive,
  SkillTools,
  SkillWriter,
  type ToolAccess,
  TurnSkillsInUse,
} from "@hobbots/agents";
import type { SkillProposalView } from "@hobbots/api";
import {
  Agent,
  AgentId,
  EMPTY_HOB_POLICY,
  type EventEnvelope,
  type HobPolicy,
  memoryProjectIdentity,
  type SafetyPreset,
  SKILL_FEEDBACK_TOOL,
  SKILL_PROPOSE_TOOL,
  SKILL_REQUEST_TOOL,
  SKILL_SEARCH_TOOL,
  SkillName,
  SkillProposal,
  SkillRevisionHash,
  type SkillScope,
  type ThreadId,
} from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
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
import { FakeRuntimeLayer } from "@hobbots/runtimes";
import { SkillImporter, SkillToolsLive } from "@hobbots/skills";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { SkillsLive } from "../src/skills.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// #1063: hobs proposing skills (ADR 029, Proactive hobs), from the hob's skill tools to your decision
// over HTTP, on the hub's database and skills store. Nothing a hob proposes reaches the library until
// you add it, a turned-down proposal leaves it as it was, and the hob is told either way.

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hobbots-skill-proposals-")));
/** Makes every folder under `folder` writable again, since the skills store keeps its revisions read-only. */
const unlock = (folder: string): void => {
  fs.chmodSync(folder, 0o755);
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) unlock(path.join(folder, entry.name));
  }
};
afterAll(() => {
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
});

const ada = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000b1");
const folder = path.join(root, "work");
fs.mkdirSync(folder, { recursive: true });

const skillMd = (name: string, body = `Steps for ${name}.`) =>
  `---\nname: ${name}\ndescription: What ${name} is for, and when to use it.\n---\n\n# ${name}\n\n${body}\n`;

/**
 * What lands in the library just before the next writes of a proposal you add, one per write, as
 * another import or update would land while its files were copied.
 */
const races: Array<Effect.Effect<unknown, unknown, SkillImporter>> = [];
/** Whether the hub stops right after the next write of a proposal, before anything else is done. */
const stop = { afterWrite: false };

/** The library's writer as proposals reach it, with `races` landing first. */
const RacingWriter = Layer.effect(
  SkillWriter,
  Effect.gen(function* () {
    const real = yield* SkillWriter;
    const importer = yield* SkillImporter;
    return SkillWriter.of({
      check: real.check,
      write: (files, options) =>
        Effect.gen(function* () {
          const race = races.shift();
          if (race !== undefined) yield* Effect.orDie(Effect.provideService(race, SkillImporter, importer));
          const added = yield* real.write(files, options);
          if (stop.afterWrite) {
            stop.afterWrite = false;
            return yield* Effect.die("The hub stopped.");
          }
          return added;
        }),
    });
  }),
);

const App = (data: string) => {
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
  const Skills = SkillToolsLive.pipe(
    Layer.provideMerge(SkillReviewsLive.pipe(Layer.provide(RacingWriter))),
    Layer.provide(PolicyEngine.node),
  );
  return HobLifecycle.layer
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ChatService.layer.pipe(Layer.provide(HobTools.chatOnly)),
          ApprovalService.layer,
          GrantService.layer,
          HobService.layer,
          PermissionSummary.layer,
          Skills,
        ),
      ),
    )
    .pipe(Layer.provideMerge(SkillsLive(data, null)))
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Persistence,
          EventBus.layer,
          HobAdmission.layer,
          NodeFolderChecks,
          FakeRuntimeLayer(),
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir: data }),
        ),
      ),
    );
};

type AppLayer = ReturnType<typeof App>;
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<AppLayer>, Layer.Error<AppLayer>>;
let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let thread: ThreadId;
let run = 0;

beforeEach(async () => {
  run += 1;
  races.length = 0;
  stop.afterWrite = false;
  runtime = ManagedRuntime.make(App(path.join(root, `data-${run}`)));
  await runtime.runPromise(
    HobbotsRepository.use((repo) =>
      repo.insertAgent(
        new Agent({
          id: ada,
          name: "Ada",
          roleTitle: "Builder",
          runtime: "claude-code",
          model: null,
          effort: null,
          instructions: "",
          lookSeed: 4822,
          lookColor: "violet",
          configVersion: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ),
  );
  thread = (await runtime.runPromise(ChatService.use((chat) => chat.createThread(ada)))).id;
  const web = HttpRouter.toWebHandler(
    ApiRoutes.pipe(
      Layer.provide(TestDevices),
      Layer.provideMerge(Layer.succeedContext(await runtime.context())),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );
  handler = (request) => web.handler(request);
  dispose = async () => {
    await web.dispose();
    await runtime.dispose();
  };
});
afterEach(() => dispose());

// biome-ignore lint/suspicious/noExplicitAny: the routes' bodies are read as JSON.
const request = async (method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await handler(
    new Request(`http://localhost:4317${route}`, {
      method,
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
};

const accessFor = (preset: SafetyPreset, overrides: HobPolicy["overrides"] = {}): ToolAccess => ({
  policy: {
    preset,
    sharedFolders: [],
    hob: { ...EMPTY_HOB_POLICY, ownFolders: [folder], overrides },
    dataFolder: path.join(root, "data"),
    restrictions: [],
  },
  folders: [folder],
  runtimeFolder: path.join(root, "runtimes", "ada"),
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

const turnFor = (access: ToolAccess, work = "reply:m1"): CharmTurn => ({
  agentId: ada,
  threadId: thread,
  messageId: null,
  scope: () => work,
  also: work,
  currentAccess: Effect.succeed(access),
  redactor: makeRedactor([]),
  approvals: null,
});

/** The skill tools Ada is offered in a turn under `access`, or null when none is. */
const offered = (access: ToolAccess) => runtime.runPromise(SkillTools.use((tools) => tools.forTurn(turnFor(access))));

/** Ada calls a skill tool in a turn of its own. */
const call = (name: string, input: unknown, access: ToolAccess = accessFor("balanced"), work?: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const tools = yield* (yield* SkillTools).forTurn(turnFor(access, work));
      if (tools === null) throw new Error("No skill tools");
      return yield* tools.call(
        name,
        input,
        hubCallStep("step-1", () => undefined),
      );
    }),
  );

const propose = (name: string, options: { key?: string; basedOn?: number; body?: string; work?: string } = {}) =>
  call(
    SKILL_PROPOSE_TOOL,
    {
      key: options.key ?? name,
      name,
      instructions: skillMd(name, options.body),
      why: `I repeat the ${name} steps in every task.`,
      memoryPages: ["howto/release.md"],
      ...(options.basedOn === undefined ? {} : { basedOn: options.basedOn }),
    },
    accessFor("trusting"),
    options.work,
  );

const proposals = async (): Promise<ReadonlyArray<SkillProposalView>> =>
  (await request("GET", "/api/skill-proposals")).body.proposals;
const library = () => runtime.runPromise(SkillLibrary.use((skills) => skills.list));
const importSkill = async (name: string) => {
  const imported = await request("POST", "/api/skills", {
    source: { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd(name) }] },
  });
  expect(imported.status).toBe(200);
  return imported.body.imported[0];
};
/** What Ada's next chat turn is told, from its open backpack items. */
const told = () =>
  runtime.runPromise(
    Backpack.use((backpack) => backpack.listOpen({ _tag: "Hob", agentId: ada })).pipe(
      Effect.map((items) => items.filter((item) => item.kind === "skill-proposal")),
    ),
  );
const journal = async () =>
  ((await runtime.runPromise(EventJournal.use((events) => events.readAfter(0, 500)))) as ReadonlyArray<EventEnvelope>)
    .map((entry) => entry.type)
    .filter((type) => type.startsWith("SkillProposal"));

describe("hobs proposing skills", () => {
  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-145] a new skill waits for you under every preset, and nothing reaches the library until you add it", async () => {
    const answer = await propose("release-steps");
    expect(answer).toEqual({
      text: "Proposed a new skill, release-steps. It waits for the user's review in their Inbox, so nothing changed yet, and you are told when they decide. Do not propose it again.",
      refused: false,
    });
    expect(await library()).toEqual([]);
    const [waiting] = await proposals();
    expect(waiting?.proposal).toMatchObject({
      name: "release-steps",
      state: "waiting",
      skillId: null,
      memoryPages: ["howto/release.md"],
      threadId: thread,
    });
    expect(await journal()).toEqual(["SkillProposalRequested"]);

    const added = await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/add`, {});
    expect(added).toMatchObject({ status: 200, body: { state: "added", added: { number: 1 }, edited: false } });
    const [skill] = await library();
    expect(skill).toMatchObject({ name: "release-steps", revisions: 1 });
    // It goes to the hob that proposed it, and the hob is told in its next turn.
    const assignments = await runtime.runPromise(SkillLibrary.use((skills) => skills.assignments(skill?.id as never)));
    expect(assignments.map((one) => one.scope)).toEqual([{ _tag: "Hob", agentId: ada }]);
    const [item] = await told();
    expect(item?.payload).toMatchObject({ _tag: "skill-proposal", proposal: { state: "added" } });
    // A second decision is refused.
    expect((await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/decline`)).status).toBe(409);
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-146] Not now leaves the library unchanged, and the hob is told", async () => {
    await propose("release-steps");
    const [waiting] = await proposals();
    const declined = await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/decline`);
    expect(declined).toMatchObject({ status: 200, body: { state: "declined" } });
    expect(await library()).toEqual([]);
    const [item] = await told();
    expect(item?.payload).toMatchObject({ _tag: "skill-proposal", proposal: { state: "declined" } });
    expect(await journal()).toEqual(["SkillProposalRequested", "SkillProposalChanged"]);
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-147] a retried proposal makes one card, one name waits once, and a hob with three waiting stops", async () => {
    const first = await propose("release-steps");
    const again = await propose("release-steps");
    expect(again).toEqual(first);
    expect(await proposals()).toHaveLength(1);
    // The same key for another call is refused, as is the same name in other work.
    expect(await propose("release-steps", { body: "Other steps." })).toMatchObject({ refused: true });
    expect(await propose("release-steps", { key: "other", work: "reply:m2" })).toMatchObject({ refused: true });
    await propose("review-steps");
    await propose("deploy-steps");
    const full = await propose("triage-steps");
    expect(full.refused).toBe(true);
    expect(full.text).toContain("3 proposals waiting");
    expect(await proposals()).toHaveLength(3);
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-148] a change you edit rolls out as your edit, and keeps the files it did not change", async () => {
    // Imported with a script that runs, which the HTTP source cannot mark.
    const script = { path: "scripts/tag.sh", text: '#!/bin/sh\ngit tag "$1"\n', executable: true };
    const [imported] = await runtime.runPromise(
      SkillImporter.use((importer) =>
        importer.add(
          { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("release-steps") }, script] },
          { by: { _tag: "You" } },
        ),
      ),
    );
    expect(imported?.revision.number).toBe(1);
    // A change must name the revision it read.
    expect(await propose("release-steps")).toMatchObject({ refused: true });
    expect(await propose("release-steps", { basedOn: 1, body: "Tag, then push." })).toMatchObject({ refused: false });
    const [waiting] = await proposals();
    expect(waiting).toMatchObject({ base: skillMd("release-steps"), latest: null });
    const edited = skillMd("release-steps", "Tag, push, then announce.");
    const added = await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/add`, { instructions: edited });
    expect(added).toMatchObject({ status: 200, body: { state: "added", edited: true, added: { number: 2 } } });
    const [skill] = await library();
    expect(skill?.revisions).toBe(2);
    const revision = await runtime.runPromise(
      SkillLibrary.use((skills) => skills.revision(skill?.id as never, added.body.added.hash)),
    );
    expect(revision?.files.map((file) => [file.path, file.mode])).toEqual(
      expect.arrayContaining([["scripts/tag.sh", "executable"]]),
    );
    const [item] = await told();
    expect(item?.payload).toMatchObject({ proposal: { state: "added", edited: true } });
  });

  // covers ADR 029 (Proactive hobs; ~/.agents/skills stays, through Hobbots), #1139
  it("[TC-AG-164] a change to a skill from ~/.agents/skills is refused, with a hint to propose a copy", async () => {
    await runtime.runPromise(
      SkillLibrary.use((skills) =>
        skills.addRevision(null, {
          hash: SkillRevisionHash.make("d".repeat(64)),
          name: SkillName.make("pdf-forms"),
          description: "Use when filling in a PDF form.",
          charms: [],
          files: [{ path: "SKILL.md", mode: "regular", size: 10, sha256: "0".repeat(64) }],
          flags: [],
          dropped: [],
          origin: { _tag: "AgentsFolder", path: "/home/me/.agents/skills" },
          commit: null,
          path: "pdf-forms",
          label: null,
          addedBy: { _tag: "You" },
        }),
      ),
    );
    const answer = await propose("pdf-forms", { basedOn: 1, body: "Fill, then check." });
    expect(answer).toEqual({
      text: "pdf-forms comes from ~/.agents/skills, which Hobbots only reads, so it cannot change here. Propose a skill under a new name instead, such as pdf-forms-copy, without basedOn, starting from the files you read.",
      refused: true,
    });
    expect(await proposals()).toEqual([]);
    expect(await propose("pdf-forms-copy", { body: "Fill, then check." })).toMatchObject({ refused: false });
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-150] a stale change keeps the files the skill has now, not those of the revision the hob read", async () => {
    const add = (files: ReadonlyArray<{ path: string; text: string; executable?: boolean }>, skillId?: string) =>
      runtime.runPromise(
        SkillImporter.use((importer) =>
          importer.add(
            { _tag: "Written", files },
            { by: { _tag: "You" }, ...(skillId === undefined ? {} : { skillId: skillId as never }) },
          ),
        ),
      );
    const [first] = await add([
      { path: "SKILL.md", text: skillMd("release-steps") },
      { path: "scripts/tag.sh", text: "#!/bin/sh\ngit tag v1\n", executable: true },
    ]);
    expect(await propose("release-steps", { basedOn: 1, body: "Tag, then push." })).toMatchObject({ refused: false });
    // Meanwhile r2 fixes the script and adds a checklist.
    await add(
      [
        { path: "SKILL.md", text: skillMd("release-steps", "Steps for release-steps, fixed.") },
        { path: "scripts/tag.sh", text: '#!/bin/sh\ngit tag "$1"\n', executable: true },
        { path: "checklist.md", text: "- Tag\n" },
      ],
      first?.revision.skillId,
    );
    const [waiting] = await proposals();
    expect(waiting?.latest).toMatchObject({ number: 2 });
    const added = await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/add`, {});
    expect(added).toMatchObject({ status: 200, body: { state: "added", added: { number: 3 } } });
    const folder = await runtime.runPromise(SkillFiles.use((store) => store.folder(added.body.added.hash)));
    if (folder === null) throw new Error("No files for r3");
    expect(fs.readFileSync(path.join(folder, "scripts/tag.sh"), "utf8")).toBe('#!/bin/sh\ngit tag "$1"\n');
    expect(fs.readFileSync(path.join(folder, "checklist.md"), "utf8")).toBe("- Tag\n");
    expect(fs.readFileSync(path.join(folder, "SKILL.md"), "utf8")).toBe(skillMd("release-steps", "Tag, then push."));
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-151] a proposal sent again after you decided answers as it ended, not with what the library now holds", async () => {
    await propose("release-steps");
    const [waiting] = await proposals();
    await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/add`, {});
    // The skill is in the library now, which would refuse a new proposal of that name without basedOn.
    expect(await propose("release-steps")).toEqual({
      text: "The user added a new skill, release-steps as r1. You use it from your next turn.",
      refused: false,
    });
    await propose("review-steps");
    const review = (await proposals()).find((one) => one.proposal.name === "review-steps");
    await request("POST", `/api/skill-proposals/${review?.proposal.id}/decline`);
    expect((await propose("review-steps")).text).toContain("turned down a new skill, review-steps");
    expect(await proposals()).toHaveLength(2);
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-152] a change whose kept files cannot be read is refused, waits again, and leaves the library as it was", async () => {
    const [first] = await runtime.runPromise(
      SkillImporter.use((importer) =>
        importer.add(
          {
            _tag: "Written",
            files: [
              { path: "SKILL.md", text: skillMd("release-steps") },
              { path: "scripts/tag.sh", text: "#!/bin/sh\ngit tag v1\n", executable: true },
            ],
          },
          { by: { _tag: "You" } },
        ),
      ),
    );
    await propose("release-steps", { basedOn: 1, body: "Tag, then push." });
    const [waiting] = await proposals();
    // The script goes missing from the revision's folder, as a damaged disk would lose it.
    const folder = await runtime.runPromise(SkillFiles.use((store) => store.folder(first?.revision.hash as never)));
    if (folder === null) throw new Error("No files for r1");
    unlock(folder);
    fs.rmSync(path.join(folder, "scripts/tag.sh"));
    const refused = await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/add`, {});
    expect(refused).toMatchObject({ status: 422, body: { _tag: "SkillSourceNotRead" } });
    expect(refused.body.message).toContain("scripts/tag.sh");
    expect((await proposals())[0]?.proposal.state).toBe("waiting");
    expect((await library())[0]?.revisions).toBe(1);

    // The whole folder gone is refused the same way: a missing folder is not a skill without files.
    fs.rmSync(folder, { recursive: true, force: true });
    expect(await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/add`, {})).toMatchObject({
      status: 422,
      body: { _tag: "SkillSourceNotRead" },
    });
    expect((await proposals())[0]?.proposal.state).toBe("waiting");
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-153] a hub that stopped while adding finishes each proposal it can, and sends back one it cannot", async () => {
    const [first] = await runtime.runPromise(
      SkillImporter.use((importer) =>
        importer.add(
          {
            _tag: "Written",
            files: [
              { path: "SKILL.md", text: skillMd("release-steps") },
              { path: "notes.md", text: "- Tag\n" },
            ],
          },
          { by: { _tag: "You" } },
        ),
      ),
    );
    await propose("release-steps", { basedOn: 1, body: "Tag, then push." });
    await propose("review-steps");
    // Both were claimed when the hub stopped, before either was written.
    for (const view of await proposals()) {
      await runtime.runPromise(
        SkillProposalLog.use((log) => log.move(new SkillProposal({ ...view.proposal, state: "adding" }), ["waiting"])),
      );
    }
    const folder = await runtime.runPromise(SkillFiles.use((store) => store.folder(first?.revision.hash as never)));
    if (folder === null) throw new Error("No files for r1");
    unlock(folder);
    fs.rmSync(path.join(folder, "notes.md"));
    await runtime.runPromise(SkillReviews.use((reviews) => reviews.recover));
    const states = Object.fromEntries((await proposals()).map((view) => [view.proposal.name, view.proposal.state]));
    expect(states).toEqual({ "release-steps": "waiting", "review-steps": "added" });
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-154] a revision that lands while a change is written is not overwritten: the change is built again on it", async () => {
    const add = (files: ReadonlyArray<{ path: string; text: string; executable?: boolean }>, skillId?: string) =>
      SkillImporter.use((importer) =>
        importer.add(
          { _tag: "Written", files },
          { by: { _tag: "You" }, ...(skillId === undefined ? {} : { skillId: skillId as never }) },
        ),
      );
    const [first] = await runtime.runPromise(
      add([
        { path: "SKILL.md", text: skillMd("release-steps") },
        { path: "scripts/tag.sh", text: "#!/bin/sh\ngit tag v1\n", executable: true },
      ]),
    );
    const skillId = first?.revision.skillId;
    await propose("release-steps", { basedOn: 1, body: "Tag, then push." });
    const [waiting] = await proposals();
    // r2 lands after the add read r1's files, before it is written: it fixes the script.
    races.push(
      add(
        [
          { path: "SKILL.md", text: skillMd("release-steps", "Fixed.") },
          { path: "scripts/tag.sh", text: '#!/bin/sh\ngit tag "$1"\n', executable: true },
        ],
        skillId,
      ),
    );
    const added = await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/add`, {});
    expect(added).toMatchObject({ status: 200, body: { state: "added", added: { number: 3, as: "new" } } });
    const folder = await runtime.runPromise(SkillFiles.use((store) => store.folder(added.body.added.hash)));
    if (folder === null) throw new Error("No files for r3");
    expect(fs.readFileSync(path.join(folder, "scripts/tag.sh"), "utf8")).toBe('#!/bin/sh\ngit tag "$1"\n');

    // A skill that moves on at every try is sent back to you, with nothing written over it.
    await propose("release-steps", { basedOn: 3, body: "Tag, push, announce.", key: "again", work: "reply:m2" });
    const again = (await proposals()).find((one) => one.proposal.state === "waiting");
    for (const body of ["Four.", "Five.", "Six."]) {
      races.push(add([{ path: "SKILL.md", text: skillMd("release-steps", body) }], skillId));
    }
    const moved = await request("POST", `/api/skill-proposals/${again?.proposal.id}/add`, {});
    expect(moved).toMatchObject({ status: 409, body: { _tag: "SkillEditStale" } });
    expect((await proposals()).find((one) => one.proposal.id === again?.proposal.id)?.proposal.state).toBe("waiting");
    expect((await library())[0]?.revisions).toBe(6);
    // The library refuses a revision built on one that is no longer the newest, whoever writes it.
    const stale = await runtime.runPromise(
      SkillWriter.use((writer) =>
        writer.write([{ path: "SKILL.md", text: skillMd("release-steps", "Seven.") }], {
          by: { _tag: "You" },
          skillId: skillId as never,
          after: first?.revision.hash as never,
        }),
      ).pipe(Effect.flip),
    );
    expect(stale._tag).toBe("SkillMovedOn");
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-155] a change that is an earlier revision again says so, and rolls back to it; the newest again changes nothing", async () => {
    await importSkill("release-steps");
    const [skill] = await library();
    await call(SKILL_REQUEST_TOOL, { name: "release-steps", why: "To release." }, accessFor("trusting"));
    const revised = await request("POST", `/api/skills/${skill?.id}/revisions`, {
      source: { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("release-steps", "Tag, then push.") }] },
    });
    expect(revised.status).toBe(200);
    const pinOf = async () =>
      (await runtime.runPromise(SkillLibrary.use((skills) => skills.assignments(skill?.id as never))))[0]?.pin;
    const r1 = (await runtime.runPromise(SkillLibrary.use((skills) => skills.revisions(skill?.id as never)))).find(
      (one) => one.number === 1,
    );
    // Ada moves to r2 when you roll it out, then proposes r1's words again.
    const r2 = (await library())[0]?.latest;
    await runtime.runPromise(
      SkillLibrary.use((skills) => skills.rollOutRevision(skill?.id as never, r2 as never, { _tag: "You" }, "always")),
    );
    expect(await pinOf()).toBe(r2);
    await propose("release-steps", { basedOn: 2, body: "Steps for release-steps." });
    const [waiting] = await proposals();
    expect(waiting?.check).toEqual({ flags: [], existing: 1 });
    const added = await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/add`, {});
    expect(added).toMatchObject({ status: 200, body: { state: "added", added: { number: 1, as: "earlier" } } });
    expect((await library())[0]?.revisions).toBe(2);
    expect(await pinOf()).toBe(r1?.hash);
    expect(await propose("release-steps", { basedOn: 2, body: "Steps for release-steps." })).toEqual({
      text: "The user accepted a change to release-steps. It is what r1 said, so release-steps went back to r1. You use it from your next turn.",
      refused: false,
    });

    // The newest revision's words again: accepted, and the library is as it was.
    await propose("release-steps", { basedOn: 2, body: "Tag, then push.", key: "same", work: "reply:m2" });
    const same = (await proposals()).find((one) => one.proposal.state === "waiting");
    expect(same?.check).toEqual({ flags: [], existing: 2 });
    const kept = await request("POST", `/api/skill-proposals/${same?.proposal.id}/add`, {});
    expect(kept).toMatchObject({ status: 200, body: { added: { number: 2, as: "same" } } });
    expect((await library())[0]?.revisions).toBe(2);
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-156] a note is left on the revision the turn mounted, even after a rollout moved the hob on", async () => {
    await importSkill("release-steps");
    const [skill] = await library();
    await call(SKILL_REQUEST_TOOL, { name: "release-steps", why: "To release." }, accessFor("trusting"));
    const r1 = skill?.latest;
    const noted = await runtime.runPromise(
      Effect.gen(function* () {
        // The turn starts on r1.
        const tools = yield* (yield* SkillTools)
          .forTurn(turnFor(accessFor("trusting")))
          .pipe(
            Effect.provideService(TurnSkillsInUse, [
              { skillId: skill?.id as never, name: "release-steps" as never, pin: r1 as never, onlyWhenAsked: false },
            ]),
          );
        // r2 rolls out to Ada during the turn.
        const importer = yield* SkillImporter;
        const [r2] = yield* importer.add(
          { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("release-steps", "Tag, then push.") }] },
          { by: { _tag: "You" }, skillId: skill?.id as never },
        );
        yield* (yield* SkillLibrary).rollOutRevision(
          skill?.id as never,
          r2?.revision.hash as never,
          { _tag: "You" },
          "pending",
        );
        return yield* tools?.call(SKILL_FEEDBACK_TOOL, {
          name: "release-steps",
          kind: "unclear",
          note: "Step 2 is unclear.",
        }) ?? Effect.die("No tools");
      }),
    );
    expect(noted.refused).toBe(false);
    const assignments = await runtime.runPromise(SkillLibrary.use((skills) => skills.assignments(skill?.id as never)));
    expect(assignments[0]?.pin).not.toBe(r1);
    expect((await request("GET", `/api/skills/${skill?.id}/feedback`)).body.feedback).toMatchObject([
      { note: "Step 2 is unclear.", revision: r1 },
    ]);
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-157] the review shows what the checks flag, and checks your edit before it is added", async () => {
    await propose("release-steps", { body: "Read https://example.com/release first.\u200B Then tag." });
    const [waiting] = await proposals();
    expect(waiting?.check?.flags).toEqual([
      { _tag: "Url", path: "SKILL.md", url: "https://example.com/release" },
      { _tag: "HiddenText", path: "SKILL.md", codePoint: "U+200B" },
    ]);
    const id = waiting?.proposal.id;
    // Your edit is checked as adding it would check it, and nothing is written.
    const clean = await request("POST", `/api/skill-proposals/${id}/check`, {
      instructions: skillMd("release-steps", "Tag."),
    });
    expect(clean).toMatchObject({ status: 200, body: { flags: [], existing: null } });
    const linked = await request("POST", `/api/skill-proposals/${id}/check`, {
      instructions: skillMd("release-steps", "See http://example.org."),
    });
    expect(linked.body.flags).toEqual([{ _tag: "Url", path: "SKILL.md", url: "http://example.org" }]);
    const broken = await request("POST", `/api/skill-proposals/${id}/check`, {
      instructions: skillMd("release-steps").replace("name: release-steps", "name: Release Steps"),
    });
    expect(broken).toMatchObject({ status: 422, body: { _tag: "SkillImportRefused" } });
    expect((await proposals())[0]?.proposal).toMatchObject({ state: "waiting", edited: false });
    expect(await library()).toEqual([]);
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-158] a hub stopped after writing a proposal finishes what it planned, and never undoes a later rollout", async () => {
    await importSkill("release-steps");
    const [skill] = await library();
    const skillId = skill?.id as never;
    await call(SKILL_REQUEST_TOOL, { name: "release-steps", why: "To release." }, accessFor("trusting"));
    const pinOf = async () =>
      (await runtime.runPromise(SkillLibrary.use((skills) => skills.assignments(skillId))))[0]?.pin;
    const revise = (body: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const [added] = yield* (yield* SkillImporter).add(
            { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("release-steps", body) }] },
            { by: { _tag: "You" }, skillId },
          );
          const hash = added?.revision.hash as never;
          yield* (yield* SkillLibrary).rollOutRevision(skillId, hash, { _tag: "You" }, "pending");
          return hash;
        }),
      );

    // The hub stops after it wrote r2, before r2 rolled out or the proposal was marked added.
    await propose("release-steps", { basedOn: 1, body: "Tag, then push." });
    const [waiting] = await proposals();
    stop.afterWrite = true;
    expect((await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/add`, {})).status).toBe(500);
    expect((await proposals())[0]?.proposal).toMatchObject({ state: "adding", planned: { as: "new" } });
    // Meanwhile you write r3 and roll it out.
    const r3 = await revise("Your own steps.");
    expect(await pinOf()).toBe(r3);
    await runtime.runPromise(SkillReviews.use((reviews) => reviews.recover));
    expect((await proposals()).find((one) => one.proposal.id === waiting?.proposal.id)?.proposal).toMatchObject({
      state: "added",
      added: { number: 2, as: "new" },
      planned: null,
    });
    expect(await pinOf()).toBe(r3);

    // A rollback to r1 that was made before the hub stopped is not made again, even once you moved
    // Ada back to the very revision it rolled back from.
    const r1 = (await runtime.runPromise(SkillLibrary.use((skills) => skills.revisions(skillId)))).find(
      (one) => one.number === 1,
    )?.hash as never;
    await propose("release-steps", { basedOn: 3, body: "Steps for release-steps.", key: "back", work: "reply:m2" });
    const back = (await proposals()).find((one) => one.proposal.state === "waiting");
    if (back === undefined) throw new Error("No proposal waits");
    await runtime.runPromise(
      Effect.gen(function* () {
        const log = yield* SkillProposalLog;
        const planned = { hash: r1, after: r3, as: "earlier" as const };
        yield* log.move(new SkillProposal({ ...back.proposal, state: "adding", planned }), ["waiting"]);
        yield* (yield* SkillLibrary).deliver(`skill-proposal:${back.proposal.id}`, {
          _tag: "RollOut",
          skillId,
          pin: r1,
          by: { _tag: "Hob", agentId: ada },
          when: "always",
        });
      }),
    );
    expect(await pinOf()).toBe(r1);
    const [assignment] = await runtime.runPromise(SkillLibrary.use((skills) => skills.assignments(skillId)));
    await runtime.runPromise(
      SkillLibrary.use((skills) => skills.rollOut(assignment?.id as never, r3, { _tag: "You" })),
    );
    expect(await pinOf()).toBe(r3);
    await runtime.runPromise(SkillReviews.use((reviews) => reviews.recover));
    expect((await proposals()).find((one) => one.proposal.id === back.proposal.id)?.proposal).toMatchObject({
      state: "added",
      added: { number: 1, as: "earlier" },
    });
    expect(await pinOf()).toBe(r3);
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-159] a change that is an earlier revision again rolls back every assignment not held, whatever it is on", async () => {
    await importSkill("release-steps");
    const [skill] = await library();
    const skillId = skill?.id as never;
    await call(SKILL_REQUEST_TOOL, { name: "release-steps", why: "To release." }, accessFor("trusting"));
    const revise = (body: string) =>
      runtime.runPromise(
        SkillImporter.use((importer) =>
          importer.add(
            { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd("release-steps", body) }] },
            { by: { _tag: "You" }, skillId },
          ),
        ).pipe(Effect.map(([added]) => added?.revision.hash as never)),
      );
    const r2 = await revise("Second steps.");
    const r3 = await revise("Third steps.");
    const r1 = skill?.latest as never;
    // Ada is on r3; every hob is on r2 after you rolled that one back; a project holds r2.
    await runtime.runPromise(
      Effect.gen(function* () {
        const skills = yield* SkillLibrary;
        yield* skills.rollOutRevision(skillId, r3, { _tag: "You" }, "always");
        const assign = (scope: SkillScope, pin: never, held: boolean) =>
          skills.assign({ skillId, scope, pin, held, onlyWhenAsked: false, by: { _tag: "You" } });
        yield* assign({ _tag: "Everyone" }, r2, false);
        yield* assign({ _tag: "Project", identity: memoryProjectIdentity(null, "site") }, r2, true);
      }),
    );
    await propose("release-steps", { basedOn: 3, body: "Steps for release-steps." });
    const [waiting] = await proposals();
    const added = await request("POST", `/api/skill-proposals/${waiting?.proposal.id}/add`, {});
    expect(added).toMatchObject({ status: 200, body: { added: { number: 1, as: "earlier" } } });
    const pins = Object.fromEntries(
      (await runtime.runPromise(SkillLibrary.use((skills) => skills.assignments(skillId)))).map((one) => [
        one.scope._tag,
        one.pin,
      ]),
    );
    expect(pins).toEqual({ Hob: r1, Everyone: r1, Project: r2 });
  });

  // covers ADR 029 (Proactive hobs), #1063
  it("[TC-AG-149] a request goes through under Trusting, asks under Careful and Balanced, and Never offers no tool", async () => {
    await importSkill("release-steps");
    // Careful and Balanced ask, and a call with no one to ask is refused, with nothing assigned.
    for (const preset of ["careful", "balanced"] as const) {
      const answer = await runtime.runPromise(
        Effect.gen(function* () {
          const tools = yield* (yield* SkillTools).forTurn(turnFor(accessFor(preset)));
          return yield* tools?.call(SKILL_REQUEST_TOOL, { name: "release-steps", why: "To release." }) ??
            Effect.die("No tools");
        }),
      );
      expect(answer.refused).toBe(true);
    }
    const found = await call(SKILL_SEARCH_TOOL, { query: "release" }, accessFor("trusting"));
    expect(found.text).toContain("release-steps (newest r1)");
    const asked = await call(SKILL_REQUEST_TOOL, { name: "release-steps", why: "To release." }, accessFor("trusting"));
    expect(asked).toMatchObject({ refused: false });
    expect((await call(SKILL_SEARCH_TOOL, { query: "release" }, accessFor("trusting"))).text).toContain("you have r1");
    const noted = await call(
      SKILL_FEEDBACK_TOOL,
      { name: "release-steps", kind: "outdated", note: "Step 2 names an old branch." },
      accessFor("trusting"),
    );
    expect(noted.refused).toBe(false);
    const [skill] = await library();
    expect((await request("GET", `/api/skills/${skill?.id}/feedback`)).body.feedback).toMatchObject([
      { kind: "outdated", note: "Step 2 names an old branch." },
    ]);
    // Never for proposals takes the tool away; the others stay.
    const never = await offered(accessFor("trusting", { "propose-skill": "deny" }));
    expect(never?.tools.map((tool) => tool.name)).toEqual([SKILL_SEARCH_TOOL, SKILL_REQUEST_TOOL, SKILL_FEEDBACK_TOOL]);
  });
});
