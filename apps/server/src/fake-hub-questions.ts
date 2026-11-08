import { HubQuestions } from "@hobbots/agents";
import { Effect, Layer } from "effect";

const KIND = "fake-check";

/**
 * Questions the hub puts to you itself (#976), for trying them and for browser tests: at start the
 * hub asks two, one with choices and one without, and applying an answer asks a third that repeats
 * what it applied. Each is codes and data, which the web app words (#1045). Raising a question that
 * is still open returns the open one, so a restart adds none. Only `HOBBOTS_FAKE_HUB_QUESTIONS=on`
 * with the fake runtime turns it on.
 */
export const FakeHubQuestionsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const questions = yield* HubQuestions;
    yield* questions.handle({
      kind: KIND,
      apply: (question) =>
        question.ask.kind !== KIND || question.ask.check === "applied"
          ? Effect.void
          : questions
              .raise({
                key: "applied",
                ask: {
                  kind: KIND,
                  check: "applied",
                  applied: {
                    picked: question.picked === "nightly" || question.picked === "weekly" ? question.picked : null,
                    answer: question.answer,
                  },
                },
              })
              .pipe(Effect.asVoid),
    });
    yield* questions.raise({
      key: "backups",
      ask: { kind: KIND, check: "backups", applied: null },
      options: ["nightly", "weekly"],
      recommended: "nightly",
    });
    yield* questions.raise({ key: "hub-name", ask: { kind: KIND, check: "hub-name", applied: null } });
  }),
);
