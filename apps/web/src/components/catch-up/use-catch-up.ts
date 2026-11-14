import { type CatchUp, hasNews, type Thread, type ThreadId } from "@hobbots/domain";
import { useQuery } from "@tanstack/react-query";
import { useReducer, useState } from "react";
import { catchUpQuery } from "../../api/notes.ts";
import { useKnownUnreadThreads, usePageShown } from "../../api/thread-reads.ts";
import { CATCH_UP_START, type CatchUpFlow, catchUpStep, moves, seeing } from "./catch-up-flow.ts";

/** What the chat shows of catching up, and whether its read still holds back marking it read. */
export interface CatchUpView {
  /**
   * The visit's catch-up has not been read yet, or its read failed: the chat waits to mark itself
   * read until it is read or you fold it, so a failed read never loses what changed.
   */
  readonly reading: boolean;
  /** The visit's read failed: the card says so, with Read again. */
  readonly failed: boolean;
  readonly retry: () => void;
  /** What changed while you were away, shown until you fold it; null when nothing did. */
  readonly open: CatchUp | null;
  /** What the folded catch-up held, for its "Caught up" line; null unless you folded one. */
  readonly folded: CatchUp | null;
  readonly fold: () => void;
}

let mounts = 0;
const newMountId = (): string => {
  mounts += 1;
  return `m${mounts}`;
};

/**
 * Catch-up for the chat in front (ADR 037): read from the hub at each visit to an unread chat, before
 * the chat marks itself read, so it says what changed since you last read it on any device.
 */
export const useCatchUp = (thread: Thread | undefined, inView: boolean): CatchUpView => {
  const shown = usePageShown() && inView;
  const [flow, dispatch] = useReducer(catchUpStep, CATCH_UP_START);
  // Each mount counts its visits from 1 again, so the visit's key carries this mount's own id too.
  const [mount] = useState(newMountId);
  const seen = seeing(thread?.id, shown, useKnownUnreadThreads());
  // Where you are changed: the flow takes it in this render, as a visit or not (adjusting state to a prop).
  if (moves(flow, seen)) dispatch(seen);
  const visit = flow.step !== "idle" && flow.threadId === thread?.id ? flow.visits : null;
  const read = useQuery({
    ...catchUpQuery(thread?.id ?? ("" as ThreadId), `${mount}:${visit ?? 0}`),
    enabled: visit !== null,
  });
  return {
    ...viewOf(flow.step, visit === null ? null : read),
    retry: () => void read.refetch(),
    fold: () => dispatch({ _tag: "Fold" }),
  };
};

/** What the visit's read shows at `step`; `read` is null when there is no visit. */
const viewOf = (
  step: CatchUpFlow["step"],
  read: { readonly data: CatchUp | undefined; readonly isSuccess: boolean; readonly isError: boolean } | null,
): Pick<CatchUpView, "reading" | "failed" | "open" | "folded"> => {
  const caught = read?.data !== undefined && hasNews(read.data) ? read.data : null;
  const unsettled = read !== null && step === "open" && !read.isSuccess;
  return {
    reading: unsettled,
    failed: unsettled && read.isError,
    open: step === "open" ? caught : null,
    folded: step === "folded" ? caught : null,
  };
};
