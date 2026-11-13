import { MessageKeyReused, type MessageNotFound, ThreadArchived, ThreadNotFound, UserSession } from "@hobbots/api";
import {
  type Committed,
  isNote,
  Message,
  type MessageId,
  type MessagePin,
  type Thread,
  type ThreadId,
} from "@hobbots/domain";
import { Context, DateTime, Effect, Layer, Option } from "effect";
import { HobAdmission } from "./admission.ts";
import { announcer, EventPublisher } from "./ports.ts";
import { HobbotsRepository } from "./repository.ts";

/**
 * Notes to self and pins (ADR 037, Mine). A note is a message with the `note` role: you write it in
 * a chat or camp, and only you read it. It wakes no hob, joins no turn, and never reaches the hob's
 * memory or records, since every read a hob takes keeps only what it reads (`hobReads`). A pin
 * marks a message of the thread, so the camp sheet lists it under Mine.
 */

/** Where pins are kept. Each change journals its event in one transaction. */
export class PinRepository extends Context.Service<
  PinRepository,
  {
    /**
     * Pins or unpins a message of the thread, journaled as `MessagePinned` or `MessageUnpinned`.
     * A message pinned already keeps its pin, and one not pinned stays so, with nothing journaled.
     * Answers the pin as it stands after, or null when there is none.
     */
    readonly setPinned: (
      threadId: ThreadId,
      messageId: MessageId,
      pinned: boolean,
      at: string,
    ) => Effect.Effect<Committed<MessagePin | null>, MessageNotFound>;
    /** The thread's pins, the newest first. */
    readonly listPins: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<MessagePin>>;
  }
>()("@hobbots/agents/PinRepository") {}

export class Notes extends Context.Service<
  Notes,
  {
    /**
     * Writes a note to self in the thread, under `key`, which becomes its id: the same note sent
     * again returns it, and a key that names anything else is refused. An archived thread takes none.
     * The note is the session's user's (ADR 039): only a person writes one.
     */
    readonly write: (
      threadId: ThreadId,
      key: MessageId,
      content: string,
    ) => Effect.Effect<Message, ThreadNotFound | ThreadArchived | MessageKeyReused, UserSession>;
    readonly setPinned: (
      threadId: ThreadId,
      messageId: MessageId,
      pinned: boolean,
    ) => Effect.Effect<MessagePin | null, ThreadNotFound | MessageNotFound>;
    readonly pins: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<MessagePin>, ThreadNotFound>;
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

      const threadOf = (threadId: ThreadId): Effect.Effect<Thread, ThreadNotFound> =>
        Effect.flatMap(repo.findThread(threadId), (found) =>
          Option.isNone(found) ? Effect.fail(new ThreadNotFound({ threadId })) : Effect.succeed(found.value),
        );

      const announced = <A, E>(command: Effect.Effect<Committed<A>, E>) =>
        Effect.tap(command, (committed) => announce(committed.entries)).pipe(
          Effect.map((committed) => committed.value),
        );

      // Under the hob's lock, as a message you send is, so the note takes its place in the thread's
      // order and no archive lands between the check and the write.
      const write = (threadId: ThreadId, key: MessageId, content: string) =>
        Effect.flatMap(threadOf(threadId), (thread) =>
          admission.withHob(thread.agentId, writeIn(threadId, key, content)),
        );

      const writeIn = Effect.fn("Notes.write")(function* (threadId: ThreadId, key: MessageId, content: string) {
        const session = yield* UserSession;
        const thread = yield* threadOf(threadId);
        const stored = yield* repo.findMessage(key);
        if (Option.isSome(stored)) {
          const same = stored.value.threadId === threadId && isNote(stored.value) && stored.value.content === content;
          return same ? stored.value : yield* new MessageKeyReused({ messageId: key });
        }
        if (thread.archivedAt !== null) return yield* new ThreadArchived({ threadId, archivedAt: thread.archivedAt });
        const note = new Message({
          id: key,
          threadId,
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
        setPinned: (threadId, messageId, pinned) =>
          Effect.gen(function* () {
            yield* threadOf(threadId);
            return yield* announced(pins.setPinned(threadId, messageId, pinned, yield* now));
          }),
        pins: (threadId) => Effect.andThen(threadOf(threadId), pins.listPins(threadId)),
      });
    }),
  );
}
