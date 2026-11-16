import type { ChannelId, Message, MessageId } from "@hobbots/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call } from "./client.ts";
import { queryKeys } from "./queries.ts";
import { recordedMessage, recordMessage } from "./sync.ts";

/** A reply you write in a thread (ADR 039, Reply threads). */
export interface ThreadReplyDraft {
  /** Its id, made once per reply, so a retry after a lost answer writes it once. */
  readonly key: MessageId;
  readonly content: string;
  /** Also send it to the channel's main line. */
  readonly alsoInMainLine: boolean;
}

/**
 * Replies in the thread of `rootId`, a main-line message of the channel. The reply joins the
 * channel's messages at once, which show it in its thread, and in the main line too when it was
 * also sent there; no hob wakes for it yet (#1485).
 */
export const useReplyInThread = (channelId: ChannelId, rootId: MessageId) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, content, alsoInMainLine }: ThreadReplyDraft) =>
      call((c) =>
        c.threads.replyInThread({
          params: { channelId, messageId: rootId },
          payload: { key, content, alsoInMainLine },
        }),
      ),
    onSuccess: (reply) => {
      recordMessage(queryClient, reply);
      // A late answer never undoes what the channel learned since, as a chapter moved with the reply.
      if (recordedMessage(queryClient, reply.id) !== reply) return;
      queryClient.setQueryData<ReadonlyArray<Message>>(queryKeys.messages(channelId), (old) =>
        old === undefined || old.some((each) => each.id === reply.id) ? old : [...old, reply],
      );
    },
  });
};
