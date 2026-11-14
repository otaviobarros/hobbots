import { describe, expect, it } from "vitest";
import {
  type Authority,
  delegatedAuthority,
  holds,
  NO_AUTHORITY,
  narrowBy,
  reassignedAuthority,
  sharedFolders,
} from "../src/authority.ts";

const lead: Authority = {
  decisions: {
    "read-files": "allow",
    "edit-files": "allow",
    "delete-files": "ask",
    "run-commands": "allow",
    "local-git": "allow",
    push: "ask",
    "use-web": "allow",
    "github.read": "allow",
    "github.open-pull-request": "ask",
    "github.comment": "ask",
    "outside-folders": "deny",
    "search-memory": "allow",
    "save-memory": "allow",
    "search-skills": "allow",
    "request-skill": "ask",
    "propose-skill": "allow",
    "skill-feedback": "allow",
    "read-hobs": "allow",
    "search-web": "allow",
  },
  // Its own override asks before a push; the other Asks are the preset's.
  fixed: ["push"],
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
        overrides: { push: "deny", "edit-files": "ask" },
        folders: ["/work/site/blog"],
      },
    });
  });

  it("passes on the lead's answers given on purpose, and leaves the preset's to the member", () => {
    // The lead's own push Ask stays a restriction no grant answers; its preset Asks are not copied.
    expect(delegatedAuthority(lead, undefined, "/")).toEqual({
      _tag: "Narrowed",
      authority: { overrides: { push: "ask" }, folders: lead.folders },
    });
    const below = narrowBy(lead, { overrides: { "edit-files": "ask", "use-web": "allow" }, folders: null }, "/");
    expect(below.fixed).toEqual(["edit-files", "push"]);
    expect(delegatedAuthority(below, undefined, "/")).toEqual({
      _tag: "Narrowed",
      authority: { overrides: { "edit-files": "ask", push: "ask" }, folders: lead.folders },
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

describe("the authority of a hob taking a Task over", () => {
  // covers OR-006, STD-SEC-003
  it("[TC-OR-1446-15] keeps a restriction the lead gained after the delegation, and never holds more than the lead or the new hob", () => {
    // The delegation answered only push; since then the lead was refused edit-files on purpose.
    const leadNow: Authority = {
      ...lead,
      decisions: { ...lead.decisions, "edit-files": "deny" },
      fixed: [...lead.fixed, "edit-files"],
    };
    const given = { overrides: { push: "deny" as const }, folders: ["/work/site"] };
    // The new hob's own policy allows editing and asks before running commands.
    const own: Authority = {
      ...lead,
      decisions: { ...lead.decisions, "run-commands": "ask" },
      fixed: ["run-commands"],
      folders: ["/work"],
    };
    const result = reassignedAuthority(leadNow, given, own, "/");
    expect(result).toEqual({
      _tag: "Reassigned",
      authority: { overrides: { "edit-files": "deny", push: "deny" }, folders: ["/work/site"] },
    });
    // A hob that may use none of the Task's folders could not do it.
    expect(reassignedAuthority(leadNow, given, { ...own, folders: ["/elsewhere"] }, "/")).toEqual({
      _tag: "Unusable",
      folders: ["/work/site"],
    });
  });
});
