import type { Question, QuestionSurface } from "@hobbots/domain";
import { messages } from "./messages.ts";

const copy = messages.question;

/**
 * Your answer to `question`, saying where you gave it as seen from `here` (#671): "You answered in
 * the Inbox: light", or "You answered here" on the same surface. An answer from before this was
 * recorded, or from a client that did not say, just says you answered. A choice you clicked says
 * you picked it. Null when you did not answer.
 */
export const yourAnswer = (question: Question, here: QuestionSurface): string | null => {
  if (question.answer === null || question.answeredBy?._tag !== "User") return null;
  // A choice you clicked says you picked it (#740).
  const picked = question.picked !== null;
  const via = question.answeredVia;
  if (via === null) return (picked ? copy.youPicked : copy.youAnswered)({ answer: question.answer });
  return (picked ? copy.youPickedIn : copy.youAnsweredIn)[via === here ? "here" : via]({ answer: question.answer });
};
