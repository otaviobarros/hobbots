import { ReplyThreads } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// Reply threads (ADR 039, #1484), for user sessions only (PE-006). A hub built without them, as in
// some tests, takes no replies in a thread.
export const ThreadsHandlers = HttpApiBuilder.group(HobbotsApi, "threads", (handlers) =>
  Effect.gen(function* () {
    const threads = Option.getOrElse(yield* Effect.serviceOption(ReplyThreads), () =>
      ReplyThreads.of({ reply: () => Effect.die(new Error("This hub takes no replies in a thread.")) }),
    );
    return handlers.handleAll({
      replyInThread: ({ params, payload }) =>
        threads.reply(params.channelId, params.messageId, {
          key: payload.key,
          content: payload.content,
          alsoInMainLine: payload.alsoInMainLine,
        }),
    });
  }),
);
