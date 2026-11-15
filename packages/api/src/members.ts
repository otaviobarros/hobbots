import { Actor, ActorKind, AgentId, MemberRefusal, ChannelId, ChannelMember, User } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { AgentNotFound, HobUnavailable, ChannelArchived, ChannelNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * A camp's members sheet (ADR 039, Members; Cards every channel shares › Status and cost): who is in
 * it, who leads its quests, and what each hob spent there today.
 */

/** A member the channel did not take or let go, and why. */
export class MembershipRefused extends Schema.TaggedError<MembershipRefused>()(
  "MembershipRefused",
  { channelId: ChannelId, actor: Actor, reason: MemberRefusal },
  { httpApiStatus: 409 },
) {}

/**
 * What one hob's replies in the channel used in the period, from the same records as the Usage
 * screen: its settled replies (`turns`), every token they read or wrote, and how many reported none.
 */
export const HobToday = Schema.Struct({
  hobId: AgentId,
  turns: Schema.Number,
  tokens: Schema.Number,
  unreported: Schema.Number,
  /** When its last settled reply in the channel started, in the period or before; null for none. */
  lastAnsweredAt: Schema.NullOr(Schema.String),
});
export type HobToday = typeof HobToday.Type;

export const MembersReport = Schema.Struct({
  channelId: ChannelId,
  /** Every member, in every state: the owner first, then in the order they joined. */
  members: Schema.Array(ChannelMember),
  /** The people among them, so the sheet can name them. Who speaks comes from the hub's status. */
  people: Schema.Array(User),
  /** Each hob member's replies in the channel from `since` until `until`. */
  /** Every hob that answered in the channel in the period, a member or not, so the totals add up. */
  today: Schema.Array(HobToday),
  since: Schema.String,
  until: Schema.String,
});
export type MembersReport = typeof MembersReport.Type;

/** Adds a hob, or a person the hub knows, to a camp. */
export const AddMemberPayload = Schema.Struct({ actor: Actor });
export type AddMemberPayload = typeof AddMemberPayload.Type;

export class MembersGroup extends HttpApiGroup.make("members")
  .add(
    // `since` (ISO 8601) starts "today" at the client's own midnight, as the Usage screen's period does.
    HttpApiEndpoint.get("list", "/channels/:channelId/members", {
      params: { channelId: ChannelId },
      query: { since: Schema.String },
      success: MembersReport,
      error: ChannelNotFound,
    }),
  )
  .add(
    // Adding someone already in returns them as they are; one who left or was removed comes back.
    HttpApiEndpoint.post("add", "/channels/:channelId/members", {
      params: { channelId: ChannelId },
      payload: AddMemberPayload,
      success: ChannelMember,
      error: [ChannelNotFound, ChannelArchived, AgentNotFound, HobUnavailable, MembershipRefused],
    }),
  )
  .add(
    // Removing a hob drops the answers it still owed there, and stops the reply it is writing.
    // Removing someone already gone returns them as they are.
    HttpApiEndpoint.delete("remove", "/channels/:channelId/members/:kind/:id", {
      params: { channelId: ChannelId, kind: ActorKind, id: Schema.String },
      success: ChannelMember,
      error: [ChannelNotFound, ChannelArchived, MembershipRefused],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
