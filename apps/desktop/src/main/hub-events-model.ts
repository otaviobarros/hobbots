/**
 * What the main process takes from the hub's event stream (ADR 013): when it connected, and which
 * of its own reads a change makes stale. It reads the stream instead of polling, so an idle app
 * sends no requests.
 */

/** One server-sent event: its name and its data lines joined. */
export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/**
 * Splits server-sent events text into complete frames. `rest` is the unfinished frame at the end,
 * to put before the next chunk. Comments, such as keep-alives, and frames without data are skipped.
 */
export const parseSse = (text: string): { readonly frames: ReadonlyArray<SseFrame>; readonly rest: string } => {
  const blocks = text.split("\n\n");
  const rest = blocks.pop() ?? "";
  const frames = blocks.flatMap((block): Array<SseFrame> => {
    let event = "message";
    const data: Array<string> = [];
    for (const line of block.split("\n")) {
      const colon = line.indexOf(":");
      if (colon === 0) continue;
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length === 0 ? [] : [{ event, data: data.join("\n") }];
  });
  return { frames, rest };
};

/** A read the main process makes again: the Inbox's requests, or which hobs are working. */
export type HubChange = "approvals" | "activity";

const parse = (data: string): unknown => {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * What a frame means for the main process: `connected` for the stream's first frame, the read a
 * journal entry makes stale, or null when it changes nothing the main process shows. A hob starts
 * and ends its turns through its reply, so only a reply's upsert changes who is working.
 */
export const frameChange = (frame: SseFrame): HubChange | "connected" | null => {
  if (frame.event === "ready") return "connected";
  if (frame.event !== "message") return null;
  const entry = parse(frame.data);
  switch (field(entry, "type")) {
    case "ApprovalRequested":
    case "ApprovalResolved":
      return "approvals";
    case "MessageUpserted":
      return field(field(field(entry, "payload"), "message"), "role") === "assistant" ? "activity" : null;
    default:
      return null;
  }
};
