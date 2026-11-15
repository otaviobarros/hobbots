import { ChannelArchived, ChannelNotFound, MessageKeyReused, type MessageNotFound, UserSession } from "@hobbots/api";
import {
  type Channel,
  type ChannelId,
  type Committed,
  isNote,
  Message,
  type MessageId,
  type MessagePin,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { HobAdmission, withChannelLock } from "./admission.ts";
import { announcer, announcing, EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";

/**
 * Notes to self and pins (ADR 037, Mine). A note is a message with the `note` role: you write it in
 * a chat or camp, and only you read it. It wakes no hob, joins no turn, and never reaches the hob's
 * memory or records, since every read a hob takes keeps only what it reads (`hobReads`). A pin
 * marks a message of the channel, so the camp sheet lists it under Mine.
 */

/** Where pins are kept. Each change journals its event in one transaction. */
export class PinRepository extends Context.Service<
  PinRepository,
  {
    /**
     * Pins or unpins a message of the channel, journaled as `MessagePinned` or `MessageUnpinned`.
     * A message pinned already keeps its pin, and one not pinned stays so, with nothing journaled.
     * Answers the pin as it stands after, or null when there is none.
     */
    readonly setPinned: (
      channelId: ChannelId,
      messageId: MessageId,
      pinned: boolean,
      at: string,
    ) => Effect.Effect<Committed<MessagePin | null>, MessageNotFound>;
    /** The channel's pins, the newest first. */
    readonly listPins: (channelId: ChannelId) => Effect.Effect<ReadonlyArray<MessagePin>>;
  }
>()("@hobbots/agents/PinRepository") {}

export class Notes extends Context.Service<
  Notes,
  {
    /**
     * Writes a note to self in the channel, under `key`, which becomes its id: the same note sent
     * again returns it, and a key that names anything else is refused. An archived channel takes none.
     * The note is the session's user's (ADR 039): only a person writes one.
     */
    readonly write: (
      channelId: ChannelId,
      key: MessageId,
      content: string,
    ) => Effect.Effect<Message, ChannelNotFound | ChannelArchived | MessageKeyReused, UserSession>;
    readonly setPinned: (
      channelId: ChannelId,
      messageId: MessageId,
      pinned: boolean,
    ) => Effect.Effect<MessagePin | null, ChannelNotFound | MessageNotFound>;
    readonly pins: (channelId: ChannelId) => Effect.Effect<ReadonlyArray<MessagePin>, ChannelNotFound>;
  }
>()("@hobbots/agents/Notes") {
  static readonly layer = Layer.effect(
    Notes,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const pins = yield* PinRepository;
      const admission = yield* HobAdmission;
      const announce = announcer(yield* Effect.serviceOption(EventPublisher), "a note or a pin");
      const now = Effect.map(DateTime.now, DateTime.formatIso);

      const channelOf = (channelId: ChannelId): Effect.Effect<Channel, ChannelNotFound> =>
        Effect.flatMap(repo.findChannel(channelId), (found) =>
          Option.isNone(found) ? Effect.fail(new ChannelNotFound({ channelId })) : Effect.succeed(found.value),
        );

      const announced = announcing(announce);

      // Under the hob's lock, as a message you send is, so the note takes its place in the channel's
      // order and no archive lands between the check and the write.
      const write = (channelId: ChannelId, key: MessageId, content: string) =>
        Effect.flatMap(channelOf(channelId), (channel) =>
          withChannelLock(admission, channel, writeIn(channelId, key, content)),
        );

      const writeIn = Effect.fn("Notes.write")(function* (channelId: ChannelId, key: MessageId, content: string) {
        const session = yield* UserSession;
        const channel = yield* channelOf(channelId);
        const stored = yield* repo.findMessage(key);
        if (Option.isSome(stored)) {
          const same = stored.value.channelId === channelId && isNote(stored.value) && stored.value.content === content;
          return same ? stored.value : yield* new MessageKeyReused({ messageId: key });
        }
        if (channel.archivedAt !== null)
          return yield* new ChannelArchived({ channelId, archivedAt: channel.archivedAt });
        const note = new Message({
          id: key,
          channelId,
          actor: session.actor,
          role: "note",
          content,
          status: "complete",
          error: null,
          configVersion: null,
          createdAt: yield* now,
        });
        return yield* announced(repo.upsertMessage(note));
      });

      return Notes.of({
        write,
        setPinned: (channelId, messageId, pinned) =>
          Effect.gen(function* () {
            yield* channelOf(channelId);
            return yield* announced(pins.setPinned(channelId, messageId, pinned, yield* now));
          }),
        pins: (channelId) => Effect.andThen(channelOf(channelId), pins.listPins(channelId)),
      });
    }),
  );
}
