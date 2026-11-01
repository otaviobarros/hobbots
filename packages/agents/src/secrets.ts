import { type KnownSecret, redactSecrets, redactSecretsIn } from "@hobbots/domain";
import { Context, Layer } from "effect";
import type { RuntimeEvent } from "./runtime.ts";

/**
 * Redacts secrets from tool input and output before Hobbots journals, stores or shows them (see the
 * permissions contract). It knows the hub's credentials by value and recognizes common secret
 * shapes in anything else.
 */
export interface Redactor {
  readonly text: (text: string) => string;
  /** Every string inside `value`, at any depth. */
  readonly value: <A>(value: A) => A;
  /**
   * Adds a value the turn's tools can see, such as the sign-in an adapter puts in their
   * environment, so it is redacted from then on.
   */
  readonly remember: (secret: KnownSecret) => void;
}

/** A redactor that knows `initial` and whatever is remembered later. */
export const makeRedactor = (initial: ReadonlyArray<KnownSecret> = []): Redactor => {
  // By value, so a token remembered at every turn is kept once.
  const known = new Map(initial.map((secret) => [secret.value, secret]));
  return {
    text: (text) => redactSecrets(text, [...known.values()]),
    value: (value) => redactSecretsIn(value, [...known.values()]),
    remember: (secret) => {
      if (!known.has(secret.value)) known.set(secret.value, secret);
    },
  };
};

/** The hub's redactor. Without it, use cases still redact secret shapes, but know no values. */
export class SecretRedaction extends Context.Service<SecretRedaction, Redactor>()("@hobbots/agents/SecretRedaction") {
  /** Knows `secrets`, such as the credentials in the hub's environment, from the start. */
  static readonly layer = (secrets: ReadonlyArray<KnownSecret>) =>
    Layer.sync(SecretRedaction, () => makeRedactor(secrets));
}

/** A runtime event with secrets redacted from what it says about a tool call. The reply's text is left as it is. */
export const redactEvent = (event: RuntimeEvent, redactor: Redactor): RuntimeEvent => {
  switch (event._tag) {
    case "StepStarted":
      return { ...event, label: redactor.text(event.label) };
    case "ToolStarted":
    case "ToolAwaitingApproval":
      return { ...event, label: redactor.text(event.label), targets: redactor.value(event.targets) };
    case "ToolDenied":
      return {
        ...event,
        label: redactor.text(event.label),
        targets: redactor.value(event.targets),
        reason: redactor.text(event.reason),
      };
    default:
      return event;
  }
};
