import type { InvalidFolder } from "@hobbots/api";
import type {
  AgentId,
  CommitIdentity,
  EventEnvelope,
  GitHubAccount,
  HobGitHubApp,
  InstallationSetup,
  MessageId,
  ThreadId,
  TransientEvent,
} from "@hobbots/domain";
import { Context, Effect, Option, Schema } from "effect";

/** Announces what the use cases did to every client: journal entries once committed, and transient reply events. */
export class EventPublisher extends Context.Service<
  EventPublisher,
  {
    /** Announces entries a write committed, in sequence order. */
    readonly publish: (entries: ReadonlyArray<EventEnvelope>) => Effect.Effect<void>;
    readonly publishTransient: (event: TransientEvent) => Effect.Effect<void>;
  }
>()("@hobbots/agents/EventPublisher") {}

/**
 * Announces committed entries through the publisher when there is one. A failed announcement is
 * logged as `what` and never fails the write, which the journal already holds.
 */
export const announcer =
  (publisher: Option.Option<EventPublisher["Service"]>, what: string) => (entries: ReadonlyArray<EventEnvelope>) =>
    Option.isNone(publisher) || entries.length === 0
      ? Effect.void
      : publisher.value
          .publish(entries)
          .pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not announce ${what}`, cause)));

/** The installation's setup as the user last saved it: its safety preset and the folders shared with every hob. */
export class InstallationSettings extends Context.Service<
  InstallationSettings,
  { readonly get: Effect.Effect<Pick<InstallationSetup, "safetyPreset" | "approvedFolders">> }
>()("@hobbots/agents/InstallationSettings") {}

export interface FolderChecksShape {
  /**
   * A folder the user lets hobs work in, as the hub stores it: canonical, or `InvalidFolder` when
   * it is not an existing folder on the hub (ADR 014).
   */
  readonly check: (typed: string) => Effect.Effect<string, InvalidFolder>;
  /** The folder a stored path names now: canonical while it is on the hub, else the path as stored. */
  readonly identity: (folder: string) => Effect.Effect<string>;
}

/** Checks folders on the hub, where hobs work (ADR 010). */
export class FolderChecks extends Context.Service<FolderChecks, FolderChecksShape>()("@hobbots/agents/FolderChecks") {}

/** The tool step a full log belongs to. */
export interface ToolLogKey {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly stepId: string;
}

export interface ToolLogsShape {
  /** Keeps `text`, already redacted, as the step's full log. Fails when it cannot be kept. */
  readonly write: (key: ToolLogKey, text: string) => Effect.Effect<void, ToolLogUnavailable>;
  /** The step's full log, or none when there is no log Hobbots kept for it. */
  readonly read: (key: ToolLogKey) => Effect.Effect<Option.Option<string>>;
}

export class ToolLogUnavailable extends Schema.TaggedError<ToolLogUnavailable>()("ToolLogUnavailable", {
  message: Schema.String,
}) {}

/**
 * Where the hub keeps the whole output of tool calls whose steps show only its start and end, so
 * the user can open it from the step.
 */
export class ToolLogs extends Context.Service<ToolLogs, ToolLogsShape>()("@hobbots/agents/ToolLogs") {}

/**
 * Who is connected to GitHub on the hub, and since when (ADR 020), for the UI. The tokens are kept
 * in the OS keychain, never here.
 */
export class GitHubAccounts extends Context.Service<
  GitHubAccounts,
  {
    readonly get: Effect.Effect<GitHubAccount | null>;
    readonly save: (account: GitHubAccount) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
  }
>()("@hobbots/agents/GitHubAccounts") {}

/**
 * Who hobs on the user's account commit as when the user's own Git config sets no identity (#741):
 * the name and email the user gave the hub, in one row at most.
 */
export class HubCommitIdentities extends Context.Service<
  HubCommitIdentities,
  {
    readonly get: Effect.Effect<CommitIdentity | null>;
    /** Replaces the identity the user gave before, if any. */
    readonly save: (identity: CommitIdentity, at: string) => Effect.Effect<void>;
  }
>()("@hobbots/agents/HubCommitIdentities") {}

/**
 * Where you said not to ask whether a hob will write code (#1241): a hob's id, or `ALL_HOBS` for
 * every hob, with when.
 */
export class CodingSetupDismissals extends Context.Service<
  CodingSetupDismissals,
  {
    readonly list: Effect.Effect<ReadonlyArray<string>>;
    /** Keeps the choice; making it again changes nothing. */
    readonly dismiss: (scope: string, at: string) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
  }
>()("@hobbots/agents/CodingSetupDismissals") {}

/**
 * Each hob's own GitHub App, by hob (ADR 022): its identity only. Its private key is kept in the OS
 * keychain, never here.
 */
export class HobGitHubApps extends Context.Service<
  HobGitHubApps,
  {
    /** The hob's connected app, or null; an app left over after a failed removal is not one. */
    readonly get: (agentId: AgentId) => Effect.Effect<HobGitHubApp | null>;
    /** The hob's app that was disconnected or retired but not fully removed, and why, or null. */
    readonly leftOver: (
      agentId: AgentId,
    ) => Effect.Effect<{ readonly app: HobGitHubApp; readonly problem: string } | null>;
    /** Saves the hob's app, replacing the one it had, left over or not. */
    readonly save: (agentId: AgentId, app: HobGitHubApp) => Effect.Effect<void>;
    /** Keeps the hob's app as left over, with what could not be removed, until the user dismisses it. */
    readonly leave: (agentId: AgentId, problem: string) => Effect.Effect<void>;
    readonly remove: (agentId: AgentId) => Effect.Effect<void>;
  }
>()("@hobbots/agents/HobGitHubApps") {}

/**
 * What retiring a hob does to its own GitHub App (ADR 022): removes its installations and its key.
 * The hub has it only when the GitHub Charm is wired in. It never fails: what it could not remove is
 * kept with the hob's app, which then shows as left over until the user dismisses it.
 */
export class RetiredHobGitHubApp extends Context.Service<
  RetiredHobGitHubApp,
  {
    readonly remove: (agentId: AgentId) => Effect.Effect<void>;
    /**
     * Removes as `remove` does, for Start over (#948), and answers why the hob's key is still in the
     * keychain, or null when it is gone. Installations GitHub kept do not count: the app stays there.
     */
    readonly erase: (agentId: AgentId) => Effect.Effect<string | null>;
  }
>()("@hobbots/agents/RetiredHobGitHubApp") {}
