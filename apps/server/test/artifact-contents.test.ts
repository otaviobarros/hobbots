import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityStore,
  ArtifactContents,
  HobbotsRepository,
  RecordRepository,
  SecretRedaction,
  type StoredArtifact,
} from "@hobbots/agents";
import {
  Agent,
  AgentId,
  Artifact,
  AttemptId,
  ChapterId,
  ContentId,
  RegisteredArtifactId,
  type StoredVersion,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { HobbotsRepositoryLive, SetupRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { HobFilesLive } from "@hobbots/workbench";
import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeFolderChecks } from "../src/folders.ts";

// Issue #1434 (ADR 037, Records): an artifact's versions and their contents, read only, for the camp
// sheet. A version's contents are what the hub kept, or the latest as it is now, only inside the
// folders of the hob whose camp it is in, never a file named as a secret's; text redacted and cut.

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-artifact-contents-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const project = join(temp, "project");
const outside = join(temp, "outside");

const AT = "2026-11-12T10:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const CAMP = ThreadId.make("camp");
const HUB_SECRET = "hub-credential-0123456789";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const KEPT = ContentId.make("kept-1");
const ATTEMPT = AttemptId.make("a1");

const write = (folder: string, path: string, contents: string | Uint8Array) => {
  mkdirSync(join(folder, path, ".."), { recursive: true });
  writeFileSync(join(folder, path), contents);
};

const artifact = (id: string, locator: string) =>
  new Artifact({
    id: RegisteredArtifactId.make(id),
    threadId: CAMP,
    chapterId: ChapterId.make("c1"),
    kind: "doc",
    title: id,
    locator,
    latestVersion: 2,
    origin: { kind: "attempt", id: ATTEMPT },
    actor: { kind: "hob", id: ALDRIC },
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
  });

const version = (number: number, source: StoredVersion["source"] = { _tag: "none" }): StoredVersion => ({
  version: number,
  at: AT,
  origin: { kind: "attempt", id: ATTEMPT },
  source,
});

const kept = { _tag: "kept", attemptId: ATTEMPT, contentId: KEPT } as const;

/** Every artifact the camp holds, with its versions, as the registry would read them. */
const STORED: ReadonlyArray<StoredArtifact> = [
  { artifact: artifact("report", join(project, "report.md")), versions: [version(1, kept), version(2)] },
  { artifact: artifact("chart", join(project, "chart.png")), versions: [version(1)] },
  { artifact: artifact("env", join(project, ".env")), versions: [version(1)] },
  { artifact: artifact("elsewhere", join(outside, "notes.md")), versions: [version(1)] },
  { artifact: artifact("escape", join(project, "escape.md")), versions: [version(1)] },
  { artifact: artifact("binary", join(project, "data.bin")), versions: [version(1)] },
  {
    artifact: artifact("headlines", "text:ref-1"),
    versions: [version(1, { _tag: "text", text: `Use ${HUB_SECRET}.` })],
  },
  { artifact: artifact("pr", "https://github.com/me/app/pull/7"), versions: [version(1)] },
];

const Records = Layer.succeed(
  RecordRepository,
  RecordRepository.of({
    artifactVersions: (threadId: ThreadId, artifactId: RegisteredArtifactId) =>
      Effect.succeed(
        Option.fromNullishOr(
          STORED.find((each) => each.artifact.id === artifactId && each.artifact.threadId === threadId),
        ),
      ),
  } as unknown as RecordRepository["Service"]),
);

const Store = Layer.succeed(
  ActivityStore,
  ActivityStore.of({
    get: (id: ContentId) =>
      Effect.succeed(
        id === KEPT ? Option.some(new TextEncoder().encode(`# Report\n\nKept ${HUB_SECRET}.\n`)) : Option.none(),
      ),
  } as unknown as ActivityStore["Service"]),
);

const Seed = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* (yield* SetupRepository).update({ safetyPreset: "balanced", approvedFolders: [project] });
    const repo = yield* HobbotsRepository;
    yield* repo.insertAgent(
      new Agent({
        id: ALDRIC,
        name: "Aldric",
        roleTitle: "Writer",
        runtime: "claude-code",
        model: null,
        effort: null,
        instructions: "",
        lookSeed: 1,
        lookColor: "moss",
        configVersion: 1,
        createdAt: AT,
      }),
    );
    yield* repo.upsertThread(new Thread({ id: CAMP, agentId: ALDRIC, title: "Launch", createdAt: AT, updatedAt: AT }));
  }),
);

