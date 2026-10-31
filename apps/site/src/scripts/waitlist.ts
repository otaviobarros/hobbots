import { getMine } from "./mine.ts";
import { replay } from "./motion.ts";
import { notes } from "./sound.ts";

/**
 * The two wait-list forms share one email. This step checks the address and shows the success state
 * of the design; saving the sign-up comes with the wait-list action (#185).
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const problem = (email: string) => {
  if (!email) return "Type your email address first.";
  if (!EMAIL.test(email)) return "That email looks incomplete. Check for an @ and a domain, like you@example.com.";
  return "";
};

export const initWaitlist = () => {
  const forms = [...document.querySelectorAll<HTMLFormElement>("[data-join-form]")];
  const inputs = forms.flatMap((form) => [...form.querySelectorAll<HTMLInputElement>("[data-email]")]);
  const joined = [...document.querySelectorAll<HTMLElement>("[data-joined]")];
  const joinedBody = document.querySelector<HTMLElement>("[data-joined-body]");
  const more = document.querySelector<HTMLInputElement>("[data-more]");
  const sign = document.querySelector<HTMLElement>("[data-sign]");
  const signPost = document.querySelector<HTMLElement>("[data-sign-post]");
  const signText = document.querySelector<HTMLElement>("[data-sign-text]");
  let focused = false;
  let failed = false;

  const showSign = () => {
    if (!signText) return;
    const email = inputs[0]?.value.trim() ?? "";
    signText.textContent = failed
      ? "Check that one!"
      : EMAIL.test(email)
        ? "Looks right!"
        : focused
          ? "Type away!"
          : "Save my spot!";
  };

  const clearErrors = () => {
    failed = false;
    for (const error of document.querySelectorAll("[data-error]")) error.textContent = "";
    for (const input of inputs) input.removeAttribute("aria-invalid");
  };

  for (const input of inputs) {
    input.addEventListener("input", () => {
      for (const other of inputs) if (other !== input) other.value = input.value;
      clearErrors();
      showSign();
    });
    input.addEventListener("focus", () => {
      focused = true;
      showSign();
    });
    input.addEventListener("blur", () => {
      focused = false;
      showSign();
    });
  }

  const join = (form: HTMLFormElement, email: string) => {
    for (const form of forms) form.hidden = true;
    for (const element of joined) element.hidden = false;
    if (sign) sign.hidden = true;
    if (joinedBody) {
      const also = more?.checked ? ", and again when the Windows and phone apps are ready" : "";
      joinedBody.textContent = `${getMine().name} will keep your spot. We'll write to ${email} when the lantern is lit${also}.`;
    }
    const sprite = document.querySelector(".joined-sprite");
    if (sprite) replay(sprite, "fx-hop");
    notes([523, 659, 784, 1047], 0.08);
    // The focused button is gone, so focus moves to the confirmation beside the form used.
    form.closest("[data-waitlist]")?.querySelector<HTMLElement>("[data-joined-focus]")?.focus();
  };

  for (const form of forms) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = form.querySelector<HTMLInputElement>("[data-email]");
      const email = input?.value.trim() ?? "";
      const message = problem(email);
      if (message) {
        const error = form.querySelector("[data-error]");
        if (error) {
          // Clearing first makes a repeated message announce again.
          error.textContent = "";
          window.setTimeout(() => {
            if (failed) error.textContent = message;
          }, 50);
        }
        input?.setAttribute("aria-invalid", "true");
        failed = true;
        showSign();
        if (signPost) replay(signPost, "fx-shake");
        input?.focus();
        return;
      }
      clearErrors();
      join(form, email);
    });
  }

  document.querySelector("[data-reset]")?.addEventListener("click", () => {
    for (const form of forms) form.hidden = false;
    for (const element of joined) element.hidden = true;
    if (sign) sign.hidden = false;
    showSign();
    inputs[0]?.focus();
  });
};
