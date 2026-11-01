import type { Brain, Effort, Message, RuntimeKind, RuntimeModels } from "@hobbots/domain";

/** A brain's runtime and model, as a reply records them. */
export type ReplyBrain = { readonly runtime: RuntimeKind; readonly model: string | null };

/** The model's own name, or the runtime's word for its default model when it is left to the runtime. */
export const modelName = (models: RuntimeModels | undefined, model: string | null): string | null =>
  model === null ? null : (models?.models.find((m) => m.id === model)?.displayName ?? model);

/**
 * The replies whose brain differs from the reply before them (ADR 017): where the chat shows that
 * the hob now thinks with another brain. Replies from before brains were recorded show none.
 */
export const brainSwitches = (transcript: ReadonlyArray<Message>): ReadonlySet<string> => {
  const switches = new Set<string>();
  let last: ReplyBrain | null = null;
  for (const message of transcript) {
    if (message.role !== "assistant" || message.runtime === null) continue;
    if (last !== null && (last.runtime !== message.runtime || last.model !== message.model)) switches.add(message.id);
    last = { runtime: message.runtime, model: message.model };
  }
  return switches;
};

/** The brain of the thread's latest reply, if it recorded one. */
export const lastReplyBrain = (transcript: ReadonlyArray<Message>): ReplyBrain | null => {
  const last = transcript.findLast((m) => m.role === "assistant" && m.runtime !== null);
  return last?.runtime == null ? null : { runtime: last.runtime, model: last.model };
};

/**
 * The brain a pick makes: the runtime and model picked, keeping the hob's effort when the model takes
 * it, otherwise the model's default.
 */
export const pickedBrain = (
  models: RuntimeModels | undefined,
  runtime: RuntimeKind,
  model: string | null,
  hobEffort: Effort | null,
): Brain => {
  const efforts = models?.models.find((m) => m.id === (model ?? "default"))?.efforts ?? [];
  return { runtime, model, effort: hobEffort !== null && efforts.includes(hobEffort) ? hobEffort : null };
};
