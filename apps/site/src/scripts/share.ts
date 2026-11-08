const URL = "https://hobbots.app";

/**
 * Hobbots installs on a computer, so a phone visitor sends the link on: through the phone's share sheet, or by
 * copying it where there is none.
 */
export const initShare = () => {
  // The toast shows the message; a status region that is always there reads it out, again on each press.
  const toast = document.querySelector<HTMLElement>("[data-share-toast]");
  const status = document.querySelector<HTMLElement>("[data-share-status]");
  let timer = 0;

  const tell = (text: string) => {
    if (status) {
      status.textContent = "";
      window.setTimeout(() => {
        status.textContent = text;
      }, 50);
    }
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      toast.hidden = true;
    }, 4000);
  };

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: "Hobbots", text: "Download Hobbots on my computer", url: URL });
      } catch {
        // Closing the share sheet is not an error worth showing.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(URL);
      tell("Link copied. Open hobbots.app on your computer.");
    } catch {
      tell("Open hobbots.app on your computer to download Hobbots.");
    }
  };

  for (const button of document.querySelectorAll("[data-share]")) button.addEventListener("click", share);
};
