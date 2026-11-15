import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimRegister, GitWorkspace, HobGitHubApps, HobTools } from "@hobbots/agents";
import { type Agent, EMPTY_HOB_POLICY, type HobGitHubApp, OWNER_ACTOR } from "@hobbots/domain";
import { SetupRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { GitWorkspaceLive } from "@hobbots/workbench";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { NodeFolderChecks } from "../src/folders.ts";
import { Installation } from "../src/installation.ts";
import { HobToolsLive, runtimeFolders } from "../src/tools.ts";

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-tools-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const dataDir = join(temp, "hub", "data");
const project = join(temp, "project");
mkdirSync(dataDir, { recursive: true });
mkdirSync(project);

const hob = { id: "hob-1", policy: EMPTY_HOB_POLICY } as unknown as Agent;

/** The hobs' own GitHub Apps, as a hub with the GitHub Charm keeps them. */
const appsWith = (apps: Readonly<Record<string, HobGitHubApp>>) =>
  Layer.succeed(HobGitHubApps, {
    get: (id: string) => Effect.succeed(apps[id] ?? null),
  } as unknown as HobGitHubApps["Service"]);

const accessWith = (approvedFolders: ReadonlyArray<string>, apps: Layer.Layer<never> = Layer.empty) =>
  Effect.gen(function* () {
    const setup = yield* SetupRepository;
    yield* setup.update({ approvedFolders: [...approvedFolders] }, OWNER_ACTOR);
    const tools = yield* HobTools;
    return yield* tools.access(hob);
  }).pipe(
    Effect.provide(
      HobToolsLive.pipe(
        Layer.provideMerge(SetupRepository.layer),
        Layer.provide(NodeFolderChecks),
        Layer.provide(apps),
        Layer.provide(TestDatabase),
        Layer.provide(
          Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
        ),
      ),
    ),
    Effect.runPromise,
  );

describe("a hob's tools", () => {
  it("works in the hob's folders and keeps its runtime state beside the data folder", async () => {
    const access = await accessWith([project]);
    expect(access?.folders).toEqual([project]);
    expect(access?.runtimeFolder).toBe(join(runtimeFolders(dataDir), "hob-1"));
  });

  it("gives no tools when a folder holds every hob's runtime state", async () => {
    // Chat-only, with the runtime folder kept so the channel's session still moves back.
    for (const folders of [[join(temp, "hub")], [temp, project]]) {
      const access = await accessWith(folders);
      expect(access?.folders).toEqual([]);
      expect(access?.runtimeFolder).toBe(join(runtimeFolders(dataDir), "hob-1"));
    }
  });

  // covers ADR 022
  it("commits as the hob's bot when it has its own GitHub App, and as the user otherwise", async () => {
    const app: HobGitHubApp = {
      appId: 1000,
      clientId: "Iv23test",
      slug: "frodo-hobbots",
      origin: "made",
      owner: "otaviobarros",
      botUserId: 90001000,
      htmlUrl: "https://github.com/apps/frodo-hobbots",
      connectedAt: "2026-11-02T00:00:00.000Z",
    };
    const asBot = await accessWith([project], appsWith({ "hob-1": app }));
    expect(asBot?.commitAs).toEqual({
      name: "frodo-hobbots[bot]",
      email: "90001000+frodo-hobbots[bot]@users.noreply.github.com",
    });
    // Without an app, or on a hub without the GitHub Charm, the hob keeps the user's identity.
    expect((await accessWith([project], appsWith({})))?.commitAs).toBeUndefined();
    expect((await accessWith([project]))?.commitAs).toBeUndefined();
  });

  // Issue #1578
  it("asks Git nothing while nothing is taken, nor for a read that needs only the folders (#1578)", async () => {
    // The hob's folder is a checkout whose `docs` you took over.
    execFileSync("git", ["init", "-q"], { cwd: project });
    mkdirSync(join(project, "docs"), { recursive: true });
    let reads = 0;
    let taken: ReadonlyArray<{ key: string; gitFolder: string }> = [];
    const git = Layer.effect(
      GitWorkspace,
      Effect.map(Effect.service(GitWorkspace), (live) =>
        GitWorkspace.of({
          ...live,
          worktreesOf: (top) =>
            Effect.suspend(() => {
              reads += 1;
              return live.worktreesOf(top);
            }),
        }),
      ),
    ).pipe(Layer.provide(GitWorkspaceLive));
    const claims = Layer.succeed(ClaimRegister, {
      takenCheckouts: Effect.sync(() => taken),
    } as unknown as ClaimRegister["Service"]);
    await Effect.gen(function* () {
      const setup = yield* SetupRepository;
      yield* setup.update({ approvedFolders: [project] }, OWNER_ACTOR);
      const tools = yield* HobTools;
      const full = () => Effect.map(tools.access(hob), (access) => access?.taken);
      const folders = () => tools.access(hob, undefined, { taken: false });

      // Nothing taken: nothing is closed, and Git is not asked.
      expect(yield* full()).toBeUndefined();
      expect((yield* folders())?.folders).toEqual([project]);
      expect(reads).toBe(0);

      // `docs` taken: the full read closes it; a read of the folders alone asks nothing.
      taken = [{ key: "docs", gitFolder: join(project, ".git") }];
      expect(yield* full()).toEqual([join(project, "docs")]);
      const plain = yield* folders();
      expect(plain?.taken).toBeUndefined();
      expect(plain?.folders).toEqual([project]);
      expect(reads).toBe(1);
    }).pipe(
      Effect.provide(
        HobToolsLive.pipe(
          Layer.provideMerge(SetupRepository.layer),
          Layer.provide(NodeFolderChecks),
          Layer.provide(Layer.mergeAll(git, claims)),
          Layer.provide(TestDatabase),
          Layer.provide(
            Layer.succeed(Installation, { app: "hobbots", installationId: "test", version: "0.0.0", dataDir }),
          ),
        ),
      ),
      Effect.runPromise,
    );
  });
});
