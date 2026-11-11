import { Context, type Effect } from "effect";

/** What a Task changed in one Git repository and left uncommitted (#586). */
export interface UncommittedFiles {
  /** The repository's top folder. */
  readonly repository: string;
  /** The files, by path inside the repository with `/` between names, in that order. */
  readonly paths: ReadonlyArray<string>;
}

export interface GitWorkspaceShape {
  /**
   * Of `files`, each a path inside one of a hob's folders, those in a Git repository that differ
   * from its last commit, staged or not, grouped by repository. Files in no repository, ignored
   * files and repositories that cannot be read count as committed. Reading runs no Git command,
   * hook or filter, since a repository's own config can name code to run.
   */
  readonly uncommitted: (
    files: ReadonlyArray<{ readonly folder: string; readonly path: string }>,
  ) => Effect.Effect<ReadonlyArray<UncommittedFiles>>;
  /**
   * The repository Git finds from `folder`, as the real path of its top folder, or null when there
   * is none: two spellings of one repository give one answer, and a nested repository its own.
   * Read without running Git, like `uncommitted`.
   */
  readonly repository: (folder: string) => Effect.Effect<string | null>;
  /**
   * The real path of `folder`, every link and `..` resolved as the kernel walks it, or null when it
   * is not an absolute path or cannot be read. A folder a hob names is checked against its own
   * folders by this path, never by its spelling.
   */
  readonly realFolder: (folder: string) => Effect.Effect<string | null>;
  /**
   * The names of the files and folders directly in `directory`, a path inside the repository whose
   * top is `repository` with `/` between names, as its default branch has them: `origin`'s HEAD, else
   * `origin/main`, else `main`, as this clone last fetched them. Empty when the directory is not
   * there, and null when the repository has no such branch or cannot be read. Read without running Git.
   */
  readonly namesOnMain: (repository: string, directory: string) => Effect.Effect<ReadonlyArray<string> | null>;
}

/** Reads the Git state of a hob's folders for the hub, without running Git. */
export class GitWorkspace extends Context.Service<GitWorkspace, GitWorkspaceShape>()("@hobbots/agents/GitWorkspace") {}
