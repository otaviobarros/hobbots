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
});
