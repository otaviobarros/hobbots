import { replay } from "./motion.ts";

/** The Allow once / Deny demo on the "Nothing risky without you" card. */
export const initApproval = () => {
  const root = document.querySelector<HTMLElement>("[data-approval]");
  if (!root) return;
  const find = <T extends Element>(selector: string) => root.querySelector<T>(selector);
  const open = find<HTMLElement>("[data-approval-open]");
  const label = find<HTMLElement>("[data-approval-label]");
  const reset = find<HTMLButtonElement>("[data-approval-reset]");
  const sparks = find<HTMLElement>("[data-approval-sparks]");
  const hop = find<HTMLElement>("[data-approval-hop]");
  const allow = find<HTMLButtonElement>("[data-allow]");
  if (!open || !label || !reset || !sparks || !hop || !allow) return;

  const answer = (allowed: boolean) => {
    open.hidden = true;
    label.hidden = false;
    reset.hidden = false;
    label.textContent = allowed ? "Allowed once" : "Denied";
    label.style.setProperty("--fg", allowed ? "var(--color-mint)" : "var(--color-rose)");
    sparks.hidden = !allowed;
    if (allowed) replay(hop, "fx-hop");
    else replay(root, "fx-shake");
    reset.focus();
  };

  allow.addEventListener("click", () => answer(true));
  find("[data-deny]")?.addEventListener("click", () => answer(false));
  reset.addEventListener("click", () => {
    open.hidden = false;
    label.hidden = true;
    reset.hidden = true;
    sparks.hidden = true;
    allow.focus();
  });
};
