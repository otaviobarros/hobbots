import type { ReplyStep } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { actionPhrase, blockedLine, changeLine, commandSense, stepDoing } from "./plain-words.ts";

describe("commandSense", () => {
  it("leaves out commands that only look around or arrange files", () => {
    expect(commandSense("ls -la")).toEqual({ kind: "routine" });
    expect(commandSense("cd site && cat copy.md | head -5")).toEqual({ kind: "routine" });
    expect(commandSense("rm -- scratch.txt && ls -la")).toEqual({ kind: "routine" });
    // A here-document's lines are a file's text, not commands.
    expect(commandSense("cat > copy.md <<'EOF'\n# Lemon Stand\nnpm run build\nEOF")).toEqual({ kind: "routine" });
  });

  it("names the script a command runs, by its own name", () => {
    expect(commandSense('bash check.sh; echo "exit=$?"')).toEqual({ kind: "script", name: "check.sh" });
    expect(commandSense("chmod +x …/lemon-stand-2/check.sh && …/lemon-stand-2/check.sh;")).toEqual({
      kind: "script",
      name: "check.sh",
    });
    expect(commandSense("python3 tools/resize.py --all")).toEqual({ kind: "script", name: "resize.py" });
    expect(commandSense('python3 -c "print(1)"')).toEqual({ kind: "other" });
  });

  it("says what a package script and git do", () => {
    expect(commandSense("pnpm test")).toEqual({ kind: "tests" });
    expect(commandSense("npm run build")).toEqual({ kind: "build" });
    expect(commandSense("pnpm install --frozen-lockfile")).toEqual({ kind: "install" });
    expect(commandSense("pnpm copy:check")).toEqual({ kind: "packageScript", name: "copy:check" });
    expect(commandSense("git status && git commit -m 'feat: page'")).toEqual({ kind: "commit" });
    expect(commandSense("git diff")).toEqual({ kind: "routine" });
    expect(commandSense("xmllint --noout logo.svg")).toEqual({ kind: "other" });
  });
});

describe("actionPhrase", () => {
  it("names the files a call acts on, and what a command runs", () => {
    expect(actionPhrase("delete-files", ["/work/site/scratch.txt"])).toBe("delete scratch.txt");
    expect(actionPhrase("edit-files", ["/w/a.md", "/w/b.md", "/w/c.md"])).toContain("1 more file");
    expect(actionPhrase("run-commands", ["/work/site"], "bash check.sh")).toBe("run check.sh");
    expect(actionPhrase("run-commands", ["/work/site"], "ls")).toBe("run a command");
    expect(actionPhrase("push", ["origin"])).toBe("push your work");
  });

  it("says a file change by its file's own name", () => {
    expect(changeLine("added", "docs/copy.md")).toBe("Created copy.md");
    expect(changeLine("edited", "copy.md")).toBe("Updated copy.md");
    expect(changeLine("deleted", "/a/scratch.txt")).toBe("Deleted scratch.txt");
    expect(changeLine("edited", "docs/plan.md///")).toBe("Updated plan.md");
    // A long run of slashes costs one pass, not one per slash (STD-SEC-005).
    expect(changeLine("edited", `${"/".repeat(100_000)}x`)).toBe("Updated x");
  });
});

describe("steps", () => {
  const step = (fields: Partial<ReplyStep>): ReplyStep => ({
    id: "s1",
    kind: "tool",
    label: "Running rm -- scratch.txt",
    state: "denied",
    ...fields,
  });

  it("says what a stopped step wanted, and who stopped it", () => {
    const remove = { tool: "Bash", operation: "delete-files", targets: ["/w/scratch.txt"] } as const;
    expect(blockedLine(step({ call: remove, decidedBy: "user" }))).toBe("You said no to: delete scratch.txt");
    expect(blockedLine(step({ call: remove }))).toBe("Not allowed to delete scratch.txt");
    const outside = { tool: "Bash", operation: "outside-folders", targets: ["/w"] } as const;
    expect(blockedLine(step({ call: outside, decidedBy: "policy" }))).toBe(
      "Stopped a step that could reach outside its folders",
    );
  });

  it("says what a running step does", () => {
    const run = { tool: "Bash", operation: "run-commands", targets: ["/w"] } as const;
    expect(stepDoing(step({ state: "running", label: "Running ls -la && cat copy.md", call: run }))).toBe(
      "Looking through the files",
    );
    expect(stepDoing(step({ state: "running", label: "Running pnpm build", call: run }))).toBe("Building the project");
    expect(stepDoing(step({ state: "running", label: "Waiting on Tasks" }))).toBe("Waiting on Tasks");
  });
});
