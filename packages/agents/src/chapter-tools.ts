import {
  ChapterId,
  type ChapterRefusal,
  hobReads,
  MESSAGE_PART_CHARS,
  type Message,
  MessageId,
  READ_MESSAGE_DESCRIPTION,
  READ_MESSAGE_LABEL,
  READ_MESSAGE_TOOL,
  ReadMessageInput,
  readMessageJsonSchema,
  START_CHAPTER_DESCRIPTION,
  START_CHAPTER_LABEL,
  START_CHAPTER_TOOL,
  StartChapterInput,
  startChapterJsonSchema,
} from "@hobbots/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { ChapterService } from "./chapters.ts";
import { ChapterTools, type CharmTurn, hubAnswer } from "./charms.ts";
import { HobbotsRepository } from "./repository.ts";
import type { HubTool, HubToolAnswer, HubTools } from "./runtime.ts";
import { pageParts } from "./web-fetch.ts";

/** Why a Chapter tool call did not run, in words for the hob. */
class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {}

const START_CHAPTER: HubTool = {
  name: START_CHAPTER_TOOL,
  description: START_CHAPTER_DESCRIPTION,
  inputSchema: startChapterJsonSchema(),
  label: START_CHAPTER_LABEL,
};

const READ_MESSAGE: HubTool = {
  name: READ_MESSAGE_TOOL,
  description: READ_MESSAGE_DESCRIPTION,
  inputSchema: readMessageJsonSchema(),
  label: READ_MESSAGE_LABEL,
};

/** What `start_chapter` answers outside a chat turn, as in a Task step's session (#1381). */
export const START_CHAPTER_OUTSIDE_CHAT =
  "start_chapter works only from a chat turn: this session runs a Task's step, outside the conversation. A chapter starts between steps, from the chat, and its open Tasks carry over.";

/** What `read_message` answers for a message it does not find in the hob's own threads. */
export const unknownMessageText = (id: string): string =>
  `There is no message ${id.slice(0, 200)} in your conversations.`;

const REFUSALS: Partial<Record<ChapterRefusal, string>> = {
  "thread-closed": "This conversation is archived, so its chapters stay as they are.",
  "empty-title": "Give the new chapter a title with some text.",
  "live-chapter-empty": "The current chapter has no message yet, so there is nothing to end.",
  moved: "The current chapter moved to a camp, so there is no chapter here to end.",
};

/** The id of the chapter a turn's `start_chapter` makes: one per reply, so a retried call starts none twice. */
export const turnChapterId = (messageId: MessageId): ChapterId => ChapterId.make(`${messageId}:chapter`);

/** Who wrote a message, as `read_message` names them. */
const author = (message: Message) => (message.role === "user" ? "the user" : "you");

/**
 * What the hob is told of a message: part `part` of `content`, and how to read the next. `content` is
 * the message's text already redacted whole, since a secret split across two parts matches nowhere.
 */
export const messageAnswer = (message: Message, content: string, part: number): string => {
  const parts = pageParts(content, MESSAGE_PART_CHARS);
  const where =
    parts.length === 1
      ? null
      : part < parts.length
        ? `Part ${part} of ${parts.length}. Read the next with ${READ_MESSAGE_TOOL}, the same message_id and part ${part + 1}.`
        : `Part ${part} of ${parts.length}, the last.`;
  const head = `Message ${message.id}, written by ${author(message)} at ${message.createdAt}.`;
  return [head, ...(where === null ? [] : [where]), "", (parts[part - 1] ?? "").trim() || "(no text)"].join("\n");
};

const decodeStart = Schema.decodeUnknownEffect(StartChapterInput);
const decodeRead = Schema.decodeUnknownEffect(ReadMessageInput);

/**
 * The Chapter tools' layer (ADR 037, #1381): `start_chapter` runs through `ChapterService`, and
 * `read_message` reads only messages of the hob's own threads.
 */
