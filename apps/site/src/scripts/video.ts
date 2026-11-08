/**
 * The presentation video plays in a dialog over the page. The file loads only when it is first opened. Escape, the
 * Close button or a click outside the video closes it, the video stops, and focus goes back to what opened it.
 */
export const initVideo = () => {
  const dialog = document.querySelector<HTMLDialogElement>("[data-video]");
  const video = dialog?.querySelector("video");
  if (!dialog || !video) return;
  let opener: HTMLElement | null = null;

  const open = (from: HTMLElement) => {
    opener = from;
    if (!video.getAttribute("src") && video.dataset.src) video.src = video.dataset.src;
    dialog.showModal();
    video.play().catch(() => {
      // Autoplay can be refused; the controls are there to start it.
    });
  };

  const close = () => {
    if (dialog.open) dialog.close();
  };

  for (const button of document.querySelectorAll<HTMLElement>("[data-video-open]"))
    button.addEventListener("click", () => open(button));
  for (const button of dialog.querySelectorAll<HTMLElement>("[data-video-close]"))
    button.addEventListener("click", close);
  // A click on the dialog itself, not its box, landed on the backdrop.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    video.pause();
    // Without scrolling: the Download link closes the dialog on its way to the Download section.
    opener?.focus({ preventScroll: true });
  });
};
