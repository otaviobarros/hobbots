import { type CatchUp, hasNews, type Thread, type ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useReducer } from "react";
import { catchUpQuery } from "../../api/notes.ts";
import { usePageShown } from "../../api/thread-reads.ts";
import { CATCH_UP_START, type CatchUpEvent, catchUpStep, moves } from "./catch-up-flow.ts";

/** What the chat shows of catching up, and whether its read still holds back marking it read. */
export interface CatchUpView {
  /** The visit's catch-up is being read: the chat waits to mark itself read until it is. */
  readonly reading: boolean;
  /** What changed while you were away, shown until you fold it; null when nothing did. */
  readonly open: CatchUp | null;
  /** What the folded catch-up held, for its "Caught up" line; null unless you folded one. */
  readonly folded: CatchUp | null;
  readonly fold: () => void;
}

/**
 * Catch-up for the chat in front (ADR 037): read from the hub at each visit to an unread chat, before
 * the chat marks itself read, so it says what changed since you last read it on any device.
 */
export const useCatchUp = (thread: Thread | undefined, inView: boolean): CatchUpView => {
  const shown = usePageShown() && inView;
  const [flow, dispatch] = useReducer(catchUpStep, CATCH_UP_START);
  const seen: Extract<CatchUpEvent, { readonly _tag: "See" }> = {
    _tag: "See",
    threadId: thread?.id,
    shown,
    unread: thread?.unread === true,
  };
  // Where you are changed: the flow takes it in this render, as a visit or not (adjusting state to a prop).
  if (moves(flow, seen)) dispatch(seen);
  const visit = flow.step !== "idle" && flow.threadId === thread?.id ? flow.visits : null;
  const read = useQuery({ ...catchUpQuery(thread?.id ?? ("" as ThreadId), visit ?? 0), enabled: visit !== null });
  const caught = visit !== null && read.data !== undefined && hasNews(read.data) ? read.data : null;
  return {
    reading: visit !== null && read.isPending,
    open: flow.step === "open" ? caught : null,
    folded: flow.step === "folded" ? caught : null,
    fold: () => dispatch({ _tag: "Fold" }),
  };
};
