import { type DroppedTool, type NotOfferedCall, notOfferedReason, type SessionToolOffer } from "@hobbots/agents";

/** Why a session is not offered a tool, in words for a lead, and for whoever reads why a call did not run. */
export const dropWords = (who: string, dropped: DroppedTool): string => {
  switch (dropped.reason) {
    case "never":
      return "its answer is Never";
    case "not-granted":
      return `${who} does not hold ${dropped.from}`;
    case "not-connected":
      return `${dropped.from} is not connected`;
    case "chats-only":
      return `${dropped.from} offers its writes only in chats, not in a Task`;
    case "chat-only":
      return "its turns are chat-only";
    case "commands-closed":
      return "commands need Read files Allow and Edit files Allow or Never";
    case "no-sandbox":
      return `${who}'s runtime cannot start its sandbox on this hub`;
  }
};

/** The names a session's offer may give the runtime's own tool a call belongs to. */
const offerNames = (call: NotOfferedCall): ReadonlyArray<string> =>
  call.runtimeTool === null
    ? [call.tool]
    : call.runtimeTool === "commands"
      ? ["commands", "read_only_commands"]
      : [call.runtimeTool];

/**
 * Why a call to a tool the session was not offered did not run, from the offer the session was
 * built from (#1348, #1356): the reason it lacks the tool when the hub knows one, such as a Charm's
 * writes being offered only in chats or a hob not holding the Charm. A tool the offer holds now was
 * added after the session started, which keeps the tools it started with; any other name is one the
 * hub has no tool for.
 */
export const notOfferedWords = (call: NotOfferedCall, offer: SessionToolOffer, who: string): string => {
  const names = offerNames(call);
  const dropped = offer.dropped.find((tool) => names.includes(tool.tool));
  if (dropped !== undefined)
    return `${notOfferedReason(call.tool)} It is not offered because ${dropWords(who, dropped)}.`;
  if (offer.tools.some((tool) => names.includes(tool.tool))) {
    return `${notOfferedReason(call.tool)} The session started before it was offered and keeps the tools it started with; a new session gets it.`;
  }
  return `${notOfferedReason(call.tool)} Hobbots has no tool by that name for ${who}.`;
};
