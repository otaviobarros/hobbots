import { Sidebar, User } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/**
 * The sidebar of the person whose device asks (ADR 039, The sidebar): who they are, the other people
 * in their camps, and their camps and direct messages as the hub sorted them by members.
 */
export const SidebarRead = Schema.Struct({ you: User, people: Schema.Array(User), sidebar: Sidebar });
export type SidebarRead = typeof SidebarRead.Type;

/** The sidebar's Camps and Direct messages, worked out on every read and never stored. User sessions only (PE-006). */
export class SidebarGroup extends HttpApiGroup.make("sidebar")
  .add(HttpApiEndpoint.get("current", "/sidebar", { success: SidebarRead }))
  .middleware(DeviceSession)
  .prefix("/api") {}
