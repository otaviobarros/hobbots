import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EMPTY_HOB_POLICY, type SafetyPreset } from "@hobbots/domain";
import { Effect } from "effect";
import { afterAll, beforeAll } from "vitest";
import { type PolicyContext, PolicyEngine, type PolicyRequest, type PolicyVerdict } from "../src/index.ts";

/**
 * A pretend home folder on disk: a shared `project` folder holding Hobbots' data folder and a Git
 * repository, a hob's own `notes` folder, and personal files outside both, with symlinks that
 * point out of the project. Paths are left uncanonical (on macOS the temp folder is itself a
 * symlink) so every test also checks that the engine resolves them.
 */
export interface Home {
  readonly root: string;
  readonly project: string;
  readonly notes: string;
  readonly data: string;
  readonly secret: string;
  /** A repository whose `.git/hooks` is a link to `custom-hooks` beside it. */
  readonly repo: string;
}

export const useHome = (): Home => {
  const home = {} as { -readonly [K in keyof Home]: Home[K] };
  beforeAll(async () => {
    home.root = await fs.mkdtemp(path.join(os.tmpdir(), "hobbots-permissions-"));
    home.project = path.join(home.root, "project");
    home.notes = path.join(home.root, "notes");
    home.data = path.join(home.project, ".hobbots-data");
    home.secret = path.join(home.root, "secret.txt");
    home.repo = path.join(home.root, "repo");
    await fs.mkdir(path.join(home.project, "src"), { recursive: true });
    await fs.mkdir(path.join(home.project, ".git", "hooks"), { recursive: true });
    await fs.mkdir(home.data, { recursive: true });
    await fs.mkdir(home.notes);
    await fs.mkdir(path.join(home.root, "private"));
    await fs.writeFile(path.join(home.project, "src", "index.ts"), "");
    await fs.writeFile(path.join(home.project, ".git", "config"), "");
    await fs.writeFile(path.join(home.data, "hobbots.db"), "");
    await fs.writeFile(home.secret, "");
    await fs.mkdir(path.join(home.repo, ".git"), { recursive: true });
    await fs.mkdir(path.join(home.repo, "custom-hooks"));
    await fs.mkdir(path.join(home.repo, "docs"));
    await fs.writeFile(path.join(home.repo, ".git", "config"), "");
    await fs.symlink(path.join(home.repo, "custom-hooks"), path.join(home.repo, ".git", "hooks"));
    await fs.symlink(home.secret, path.join(home.project, "secret-link"));
    await fs.symlink(path.join(home.root, "private"), path.join(home.project, "private-link"));
    await fs.symlink(path.join(home.root, "missing.txt"), path.join(home.project, "dangling"));
    await fs.symlink(path.join(home.project, "loop-b"), path.join(home.project, "loop-a"));
    await fs.symlink(path.join(home.project, "loop-a"), path.join(home.project, "loop-b"));
  });
  afterAll(async () => {
    await fs.rm(home.root, { recursive: true, force: true });
  });
  return home;
};

export const contextFor = (home: Home, preset: SafetyPreset, extra: Partial<PolicyContext> = {}): PolicyContext => ({
  preset,
  sharedFolders: [home.project],
  hob: EMPTY_HOB_POLICY,
  dataFolder: home.data,
  sandbox: "on",
  modelHosts: ["api.anthropic.com"],
  restrictions: [],
  ...extra,
});

export const decide = (context: PolicyContext, request: PolicyRequest): Promise<PolicyVerdict> =>
  Effect.gen(function* () {
    const engine = yield* PolicyEngine;
    return yield* engine.decide(context, request);
  }).pipe(Effect.provide(PolicyEngine.node), Effect.runPromise);

export const files = (
  operation: "read-files" | "edit-files" | "delete-files",
  cwd: string,
  ...paths: ReadonlyArray<string>
): PolicyRequest => ({ _tag: "Files", operation, cwd, paths });
