import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type CharmOperation,
  DelegationAuthority,
  GrantRule,
  HobPolicy,
  heldCharms,
  hobAnswers,
  presetDecision,
  StoredOperation,
  ToolCall,
} from "../src/index.ts";

// Names and shapes stored or journaled before ADR 031 read as the Charm operations they became.

describe("Charm operations", () => {
  // covers DP-051
  it("[TC-DP-287] reads the GitHub operations, rules and overrides stored before ADR 031 under their new names", () => {
    const operation = Schema.decodeUnknownSync(StoredOperation);
    expect(operation("read-github")).toBe("github.read");
    expect(operation("open-pull-request")).toBe("github.open-pull-request");
    expect(operation("comment-github")).toBe("github.comment");
    expect(operation("push")).toBe("push");
    expect(() => operation("no-such-operation")).toThrow();

    const rule = Schema.decodeUnknownSync(GrantRule);
    expect(rule({ _tag: "GitHubComment", cwd: "/w", repository: "o/r" })).toEqual({
      _tag: "CharmSite",
      charm: "github",
      operation: "github.comment",
      cwd: "/w",
      site: { repository: "o/r" },
    });
    const current = { _tag: "CharmSite", charm: "github", operation: "github.comment", site: { repository: "o/r" } };
    expect(Schema.encodeSync(GrantRule)(rule(current))).toEqual(current);

    // A reply step's tool call, a delegation's authority and a hob's policy, each as journaled before.
    expect(Schema.decodeUnknownSync(ToolCall)({ tool: "github_read", operation: "read-github", targets: [] })).toEqual({
      tool: "github_read",
      operation: "github.read",
      targets: [],
    });
    expect(
      Schema.decodeUnknownSync(DelegationAuthority)({
        overrides: { "comment-github": "deny", "edit-files": "ask" },
        folders: null,
      }),
    ).toEqual({ overrides: { "github.comment": "deny", "edit-files": "ask" }, folders: null });
    const policy = Schema.decodeUnknownSync(HobPolicy)({
      ownFolders: [],
      hiddenSharedFolders: [],
      overrides: { push: "ask", "comment-github": "deny" },
    });
    expect(policy).toEqual({
      ownFolders: [],
      hiddenSharedFolders: [],
      overrides: { push: "ask" },
      charms: { overrides: { "github.comment": "deny" } },
    });
    // Encoded and read again, a policy keeps its overrides where they were.
    expect(Schema.decodeUnknownSync(HobPolicy)(Schema.encodeSync(HobPolicy)(policy))).toEqual(policy);
    expect(hobAnswers(policy)).toEqual({ push: "ask", "github.comment": "deny" });
  });

  // covers DP-051, ADR 031
  it("[TC-PE-510] reads the GitHub Charm flag stored or journaled before the Charm-id grant as the set it meant", () => {
    const decode = Schema.decodeUnknownSync(HobPolicy);
    const base = { ownFolders: [], hiddenSharedFolders: [], overrides: {} };
    const off = decode({ ...base, githubCharm: false, overrides: { "comment-github": "deny" } });
    expect(off).toEqual({ ...base, charms: { granted: [], overrides: { "github.comment": "deny" } } });
    expect(heldCharms(off)).toEqual([]);
    // On, or never set, the hob holds the GitHub Charm every hob started with.
    for (const on of [decode({ ...base, githubCharm: true }), decode(base)]) {
      expect(on).toEqual(base);
      expect(heldCharms(on)).toEqual(["github"]);
    }
    // A set given beside the old flag wins, and the flag is never written again.
    const both = decode({ ...base, githubCharm: false, charms: { granted: ["github"] } });
    expect(heldCharms(both)).toEqual(["github"]);
    expect(Schema.encodeSync(HobPolicy)(off)).toEqual({
      ...base,
      charms: { granted: [], overrides: { "github.comment": "deny" } },
    });
  });

  it("answers a Charm operation by its declaration, and one nothing declares with Never", () => {
    const declared: ReadonlyArray<CharmOperation> = [
      {
        id: "mail.send",
        words: "sending mail",
        presets: { careful: "ask", balanced: "ask", trusting: "allow" },
        site: ["to"],
        onceOnly: false,
        actsAsIdentity: true,
      },
    ];
    expect(presetDecision("trusting", "mail.send", declared)).toBe("allow");
    expect(presetDecision("trusting", "mail.search", declared)).toBe("deny");
    expect(presetDecision("careful", "edit-files", declared)).toBe("ask");
  });
});
