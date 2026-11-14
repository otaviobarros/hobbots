import type { AgentId, Message, ThreadId } from "@hobbots/domain";
import { Fragment, type ReactNode } from "react";
import { operationLabel } from "../../lib/reply-steps.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { type HobLookup, useHobLookup, useThreadTrees } from "../quest/use-work.ts";
import { messages } from "./messages.ts";
import { type ReceiptHop, type SteerReceipt, steerReceiptOf } from "./steer-model.ts";

/** How each step reads: the lead reading or done, then each hop by where its note stands. */
const TONE: Record<ReceiptHop["state"] | "reading" | "read", string> = {
  reading: "text-text-secondary",
  read: "",
  passing: "text-text-secondary",
  held: "text-lantern",
  picked: "font-semibold text-mint",
  unread: "text-label",
  sent: "text-text-secondary",
  waiting: "text-text-secondary",
  interrupting: "text-lantern",
};

const actionOf = (hop: ReceiptHop) => (hop.approval === null ? "" : operationLabel(hop.approval.operation));

/** What a hop says, beside its hob's sprite. */
const hopText = (hop: ReceiptHop, name: string): string => {
  if (hop.state === "picked") {
    return hop.passedOn.length > 0 ? messages.hop.pickedPassing({ name }) : messages.hop.picked({ name });
  }
  if (hop.state === "held") return messages.hop.held({ name, action: actionOf(hop) });
  return messages.hop[hop.state]({ name });
};

/** The sentence a screen reader hears for a hop, which `from` passed the note to. */
const hopSentence = (hop: ReceiptHop, name: string, from: string): string => {
  if (hop.state === "passing") return messages.say.passing({ from, name });
  if (hop.state === "held") return messages.say.held({ name, action: actionOf(hop) });
  return messages.say[hop.state]({ name });
};

/** Each step as a whole sentence, keyed by where it sits, so a screen reader hears each step once. */
const sentences = (receipt: SteerReceipt, hobs: HobLookup): ReadonlyArray<{ key: string; text: string }> => {
  const lead = hobs(receipt.lead).name;
  // A message sent straight to the members it mentions never went through the lead (#1446).
  const out = receipt.direct
    ? []
    : [{ key: "lead", text: receipt.read ? messages.say.gotIt({ name: lead }) : messages.say.reading({ name: lead }) }];
  const walk = (hops: ReadonlyArray<ReceiptHop>, from: string, path: string) => {
    for (const [index, hop] of hops.entries()) {
      const name = hobs(hop.hob).name;
      const key = `${path}.${index}`;
      out.push({ key, text: hopSentence(hop, name, from) });
      walk(hop.passedOn, name, key);
    }
  };
  walk(receipt.hops, lead, "hop");
  return out;
};

function Step({
  hob,
  hobs,
  tone,
  children,
}: {
  hob: AgentId;
  hobs: HobLookup;
  tone: keyof typeof TONE;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <HobSprite hob={hobs(hob)} size={16} />
      <span className={TONE[tone]}>{children}</span>
    </span>
  );
}

function Hops({ hops, hobs }: { hops: ReadonlyArray<ReceiptHop>; hobs: HobLookup }) {
  return hops.map((hop, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: STD-REACT-020 a hob can get the same note twice, so its place is its key.
    <Fragment key={`${hop.hob}-${index}`}>
      <Step hob={hop.hob} hobs={hobs} tone={hop.state}>
        {hopText(hop, hobs(hop.hob).name)}
      </Step>
      {hop.state === "picked" && <Hops hops={hop.passedOn} hobs={hobs} />}
    </Fragment>
  ));
}

/**
 * The steer receipt under a message you sent while work ran (ADR 027): the lead reading it, then
 * whom it passed it to and whether each picked it up, with the hobs' sprites, as the hub records
 * each step. The steps are drawn for the eye; a polite live region says each one once.
 */
function SteerReceiptLine({ receipt, hobs }: { receipt: SteerReceipt; hobs: HobLookup }) {
  const lead = hobs(receipt.lead).name;
  const leadText = !receipt.read
    ? messages.lead.reading({ name: lead })
    : receipt.hops.length > 0
      ? messages.lead.gotItPassing({ name: lead })
      : messages.lead.gotIt({ name: lead });
  return (
    <section
      aria-label={messages.label}
      className="flex max-w-bubble-max flex-wrap items-center justify-end gap-x-2 gap-y-1 self-end text-detail text-label"
    >
      <span aria-hidden className="contents">
        {!receipt.direct && (
          <Step hob={receipt.lead} hobs={hobs} tone={receipt.read ? "read" : "reading"}>
            {leadText}
          </Step>
        )}
        <Hops hops={receipt.hops} hobs={hobs} />
      </span>
      {/* A status is atomic by default and would read every step again; each sentence is its own node, so only the step that changed is read. */}
      <span role="status" aria-atomic={false} className="sr-only">
        {sentences(receipt, hobs).map((each) => (
          <span key={each.key}>{each.text} </span>
        ))}
      </span>
    </section>
  );
}

/**
 * Steer receipts for a thread's transcript: `of(message)` is the receipt under that message, or
 * null. It reads the thread's Task trees, which stay live through the journal's events.
 */
export const useSteerReceipts = (lead: AgentId, threadId: ThreadId | undefined, transcript: ReadonlyArray<Message>) => {
  const trees = useThreadTrees(threadId);
  const hobs = useHobLookup();
  return {
    of: (message: Message) => {
      const receipt = steerReceiptOf(message, transcript, trees, lead);
      return receipt === null ? null : <SteerReceiptLine receipt={receipt} hobs={hobs} />;
    },
  };
};
