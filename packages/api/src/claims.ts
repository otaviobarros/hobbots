import { ClaimClash, ThreadId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { DeviceSession } from "./user-session.ts";

/**
 * The claims register as a chat or camp shows it (ADR 037): the open clashes on paths and branches
 * that touch its quests, each a Heads-up. The `Claim*` events say when to read it again.
 */
export class ClaimsGroup extends HttpApiGroup.make("claims")
  .add(
    HttpApiEndpoint.get("clashes", "/threads/:threadId/clashes", {
      params: { threadId: ThreadId },
      success: Schema.Array(ClaimClash),
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
