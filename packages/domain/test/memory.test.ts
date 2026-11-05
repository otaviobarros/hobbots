import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AgentId } from "../src/ids.ts";
import { MemoryPath, memoryProjectIdentity, memoryScopeAllowed } from "../src/memory.ts";

describe("memory project identity", () => {
  it("is the same for every clone of one remote", () => {
    const clones = [
      "git@github.com:Me/App.git",
      "https://github.com/me/app",
      "https://github.com/me/app.git/",
      "https://token@github.com/me/app.git",
      "ssh://git@github.com:22/me/app.git",
      "  git@github.com:me/app  ",
    ];
    for (const remote of clones) expect(memoryProjectIdentity(remote, "anything")).toBe("github.com/me/app");
  });

  it("tells repositories on other hosts and paths apart", () => {
    expect(memoryProjectIdentity("git@gitlab.com:me/app.git", "app")).toBe("gitlab.com/me/app");
    expect(memoryProjectIdentity("https://git.example.com/group/sub/app.git", "app")).toBe(
      "git.example.com/group/sub/app",
    );
    expect(memoryProjectIdentity("git@github.com:me/app.git", "app")).not.toBe(
      memoryProjectIdentity("git@github.com:me/site.git", "app"),
    );
  });

  it("keeps IPv6 hosts whole, so two hosts never share a project", () => {
    const one = memoryProjectIdentity("ssh://git@[2001:db8::1]/org/app.git", "app");
    expect(one).toBe("[2001:db8::1]/org/app");
    expect(memoryProjectIdentity("ssh://git@[2001:db8::2]/org/app.git", "app")).not.toBe(one);
    // The same repository read through another form of remote.
    expect(memoryProjectIdentity("ssh://git@[2001:DB8::1]:22/org/app", "app")).toBe(one);
    expect(memoryProjectIdentity("git@[2001:db8::1]:org/app.git", "app")).toBe(one);
    expect(memoryProjectIdentity("git@[2001:db8::2]:org/app.git", "app")).not.toBe(one);
  });

  it("reads a remote of any length in one pass", () => {
    const long = `https://github.com/me/app${"/".repeat(100_000)}`;
    expect(memoryProjectIdentity(long, "app")).toBe("github.com/me/app");
    expect(memoryProjectIdentity(`#${"#".repeat(100_000)}`, "app")).toBe("app");
  });

  it("falls back to the folder's name with no remote, or one it cannot read", () => {
    expect(memoryProjectIdentity(null, "Notes")).toBe("notes");
    expect(memoryProjectIdentity("/srv/git/app.git", "app")).toBe("app");
    expect(memoryProjectIdentity("", "app")).toBe("app");
  });
});

describe("memory scopes", () => {
  const pip = AgentId.make("pip");
  const quill = AgentId.make("quill");

  it("lets a hob touch its own memory, its projects and everyone's, never another hob's or project", () => {
    const app = memoryProjectIdentity("git@github.com:me/app.git", "app");
    const site = memoryProjectIdentity("git@github.com:me/site.git", "site");
    const asPip = { _tag: "Hob", agentId: pip, projects: [app] } as const;
    expect(memoryScopeAllowed(asPip, { _tag: "Hob", agentId: pip })).toBe(true);
    expect(memoryScopeAllowed(asPip, { _tag: "Hob", agentId: quill })).toBe(false);
    expect(memoryScopeAllowed(asPip, { _tag: "Project", identity: app })).toBe(true);
    expect(memoryScopeAllowed(asPip, { _tag: "Project", identity: site })).toBe(false);
    expect(memoryScopeAllowed(asPip, { _tag: "Everyone" })).toBe(true);
    expect(memoryScopeAllowed({ _tag: "You" }, { _tag: "Hob", agentId: quill })).toBe(true);
  });

  it("accepts only relative markdown paths", () => {
    const valid = Schema.is(MemoryPath);
    expect(valid("notes/tests.md")).toBe(true);
    expect(valid("sessions/5f0c1e7a-0000-4000-8000-000000000001.md")).toBe(true);
    for (const path of ["/etc/x.md", "../x.md", "notes/../x.md", "notes//x.md", "Notes/x.md", "notes/x.txt", "x"]) {
      expect(valid(path)).toBe(false);
    }
  });
});
