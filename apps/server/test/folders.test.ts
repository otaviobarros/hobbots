import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { checkFolder, checkNewFolder } from "../src/folders.ts";

// Canonical, since the hub stores folders with symlinks resolved (on macOS the temp folder is one).
const home = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-home-")));
mkdirSync(join(home, "code"));
symlinkSync(join(home, "code"), join(home, "link"));
mkdirSync(join(home, "closed"));
afterAll(() => {
  chmodSync(join(home, "closed"), 0o755);
  rmSync(home, { recursive: true, force: true });
});

const check = (typed: string) => Effect.runPromiseExit(checkFolder(typed, home));

describe("checking a folder on the hub", () => {
  it("expands ~ to the hub user's home and resolves the path", async () => {
    expect(await check("~/code")).toEqual(Exit.succeed(join(home, "code")));
    expect(await check("  ~  ")).toEqual(Exit.succeed(home));
    expect(await check(`${home}/code/../code/`)).toEqual(Exit.succeed(join(home, "code")));
  });

  it("refuses a relative path, a ~user path and a missing folder", async () => {
    for (const typed of ["code", "~someone/code", join(home, "nope")]) {
      expect(Exit.isFailure(await check(typed))).toBe(true);
    }
  });

  it("stores a folder reached through a symlink as the folder it points at", async () => {
    expect(await check("~/link")).toEqual(Exit.succeed(join(home, "code")));
    expect(await check(`${home}/link/../link`)).toEqual(Exit.succeed(join(home, "code")));
  });
});

describe("adding a folder on the hub", () => {
  // covers #1225: on macOS, opening a protected folder asks the user then, not mid-turn.
  it("[TC-RT-1225-01] opens the folder once and accepts it", async () => {
    expect(await Effect.runPromiseExit(checkNewFolder("~/code", home))).toEqual(Exit.succeed(join(home, "code")));
  });

  // root opens any folder, so the refusal shows only for an ordinary user.
  it.skipIf(process.getuid?.() === 0)(
    "[TC-RT-1225-02] refuses a folder it can't open, saying where to allow it",
    async () => {
      chmodSync(join(home, "closed"), 0o000);
      const exit = await Effect.runPromiseExit(checkNewFolder("~/closed", home));
      chmodSync(join(home, "closed"), 0o755);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Privacy & Security");
    },
  );
});
