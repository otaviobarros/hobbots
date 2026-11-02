import { describe, expect, it } from "vitest";
import { type Authority, delegatedAuthority, holds, NO_AUTHORITY, narrowBy, sharedFolders } from "../src/authority.ts";

const lead: Authority = {
  decisions: {
    "read-files": "allow",
    "edit-files": "allow",
    "delete-files": "ask",
    "run-commands": "allow",
    "local-git": "allow",
    push: "ask",
    "use-web": "allow",
    "read-github": "allow",
    "open-pull-request": "ask",
    "comment-github": "ask",
    "outside-folders": "deny",
  },
  folders: ["/work/campaign", "/work/site"],
};

describe("authority only narrows", () => {
  it("holds a folder and what is inside it, never a sibling with the same prefix", () => {
    expect(holds("/work/campaign", "/work/campaign", "/")).toBe(true);
    expect(holds("/work/campaign/", "/work/campaign/copy", "/")).toBe(true);
    expect(holds("/work/campaign", "/work/campaign-old", "/")).toBe(false);
    expect(holds("C:\\work", "C:\\work\\copy", "\\")).toBe(true);
    expect(holds("C:\\work\\", "C:\\work\\copy", "\\")).toBe(true);
    expect(holds("C:\\work", "C:\\work-old", "\\")).toBe(false);
  });

  it("divides paths only at the hub's own separator", () => {
    // On macOS and Linux a backslash is part of a name, so this folder sits beside /work/project.
    expect(holds("/work/project", "/work/project\\outside", "/")).toBe(false);
    expect(sharedFolders(["/work/project"], ["/work/project\\outside"], "/")).toEqual([]);
    expect(delegatedAuthority(lead, { folders: ["/work/site\\outside"] }, "/")._tag).toBe("Wider");
    expect(narrowBy(lead, { overrides: {}, folders: ["/work/site\\outside"] }, "/").folders).toEqual([]);
  });

  it("keeps only the folders both sides allow", () => {
    expect(sharedFolders(["/work"], ["/work/copy", "/elsewhere"], "/")).toEqual(["/work/copy"]);
    expect(sharedFolders(["/work/copy"], ["/work"], "/")).toEqual(["/work/copy"]);
    expect(sharedFolders(["/a"], ["/b"], "/")).toEqual([]);
  });

  it("gives a member the lead's authority narrowed by what the brief asks for", () => {
    const narrowed = delegatedAuthority(
      lead,
      {
        decisions: { push: "deny", "edit-files": "ask" },
        folders: ["/work/site/blog"],
      },
      "/",
    );
    expect(narrowed).toEqual({
      _tag: "Narrowed",
      authority: {
        overrides: { ...lead.decisions, push: "deny", "edit-files": "ask" },
        folders: ["/work/site/blog"],
      },
    });
    expect(delegatedAuthority(lead, undefined, "/")).toEqual({
      _tag: "Narrowed",
      authority: { overrides: lead.decisions, folders: lead.folders },
    });
  });

  it("refuses a brief that asks for more than the lead has", () => {
    const wider = delegatedAuthority(lead, { decisions: { push: "allow", "outside-folders": "ask" } }, "/");
    expect(wider._tag).toBe("Wider");
    expect(wider._tag === "Wider" && wider.message).toContain("push (yours is ask)");
    expect(wider._tag === "Wider" && wider.message).toContain("outside-folders (yours is deny)");
    expect(delegatedAuthority(lead, { folders: ["/home"] }, "/")._tag).toBe("Wider");
    expect(delegatedAuthority(NO_AUTHORITY, { decisions: { "read-files": "allow" } }, "/")._tag).toBe("Wider");
  });

  it("narrows by every delegation on the way down", () => {
    const member = narrowBy(lead, { overrides: { "run-commands": "deny" }, folders: ["/work/site"] }, "/");
    expect(member.decisions["run-commands"]).toBe("deny");
    expect(member.decisions["read-files"]).toBe("allow");
    expect(member.folders).toEqual(["/work/site"]);
    expect(narrowBy(member, { overrides: { "run-commands": "allow" }, folders: null }, "/")).toEqual(member);
  });
});
