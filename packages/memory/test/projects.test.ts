import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryProjects } from "@hobbots/agents";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryProjectsLive } from "../src/index.ts";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, stdio: "pipe" });

const identityOf = (folder: string) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(MemoryProjects), (projects) => projects.of(folder)).pipe(
      Effect.provide(MemoryProjectsLive),
    ),
  );

describe("MemoryProjectsLive", () => {
  // covers ADR 028
  it("[TC-GEN-194] gives a clone and its linked worktree the identity of their origin, and a plain folder its name", async () => {
    root = mkdtempSync(join(tmpdir(), "hobbots-projects-"));
    const clone = join(root, "App");
    mkdirSync(clone);
    git(clone, "init", "-q");
    git(clone, "remote", "add", "origin", "git@github.com:Me/App.git");
    git(clone, "commit", "-q", "--allow-empty", "-m", "start");
    const worktree = join(root, "app-feature");
    git(clone, "worktree", "add", "-q", "-b", "feature", worktree);
    const plain = join(root, "Notes");
    mkdirSync(plain);

    expect(await identityOf(clone)).toBe("github.com/me/app");
    expect(await identityOf(worktree)).toBe("github.com/me/app");
    expect(await identityOf(plain)).toBe("notes");
  });

  // covers ADR 028 (The ai-memory adapter): a project is its origin remote, shared across clones.
  it("[TC-GEN-253] puts two clones of one repository in one memory project, and a folder with no remote in its own", async () => {
    root = mkdtempSync(join(tmpdir(), "hobbots-projects-"));
    const first = join(root, "memory-app");
    const second = join(root, "memory-app-copy");
    for (const folder of [first, second]) mkdirSync(folder);
    git(first, "init", "-q");
    git(first, "remote", "add", "origin", "git@github.com:me/app.git");
    git(second, "init", "-q");
    git(second, "remote", "add", "origin", "https://github.com/Me/App.git");
    expect(await identityOf(first)).toBe("github.com/me/app");
    expect(await identityOf(second)).toBe("github.com/me/app");
    // Any host works, and a folder inside a repository is its folder's name.
    git(second, "remote", "set-url", "origin", "https://gitlab.com/me/app.git");
    expect(await identityOf(second)).toBe("gitlab.com/me/app");
    mkdirSync(join(first, "docs"));
    expect(await identityOf(join(first, "docs"))).toBe("docs");
  });
});
