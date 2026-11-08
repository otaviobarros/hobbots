import { actions, isActionError, isInputError } from "astro:actions";
import { emailProblem } from "./email.ts";
import { humanToken } from "./turnstile.ts";

/**
 * The wait-list for the apps that are not out yet, in the Download section. It checks the address, then saves it
 * with the wait-list action. Everyone who joins here asked about the Windows and phone apps, and the stored source
 * stays "hero", the page's main form, so the table keeps the values it was created with.
 */

const HUMAN_CHECK_FAILED = "We couldn't check that you're a person. Reload the page and try again.";

/** What to tell the visitor when the server refused or failed to save the sign-up. */
const saveProblem = (error: unknown) => {
  if (isInputError(error)) return "That email doesn't look right. Check it and try again.";
  if (isActionError(error) && error.code === "TOO_MANY_REQUESTS")
    return "That's a lot of tries. Wait a minute, then try again.";
  if (isActionError(error) && error.code === "FORBIDDEN") return HUMAN_CHECK_FAILED;
  return "Your email wasn't saved. Try again in a moment.";
};

/** Saves the sign-up and returns what went wrong, or "" when it was saved. */
const save = async (form: HTMLFormElement, email: string) => {
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
      wantsMorePlatforms: true,
      source: "hero",
      website: form.querySelector<HTMLInputElement>("[data-website]")?.value ?? "",
      turnstileToken,
    });
    return error ? saveProblem(error) : "";
  } catch (error) {
    return saveProblem(error);
  }
};

export const initWaitlist = () => {
  const form = document.querySelector<HTMLFormElement>("[data-join-form]");
  const input = form?.querySelector<HTMLInputElement>("[data-email]");
  const error = form?.querySelector<HTMLElement>("[data-error]");
  const submit = form?.querySelector<HTMLButtonElement>("[data-submit]");
  const joined = document.querySelector<HTMLElement>("[data-joined]");
  const joinedBody = document.querySelector<HTMLElement>("[data-joined-body]");
  if (!form || !input || !error || !joined) return;
  let failed = false;
  let busy = false;

  const clearError = () => {
    failed = false;
    error.textContent = "";
    input.removeAttribute("aria-invalid");
  };

  const showError = (message: string, invalid: boolean) => {
    // Clearing first makes a repeated message announce again.
    error.textContent = "";
    window.setTimeout(() => {
      if (failed) error.textContent = message;
    }, 50);
    if (invalid) input.setAttribute("aria-invalid", "true");
    failed = true;
    input.focus();
  };

  input.addEventListener("input", clearError);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const email = input.value.trim();
    const message = emailProblem(email);
    if (message) return showError(message, true);
    clearError();
    busy = true;
    submit?.setAttribute("aria-disabled", "true");
    const problem = await save(form, email);
    busy = false;
    submit?.removeAttribute("aria-disabled");
    if (problem) return showError(problem, false);
    form.hidden = true;
    joined.hidden = false;
    if (joinedBody) joinedBody.textContent = `We'll write to ${email.toLowerCase()} once, when it is out.`;
    // The focused button is gone, so focus moves to the confirmation.
    joined.querySelector<HTMLElement>("[data-joined-focus]")?.focus();
  });

  document.querySelector("[data-reset]")?.addEventListener("click", () => {
    form.hidden = false;
    joined.hidden = true;
    input.focus();
  });
};
