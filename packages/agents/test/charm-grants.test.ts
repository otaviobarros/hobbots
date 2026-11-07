import {
  AgentId,
  type CharmDeclaration,
  EMPTY_HOB_POLICY,
  Grant,
  GrantId,
  type GrantRule,
  type HobPolicy,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { hobCharms, lostAuthority, narrows, policyLoss, type ToolAccess } from "../src/index.ts";

// A hob's Charms are a set of Charm ids (ADR 031): taking one away stops its running turn and
// revokes the grants that relied on it, and skills match their Charm hints against the set.

const GITHUB: CharmDeclaration = {
  id: "github",
  operations: [
    {
      id: "github.read",
      words: "reading GitHub",
      presets: { careful: "allow", balanced: "allow", trusting: "allow" },
      site: ["repository"],
      onceOnly: false,
      actsAsIdentity: false,
    },
  ],
  takesOver: ["push"],
};

const policy = (charms: HobPolicy["charms"]): HobPolicy => ({
  ...EMPTY_HOB_POLICY,
  ...(charms === undefined ? {} : { charms }),
});

const access = (hob: HobPolicy): ToolAccess => ({
  policy: {
    preset: "balanced",
    sharedFolders: ["/work"],
    hob,
    dataFolder: "/data",
    restrictions: [],
    charmOperations: GITHUB.operations,
  },
  folders: ["/work"],
  runtimeFolder: "/runtimes/hob",
  commitsAs: { _tag: "UserConfig", config: { name: "Ada", email: "ada@example.com" } },
});

const grant = (rule: GrantRule) =>
  new Grant({
    id: GrantId.make("g1"),
    agentId: AgentId.make("hob"),
    operation: rule._tag === "CharmSite" ? rule.operation : rule._tag === "Push" ? "push" : "run-commands",
    rule,
    lifetime: "always",
    taskId: null,
    approvalId: null,
    grantedBy: "user",
    createdAt: "2026-11-07T00:00:00.000Z",
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
  });

describe("a hob's Charms", () => {
  // covers PE-008, ADR 031
  it("[TC-PE-504] stops a running turn when the hob loses a Charm, and keeps it when it gains one", () => {
    const both = access(policy({ granted: ["github", "pip"] }));
    expect(narrows(both, access(policy({ granted: ["pip"] })))).toBe(true);
    expect(narrows(access(policy(undefined)), access(policy({ granted: [] })))).toBe(true);
    // Gaining a Charm, or the same set in another order, changes nothing a running turn holds.
    expect(narrows(access(policy({ granted: ["pip"] })), both)).toBe(false);
    expect(narrows(both, access(policy({ granted: ["pip", "github"] })))).toBe(false);
    // Holding no set is holding the GitHub Charm every hob starts with.
    expect(narrows(access(policy(undefined)), access(policy({ granted: ["github"] })))).toBe(false);
  });

  // covers PE-008, ADR 031
  it("[TC-PE-505] stops a running turn when a Charm operation's answer gets narrower, not when it widens", () => {
    const allowed = access(policy({ granted: ["github"] }));
    const asks = access(policy({ granted: ["github"], overrides: { "github.read": "ask" } }));
    expect(narrows(allowed, asks)).toBe(true);
    expect(narrows(asks, access(policy({ granted: ["github"], overrides: { "github.read": "deny" } })))).toBe(true);
    expect(narrows(asks, allowed)).toBe(false);
  });

  // covers PE-007, ADR 031
  it("[TC-PE-506] revokes the grants that relied on a Charm taken away, its sites and what it takes over", () => {
    const site = grant({ _tag: "CharmSite", charm: "github", operation: "github.read", site: { repository: "o/r" } });
    const push = grant({ _tag: "Push", cwd: "/work", remote: "origin", branch: "main" });
    const command = grant({ _tag: "Command", operation: "run-commands", cwd: "/work", words: ["ls"] });
    const off = policyLoss(policy({ granted: ["github", "pip"] }), policy({ granted: ["pip"] }), [GITHUB]);
    expect(off.charms).toEqual([GITHUB]);
    expect([site, push, command].map((each) => lostAuthority(each, off))).toEqual(["narrowed", "narrowed", null]);
    // Kept, or never declared by a Charm the hub holds, only its own sites go.
    const kept = policyLoss(policy(undefined), policy({ granted: ["github"] }), [GITHUB]);
    expect(lostAuthority(site, kept)).toBeNull();
    const undeclared = policyLoss(policy(undefined), policy({ granted: [] }));
    expect([site, push].map((each) => lostAuthority(each, undeclared))).toEqual(["narrowed", null]);
  });

  // covers AG-150, ADR 031
  it("[TC-AG-165] matches a skill's Charm hint against the hob's set of Charm ids", () => {
    expect(hobCharms(policy(undefined))).toEqual(["github"]);
    expect(hobCharms(policy({ granted: ["github", "pip", "github"] }))).toEqual(["github", "pip"]);
    expect(hobCharms(policy({ granted: [] }))).toEqual([]);
  });
});
