import {
  type Message,
  type MessageId,
  PASS_DESCRIPTION,
  PASS_LABEL,
  PASS_TOOL,
  PassInput,
  type PolicyOperation,
  passJsonSchema,
  type ReplyStep,
  type TurnRequest,
  TurnRequests,
} from "@hobbots/domain";
import { Effect, Ref, Schema } from "effect";
import { hubAnswer } from "./charms.ts";
import type { HubTool, HubToolAnswer, HubTools } from "./runtime.ts";
import type { Redactor } from "./secrets.ts";
import type { Reply } from "./thread-run.ts";

/**
 * The `pass` tool (ADR 039, One hob speaks at a time): a hob asked to answer that has nothing to add
 * ends its turn with no message and a reason. It is offered in every chat turn, on every runtime, so
 * a session that keeps the tools it started with, as Codex does, always holds it. The call only marks
 * the turn passed; the turn's end passes its requests and removes its reply (`passTurnRequests`).
 */
export const PASS: HubTool = {
  name: PASS_TOOL,
  description: PASS_DESCRIPTION,
  inputSchema: passJsonSchema(),
  label: PASS_LABEL,
};

/** Who offers `pass`, as a hub tool's owner is named. */
export const PASS_OWNER = "the Turn tools";

/** Why a `pass` call did not run, in words for the hob. */
class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {}

export const PASS_UNREADABLE = "Give why you pass as `reason`, in a few words, such as “Quill covered it”.";
export const PASS_AFTER_TEXT = "You already wrote part of a reply in this turn, so finish it instead of passing.";
export const PASS_AFTER_WORK =
  "You already changed something or asked for an approval in this turn, so answer with what you did instead of passing.";
export const PASS_NOT_ASKED = "Nobody is waiting for your answer in this turn, so there is nothing to pass.";
export const PASS_ONLY_HOB = "You are the only hob here, so answer: nobody else will.";
export const PASS_TAKEN =
  "You passed. End your turn now without writing anything more: this turn leaves no message, and the conversation shows that you passed and why.";

/** What a turn may have read before it passes: its record goes with the reply, and nothing is lost. */
const READS: ReadonlySet<PolicyOperation> = new Set([
  "read-files",
  "search-memory",
  "search-skills",
  "read-hobs",
  "search-web",
  "use-web",
]);

/**
 * Whether a step of the turn leaves nothing behind once its reply is removed: a thought, a hub tool
 * call no policy decides, as `pass` itself, whose records live apart from the reply, or a read. A step
 * an approval or a proposal names stays with its reply, and so does any other runtime tool call.
 */
const leavesNothing = (step: ReplyStep): boolean =>
  step.kind === "thinking" ||
  (step.approvalId === undefined &&
    step.proposalId === undefined &&
    (step.call === undefined || READS.has(step.call.operation as PolicyOperation)));

/**
 * Whether a turn that passed still leaves no message once it ends: it did nothing after the call
 * that a removed reply would hide. Text it wrote after passing goes with the reply.
 */
export const passStands = (reply: Message, stepsFrom: number): boolean =>
  reply.steps.slice(stepsFrom).every(leavesNothing);

/**
 * Why the turn writing `reply` may not pass, or null when it may: it wrote text, it did something a
 * removed reply would hide, or none of the requests it speaks for was asked of it by someone else.
 */
export const passRefusal = (reply: Message, stepsFrom: number, requests: ReadonlyArray<TurnRequest>): string | null => {
  if (reply.content.trim() !== "") return PASS_AFTER_TEXT;
  if (!passStands(reply, stepsFrom)) return PASS_AFTER_WORK;
  const speaking = requests.filter(TurnRequests.isSpeaking);
  if (speaking.length === 0) return PASS_NOT_ASKED;
  if (speaking.every((request) => request.cause === "only-hob")) return PASS_ONLY_HOB;
  return null;
};

const decodePass = Schema.decodeUnknownEffect(PassInput);

/** The `pass` tool for the chat turn writing `reply`; every answer is redacted with the turn's redactor. */
export const passTools = (
  reply: Reply,
  requestsOf: (replyId: MessageId) => Effect.Effect<ReadonlyArray<TurnRequest>>,
  redactor: Redactor,
): HubTools => {
  const pass = (raw: unknown) =>
    Effect.gen(function* () {
      const input = yield* decodePass(raw).pipe(Effect.mapError(() => new Refused({ message: PASS_UNREADABLE })));
      const reason = input.reason.trim();
      if (reason === "") return yield* new Refused({ message: PASS_UNREADABLE });
      const current = yield* Ref.get(reply.current);
      const refusal = passRefusal(current, reply.stepsFrom, yield* requestsOf(current.id));
      if (refusal !== null) return yield* new Refused({ message: refusal });
      // What the hob gave is kept as the conversation shows it, without a secret it may quote.
      yield* Ref.set(reply.passed, redactor.text(reason));
      return { text: PASS_TAKEN, refused: false } satisfies HubToolAnswer;
    });
  return {
    tools: [PASS],
    call: (name, input) =>
      hubAnswer(
        redactor,
        name === PASS_TOOL
          ? pass(input)
          : Effect.fail(new Refused({ message: `${name} is not one of the Turn tools.` })),
      ),
  };
};
