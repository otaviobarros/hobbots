import type { ToolAccess } from "@hobbots/agents";
import type { CharmDeclaration } from "@hobbots/domain";

/**
 * The GitHub Charm as it declares itself to the policy (ADR 031): its operations, with the answers
 * every preset gives them, and Push, which it takes over and makes as its GitHub identity (ADR 022).
 * A read is allowed under every preset; opening a pull request and commenting ask, unless the preset
 * is Trusting. A grant names the repository, and for a pull request its base branch too.
 */
export const GITHUB_CHARM = {
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
    {
      id: "github.open-pull-request",
      words: "opening pull requests",
      presets: { careful: "ask", balanced: "ask", trusting: "allow" },
      site: ["repository", "base"],
      onceOnly: false,
      actsAsIdentity: true,
    },
    {
      id: "github.comment",
      words: "commenting on GitHub",
      presets: { careful: "ask", balanced: "ask", trusting: "allow" },
      site: ["repository"],
      onceOnly: false,
      actsAsIdentity: true,
    },
  ],
  takesOver: ["push"],
} as const satisfies CharmDeclaration;

/**
 * `access` with the GitHub Charm's operations declared, as the hub's Charms declare them. The Charm
 * decides only its own operations, so it never relies on a caller having passed its declaration.
 */
export const withGitHubOperations = (access: ToolAccess): ToolAccess => ({
  ...access,
  policy: {
    ...access.policy,
    charmOperations: [
      ...(access.policy.charmOperations ?? []).filter((operation) => !operation.id.startsWith(`${GITHUB_CHARM.id}.`)),
      ...GITHUB_CHARM.operations,
    ],
  },
});
