import type { CharmDeclaration } from "@hobbots/domain";

/**
 * The GitHub Charm as it declares itself to the policy (ADR 031): its operations, with the answers
 * every preset gives them, and Push, which it takes over and makes as its GitHub identity (ADR 022).
 * A read is allowed under every preset; opening a pull request, commenting and opening an issue ask,
 * unless the preset is Trusting. A grant names the repository, and for a pull request its base branch too.
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
    {
      id: "github.open-issue",
      words: "opening issues",
      presets: { careful: "ask", balanced: "ask", trusting: "allow" },
      site: ["repository"],
      onceOnly: false,
      actsAsIdentity: true,
    },
  ],
  takesOver: ["push"],
} as const satisfies CharmDeclaration;
