import { actions, isActionError, isInputError } from "astro:actions";
import { EMAIL, emailProblem } from "./email.ts";
import { getMine } from "./mine.ts";
import { replay } from "./motion.ts";
import { notes } from "./sound.ts";
import { humanToken } from "./turnstile.ts";

/** The two wait-list forms share one email. Each checks the address, then saves it with the wait-list action. */

const HUMAN_CHECK_FAILED = "We couldn't check that you're a person. Reload the page and try again.";

/** What to tell the visitor when the server refused or failed to save the sign-up. */
const saveProblem = (error: unknown) => {
  if (isInputError(error)) return "That email doesn't look right. Check it and try again.";
  if (isActionError(error) && error.code === "TOO_MANY_REQUESTS")
    return "That's a lot of tries. Wait a minute, then try again.";
  if (isActionError(error) && error.code === "FORBIDDEN") return HUMAN_CHECK_FAILED;
  return "Your spot wasn't saved. Try again in a moment.";
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

  const join = (form: HTMLFormElement, email: string, wantsMorePlatforms: boolean) => {
    for (const form of forms) form.hidden = true;
    for (const element of joined) element.hidden = false;
    if (sign) sign.hidden = true;
    if (joinedBody) {
      const also = wantsMorePlatforms ? ", and again when the Windows and phone apps are ready" : "";
      joinedBody.textContent = `${getMine().name} will keep your spot. We'll write to ${email} when the lantern is lit${also}.`;
    }
    const sprite = document.querySelector(".joined-sprite");
    if (sprite) replay(sprite, "fx-hop");
    notes([523, 659, 784, 1047], 0.08);
    // The focused button is gone, so focus moves to the confirmation beside the form used.
    form.closest("[data-waitlist]")?.querySelector<HTMLElement>("[data-joined-focus]")?.focus();
  };

  const showError = (form: HTMLFormElement, message: string, invalid: boolean) => {
    const input = form.querySelector<HTMLInputElement>("[data-email]");
    const error = form.querySelector("[data-error]");
    if (error) {
      // Clearing first makes a repeated message announce again.
      error.textContent = "";
      window.setTimeout(() => {
        if (failed) error.textContent = message;
      }, 50);
    }
    if (invalid) input?.setAttribute("aria-invalid", "true");
    failed = true;
    showSign();
    if (signPost) replay(signPost, "fx-shake");
    input?.focus();
  };

  /** Saves the sign-up and returns what went wrong, or "" when it was saved. */
  const save = async (form: HTMLFormElement, email: string, wantsMorePlatforms: boolean) => {
    const container = form.querySelector<HTMLElement>("[data-turnstile]");
    let turnstileToken: string;
    try {
      if (!container) throw new Error("The form has no Turnstile container");
      turnstileToken = await humanToken(container);
    } catch {
      return HUMAN_CHECK_FAILED;
    }
    try {
      const { error } = await actions.waitlist.join({
        email,
        wantsMorePlatforms,
        source: form.dataset.source === "roll" ? "roll" : "hero",
        website: form.querySelector<HTMLInputElement>("[data-website]")?.value ?? "",
        turnstileToken,
      });
      return error ? saveProblem(error) : "";
    } catch (error) {
      return saveProblem(error);
    }
  };

  for (const form of forms) {
    const submit = form.querySelector<HTMLButtonElement>("[data-submit]");
    let busy = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const email = form.querySelector<HTMLInputElement>("[data-email]")?.value.trim() ?? "";
      const message = emailProblem(email);
      if (message) return showError(form, message, true);
      clearErrors();
      busy = true;
      submit?.setAttribute("aria-disabled", "true");
      // Read once: the box stays editable while the save is pending, and the message must match what was saved.
      // One checkbox, in the hero form, serves both forms.
      const wantsMorePlatforms = more?.checked ?? false;
      const problem = await save(form, email, wantsMorePlatforms);
      busy = false;
      submit?.removeAttribute("aria-disabled");
      if (problem) showError(form, problem, false);
      else join(form, email.toLowerCase(), wantsMorePlatforms);
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
