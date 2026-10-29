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

  // covers RT-001: an honest Claude Code state when the app is opened from Finder
  it("[TC-GEN-001] gives up on a shell that hangs at startup, as an interactive shell ignoring SIGTERM would", async () => {
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

  // covers RT-001
  it("[TC-GEN-002] keeps the PATH when a background job started by the shell holds its output open", async () => {
    const shell = join(temp, "backgrounding-shell");
    writeFileSync(shell, "#!/bin/sh\nsleep 30 &\nprintf '__HOBBOTS_PATH__/found__HOBBOTS_PATH__'\n", { mode: 0o755 });
    const previous = process.env.SHELL;
    process.env.SHELL = shell;
    try {
      const started = Date.now();
      expect(await loginShellPath(3_000)).toBe("/found");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      process.env.SHELL = previous;
    }
  });

  // covers RT-001
  it("[TC-GEN-003] reads the PATH from a real shell", async () => {
    const previous = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      expect((await loginShellPath())?.split(delimiter)).toContain("/bin");
    } finally {
      process.env.SHELL = previous;
    }
  });
});
