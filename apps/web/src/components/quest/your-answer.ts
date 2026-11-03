import type { Question, QuestionSurface } from "@hobbots/domain";
import { messages } from "./messages.ts";

const copy = messages.question;

/**
 * Your answer to `question`, saying where you gave it as seen from `here` (#671): "You answered in
 * the Inbox: light", or "You answered here" on the same surface. An answer from before this was
 * recorded, or from a client that did not say, just says you answered. Null when you did not answer.
 */
export const yourAnswer = (question: Question, here: QuestionSurface): string | null => {
  if (question.answer === null || question.answeredBy?._tag !== "User") return null;
  const via = question.answeredVia;
  if (via === null) return copy.youAnswered({ answer: question.answer });
  return copy.youAnsweredIn[via === here ? "here" : via]({ answer: question.answer });
};
