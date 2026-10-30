import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { isInside, PathResolver } from "../src/index.ts";
import { contextFor, decide, files, type Home, useHome } from "./fixture.ts";

const home: Home = useHome();

const canonicalize = (input: string, base = "/") =>
  Effect.gen(function* () {
    const resolver = yield* PathResolver;
    return yield* resolver.canonicalize(input, base);
  }).pipe(Effect.provide(PathResolver.node), Effect.runPromise);

describe("canonical paths", () => {
  it("resolves symlinks, `.` and `..` like the kernel does", async () => {
    const root = await fs.realpath(home.root);
    expect((await canonicalize(home.project)).path).toBe(path.join(root, "project"));
    expect((await canonicalize("./src/./index.ts", home.project)).path).toBe(
      path.join(root, "project", "src", "index.ts"),
    );
    expect((await canonicalize("secret-link", home.project)).path).toBe(path.join(root, "secret.txt"));
    expect((await canonicalize("private-link/../secret.txt", home.project)).path).toBe(path.join(root, "secret.txt"));
    expect((await canonicalize("dangling", home.project)).path).toBe(path.join(root, "missing.txt"));
  });

  it("resolves a path that does not exist yet through its nearest existing parent", async () => {
    const root = await fs.realpath(home.root);
    expect((await canonicalize("src/new/deep/file.ts", home.project)).path).toBe(
      path.join(root, "project", "src", "new", "deep", "file.ts"),
    );
    expect((await canonicalize("new/../private-link/x", home.project)).path).toBe(path.join(root, "private", "x"));
  });

  it("fails on a symlink loop instead of guessing", async () => {
    await expect(canonicalize("loop-a", home.project)).rejects.toMatchObject({ _tag: "PathResolutionError" });
  });

  it("compares by whole path segments", () => {
    const target = { path: "/work/projects-old/a", caseSensitive: true };
    expect(isInside(target, "/work/projects")).toBe(false);
    expect(isInside(target, "/work/projects-old")).toBe(true);
    expect(isInside(target, "/")).toBe(true);
    expect(isInside({ path: "/Work/A", caseSensitive: false }, "/work")).toBe(true);
    expect(isInside({ path: "/Work/A", caseSensitive: true }, "/work")).toBe(false);
  });

  it("follows the volume's case sensitivity", async () => {
    const upper = path.join(home.root, "PROJECT", "src", "index.ts");
    const volumeIsInsensitive = await fs.stat(upper).then(
      () => true,
      () => false,
    );
    expect((await canonicalize(upper)).caseSensitive).toBe(!volumeIsInsensitive);
    // On a case-insensitive volume, such as macOS's default, ~/PROJECT is the shared ~/project.
    const verdict = await decide(contextFor(home, "balanced"), files("edit-files", "/", upper));
    expect(verdict.decision).toBe(volumeIsInsensitive ? "allow" : "deny");
    if (volumeIsInsensitive) {
      const hook = await decide(contextFor(home, "trusting"), files("edit-files", home.project, ".GIT/Hooks/pre-push"));
      expect(hook.reason.code).toBe("protected-path");
    }
  });
});
