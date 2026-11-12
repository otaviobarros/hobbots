import { Schema } from "effect";
import type { AgentId } from "./ids.ts";

/**
 * Who wrote a record (ADR 037, Every author is an actor): you, a hob or the hub itself, each with an
 * id. There is no implied "you": every authored record names its actor, so shared camps can name
 * more than one person later without changing what a stored record means.
 */
export const ActorKind = Schema.Literals(["user", "hob", "hub"]);
export type ActorKind = typeof ActorKind.Type;

export const Actor = Schema.Struct({ kind: ActorKind, id: Schema.String });
export type Actor = typeof Actor.Type;

/**
 * The person a hub serves today. A hub has one person, so every record you write names this id;
 * shared camps will give each person an id of their own.
 */
export const OWNER_ACTOR: Actor = { kind: "user", id: "owner" };

/** A hob as the author of a record. */
export const hobActor = (agentId: AgentId): Actor => ({ kind: "hob", id: agentId });

/** The hub itself as the author of a record it writes, such as a camp's brief. */
export const HUB_ACTOR: Actor = { kind: "hub", id: "hub" };
