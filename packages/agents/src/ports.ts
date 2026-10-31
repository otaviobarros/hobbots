import type { InvalidFolder } from "@hobbots/api";
import type { EventEnvelope, InstallationSetup, TransientEvent } from "@hobbots/domain";
import { Context, type Effect } from "effect";

/** Announces what the use cases did to every client: journal entries once committed, and transient reply events. */
export class EventPublisher extends Context.Service<
  EventPublisher,
  {
    /** Announces entries a write committed, in sequence order. */
    readonly publish: (entries: ReadonlyArray<EventEnvelope>) => Effect.Effect<void>;
    readonly publishTransient: (event: TransientEvent) => Effect.Effect<void>;
  }
>()("@hobbots/agents/EventPublisher") {}

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
