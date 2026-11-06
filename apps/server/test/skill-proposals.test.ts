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
  makeRedactor,
  PermissionSummary,
  SkillLibrary,
  SkillTools,
  type ToolAccess,
} from "@hobbots/agents";
import type { SkillProposalView } from "@hobbots/api";
import {
  Agent,
  AgentId,
  EMPTY_HOB_POLICY,
  type EventEnvelope,
  type HobPolicy,
  type SafetyPreset,
  SKILL_FEEDBACK_TOOL,
  SKILL_PROPOSE_TOOL,
  SKILL_REQUEST_TOOL,
  SKILL_SEARCH_TOOL,
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
import { SkillReviewsLive } from "../src/skill-proposals.ts";
import { SkillsLive } from "../src/skills.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// #1063: hobs proposing skills (ADR 029, Proactive hobs), from the hob's skill tools to your decision
// over HTTP, on the hub's database and skills store. Nothing a hob proposes reaches the library until
// you add it, a turned-down proposal leaves it as it was, and the hob is told either way.

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hobbots-skill-proposals-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const ada = AgentId.make("0d6e2f0a-0000-4000-8000-0000000000b1");
const folder = path.join(root, "work");
fs.mkdirSync(folder, { recursive: true });

const skillMd = (name: string, body = `Steps for ${name}.`) =>
  `---\nname: ${name}\ndescription: What ${name} is for, and when to use it.\n---\n\n# ${name}\n\n${body}\n`;

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
  const Skills = SkillToolsLive.pipe(Layer.provideMerge(SkillReviewsLive), Layer.provide(PolicyEngine.node));
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
      return yield* tools.call(name, input, { id: "step-1", report: () => undefined });
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
