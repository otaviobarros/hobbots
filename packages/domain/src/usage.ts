import { Schema } from "effect";
import { AgentStatus, RuntimeKind } from "./agent.ts";
import { AgentId } from "./ids.ts";
import { QuestId } from "./quest.ts";

// The Usage screen (OP-002): what each hob's replies used, from the usage recorded with them (#398),
// with the turns its Tasks ran outside any chat as a planned step or a party member (#1011), and each
// runtime's plan as the runtime reports it. Nothing here is estimated: a reply or a plan
// that reported nothing says so.

/** The periods the Usage screen offers, in days. */
export const UsagePeriod = Schema.Literals(["7", "30"]);
export type UsagePeriod = typeof UsagePeriod.Type;

/**
 * What one hob's replies on one runtime and model used in the period. A turn the hob ran outside any
 * chat, as a planned step or a party member, counts as a reply. `unreported` counts the replies whose
 * runtime reported no usage: a failed or stopped turn, or a reply older than #398. Turns outside a
 * chat from before #1011 were never recorded, so they are missing rather than unreported.
 */
export const HobUsage = Schema.Struct({
  hobId: AgentId,
  hobName: Schema.String,
  hobStatus: AgentStatus,
  /** The runtime and model the replies ran on; null for replies older than ADR 017. */
  runtime: Schema.NullOr(RuntimeKind),
  model: Schema.NullOr(Schema.String),
  replies: Schema.Number,
  unreported: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
});
export type HobUsage = typeof HobUsage.Type;

/**
 * What one Quest's whole party used in the period, or everything outside a Quest when `questId` is
 * null. A chat reply counts for a Quest when it was written in the Quest's chat while the Quest ran,
 * from its start to its end. A turn outside any chat, a member's or a step's, counts for the Quest of
 * its Task's tree (#1011). A sub-quest's count for the Quest above it.
 */
export const QuestUsage = Schema.Struct({
  questId: Schema.NullOr(QuestId),
  /** The Quest's goal; null for the chats outside a Quest. */
  goal: Schema.NullOr(Schema.String),
  /** The Quest's lead; null for the chats outside a Quest. */
  leadName: Schema.NullOr(Schema.String),
  /** How many hobs are in the party, the lead included; 0 for the chats outside a Quest. */
  party: Schema.Number,
  /** How many chats the replies were in; turns outside a chat are in none. */
  chats: Schema.Number,
  replies: Schema.Number,
  unreported: Schema.Number,
  /** Every token the replies read or wrote, cached or not. */
  tokens: Schema.Number,
});
export type QuestUsage = typeof QuestUsage.Type;

/**
 * Every hob's replies that started in one minute (UTC). A minute fits every time zone's offset, so a
 * client can count them by its own days.
 */
export const MinuteUsage = Schema.Struct({
  /** The minute's start, ISO 8601 in UTC: "2026-11-02T18:45:00.000Z". */
  minute: Schema.String,
  replies: Schema.Number,
  tokens: Schema.Number,
});
export type MinuteUsage = typeof MinuteUsage.Type;

/**
 * One of a plan's meters, as the provider sent it: which meters apply, their order and their severity
 * are the provider's, so a client shows them as they are and never grades one itself.
 */
export const PlanMeter = Schema.Struct({
  /** The provider's kind of meter, such as "session", "weekly_all" or "weekly_scoped". */
  kind: Schema.String,
  /** The provider's group for the meter, such as "session" or "weekly". */
  group: Schema.String,
  /** How much of the window is used, 0 to 100. */
  percent: Schema.Number,
  /** When the window refills, ISO 8601, when the provider said. */
  resetsAt: Schema.NullOr(Schema.String),
  /** The model or surface a scoped meter is for, in the provider's words. */
  scope: Schema.NullOr(Schema.String),
  /** The provider's reading of the meter, such as "normal", "warning" or "critical". */
  severity: Schema.String,
  /** The meter the provider picks for a single-value indicator. */
  active: Schema.Boolean,
});
export type PlanMeter = typeof PlanMeter.Type;

/** Usage credits spent beyond the plan in its billing period, in minor units of `currency`. */
export const PlanExtraUsage = Schema.Struct({
  enabled: Schema.Boolean,
  monthlyLimit: Schema.NullOr(Schema.Number),
  usedCredits: Schema.NullOr(Schema.Number),
  currency: Schema.NullOr(Schema.String),
});
export type PlanExtraUsage = typeof PlanExtraUsage.Type;

/**
 * A runtime's plan as it reported it. `reported` is false when it reported nothing: an API key, an
 * account without the plan's usage, a runtime that cannot say, or a check that failed.
 */
export const PlanUsage = Schema.Struct({
  runtime: RuntimeKind,
  reported: Schema.Boolean,
  meters: Schema.Array(PlanMeter),
  extraUsage: Schema.NullOr(PlanExtraUsage),
  checkedAt: Schema.NullOr(Schema.String),
});
export type PlanUsage = typeof PlanUsage.Type;

/** A runtime's plan when it reports nothing. */
export const unreportedPlan = (runtime: RuntimeKind, checkedAt: string | null = null): PlanUsage => ({
  runtime,
  reported: false,
  meters: [],
  extraUsage: null,
  checkedAt,
});

/**
 * What the hub's hobs used from `since` until `until`. A client that names `since`, such as the start
 * of its own first day, gets exactly that period. The runtimes' plans come on their own request, since
 * asking a runtime for its plan can take seconds and the hub's own numbers should not wait for it.
 */
export const UsageReport = Schema.Struct({
  since: Schema.String,
  until: Schema.String,
  hobs: Schema.Array(HobUsage),
  quests: Schema.Array(QuestUsage),
  minutes: Schema.Array(MinuteUsage),
});
export type UsageReport = typeof UsageReport.Type;

/** Every token a reply's model read or wrote, cached or not. */
export const usageTokens = (
  usage: Pick<HobUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
): number => usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
