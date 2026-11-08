/** How long the hobs work after you answer before the sun comes up, in milliseconds. */
const WORK = 2600;

const SAY = {
  early: "Ada: Got it. Dec 12 for international, Dec 18 for the rest. Telling Quill.",
  late: "Ada: Got it. Dec 18 for everyone. Telling Quill.",
} as const;

type Phase = "ask" | "working" | "dawn";

/** The hero's Quest: answer Ada's question and watch the hobs finish the work by morning. */
export const initStage = () => {
  const stage = document.querySelector<HTMLElement>("[data-stage]");
  if (!stage) return;
  const say = stage.querySelector<HTMLElement>("[data-say]");
  const done = stage.querySelector<HTMLElement>("[data-done]");
  const needs = stage.querySelector<HTMLElement>("[data-needs]");
  const finished = stage.querySelector<HTMLElement>("[data-finished]");
  let timer = 0;

  const show = (phase: Phase) => {
    stage.dataset.phase = phase;
    for (const panel of stage.querySelectorAll<HTMLElement>("[data-show]")) panel.hidden = panel.dataset.show !== phase;
    if (done) done.textContent = phase === "ask" ? "4 of 5 done" : "5 of 5 done";
    if (needs) needs.hidden = phase !== "ask";
    if (finished) finished.hidden = phase === "ask";
  };

  for (const option of stage.querySelectorAll<HTMLButtonElement>("[data-answer]")) {
    option.addEventListener("click", () => {
      const line = option.dataset.answer === "late" ? SAY.late : SAY.early;
      if (say) say.textContent = line;
      show("working");
      // The focused option is gone, so focus moves to Ada's reply.
      say?.focus();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        show("dawn");
        stage.querySelector<HTMLElement>("[data-morning]")?.focus();
      }, WORK);
    });
  }

  stage.querySelector("[data-replay]")?.addEventListener("click", () => {
    window.clearTimeout(timer);
    show("ask");
    stage.querySelector<HTMLElement>("[data-answer]")?.focus();
  });
};
