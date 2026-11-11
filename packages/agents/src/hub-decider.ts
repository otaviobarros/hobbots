import type { HubTask } from "@hobbots/domain";
import { Context, Effect, Layer, Option, Schema } from "effect";

/**
 * The hub's judgments (ADR 037, The hub's brain). A projector asks `HubDecider` a question with a
 * schema of the choices it accepts and its own rule's answer. The hub's brain answers with a choice
 * and a confidence, decoded by `Schema`; with No AI, or an answer that does not decode, the rule
 * stands. Only projectors call it, never a command in its request path (STD-ARCH-014, STD-ARCH-016).
 */

/** One judgment the hub asks its brain for. */
export interface Judgment<A> {
  /** Which of the brain's tasks this is, so a model chosen for it in Settings is the one asked. */
  readonly task: HubTask;
  /** What to judge, in plain words: the turn's instructions. */
  readonly question: string;
  /** What to judge it on, such as a chapter's lines or two quests' goals. */
  readonly input: string;
  /** The choices the caller accepts. An answer outside them falls back to `rule`. */
  readonly choices: Schema.Decoder<A>;
  /** The caller's own rule's answer, which stands whenever the brain's does not. */
  readonly rule: A;
}

/** Who answered a judgment: the hub's brain, or the caller's rule. */
export const DecidedBy = Schema.Literals(["brain", "rule"]);
export type DecidedBy = typeof DecidedBy.Type;

/** A judgment's answer: the choice, how sure its maker is from 0 to 1, and who made it. */
export interface Decided<A> {
  readonly choice: A;
  readonly confidence: number;
  readonly by: DecidedBy;
}

/** The rule's own answer, which is as sure as a rule is. */
export const byRule = <A>(judgment: Judgment<A>): Decided<A> => ({ choice: judgment.rule, confidence: 1, by: "rule" });

/** What a judgment's turn tells the brain: the question and the answer's shape, and the input. */
export interface JudgmentText {
  readonly instructions: string;
  readonly prompt: string;
}

// Finite, so its JSON Schema is a plain number from 0 to 1, not one that may also be "NaN" or "Infinity".
const Confidence = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** The answer's shape, as the brain is told it and as its reply is decoded. */
const answerSchema = <A>(choices: Schema.Decoder<A>) => Schema.Struct({ choice: choices, confidence: Confidence });

/**
 * The turn's text. The question, the input and the answer's shape all go in the prompt itself:
 * a runtime adds the instructions to a long system prompt of its own, where a small model at low
 * effort can lose them and answer the input instead (seen with Claude Code's smallest model).
 */
export const judgmentText = <A>(judgment: Judgment<A>): JudgmentText => {
  const document = Schema.toJsonSchemaDocument(answerSchema(judgment.choices));
  const definitions = Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {};
  return {
    instructions: "You make one judgment for the Hobbots hub. Reply with one JSON object and nothing else.",
    prompt: [
      judgment.question,
      `<input>\n${judgment.input}\n</input>`,
      "Answer the question about the input with one JSON object and nothing else, matching this JSON Schema. `confidence` is how sure you are, from 0 to 1.",
      JSON.stringify({ ...document.schema, ...definitions }),
    ].join("\n\n"),
  };
};

/**
 * The brain's reply decoded as an answer in the judgment's shape, or none. A reply may wrap its
 * JSON in a code fence or a sentence, so the outermost object in it is what is decoded.
 */
export const decodeJudgment = <A>(
  judgment: Judgment<A>,
  reply: string,
): Option.Option<{ readonly choice: A; readonly confidence: number }> => {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end < start) return Option.none();
  return Schema.decodeUnknownOption(Schema.fromJsonString(answerSchema(judgment.choices)))(reply.slice(start, end + 1));
};

export interface HubDeciderShape {
  /** The brain's answer when it gives one that decodes, else the rule's. It never fails. */
  readonly decide: <A>(judgment: Judgment<A>) => Effect.Effect<Decided<A>>;
}

export class HubDecider extends Context.Service<HubDecider, HubDeciderShape>()("@hobbots/agents/HubDecider") {
  /** A hub with no brain, as with No AI: every judgment is its rule's, and no model is called. */
  static readonly rules = Layer.succeed(HubDecider, { decide: (judgment) => Effect.succeed(byRule(judgment)) });
}
