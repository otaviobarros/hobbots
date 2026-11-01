import { ToolLogNotFound } from "@hobbots/api";
import { previewToolOutput, type ToolOutput } from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { ToolLogKey, ToolLogs } from "./ports.ts";
import type { HobbotsRepository } from "./repository.ts";

/**
 * What a tool step keeps of `text`, which is already redacted: all of it when it is short, else its
 * start and end, with the whole of it kept as the step's log. A log that cannot be written leaves
 * the step with its start and end only.
 */
export const keepToolOutput = (
  text: string,
  key: ToolLogKey,
  logs: Option.Option<ToolLogs["Service"]>,
): Effect.Effect<ToolOutput> =>
  Effect.gen(function* () {
    const preview = previewToolOutput(text);
    if (preview.omittedBytes === 0 || Option.isNone(logs)) return { ...preview, logged: false };
    const logged = yield* logs.value.write(key, text).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning(`Could not keep a tool step's full log: ${error.message}`).pipe(Effect.as(false)),
      ),
    );
    return { ...preview, logged };
  });

/**
 * The full log of a tool step whose output the step shows cut. Only a step the thread's reply says
 * was logged is read, so a request never reaches a file Hobbots did not keep for that step.
 */
export const readToolLog = (
  key: ToolLogKey,
  repo: HobbotsRepository["Service"],
  logs: Option.Option<ToolLogs["Service"]>,
): Effect.Effect<string, ToolLogNotFound> =>
  Effect.gen(function* () {
    const missing = new ToolLogNotFound({ messageId: key.messageId, stepId: key.stepId });
    const messages = yield* repo.listMessages(key.threadId);
    const step = messages
      .find((message) => message.id === key.messageId)
      ?.steps.find((candidate) => candidate.id === key.stepId);
    if (step?.output?.logged !== true || Option.isNone(logs)) return yield* Effect.fail(missing);
    const text = yield* logs.value.read(key);
    return yield* Option.match(text, { onNone: () => Effect.fail(missing), onSome: Effect.succeed });
  });
