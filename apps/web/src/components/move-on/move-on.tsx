import { Toast, ToastDescription } from "@hobbots/ui/components/toast";
import { createContext, type ReactNode, useContext, useState } from "react";
import { type FocusTargets, followFocus } from "./follow-focus.ts";

/** What a decision sent from a card asks for: where focus goes after it, and what to say once it is sent. */
interface MoveOnStep {
  /** The card or form the decision was made in, which may leave once it is sent; `null` before it shows. */
  readonly from: HTMLElement | null;
  readonly targets: FocusTargets;
  /** The send, which says the decision went once it resolves. */
  readonly sent: Promise<unknown>;
  /** What the toast says once it is sent; with none, the card says it itself. */
  readonly say?: string | undefined;
}

type MoveOn = (step: MoveOnStep) => void;

/** Follows focus from `from` while `sent` is on its way; a failed send is the card's to show. */
const follow = (from: HTMLElement | null, targets: FocusTargets, sent: Promise<unknown>) => {
  sent.catch(() => undefined);
  if (from !== null) followFocus(from, targets, sent);
};

/** Without the provider, as in a test that renders one card, focus is still followed and nothing is said. */
const followOnly: MoveOn = ({ from, targets, sent }) => follow(from, targets, sent);

const MoveOnContext = createContext<MoveOn>(followOnly);

/**
 * Moving on after a decision sent from a card that then leaves (#988, #995): focus goes to what
 * waits next, or to a fallback, never to the page, and a toast says the decision went. The toast
 * lives outside the card, so it shows whether the hub's event or its answer lands first.
 */
export const useMoveOn = (): MoveOn => useContext(MoveOnContext);

/**
 * The toast for moving on, for every page after setup. It sits inside the app shell's toast
 * provider, the one the archive Undo uses, and shows in the viewport the page holds.
 */
export function MoveOnProvider({ children }: { children: ReactNode }) {
  const [said, setSaid] = useState<{ readonly id: number; readonly text: string } | null>(null);
  const moveOn: MoveOn = ({ from, targets, sent, say }) => {
    follow(from, targets, sent);
    if (say === undefined) return;
    sent.then(
      () => setSaid((old) => ({ id: (old?.id ?? 0) + 1, text: say })),
      () => undefined,
    );
  };
  return (
    <MoveOnContext.Provider value={moveOn}>
      {children}
      {said && (
        <Toast
          key={said.id}
          onOpenChange={(open) => {
            if (!open) setSaid(null);
          }}
        >
          <ToastDescription>{said.text}</ToastDescription>
        </Toast>
      )}
    </MoveOnContext.Provider>
  );
}
