import { Schema } from "effect";

export const AgentId = Schema.String.pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;

export const ThreadId = Schema.String.pipe(Schema.brand("ThreadId"));
export type ThreadId = typeof ThreadId.Type;

export const MessageId = Schema.String.pipe(Schema.brand("MessageId"));
export type MessageId = typeof MessageId.Type;
