import { realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import {
  type AskableVerdict,
  approvalNote,
  askUntilDecided,
  type CharmTurn,
  type HubCallStep,
  type HubToolAnswer,
  LocalGitTools,
  RepositorySandbox,
  type ToolAccess,
} from "@hobbots/agents";
import {
  GIT_INIT_DESCRIPTION,
  GIT_INIT_LABEL,
  GIT_INIT_TOOL,
  GitInitInput,
  gitInitToolJsonSchema,
  narrowest,
} from "@hobbots/domain";

import { PolicyEngine, type PolicyRequest } from "@hobbots/permissions";
import { Data, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { decideCharmWrite } from "./github-writes.ts";
import { runTool, toolEnv } from "./run-tool.ts";

/**
 * Local Git work the hub does for a hob (ADR 014, #578): `git_init` creates a repository. A turn's
 * sandbox keeps every repository's `.git/config` and `.git/hooks` read-only, so the user's own Git
 * never runs what a hob wrote there, and that also stops `git init`, which must write a config. The
 * hub decides the call as Local Git and Edit files on the folder under the hob's policy, then runs
 * `git init` with no template in its own sandbox, writable only below the hob's folder, so the
 * repository starts with Git's own config and no hooks, and the hob commits in it as usual.
 */

class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}

/** What the hob is told once the repository is there. */
export const initializedText = (folder: string) =>
  `Created an empty Git repository in ${folder}. Add, commit and branch in it with git as usual; its .git/config and .git/hooks stay read-only for you, so ask the user to add a remote or install a hook.`;

/** What a hob on Linux is told when the repository is at the top of a folder its running turn cannot see yet. */
export const NEXT_TURN =
  "On this hub your commands see a new repository at the top of a folder from your next turn: finish this turn and continue in the next.";

/** Whether `path` names something inside a Git directory, where a new repository has no place. */
const insideGitDirectory = (path: string) => path.split(sep).includes(".git");

const exists = (path: string) =>
  Effect.promise(() =>
    lstat(path).then(
      () => true,
      () => false,
    ),
  );

/** A branch name plain enough to pass to `git init --initial-branch`. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** A folder as the file system resolves it, so a link and its target are the same folder. */
const canonical = (folder: string) => {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
};

/**
 * The narrower of two verdicts on the same call, its targets the first's. Two asks ask once, and
 * Always saves the rules of both, so the next call is answered by both.
 */
export const narrowerOf = (first: AskableVerdict, second: AskableVerdict): AskableVerdict => {
  if (first.decision === "ask" && second.decision === "ask") {
    const onceOnly = first.onceOnly || second.onceOnly;
    return {
      ...first,
      onceOnly,
      grantable: !onceOnly && first.grantable && second.grantable,
      rules: [...first.rules, ...second.rules],
    };
  }
  const narrower = narrowest(first.decision, second.decision) === first.decision ? first : second;
  return {
    ...narrower,
    targets: first.targets,
    grantIds: narrower.decision === "allow" ? [...new Set([...first.grantIds, ...second.grantIds])] : narrower.grantIds,
  };
};

export const LocalGitToolsLive = Layer.effect(
  LocalGitTools,
  Effect.gen(function* () {
    const engine = yield* PolicyEngine;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const repositories = yield* RepositorySandbox;
    // The hub's own Git, outside any sandbox, only to read the user's `init.defaultBranch`.
    const git = runTool(spawner, toolEnv(process.env));
    const tools = [
      {
        name: GIT_INIT_TOOL,
        description: GIT_INIT_DESCRIPTION,
        label: GIT_INIT_LABEL,
        inputSchema: gitInitToolJsonSchema(),
      },
    ];

    /** Refuses a folder that is, or lies in, a Git directory, or already holds a repository. */
    const checkPlace = (folder: string) =>
      Effect.gen(function* () {
        if (insideGitDirectory(folder)) {
          return yield* new Refused({
            message: `${folder} is inside a Git directory, so it cannot hold a repository.`,
          });
        }
        if (yield* exists(`${folder}${sep}.git`)) {
          return yield* new Refused({
            message: `${folder} is already a Git repository, so nothing was created. Commit in it with git as usual.`,
          });
        }
      });

    /**
     * The call's verdict: Local Git on the folder, and Edit files on it, since the hub writes the
     * repository's files there for the hob (STD-SEC-002). The narrower answer stands, on the folder.
     * Edit files is decided on the folder, not its `.git`, which the policy keeps from every hob's
     * own writes.
     */
    const decideBoth =
      (turn: CharmTurn, access: ToolAccess, folder: string) =>
      (fresh: ToolAccess | null): Effect.Effect<AskableVerdict> =>
        Effect.gen(function* () {
          const command: PolicyRequest = {
            _tag: "Command",
            operation: "local-git",
            cwd: folder,
            words: ["git", "init"],
          };
          const files: PolicyRequest = {
            _tag: "Files",
            operation: "edit-files",
            paths: [folder],
            cwd: folder,
          };
          const git = yield* decideCharmWrite(engine, turn, access, command)(fresh);
          const edit = yield* decideCharmWrite(engine, turn, access, files)(fresh);
          return narrowerOf(git, edit);
        });

    /** The canonical hob folder that holds `target`, which the sandboxed `git init` may write below. */
    const holder = (access: ToolAccess, target: string) =>
      access.folders.map(canonical).find((folder) => target === folder || target.startsWith(`${folder}${sep}`));

    /** The user's `init.defaultBranch`, read from their own Git config on the hub, when it is a plain name. */
    const initialBranch = git("git", ["config", "--global", "--get", "init.defaultBranch"]).pipe(
      Effect.map((run) => run.out.trim()),
      Effect.map((name) => (BRANCH_NAME.test(name) ? name : null)),
      Effect.orElseSucceed(() => null),
    );

    /**
     * Runs `git init` of `target` in the hub's sandbox. There the program writes only below the hob's
     * folder `writable`, whatever links a hob's command lays on the way while the call waits, and
     * refuses a folder that moved or holds a `.git` by then.
     */
    const sandboxedInit = (writable: string, target: string) =>
      Effect.gen(function* () {
        const branch = yield* initialBranch;
        const run = yield* Effect.scoped(
          Effect.gen(function* () {
            const program = yield* repositories.gitInit(writable, target, branch);
            return yield* runTool(spawner, { PATH: process.env.PATH, ...program.env })("/bin/sh", [
              "-c",
              program.commandLine,
            ]);
          }),
        ).pipe(
          Effect.mapError(
            (error) =>
              new Refused({
                message:
                  error === "unavailable"
                    ? "Git did not finish on the hub, so no repository was created."
                    : error.message,
              }),
          ),
        );
        if (run.code !== 0) {
          return yield* new Refused({ message: `Git could not create the repository: ${run.out.trim()}` });
        }
      });

    const init = (turn: CharmTurn, access: ToolAccess, folder: string, step: HubCallStep | undefined) =>
      Effect.gen(function* () {
        if (!isAbsolute(folder)) {
          return yield* new Refused({ message: `Give the folder as an absolute path, not ${folder}.` });
        }
        yield* checkPlace(folder);
        const decision = yield* askUntilDecided({
          call: { id: step?.id ?? GIT_INIT_TOOL, tool: GIT_INIT_TOOL, arguments: { folder }, label: GIT_INIT_LABEL },
          // A call without a step has no card to show, so it cannot ask.
          approvals: step === undefined ? null : turn.approvals,
          decide: decideBoth(turn, access, folder),
          report: step?.report ?? (() => {}),
          unknown: "Hobbots cannot decide this call.",
        });
        if (decision._tag === "Refuse") return yield* new Refused({ message: decision.reason });
        // The folder as the engine resolved it, links followed, so the repository goes where it was decided.
        const target = decision.verdict.targets[0] ?? folder;
        if (target !== folder) yield* checkPlace(target);
        const writable = holder(access, target);
        if (writable === undefined) {
          return yield* new Refused({ message: `${target} is outside this hob's folders, so nothing was created.` });
        }
        step?.report({
          _tag: "ToolStarted",
          id: step.id,
          tool: GIT_INIT_TOOL,
          operation: decision.verdict.operation,
          targets: decision.verdict.targets,
          label: GIT_INIT_LABEL,
        });
        yield* sandboxedInit(writable, target);
        const note = decision.approval === undefined ? "" : ` ${approvalNote(decision.approval)}`;
        // Bubblewrap fixes a turn's mounts when it starts, and holds a missing `.git` at the top of a folder.
        const later = process.platform === "linux" && writable === target ? ` ${NEXT_TURN}` : "";
        return `${initializedText(target)}${later}${note}`;
      });

    const call = (turn: CharmTurn, name: string, input: unknown, step?: HubCallStep) =>
      Effect.gen(function* () {
        if (name !== GIT_INIT_TOOL) return yield* new Refused({ message: `Hobbots has no tool named ${name}.` });
        const decoded = yield* Schema.decodeUnknownEffect(GitInitInput)(input).pipe(
          Effect.mapError(() => new Refused({ message: "Give the folder to make a repository, as an absolute path." })),
        );
        const access = yield* turn.currentAccess;
        if (access === null || access.folders.length === 0) {
          return yield* new Refused({
            message: "You have no folders this turn, so there is nowhere to create a repository.",
          });
        }
        return yield* init(turn, access, decoded.folder, step);
      }).pipe(
        Effect.map((text): HubToolAnswer => ({ text, refused: false })),
        Effect.catchTag("Refused", (refused) =>
          Effect.succeed<HubToolAnswer>({ text: refused.message, refused: true }),
        ),
        // What the hob reads is redacted, as every hub tool's answer is.
        Effect.map((answer) => ({ ...answer, text: turn.redactor.text(answer.text) })),
      );

    return LocalGitTools.of({
      forTurn: (turn) =>
        Effect.map(turn.currentAccess, (access) =>
          access === null || access.folders.length === 0
            ? null
            : { tools, call: (name: string, input: unknown, step?: HubCallStep) => call(turn, name, input, step) },
        ),
    });
  }),
);
