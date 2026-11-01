import type { KeyboardEvent } from "react";

/** Enter sends and Shift+Enter adds a line, as in the composer; Enter that ends an IME composition never sends. */
export const enterSends = (submit: () => void) => (event: KeyboardEvent<HTMLTextAreaElement>) => {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  submit();
};
