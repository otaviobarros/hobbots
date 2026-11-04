import { useEffect, useEffectEvent } from "react";
import { isPageKey, type KeyPress } from "../../lib/page-keys.ts";

/** What a key does to the request shown: A allows it once, D opens Deny. */
export type DecideKey = "allow" | "deny";

const KEYS: Readonly<Record<string, DecideKey>> = { a: "allow", A: "allow", d: "deny", D: "deny" };

/** The decision a press means, or `undefined` when it is not A or D or belongs elsewhere. */
export const decideKey = (press: KeyPress): DecideKey | undefined => {
  const key = KEYS[press.key];
  return key !== undefined && isPageKey(press) ? key : undefined;
};

/** While `on`, A and D pressed anywhere on the page act on this request. */
export const useDecideKeys = (on: boolean | undefined, act: (key: DecideKey) => void) => {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const key = decideKey(event);
    if (key === undefined) return;
    event.preventDefault();
    act(key);
  });
  useEffect(() => {
    if (on !== true) return;
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [on]);
};
