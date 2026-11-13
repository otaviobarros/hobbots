import { Schema } from "effect";

export const AgentId = Schema.String.pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;

export const ThreadId = Schema.String.pipe(Schema.brand("ThreadId"));
export type ThreadId = typeof ThreadId.Type;

/** A chapter of a thread (ADR 037). */
export const ChapterId = Schema.String.pipe(Schema.brand("ChapterId"));
export type ChapterId = typeof ChapterId.Type;

export const MessageId = Schema.String.pipe(Schema.brand("MessageId"));
export type MessageId = typeof MessageId.Type;

/** A Task of ADR 018. */
export const TaskId = Schema.String.pipe(Schema.brand("TaskId"));
export type TaskId = typeof TaskId.Type;

/** An artifact in the registry (ADR 037): one thing a hob made or changed in a chat or camp. */
export const RegisteredArtifactId = Schema.String.pipe(Schema.brand("RegisteredArtifactId"));
export type RegisteredArtifactId = typeof RegisteredArtifactId.Type;
