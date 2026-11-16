import { ChannelArchived, ChannelNotFound, MessageKeyReused, MessageNotFound, UserSession } from "@hobbots/api";
import { type Channel, type ChannelId, hobReads, Message, type MessageId } from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { HobAdmission, withChannelLock } from "./admission.ts";
import { announcer, announcing, EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";

/**
 * Reply threads (ADR 039, Reply threads): any main-line message of a chat or camp can have a thread
 * of replies, as in Slack, so a side conversation doesn't fill the channel. A reply is an ordinary
 * message of the channel that names its root, filed in its root's chapter, so find, chapters,
 * records and capture read it as they read any other. The main line leaves it out unless it was also
 * sent there. Until each thread has its own floor and sessions (#1485), no hob answers in one.
 */

/** A reply you write in a thread: `key` becomes its id, so the same reply sent again is written once. */
export interface ThreadReply {
  readonly key: MessageId;
  readonly content: string;
  /** Also send it to the channel's main line, where it shows with a link back to its thread. */
  readonly alsoInMainLine: boolean;
}

export class ReplyThreads extends Context.Service<
  ReplyThreads,
  {
    /**
     * Writes a reply of the session's user in the thread of `rootId`, a main-line message of the
     * channel; a reply to a reply goes to that reply's thread. A note to self, a message still
     * waiting its turn and a message of another channel have no thread here (`MessageNotFound`). The
     * same reply sent again under its key returns it, and a key that names anything else is refused.
     * An archived channel takes none.
     */
    readonly reply: (
      channelId: ChannelId,
      rootId: MessageId,
      reply: ThreadReply,
    ) => Effect.Effect<Message, ChannelNotFound | ChannelArchived | MessageNotFound | MessageKeyReused, UserSession>;
  }
>()("@hobbots/agents/ReplyThreads") {
  static readonly layer = Layer.effect(
    ReplyThreads,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const admission = yield* HobAdmission;
      const announced = announcing(announcer(yield* Effect.serviceOption(EventPublisher), "a reply in a thread"));
      const now = Effect.map(DateTime.now, DateTime.formatIso);
      const channelOf = (channelId: ChannelId): Effect.Effect<Channel, ChannelNotFound> =>
        repo
          .findChannel(channelId)
          .pipe(
            Effect.flatMap(Option.match({ onNone: () => new ChannelNotFound({ channelId }), onSome: Effect.succeed })),
          );

      // The message a thread on `messageId` hangs from: itself when it is in the main line, or the
      // root of the thread it is a reply in, which is always in the main line.
      const rootOf = Effect.fn("ReplyThreads.rootOf")(function* (channelId: ChannelId, messageId: MessageId) {
        const missing = new MessageNotFound({ channelId, messageId });
        const found = yield* repo.findMessage(messageId);
        if (Option.isNone(found) || found.value.channelId !== channelId) return yield* missing;
        const { rootMessageId } = found.value;
        const root = rootMessageId === null ? found : yield* repo.findMessage(rootMessageId);
        if (Option.isNone(root)) return yield* missing;
        // A note is yours alone and a queued message is not said yet, so neither carries a thread.
        if (!hobReads(root.value) || root.value.status === "queued") return yield* missing;
        return root.value;
      });

      const replyIn = Effect.fn("ReplyThreads.reply")(function* (
        channel: Channel,
        rootId: MessageId,
        reply: ThreadReply,
      ) {
        const session = yield* UserSession;
        const stored = yield* repo.findMessage(reply.key);
        if (Option.isSome(stored)) {
          const same =
            stored.value.channelId === channel.id &&
            stored.value.rootMessageId !== null &&
            stored.value.role === "user" &&
            stored.value.content === reply.content;
          return same ? stored.value : yield* new MessageKeyReused({ messageId: reply.key });
        }
        if (channel.archivedAt !== null) {
          return yield* new ChannelArchived({ channelId: channel.id, archivedAt: channel.archivedAt });
        }
        const root = yield* rootOf(channel.id, rootId);
        const message = new Message({
          id: reply.key,
          channelId: channel.id,
          actor: session.actor,
          role: "user",
          content: reply.content,
          status: "complete",
          error: null,
          configVersion: null,
          rootMessageId: root.id,
          alsoInMainLine: reply.alsoInMainLine,
          createdAt: yield* now,
        });
        // Its mentions are stored with it, as any message's are; no hob owes a reply in a thread an
        // answer yet, so none can be refused.
        const sent = yield* announced(repo.sendMessage(message, { mentions: [], repliesTo: null })).pipe(
          Effect.catchTag("MentionRefused", (refused) => Effect.die(refused)),
        );
        return sent.message;
      });

      // Under the hob's lock, as a message you send is, so the reply takes its place in the channel's
      // order and no archive lands between the check and the write.
      return ReplyThreads.of({
        reply: (channelId, rootId, reply) =>
          Effect.flatMap(channelOf(channelId), (channel) =>
            withChannelLock(
              admission,
              channel,
              Effect.flatMap(channelOf(channelId), (current) => replyIn(current, rootId, reply)),
            ),
          ),
      });
    }),
  );
}
