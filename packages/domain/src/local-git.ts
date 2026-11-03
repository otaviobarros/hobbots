import { Schema } from "effect";
import { toolInputJsonSchema } from "./task-tools.ts";

/**
 * Local Git work the hub does for a hob outside its turn's sandbox (ADR 014): creating a repository. In the
 * sandbox a repository's `.git/config` and `.git/hooks` are read-only, since the user's own Git would
 * later run what a hob wrote there, so `git init` cannot write the config a new repository needs.
 * The hub creates it instead, with Git's defaults and no hooks, and the hob commits as usual.
 */

/** The tool a hob creates a repository with, which the policy hook points a `git init` command to. */
export const GIT_INIT_TOOL = "git_init";

export const GitInitInput = Schema.Struct({
  folder: Schema.String.annotate({
    description:
      "The absolute path of the folder to make a repository: one of your folders, or a folder inside one. Hobbots creates it when it does not exist yet.",
  }),
});
export type GitInitInput = typeof GitInitInput.Type;

export const GIT_INIT_DESCRIPTION =
  "Create an empty Git repository in one of your folders, or in a folder inside one. Use this instead of `git init`, which cannot write a repository's config or hooks from your sandbox. Hobbots creates the repository with Git's defaults and no hooks; then add, commit and branch with git as usual. Its .git/config and .git/hooks stay read-only for you.";

export const GIT_INIT_LABEL = "Creating a Git repository";

/** The JSON Schema a runtime advertises for the tool's input. */
export const gitInitToolJsonSchema = (): Record<string, unknown> => toolInputJsonSchema(GitInitInput);

/** Why a `git init` command is refused when the turn offers the tool, in words for the hob. */
export const steerGitInit = (tool: string) =>
  `Create the repository with the ${tool} tool instead of git init: in your sandbox a repository's .git/config and .git/hooks are read-only, so git init cannot write them. Hobbots creates it for you with Git's defaults and no hooks, under your policy.`;

/**
 * The hub's `git init` for a hob (#578), as a shell script: it makes the folder, moves into it
 * without following links and checks it is the folder decided, and refuses one that already holds a
 * `.git` of any kind. Git then creates the repository with no template, so it has no hooks, in a
 * folder beside it that is not named `.git`, and the script moves that folder to `.git`. The sandbox
 * it runs in keeps every `.git/config` below the hub's own working folder read-only (sandbox-runtime
 * does, whatever the folders), and a repository is complete before it is named `.git`. Its arguments
 * are the folder and the initial branch, empty for Git's default.
 */
export const GIT_INIT_SCRIPT = [
  'mkdir -p -- "$1" && cd -P -- "$1" || exit 3',
  '[ "$(pwd -P)" = "$1" ] || { echo "$1 moved while Hobbots was creating the repository." >&2; exit 3; }',
  'if [ -e .git ] || [ -L .git ]; then echo "$1 already has a .git." >&2; exit 4; fi',
  'staging=".hobbots-git-$$"',
  'mkdir -- "$staging" || exit 3',
  'if [ -n "$2" ]; then branch="--initial-branch=$2"; else branch="--quiet"; fi',
  'if git init --quiet --template= "$branch" --separate-git-dir="$staging" . && rm -f -- .git && mv -- "$staging" .git; then exit 0; fi',
  'echo "Hobbots could not create the repository in $1." >&2; rm -rf -- "$staging"; exit 5',
].join("\n");
