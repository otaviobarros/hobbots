import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loginShellPath, mergePaths, parseShellPath } from "../src/main/shell-path.ts";

const temp = mkdtempSync(join(tmpdir(), "hobbots-shell-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("the login shell's PATH", () => {
  it("reads the PATH between the markers and ignores what startup files print", () => {
    expect(parseShellPath("Welcome!\n__HOBBOTS_PATH__/a:/b__HOBBOTS_PATH__\nbye")).toBe("/a:/b");
    expect(parseShellPath("no markers")).toBeUndefined();
    expect(parseShellPath("__HOBBOTS_PATH____HOBBOTS_PATH__")).toBeUndefined();
  });

  it("puts the shell's folders first, without duplicates or empty entries", () => {
    expect(mergePaths(["/nvm/bin", "/usr/bin"].join(delimiter), ["/usr/bin", "", "/bin"].join(delimiter))).toBe(
      ["/nvm/bin", "/usr/bin", "/bin"].join(delimiter),
    );
    expect(mergePaths(undefined, "/usr/bin")).toBe("/usr/bin");
  });

  it("gives up on a shell that hangs at startup, as an interactive shell ignoring SIGTERM would", async () => {
    const shell = join(temp, "hanging-shell");
    writeFileSync(shell, "#!/bin/sh\ntrap '' TERM\nsleep 30\n", { mode: 0o755 });
    const previous = process.env.SHELL;
    process.env.SHELL = shell;
    try {
      const started = Date.now();
      expect(await loginShellPath(500)).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.env.SHELL = previous;
    }
  });

  it("reads the PATH from a real shell", async () => {
    const previous = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      expect((await loginShellPath())?.split(delimiter)).toContain("/bin");
    } finally {
      process.env.SHELL = previous;
    }
  });
});
