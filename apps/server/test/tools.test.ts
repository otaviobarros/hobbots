import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, EMPTY_HOB_POLICY } from "@hobbots/domain";
import { SetupRepository } from "@hobbots/persistence";
import { TestDatabase } from "@hobbots/persistence/testing";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { Installation } from "../src/installation.ts";
import { HobTools, runtimeFolders } from "../src/tools.ts";

const temp = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-tools-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const dataDir = join(temp, "hub", "data");
const project = join(temp, "project");
mkdirSync(dataDir, { recursive: true });
mkdirSync(project);

const hob = { id: "hob-1", policy: EMPTY_HOB_POLICY } as unknown as Agent;

const accessWith = (approvedFolders: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const setup = yield* SetupRepository;
    yield* setup.update({ approvedFolders: [...approvedFolders] });
    const tools = yield* HobTools;
    return yield* tools.access(hob);
  }).pipe(
    Effect.provide(
      HobTools.layer.pipe(
        Layer.provideMerge(SetupRepository.layer),
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
    expect(await accessWith([join(temp, "hub")])).toBeNull();
    expect(await accessWith([temp, project])).toBeNull();
  });
});
