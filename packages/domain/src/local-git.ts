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
  "Create an empty Git repository in one of your folders, or in a folder inside one. Use this instead of `git init`, which cannot write a repository's config or hooks from your sandbox. Hobbots creates the repository with Git's defaults and no hooks; then add, commit and branch with git as usual. Its .git/config and .git/hooks stay read-only for you. A .git that holds only a config and hooks, which is what your sandbox leaves when you delete a repository, is replaced.";

export const GIT_INIT_LABEL = "Creating a Git repository";

/** The JSON Schema a runtime advertises for the tool's input. */
export const gitInitToolJsonSchema = (): Record<string, unknown> => toolInputJsonSchema(GitInitInput);

/** Why a `git init` command is refused when the turn offers the tool, in words for the hob. */
export const steerGitInit = (tool: string) =>
  `Create the repository with the ${tool} tool instead of git init: in your sandbox a repository's .git/config and .git/hooks are read-only, so git init cannot write them. Hobbots creates it for you with Git's defaults and no hooks, under your policy.`;

/**
 * What a hob is told when a delete meets a repository's `.git/config` or `.git/hooks`, which neither
 * the policy nor the sandbox lets it remove (#663): what is left is not a repository, and `tool`
 * replaces it.
 */
export const leftoverGitNote = (tool: string) =>
  `Hobs can never delete or change a repository's .git/config and .git/hooks, and a .git that holds only those is not a repository: the ${tool} tool replaces it with a new one. To start a folder's repository over, delete the rest of its .git (HEAD, objects, refs and the like), then call ${tool}. To leave the folder with no .git at all, ask the user to delete it.`;
