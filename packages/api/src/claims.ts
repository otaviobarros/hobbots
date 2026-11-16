import { ChannelId, Claim, ClaimClash, TaskId } from "@hobbots/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { TaskNotFound } from "./errors.ts";
import { DeviceSession } from "./user-session.ts";

/**
 * The claims register as a chat or camp shows it (ADR 037): the open clashes on paths and branches
 * that touch its quests, each a Heads-up. The `Claim*` events say when to read it again. Take over
 * moves a Task's open claims to you (#1449), so the hub refuses its hob's writes to them, and Give
 * back returns them to its hob (#1538).
 */
export class ClaimsGroup extends HttpApiGroup.make("claims")
  .add(
    HttpApiEndpoint.get("clashes", "/channels/:channelId/clashes", {
      params: { channelId: ChannelId },
      success: Schema.Array(ClaimClash),
    }),
  )
  .add(
    // A Task's open claims, oldest first, and whether you took each over (#1449).
    HttpApiEndpoint.get("taskClaims", "/tasks/:taskId/claims", {
      params: { taskId: TaskId },
      success: Schema.Array(Claim),
    }),
  )
  .add(
    // The claims it moved to you; none when the Task holds no open claim or you hold them all.
    HttpApiEndpoint.post("takeOver", "/tasks/:taskId/take-over", {
      params: { taskId: TaskId },
      success: Schema.Array(Claim),
      error: [TaskNotFound],
    }),
  )
  .add(
    // The claims it gave back to the Task's hob; none when you took over nothing of the Task.
    HttpApiEndpoint.post("giveBack", "/tasks/:taskId/give-back", {
      params: { taskId: TaskId },
      success: Schema.Array(Claim),
      error: [TaskNotFound],
    }),
  )
  .middleware(DeviceSession)
  .prefix("/api") {}
