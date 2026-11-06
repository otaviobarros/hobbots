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
  type PromptRequest,
  RuntimeAdapter,
  type SkillMount,
} from "@hobbots/agents";
import { type Agent, isInProgress, type Message, roleFields, type Thread } from "@hobbots/domain";
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
import { Effect, Layer, Schedule, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/event-bus.ts";
import { NodeFolderChecks } from "../src/folders.ts";
import { ApiRoutes } from "../src/http.ts";
import { Installation } from "../src/installation.ts";
import { SkillsLive } from "../src/skills.ts";
import { AS_WINDOW, TestDevices } from "./window-device.ts";

// #1061: where each skill applies, and what every turn is given (ADR 029, Scopes, Pins and rollout).

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;
let root: string;

/** The skills each turn was given, in the order the turns started. */
let given: Array<ReadonlyArray<SkillMount>>;
/** A turn whose prompt holds `hold` waits here before the runtime answers it. */
let release: () => void;
let held: Promise<void>;

const skillMd = (name: string, description = `What ${name} is for.`, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

const written = (name: string, description?: string, extra?: string) => ({
  _tag: "Written",
  files: [{ path: "SKILL.md", text: skillMd(name, description, extra) }],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hobbots-skill-assign-"));
  const data = join(root, "data");
  const agentsFolder = join(root, "agents-skills");
  await mkdir(join(agentsFolder, "shared"), { recursive: true });
  await writeFile(join(agentsFolder, "shared", "SKILL.md"), skillMd("shared"));
  given = [];
  held = new Promise((resolve) => {
    release = resolve;
  });
  const fake = makeFakeRuntime();
  // The fake runtime, recording what each turn was given before it answers.
  const recording = {
    ...fake,
    sendPrompt: (request: PromptRequest) => {
      given.push(request.skills ?? []);
      const answer = fake.sendPrompt({ ...request, prompt: request.prompt.replace(/^hold\n/, "") });
      return request.prompt.startsWith("hold\n")
        ? Stream.unwrap(
            Effect.as(
              Effect.promise(() => held),
              answer,
            ),
          )
        : answer;
    },
  };
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
        Layer.succeed(RuntimeAdapter, recording),
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

afterEach(() => {
  release();
  return dispose();
});

// biome-ignore lint/suspicious/noExplicitAny: the routes' bodies are read as JSON.
const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await handler(
    new Request(`http://localhost:4365${path}`, {
      method,
      headers: { "content-type": "application/json", ...AS_WINDOW },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const eventually = <A>(read: () => Promise<A | undefined>) =>
  Effect.runPromise(
    Effect.tryPromise(read).pipe(
      Effect.flatMap((value) => (value === undefined ? Effect.fail("waiting" as const) : Effect.succeed(value))),
      Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 2_000 }),
    ),
  );

const summon = async (name: string, lookSeed: number): Promise<Agent> =>
  (
    await request("POST", "/api/agents", {
      name,
      ...roleFields("writer"),
      lookSeed,
      lookColor: "moss",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    })
  ).body;

const messages = async (thread: Thread): Promise<ReadonlyArray<Message>> =>
  (await request("GET", `/api/threads/${thread.id}/messages`)).body;

const send = async (thread: Thread, content: string) => {
  const sent = await request("POST", `/api/threads/${thread.id}/messages`, { content });
  expect(sent.status).toBe(200);
};

/** Waits until the thread holds `count` replies, all ended, and returns the last. */
const replies = (thread: Thread, count: number) =>
  eventually(async () => {
    const ended = (await messages(thread)).filter((m) => m.role === "assistant" && !isInProgress(m.status));
    return ended.length >= count ? ended.at(-1) : undefined;
  });

const importSkill = async (name: string, extra?: string) => {
  const imported = await request("POST", "/api/skills", { source: written(name, undefined, extra) });
  expect(imported.status).toBe(200);
  return imported.body.imported[0];
};

describe("skill assignments", () => {
  // covers RT-001, ADR 029 (Scopes, Delivery per runtime)
  it("[TC-AG-142] a turn gets Everyone's skills, the hob's own and Only when asked ones, never another hob's or one it opted out of", async () => {
    const pip = await summon("Pip", 961);
    const quill = await summon("Quill", 962);
    const releaseSkill = await importSkill("release");
    const review = await importSkill("review");
    const shared = (await request("GET", "/api/skills")).body.skills.find(
      (skill: { name: string }) => skill.name === "shared",
    );

    const toPip = await request("POST", `/api/skills/${releaseSkill.skill.id}/assignments`, {
      scope: { _tag: "Hob", agentId: pip.id },
    });
    expect(toPip).toMatchObject({ status: 200, body: { pin: releaseSkill.revision.hash, held: false } });
    await request("POST", `/api/skills/${review.skill.id}/assignments`, {
      scope: { _tag: "Everyone" },
      onlyWhenAsked: true,
    });
    const unknownHob = await request("POST", `/api/skills/${releaseSkill.skill.id}/assignments`, {
      scope: { _tag: "Hob", agentId: crypto.randomUUID() },
    });
    expect(unknownHob.status).toBe(404);

    const pipThread: Thread = (await request("POST", `/api/agents/${pip.id}/threads`)).body;
    await send(pipThread, "/skills");
    expect((await replies(pipThread, 1)).content).toBe("release\nreview (only when asked)\nshared");
    expect(given.at(-1)?.map((mount) => [mount.name, mount.revision])).toEqual([
      ["release", releaseSkill.revision.hash],
      ["review", review.revision.hash],
      ["shared", shared.latest],
    ]);

    // Another hob gets Everyone's, never Pip's own.
    const quillThread: Thread = (await request("POST", `/api/agents/${quill.id}/threads`)).body;
    await send(quillThread, "/skills");
    expect((await replies(quillThread, 1)).content).toBe("review (only when asked)\nshared");

    // Opting out of an Everyone skill takes it off that hob's next turn only.
    const optedOut = await request("PUT", `/api/skills/hobs/${quill.id}/opt-outs/${shared.id}`, { optedOut: true });
    expect(optedOut.body.optedOut).toEqual([shared.id]);
    await send(quillThread, "/skills");
    expect((await replies(quillThread, 2)).content).toBe("review (only when asked)");
    await send(pipThread, "/skills");
    expect((await replies(pipThread, 2)).content).toContain("shared");

    // Unassigned, it is gone from the next turn.
    expect((await request("DELETE", `/api/skills/assignments/${toPip.body.id}`)).status).toBe(200);
    await send(pipThread, "/skills");
    expect((await replies(pipThread, 3)).content).toBe("review (only when asked)\nshared");
  });

  // covers RT-001, ADR 029 (Pins and rollout)
  it("[TC-AG-143] saving a revision rolls it out to every assignment but a held one, running and queued turns keep their revision, and Roll back moves one back", async () => {
    const pip = await summon("Pip", 963);
    const quill = await summon("Quill", 964);
    const first = await importSkill("release");
    const toPip = (
      await request("POST", `/api/skills/${first.skill.id}/assignments`, { scope: { _tag: "Hob", agentId: pip.id } })
    ).body;
    const toQuill = (
      await request("POST", `/api/skills/${first.skill.id}/assignments`, {
        scope: { _tag: "Hob", agentId: quill.id },
      })
    ).body;
    const kept = await request("POST", `/api/skills/assignments/${toQuill.id}/hold`, { held: true });
    expect(kept.body).toMatchObject({ held: true, pin: first.revision.hash });

    // A turn starts on r1 and is still running when r2 is saved; a message queued behind it was accepted on r1.
    const thread: Thread = (await request("POST", `/api/agents/${pip.id}/threads`)).body;
    await send(thread, "hold\n/skills");
    await eventually(async () => (given.length === 1 ? true : undefined));
    await send(thread, "/skills");
    const revised = await request("POST", `/api/skills/${first.skill.id}/revisions`, {
      source: written("release", "Releases, now."),
    });
    expect(revised.status).toBe(200);
    const second = revised.body.revision;
    expect(revised.body.rolledOut.map((one: { id: string; pin: string }) => [one.id, one.pin])).toEqual([
      [toPip.id, second.hash],
    ]);
    // Saving the same content again moves nothing more.
    const again = await request("POST", `/api/skills/${first.skill.id}/revisions`, {
      source: written("release", "Releases, now."),
    });
    expect(again.body).toMatchObject({ added: false, rolledOut: [] });
    release();
    await replies(thread, 2);
    const pinOf = (mounts: ReadonlyArray<SkillMount> | undefined) =>
      mounts?.find((mount) => mount.name === "release")?.revision;
    expect([pinOf(given[0]), pinOf(given[1])]).toEqual([first.revision.hash, first.revision.hash]);

    // The next message gets r2, and each reply records the revision it used; the held hob stays on r1.
    await send(thread, "/skills");
    await replies(thread, 3);
    expect(pinOf(given.at(-1))).toBe(second.hash);
    const used = (await messages(thread))
      .filter((m) => m.role === "assistant")
      .map((m) => m.skills?.find((skill) => skill.name === "release")?.pin);
    expect(used).toEqual([first.revision.hash, first.revision.hash, second.hash]);
    const detail = (await request("GET", `/api/skills/${first.skill.id}`)).body;
    expect(Object.fromEntries(detail.assignments.map((one: { id: string; pin: string }) => [one.id, one.pin]))).toEqual(
      { [toPip.id]: second.hash, [toQuill.id]: first.revision.hash },
    );

    // Roll back is a rollout to an older revision; the held one moves only when you move it.
    const back = await request("POST", `/api/skills/${first.skill.id}/roll-out`, { pin: first.revision.hash });
    expect(back.body.rolledOut.map((one: { id: string }) => one.id)).toEqual([toPip.id]);
    const moved = await request("POST", `/api/skills/assignments/${toQuill.id}/roll-out`, { pin: second.hash });
    expect(moved.body).toMatchObject({ pin: second.hash, held: true });
    const unknown = await request("POST", `/api/skills/${first.skill.id}/roll-out`, { pin: "0".repeat(64) });
    expect(unknown.status).toBe(404);
  });

  // covers ADR 029 (Scopes, Skills and Charms)
  it("[TC-AG-144] a hob's skills show what replaced what, a name two of its projects define, and a Charm it lacks", async () => {
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    await mkdir(alpha);
    await mkdir(beta);
    await request("PATCH", "/api/setup", { completed: true, safetyPreset: "balanced", approvedFolders: [alpha, beta] });
    const pip = await summon("Pip", 965);
    const style = await importSkill("style");
    const deploy = await importSkill("deploy", "metadata:\n  hobbots:\n    charms: [github, slack]\n");
    for (const scope of [{ _tag: "Everyone" }, { _tag: "Hob", agentId: pip.id }])
      await request("POST", `/api/skills/${style.skill.id}/assignments`, { scope });
    for (const identity of ["alpha", "beta"])
      await request("POST", `/api/skills/${deploy.skill.id}/assignments`, { scope: { _tag: "Project", identity } });

    const view = (await request("GET", `/api/skills/hobs/${pip.id}`)).body;
    expect(
      view.skills.map((skill: { name: string; scope: { _tag: string } }) => [skill.name, skill.scope._tag]),
    ).toEqual([
      ["shared", "Everyone"],
      ["style", "Hob"],
    ]);
    expect(view.replaced).toMatchObject([
      { assignment: { scope: { _tag: "Everyone" } }, by: { scope: { _tag: "Hob" } } },
    ]);
    expect(view.clashes).toMatchObject([{ name: "deploy" }]);
    expect(view.clashes[0].assignments).toHaveLength(2);

    // With one project, it loads, and says which Charm the hob lacks.
    await request("PATCH", "/api/setup", { approvedFolders: [alpha] });
    const one = (await request("GET", `/api/skills/hobs/${pip.id}`)).body;
    expect(one.clashes).toEqual([]);
    expect(one.skills.find((skill: { name: string }) => skill.name === "deploy")).toMatchObject({
      scope: { _tag: "Project", identity: "alpha" },
      missingCharms: ["slack"],
    });
    expect((await request("GET", `/api/skills/hobs/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

// #1096: which skills a reply used, mapped to the revision its turn mounted, and how often (ADR 029, The use line).
describe("skill uses", () => {
  // covers RT-001, ADR 029 (The use line)
  it("[TC-AG-144] a reply records each skill it used at the revision its turn had, and never one it was not given", async () => {
    const pip = await summon("Pip", 965);
    const first = await importSkill("release-steps");
    await request("POST", `/api/skills/${first.skill.id}/assignments`, { scope: { _tag: "Hob", agentId: pip.id } });
    const second = (
      await request("POST", `/api/skills/${first.skill.id}/revisions`, { source: written("release-steps", "Now.") })
    ).body.revision;
    const thread: Thread = (await request("POST", `/api/agents/${pip.id}/threads`)).body;

    // The hob picks it on its own, twice in one turn, and names a skill it does not have.
    await send(thread, "fake:skill release-steps\nfake:skill release-steps\nfake:skill commit-style");
    const reply = await replies(thread, 1);
    expect(reply.skillsUsed).toEqual([
      {
        source: "library",
        skillId: first.skill.id,
        name: "release-steps",
        pin: second.hash,
        number: 2,
        explicit: false,
      },
    ]);
    // A reply that used none says so with an empty list.
    await send(thread, "Hello");
    expect((await replies(thread, 2)).skillsUsed).toEqual([]);
  });

  // covers RT-001, ADR 029 (Explicit use, The use line)
  it("[TC-AG-145] a skill you pick is handed to the turn and shown as yours, and its uses are counted per hob and thread", async () => {
    const pip = await summon("Pip", 966);
    const quill = await summon("Quill", 967);
    const skill = await importSkill("release-steps");
    await request("POST", `/api/skills/${skill.skill.id}/assignments`, { scope: { _tag: "Everyone" } });
    const pipThread: Thread = (await request("POST", `/api/agents/${pip.id}/threads`)).body;
    const quillThread: Thread = (await request("POST", `/api/agents/${quill.id}/threads`)).body;

    const sent = await request("POST", `/api/threads/${pipThread.id}/messages`, {
      content: "Ship it.",
      skill: "release-steps",
    });
    expect(sent.body.userMessage.askedSkill).toBe("release-steps");
    expect((await replies(pipThread, 1)).skillsUsed).toMatchObject([{ name: "release-steps", explicit: true }]);
    // A skill the hob does not have is not handed to the turn.
    const unknown = await request("POST", `/api/threads/${pipThread.id}/messages`, { content: "Go.", skill: "other" });
    expect(unknown.status).toBe(200);
    expect((await replies(pipThread, 2)).skillsUsed).toEqual([]);
    // Typed as the composer writes it, `/release-steps` at the start picks it, and the runtime gets the rest.
    await send(quillThread, "/release-steps Ship it.");
    const typed = await replies(quillThread, 1);
    expect(typed.skillsUsed).toMatchObject([{ name: "release-steps", explicit: true }]);
    expect(typed.content).toBe("Echo: Ship it.");
    expect((await messages(quillThread)).find((m) => m.role === "user")).toMatchObject({
      content: "/release-steps Ship it.",
      askedSkill: "release-steps",
    });
    await send(quillThread, "fake:skill release-steps");
    await replies(quillThread, 2);

    const counts = await request("GET", `/api/skills/${skill.skill.id}/uses`);
    expect(counts.body).toMatchObject({ skillId: skill.skill.id, total: 3, thisWeek: 3 });
    expect(counts.body.hobs.map((hob: { agentId: string; count: number }) => [hob.agentId, hob.count]).sort()).toEqual(
      [
        [pip.id, 1],
        [quill.id, 2],
      ].sort(),
    );
    expect(counts.body.threads.map((one: { threadId: string }) => one.threadId).sort()).toEqual(
      [pipThread.id, quillThread.id].sort(),
    );
    const list = (await request("GET", "/api/skills")).body;
    expect(list.usesThisWeek).toContainEqual({ skillId: skill.skill.id, count: 3 });
    const hob = (await request("GET", `/api/skills/hobs/${pip.id}`)).body;
    expect(hob.lastUsed).toMatchObject([
      { skillId: skill.skill.id, name: "release-steps", number: 1, threadId: pipThread.id, explicit: true },
    ]);
    expect((await request("GET", `/api/skills/${crypto.randomUUID()}/uses`)).status).toBe(404);
  });
});
