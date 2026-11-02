import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HobGitHubApps, HobTools } from "@hobbots/agents";
import { type Agent, EMPTY_HOB_POLICY, type HobGitHubApp } from "@hobbots/domain";
import { SetupRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
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
    yield* setup.update({ approvedFolders: [...approvedFolders] });
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

  it("[TC-PE-017] gives no tools when a folder holds every hob's runtime state", async () => {
    // covers PE-005
    // Chat-only, with the runtime folder kept so the thread's session still moves back.
    for (const folders of [[join(temp, "hub")], [temp, project]]) {
      const access = await accessWith(folders);
      expect(access?.folders).toEqual([]);
      expect(access?.runtimeFolder).toBe(join(runtimeFolders(dataDir), "hob-1"));
    }
  });

  // covers ADR 022
  it("[TC-CH-198] commits as the hob's bot when it has its own GitHub App, and as the user otherwise", async () => {
    const app: HobGitHubApp = {
      appId: 1000,
      clientId: "Iv23test",
      slug: "frodo-hobbots",
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
});
