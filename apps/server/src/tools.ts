import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
  CommitIdentityQuestions,
  effectiveFolders,
  FolderChecks,
  HobGitHubApps,
  HobTools,
  openTools,
  operationDecision,
} from "@hobbots/agents";
import { type CommitsAs, hobAppCommitIdentity, settleCommitsAs } from "@hobbots/domain";
import { SetupRepository } from "@hobbots/persistence";
import { userGitIdentity } from "@hobbots/runtimes";
import { Effect, Layer, Option } from "effect";
import { Installation } from "./installation.ts";

/**
 * Where runtimes keep each hob's own state when it has tools, beside the data folder rather than in
 * it, since the data folder stays closed to every hob.
 */
export const runtimeFolders = (dataDir: string) => `${dataDir}-runtimes`;

/** Whether `folder` is `path` or holds it. */
const holds = (folder: string, path: string) =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

/** The hub's answer for HobTools: the setup and the hob's policy, read at the start of every turn. */
export const HobToolsLive = Layer.effect(
  HobTools,
  Effect.gen(function* () {
    const setup = yield* SetupRepository;
    const folderChecks = yield* FolderChecks;
    const { dataDir } = yield* Installation;
    // A hob's own GitHub App, on a hub with the GitHub Charm (ADR 022), makes the hob commit as its bot.
    const apps = yield* Effect.serviceOption(HobGitHubApps);
    // A hob on your account commits as you, or as who you told the hub when your Git config sets no one
    // (#741). A hub without the question reads your Git config in your home.
    const identities = yield* Effect.serviceOption(CommitIdentityQuestions);
    return HobTools.of({
      access: (agent, turn) =>
        Effect.gen(function* () {
          const { safetyPreset, approvedFolders } = yield* setup.get;
          const folders = yield* effectiveFolders(folderChecks, approvedFolders, agent.policy);
          const app = Option.isSome(apps) ? yield* apps.value.get(agent.id) : null;
          // A folder that holds every hob's runtime state would open one hob's sessions to another,
          // since the sandbox cannot close that state inside a folder it opens for writing. The turn
          // then gets no folders, so it is chat-only but still resumes the hob's latest session.
          const runtimes = join(realpathSync(dirname(dataDir)), basename(runtimeFolders(dataDir)));
          const holder = folders.find((folder) => holds(folder, runtimes));
          if (holder !== undefined)
            yield* Effect.logWarning(`${holder} holds Hobbots' own state; the turn is chat-only`);
          const policy = {
            preset: safetyPreset,
            sharedFolders: approvedFolders,
            hob: agent.policy,
            dataFolder: dataDir,
            // Threads, Quests and delegations add no restrictions yet.
            restrictions: [],
          };
          const turnFolders = holder === undefined ? folders : [];
          // Only a turn whose commands may run can commit, so only then is who it commits as settled.
          const commits =
            app === null &&
            turnFolders.length > 0 &&
            openTools((operation) => operationDecision(policy, operation)).commands;
          // Who the turn commits as is settled here, and every runtime applies it as given (#586, #741).
          const commitsAs: CommitsAs =
            app !== null
              ? { _tag: "Bot", identity: hobAppCommitIdentity(app) }
              : Option.isSome(identities)
                ? yield* identities.value.forTurn(agent.id, commits ? turn : undefined)
                : settleCommitsAs(null, userGitIdentity(homedir()), null);
          return {
            policy,
            folders: turnFolders,
            runtimeFolder: join(runtimeFolders(dataDir), agent.id),
            ...(app === null ? {} : { commitAs: hobAppCommitIdentity(app) }),
            commitsAs,
          };
        }).pipe(
          // Without its policy the hob gets no tools: closed, never open.
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not read the hob's policy; the turn is chat-only", cause).pipe(Effect.as(null)),
          ),
        ),
    });
  }),
);