const App = ArtifactContents.layer.pipe(
  Layer.provideMerge(Seed),
  Layer.provideMerge(
    Layer.mergeAll(
      Records,
      Store,
      HobFilesLive,
      NodeFolderChecks,
      SecretRedaction.layer([{ value: HUB_SECRET, kind: "HUB_TOKEN" }]),
      HobbotsRepositoryLive,
      SetupRepository.layer,
    ),
  ),
  Layer.provideMerge(TestDatabase),
);

let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>;
beforeAll(async () => {
  write(project, "report.md", `# Report\n\nNow ${HUB_SECRET}.\n`);
  write(project, "chart.png", PNG);
  write(project, ".env", "API_TOKEN=x\n");
  write(project, "data.bin", "\u0000\u0001");
  write(outside, "notes.md", "Not for hobs.\n");
  // A link the hob left in its folder, to a file outside every folder of its.
  symlinkSync(join(outside, "notes.md"), join(project, "escape.md"));
  runtime = ManagedRuntime.make(App);
  await runtime.runPromise(Effect.void);
});
afterAll(() => runtime?.dispose());

const decoder = new TextDecoder();
const content = (id: string, number: number, thread = CAMP) =>
  runtime.runPromise(
    Effect.exit(
      ArtifactContents.use((contents) => contents.content(thread, RegisteredArtifactId.make(id), number)).pipe(
        Effect.map((bytes) => decoder.decode(bytes)),
        Effect.mapError((error) => (error._tag === "ArtifactContentUnavailable" ? error.reason : error._tag)),
      ),
    ),
  );
const refused = (exit: Exit.Exit<string, string>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.map((reason) => ("error" in reason ? reason.error : reason)) : [];

describe("an artifact's contents", () => {
  // covers ADR 037 (Records: Artifact), #1434
  it("[TC-CH-1434-03] lists its versions newest first, each kept, read now or not kept", async () => {
    const versions = await runtime.runPromise(
      ArtifactContents.use((contents) => contents.versions(CAMP, RegisteredArtifactId.make("report"))),
    );
    expect(versions.show).toBe("document");
    expect(versions.versions.map((each) => [each.version, each.content])).toEqual([
      [2, "now"],
      [1, "kept"],
    ]);
  });

  // covers ADR 037 (Records: Artifact), PE-006, #1434
  it("[TC-CH-1434-04] serves kept and current text redacted, refuses a path outside the hob's folders, a secret's name and a link out", async () => {
    const [older, latest] = [await content("report", 1), await content("report", 2)];
    expect(older).toEqual(Exit.succeed(expect.stringContaining("# Report\n\nKept ")));
    expect(latest).toEqual(Exit.succeed(expect.stringContaining("# Report\n\nNow ")));
    for (const each of [older, latest]) expect(JSON.stringify(each)).not.toContain(HUB_SECRET);
    expect(await content("headlines", 1)).toEqual(Exit.succeed(expect.not.stringContaining(HUB_SECRET)));
    expect(refused(await content("elsewhere", 1))).toEqual(["outside-folders"]);
    expect(refused(await content("env", 1))).toEqual(["secret"]);
    expect(refused(await content("escape", 1))).toEqual(["gone"]);
    expect(refused(await content("binary", 1))).toEqual(["no-contents"]);
    expect(refused(await content("pr", 1))).toEqual(["no-contents"]);
    expect(refused(await content("report", 3))).toEqual(["ArtifactNotFound"]);
    expect(refused(await content("report", 2, ThreadId.make("other")))).toEqual(["ArtifactNotFound"]);
    const image = await runtime.runPromise(
      ArtifactContents.use((contents) => contents.content(CAMP, RegisteredArtifactId.make("chart"), 1)),
    );
    expect([...image]).toEqual([...PNG]);
  });
});
