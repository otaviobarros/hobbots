import { HubQuestions } from "@hobbots/agents";
import { Effect, Layer } from "effect";

const KIND = "fake-check";

/**
 * Questions the hub puts to you itself (#976), for trying them and for browser tests: at start the
 * hub asks two, one with choices and one without, and applying an answer asks a third that repeats
 * what it applied. Raising a subject that is still open returns the open question, so a restart adds
 * none. Only `HOBBOTS_FAKE_HUB_QUESTIONS=on` with the fake runtime turns it on.
 */
export const FakeHubQuestionsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const questions = yield* HubQuestions;
    yield* questions.handle({
      kind: KIND,
      apply: (question) =>
        question.subject.key === "applied"
          ? Effect.void
          : questions
              .raise({
                subject: { kind: KIND, key: "applied", title: "What the hub applied" },
                text: `The hub applied: ${question.answer ?? ""}`,
              })
              .pipe(Effect.asVoid),
    });
    yield* questions.raise({
      subject: { kind: KIND, key: "backups", title: "Nightly backups" },
      text: "How often should the hub back up your data?",
      options: [
        { label: "Every night", consequence: "A backup each night, kept for a week." },
        { label: "Every week", consequence: "A backup each Sunday, kept for a month." },
      ],
      recommended: 0,
    });
    yield* questions.raise({
      subject: { kind: KIND, key: "hub-name", title: "The hub's name" },
      text: "What should this hub be called on your other devices?",
    });
  }),
);
