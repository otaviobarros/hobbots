import { GITHUB_TOOLS, GITHUB_WRITE_TOOLS, type GitHubToolName, type GitHubWriteToolName } from "./github.ts";

/**
 * GitHub's own command line, `gh`, in a hob's commands (#1349). No credential enters a hob's sandbox
 * (ADR 014, ADR 020), so `gh` can never sign in there: the hub refuses it before it runs and points
 * the hob to the GitHub Charm's tool for what it tried, as it points a `git push` to `github_push`.
 */

/** The GitHub Charm's tools, reads and writes, by name. */
export const GITHUB_CHARM_TOOLS: ReadonlyArray<string> = [...GITHUB_TOOLS, ...GITHUB_WRITE_TOOLS].map(
  (tool) => tool.name,
);

/** What a hob holding the GitHub Charm is told with how its commands run. */
export const GITHUB_CHARM_NOTE =
  "GitHub goes through your GitHub Charm tools, never `gh`: no credential enters your sandbox, so gh cannot sign in there, and a gh command is refused.";

/** Where each `gh` command a hob may try goes instead, by its command and subcommand, aliases included. */
const ROUTES: ReadonlyArray<{
  readonly commands: ReadonlyArray<string>;
  readonly tool: GitHubToolName | GitHubWriteToolName;
}> = [
  { commands: ["pr create", "pr new"], tool: "github_open_pull_request" },
  { commands: ["pr comment", "issue comment"], tool: "github_comment" },
  { commands: ["issue create", "issue new"], tool: "github_open_issue" },
  { commands: ["pr view", "issue view"], tool: "github_item" },
  {
    commands: [
      "pr list",
      "pr ls",
      "pr status",
      "issue list",
      "issue ls",
      "issue status",
      "search issues",
      "search prs",
    ],
    tool: "github_search",
  },
  { commands: ["repo view"], tool: "github_repository" },
];

// gh's options that take a value and may come before the command, such as `gh -R owner/name pr view`.
const VALUE_OPTIONS = new Set(["-R", "--repo", "--hostname"]);

/** The command and subcommand a `gh` call names, as `pr create`, from its arguments; "" for none. */
export const ghCommandOf = (args: ReadonlyArray<string>): string => {
  const words: Array<string> = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    const arg = args[i] as string;
    if (arg === "--") break;
    if (VALUE_OPTIONS.has(arg)) i++;
    else if (!arg.startsWith("-")) words.push(arg);
  }
  return words.join(" ");
};

const SIGN_IN = "gh cannot sign in from your sandbox, since no credential enters it.";
const ASK_USER = "Tell the user what you need from GitHub instead.";

/**
 * Why a `gh` command with `args` is refused, pointing the hob to the GitHub Charm tool for what it
 * tried when the turn offers it, among `offered`, the GitHub Charm tools it offers.
 */
export const steerGh = (args: ReadonlyArray<string>, offered: ReadonlyArray<string>): string => {
  const command = ghCommandOf(args);
  const tried = command === "" ? "gh" : `gh ${command}`;
  const route = ROUTES.find((each) => each.commands.includes(command));
  if (route !== undefined && offered.includes(route.tool)) {
    return `Use the ${route.tool} tool instead of ${tried}: Hobbots reaches GitHub for you through the GitHub Charm, under your policy. ${SIGN_IN}`;
  }
  if (offered.length === 0) {
    return `${SIGN_IN} GitHub goes through the GitHub Charm, whose tools you are not offered now. ${ASK_USER}`;
  }
  if (route !== undefined) {
    return `${SIGN_IN} The ${route.tool} tool does what ${tried} would, and you are not offered it now. ${ASK_USER}`;
  }
  return `Reach GitHub with your GitHub Charm tools instead of ${tried}: ${offered.join(", ")}. ${SIGN_IN}`;
};
