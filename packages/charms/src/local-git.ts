import { lstat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import {
  approvalNote,
  askUntilDecided,
  type CharmTurn,
  type HubCallStep,
  type HubToolAnswer,
  LocalGitTools,
  type ToolAccess,
} from "@hobbots/agents";
import {
  GIT_INIT_DESCRIPTION,
  GIT_INIT_LABEL,
  GIT_INIT_TOOL,
  GitInitInput,
  gitInitToolJsonSchema,
} from "@hobbots/domain";
import { PolicyEngine, type PolicyRequest } from "@hobbots/permissions";
import { Data, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { decideCharmWrite } from "./github-writes.ts";
import { runTool, toolEnv } from "./run-tool.ts";

/**
 * Local Git work the hub does for a hob outside its sandbox (ADR 014, #578): `git_init` creates a
 * repository. The sandbox keeps every repository's `.git/config` and `.git/hooks` read-only, so the
 * user's own Git never runs what a hob wrote there, and that also stops `git init`, which must write
 * a config. The hub decides the call as Local Git on the folder under the hob's policy, then runs
 * `git init` with no template, so the repository starts with Git's own config and no hooks, and the
 * hob commits in it as usual.
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

export const LocalGitToolsLive = Layer.effect(
  LocalGitTools,
  Effect.gen(function* () {
    const engine = yield* PolicyEngine;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // The hub's own Git, with the user's config for settings such as `init.defaultBranch`. With no
    // template, no hooks are copied, whatever `init.templateDir` says.
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

    const init = (turn: CharmTurn, access: ToolAccess, folder: string, step: HubCallStep | undefined) =>
      Effect.gen(function* () {
        if (!isAbsolute(folder)) {
          return yield* new Refused({ message: `Give the folder as an absolute path, not ${folder}.` });
        }
        yield* checkPlace(folder);
        const request: PolicyRequest = { _tag: "Command", operation: "local-git", cwd: folder, words: ["git", "init"] };
        const decision = yield* askUntilDecided({
          call: { id: step?.id ?? GIT_INIT_TOOL, tool: GIT_INIT_TOOL, arguments: { folder }, label: GIT_INIT_LABEL },
          // A call without a step has no card to show, so it cannot ask.
          approvals: step === undefined ? null : turn.approvals,
          decide: decideCharmWrite(engine, turn, access, request),
          report: step?.report ?? (() => {}),
          unknown: "Hobbots cannot decide this call.",
        });
        if (decision._tag === "Refuse") return yield* new Refused({ message: decision.reason });
        // The folder as the engine resolved it, links followed, so the repository goes where it was decided.
        const target = decision.verdict.targets[0] ?? folder;
        if (target !== folder) yield* checkPlace(target);
        step?.report({
          _tag: "ToolStarted",
          id: step.id,
          tool: GIT_INIT_TOOL,
          operation: decision.verdict.operation,
          targets: decision.verdict.targets,
          label: GIT_INIT_LABEL,
        });
        const run = yield* git("git", ["init", "--quiet", "--template=", "--", target]).pipe(
          Effect.mapError(
            () => new Refused({ message: "Git did not start on the hub, so no repository was created." }),
          ),
        );
        if (run.code !== 0) {
          return yield* new Refused({ message: `Git could not create the repository: ${run.out.trim()}` });
        }
        const note = decision.approval === undefined ? "" : ` ${approvalNote(decision.approval)}`;
        // Bubblewrap fixes a turn's mounts when it starts, and holds a missing `.git` at the top of a folder.
        const later = process.platform === "linux" && access.folders.includes(target) ? ` ${NEXT_TURN}` : "";
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