export const ChapterToolsLive = Layer.effect(
  ChapterTools,
  Effect.gen(function* () {
    const chapters = yield* ChapterService;
    const repo = yield* HobbotsRepository;
    // A runtime runs each call on its own, so it carries the hub's services, its logger included.
    const context = yield* Effect.context<never>();

    const startChapter = (turn: CharmTurn, raw: unknown) =>
      Effect.gen(function* () {
        if (turn.threadId === null || turn.messageId === null) {
          return yield* new Refused({ message: START_CHAPTER_OUTSIDE_CHAT });
        }
        const threadId = turn.threadId;
        const input = yield* decodeStart(raw).pipe(
          Effect.mapError(() => new Refused({ message: "Give the new chapter's topic as `title`." })),
        );
        const id = turnChapterId(turn.messageId);
        const plan = yield* chapters.startChapter(threadId, { id, title: input.title }).pipe(
          Effect.catchTags({
            ChapterRefused: (refused) =>
              Effect.fail(new Refused({ message: REFUSALS[refused.reason] ?? "The chapter could not start." })),
            ThreadNotFound: () => Effect.fail(new Refused({ message: "This conversation is gone." })),
            ChapterNotFound: () => Effect.fail(new Refused({ message: "The chapter could not start." })),
            IllegalChapterTransition: () => Effect.fail(new Refused({ message: "The chapter could not start." })),
          }),
        );
        const started = plan.chapters.find((chapter) => chapter.id === id);
        const named = `chapter ${started?.number ?? plan.chapters.length}, “${started?.title ?? input.title}”`;
        return {
          text:
            plan.changed.length === 0
              ? `This turn already started ${named}. Your next turn starts it in a fresh session.`
              : `Started ${named}. Your next turn starts it in a fresh session, from this conversation's records.`,
          refused: false,
        } satisfies HubToolAnswer;
      });

    const readMessage = (turn: CharmTurn, raw: unknown) =>
      Effect.gen(function* () {
        const input = yield* decodeRead(raw).pipe(
          Effect.mapError(
            () =>
              new Refused({
                message: "Give the message's id as `message_id`, and a part number from 1 as `part` if you want one.",
              }),
          ),
        );
        const found = yield* repo.findMessage(MessageId.make(input.message_id));
        const thread = Option.isNone(found) ? Option.none() : yield* repo.findThread(found.value.threadId);
        // Another hob's message, and a note to self, which only you read (ADR 037), read as one that
        // does not exist, so its id says nothing.
        if (
          Option.isNone(found) ||
          !hobReads(found.value) ||
          Option.isNone(thread) ||
          thread.value.agentId !== turn.agentId
        ) {
          return yield* new Refused({ message: unknownMessageText(input.message_id) });
        }
        const part = input.part ?? 1;
        // Redacted whole before it is cut into parts, so no part holds a piece of a secret.
        const content = turn.redactor.text(found.value.content);
        const parts = pageParts(content, MESSAGE_PART_CHARS).length;
        if (part > parts) {
          return yield* new Refused({
            message: `Message ${input.message_id} has ${parts === 1 ? "1 part" : `${parts} parts`}, so there is no part ${part}.`,
          });
        }
        return { text: messageAnswer(found.value, content, part), refused: false } satisfies HubToolAnswer;
      });

    const forTurn = (turn: CharmTurn): Effect.Effect<HubTools | null> =>
      Effect.map(turn.currentAccess, (access) =>
        access === null
          ? null
          : {
              tools: [START_CHAPTER, READ_MESSAGE],
              call: (name, input) =>
                hubAnswer(
                  turn.redactor,
                  name === START_CHAPTER_TOOL
                    ? startChapter(turn, input)
                    : name === READ_MESSAGE_TOOL
                      ? readMessage(turn, input)
                      : Effect.fail(new Refused({ message: `${name} is not one of the Chapter tools.` })),
                ).pipe(Effect.provideContext(context)),
            },
      );

    return ChapterTools.of({ forTurn });
  }),
);
