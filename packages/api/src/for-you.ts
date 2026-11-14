import { ForYou } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/**
 * Your For you list, with the stream cursor taken before it was read, so the events after it bring
 * what changed since (ADR 039).
 */
export const ForYouRead = Schema.Struct({ cursor: Schema.String, forYou: ForYou });
export type ForYouRead = typeof ForYouRead.Type;

/**
 * For you (ADR 039, Cards every thread shares): what is yours to act on, and While you were away,
 * for the person whose device asks. User sessions only (PE-006).
 */
export class ForYouGroup extends HttpApiGroup.make("forYou")
  .add(HttpApiEndpoint.get("current", "/for-you", { success: ForYouRead }))
  .middleware(DeviceSession)
  .prefix("/api") {}
